/**
 * sessions_spawn built-in tool.
 *
 * Starts subagent or ACP-backed sessions with inherited tool policy and delivery context.
 */
import { Type } from "typebox";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import {
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "../../channels/thread-bindings-policy.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { emitAgentEvent, onAgentEvent } from "../../infra/agent-events.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  readLatestAssistantReply,
  waitForAgentRun,
} from "../run-wait.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagent-attachments.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { resolveSubagentSpawnOwnership } from "../subagent-spawn-ownership.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagent-task-name.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "../subagent-spawn-plan.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readStringParam,
  ToolInputError,
} from "./common.js";

const log = createSubsystemLogger("agents/tools/sessions-spawn");

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;
const UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS = [
  "runTimeoutSeconds",
  "timeoutSeconds",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

const acpSpawnModuleLoader = createLazyImportLoader<AcpSpawnModule>(
  () => import("../acp-spawn.js"),
);

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  return await acpSpawnModuleLoader.load();
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

type SessionsSpawnThreadAvailability = {
  subagent: boolean;
  acp: boolean;
};

function hasAnyThreadAvailability(availability: SessionsSpawnThreadAvailability): boolean {
  return availability.subagent || availability.acp;
}

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
}): SessionsSpawnThreadAvailability {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsAutomaticThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable alias for later targeting; lowercase letters/digits/underscores/hyphens, starts letter.",
      }),
    ),
    label: Type.Optional(Type.String()),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind spawn to new chat thread when supported. `thread=true` defaults mode="session".',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description:
        'Native context. Omit/"isolated" for clean child; "fork" only when child needs requester transcript.',
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: 'Light bootstrap context; runtime="subagent" only.',
      }),
    ),
    expectsCompletionMessage: Type.Optional(
      Type.Boolean({
        description:
          'If true (default), waits for the spawned agent to complete and returns the result synchronously. ' +
          'If false, returns immediately with "accepted" status; completion is delivered via announcement. ' +
          'Use false for fire-and-forget background tasks. ' +
          'Native subagents only; ACP runtime always returns immediately regardless of this setting.',
      }),
    ),

    // Inline attachments (snapshot-by-value).
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        { maxItems: 50 },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object({
        // Where the spawned agent should look for attachments.
        // Kept as a hint; implementation materializes into the child workspace.
        mountPath: Type.Optional(Type.String()),
      }),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description:
                'ACP-only resume target; ignored for runtime="subagent". Use id already recorded for this requester.',
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description:
              'ACP-only stream target; ignored for runtime="subagent". Use "parent" to stream turn to requester.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    /** Separate key used only for completion routing (registerSubagentRun requesterSessionKey). */
    completionOwnerKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    /** Agent A's runId (for event streaming). */
    runId?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: opts?.config,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability(opts);
  const threadAvailable = hasAnyThreadAvailability(threadAvailability);
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({ acpAvailable, threadAvailable }),
    parameters: createSessionsSpawnToolSchema({ acpAvailable, threadAvailable }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const unsupportedTimeoutParam = UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS.find((key) =>
        resolveSnakeCaseParamKey(params, key),
      );
      if (unsupportedTimeoutParam) {
        const providedTimeoutParam =
          resolveSnakeCaseParamKey(params, unsupportedTimeoutParam) ?? unsupportedTimeoutParam;
        throw new ToolInputError(
          `sessions_spawn does not support per-call "${providedTimeoutParam}". Configure agents.defaults.subagents.runTimeoutSeconds instead.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const taskNameResult = normalizeSubagentTaskName(params.taskName);
      if (taskNameResult.error) {
        return jsonResult({
          status: "error",
          error: taskNameResult.error,
        });
      }
      const taskName = taskNameResult.taskName;
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = normalizeToolModelOverride(readStringParam(params, "model"));
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;

      // Log the initial spawn request
      log.info(
        `[sessions_spawn] ENTRY: Agent A (${opts?.agentSessionKey || "unknown"}) spawning Agent B`,
      );
      log.info(
        `[sessions_spawn] Parameters: runtime=${runtime}, agentId=${requestedAgentId || "<same>"}, mode=${mode || "auto"}, expectsCompletionMessage=${expectsCompletionMessage}`,
      );
      log.info(
        `[sessions_spawn] Task: "${task.length > 100 ? task.substring(0, 100) + "..." : task}"`,
      );
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
      if (runtime === "acp" && !acpAvailable) {
        return jsonResult({
          status: "error",
          error: resolveAcpUnavailableMessage(opts),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedTool =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
          : undefined;
      if (acpUnsupportedInheritedTool) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedAllow =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
          : undefined;
      if (acpUnsupportedInheritedAllow) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
          ...roleContext,
        });
      }
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      if (runtime === "acp" && context === "fork") {
        throw new Error('context="fork" is only supported for runtime="subagent".');
      }
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (runtime === "acp") {
        log.info(
          `[sessions_spawn] RUNTIME_PATH: ACP (spawning via spawnAcpDirect)`,
        );
        log.info(
          `[sessions_spawn] ACP Config: streamTo=${streamTo || "none"}, resumeSessionId=${resumeSessionId || "none"}`,
        );
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        const acpAttachments = resolveAcpSessionsSpawnImageAttachments({
          config: opts?.config ?? getRuntimeConfig(),
          attachments,
        });
        if (acpAttachments?.status === "forbidden" || acpAttachments?.status === "error") {
          return jsonResult({
            status: acpAttachments.status,
            error: acpAttachments.error,
            ...roleContext,
          });
        }
        const startTime = Date.now();
        log.info(
          `[sessions_spawn] ACP: Calling spawnAcpDirect() at ${new Date(startTime).toISOString()}...`,
        );
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
            attachments: acpAttachments?.attachments,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
            inheritedToolAllowlist: opts?.inheritedToolAllowlist,
            inheritedToolDenylist: opts?.inheritedToolDenylist,
          },
        );
        const endTime = Date.now();
        const elapsedMs = endTime - startTime;
        log.info(
          `[sessions_spawn] ACP: spawnAcpDirect() returned after ${elapsedMs}ms at ${new Date(endTime).toISOString()}`,
        );
        log.info(
          `[sessions_spawn] ACP Result: status=${result.status}, runId=${(result as any).runId || "none"}`,
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" && Boolean(childSessionKey) && Boolean(childRunId);
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = getRuntimeConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const ownership = resolveSubagentSpawnOwnership({
            cfg,
            agentSessionKey: opts?.agentSessionKey,
            completionOwnerKey: opts?.completionOwnerKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          const shouldExpectCompletionMessage = result.inlineDelivery
            ? false
            : expectsCompletionMessage;
          try {
            log.info(
              `[sessions_spawn] ACP: Registering subagent run in registry with expectsCompletionMessage=${expectsCompletionMessage}`,
            );
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              controllerSessionKey: ownership.controllerSessionKey,
              requesterSessionKey: ownership.completionRequesterSessionKey,
              requesterOrigin,
              requesterDisplayKey: ownership.completionRequesterDisplayKey,
              task,
              taskName,
              requesterAgentId: opts?.requesterAgentIdOverride,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds: result.runTimeoutSeconds,
              expectsCompletionMessage: shouldExpectCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
            log.info(
              `[sessions_spawn] ACP: Successfully registered. childSessionKey=${childSessionKey}`,
            );
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
              ...roleContext,
            });
          }
        }
        log.info(
          `[sessions_spawn] ACP: IMMEDIATE_RETURN with status=${result.status} (Agent A continues immediately)`,
        );
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }

      // Subagent runtime path
      log.info(
        `[sessions_spawn] RUNTIME_PATH: SUBAGENT (spawning via spawnSubagentDirect)`,
      );
      log.info(
        `[sessions_spawn] SUBAGENT Config: sandbox=${sandbox}, lightContext=${lightContext}, thread=${thread}`,
      );
      
      const startTime = Date.now();
      log.info(
        `[sessions_spawn] SUBAGENT: Calling spawnSubagentDirect() at ${new Date(startTime).toISOString()}...`,
      );
      log.info(
        `[sessions_spawn] SUBAGENT: expectsCompletionMessage=${expectsCompletionMessage} (${expectsCompletionMessage ? "WILL WAIT for Agent B completion" : "IMMEDIATE return"})`,
      );

      const result = await spawnSubagentDirect(
        {
          task,
          taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          cwd,
          thread,
          mode,
          cleanup,
          sandbox,
          context,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          completionOwnerKey: opts?.completionOwnerKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
        },
      );

      const spawnEndTime = Date.now();
      const spawnElapsedMs = spawnEndTime - startTime;
      log.info(
        `[sessions_spawn] SUBAGENT: spawnSubagentDirect() returned after ${spawnElapsedMs}ms at ${new Date(spawnEndTime).toISOString()}`,
      );
      log.info(
        `[sessions_spawn] SUBAGENT Result: status=${result.status}, runId=${result.runId || "none"}, childSessionKey=${result.childSessionKey || "none"}`,
      );
      
      // If expectsCompletionMessage is true, wait for Agent B to complete and read its result
      if (expectsCompletionMessage && result.status === "accepted" && result.runId && result.childSessionKey) {
        log.info(
          `[sessions_spawn] SUBAGENT: SYNCHRONOUS MODE - Now waiting for Agent B (runId=${result.runId}) to complete...`,
        );
        
        // 🆕 Start listening to Agent B's events and relay text deltas to Agent A
        const childSessionKey = result.childSessionKey;
        const parentSessionKey = opts?.agentSessionKey;
        const childRunId = result.runId;
        const parentRunId = opts?.runId;  // ← Agent A's runId
        
        // Extract agent label from childSessionKey (e.g., "agent:fais-agent:subagent:xxx" → "fais-agent")
        const childAgentLabel = childSessionKey?.split(":")[1] || "Agent B";
        
        log.info(
          `[sessions_spawn] SUBAGENT STREAMING: Setting up event relay from child (${childSessionKey}) to parent (${parentSessionKey || "none"})`,
        );
        log.info(
          `[sessions_spawn] SUBAGENT STREAMING: Agent A runId=${parentRunId || "none"}, Agent B runId=${childRunId}`,
        );
        log.info(
          `[sessions_spawn] SUBAGENT STREAMING: Child agent label: "${childAgentLabel}"`,
        );
        
        // Track if we've sent the header
        let headerSent = false;
        let detailsClosed = false;  // Track if we've closed the collapsible section
        let progressLineCount = 0;
        // Thinking/reasoning deltas are display-only: they accumulate here so
        // reasoning-heavy models still show progress lines, but they must never
        // be checked by looksLikeReport() or count toward sustainedAnswerText —
        // thinking prose routinely contains "---\n#" style dividers or just runs
        // long, and either one used to get misread as the final answer starting.
        let thinkingPreview = "";
        let pendingText = "";  // Real assistant-text candidate for the final answer
        let lastEventWasToolCall = false;
        let accumulatedReportText = "";  // Accumulate all report text for final result
        // When the current uninterrupted run of real assistant text began (reset
        // on every tool call). Backs the sustained-answer fallback below.
        let textStreakStartedAt: number | undefined;

        // Helper function to remove markdown heading symbols from text
        const removeMarkdownHeadings = (text: string): string => {
          // Remove markdown heading symbols (# ## ### etc.) from each line
          // Split by newlines, remove # from start of each line, then rejoin
          return text
            .split('\n')
            .map(line => line.replace(/^#+\s*/, ''))
            .join('\n');
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
        
        // Subscribe to Agent B's events
        const unsubscribe = onAgentEvent((evt) => {
          // Only process events from the child session
          if (evt.sessionKey !== childSessionKey) {
            return;
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
              if (parentRunId && parentSessionKey) {
                const reopenText = `\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中...（繼續處理，點擊摺疊/展開）</summary>\n\n`;
                log.info(
                  `[sessions_spawn] SUBAGENT STREAMING: Tool call after details were closed — reopening section`,
                );
                emitAgentEvent({
                  runId: parentRunId,
                  sessionKey: parentSessionKey,
                  stream: "assistant",
                  data: {
                    text: reopenText,
                    delta: reopenText,
                  },
                });
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

              log.info(
                `[sessions_spawn] SUBAGENT STREAMING: Flushing accumulated text (${combinedPreview.length} chars) before tool call`,
              );

              emitAgentEvent({
                runId: parentRunId,
                sessionKey: parentSessionKey,
                stream: "assistant",
                data: {
                  text: formattedText,
                  delta: formattedText,
                },
              });
            }
            thinkingPreview = "";
            pendingText = "";
            textStreakStartedAt = undefined;
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
                emitAgentEvent({
                  runId: parentRunId,
                  sessionKey: parentSessionKey,
                  stream: "assistant",
                  data: {
                    text: `\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中... (點擊摺疊/展開)</summary>\n\n> 📋 **Session**: \`${childSessionKey}\`\n\n`,
                    delta: `\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中... (點擊摺疊/展開)</summary>\n\n> 📋 **Session**: \`${childSessionKey}\`\n\n`,
                  },
                });
              }
              log.info(
                `[sessions_spawn] SUBAGENT STREAMING: Received thinking delta (${thinkingDelta.length} chars)`,
              );
              thinkingPreview += thinkingDelta;
            }
            return;
          }

          // Only relay 'assistant' stream with text content
          if (evt.stream === "assistant" && evt.data) {
            const delta = evt.data.delta;

            // Check if this is a text delta (not tool calls, media, etc.)
            if (typeof delta === "string" && delta.length > 0 && parentRunId && parentSessionKey) {
              log.info(
                 `[sessions_spawn] SUBAGENT STREAMING: Received text delta (${delta.length} chars), lastWasToolCall=${lastEventWasToolCall}`,
              );

              // Send collapsible header on first output
              if (!headerSent) {
                headerSent = true;
                emitAgentEvent({
                  runId: parentRunId,
                  sessionKey: parentSessionKey,
                  stream: "assistant",
                  data: {
                    text: `\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中... (點擊摺疊/展開)</summary>\n\n> 📋 **Session**: \`${childSessionKey}\`\n\n`,
                    delta: `\n\n<details open>\n<summary>🔄 ${childAgentLabel} 執行中... (點擊摺疊/展開)</summary>\n\n> 📋 **Session**: \`${childSessionKey}\`\n\n`,
                  },
                });
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
                  log.info(
                    `[sessions_spawn] SUBAGENT STREAMING: Flushing accumulated thinking (${thinkingPreview.length} chars) after tool call`,
                  );
                  emitAgentEvent({
                    runId: parentRunId,
                    sessionKey: parentSessionKey,
                    stream: "assistant",
                    data: {
                      text: formattedThinking,
                      delta: formattedThinking,
                    },
                  });
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
                  log.info(
                    `[sessions_spawn] SUBAGENT STREAMING: Detected report start (${matchedMarker ? "🦉/marker" : "sustained answer text, no marker"}), closing details`,
                  );
                  const closeText = `\n</details>\n\n---\n\n**✅ ${childAgentLabel} 執行完成，開始生成報告** (${progressLineCount} 條進度更新)\n\n`;
                  emitAgentEvent({
                    runId: parentRunId,
                    sessionKey: parentSessionKey,
                    stream: "assistant",
                    data: {
                      text: closeText,
                      delta: closeText,
                    },
                  });
                  detailsClosed = true;
                  emitAgentEvent({
                    runId: parentRunId,
                    sessionKey: parentSessionKey,
                    stream: "assistant",
                    data: {
                      text: pendingText,
                      delta: pendingText,
                    },
                  });
                  accumulatedReportText += pendingText;
                  pendingText = "";
                }
              } else {
                // Already in report-streaming mode: relay immediately.
                log.info(
                  `[sessions_spawn] SUBAGENT STREAMING: Streaming report text (${pendingText.length} chars)`,
                );
                emitAgentEvent({
                  runId: parentRunId,
                  sessionKey: parentSessionKey,
                  stream: "assistant",
                  data: {
                    text: pendingText,
                    delta: pendingText,
                  },
                });
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

        log.info(
          `[sessions_spawn] SUBAGENT: Resolved runTimeoutSeconds=${resolvedRunTimeoutSeconds} (from config: ${cfg?.agents?.defaults?.subagents?.runTimeoutSeconds ?? "none"})`,
        );
        
        const waitTimeoutMs = (resolvedRunTimeoutSeconds || 300) * 1000 + 10000; // timeout + 10s buffer
        const waitStartTime = Date.now();
        
        try {
          log.info(
            `[sessions_spawn] SUBAGENT: Calling waitForAgentRun() with timeout=${waitTimeoutMs}ms...`,
          );
          
          const waitResult = await waitForAgentRun({
            runId: result.runId,
            timeoutMs: waitTimeoutMs,
          });
          
          const waitEndTime = Date.now();
          const waitElapsedMs = waitEndTime - waitStartTime;
          
          log.info(
            `[sessions_spawn] SUBAGENT: waitForAgentRun() completed with status=${waitResult.status} after ${waitElapsedMs}ms`,
          );
          
          if (waitResult.status === "ok") {
            // Agent B completed successfully, read its result
            log.info(
              `[sessions_spawn] SUBAGENT: Agent B completed successfully. Reading result from ${result.childSessionKey}...`,
            );
            
            const agentBResult = await readLatestAssistantReply({
              sessionKey: result.childSessionKey,
              limit: 50,
            });
            
            const totalElapsedMs = Date.now() - startTime;
            
            // 🆕 Clean up event listener
            log.info(
              `[sessions_spawn] SUBAGENT STREAMING: Cleaning up event listener after Agent B completion`,
            );
            log.info(
              `[sessions_spawn] SUBAGENT STREAMING: Relayed ${progressLineCount} progress updates`,
            );
            unsubscribe();
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
                emitAgentEvent({
                  runId: parentRunId,
                  sessionKey: parentSessionKey,
                  stream: "assistant",
                  data: {
                    text: closeText,
                    delta: closeText,
                  },
                });
                detailsClosed = true;
              }
              emitAgentEvent({
                runId: parentRunId,
                sessionKey: parentSessionKey,
                stream: "assistant",
                data: {
                  text: remainingText,
                  delta: remainingText,
                },
              });
              accumulatedReportText += remainingText;
              log.info(
                `[sessions_spawn] SUBAGENT STREAMING: Sent final pending text (${remainingText.length} chars)`,
              );
            }

            // Close the collapsible section if we opened it and haven't closed
            // it yet (covers the case where there was nothing left to flush).
            if (headerSent && !detailsClosed && parentRunId && parentSessionKey) {
              emitAgentEvent({
                runId: parentRunId,
                sessionKey: parentSessionKey,
                stream: "assistant",
                data: {
                  text: `\n</details>\n\n---\n\n**✅ ${childAgentLabel} 任務完成** (${progressLineCount} 條進度更新)\n\n`,
                  delta: `\n</details>\n\n---\n\n**✅ ${childAgentLabel} 任務完成** (${progressLineCount} 條進度更新)\n\n`,
                },
              });
            }
            
            if (agentBResult) {
              log.info(
                `[sessions_spawn] SUBAGENT: SUCCESS - Got Agent B result from transcript (${agentBResult.length} chars) after total ${totalElapsedMs}ms`,
              );
              
              // Use accumulated streaming text if available and longer than transcript result
              const finalResult = accumulatedReportText.length > agentBResult.length 
                ? accumulatedReportText 
                : agentBResult;
              
              if (accumulatedReportText.length > agentBResult.length) {
                log.info(
                  `[sessions_spawn] SUBAGENT: Using accumulated streaming text (${accumulatedReportText.length} chars) instead of transcript result (${agentBResult.length} chars)`,
                );
              }
              
              // Return the actual result from Agent B
              return jsonResult({
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
              });
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
            return jsonResult({
              ...result,
              note: `Subagent started but timed out after ${Math.round(waitElapsedMs / 1000)}s. Check /subagents list for status. Original note: ${result.note || ""}`,
            });
          } else {
            log.warn(
              `[sessions_spawn] SUBAGENT: Wait ERROR status=${waitResult.status}, error=${waitResult.error}. Returning accepted status.`,
            );
            // 🆕 Clean up event listener on error
            unsubscribe();
            return jsonResult({
              ...result,
              note: `Subagent started but wait failed (${waitResult.status}). Check /subagents list for status. Original note: ${result.note || ""}`,
            });
          }
        } catch (err) {
          const waitErrorMs = Date.now() - waitStartTime;
          log.error(
            `[sessions_spawn] SUBAGENT: Wait exception after ${waitErrorMs}ms: ${err instanceof Error ? err.message : String(err)}`,
          );
          // 🆕 Clean up event listener on exception
          unsubscribe();
          // Fall through to return accepted status
        }
      } else if (expectsCompletionMessage) {
        log.info(
          `[sessions_spawn] SUBAGENT: SYNCHRONOUS MODE requested but spawn did not return accepted status or missing runId/childSessionKey. Returning as-is.`,
        );
      } else {
        log.info(
          `[sessions_spawn] SUBAGENT: ASYNCHRONOUS MODE - Agent A received immediate acceptance (Agent B may still be running)`,
        );
      }
      
      log.info(
        `[sessions_spawn] EXIT: Returning tool result to Agent A`,
      );

      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
}
