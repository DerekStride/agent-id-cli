import { execFileSync } from "node:child_process";

type SessionContext = {
  sessionManager: {
    getSessionId(): string | undefined;
  };
};

type ToolResult = {
  content: [{ type: "text"; text: string }];
  details?: { session_id: string; registered: boolean };
  isError?: boolean;
};

type ExtensionAPI = {
  on(
    event: "session_start" | "session_switch" | "agent_start",
    handler: (event: unknown, context: SessionContext) => void,
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    loadMode?: "essential";
    parameters: {
      type: "object";
      properties: Record<string, never>;
      additionalProperties: false;
    };
    execute(
      id: string,
      params: Record<string, never>,
      signal: AbortSignal,
      onUpdate: unknown,
      context: SessionContext,
    ): Promise<ToolResult>;
  }): void;
};

type IdentityResult = {
  output: string;
  registered: boolean;
};

function runAgentId(args: string[]): string {
  return execFileSync("agent-id", args, {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 5000,
  });
}

function registerIdentity(sessionId: string): IdentityResult {
  return {
    output: runAgentId(["register", "--session-id", sessionId, "--json"]),
    registered: true,
  };
}

function reportSession(context: SessionContext): void {
  const sessionId = context.sessionManager.getSessionId();
  if (!sessionId) return;

  try {
    registerIdentity(sessionId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`agent-id: unable to register the session identity: ${detail}`);
  }
}

export default function agentIdExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => reportSession(context));
  pi.on("session_switch", (_event, context) => reportSession(context));
  pi.on("agent_start", (_event, context) => reportSession(context));

  pi.registerTool({
    name: "agent_identity",
    label: "Agent Identity",
    description:
      "Look up or register the current agent session identity and return its complete assignment.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_id, _params, _signal, _onUpdate, context) {
      const sessionId = context.sessionManager.getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "agent-id: no active session ID" }],
          isError: true,
        };
      }

      try {
        const result = registerIdentity(sessionId);
        return {
          content: [{ type: "text", text: result.output.trim() }],
          details: { session_id: sessionId, registered: result.registered },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `agent-id: ${detail}` }],
          isError: true,
        };
      }
    },
  });
}
