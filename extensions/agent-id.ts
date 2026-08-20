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

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ExtensionAPI = {
  on(
    event: "session_start" | "session_switch" | "agent_start" | "tool_call",
    handler: (event: unknown, context: SessionContext) => unknown,
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

const IDENTITY_ENV_KEYS = [
  "AGENT_ID_SESSION_ID",
  "AGENT_ID_NAME",
  "AGENT_ID_SLUG",
  "AGENT_ID_FIRST_NAME",
  "AGENT_ID_FAMILY_NAME",
  "AGENT_ID_REALM",
] as const;

let currentAssignment: Assignment | undefined;

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

function identityEnvironment(assignment: Assignment): Record<string, string> {
  return {
    AGENT_ID_SESSION_ID: assignment.session_id,
    AGENT_ID_NAME: assignment.name,
    AGENT_ID_SLUG: assignment.slug,
    AGENT_ID_FIRST_NAME: assignment.first_name,
    AGENT_ID_FAMILY_NAME: assignment.family_name,
    AGENT_ID_REALM: assignment.realm,
  };
}

function clearIdentityEnvironment(): void {
  for (const key of IDENTITY_ENV_KEYS) delete process.env[key];
  currentAssignment = undefined;
}

function exportIdentity(assignment: Assignment): void {
  currentAssignment = assignment;
  Object.assign(process.env, identityEnvironment(assignment));
}

function injectIdentityEnvironment(
  event: unknown,
): { input: Record<string, unknown> } | undefined {
  if (!currentAssignment || typeof event !== "object" || event === null) return;
  const toolEvent = event as Partial<ToolCallEvent>;
  if (toolEvent.toolName !== "bash" || !toolEvent.input) return;

  const existingEnv = toolEvent.input.env;
  const callerEnv =
    typeof existingEnv === "object" && existingEnv !== null && !Array.isArray(existingEnv)
      ? (existingEnv as Record<string, unknown>)
      : {};
  return {
    input: {
      ...toolEvent.input,
      env: { ...identityEnvironment(currentAssignment), ...callerEnv },
    },
  };
}

function reportSession(context: SessionContext): void {
  clearIdentityEnvironment();
  const sessionId = context.sessionManager.getSessionId();
  if (!sessionId) return;

  try {
    const result = ensureIdentity(sessionId);
    exportIdentity(result.assignment);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`agent-id: unable to resolve the session identity: ${detail}`);
  }
}

export default function agentIdExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => reportSession(context));
  pi.on("session_switch", (_event, context) => reportSession(context));
  pi.on("agent_start", (_event, context) => reportSession(context));
  pi.on("tool_call", injectIdentityEnvironment);

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
        const result = ensureIdentity(sessionId);
        exportIdentity(result.assignment);
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
