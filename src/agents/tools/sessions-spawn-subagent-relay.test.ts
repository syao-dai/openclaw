import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChildListener = (evt: {
  sessionKey: string;
  stream: string;
  data: Record<string, unknown>;
}) => void;

const mocks = vi.hoisted(() => ({
  listener: undefined as ChildListener | undefined,
  unsubscribe: vi.fn(),
  emitted: [] as string[],
  markProgress: vi.fn(),
  debug: vi.fn(),
  waitForAgentRun: vi.fn(),
  readLatestAssistantReply: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent: (listener: ChildListener) => {
    mocks.listener = listener;
    return mocks.unsubscribe;
  },
  emitAgentEventIfCurrent: (event: { data: { text: string } }) => {
    mocks.emitted.push(event.data.text);
    return true;
  },
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../logging/diagnostic-run-activity.js", () => ({
  markDiagnosticRunProgress: mocks.markProgress,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: mocks.debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("../run-wait.js", () => ({
  waitForAgentRun: mocks.waitForAgentRun,
  readLatestAssistantReply: mocks.readLatestAssistantReply,
}));
vi.mock("../subagents/spawn/subagent-spawn-plan.js", () => ({
  resolveConfiguredSubagentRunTimeoutSeconds: () => 60,
}));

const { waitForSubagentRunWithRelay } = await import("./sessions-spawn-subagent-relay.js");

const CHILD = "agent:worker:subagent:1";

function startRelay() {
  let settle!: (result: { status: string }) => void;
  mocks.waitForAgentRun.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  const done = waitForSubagentRunWithRelay({
    result: { runId: "child-run", childSessionKey: CHILD, mode: "run" } as never,
    parentSessionKey: "agent:main:parent",
    parentRunId: "parent-run",
    startTime: Date.now(),
    spawnElapsedMs: 0,
  });
  return { done, settle };
}

function childEvent(stream: string, data: Record<string, unknown>) {
  mocks.listener?.({ sessionKey: CHILD, stream, data });
}

function textDelta(delta: string) {
  childEvent("assistant", { delta });
}

/** The report starts at the 🦉 marker; everything emitted after the "完成" banner is report text. */
function reportEmits() {
  const banner = mocks.emitted.findIndex((text) => text.includes("開始生成報告"));
  return banner < 0 ? [] : mocks.emitted.slice(banner + 1);
}

describe("waitForSubagentRunWithRelay report relay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listener = undefined;
    mocks.emitted.length = 0;
    mocks.unsubscribe.mockClear();
    mocks.markProgress.mockClear();
    mocks.debug.mockClear();
    mocks.readLatestAssistantReply.mockResolvedValue("transcript reply");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces tiny report deltas without reordering or losing text", async () => {
    const { done, settle } = startRelay();
    textDelta("🦉");
    for (let i = 0; i < 500; i += 1) {
      textDelta("x");
    }
    settle({ status: "ok" });
    const result = await done;

    const chunks = reportEmits();
    expect(chunks.join("")).toBe(`🦉${"x".repeat(500)}`);
    // 501 deltas -> a handful of size-triggered flushes plus the tail flush, never per-delta.
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(result?.status).toBe("completed");
  });

  it("does not write per-delta debug logs", async () => {
    const { done, settle } = startRelay();
    textDelta("🦉");
    for (let i = 0; i < 100; i += 1) {
      textDelta("y");
    }
    settle({ status: "ok" });
    await done;

    const perDelta = mocks.debug.mock.calls.filter(([message]) =>
      /Received text delta|Streaming report text/.test(String(message)),
    );
    expect(perDelta).toEqual([]);
  });

  it("flushes a small buffered report after the coalescing interval", async () => {
    const { done, settle } = startRelay();
    textDelta("🦉");
    textDelta("ab");
    expect(reportEmits()).toEqual([]);

    await vi.advanceTimersByTimeAsync(80);
    expect(reportEmits().join("")).toBe("🦉ab");

    settle({ status: "ok" });
    await done;
  });

  it("emits buffered report text before a later non-report event", async () => {
    const { done, settle } = startRelay();
    textDelta("🦉");
    textDelta("tail");
    // A tool call after the report was detected reopens the progress section: the buffered
    // report text must go out first so the parent stream keeps child output order.
    childEvent("tool", {});
    settle({ status: "ok" });
    await done;

    const joined = reportEmits().join("");
    expect(joined.indexOf("🦉tail")).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf("🦉tail")).toBeLessThan(joined.indexOf("執行中"));
  });

  it("flushes the buffered tail when the wait times out", async () => {
    const { done, settle } = startRelay();
    textDelta("🦉");
    textDelta("partial");
    settle({ status: "timeout" });
    const result = await done;

    expect(reportEmits().join("")).toBe("🦉partial");
    expect(result?.note).toContain("timed out");
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });

  it("touches the parent's diagnostic progress at most once per second", async () => {
    const { done, settle } = startRelay();
    textDelta("🦉");
    for (let i = 0; i < 200; i += 1) {
      textDelta("z");
    }
    expect(mocks.markProgress).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    textDelta("z");
    expect(mocks.markProgress).toHaveBeenCalledTimes(2);

    settle({ status: "ok" });
    await done;
  });
});
