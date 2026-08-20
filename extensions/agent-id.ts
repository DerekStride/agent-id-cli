import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

type SessionContext = {
  hasUI?: boolean;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile?(): string | undefined;
  };
};

type ExtensionAPI = {
  on(
    event: "session_start",
    handler: (event: unknown, context: SessionContext) => void,
  ): void;
};

type Assignment = {
  family_name: string;
};


function runAgentId(args: string[]): Assignment {
  const output = execFileSync("agent-id", args, {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 5000,
  });
  return JSON.parse(output) as Assignment;
}

function ensureRegistered(family: string | undefined): Assignment | undefined {
  try {
    return runAgentId(["lookup", "--json"]);
  } catch {
    try {
      const args = ["register", "--json"];
      if (family) args.push("--family", family);
      return runAgentId(args);
    } catch {
      console.warn("agent-id: unable to register the session identity");
      return undefined;
    }
  }
}

/**
 * Export the current harness session to child tool processes and ensure its
 * durable identity exists.
 *
 * A child process inherits AGENT_SURNAME and receives a synthetic session ID
 * when the harness does not persist one. Ordinary ephemeral prompts remain
 * anonymous.
 */
export default function agentIdExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    const family =
      process.env.AGENT_IDENTITY_PID !== String(process.pid)
        ? process.env.AGENT_SURNAME
        : undefined;
    const sessionFile = context.sessionManager.getSessionFile?.();
    const ephemeral = context.hasUI === false && !sessionFile;
    const sessionId =
      ephemeral && !family
        ? undefined
        : context.sessionManager.getSessionId() ??
          (family ? `subagent-${randomUUID()}` : undefined);
    if (!sessionId) {
      delete process.env.AGENT_ID_SESSION_ID;
      delete process.env.AGENT_SURNAME;
      return;
    }

    process.env.AGENT_ID_SESSION_ID = sessionId;
    const assignment = ensureRegistered(family);
    if (assignment?.family_name) {
      process.env.AGENT_SURNAME = assignment.family_name;
    } else {
      delete process.env.AGENT_SURNAME;
    }
    process.env.AGENT_IDENTITY_PID = String(process.pid);
  });
}
