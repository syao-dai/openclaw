# Implementation Summary: Agent Iteration Hooks

## 🎯 Goal

Add two new hooks (`agent_iteration_start` and `agent_iteration_end`) to track each LLM call within an agent run, enabling better observability for plugins like Langfuse tracer.

## 📝 Changes Made

### 1. Core Type Definitions

**File: `src/plugins/hook-types.ts`**

- ✅ Added `"agent_iteration_start"` and `"agent_iteration_end"` to `PluginHookName` type union
- ✅ Added both hooks to `PLUGIN_HOOK_NAMES` array
- ✅ Defined `PluginHookAgentIterationStartEvent` type:
  ```typescript
  {
    runId: string;
    sessionId: string;
    iterationId: number;
    toolResults?: unknown[];
    messages: unknown[];
    provider: string;
    model: string;
  }
  ```
- ✅ Defined `PluginHookAgentIterationEndEvent` type:
  ```typescript
  {
    runId: string;
    sessionId: string;
    iterationId: number;
    assistantMessage?: unknown;
    toolCalls: Array<{
      id?: string;
      name: string;
      arguments?: string;
    }>;
    usage?: { ... };
  }
  ```
- ✅ Added handlers to `PluginHookHandlerMap`

### 2. Hook Runner Implementation

**File: `src/plugins/hooks.ts`**

- ✅ Imported new event types
- ✅ Implemented `runAgentIterationStart()` function
- ✅ Implemented `runAgentIterationEnd()` function
- ✅ Exported both functions from `createHookRunner()`
- ✅ Both hooks use `runVoidHook()` (fire-and-forget, parallel execution)

### 3. Testing

**File: `src/plugins/wired-hooks-iteration.test.ts`** (New)

- ✅ Test: Basic `agent_iteration_start` registration and execution
- ✅ Test: Basic `agent_iteration_end` registration and execution
- ✅ Test: Multiple handlers with priority ordering
- ✅ Test: Tool results passing in `agent_iteration_start`
- ✅ Test: Tool calls passing in `agent_iteration_end`
- ✅ Test: Error handling and logging
- ✅ Test: `hasHooks()` integration

### 4. Documentation

**File: `docs/plugins/agent-iteration-hooks.md`** (New)

- ✅ Overview and use cases
- ✅ Event structure documentation
- ✅ Complete examples
- ✅ Langfuse integration example
- ✅ Comparison with existing hooks
- ✅ Agent flow diagram

## 🔧 Remaining Work

### Critical: Add Trigger Logic

**File: `src/agents/pi-embedded-subscribe.ts`** (Not yet modified)

This is the **most important** remaining step. We need to:

1. Track iteration count
2. Detect when LLM returns tool calls
3. Fire `agent_iteration_end` with tool call information
4. Fire `agent_iteration_start` before next LLM call with tool results

**Suggested approach:**

```typescript
// In subscribeEmbeddedPiSession()
let iterationCount = 0;
let lastToolCalls: any[] = [];

// Listen to Pi Agent events
session.on("message", async (evt) => {
  // When assistant message contains tool calls
  const toolCalls = extractToolCalls(evt);
  if (toolCalls && toolCalls.length > 0) {
    iterationCount++;
    
    // Fire agent_iteration_end
    if (hookRunner?.hasHooks("agent_iteration_end")) {
      hookRunner.runAgentIterationEnd({
        runId: params.runId,
        sessionId: params.sessionId,
        iterationId: iterationCount,
        assistantMessage: evt,
        toolCalls,
        usage: extractUsage(evt),
      }, hookCtx).catch(err => log.warn(...));
    }
    
    lastToolCalls = toolCalls;
  }
});

session.on("tool_execution_start", async (evt) => {
  // First tool in this iteration - fire agent_iteration_start
  if (isFirstToolInIteration) {
    if (hookRunner?.hasHooks("agent_iteration_start")) {
      hookRunner.runAgentIterationStart({
        runId: params.runId,
        sessionId: params.sessionId,
        iterationId: iterationCount + 1,
        toolResults: collectToolResults(lastToolCalls),
        messages: session.messages,
        provider: params.provider,
        model: params.modelId,
      }, hookCtx).catch(err => log.warn(...));
    }
  }
});
```

### Optional Enhancements

1. **Add to Plugin SDK exports** (if needed for external plugins)
   - Run `pnpm plugin-sdk:api:gen` after all changes

2. **Update CHANGELOG.md**
   ```markdown
   ### Changes
   - Plugins/hooks: add `agent_iteration_start` and `agent_iteration_end` hooks 
     to observe each LLM call within an agent run, enabling per-iteration 
     observability for tracing systems like Langfuse.
   ```

3. **Update main plugin architecture docs**
   - Add to `docs/plugins/architecture.md` hook list

## ✅ Testing Strategy

### Unit Tests
```bash
pnpm test src/plugins/wired-hooks-iteration.test.ts
```

### Integration Test
Create a test plugin:
```typescript
// extensions/test-iteration-tracker/index.ts
export const hooks = ["agent_iteration_start", "agent_iteration_end"];
export const agent_iteration_start = (event, ctx) => {
  console.log(`ITER_START: ${event.iterationId}`);
};
export const agent_iteration_end = (event, ctx) => {
  console.log(`ITER_END: ${event.iterationId}, tools: ${event.toolCalls.length}`);
};
```

Then run an agent with multiple tool calls:
```bash
openclaw agent "Read file.txt and count the lines"
```

Expected output:
```
ITER_START: 1
ITER_END: 1, tools: 1
ITER_START: 2
ITER_END: 2, tools: 1
ITER_START: 3
ITER_END: 3, tools: 0
```

## 📊 Architecture Impact

### Before (Current State)
```
User prompt → llm_input
            ↓
    [Pi Agent Internal Loop]
    - LLM call 1 → tool_1 → tool_2
    - LLM call 2 → tool_3
    - LLM call 3 → final answer
            ↓
    llm_output (cumulative)
```

**Problem**: Cannot observe individual LLM calls

### After (With New Hooks)
```
User prompt → llm_input
            ↓
    agent_iteration_start (1)
    → LLM call 1
    → agent_iteration_end (1, tool calls: [tool_1, tool_2])
    → before_tool_call → after_tool_call (tool_1)
    → before_tool_call → after_tool_call (tool_2)
    ↓
    agent_iteration_start (2, tool results)
    → LLM call 2
    → agent_iteration_end (2, tool calls: [tool_3])
    → before_tool_call → after_tool_call (tool_3)
    ↓
    agent_iteration_start (3, tool results)
    → LLM call 3
    → agent_iteration_end (3, tool calls: [])
            ↓
    llm_output (cumulative)
```

**Benefit**: Full observability of each iteration

## 🚀 Next Steps

1. ✅ Core types defined
2. ✅ Hook runners implemented
3. ✅ Tests created
4. ✅ Documentation written
5. ⏳ **Add trigger logic in `pi-embedded-subscribe.ts`**
6. ⏳ Run tests: `pnpm tsgo && pnpm test src/plugins/wired-hooks-iteration.test.ts`
7. ⏳ Update Plugin SDK API: `pnpm plugin-sdk:api:gen`
8. ⏳ Test with real plugin
9. ⏳ Update CHANGELOG.md
10. ⏳ Submit PR

## 📚 References

- Investigation: `submodules/langfuse_tracer/INVESTIGATION.md`
- Hook types: `src/plugins/hook-types.ts`
- Hook runner: `src/plugins/hooks.ts`
- Pi subscribe: `src/agents/pi-embedded-subscribe.ts`
- Agent loop docs: `docs/concepts/agent-loop.md`
