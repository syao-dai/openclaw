import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type {
  PluginHookAgentIterationStartEvent,
  PluginHookAgentIterationEndEvent,
} from "./hook-types.js";

describe("agent iteration hooks", () => {
  it("should register and run agent_iteration_start hook", async () => {
    const startHandler = vi.fn();

    const runner = createHookRunner({
      typedHooks: [
        {
          pluginId: "test-plugin",
          hookName: "agent_iteration_start",
          handler: startHandler,
          source: "test",
        },
      ],
      plugins: [{ id: "test-plugin", status: "loaded" }],
    });

    const event: PluginHookAgentIterationStartEvent = {
      runId: "run-1",
      sessionId: "session-1",
      iterationId: 1,
      messages: [],
      provider: "openai",
      model: "gpt-4",
    };

    await runner.runAgentIterationStart(event, { runId: "run-1" });

    expect(startHandler).toHaveBeenCalledOnce();
    expect(startHandler).toHaveBeenCalledWith(event, { runId: "run-1" });
  });

  it("should register and run agent_iteration_end hook", async () => {
    const endHandler = vi.fn();

    const runner = createHookRunner({
      typedHooks: [
        {
          pluginId: "test-plugin",
          hookName: "agent_iteration_end",
          handler: endHandler,
          source: "test",
        },
      ],
      plugins: [{ id: "test-plugin", status: "loaded" }],
    });

    const event: PluginHookAgentIterationEndEvent = {
      runId: "run-1",
      sessionId: "session-1",
      iterationId: 1,
      assistantMessage: { role: "assistant", content: "test" },
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: '{"path": "test.txt"}' },
      ],
      usage: { input: 100, output: 50, total: 150 },
    };

    await runner.runAgentIterationEnd(event, { runId: "run-1" });

    expect(endHandler).toHaveBeenCalledOnce();
    expect(endHandler).toHaveBeenCalledWith(event, { runId: "run-1" });
  });

  it("should handle multiple handlers for agent_iteration_start", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const runner = createHookRunner({
      typedHooks: [
        {
          pluginId: "plugin-1",
          hookName: "agent_iteration_start",
          handler: handler1,
          priority: 10,
          source: "test",
        },
        {
          pluginId: "plugin-2",
          hookName: "agent_iteration_start",
          handler: handler2,
          priority: 5,
          source: "test",
        },
      ],
      plugins: [
        { id: "plugin-1", status: "loaded" },
        { id: "plugin-2", status: "loaded" },
      ],
    });

    const event: PluginHookAgentIterationStartEvent = {
      runId: "run-1",
      sessionId: "session-1",
      iterationId: 2,
      toolResults: [{ result: "previous tool output" }],
      messages: [],
      provider: "anthropic",
      model: "claude-3",
    };

    await runner.runAgentIterationStart(event, { runId: "run-1" });

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it("should pass tool results in agent_iteration_start event", async () => {
    const handler = vi.fn();

    const runner = createHookRunner({
      typedHooks: [
        {
          pluginId: "test-plugin",
          hookName: "agent_iteration_start",
          handler,
          source: "test",
        },
      ],
      plugins: [{ id: "test-plugin", status: "loaded" }],
    });

    const toolResults = [
      { toolName: "read_file", result: "file content" },
      { toolName: "exec", result: "command output" },
    ];

    const event: PluginHookAgentIterationStartEvent = {
      runId: "run-1",
      sessionId: "session-1",
      iterationId: 2,
      toolResults,
      messages: [],
      provider: "openai",
      model: "gpt-4",
    };

    await runner.runAgentIterationStart(event, { runId: "run-1" });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        toolResults: expect.arrayContaining([
          expect.objectContaining({ toolName: "read_file" }),
          expect.objectContaining({ toolName: "exec" }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("should pass tool calls in agent_iteration_end event", async () => {
    const handler = vi.fn();

    const runner = createHookRunner({
      typedHooks: [
        {
          pluginId: "test-plugin",
          hookName: "agent_iteration_end",
          handler,
          source: "test",
        },
      ],
      plugins: [{ id: "test-plugin", status: "loaded" }],
    });

    const toolCalls = [
      { id: "call-1", name: "read_file", arguments: '{"path": "a.txt"}' },
      { id: "call-2", name: "read_file", arguments: '{"path": "b.txt"}' },
      { id: "call-3", name: "exec", arguments: '{"command": "ls"}' },
    ];

    const event: PluginHookAgentIterationEndEvent = {
      runId: "run-1",
      sessionId: "session-1",
      iterationId: 3,
      assistantMessage: { role: "assistant", content: "" },
      toolCalls,
      usage: { input: 200, output: 100, total: 300 },
    };

    await runner.runAgentIterationEnd(event, { runId: "run-1" });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: expect.arrayContaining([
          expect.objectContaining({ name: "read_file" }),
          expect.objectContaining({ name: "exec" }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("should catch and log errors in agent_iteration_start hook", async () => {
    const errorHandler = vi.fn(() => {
      throw new Error("Hook failed");
    });
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = createHookRunner(
      {
        typedHooks: [
          {
            pluginId: "test-plugin",
            hookName: "agent_iteration_start",
            handler: errorHandler,
            source: "test",
          },
        ],
        plugins: [{ id: "test-plugin", status: "loaded" }],
      },
      { logger, catchErrors: true },
    );

    const event: PluginHookAgentIterationStartEvent = {
      runId: "run-1",
      sessionId: "session-1",
      iterationId: 1,
      messages: [],
      provider: "openai",
      model: "gpt-4",
    };

    await runner.runAgentIterationStart(event, { runId: "run-1" });

    expect(errorHandler).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("agent_iteration_start handler from test-plugin failed"),
    );
  });

  it("hasHooks should return true when iteration hooks are registered", () => {
    const runner = createHookRunner({
      typedHooks: [
        {
          pluginId: "test-plugin",
          hookName: "agent_iteration_start",
          handler: vi.fn(),
          source: "test",
        },
      ],
      plugins: [{ id: "test-plugin", status: "loaded" }],
    });

    expect(runner.hasHooks("agent_iteration_start")).toBe(true);
    expect(runner.hasHooks("agent_iteration_end")).toBe(false);
  });
});
