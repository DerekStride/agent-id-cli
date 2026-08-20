import { execFileSync } from "node:child_process";

type SessionContext = {
  sessionManager: {
    getSessionId(): string | undefined;
  };
};

type ExtensionAPI = {
  on(
    event: "session_start" | "session_switch",
    handler: (event: unknown, context: SessionContext) => void,
  ): void;
};
function runAgentId(args: string[]): void {
  execFileSync("agent-id", args, {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 5000,
  });
}

function ensureRegistered(): void {
  try {
    runAgentId(["lookup", "--json"]);
  } catch {
    try {
      runAgentId(["register", "--json"]);
    } catch {
      console.warn("agent-id: unable to register the session identity");
    }
  }
}

/**
 * Export the current harness session to child tool processes and ensure its
 * durable identity exists on startup and session switches.
 */
export default function agentIdExtension(pi: ExtensionAPI): void {
  const ensureSession = (_event: unknown, context: SessionContext): void => {
    const sessionId = context.sessionManager.getSessionId();
    if (!sessionId) {
      delete process.env.AGENT_ID_SESSION_ID;
      return;
    }

    process.env.AGENT_ID_SESSION_ID = sessionId;
    ensureRegistered();
  };

  pi.on("session_start", ensureSession);
  pi.on("session_switch", ensureSession);
}
