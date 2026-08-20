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

/**
 * Export the current harness session to child tool processes.
 *
 * The extension deliberately owns only the environment bridge. Identity
 * allocation and persistence remain in the agent-id executable.
 */
export default function agentIdExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    const sessionFile = context.sessionManager.getSessionFile?.();
    const ephemeral = context.hasUI === false && !sessionFile;
    const sessionId = ephemeral ? undefined : context.sessionManager.getSessionId();

    if (sessionId) {
      process.env.AGENT_ID_SESSION_ID = sessionId;
    } else {
      delete process.env.AGENT_ID_SESSION_ID;
    }
  });
}
