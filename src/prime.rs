use anyhow::Result;
use serde_json::json;

use crate::cli::PrimeArgs;

pub fn execute(args: &PrimeArgs) -> Result<()> {
    let documentation = generate(args.prelude);
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"documentation": documentation}))?
        );
    } else {
        println!("{documentation}");
    }
    Ok(())
}

pub fn generate(prelude_only: bool) -> String {
    let prelude = r#"# agent-id — Portable agent identity registry

Use `agent-id` to register and look up the permanent human-readable identity for a coding-agent session.

The identity is keyed by the harness session ID. Do not invent a name or register a second name for the same session.

Session discovery, in order:

1. An explicit `SESSION_ID` argument or `--session-id ID`.
2. `AGENT_ID_SESSION_ID`.

The realm is discovered from `--realm NAME`, `AGENT_REALM` (for tests/overrides), or `$XDG_CONFIG_HOME/agent-id/realm` with `$HOME/.config/agent-id/realm` as the fallback. If no realm configuration exists, one is automatically selected and saved to the realm file.

The registry is durable and defaults to `$XDG_DATA_HOME/agent-id`, or `$HOME/.local/share/agent-id` when `XDG_DATA_HOME` is unset. Set `AGENT_ID_HOME` for tests or an isolated registry.

A missing session ID is an error. A missing lookup is an error; register the session first.

## Examples

```bash
agent-id register "$AGENT_ID_SESSION_ID"
agent-id register --family Oak "$AGENT_ID_SESSION_ID"
agent-id lookup "$AGENT_ID_SESSION_ID"
agent-id register --json --family Oak "$AGENT_ID_SESSION_ID"
```

The default output is the full name. Use `--json` when a tool needs the session ID, name parts, realm, slug, and assignment timestamp."#;

    if prelude_only {
        return prelude.to_string();
    }

    format!(
        "{prelude}\n\n## Commands\n\n### `agent-id register [SESSION_ID]` — Allocate a permanent identity\n\n```\n--family NAME       Prefer a family name, useful for child agents\n--realm NAME        Select the computer realm\n--session-id ID     Provide the session ID explicitly\n--json              Print the complete assignment as JSON\n```\n\nFails if the session already has a registered identity.\n\n### `agent-id lookup [IDENTIFIER]` — Read an existing identity\n\nIDENTIFIER may be a session ID, canonical name, or slug. Without an explicit identifier, lookup uses AGENT_ID_SESSION_ID.\n\n```\n--session-id ID     Provide the session ID explicitly\n--json              Print the complete assignment as JSON\n```\n\nFails if the identifier has not been registered.\n\n### `agent-id prime` — Print this workflow manual\n\n```\n--prelude           Omit the command reference\n--json              Wrap the manual in a JSON object\n```"
    )
}
