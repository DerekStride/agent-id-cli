# agent-id

Portable identity registry for coding-agent sessions.

The `agent-id` binary assigns a permanent human-readable name to a stable session ID. The registry is durable, realm-aware, and independent of any particular agent harness.

The Rust crate is named `agent-id-cli`; the installed binary remains `agent-id`.

## Usage

Register a session:

```bash
agent-id register SESSION_ID --family Oak --realm Darkwood
```

Look up an existing identity by session ID, canonical name, or slug:

```bash
agent-id lookup SESSION_ID
agent-id lookup "Spring Oak of Darkwood"
agent-id lookup spring-oak-darkwood
```

Set or clear a concise current-work summary without changing the identity:

```bash
agent-id annotate SESSION_ID --summary "Implementing checkout retries"
agent-id annotate SESSION_ID --clear-summary
```

Without an explicit identifier, lookup and annotate use `AGENT_ID_SESSION_ID`. Use `--json` for machine-readable assignment records, including the optional timestamped summary. Use `agent-id prime` for the complete agent-facing workflow documentation.

List recent identities sorted by `updated_at`:

```bash
agent-id discover
agent-id discover --limit 20
agent-id discover --recent 24 --realm Darkwood --json
```

Human-readable discovery includes summaries when present. JSON discovery always includes the nullable `summary` field.

Prune old assignments by default, or preview with `--dry-run`:

```bash
agent-id prune --before 2026-08-01T00:00:00Z
agent-id prune --before 2026-08-01T00:00:00Z --dry-run --json
```

## Registry

The registry defaults to `$XDG_DATA_HOME/agent-id`, or `$HOME/.local/share/agent-id` when `XDG_DATA_HOME` is unset. Set `AGENT_ID_HOME` for tests or an isolated registry.

Session records are stored as `by-session/<session-id>.json`; session IDs must be filename-safe. An optional current-work summary is stored with the assignment and updates independently of its permanent name.

Registration resolves the realm from `--realm`, `AGENT_REALM` (for tests/overrides), or `$XDG_CONFIG_HOME/agent-id/realm` with `$HOME/.config/agent-id/realm` as the fallback. If missing, a realm is automatically chosen and saved to the realm file for all future sessions on the machine.

The optional `extensions/agent-id.ts` adapter registers an OMP tool named `agent_identity`. The tool reads the authoritative session ID from the extension context, looks up or registers the assignment with explicit CLI arguments, and returns the complete JSON record. Pass `summary` to publish current work or `clear_summary: true` to remove it. Lifecycle hooks perform the same lookup/register maintenance without relying on shell environment propagation. Install or link the extension into the OMP extension directory.

## Attribution

The identity-and-mail coordination model was inspired by Josh Beckman's `agent-mail` script:

<https://github.com/joshbeckman/dotfiles/blob/master/bin/agent-mail>

`agent-id` is an independent Rust implementation of the identity registry portion of that system. Mailbox transport remains a separate concern handled by `agent-mail`.
