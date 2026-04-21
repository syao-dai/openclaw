import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  readLatestAssistantReply,
  waitForAgentRun,
} from "../run-wait.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "../subagent-spawn-plan.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

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

type AcpSpawnModule = typeof import("../acp-spawn.js");

let acpSpawnModulePromise: Promise<AcpSpawnModule> | undefined;

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  acpSpawnModulePromise ??= import("../acp-spawn.js");
  return await acpSpawnModulePromise;
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

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS),
  lightContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
    }),
  ),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
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
});

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool(),
    parameters: SessionsSpawnToolSchema,
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
      const task = readStringParam(params, "task", { required: true });
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
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
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};

      if (streamTo && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
          ...roleContext,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
          ...roleContext,
        });
      }

      if (runtime === "acp") {
        log.info(
          `[sessions_spawn] RUNTIME_PATH: ACP (spawning via spawnAcpDirect)`,
        );
        log.info(
          `[sessions_spawn] ACP Config: streamTo=${streamTo || "none"}, resumeSessionId=${resumeSessionId || "none"}`,
        );
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
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
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
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
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = loadConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          try {
            log.info(
              `[sessions_spawn] ACP: Registering subagent run in registry with expectsCompletionMessage=${expectsCompletionMessage}`,
            );
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin,
              requesterDisplayKey,
              task,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds,
              expectsCompletionMessage,
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
        return jsonResult(result);
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
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          sandbox,
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
        
        // Resolve the actual runTimeoutSeconds from config if not explicitly set
        const cfg = loadConfig();
        const resolvedRunTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
          cfg,
          runTimeoutSeconds,
        });
        
        log.info(
          `[sessions_spawn] SUBAGENT: Resolved runTimeoutSeconds=${resolvedRunTimeoutSeconds} (from tool param: ${runTimeoutSeconds ?? "none"}, from config: ${cfg?.agents?.defaults?.subagents?.runTimeoutSeconds ?? "none"})`,
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
            
            if (agentBResult) {
              log.info(
                `[sessions_spawn] SUBAGENT: SUCCESS - Got Agent B result (${agentBResult.length} chars) after total ${totalElapsedMs}ms`,
              );
              
              // Return the actual result from Agent B
              return jsonResult({
                status: "completed",
                childSessionKey: result.childSessionKey,
                runId: result.runId,
                mode: result.mode,
                result: agentBResult,
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
            return jsonResult({
              ...result,
              note: `Subagent started but timed out after ${Math.round(waitElapsedMs / 1000)}s. Check /subagents list for status. Original note: ${result.note || ""}`,
            });
          } else {
            log.warn(
              `[sessions_spawn] SUBAGENT: Wait ERROR status=${waitResult.status}, error=${waitResult.error}. Returning accepted status.`,
            );
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

      return jsonResult(result);
    },
  };
}
