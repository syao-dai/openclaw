import { emitAgentEventIfCurrent, onAgentEvent } from "../../infra/agent-events.js";
import { getRuntimeConfig } from "../../config/config.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readLatestAssistantReply, waitForAgentRun } from "../run-wait.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "../subagents/spawn/subagent-spawn-plan.js";
import type { spawnSubagentDirect } from "../subagents/spawn/subagent-spawn.js";

const log = createSubsystemLogger("agents/tools/sessions-spawn");

type AcceptedSubagentSpawn = Awaited<ReturnType<typeof spawnSubagentDirect>> & {
  runId: string;
  childSessionKey: string;
};

/**
 * Blocks the parent's `sessions_spawn` call until the child run settles, relaying the
 * child's thinking/tool/answer events into the parent's assistant stream as a collapsible
 * `<details>` progress section. Returns the tool result payload, or `undefined` when the
 * caller should fall back to the plain accepted result.
 */
export async function waitForSubagentRunWithRelay(params: {
  result: AcceptedSubagentSpawn;
  parentSessionKey?: string;
  parentRunId?: string;
  startTime: number;
  spawnElapsedMs: number;
}): Promise<Record<string, unknown> | undefined> {
  const { result, parentSessionKey, parentRunId, startTime, spawnElapsedMs } = params;
  log.debug(
    `[sessions_spawn] SUBAGENT: SYNCHRONOUS MODE - Now waiting for Agent B (runId=${result.runId}) to complete...`,
  );

  // 🆕 Start listening to Agent B's events and relay text deltas to Agent A
  const childSessionKey = result.childSessionKey;
  
  const childRunId = result.runId;
  

  // Extract agent label from childSessionKey (e.g., "agent:fais-agent:subagent:xxx" → "fais-agent")
  const childAgentLabel = childSessionKey?.split(":")[1] || "Agent B";

  const correlation =
    `parentRunId=${parentRunId ?? "none"} parentSessionKey=${parentSessionKey ?? "none"} ` +
    `childRunId=${childRunId} childSessionKey=${childSessionKey}`;
  log.info(`sessions_spawn relay: waiting for child run ${correlation}`);
  if (!parentRunId || !parentSessionKey) {
    // Without both ids nothing can be emitted into the parent's stream: the caller
    // (e.g. an OpenAI-compatible HTTP client) sees no progress until the tool returns.
    log.warn(`sessions_spawn relay: parent ids missing, progress will not be streamed ${correlation}`);
  }
  let childEventCount = 0;
  let relayedChunkCount = 0;
  let droppedChunkCount = 0;
  // emitAgentEvent drops events silently when the parent run is no longer current
  // (ownership/lifecycle checks), so use the boolean-returning variant to surface that.
  const emitRawToParent = (text: string) => {
    if (!parentRunId || !parentSessionKey) {
      return;
    }
    const accepted = emitAgentEventIfCurrent({
      runId: parentRunId,
      sessionKey: parentSessionKey,
      stream: "assistant",
      data: { text, delta: text },
    });
    if (accepted) {
      relayedChunkCount += 1;
      return;
    }
    droppedChunkCount += 1;
    if (droppedChunkCount === 1) {
      log.warn(
        `sessions_spawn relay: parent run rejected relayed event (run no longer current?) ${correlation}`,
      );
    }
  };
  // Report text arrives as thousands of 1-20 char deltas (a 100KB report was ~11k). Every
  // emit fans out synchronously to all agent-event listeners (SSE/WS/tracing), so relaying
  // each delta starves the event loop and the client sees nothing until it frees. Coalesce
  // report text into ~REPORT_COALESCE_MAX_CHARS / REPORT_COALESCE_INTERVAL_MS chunks.
  // Every other emit flushes first, so ordering relative to headers/progress lines holds.
  const REPORT_COALESCE_MAX_CHARS = 200;
  const REPORT_COALESCE_INTERVAL_MS = 80;
  let reportBuffer = "";
  let reportFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushReportBuffer = () => {
    if (reportFlushTimer) {
      clearTimeout(reportFlushTimer);
      reportFlushTimer = null;
    }
    if (reportBuffer.length > 0) {
      const text = reportBuffer;
      reportBuffer = "";
      emitRawToParent(text);
    }
  };
  const emitToParent = (text: string) => {
    flushReportBuffer();
    emitRawToParent(text);
  };
  const emitReportText = (text: string) => {
    if (!parentRunId || !parentSessionKey) {
      return;
    }
    reportBuffer += text;
    if (reportBuffer.length >= REPORT_COALESCE_MAX_CHARS) {
      flushReportBuffer();
    } else if (!reportFlushTimer) {
      reportFlushTimer = setTimeout(flushReportBuffer, REPORT_COALESCE_INTERVAL_MS);
    }
  };
  // Per-delta debug logging would itself overflow the file log queue (2 records/delta),
  // so text deltas are only counted and reported in the final summary.
  let textDeltaCount = 0;
  let textDeltaChars = 0;
  // The watchdog thresholds are minutes; touching progress once a second is enough.
  const PROGRESS_TOUCH_MIN_INTERVAL_MS = 1_000;
  let lastProgressTouchAt = 0;
  log.debug(`[sessions_spawn] SUBAGENT STREAMING: Child agent label: "${childAgentLabel}"`);

  // Track if we've sent the header
  let headerSent = false;
  let detailsClosed = false; // Track if we've closed the collapsible section
  let progressLineCount = 0;
  // Thinking/reasoning deltas are display-only: they accumulate here so
  // reasoning-heavy models still show progress lines, but they must never
  // be checked by looksLikeReport() or count toward sustainedAnswerText —
  // thinking prose routinely contains "---\n#" style dividers or just runs
  // long, and either one used to get misread as the final answer starting.
  let thinkingPreview = "";
  let pendingText = ""; // Real assistant-text candidate for the final answer
  let lastEventWasToolCall = false;
  let accumulatedReportText = ""; // Accumulate all report text for final result
  // When the current uninterrupted run of real assistant text began (reset
  // on every tool call). Backs the sustained-answer fallback below.
  let textStreakStartedAt: number | undefined;

  // Helper function to remove markdown heading symbols from text
  const removeMarkdownHeadings = (text: string): string => {
    // Remove markdown heading symbols (# ## ### etc.) from each line
    // Split by newlines, remove # from start of each line, then rejoin
    return text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, ""))
      .join("\n");
  };

  // Progress lines relay raw thinking/text verbatim, which can run to
  // 1000+ chars for reasoning-heavy models. Cap each preview so users see
  // motion without a wall of text; the full content still reaches the
  // final result via accumulatedReportText/agentBResult.
  const PROGRESS_PREVIEW_MAX_CHARS = 150;
  const truncateProgressPreview = (text: string): string =>
    text.length > PROGRESS_PREVIEW_MAX_CHARS
      ? `${text.slice(0, PROGRESS_PREVIEW_MAX_CHARS)}…`
      : text;

  // Models that keep calling tools interleave short remarks, not
  // multi-second prose. If real (non-thinking) answer text has been
  // flowing continuously this long without a new tool call, treat it as
  // the final answer even without an explicit 🦉 marker — otherwise a
  // model that forgets the marker leaves the "執行中" section open for
  // the entire remaining run.
  const SUSTAINED_ANSWER_TEXT_MS = 10_000;

  // Helper function to detect if text looks like a report
  const looksLikeReport = (text: string): boolean => {
    const trimmed = text.trim();
    // Detect markdown headings (# at start of line or after ---)
    // if (/^#+\s/.test(trimmed)) {
    //   return true;
    // }
    // Detect 🦉 emoji (indicates structured report output)
    if (/🦉/.test(trimmed)) {
      return true;
    }
    // Check if text contains --- followed by markdown heading
    // if (/---\s*#+\s/.test(trimmed)) {
    //   return true;
    // }
    // Detect Chinese report keywords at start or after ---
    // if (/^(#+)?\s*(報告|分析報告|財務報告|財務分析|分析結果|執行結果)/.test(trimmed)) {
    //   return true;
    // }
    // Check for report keywords after ---
    // if (/---[\s\S]*?(報告|分析報告|財務報告)/.test(trimmed)) {
    //   return true;
    // }
    // Detect phrases that indicate report generation
    // if (/(產出|生成|撰寫|編寫)[^\n]*(報告|分析)/.test(trimmed)) {
    //   return true;
    // }
    return false;
  };

  // Agent B can think silently for a long stretch with no tool call and
  // no text delta — during that window the relay otherwise emits nothing
  // at all after the initial header, which looks identical to a hang to
  // whoever is watching Agent A's stream. Drip a "." into the still-open
  // <details> block every 30s while thinking is the only activity, so
  // the parent stream visibly keeps moving without leaking Agent B's
  // actual reasoning text.
  const THINKING_HEARTBEAT_INTERVAL_MS = 30_000;
  let thinkingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stopThinkingHeartbeat = () => {
    if (thinkingHeartbeatTimer) {
      clearInterval(thinkingHeartbeatTimer);
      thinkingHeartbeatTimer = null;
    }
  };
  const startThinkingHeartbeat = () => {
    if (thinkingHeartbeatTimer || !parentRunId || !parentSessionKey) {
      return;
    }
    thinkingHeartbeatTimer = setInterval(() => {
      emitToParent(".");
    }, THINKING_HEARTBEAT_INTERVAL_MS);
  };

  // Subscribe to Agent B's events
  const unsubscribe = onAgentEvent((evt) => {
    // Only process events from the child session
    if (evt.sessionKey !== childSessionKey) {
      return;
    }
    childEventCount += 1;
    if (childEventCount === 1) {
      log.info(`sessions_spawn relay: first child event stream=${evt.stream} ${correlation}`);
    }
    // Agent B's thinking/tool/text activity lives entirely in its own
    // session, so it never touches Agent A's own diagnostic progress
    // markers. Without this, stuck-session recovery sees Agent A's
    // `sessions_spawn` tool call as motionless the whole time Agent B is
    // working and force-aborts it once the blocked-tool-call threshold
    // passes (~6 min) — killing the parent stream mid-flight even while
    // Agent B is actively streaming real output. Touch progress on every
    // relayed child event so the watchdog sees Agent A as alive too.
    const now = Date.now();
    if (
      parentRunId &&
      parentSessionKey &&
      now - lastProgressTouchAt >= PROGRESS_TOUCH_MIN_INTERVAL_MS
    ) {
      lastProgressTouchAt = now;
      markDiagnosticRunProgress({
        runId: parentRunId,
        sessionKey: parentSessionKey,
        reason: "sessions_spawn:child_activity",
      });
    }
    // Track tool calls to know when to emit accumulated text
    if (evt.stream === "tool") {
      if (detailsClosed) {
        // We previously guessed the final answer had started (🦉 or the
        // sustained-answer fallback below), but the model is still
        // calling tools. Reopen a fresh collapsible section instead of
        // silently hiding the renewed activity under a "completed" banner.
        detailsClosed = false;
        thinkingPreview = "";
        pendingText = "";
        textStreakStartedAt = undefined;
        stopThinkingHeartbeat();
        if (parentRunId && parentSessionKey) {
          const reopenText = `\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中...（繼續處理，點擊摺疊/展開）</summary>\n\n`;
          log.debug(
            `[sessions_spawn] SUBAGENT STREAMING: Tool call after details were closed — reopening section`,
          );
          emitToParent(reopenText);
        }
        lastEventWasToolCall = true;
        return;
      }
      // Tool call started - flush any pending thinking/text preview
      const combinedPreview = `${thinkingPreview}${pendingText}`.trim();
      if (combinedPreview.length > 0 && parentRunId && parentSessionKey) {
        // Remove markdown headings from accumulated text to avoid rendering as title in Open WebUI
        const cleanedText = truncateProgressPreview(removeMarkdownHeadings(combinedPreview));
        const formattedText = `> 📌 ${cleanedText}\n\n`;
        progressLineCount++;

        log.debug(
          `[sessions_spawn] SUBAGENT STREAMING: Flushing accumulated text (${combinedPreview.length} chars) before tool call`,
        );

        emitToParent(formattedText);
      }
      thinkingPreview = "";
      pendingText = "";
      textStreakStartedAt = undefined;
      stopThinkingHeartbeat();
      lastEventWasToolCall = true;
      return;
    }

    // Thinking/reasoning deltas land on their own stream (see
    // AgentEventStream in agent-events.ts) instead of "assistant". Feed
    // them into thinkingPreview (display-only) so they still flush with
    // the "> 📌" prefix at the next tool-call/report boundary instead of
    // being silently dropped — which is what made reasoning-heavy models
    // show no progress lines at all. This buffer is never checked by
    // looksLikeReport() and never counted by the sustained-answer timer.
    if (evt.stream === "thinking" && evt.data) {
      const thinkingDelta = evt.data.delta;
      if (
        typeof thinkingDelta === "string" &&
        thinkingDelta.length > 0 &&
        parentRunId &&
        parentSessionKey
      ) {
        if (!headerSent) {
          headerSent = true;
          emitToParent(`\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中... (點擊摺疊/展開)</summary>\n\n> 📋 **Session**: \`${childSessionKey}\`\n\n`);
        }
        log.debug(
          `[sessions_spawn] SUBAGENT STREAMING: Received thinking delta (${thinkingDelta.length} chars)`,
        );
        thinkingPreview += thinkingDelta;
        startThinkingHeartbeat();
      }
      return;
    }

    // Only relay 'assistant' stream with text content
    if (evt.stream === "assistant" && evt.data) {
      const delta = evt.data.delta;

      // Check if this is a text delta (not tool calls, media, etc.)
      if (typeof delta === "string" && delta.length > 0 && parentRunId && parentSessionKey) {
        textDeltaCount += 1;
        textDeltaChars += delta.length;
        stopThinkingHeartbeat();

        // Send collapsible header on first output
        if (!headerSent) {
          headerSent = true;
          emitToParent(`\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中... (點擊摺疊/展開)</summary>\n\n> 📋 **Session**: \`${childSessionKey}\`\n\n`);
        }

        // Coming out of a tool call (or the run's very first delta):
        // flush whatever thinking accumulated in the interim as its own
        // progress line first. Thinking never counts toward "does this
        // look like the final answer" — only real answer text does.
        if (lastEventWasToolCall) {
          if (thinkingPreview.trim().length > 0) {
            const cleanedThinking = truncateProgressPreview(
              removeMarkdownHeadings(thinkingPreview.trim()),
            );
            const formattedThinking = `> 📌 ${cleanedThinking}\n\n`;
            progressLineCount++;
            log.debug(
              `[sessions_spawn] SUBAGENT STREAMING: Flushing accumulated thinking (${thinkingPreview.length} chars) after tool call`,
            );
            emitToParent(formattedThinking);
            thinkingPreview = "";
          }
          lastEventWasToolCall = false;
        }

        // Mark the start of a fresh, uninterrupted run of real answer
        // text. Keyed off pendingText being empty rather than
        // lastEventWasToolCall so it also covers a model that writes
        // text without ever calling a tool first.
        if (pendingText.length === 0) {
          textStreakStartedAt = Date.now();
        }
        pendingText += delta;

        // Check whether the accumulated real answer text now looks like
        // the final report — either an explicit 🦉 marker, or (fallback)
        // it has been flowing continuously long enough that it's very
        // unlikely to just be a between-tool-call remark.
        if (!detailsClosed) {
          const matchedMarker = looksLikeReport(pendingText);
          const sustainedAnswer =
            !matchedMarker &&
            textStreakStartedAt !== undefined &&
            Date.now() - textStreakStartedAt >= SUSTAINED_ANSWER_TEXT_MS;
          if (matchedMarker || sustainedAnswer) {
            log.debug(
              `[sessions_spawn] SUBAGENT STREAMING: Detected report start (${matchedMarker ? "🦉/marker" : "sustained answer text, no marker"}), closing details`,
            );
            const closeText = `\n</details>\n\n---\n\n**✅ ${childAgentLabel} 執行完成，開始生成報告** (${progressLineCount} 條進度更新)\n\n`;
            emitToParent(closeText);
            detailsClosed = true;
            emitReportText(pendingText);
            accumulatedReportText += pendingText;
            pendingText = "";
          }
        } else {
          // Already in report-streaming mode: relay (coalesced, see emitReportText).
          emitReportText(pendingText);
          accumulatedReportText += pendingText;
          pendingText = "";
        }
        // Otherwise pendingText keeps accumulating: it flushes as a
        // progress line at the next tool call, or triggers the report
        // detection above once looksLikeReport()/sustainedAnswer fires.
      }
    }
  });

  // sessions_spawn rejects a per-call runTimeoutSeconds override (see
  // UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS above), so only the config default applies here.
  const cfg = getRuntimeConfig();
  const resolvedRunTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
  });

  log.debug(
    `[sessions_spawn] SUBAGENT: Resolved runTimeoutSeconds=${resolvedRunTimeoutSeconds} (from config: ${cfg?.agents?.defaults?.subagents?.runTimeoutSeconds ?? "none"})`,
  );

  const waitTimeoutMs = (resolvedRunTimeoutSeconds || 300) * 1000 + 10000; // timeout + 10s buffer
  const waitStartTime = Date.now();

  try {
    log.debug(
      `[sessions_spawn] SUBAGENT: Calling waitForAgentRun() with timeout=${waitTimeoutMs}ms...`,
    );

    const waitResult = await waitForAgentRun({
      runId: result.runId,
      timeoutMs: waitTimeoutMs,
    });

    const waitEndTime = Date.now();
    const waitElapsedMs = waitEndTime - waitStartTime;

    log.info(
      `sessions_spawn relay: child run settled status=${waitResult.status} waitMs=${waitElapsedMs} ${correlation}`,
    );

    if (waitResult.status === "ok") {
      // Agent B completed successfully, read its result
      log.debug(
        `[sessions_spawn] SUBAGENT: Agent B completed successfully. Reading result from ${result.childSessionKey}...`,
      );

      const agentBResult = await readLatestAssistantReply({
        sessionKey: result.childSessionKey,
        limit: 50,
      });

      const totalElapsedMs = Date.now() - startTime;

      // 🆕 Clean up event listener
      log.debug(
        `[sessions_spawn] SUBAGENT STREAMING: Cleaning up event listener after Agent B completion`,
      );
      log.debug(
        `[sessions_spawn] SUBAGENT STREAMING: Relayed ${progressLineCount} progress updates`,
      );
      unsubscribe();
      stopThinkingHeartbeat();
      // Send any remaining thinking/text. The run is over now, so unlike
      // the live progress-line path this is never a "preview" of more
      // to come — it's the tail of the real answer, so it goes out in
      // full (no truncateProgressPreview) whether or not a report/
      // sustained-answer trigger ever fired while the run was live.
      const remainingText = `${thinkingPreview}${pendingText}`.trim();
      if (remainingText.length > 0 && headerSent && parentRunId && parentSessionKey) {
        if (!detailsClosed) {
          // Never detected a report start live (no 🦉, and the run ended
          // before the sustained-answer fallback had a chance to fire) —
          // close the section now, right before emitting the real content.
          const closeText = `\n</details>\n\n---\n\n**✅ ${childAgentLabel} 任務完成** (${progressLineCount} 條進度更新)\n\n`;
          emitToParent(closeText);
          detailsClosed = true;
        }
        emitToParent(remainingText);
        accumulatedReportText += remainingText;
        log.debug(
          `[sessions_spawn] SUBAGENT STREAMING: Sent final pending text (${remainingText.length} chars)`,
        );
      }

      // Close the collapsible section if we opened it and haven't closed
      // it yet (covers the case where there was nothing left to flush).
      if (headerSent && !detailsClosed && parentRunId && parentSessionKey) {
        emitToParent(`\n</details>\n\n---\n\n**✅ ${childAgentLabel} 任務完成** (${progressLineCount} 條進度更新)\n\n`);
      }

      if (agentBResult) {
        log.debug(
          `[sessions_spawn] SUBAGENT: SUCCESS - Got Agent B result from transcript (${agentBResult.length} chars) after total ${totalElapsedMs}ms`,
        );

        // Use accumulated streaming text if available and longer than transcript result
        const finalResult =
          accumulatedReportText.length > agentBResult.length
            ? accumulatedReportText
            : agentBResult;

        if (accumulatedReportText.length > agentBResult.length) {
          log.debug(
            `[sessions_spawn] SUBAGENT: Using accumulated streaming text (${accumulatedReportText.length} chars) instead of transcript result (${agentBResult.length} chars)`,
          );
        }

        // Return the actual result from Agent B
        return {
          status: "completed",
          childSessionKey: result.childSessionKey,
          runId: result.runId,
          mode: result.mode,
          result: finalResult,
          runtime: {
            spawnMs: spawnElapsedMs,
            waitMs: waitElapsedMs,
            totalMs: totalElapsedMs,
          },
          modelApplied: result.modelApplied,
        };
      } else {
        log.warn(
          `[sessions_spawn] SUBAGENT: Agent B completed but no result found. Falling back to accepted status.`,
        );
      }
    } else if (waitResult.status === "timeout") {
      log.warn(
        `[sessions_spawn] SUBAGENT: Wait TIMEOUT after ${waitElapsedMs}ms. Returning accepted status with timeout note.`,
      );
      // 🆕 Clean up event listener on timeout
      unsubscribe();
      stopThinkingHeartbeat();
      return {
        ...result,
        note: `Subagent started but timed out after ${Math.round(waitElapsedMs / 1000)}s. Check /subagents list for status. Original note: ${result.note || ""}`,
      };
    } else {
      log.warn(
        `[sessions_spawn] SUBAGENT: Wait ERROR status=${waitResult.status}, error=${waitResult.error}. Returning accepted status.`,
      );
      // 🆕 Clean up event listener on error
      unsubscribe();
      stopThinkingHeartbeat();
      return {
        ...result,
        note: `Subagent started but wait failed (${waitResult.status}). Check /subagents list for status. Original note: ${result.note || ""}`,
      };
    }
  } catch (err) {
    const waitErrorMs = Date.now() - waitStartTime;
    log.error(
      `[sessions_spawn] SUBAGENT: Wait exception after ${waitErrorMs}ms: ${err instanceof Error ? err.message : String(err)}`,
    );
    // 🆕 Clean up event listener on exception
    unsubscribe();
    stopThinkingHeartbeat();
    // Fall through to return accepted status
  } finally {
    // Every exit path has unsubscribed by now; emit any coalesced report tail before returning.
    flushReportBuffer();
    log.info(
      `sessions_spawn relay: summary childEvents=${childEventCount} textDeltas=${textDeltaCount} ` +
        `textChars=${textDeltaChars} relayedChunks=${relayedChunkCount} ` +
        `droppedChunks=${droppedChunkCount} progressLines=${progressLineCount} ` +
        `totalMs=${Date.now() - startTime} ${correlation}`,
    );
  }
  return undefined;
}
