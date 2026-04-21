import { describe, expect, it, vi } from "vitest";
import {
  createMessageEndContext,
  endMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import { createTestContext } from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import type { IterationTracker } from "./pi-embedded-iteration-tracker.js";

function createTracker() {
  const tracker = { onIterationStart: vi.fn(), onIterationEnd: vi.fn() };
  return tracker as typeof tracker & IterationTracker;
}

describe("agent iteration hook wiring", () => {
  it("fires onIterationStart once, before the first tool of an iteration", async () => {
    const tracker = createTracker();
    const history = [{ role: "user", content: "hi" }];
    const { ctx } = createTestContext();
    ctx.iterationTracker = tracker;
    ctx.params.session = { agent: { state: { messages: history } } } as never;

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-1",
      args: { path: "a.txt" },
    });
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-2",
      args: { path: "b.txt" },
    });

    expect(tracker.onIterationStart).toHaveBeenCalledOnce();
    expect(tracker.onIterationStart).toHaveBeenCalledWith({
      messages: history,
      hookContext: {
        runId: "run-test",
        agentId: "agent-test-id",
        sessionKey: "agent:unit-session",
        sessionId: "session-test-id",
      },
    });
  });

  it("passes an empty history when the session exposes no messages", async () => {
    const tracker = createTracker();
    const { ctx } = createTestContext();
    ctx.iterationTracker = tracker;

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-1",
      args: { path: "a.txt" },
    });

    expect(tracker.onIterationStart).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [] }),
    );
  });

  it("does not require an iteration tracker", async () => {
    const { ctx } = createTestContext();

    // The handler returns void or a promise depending on the path; awaiting
    // covers both and fails the test if it throws or rejects.
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-1",
      args: { path: "a.txt" },
    });

    expect(ctx.state.itemActiveIds.size).toBe(1);
  });

  it("fires onIterationEnd with the assistant message on message end", async () => {
    const tracker = createTracker();
    const ctx = createMessageEndContext();
    ctx.iterationTracker = tracker;
    const message = { role: "assistant", content: [{ type: "text", text: "done" }] };

    await endMessage(ctx, { message });

    expect(tracker.onIterationEnd).toHaveBeenCalledOnce();
    expect(tracker.onIterationEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessage: message,
        hookContext: expect.objectContaining({ runId: "run-1" }),
      }),
    );
  });

  it("does not fire onIterationEnd for non-assistant messages", async () => {
    const tracker = createTracker();
    const ctx = createMessageEndContext();
    ctx.iterationTracker = tracker;

    await endMessage(ctx, { message: { role: "user", content: "hi" } });

    expect(tracker.onIterationEnd).not.toHaveBeenCalled();
  });
});
