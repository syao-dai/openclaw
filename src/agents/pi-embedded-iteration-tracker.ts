/**
 * Agent Iteration Tracking
 *
 * Tracks LLM iterations within an agent run and fires agent_iteration_start/end hooks.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { HookRunner } from "../plugins/hooks.js";
import type { PluginHookAgentContext } from "../plugins/hook-types.js";

export type IterationTracker = {
  /**
   * Call when an assistant message with tool calls is detected.
   * Fires agent_iteration_end hook.
   */
  onIterationEnd: (params: {
    assistantMessage: AgentMessage;
    hookContext: PluginHookAgentContext;
  }) => void;

  /**
   * Call when tools are about to execute (before first tool in this batch).
   * Fires agent_iteration_start hook.
   */
  onIterationStart: (params: {
    messages: unknown[];
    hookContext: PluginHookAgentContext;
  }) => void;

  /**
   * Get current iteration count.
   */
  getIterationCount: () => number;
};

/**
 * Extract tool calls from assistant message.
 */
export function extractToolCallsFromMessage(message: AgentMessage | undefined): Array<{
  id?: string;
  name: string;
  arguments?: string;
}> | null {
  if (!message || message.role !== "assistant") {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const toolCalls: Array<{
    id?: string;
    name: string;
    arguments?: string;
  }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const record = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      arguments?: unknown;
    };

    // Support various tool call formats:
    // - Anthropic: type: "tool_use", name, input, id
    // - OpenAI: type: "toolCall" or "tool_call", name, arguments, id
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (
      type === "tool_use" ||
      type === "tooluse" ||
      type === "tool_call" ||
      type === "toolcall"
    ) {
      const name = typeof record.name === "string" ? record.name : "";
      if (!name) {
        continue;
      }

      const id = typeof record.id === "string" ? record.id : undefined;

      // Try to extract arguments/input
      let argsStr: string | undefined;
      if (record.arguments) {
        if (typeof record.arguments === "string") {
          argsStr = record.arguments;
        } else if (typeof record.arguments === "object") {
          try {
            argsStr = JSON.stringify(record.arguments);
          } catch {
            argsStr = undefined;
          }
        }
      } else if (record.input) {
        if (typeof record.input === "string") {
          argsStr = record.input;
        } else if (typeof record.input === "object") {
          try {
            argsStr = JSON.stringify(record.input);
          } catch {
            argsStr = undefined;
          }
        }
      }

      toolCalls.push({
        id,
        name,
        arguments: argsStr,
      });
    }
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

/**
 * Extract usage from assistant message.
 */
export function extractUsageFromMessage(message: AgentMessage | undefined): {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
} | undefined {
  if (!message) {
    return undefined;
  }

  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;

  const result: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  } = {};

  // Support various usage field names
  if (typeof record.input === "number") {
    result.input = record.input;
  } else if (typeof record.input_tokens === "number") {
    result.input = record.input_tokens;
  } else if (typeof record.inputTokens === "number") {
    result.input = record.inputTokens;
  }

  if (typeof record.output === "number") {
    result.output = record.output;
  } else if (typeof record.output_tokens === "number") {
    result.output = record.output_tokens;
  } else if (typeof record.outputTokens === "number") {
    result.output = record.outputTokens;
  }

  if (typeof record.cacheRead === "number") {
    result.cacheRead = record.cacheRead;
  } else if (typeof record.cache_read_input_tokens === "number") {
    result.cacheRead = record.cache_read_input_tokens;
  } else if (typeof record.cacheReadTokens === "number") {
    result.cacheRead = record.cacheReadTokens;
  }

  if (typeof record.cacheWrite === "number") {
    result.cacheWrite = record.cacheWrite;
  } else if (typeof record.cache_creation_input_tokens === "number") {
    result.cacheWrite = record.cache_creation_input_tokens;
  } else if (typeof record.cacheWriteTokens === "number") {
    result.cacheWrite = record.cacheWriteTokens;
  }

  if (typeof record.total === "number") {
    result.total = record.total;
  } else if (typeof record.total_tokens === "number") {
    result.total = record.total_tokens;
  } else if (typeof record.totalTokens === "number") {
    result.total = record.totalTokens;
  }

  // Return undefined if no usage fields found
  if (
    result.input === undefined &&
    result.output === undefined &&
    result.cacheRead === undefined &&
    result.cacheWrite === undefined &&
    result.total === undefined
  ) {
    return undefined;
  }

  return result;
}

/**
 * Create an iteration tracker for an agent run.
 */
export function createIterationTracker(params: {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  hookRunner: HookRunner | undefined;
  log: { debug?: (msg: string) => void; warn: (msg: string) => void };
}): IterationTracker {
  let iterationCount = 0;
  let lastToolCalls: Array<{ id?: string; name: string; arguments?: string }> = [];
  let pendingIterationStart = false;

  return {
    onIterationEnd: ({ assistantMessage, hookContext }) => {
      const toolCalls = extractToolCallsFromMessage(assistantMessage);
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls - this is the final response
        return;
      }

      iterationCount++;
      lastToolCalls = toolCalls;
      pendingIterationStart = true;

      // Fire agent_iteration_end hook
      if (params.hookRunner?.hasHooks("agent_iteration_end")) {
        params.log.debug?.(
          `[iteration-tracker] firing agent_iteration_end: iteration=${iterationCount} tools=${toolCalls.length}`,
        );

        params.hookRunner
          .runAgentIterationEnd(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              iterationId: iterationCount,
              assistantMessage,
              toolCalls,
              usage: extractUsageFromMessage(assistantMessage),
            },
            hookContext,
          )
          .catch((err) => {
            params.log.warn(`agent_iteration_end hook failed: ${String(err)}`);
          });
      }
    },

    onIterationStart: ({ messages, hookContext }) => {
      if (!pendingIterationStart) {
        return;
      }

      pendingIterationStart = false;

      // Fire agent_iteration_start hook
      if (params.hookRunner?.hasHooks("agent_iteration_start")) {
        params.log.debug?.(
          `[iteration-tracker] firing agent_iteration_start: iteration=${iterationCount + 1} previousTools=${lastToolCalls.length}`,
        );

        params.hookRunner
          .runAgentIterationStart(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              iterationId: iterationCount + 1,
              toolResults: undefined, // Will be filled by tool execution results
              messages,
              provider: params.provider,
              model: params.model,
            },
            hookContext,
          )
          .catch((err) => {
            params.log.warn(`agent_iteration_start hook failed: ${String(err)}`);
          });
      }
    },

    getIterationCount: () => iterationCount,
  };
}
