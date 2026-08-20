# agent-id

Portable identity registry for coding-agent sessions.

The `agent-id` binary assigns a permanent human-readable name to a stable session ID. The registry is durable, realm-aware, and independent of any particular agent harness.

The Rust crate is named `agent-id-cli`; the installed binary remains `agent-id`.

## Usage

Register a session:

```bash
agent-id register SESSION_ID --family Oak --realm Darkwood
```

Look up an existing session:

```bash
agent-id lookup SESSION_ID
```

Session discovery uses an explicit argument first, then `AGENT_ID_SESSION_ID`.

Use `--json` for machine-readable assignment records. Use `agent-id prime` for the complete agent-facing workflow documentation.

## Registry

The registry defaults to `$XDG_DATA_HOME/agent-id`, or `$HOME/.local/share/agent-id` when `XDG_DATA_HOME` is unset. Set `AGENT_ID_HOME` for tests or an isolated registry.

## OMP integration

The optional `extensions/agent-id.ts` adapter exports the current OMP session as `AGENT_ID_SESSION_ID` for child tool processes. At session start it looks up the assignment and registers it if missing. A child process inherits `AGENT_SURNAME` and registers with that family name; ordinary ephemeral prompts remain anonymous. Install or link the extension into the OMP extension directory.

## Attribution

The identity-and-mail coordination model was inspired by Josh Beckman's `agent-mail` script:

<https://github.com/joshbeckman/dotfiles/blob/master/bin/agent-mail>

`agent-id` is an independent Rust implementation of the identity registry portion of that system. Mailbox transport remains a separate concern handled by `agent-mail`.
