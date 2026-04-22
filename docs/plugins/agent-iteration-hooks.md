# Agent Iteration Hooks

## Overview

OpenClaw provides two new hooks to track each LLM iteration within an agent run:

- **`agent_iteration_start`** - Fired before each LLM call (after tool results are ready)
- **`agent_iteration_end`** - Fired after each LLM response (when tool calls are determined)

These hooks enable plugins to observe the internal agent loop, which includes multiple LLM calls for tool selection and execution.

## Use Cases

- **Observability**: Track each LLM decision in tracing systems (e.g., Langfuse, LangSmith)
- **Debugging**: Log the flow of tool calls and LLM responses
- **Metrics**: Measure per-iteration latency and token usage
- **Analytics**: Understand agent behavior patterns

## Hook: `agent_iteration_start`

Fired at the beginning of each agent iteration, after tool results from the previous iteration are ready.

### Event Structure

```typescript
{
  runId: string;              // Unique ID for this agent run
  sessionId: string;          // Session identifier
  iterationId: number;        // Iteration number (1, 2, 3, ...)
  toolResults?: unknown[];    // Results from previous iteration's tools
  messages: unknown[];        // Current session message history
  provider: string;           // Model provider (e.g., "openai", "anthropic")
  model: string;              // Model ID (e.g., "gpt-4", "claude-3")
}
```

**Note on `messages`:**

- ✅ Contains the full message history up to this point
- ✅ Includes user messages, assistant messages, and tool results
- ⚠️ Does NOT include the system prompt for this iteration
- ⚠️ Does NOT include the new prompt being constructed for the next LLM call

**Why these limitations?**
The hook fires at tool execution time (after the LLM has already responded), not at LLM call time (before the prompt is constructed). This is an architectural limitation of Pi Agent Core's event system.

### Context

```typescript
{
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}
```

### Example

```typescript
export const hooks = ["agent_iteration_start"] as const;

export const agent_iteration_start = (event, ctx) => {
  console.log(`Iteration ${event.iterationId} starting`);
  console.log(`Provider: ${event.provider}/${event.model}`);

  if (event.toolResults) {
    console.log(`Previous tool results:`, event.toolResults);
  }

  // Send to observability platform
  sendTrace({
    type: "iteration_start",
    runId: event.runId,
    iteration: event.iterationId,
    timestamp: Date.now(),
  });
};
```

## Hook: `agent_iteration_end`

Fired after each LLM response, when the model has decided which tools to call.

### Event Structure

```typescript
{
  runId: string;
  sessionId: string;
  iterationId: number;
  assistantMessage?: unknown;     // Full LLM response message
  toolCalls: Array<{              // Tools the LLM decided to call
    id?: string;
    name: string;
    arguments?: string;
  }>;
  usage?: {                       // Token usage for this iteration
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}
```

### Example

```typescript
export const hooks = ["agent_iteration_end"] as const;

export const agent_iteration_end = (event, ctx) => {
  console.log(`Iteration ${event.iterationId} completed`);
  console.log(
    `Tool calls planned:`,
    event.toolCalls.map((tc) => tc.name),
  );
  console.log(`Token usage:`, event.usage);

  // Send to observability platform
  sendTrace({
    type: "iteration_end",
    runId: event.runId,
    iteration: event.iterationId,
    toolCalls: event.toolCalls.length,
    tokens: event.usage?.total,
    timestamp: Date.now(),
  });
};
```

## Complete Example: Tracking Agent Iterations

```typescript
// Plugin: iteration-tracker
export const hooks = ["agent_iteration_start", "agent_iteration_end"] as const;

const iterations = new Map();

export const agent_iteration_start = (event, ctx) => {
  const key = `${event.runId}-${event.iterationId}`;

  iterations.set(key, {
    runId: event.runId,
    iteration: event.iterationId,
    startTime: Date.now(),
    provider: event.provider,
    model: event.model,
    toolResults: event.toolResults,
  });

  console.log(`[Iteration ${event.iterationId}] Starting LLM call`);
};

export const agent_iteration_end = (event, ctx) => {
  const key = `${event.runId}-${event.iterationId}`;
  const data = iterations.get(key);

  if (data) {
    data.endTime = Date.now();
    data.duration = data.endTime - data.startTime;
    data.toolCalls = event.toolCalls;
    data.usage = event.usage;

    console.log(
      `[Iteration ${event.iterationId}] Completed in ${data.duration}ms`,
    );
    console.log(
      `  - Tools planned: ${event.toolCalls.map((t) => t.name).join(", ")}`,
    );
    console.log(`  - Tokens used: ${event.usage?.total || 0}`);

    // Send to analytics
    sendIterationMetrics(data);

    iterations.delete(key);
  }
};
```

## Integration with Langfuse

```typescript
import { Langfuse } from "langfuse";

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
});

export const hooks = ["agent_iteration_start", "agent_iteration_end"] as const;

const generations = new Map();

export const agent_iteration_start = (event, ctx) => {
  const generationId = `${event.runId}-iter-${event.iterationId}`;

  const generation = langfuse.generation({
    id: generationId,
    traceId: event.runId,
    name: `Iteration ${event.iterationId}`,
    model: `${event.provider}/${event.model}`,
    input: event.toolResults || event.messages,
    startTime: new Date(),
  });

  generations.set(generationId, generation);
};

export const agent_iteration_end = (event, ctx) => {
  const generationId = `${event.runId}-iter-${event.iterationId}`;
  const generation = generations.get(generationId);

  if (generation) {
    generation.end({
      output: event.toolCalls,
      usage: {
        input: event.usage?.input,
        output: event.usage?.output,
        total: event.usage?.total,
      },
      endTime: new Date(),
    });

    generations.delete(generationId);
  }
};
```

## Comparison with Existing Hooks

| Hook                    | Fires                   | Captures                         |
| ----------------------- | ----------------------- | -------------------------------- |
| `llm_input`             | Once at start           | Initial user prompt              |
| `agent_iteration_start` | Each LLM call           | Tool results, iteration context  |
| `agent_iteration_end`   | After each LLM response | Tool calls, per-iteration usage  |
| `before_tool_call`      | Before each tool        | Individual tool parameters       |
| `after_tool_call`       | After each tool         | Individual tool results          |
| `llm_output`            | Once at end             | Cumulative usage, final response |

## Agent Flow with Iteration Hooks

```
User: "Read file.txt and count lines"

1. llm_input (initial prompt)
2. agent_iteration_start (iteration 1)
3. agent_iteration_end (decides: read_file)
4. before_tool_call (read_file)
5. after_tool_call (read_file)
6. agent_iteration_start (iteration 2, with tool results)
7. agent_iteration_end (decides: exec with wc -l)
8. before_tool_call (exec)
9. after_tool_call (exec)
10. agent_iteration_start (iteration 3, with results)
11. agent_iteration_end (decides: no more tools, final answer)
12. llm_output (cumulative usage)
```

## Notes

- Both hooks run in **fire-and-forget** mode (parallel execution)
- Errors in hook handlers are caught and logged
- `iterationId` starts at 1 and increments for each LLM call
- `toolResults` is `undefined` in the first iteration
- Token `usage` reflects only that specific iteration, not cumulative

## Limitations & Workarounds

### `agent_iteration_start` Input Data

**What's Available:**

- ✅ `toolResults`: Results from the previous iteration's tool executions
- ✅ `messages`: Full message history up to this point
- ✅ `provider` and `model`: Model configuration
- ✅ `iterationId`: Current iteration number

**What's NOT Available:**

- ❌ System prompt for this iteration
- ❌ User prompt being constructed for the next LLM call

**Why?**
The hook fires at **tool execution time** (after the LLM has already responded and decided on tool calls), not at **LLM call time** (before the prompt is constructed). This is an architectural limitation of Pi Agent Core's event system.

**Workaround:**
Use the `llm_input` hook to capture the initial system and user prompts:

```typescript
let initialPrompt = null;

export const llm_input = (event, ctx) => {
  // Capture the first LLM call's complete input
  initialPrompt = {
    systemPrompt: event.systemPrompt,
    prompt: event.prompt,
    messages: event.historyMessages,
  };
};

export const agent_iteration_start = (event, ctx) => {
  if (event.iterationId === 1 && initialPrompt) {
    // Use the captured initial prompt
    console.log("Initial system prompt:", initialPrompt.systemPrompt);
  }
  // For iterations 2+, focus on tool results and message history
  console.log("Tool results:", event.toolResults);
  console.log("Message history:", event.messages);
};
```

### Complete Observability Strategy

For full LLM input/output tracking:

1. **Use `llm_input`** for the initial prompt (iteration 1)
2. **Use `agent_iteration_start`** for tool results between iterations
3. **Use `agent_iteration_end`** for complete LLM outputs and decisions
4. **Use `before_compaction` / `after_compaction`** for context changes
5. **Use `llm_output`** for cumulative usage statistics

```typescript
export const hooks = [
  "llm_input",
  "agent_iteration_start",
  "agent_iteration_end",
  "before_compaction",
  "after_compaction",
  "llm_output",
] as const;

let trace = null;

export const llm_input = (event, ctx) => {
  trace = {
    runId: event.runId,
    initialInput: {
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
    },
    iterations: [],
    compacted: false,
  };
};

export const agent_iteration_start = (event, ctx) => {
  trace.iterations[event.iterationId - 1] = {
    id: event.iterationId,
    startTime: Date.now(),
    toolResults: event.toolResults,
    messages: event.messages,
    messagesCount: event.messages.length,
  };
};

export const agent_iteration_end = (event, ctx) => {
  const iteration = trace.iterations[event.iterationId - 1];
  if (iteration) {
    iteration.endTime = Date.now();
    iteration.output = event.assistantMessage;
    iteration.toolCalls = event.toolCalls;
    iteration.usage = event.usage;
  }
};

export const before_compaction = (event, ctx) => {
  trace.compacted = true;
  trace.compactionTriggeredAt = Date.now();
};

export const after_compaction = (event, ctx) => {
  // After compaction:
  // - System prompt may have changed (AGENTS.md sections re-injected)
  // - Message history has been summarized
  trace.compactionCompletedAt = Date.now();
};

export const llm_output = (event, ctx) => {
  trace.cumulativeUsage = event.usage;
  sendToObservabilityPlatform(trace);
};
```

### Important: System Prompt and Message History Can Change

**System Prompt Changes After Compaction:**

- ✅ When a session nears the context limit, [compaction](/concepts/compaction) summarizes old messages
- ✅ After compaction, OpenClaw re-injects critical sections from `AGENTS.md`
- ✅ Default sections: "Session Startup" and "Red Lines"
- ✅ Configurable via `agents.defaults.compaction.postCompactionSections`
- ⚠️ `agent_iteration_start` does NOT receive the system prompt
- 💡 Use `llm_input` to capture the initial system prompt
- 💡 Use `before_compaction` / `after_compaction` hooks to track changes

**Message History Truncation via Compaction:**

- ✅ Older messages are summarized into a compact entry
- ✅ Recent turns are preserved (default: last 3 turns, configurable via `compaction.recentTurnsPreserve`)
- ✅ Tool calls and results stay paired (won't be split)
- ⚠️ `event.messages` in `agent_iteration_start` may contain a summary instead of full history
- 💡 Check `event.messages.length` changes over time to detect compaction
- 💡 Use `after_compaction` hook to know when history has been compressed

**Example: Tracking Context Changes**

```typescript
let systemPromptSnapshot = null;
let hasCompacted = false;
let previousMessagesCount = 0;

export const llm_input = (event, ctx) => {
  systemPromptSnapshot = event.systemPrompt;
  console.log("Initial system prompt length:", systemPromptSnapshot.length);
};

export const agent_iteration_start = (event, ctx) => {
  const currentCount = event.messages.length;

  if (hasCompacted) {
    console.log("This iteration uses compacted context");
  }

  if (currentCount < previousMessagesCount) {
    console.log("Message history was compressed:", {
      before: previousMessagesCount,
      after: currentCount,
    });
  }

  previousMessagesCount = currentCount;
};

export const after_compaction = (event, ctx) => {
  hasCompacted = true;
  console.log("System prompt has been updated after compaction");
  console.log("AGENTS.md sections may have been re-injected");
};
```

## Related

- [Agent Loop](/concepts/agent-loop)
- [Plugin Hooks](/plugins/architecture#provider-runtime-hooks)
- [Tool Hooks](/tools)
