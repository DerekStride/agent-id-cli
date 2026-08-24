import { execFileSync } from "node:child_process";

type SessionContext = {
  sessionManager: {
    getSessionId(): string | undefined;
  };
};

type ToolResult = {
  content: [{ type: "text"; text: string }];
  details?: {
    session_id: string;
    registered: boolean;
    summary_updated?: boolean;
  };
  isError?: boolean;
};

type IdentityParams = {
  summary?: string;
  clear_summary?: boolean;
};

type ToolParameter = {
  type: "string" | "boolean";
  description: string;
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
      properties: Record<string, ToolParameter>;
      additionalProperties: false;
    };
    execute(
      id: string,
      params: IdentityParams,
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

function annotateIdentity(
  sessionId: string,
  summary: string | null,
): IdentityResult {
  const args = ["annotate", "--session-id", sessionId, "--json"];
  if (summary === null) {
    args.push("--clear-summary");
  } else {
    args.push("--summary", summary);
  }
  const output = runAgentId(args);
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

function clearIdentityEnvironment(): void {
  for (const key of IDENTITY_ENV_KEYS) delete process.env[key];
}

function exportIdentity(assignment: Assignment): void {
  process.env.AGENT_ID_SESSION_ID = assignment.session_id;
  process.env.AGENT_ID_NAME = assignment.name;
  process.env.AGENT_ID_SLUG = assignment.slug;
  process.env.AGENT_ID_FIRST_NAME = assignment.first_name;
  process.env.AGENT_ID_FAMILY_NAME = assignment.family_name;
  process.env.AGENT_ID_REALM = assignment.realm;
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

  pi.registerTool({
    name: "agent_identity",
    label: "Agent Identity",
    description:
      "Look up or register the current agent session identity, optionally update its current-work summary, and return the complete assignment.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Concise summary of the agent's current work.",
        },
        clear_summary: {
          type: "boolean",
          description: "Remove the current-work summary when true.",
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, context) {
      const sessionId = context.sessionManager.getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "agent-id: no active session ID" }],
          isError: true,
        };
      }

      try {
        const clearSummary = params.clear_summary === true;
        if (params.summary !== undefined && clearSummary) {
          throw new Error("summary and clear_summary are mutually exclusive");
        }

        let result = ensureIdentity(sessionId);
        const summaryUpdated = params.summary !== undefined || clearSummary;
        if (params.summary !== undefined) {
          const annotated = annotateIdentity(sessionId, params.summary);
          result = { ...annotated, registered: result.registered };
        } else if (clearSummary) {
          const annotated = annotateIdentity(sessionId, null);
          result = { ...annotated, registered: result.registered };
        }
        exportIdentity(result.assignment);
        return {
          content: [{ type: "text", text: result.output.trim() }],
          details: {
            session_id: sessionId,
            registered: result.registered,
            summary_updated: summaryUpdated,
          },
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
