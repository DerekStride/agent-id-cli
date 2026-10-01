// Pi host suite (Node test runner). Mirrors extensions/agent-id.test.ts: when
// changing shared behavior, add matching assertions to both suites.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

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

const PI_EVENTS = new Set([
  "session_start",
  "session_tree",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "agent_settled",
  "tool_call",
]);

let root: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-id-pi-"));
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
      assert.ok(PI_EVENTS.has(event), `unexpected Pi event ${event}`);
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

type CompleteCall = {
  model: unknown;
  context: { systemPrompt?: string; messages: Array<{ content: string }> };
  options: { maxTokens: number; reasoning: string; signal: AbortSignal };
};

function piContext(
  sessionId: string,
  completions: CompleteCall[] = [],
  overrides: Partial<SessionContext> = {},
): SessionContext {
  return {
    cwd: "/tmp/work",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/sessions/${sessionId}.jsonl`,
      getBranch: () => [],
    },
    model: { provider: "openai", id: "session-model" },
    modelRegistry: {
      async complete(model, context, options) {
        completions.push({ model, context, options });
        return { content: [{ type: "text", text: "Wiring host adapters" }], stopReason: "stop" };
      },
    },
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
    assert.deepEqual(ACTIVITY_STATE_VALUES, ["working", "idle", "waiting", "blocked", "stopped"]);
  });
});

describe("host detection", () => {
  test("selects Pi when role-aware models and the resolver are absent", () => {
    const context = piContext("s");
    assert.equal(isOmpContext(context), false);
    assert.equal(createHostAdapter(context).kind, "pi");
  });

  test("does not depend on inherited process markers", () => {
    const saved = { AI_AGENT: process.env.AI_AGENT, PI_CODING_AGENT: process.env.PI_CODING_AGENT };
    delete process.env.AI_AGENT;
    delete process.env.PI_CODING_AGENT;
    try {
      assert.equal(createHostAdapter(piContext("s")).kind, "pi");
      const omp = piContext("s", [], {
        models: { resolve: () => undefined },
        modelRegistry: { resolver: () => undefined },
      });
      assert.equal(createHostAdapter(omp).kind, "omp");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("Pi lifecycle", () => {
  test("registers idle on start, working on agent start, idle on settle, stopped on quit", async () => {
    const h = harness();
    const context = piContext("pi-session");
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    assert.equal(calls()[0], "lookup --session-id pi-session --json");
    assert.equal(calls()[1], "register --session-id pi-session --json");
    await h.emit("agent_start", {}, context);
    await h.emit("agent_end", { type: "agent_end", messages: [] }, context);
    assert.deepEqual(states(), ["idle", "working"], "agent_end must not publish idle on Pi");
    await h.emit("agent_settled", {}, context);
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
    assert.deepEqual(states(), ["idle", "working", "idle", "stopped"]);
    assert.ok(
      calls().at(-1)?.includes(`omp={"session_file":"/tmp/sessions/pi-session.jsonl","state":"stopped"}`),
    );
    assert.ok(calls().at(-1)?.includes("--cwd /tmp/work"));
  });

  test("does not subscribe to OMP-only session events", async () => {
    const h = harness();
    await h.emit("session_start", { type: "session_start", reason: "startup" }, piContext("s"));
    assert.equal(h.handlers.has("session_switch"), false);
    assert.equal(h.handlers.has("session_branch"), false);
    assert.equal(h.handlers.has("session_before_branch"), false);
    assert.equal(h.handlers.has("session_before_fork"), true);
    assert.equal(h.handlers.has("agent_settled"), true);
  });

  test("reload keeps the identity active; new, resume, and fork end it", async () => {
    for (const reason of ["reload", "new", "resume", "fork"]) {
      const h = harness();
      const context = piContext(`shutdown-${reason}`);
      await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
      await h.emit("session_shutdown", { type: "session_shutdown", reason }, context);
      const stopped = calls().some((line) => line.includes(`--session-id shutdown-${reason} --json --cwd`) && line.includes('"state":"stopped"'));
      assert.equal(stopped, reason !== "reload", `reason ${reason}`);
    }
  });

  test("session_start after replacement activates the new identity", async () => {
    const h = harness();
    await h.emit("session_start", { type: "session_start", reason: "startup" }, piContext("one"));
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, piContext("one"));
    // Pi builds a new runtime; a fresh extension instance receives session_start.
    const next = harness();
    await next.emit(
      "session_start",
      { type: "session_start", reason: "new", previousSessionFile: "/tmp/sessions/one.jsonl" },
      piContext("two"),
    );
    await next.emit("session_tree", { newLeafId: "x", oldLeafId: null }, piContext("two"));
    assert.deepEqual(
      calls().filter((line) => line.startsWith("register")),
      ["register --session-id one --json", "register --session-id two --json"],
    );
    assert.deepEqual(states(), ["idle", "stopped", "idle", "idle"]);
  });

  test("keeps runtime state per extension instance", async () => {
    const first = harness();
    const second = harness();
    await first.emit("session_start", { type: "session_start", reason: "startup" }, piContext("first"));
    await second.emit("agent_settled", {}, piContext("first"));
    await second.emit("agent_end", agentEnd(1), piContext("first"));
    // The second instance never saw session_start, so it must not act on the
    // first instance's session.
    assert.deepEqual(states(), ["idle"]);
  });

  test("ignores settle and agent_end for a session it did not activate", async () => {
    const h = harness();
    await h.emit("agent_settled", {}, piContext("ghost"));
    await h.emit("agent_end", agentEnd(1), piContext("ghost"));
    assert.deepEqual(calls(), []);
  });
});

describe("identity injection", () => {
  test("mutates the command in place and returns nothing", async () => {
    const h = harness();
    const context = piContext("session-xyz");
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const input: Record<string, unknown> = { command: "agent-id current --json", timeout: 5 };
    const result = await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input }, context);
    assert.equal(result, undefined);
    assert.equal(input.command, withIdentity("agent-id current --json", "session-xyz"));
    assert.equal(input.timeout, 5);
    assert.equal("env" in input, false);
  });

  test("leaves unrelated calls alone", async () => {
    const h = harness();
    const context = piContext("session-xyz");
    const input = { command: "agent-id lookup other --json" };
    assert.equal(await h.emit("tool_call", { toolName: "bash", input }, context), undefined);
    assert.equal(input.command, "agent-id lookup other --json");
    const read = { path: "src/lib.rs" };
    assert.equal(await h.emit("tool_call", { toolName: "read", input: read }, context), undefined);
    assert.deepEqual(read, { path: "src/lib.rs" });
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
      const context = piContext("chain");
      await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
      const event = { toolName: "bash", input: { command } as Record<string, unknown> };
      // Pi ignores return values; every handler mutates the same event.input.
      const others = () => {
        event.input.command = workspacePrefix(mailWrap(event.input.command as string));
      };
      if (identityFirst) {
        assert.equal(await h.emit("tool_call", event, context), undefined);
        others();
      } else {
        others();
        assert.equal(await h.emit("tool_call", event, context), undefined);
      }
      const applied = event.input.command as string;
      assert.ok(applied.includes("AGENT_ID_SESSION_ID='chain'"));
      assert.ok(applied.includes("AGENT_MAIL_ID='mail-1'"));
      assert.ok(applied.includes("AGENT_WORKSPACE=/ws"));
      assert.equal(run(applied), "chain\nmail-1 /ws");
    }
  });

  test("wrapped command supplies the id only when unset and scopes it to the call", () => {
    const run = (command: string, env: Record<string, string> = {}) =>
      spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: process.env.PATH ?? "", AGENT_ID_TEST_LOG: process.env.AGENT_ID_TEST_LOG ?? "", ...env },
        encoding: "utf8",
      }).stdout.trim();
    const wrapped = withIdentity("agent-id current", "it's-me");
    assert.equal(run(wrapped), "it's-me");
    assert.equal(run(wrapped, { AGENT_ID_SESSION_ID: "inherited" }), "inherited");
    assert.equal(run(wrapped, { AGENT_ID_SESSION_ID: "" }), "");
    assert.equal(run(withIdentity("AGENT_ID_SESSION_ID=inline agent-id current", "it's-me")), "inline");
    assert.equal(run(`${wrapped}\nprintf '%s' "\${AGENT_ID_SESSION_ID-unset}"`), "it's-me\nunset");
    // A shell-local, unexported value counts as set and is exported only inside the subshell.
    assert.equal(run(`AGENT_ID_SESSION_ID=shell-local\n${wrapped}\nagent-id current`), "shell-local\nunset");
  });
});

describe("automatic summaries", () => {
  test("uses the session model through modelRegistry.complete with bounded options", async () => {
    const completions: CompleteCall[] = [];
    const h = harness();
    const context = piContext("summary", completions);
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    for (let turn = 1; turn <= 4; turn++) {
      await h.emit("agent_end", agentEnd(turn), context);
    }
    assert.equal(completions.length, AUTO_SUMMARY_LIMIT);
    const first = completions[0]!;
    assert.deepEqual(first.model, { provider: "openai", id: "session-model" });
    assert.ok(first.context.systemPrompt?.includes("Rules:"));
    assert.equal(first.context.messages[0]?.content, "Latest request:\nrequest 1\n\nLatest response:\nreply 1");
    assert.equal(first.options.maxTokens, 64);
    assert.equal(first.options.reasoning, "off");
    assert.ok(first.options.signal instanceof AbortSignal);
    assert.deepEqual(summaries(), Array(3).fill("Wiring host adapters"));
    assert.deepEqual(h.entries.map((entry) => entry.customType), Array(3).fill(AUTO_SUMMARY_ENTRY_TYPE));
    assert.deepEqual(h.entries.at(-1)?.data, {
      version: 1,
      generations: 3,
      turnKey: "3",
      summary: "Wiring host adapters",
    });
  });

  test("restores generations from the branch and does not repeat a turn", async () => {
    const completions: CompleteCall[] = [];
    const h = harness();
    const context = piContext("restored", completions, {
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
    await h.emit("session_start", { type: "session_start", reason: "resume" }, context);
    await h.emit("agent_end", agentEnd(5), context);
    assert.equal(completions.length, 0);
    await h.emit("agent_end", agentEnd(6), context);
    await h.emit("agent_end", agentEnd(7), context);
    assert.equal(completions.length, 1);
    assert.ok(completions[0]!.context.messages[0]?.content.startsWith("Previous summary:\nearlier"));
  });

  test("session_before_fork aborts an in-flight summary", async () => {
    const h = harness();
    const context = piContext("abort", [], {
      modelRegistry: {
        complete: (_model, _context, options) =>
          new Promise((resolve) =>
            options.signal.addEventListener("abort", () =>
              resolve({ content: [{ type: "text", text: "late" }], stopReason: "aborted" }),
            ),
          ),
      },
    });
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    const pending = h.emit("agent_end", agentEnd(1), context);
    await h.emit("session_before_fork", { entryId: "e", position: "at" }, context);
    await pending;
    assert.deepEqual(summaries(), []);
    assert.deepEqual(h.entries, []);
  });

  test("missing session model leaves lifecycle intact", async () => {
    const completions: CompleteCall[] = [];
    const h = harness();
    const context = piContext("nomodel", completions, { model: undefined });
    await h.emit("session_start", { type: "session_start", reason: "startup" }, context);
    await h.emit("agent_end", agentEnd(1), context);
    await h.emit("agent_settled", {}, context);
    assert.equal(completions.length, 0);
    assert.deepEqual(states(), ["idle", "idle"]);
  });
});

describe("session metadata", () => {
  test("reports an absolute session file through the legacy omp namespace", () => {
    const context = piContext("context-session");
    assert.deepEqual(sessionFileExtension(context), {
      omp: { session_file: "/tmp/sessions/context-session.jsonl" },
    });
    assert.deepEqual(
      buildAnnotateArgs("context-session", {
        cwd: "/tmp/context",
        extensions: sessionFileExtension(context, "working"),
      }),
      [
        "annotate",
        "--session-id",
        "context-session",
        "--json",
        "--cwd",
        "/tmp/context",
        "--extension",
        'omp={"session_file":"/tmp/sessions/context-session.jsonl","state":"working"}',
      ],
    );
  });

  test("ignores missing, relative, and failing session files", () => {
    const context = piContext("context-session");
    context.sessionManager.getSessionFile = () => undefined;
    assert.equal(sessionFileExtension(context), undefined);
    assert.deepEqual(sessionFileExtension(context, "idle"), { omp: { state: "idle" } });
    context.sessionManager.getSessionFile = () => "relative/session.jsonl";
    assert.equal(sessionFileExtension(context), undefined);
    context.sessionManager.getSessionFile = () => {
      throw new Error("unavailable");
    };
    assert.equal(sessionFileExtension(context), undefined);
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
      assert.equal(AGENT_ID_CURRENT_COMMAND.test(command), true, command);
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
      assert.equal(AGENT_ID_CURRENT_COMMAND.test(command), false, command);
    }
  });
});

describe("summary helpers", () => {
  test("latestExchange pairs the newest real request with the newest reply", () => {
    assert.deepEqual(
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
      { turnKey: "2", request: "second request", response: "second reply" },
    );
    assert.equal(
      latestExchange([
        { role: "user", content: "real request", timestamp: 7 },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: "auto continue", timestamp: 8, synthetic: true },
        { role: "user", content: "steer", timestamp: 9, steering: true },
      ])?.turnKey,
      "7",
    );
    assert.equal(latestExchange([]), null);
  });

  test("normalizeAutoSummary keeps one clean bounded line", () => {
    assert.equal(normalizeAutoSummary('  "Fixing checkout retries."\n\nextra '), "Fixing checkout retries");
    const summary = normalizeAutoSummary(`${"alpha ".repeat(30)}omega`);
    assert.ok((summary?.length ?? 0) <= AUTO_SUMMARY_MAX_CHARS);
    assert.ok(summary?.endsWith("alpha"));
    assert.equal(normalizeAutoSummary('"..."'), null);
  });

  test("restoreAutoSummaryState returns the newest valid record", () => {
    assert.deepEqual(
      restoreAutoSummaryState([
        { type: "custom", customType: AUTO_SUMMARY_ENTRY_TYPE, data: { version: 1, generations: 1, turnKey: "1", summary: "old" } },
        { type: "custom", customType: AUTO_SUMMARY_ENTRY_TYPE, data: { version: 1, generations: 2, turnKey: "2", summary: "new" } },
        { type: "custom", customType: AUTO_SUMMARY_ENTRY_TYPE, data: { version: 2 } },
      ]),
      { version: 1, generations: 2, turnKey: "2", summary: "new" },
    );
  });

  test("shouldSummarize stops at the limit and once per turn", () => {
    const first = { version: 1 as const, generations: 1, turnKey: "1", summary: "first" };
    assert.equal(shouldSummarize(null, "1"), true);
    assert.equal(shouldSummarize(first, "1"), false);
    assert.equal(shouldSummarize(first, "2"), true);
    assert.equal(shouldSummarize({ ...first, generations: AUTO_SUMMARY_LIMIT }, "4"), false);
  });

  test("buildSummaryInput includes the previous summary and omits an empty reply", () => {
    const exchange = { turnKey: "1", request: "do the thing", response: "" };
    assert.equal(
      buildSummaryInput(exchange, "earlier summary"),
      "Previous summary:\nearlier summary\n\nLatest request:\ndo the thing",
    );
    assert.equal(
      buildSummaryInput({ ...exchange, response: "did it" }, null),
      "Latest request:\ndo the thing\n\nLatest response:\ndid it",
    );
  });
});
