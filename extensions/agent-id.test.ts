// OMP host suite (Bun). Mirrors extensions/agent-id.pi.test.ts: when changing
// shared behavior, add matching assertions to both suites.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import agentIdExtension, {
  ACTIVITY_STATE_VALUES,
  AGENT_ID_CURRENT_COMMAND,
  AUTO_SUMMARY_ENTRY_TYPE,
  AUTO_SUMMARY_LIMIT,
  AUTO_SUMMARY_MAX_CHARS,
  buildAnnotateArgs,
  buildSummaryInput,
  createHostAdapter,
  isOmpContext,
  latestExchange,
  normalizeAutoSummary,
  restoreAutoSummaryState,
  sessionFileExtension,
  shouldSummarize,
  withIdentity,
  type ExtensionAPI,
  type SessionContext,
} from "./agent-id.ts";

const OMP_EVENTS = new Set([
  "session_start",
  "session_switch",
  "session_branch",
  "session_tree",
  "session_before_switch",
  "session_before_branch",
  "session_before_tree",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "tool_call",
]);

const completeSimple = mock(async (_model: unknown, _context: unknown, _options: unknown) => ({
  content: [{ type: "text", text: "Wiring host adapters" }],
  stopReason: "stop",
}));
mock.module("@oh-my-pi/pi-ai", () => ({ completeSimple }));

let root: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-id-omp-"));
  mkdirSync(path.join(root, "registry"));
  savedPath = process.env.PATH;
  process.env.PATH = `${root}:/usr/bin:/bin`;
  process.env.AGENT_ID_TEST_LOG = path.join(root, "calls.log");
  process.env.AGENT_ID_TEST_REGISTRY = path.join(root, "registry");
  writeFileSync(
    path.join(root, "agent-id"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$AGENT_ID_TEST_LOG"
json() { printf '{"session_id":"%s","name":"Test Agent of Realm","slug":"test-agent-realm","first_name":"Test","family_name":"Agent","realm":"Realm"}\\n' "$1"; }
case "$1" in
  lookup) [ -f "$AGENT_ID_TEST_REGISTRY/$3" ] || exit 1; json "$3" ;;
  register) : > "$AGENT_ID_TEST_REGISTRY/$3"; json "$3" ;;
  annotate) json "$3" ;;
  current) printf '%s\\n' "\${AGENT_ID_SESSION_ID-unset}" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  completeSimple.mockClear();
});

afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.AGENT_ID_TEST_LOG;
  delete process.env.AGENT_ID_TEST_REGISTRY;
  rmSync(root, { recursive: true, force: true });
});

function calls(): string[] {
  try {
    return readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

function states(): string[] {
  return calls()
    .filter((line) => line.startsWith("annotate "))
    .map((line) => /"state":"([a-z]+)"/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

function summaries(): string[] {
  return calls()
    .filter((line) => line.includes("--summary "))
    .map((line) => line.split("--summary ")[1] ?? "");
}

type Harness = {
  handlers: Map<string, (event: unknown, context: SessionContext) => unknown>;
  entries: Array<{ customType: string; data: unknown }>;
  emit(event: string, payload: unknown, context: SessionContext): Promise<unknown>;
};

function harness(): Harness {
  const handlers = new Map<string, (event: unknown, context: SessionContext) => unknown>();
  const entries: Harness["entries"] = [];
  const api: ExtensionAPI = {
    on(event, handler) {
      expect(OMP_EVENTS.has(event)).toBe(true);
      handlers.set(event, handler);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
  agentIdExtension(api);
  return {
    handlers,
    entries,
    async emit(event, payload, context) {
      return handlers.get(event)?.(payload, context);
    },
  };
}

function ompContext(sessionId: string, overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    cwd: "/tmp/work",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/sessions/${sessionId}.jsonl`,
      getBranch: () => [],
    },
    models: {
      resolve: (spec: string) =>
        spec === "@smol" ? { provider: "test", id: "smol" } : undefined,
    },
    modelRegistry: { resolver: () => "api-key" },
    ...overrides,
  };
}

function agentEnd(turn: number, request = `request ${turn}`) {
  return {
    type: "agent_end",
    messages: [
      { role: "user", content: request, timestamp: turn },
      { role: "assistant", content: [{ type: "text", text: `reply ${turn}` }] },
    ],
  };
}

describe("activity state contract", () => {
  test("exposes stable lifecycle values", () => {
    expect(ACTIVITY_STATE_VALUES).toEqual(["working", "idle", "waiting", "blocked", "stopped"]);
  });
});

describe("host detection", () => {
  test("selects OMP from role-aware models and the API-key resolver", () => {
    const context = ompContext("s");
    expect(isOmpContext(context)).toBe(true);
    expect(createHostAdapter(context).kind).toBe("omp");
  });

  test("does not depend on inherited process markers", () => {
    const saved = { AI_AGENT: process.env.AI_AGENT, PI_CODING_AGENT: process.env.PI_CODING_AGENT };
    process.env.AI_AGENT = "pi";
    process.env.PI_CODING_AGENT = "true";
    try {
      expect(createHostAdapter(ompContext("s")).kind).toBe("omp");
      expect(createHostAdapter(ompContext("s", { models: undefined })).kind).toBe("pi");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("OMP lifecycle", () => {
  test("registers idle on start, working on agent start, idle on agent end, stopped on shutdown", async () => {
    const h = harness();
    const context = ompContext("omp-session");
    await h.emit("session_start", {}, context);
    expect(calls()[0]).toBe("lookup --session-id omp-session --json");
    expect(calls()[1]).toBe("register --session-id omp-session --json");
    await h.emit("agent_start", {}, context);
    await h.emit("agent_end", { type: "agent_end", messages: [] }, context);
    await h.emit("session_shutdown", {}, context);
    expect(states()).toEqual(["idle", "working", "idle", "stopped"]);
    expect(calls().at(-1)).toContain(
      `omp={"session_file":"/tmp/sessions/omp-session.jsonl","state":"stopped"}`,
    );
    expect(calls().at(-1)).toContain("--cwd /tmp/work");
  });

  test("skips agent_end when OMP will continue and after shutdown", async () => {
    const h = harness();
    const context = ompContext("late");
    await h.emit("session_start", {}, context);
    await h.emit("agent_start", {}, context);
    await h.emit("agent_end", { type: "agent_end", messages: [], willContinue: true }, context);
    await h.emit("session_shutdown", {}, context);
    await h.emit("agent_end", { type: "agent_end", messages: [] }, context);
    expect(states()).toEqual(["idle", "working", "stopped"]);
  });

  test("re-activates on session_switch, session_branch, and session_tree", async () => {
    const h = harness();
    await h.emit("session_start", {}, ompContext("one"));
    expect(h.handlers.has("session_switch")).toBe(true);
    expect(h.handlers.has("session_branch")).toBe(true);
    expect(h.handlers.has("session_before_branch")).toBe(true);
    await h.emit("session_switch", { reason: "new" }, ompContext("two"));
    await h.emit("session_branch", {}, ompContext("three"));
    await h.emit("session_tree", {}, ompContext("three"));
    expect(calls().filter((line) => line.startsWith("register"))).toEqual([
      "register --session-id one --json",
      "register --session-id two --json",
      "register --session-id three --json",
    ]);
    expect(states()).toEqual(["idle", "idle", "idle", "idle"]);
  });

  test("keeps runtime state per extension instance", async () => {
    const first = harness();
    const second = harness();
    await first.emit("session_start", {}, ompContext("first"));
    await second.emit("agent_end", agentEnd(1), ompContext("first"));
    // The second instance never saw session_start, so it must not act on the
    // first instance's session.
    expect(states()).toEqual(["idle"]);
  });
});

describe("identity injection", () => {
  test("returns a replacement command for matching agent-id current calls", async () => {
    const h = harness();
    const context = ompContext("session-xyz");
    await h.emit("session_start", {}, context);
    const result = (await h.emit(
      "tool_call",
      { toolName: "bash", input: { command: "agent-id current --json", timeout: 5 } },
      context,
    )) as { input: Record<string, unknown> };
    expect(result.input.timeout).toBe(5);
    expect(result.input.command).toBe(withIdentity("agent-id current --json", "session-xyz"));
    expect(result.input).not.toHaveProperty("env");
  });

  test("leaves unrelated calls alone", async () => {
    const h = harness();
    const context = ompContext("session-xyz");
    const input = { command: "agent-id lookup other --json" };
    expect(await h.emit("tool_call", { toolName: "bash", input }, context)).toBeUndefined();
    expect(input.command).toBe("agent-id lookup other --json");
    expect(
      await h.emit("tool_call", { toolName: "read", input: { path: "src/lib.rs" } }, context),
    ).toBeUndefined();
  });

  test("composes with other extensions' rewrites in either handler order", async () => {
    // Mail-style wrapper (subshell + export on its own line) and workspace-style prefix.
    const mailWrap = (command: string) =>
      `(\nif [ "\${AGENT_MAIL_ID+x}" != x ]; then AGENT_MAIL_ID='mail-1'; fi\nexport AGENT_MAIL_ID\n${command}\n)`;
    const workspacePrefix = (command: string) => `export AGENT_WORKSPACE=/ws; ${command}`;
    const command =
      "agent-id current; printf '%s %s\\n' \"${AGENT_MAIL_ID-nomail}\" \"${AGENT_WORKSPACE-nows}\"; agent-mail scan";
    const run = (script: string) =>
      spawnSync("/bin/sh", ["-c", script], {
        env: { PATH: process.env.PATH ?? "", AGENT_ID_TEST_LOG: process.env.AGENT_ID_TEST_LOG ?? "" },
        encoding: "utf8",
      }).stdout.trim();

    for (const identityFirst of [true, false]) {
      const h = harness();
      const context = ompContext("chain");
      await h.emit("session_start", {}, context);
      const event = { toolName: "bash", input: { command } as Record<string, unknown> };
      // OMP passes the same event to each handler and applies the last returned input.
      const others = () => {
        event.input.command = workspacePrefix(mailWrap(event.input.command as string));
        return { input: event.input };
      };
      const results = identityFirst
        ? [await h.emit("tool_call", event, context), others()]
        : [others(), await h.emit("tool_call", event, context)];
      const applied = (results.at(-1) as { input: { command: string } }).input.command;
      expect(applied).toBe(event.input.command);
      expect(applied).toContain("AGENT_ID_SESSION_ID='chain'");
      expect(applied).toContain("AGENT_MAIL_ID='mail-1'");
      expect(applied).toContain("AGENT_WORKSPACE=/ws");
      expect(run(applied)).toBe("chain\nmail-1 /ws");
    }
  });

  test("wrapped command supplies the id only when unset and scopes it to the call", () => {
    const run = (command: string, env: Record<string, string> = {}) =>
      spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: process.env.PATH ?? "", AGENT_ID_TEST_LOG: process.env.AGENT_ID_TEST_LOG ?? "", ...env },
        encoding: "utf8",
      }).stdout.trim();
    const wrapped = withIdentity("agent-id current", "it's-me");
    expect(run(wrapped)).toBe("it's-me");
    expect(run(wrapped, { AGENT_ID_SESSION_ID: "inherited" })).toBe("inherited");
    expect(run(wrapped, { AGENT_ID_SESSION_ID: "" })).toBe("");
    expect(run(withIdentity("AGENT_ID_SESSION_ID=inline agent-id current", "it's-me"))).toBe("inline");
    expect(run(`${wrapped}\nprintf '%s' "\${AGENT_ID_SESSION_ID-unset}"`)).toBe("it's-me\nunset");
    // A shell-local, unexported value counts as set and is exported only inside the subshell.
    expect(run(`AGENT_ID_SESSION_ID=shell-local\n${wrapped}\nagent-id current`)).toBe("shell-local\nunset");
  });
});

describe("automatic summaries", () => {
  test("uses @tiny then @smol, persists at most three generations, and records state", async () => {
    const h = harness();
    const context = ompContext("summary");
    await h.emit("session_start", {}, context);
    for (let turn = 1; turn <= 4; turn++) {
      await h.emit("agent_end", agentEnd(turn), context);
    }
    expect(completeSimple).toHaveBeenCalledTimes(AUTO_SUMMARY_LIMIT);
    const [model, request, options] = completeSimple.mock.calls[0] as [
      { id: string },
      { systemPrompt: string[]; messages: Array<{ content: string }> },
      { apiKey: unknown; maxTokens: number; disableReasoning: boolean },
    ];
    expect(model.id).toBe("smol");
    expect(request.systemPrompt[0]).toContain("Rules:");
    expect(request.messages[0]?.content).toBe("Latest request:\nrequest 1\n\nLatest response:\nreply 1");
    expect(options).toMatchObject({ apiKey: "api-key", maxTokens: 64, disableReasoning: true });
    expect(summaries()).toEqual(Array(3).fill("Wiring host adapters"));
    expect(h.entries.map((entry) => entry.customType)).toEqual(Array(3).fill(AUTO_SUMMARY_ENTRY_TYPE));
    expect(h.entries.at(-1)?.data).toEqual({
      version: 1,
      generations: 3,
      turnKey: "3",
      summary: "Wiring host adapters",
    });
  });

  test("restores generations from the branch and does not repeat a turn", async () => {
    const h = harness();
    const context = ompContext("restored", {
      sessionManager: {
        getSessionId: () => "restored",
        getBranch: () => [
          {
            type: "custom",
            customType: AUTO_SUMMARY_ENTRY_TYPE,
            data: { version: 1, generations: 2, turnKey: "5", summary: "earlier" },
          },
        ],
      },
    });
    await h.emit("session_start", {}, context);
    await h.emit("agent_end", agentEnd(5), context);
    expect(completeSimple).not.toHaveBeenCalled();
    await h.emit("agent_end", agentEnd(6), context);
    await h.emit("agent_end", agentEnd(7), context);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    const [, request] = completeSimple.mock.calls[0] as [unknown, { messages: Array<{ content: string }> }];
    expect(request.messages[0]?.content).toStartWith("Previous summary:\nearlier");
  });

  test("session_before_branch aborts an in-flight summary", async () => {
    completeSimple.mockImplementationOnce(
      (_model, _context, options: { signal: AbortSignal }) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () =>
            resolve({ content: [{ type: "text", text: "late" }], stopReason: "aborted" }),
          ),
        ),
    );
    const h = harness();
    const context = ompContext("abort");
    await h.emit("session_start", {}, context);
    const pending = h.emit("agent_end", agentEnd(1), context);
    await h.emit("session_before_branch", {}, context);
    await pending;
    expect(summaries()).toEqual([]);
    expect(h.entries).toEqual([]);
  });

  test("missing model access leaves lifecycle intact", async () => {
    const h = harness();
    const context = ompContext("nomodel", { models: { resolve: () => undefined } });
    await h.emit("session_start", {}, context);
    await h.emit("agent_end", agentEnd(1), context);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(states()).toEqual(["idle", "idle"]);
  });
});

describe("session metadata", () => {
  test("reports an absolute session file through the legacy omp namespace", () => {
    const context = ompContext("context-session");
    expect(sessionFileExtension(context)).toEqual({
      omp: { session_file: "/tmp/sessions/context-session.jsonl" },
    });
    expect(
      buildAnnotateArgs("context-session", {
        cwd: "/tmp/context",
        extensions: sessionFileExtension(context, "working"),
      }),
    ).toEqual([
      "annotate",
      "--session-id",
      "context-session",
      "--json",
      "--cwd",
      "/tmp/context",
      "--extension",
      'omp={"session_file":"/tmp/sessions/context-session.jsonl","state":"working"}',
    ]);
  });

  test("ignores missing, relative, and failing session files", () => {
    const context = ompContext("context-session");
    context.sessionManager.getSessionFile = () => undefined;
    expect(sessionFileExtension(context)).toBeUndefined();
    expect(sessionFileExtension(context, "idle")).toEqual({ omp: { state: "idle" } });
    context.sessionManager.getSessionFile = () => "relative/session.jsonl";
    expect(sessionFileExtension(context)).toBeUndefined();
    context.sessionManager.getSessionFile = () => {
      throw new Error("unavailable");
    };
    expect(sessionFileExtension(context)).toBeUndefined();
  });
});

describe("agent-id current command pattern", () => {
  test("matches current invocations and nothing else", () => {
    for (const command of [
      "agent-id current",
      "agent-id current --json",
      "/usr/local/bin/agent-id current --json",
      "FOO=bar agent-id current --json",
      "echo ok && agent-id current --json",
      "agent-id current | jq .session_id",
      "export AGENT_MAIL_ID=x\nagent-id current --json",
      "(\nexport FOO=1\n  agent-id current\n)",
      "agent-id current; echo next",
      "(agent-id current)",
      "agent-id current&&echo ok",
    ]) {
      expect(AGENT_ID_CURRENT_COMMAND.test(command)).toBe(true);
    }
    for (const command of [
      "agent-id lookup session-1",
      "agent-id register --json",
      "agent-id discover",
      "agent-id prime",
      "agent-id annotate --state working",
      "git status",
      "agent-mail scan",
    ]) {
      expect(AGENT_ID_CURRENT_COMMAND.test(command)).toBe(false);
    }
  });
});

describe("summary helpers", () => {
  test("latestExchange pairs the newest real request with the newest reply", () => {
    expect(
      latestExchange([
        { role: "user", content: "first request", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "first reply" }] },
        { role: "user", content: "  second request  ", timestamp: 2 },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden" },
            { type: "text", text: "second reply" },
          ],
        },
      ]),
    ).toEqual({ turnKey: "2", request: "second request", response: "second reply" });
    expect(
      latestExchange([
        { role: "user", content: "real request", timestamp: 7 },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: "auto continue", timestamp: 8, synthetic: true },
        { role: "user", content: "steer", timestamp: 9, steering: true },
      ])?.turnKey,
    ).toBe("7");
    expect(latestExchange([])).toBeNull();
  });

  test("normalizeAutoSummary keeps one clean bounded line", () => {
    expect(normalizeAutoSummary('  "Fixing checkout retries."\n\nextra ')).toBe("Fixing checkout retries");
    const summary = normalizeAutoSummary(`${"alpha ".repeat(30)}omega`);
    expect(summary?.length).toBeLessThanOrEqual(AUTO_SUMMARY_MAX_CHARS);
    expect(summary?.endsWith("alpha")).toBe(true);
    expect(normalizeAutoSummary('"..."')).toBeNull();
  });

  test("restoreAutoSummaryState returns the newest valid record", () => {
    expect(
      restoreAutoSummaryState([
        { type: "custom", customType: AUTO_SUMMARY_ENTRY_TYPE, data: { version: 1, generations: 1, turnKey: "1", summary: "old" } },
        { type: "custom", customType: AUTO_SUMMARY_ENTRY_TYPE, data: { version: 1, generations: 2, turnKey: "2", summary: "new" } },
        { type: "custom", customType: AUTO_SUMMARY_ENTRY_TYPE, data: { version: 2 } },
      ]),
    ).toEqual({ version: 1, generations: 2, turnKey: "2", summary: "new" });
  });

  test("shouldSummarize stops at the limit and once per turn", () => {
    const first = { version: 1 as const, generations: 1, turnKey: "1", summary: "first" };
    expect(shouldSummarize(null, "1")).toBe(true);
    expect(shouldSummarize(first, "1")).toBe(false);
    expect(shouldSummarize(first, "2")).toBe(true);
    expect(shouldSummarize({ ...first, generations: AUTO_SUMMARY_LIMIT }, "4")).toBe(false);
  });

  test("buildSummaryInput includes the previous summary and omits an empty reply", () => {
    const exchange = { turnKey: "1", request: "do the thing", response: "" };
    expect(buildSummaryInput(exchange, "earlier summary")).toBe(
      "Previous summary:\nearlier summary\n\nLatest request:\ndo the thing",
    );
    expect(buildSummaryInput({ ...exchange, response: "did it" }, null)).toBe(
      "Latest request:\ndo the thing\n\nLatest response:\ndid it",
    );
  });
});
