// Host adapters: keep OMP-only and Pi-only APIs confined to this module so the
// shared extension in ../agent-id.ts only sees one contract.

export type SummaryModel = { provider: string; id: string; baseUrl?: string };

type SessionEntryLike = {
  type: string;
  customType?: string;
  data?: unknown;
};

/**
 * Structural view of the host extension context. Fields that exist on only one
 * host are optional; adapters verify them before use.
 */
export type SessionContext = {
  cwd: string;
  ui?: { setStatus(key: string, text: string | undefined): void };
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile?(): string | undefined;
    getBranch(): SessionEntryLike[];
  };
  /** Pi: current session model. */
  model?: SummaryModel;
  /** OMP: role-aware model lookup. */
  models?: { resolve(spec: string): SummaryModel | undefined };
  modelRegistry: {
    /** OMP: API-key resolver for a model and session. */
    resolver?(model: SummaryModel, sessionId?: string): unknown;
    /** Pi: provider-neutral completion with request-time authentication. */
    complete?(
      model: SummaryModel,
      context: { systemPrompt?: string; messages: CompletionMessage[] },
      options: { maxTokens: number; reasoning: "off"; signal: AbortSignal },
    ): Promise<CompletionResponse>;
  };
};

export type CompletionMessage = {
  role: "user";
  content: string;
  timestamp: number;
};

export type CompletionResponse = {
  content: Array<{ type: string; text?: string }>;
  stopReason: string;
};

export type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

export type InputReplacement = { input: Record<string, unknown> };

export type SessionShutdownEvent = { reason?: string };

export type Handler = (event: unknown, context: SessionContext) => unknown;

export type HostEventName =
  | "session_start"
  | "session_switch"
  | "session_branch"
  | "session_tree"
  | "session_before_switch"
  | "session_before_branch"
  | "session_before_fork"
  | "session_before_tree"
  | "session_shutdown"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "tool_call";

export type ExtensionAPI = {
  on(event: HostEventName, handler: Handler): unknown;
  appendEntry(customType: string, data: unknown): void;
};

export type CompletionRequest = {
  systemPrompt: string;
  input: string;
  maxTokens: number;
  signal: AbortSignal;
};

export type HostAdapter = {
  kind: "omp" | "pi";
  /** Register host-only lifecycle events. */
  subscribe(
    api: ExtensionAPI,
    hooks: {
      /** The active session changed in place (OMP switch/branch). */
      sessionChanged(context: SessionContext): void;
      /** A session replacement is about to begin. */
      beforeSessionChange(context: SessionContext): void;
      /** Pi: the agent will not continue automatically. */
      settled(context: SessionContext): void;
    },
  ): void;
  /** Whether a shutdown event ends the session identity (publish `stopped`). */
  endsSession(event: unknown): boolean;
  /** Whether `agent_end` should publish idle state. */
  idleOnAgentEnd: boolean;
  /** Supply the session identity to matching `agent-id current` calls. */
  injectIdentity(event: unknown, sessionId: string | undefined): InputReplacement | void;
  /** Pick the model used for automatic summaries. */
  resolveSummaryModel(context: SessionContext): SummaryModel | undefined;
  /** Run a bounded completion; resolves to null when the host cannot complete. */
  complete(
    context: SessionContext,
    sessionId: string,
    model: SummaryModel,
    request: CompletionRequest,
  ): Promise<CompletionResponse | null>;
};

// Command boundaries include newlines so a `current` invocation is still
// recognized after another extension prefixed its own export or wrapper lines,
// and `current` may be followed directly by a separator such as `;` or `)`.
export const AGENT_ID_CURRENT_COMMAND =
  /(?:^|[;&|`$()\n]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(?:\S*\/)?agent-id\s+(?:--[A-Za-z0-9_-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?\s+|-[A-Za-z0-9]\s+)*current(?=\s|$|[;&|)`])/;

const OMP_MODEL_ROLES = ["@tiny", "@smol"] as const;

function currentCall(event: unknown): ToolCallEvent | undefined {
  if (typeof event !== "object" || event === null) return;
  const call = event as Partial<ToolCallEvent>;
  if (call.toolName !== "bash" || !call.input) return;
  const command = call.input.command;
  if (typeof command !== "string" || !AGENT_ID_CURRENT_COMMAND.test(command)) return;
  return call as ToolCallEvent;
}

/**
 * Neither host's Bash tool consumes `input.env`. Scope the default to this call
 * (including OMP's persistent shell) and preserve inherited, empty, and inline
 * caller overrides.
 */
export function withIdentity(command: string, sessionId: string): string {
  const quoted = `'${sessionId.replaceAll("'", "'\\''")}'`;
  return [
    "(",
    `if [ "\${AGENT_ID_SESSION_ID+x}" != x ]; then AGENT_ID_SESSION_ID=${quoted}; fi`,
    "export AGENT_ID_SESSION_ID",
    command,
    ")",
  ].join("\n");
}

/** OMP exposes role-aware model lookup and an API-key resolver; Pi exposes neither. */
export function isOmpContext(context: SessionContext): boolean {
  return (
    typeof context.models?.resolve === "function" &&
    typeof context.modelRegistry?.resolver === "function"
  );
}

type CompleteSimple = (
  model: SummaryModel,
  context: { systemPrompt: string[]; messages: CompletionMessage[] },
  options: {
    apiKey: unknown;
    maxTokens: number;
    disableReasoning: boolean;
    signal: AbortSignal;
  },
) => Promise<CompletionResponse>;

let ompCompletion: Promise<CompleteSimple | null> | undefined;

// OMP rewrites this specifier onto its bundled pi-ai copy. Import lazily so
// identity registration keeps working when that resolution fails.
function loadOmpCompletion(): Promise<CompleteSimple | null> {
  ompCompletion ??= import("@oh-my-pi/pi-ai")
    .then((module: unknown) => {
      if (typeof module !== "object" || module === null) return null;
      if (!("completeSimple" in module)) return null;
      if (typeof module.completeSimple !== "function") return null;
      return module.completeSimple as CompleteSimple;
    })
    .catch(() => null);
  return ompCompletion;
}

export function createHostAdapter(context: SessionContext): HostAdapter {
  // Detect capabilities, not process.env: a host launched from another agent
  // can inherit AI_AGENT / PI_* markers.
  if (isOmpContext(context)) {
    return {
      kind: "omp",
      subscribe(api, hooks) {
        // OMP emits session_switch for new/resume/fork and session_branch for
        // branching; it does not re-emit session_start for those.
        api.on("session_switch", (_event, ctx) => hooks.sessionChanged(ctx));
        api.on("session_branch", (_event, ctx) => hooks.sessionChanged(ctx));
        api.on("session_before_branch", (_event, ctx) => hooks.beforeSessionChange(ctx));
      },
      // OMP emits session_shutdown only when the session is disposed.
      endsSession: () => true,
      idleOnAgentEnd: true,
      injectIdentity(event, sessionId) {
        if (!sessionId) return;
        const call = currentCall(event);
        if (!call) return;
        // OMP hands every tool_call handler the same event and applies the last
        // returned input. Mutate in place AND return that same object so this
        // rewrite composes with other extensions' rewrites in either order.
        call.input.command = withIdentity(call.input.command as string, sessionId);
        return { input: call.input };
      },
      resolveSummaryModel(ctx) {
        for (const role of OMP_MODEL_ROLES) {
          const model = ctx.models?.resolve(role);
          if (model) return model;
        }
        return undefined;
      },
      async complete(ctx, sessionId, model, request) {
        const complete = await loadOmpCompletion();
        if (!complete) return null;
        return complete(
          model,
          {
            systemPrompt: [request.systemPrompt],
            messages: [{ role: "user", content: request.input, timestamp: Date.now() }],
          },
          {
            apiKey: ctx.modelRegistry.resolver?.(model, sessionId),
            maxTokens: request.maxTokens,
            disableReasoning: true,
            signal: request.signal,
          },
        );
      },
    };
  }

  return {
    kind: "pi",
    subscribe(api, hooks) {
      // Pi tears down the runtime and re-emits session_start for new, resume,
      // fork, and reload, so no post-switch subscription is needed.
      api.on("session_before_fork", (_event, ctx) => hooks.beforeSessionChange(ctx));
      api.on("agent_settled", (_event, ctx) => hooks.settled(ctx));
    },
    endsSession(event) {
      // Pi fires session_shutdown for quit, reload, new, resume, and fork. A
      // reload keeps the same session id, so it does not end the identity.
      const reason = (event as SessionShutdownEvent | undefined)?.reason;
      return reason !== "reload";
    },
    idleOnAgentEnd: false,
    injectIdentity(event, sessionId) {
      if (!sessionId) return;
      const call = currentCall(event);
      if (!call) return;
      // Pi ignores returned input replacements; mutate the original object.
      call.input.command = withIdentity(call.input.command as string, sessionId);
    },
    resolveSummaryModel(ctx) {
      // Pi has no model roles. Use the session model so summaries stay with
      // the user's selected provider and credentials.
      return ctx.model;
    },
    async complete(ctx, _sessionId, model, request) {
      const complete = ctx.modelRegistry.complete;
      if (typeof complete !== "function") return null;
      return complete.call(
        ctx.modelRegistry,
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: request.input, timestamp: Date.now() }],
        },
        { maxTokens: request.maxTokens, reasoning: "off", signal: request.signal },
      );
    },
  };
}
