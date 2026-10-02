import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  AGENT_ID_CURRENT_COMMAND,
  createHostAdapter,
  type ExtensionAPI,
  type HostAdapter,
  type SessionContext,
  type SummaryModel,
} from "./lib/host.ts";

export { AGENT_ID_CURRENT_COMMAND, createHostAdapter, IDENTITY_UI_KEY, isOmpContext, withIdentity } from "./lib/host.ts";
export type { ExtensionAPI, HostAdapter, SessionContext } from "./lib/host.ts";

type MessageContent = string | Array<{ type: string; text?: string }>;

type AgentMessageLike = {
  role: string;
  content?: MessageContent;
  synthetic?: boolean;
  steering?: boolean;
  timestamp?: number;
};

type SessionEntryLike = {
  type: string;
  customType?: string;
  data?: unknown;
};

type AgentEndEvent = {
  type: "agent_end";
  messages: AgentMessageLike[];
  /** OMP: an automatic continuation is already scheduled. Absent on Pi. */
  willContinue?: boolean;
};

export const ACTIVITY_STATE_VALUES = [
  "working",
  "idle",
  "waiting",
  "blocked",
  "stopped",
] as const;
type ActivityStateValue = (typeof ACTIVITY_STATE_VALUES)[number];
type ActivityUpdate = {
  summary?: string;
  clear_summary?: boolean;
  cwd?: string;
  clear_cwd?: boolean;
  extensions?: Record<string, unknown>;
};

type Assignment = {
  session_id: string;
  name: string;
  slug: string;
  first_name: string;
  family_name: string;
  realm: string;
};

type IdentityResult = {
  output: string;
  assignment: Assignment;
  registered: boolean;
};

/**
 * Legacy metadata namespace. Both hosts persist the session file and lifecycle
 * state under `extensions.omp`; the CLI and Herdr discovery read it from there.
 */
export const SESSION_METADATA_OWNER = "omp";

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`agent-id JSON field ${key} is missing or invalid`);
  }
  return result;
}

function parseAssignment(output: string): Assignment {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null) {
    throw new Error("agent-id JSON output is not an object");
  }
  const record = value as Record<string, unknown>;
  return {
    session_id: requiredString(record, "session_id"),
    name: requiredString(record, "name"),
    slug: requiredString(record, "slug"),
    first_name: requiredString(record, "first_name"),
    family_name: requiredString(record, "family_name"),
    realm: requiredString(record, "realm"),
  };
}

function runAgentId(args: string[]): string {
  return execFileSync("agent-id", args, {
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });
}

function lookupIdentity(sessionId: string): IdentityResult {
  const output = runAgentId(["lookup", "--session-id", sessionId, "--json"]);
  return { output, assignment: parseAssignment(output), registered: false };
}

function registerIdentity(sessionId: string): IdentityResult {
  const output = runAgentId(["register", "--session-id", sessionId, "--json"]);
  return { output, assignment: parseAssignment(output), registered: true };
}

export function buildAnnotateArgs(
  sessionId: string,
  update: ActivityUpdate,
): string[] {
  const args = ["annotate", "--session-id", sessionId, "--json"];
  if (update.summary !== undefined) {
    args.push("--summary", update.summary);
  }
  if (update.clear_summary) {
    args.push("--clear-summary");
  }
  if (update.cwd !== undefined) {
    args.push("--cwd", update.cwd);
  }
  if (update.clear_cwd) {
    args.push("--clear-cwd");
  }
  for (const [owner, data] of Object.entries(update.extensions ?? {})) {
    args.push("--extension", `${owner}=${JSON.stringify(data)}`);
  }
  return args;
}

function annotateIdentity(
  sessionId: string,
  update: ActivityUpdate,
): IdentityResult {
  const output = runAgentId(buildAnnotateArgs(sessionId, update));
  return { output, assignment: parseAssignment(output), registered: false };
}

function ensureIdentity(sessionId: string): IdentityResult {
  try {
    return lookupIdentity(sessionId);
  } catch (lookupError) {
    try {
      return registerIdentity(sessionId);
    } catch (registerError) {
      // A second process may have registered the identity between lookup and
      // register. Retry lookup before reporting a real failure.
      try {
        return lookupIdentity(sessionId);
      } catch (retryError) {
        throw new Error(
          `lookup failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}; register failed: ${registerError instanceof Error ? registerError.message : String(registerError)}; retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        );
      }
    }
  }
}

export function sessionFileExtension(
  context: SessionContext,
  state?: ActivityStateValue,
): Record<string, unknown> | undefined {
  let sessionFile: string | undefined;
  try {
    sessionFile = context.sessionManager.getSessionFile?.();
  } catch {
    sessionFile = undefined;
  }
  const data: Record<string, string> = {};
  if (
    typeof sessionFile === "string" &&
    (path.posix.isAbsolute(sessionFile) || path.win32.isAbsolute(sessionFile))
  ) {
    data.session_file = sessionFile;
  }
  if (state !== undefined) data.state = state;
  return Object.keys(data).length > 0 ? { [SESSION_METADATA_OWNER]: data } : undefined;
}

function updateActivityState(
  host: HostAdapter,
  context: SessionContext,
  value: ActivityStateValue,
): void {
  const sessionId = context.sessionManager.getSessionId();
  if (!sessionId) return;
  try {
    const { assignment } = ensureIdentity(sessionId);
    annotateIdentity(sessionId, {
      cwd: context.cwd,
      extensions: sessionFileExtension(context, value),
    });
    // The slug is what other agents address (`agent-mail send --to <slug>`), so
    // surface it where a human can read it off the screen. Where and how it
    // renders is a host concern.
    host.showIdentity(context, value === "stopped" ? undefined : assignment.slug);
  } catch (error) {
    host.showIdentity(context, undefined);
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`agent-id: unable to update the activity state: ${detail}`);
  }
}

export const AUTO_SUMMARY_ENTRY_TYPE = "dev.derekstride.agent-id.auto-summary";
export const AUTO_SUMMARY_LIMIT = 3;
export const AUTO_SUMMARY_MAX_CHARS = 80;
const AUTO_SUMMARY_MAX_TOKENS = 64;
const AUTO_SUMMARY_INPUT_CHARS = 2000;
const AUTO_SUMMARY_TIMEOUT_MS = 20_000;

const AUTO_SUMMARY_PROMPT = [
  "Write a short present-tense phrase naming the concrete work of a coding session.",
  "",
  "Rules:",
  `- At most ${AUTO_SUMMARY_MAX_CHARS} characters.`,
  "- Describe the work, not the conversation.",
  "- Never mention the user, the assistant, or an agent identity.",
  "- Never describe progress or completion state.",
  '- Never begin with "Working on".',
  "- Return the phrase alone, without quotes or a trailing period.",
].join("\n");

export type AutoSummaryState = {
  version: 1;
  generations: number;
  turnKey: string;
  summary: string;
};

export type SummaryExchange = {
  turnKey: string;
  request: string;
  response: string;
};

type SummarySession = {
  state: AutoSummaryState | null;
  queue: Promise<void>;
  abort: AbortController;
  epoch: number;
};

function messageText(content: MessageContent | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function latestExchange(
  messages: readonly AgentMessageLike[],
): SummaryExchange | null {
  let response = "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      if (!response) response = messageText(message.content);
      continue;
    }
    if (message.role !== "user" || message.synthetic || message.steering) {
      continue;
    }
    const request = messageText(message.content);
    if (!request) continue;
    return {
      turnKey: String(message.timestamp ?? index),
      request: request.slice(0, AUTO_SUMMARY_INPUT_CHARS),
      response: response.slice(0, AUTO_SUMMARY_INPUT_CHARS),
    };
  }
  return null;
}

export function buildSummaryInput(
  exchange: SummaryExchange,
  previous: string | null,
): string {
  const sections: string[] = [];
  if (previous) sections.push(`Previous summary:\n${previous}`);
  sections.push(`Latest request:\n${exchange.request}`);
  if (exchange.response) {
    sections.push(`Latest response:\n${exchange.response}`);
  }
  return sections.join("\n\n");
}

export function normalizeAutoSummary(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  const unquoted = collapsed.replace(/^["'`]+|["'`]+$/g, "");
  const trimmed = unquoted.replace(/\.+$/, "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= AUTO_SUMMARY_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, AUTO_SUMMARY_MAX_CHARS);
  const boundary = cut.lastIndexOf(" ");
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trim() || null;
}

function isAutoSummaryState(value: unknown): value is AutoSummaryState {
  if (typeof value !== "object" || value === null) return false;
  return (
    "version" in value &&
    value.version === 1 &&
    "generations" in value &&
    typeof value.generations === "number" &&
    "turnKey" in value &&
    typeof value.turnKey === "string" &&
    "summary" in value &&
    typeof value.summary === "string"
  );
}

export function restoreAutoSummaryState(
  entries: readonly SessionEntryLike[],
): AutoSummaryState | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType !== AUTO_SUMMARY_ENTRY_TYPE) continue;
    if (isAutoSummaryState(entry.data)) return entry.data;
  }
  return null;
}

export function shouldSummarize(
  state: AutoSummaryState | null,
  turnKey: string,
): boolean {
  if (!state) return true;
  if (state.generations >= AUTO_SUMMARY_LIMIT) return false;
  return state.turnKey !== turnKey;
}

async function summarizeExchange(
  host: HostAdapter,
  context: SessionContext,
  sessionId: string,
  input: string,
  signal: AbortSignal,
): Promise<string | null> {
  const model: SummaryModel | undefined = host.resolveSummaryModel(context);
  if (!model) return null;
  const response = await host.complete(context, sessionId, model, {
    systemPrompt: AUTO_SUMMARY_PROMPT,
    input,
    maxTokens: AUTO_SUMMARY_MAX_TOKENS,
    signal,
  });
  if (!response) return null;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    return null;
  }
  return normalizeAutoSummary(messageText(response.content));
}

export default function agentIdExtension(pi: ExtensionAPI): void {
  // All mutable runtime state belongs to this extension instance.
  let host: HostAdapter | undefined;
  let currentSessionId: string | undefined;
  const summarySessions = new Map<string, SummarySession>();

  function adapter(context: SessionContext): HostAdapter {
    if (!host) {
      host = createHostAdapter(context);
      host.subscribe(pi, {
        sessionChanged: activateSession,
        beforeSessionChange: abortSummarySession,
        settled: (ctx) => {
          if (ctx.sessionManager.getSessionId() !== currentSessionId) return;
          updateActivityState(adapter(ctx), ctx, "idle");
        },
      });
    }
    return host;
  }

  function summarySession(sessionId: string): SummarySession {
    const existing = summarySessions.get(sessionId);
    if (existing) return existing;
    const created: SummarySession = {
      state: null,
      queue: Promise.resolve(),
      abort: new AbortController(),
      epoch: 0,
    };
    summarySessions.set(sessionId, created);
    return created;
  }

  function restoreSummarySession(context: SessionContext): void {
    const sessionId = context.sessionManager.getSessionId();
    if (!sessionId) return;
    const session = summarySession(sessionId);
    session.abort.abort();
    session.abort = new AbortController();
    session.epoch += 1;
    try {
      session.state = restoreAutoSummaryState(context.sessionManager.getBranch());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`agent-id: unable to restore the summary state: ${detail}`);
      session.state = null;
    }
  }

  function abortSummarySession(context: SessionContext): void {
    const sessionId = context.sessionManager.getSessionId();
    if (!sessionId) return;
    const session = summarySessions.get(sessionId);
    if (!session) return;
    session.abort.abort();
    session.epoch += 1;
  }

  function activateSession(context: SessionContext): void {
    const active = adapter(context);
    currentSessionId = context.sessionManager.getSessionId();
    updateActivityState(active, context, "idle");
    restoreSummarySession(context);
  }

  async function maintainAutoSummary(
    context: SessionContext,
    sessionId: string,
    session: SummarySession,
    event: AgentEndEvent,
    controller: AbortController,
    epoch: number,
  ): Promise<void> {
    try {
      if (session.epoch !== epoch || controller.signal.aborted) return;
      const exchange = latestExchange(event.messages);
      if (!exchange) return;
      if (!shouldSummarize(session.state, exchange.turnKey)) return;

      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(AUTO_SUMMARY_TIMEOUT_MS),
      ]);
      const summary = await summarizeExchange(
        adapter(context),
        context,
        sessionId,
        buildSummaryInput(exchange, session.state?.summary ?? null),
        signal,
      );
      if (
        !summary ||
        signal.aborted ||
        session.epoch !== epoch ||
        controller.signal.aborted
      ) {
        return;
      }
      if (context.sessionManager.getSessionId() !== sessionId) return;

      ensureIdentity(sessionId);
      if (session.epoch !== epoch || controller.signal.aborted) return;
      annotateIdentity(sessionId, { summary });

      const state: AutoSummaryState = {
        version: 1,
        generations: (session.state?.generations ?? 0) + 1,
        turnKey: exchange.turnKey,
        summary,
      };
      session.state = state;
      pi.appendEntry(AUTO_SUMMARY_ENTRY_TYPE, state);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`agent-id: unable to update the session summary: ${detail}`);
    }
  }

  pi.on("session_before_switch", (_event, context) => abortSummarySession(context));
  pi.on("session_before_tree", (_event, context) => abortSummarySession(context));
  pi.on("tool_call", (event, context) =>
    adapter(context).injectIdentity(event, context.sessionManager.getSessionId() ?? currentSessionId),
  );
  pi.on("session_start", (_event, context) => activateSession(context));
  pi.on("session_tree", (_event, context) => activateSession(context));
  pi.on("agent_start", (_event, context) => {
    const active = adapter(context);
    currentSessionId = context.sessionManager.getSessionId();
    updateActivityState(active, context, "working");
  });
  pi.on("session_shutdown", (event, context) => {
    const active = adapter(context);
    currentSessionId = undefined;
    if (active.endsSession(event)) updateActivityState(active, context, "stopped");
    for (const session of summarySessions.values()) session.abort.abort();
    summarySessions.clear();
  });

  pi.on("agent_end", async (event, context) => {
    const end = event as AgentEndEvent;
    if (end.willContinue) return;
    const sessionId = context.sessionManager.getSessionId();
    if (!sessionId || sessionId !== currentSessionId) return;
    const active = adapter(context);
    const session = summarySession(sessionId);
    const controller = session.abort;
    const epoch = session.epoch;
    session.queue = session.queue.then(async () => {
      if (
        session.epoch !== epoch ||
        controller.signal.aborted ||
        currentSessionId !== sessionId
      ) {
        return;
      }
      if (active.idleOnAgentEnd) updateActivityState(active, context, "idle");
      await maintainAutoSummary(context, sessionId, session, end, controller, epoch);
    });
    await session.queue;
  });
}
