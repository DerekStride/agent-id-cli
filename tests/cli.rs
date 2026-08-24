use std::process::Command;

use agent_id_cli::registry::Assignment;
use serde_json::Value;
use tempfile::TempDir;

fn command(root: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_agent-id"));
    command
        .env("AGENT_ID_HOME", root.path())
        .env("AGENT_REALM", "Darkwood")
        .env_remove("AGENT_ID_SESSION_ID")
        .env_remove("AGENT_SESSION_ID")
        .env_remove("OMP_SESSION_ID")
        .env_remove("PI_SESSION_ID");
    command
}

#[test]
fn register_and_lookup_print_the_same_name() {
    let root = TempDir::new().unwrap();
    let registered = command(&root)
        .args(["register", "session-1", "--family", "Oak"])
        .output()
        .unwrap();
    assert!(registered.status.success(), "{registered:?}");

    let name = String::from_utf8(registered.stdout).unwrap();
    assert!(name.ends_with(" Oak of Darkwood\n"), "{name:?}");

    let looked_up = command(&root)
        .args(["lookup", "session-1"])
        .output()
        .unwrap();
    assert!(looked_up.status.success(), "{looked_up:?}");
    assert_eq!(looked_up.stdout, name.as_bytes());
}

#[test]
fn json_contains_the_canonical_assignment() {
    let root = TempDir::new().unwrap();
    let output = command(&root)
        .args(["register", "session-2", "--family", "Oak", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    let assignment: Assignment = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(assignment.version, 1);
    assert_eq!(assignment.session_id, "session-2");
    assert_eq!(assignment.family_name, "Oak");
    assert_eq!(assignment.realm, "Darkwood");
    assert_eq!(
        assignment.slug,
        format!(
            "{}-oak-darkwood",
            assignment.first_name.to_ascii_lowercase()
        )
    );

    let lookup = command(&root)
        .args(["lookup", "session-2", "--json"])
        .output()
        .unwrap();
    let looked_up: Assignment = serde_json::from_slice(&lookup.stdout).unwrap();
    assert_eq!(looked_up, assignment);

    for identifier in [assignment.name.as_str(), assignment.slug.as_str()] {
        let lookup = command(&root)
            .args(["lookup", identifier, "--json"])
            .output()
            .unwrap();
        assert!(lookup.status.success(), "{lookup:?}");
        let looked_up: Assignment = serde_json::from_slice(&lookup.stdout).unwrap();
        assert_eq!(looked_up, assignment);
    }
}

#[test]
fn annotate_updates_discovers_and_clears_summary() {
    let root = TempDir::new().unwrap();
    let registered = command(&root)
        .args(["register", "summary-session", "--json"])
        .output()
        .unwrap();
    assert!(registered.status.success(), "{registered:?}");
    let registered: Assignment = serde_json::from_slice(&registered.stdout).unwrap();

    let annotated = command(&root)
        .args([
            "annotate",
            "summary-session",
            "--summary",
            "  Implementing\n  activity summaries  ",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(annotated.status.success(), "{annotated:?}");
    let annotated: Assignment = serde_json::from_slice(&annotated.stdout).unwrap();
    let summary = annotated.summary.as_ref().unwrap();
    assert_eq!(summary.text, "Implementing activity summaries");
    assert!(summary.updated_at >= registered.updated_at);
    assert_eq!(annotated.name, registered.name);
    assert_eq!(annotated.created_at, registered.created_at);

    let lookup = command(&root)
        .args(["lookup", "summary-session", "--json"])
        .output()
        .unwrap();
    assert!(lookup.status.success(), "{lookup:?}");
    assert_eq!(
        serde_json::from_slice::<Assignment>(&lookup.stdout).unwrap(),
        annotated
    );

    let discovered = command(&root)
        .args(["discover", "--json"])
        .output()
        .unwrap();
    assert!(discovered.status.success(), "{discovered:?}");
    let discovered: Vec<Assignment> = serde_json::from_slice(&discovered.stdout).unwrap();
    assert_eq!(discovered, vec![annotated.clone()]);

    let human = command(&root).args(["discover"]).output().unwrap();
    assert!(human.status.success(), "{human:?}");
    assert!(String::from_utf8(human.stdout)
        .unwrap()
        .contains("summary:Implementing activity summaries"));

    let cleared = command(&root)
        .args(["annotate", "summary-session", "--clear-summary", "--json"])
        .output()
        .unwrap();
    assert!(cleared.status.success(), "{cleared:?}");
    let cleared: Assignment = serde_json::from_slice(&cleared.stdout).unwrap();
    assert_eq!(cleared.summary, None);
    assert_eq!(cleared.name, registered.name);
    assert_eq!(cleared.created_at, registered.created_at);
}

#[test]
fn register_returns_and_updates_an_existing_identity() {
    let root = TempDir::new().unwrap();
    let first = command(&root)
        .args(["register", "session-3", "--json"])
        .output()
        .unwrap();
    assert!(first.status.success(), "{first:?}");
    let first: Assignment = serde_json::from_slice(&first.stdout).unwrap();

    let second = command(&root)
        .args(["register", "session-3", "--json"])
        .output()
        .unwrap();
    assert!(second.status.success(), "{second:?}");
    let second: Assignment = serde_json::from_slice(&second.stdout).unwrap();

    assert_eq!(second.name, first.name);
    assert_eq!(second.created_at, first.created_at);
    assert!(second.updated_at >= first.updated_at);
}

#[test]
fn commands_discover_session_id_from_environment() {
    let root = TempDir::new().unwrap();
    let mut register = command(&root);
    register.env("AGENT_ID_SESSION_ID", "env-session");
    let registered = register
        .args(["register", "--family", "Oak"])
        .output()
        .unwrap();
    assert!(registered.status.success(), "{registered:?}");

    let mut lookup = command(&root);
    lookup.env("AGENT_ID_SESSION_ID", "env-session");
    let looked_up = lookup.args(["lookup"]).output().unwrap();
    assert!(looked_up.status.success(), "{looked_up:?}");
    assert_eq!(looked_up.stdout, registered.stdout);
}

#[test]
fn legacy_session_environment_names_are_ignored() {
    let root = TempDir::new().unwrap();
    for (key, value) in [
        ("OMP_SESSION_ID", "omp-session"),
        ("PI_SESSION_ID", "pi-session"),
    ] {
        let mut command = command(&root);
        command.env(key, value);
        let output = command.args(["lookup"]).output().unwrap();

        assert!(!output.status.success());
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("no session ID found"));
    }
}

#[test]
fn lookup_fails_before_registration() {
    let root = TempDir::new().unwrap();
    let output = command(&root).args(["lookup", "missing"]).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("no identity found"));
}

#[test]
fn prime_json_contains_the_command_contract() {
    let root = TempDir::new().unwrap();
    let output = command(&root).args(["prime", "--json"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");

    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let documentation = value["documentation"].as_str().unwrap();
    assert!(documentation.contains("agent-id register"));
    assert!(documentation.contains("agent-id lookup"));
    assert!(documentation.contains("agent-id annotate"));
}

#[test]
fn discover_lists_recent_assignments() {
    let root = TempDir::new().unwrap();
    for session_id in ["discover-one", "discover-two"] {
        let output = command(&root)
            .args(["register", session_id, "--json"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    let output = command(&root)
        .args(["discover", "--json", "--realm", "Darkwood", "--limit", "1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let assignments: Vec<Assignment> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(assignments.len(), 1);
    assert_eq!(assignments[0].realm, "Darkwood");

    let output = command(&root)
        .args(["discover", "--json", "--recent", "1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let assignments: Vec<Assignment> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(assignments.len(), 2);
    assert!(assignments[0].updated_at >= assignments[1].updated_at);
}

#[test]
fn prune_defaults_to_apply_and_dry_run_previews() {
    let root = TempDir::new().unwrap();
    let registered = command(&root)
        .args(["register", "prune-session", "--json"])
        .output()
        .unwrap();
    assert!(registered.status.success(), "{registered:?}");
    let assignment: Assignment = serde_json::from_slice(&registered.stdout).unwrap();

    let cutoff = "2100-01-01T00:00:00Z";
    let dry_run = command(&root)
        .args(["prune", "--before", cutoff, "--dry-run", "--json"])
        .output()
        .unwrap();
    assert!(dry_run.status.success(), "{dry_run:?}");
    let report: Value = serde_json::from_slice(&dry_run.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["candidates"].as_array().unwrap().len(), 1);

    let still_present = command(&root)
        .args(["lookup", assignment.session_id.as_str()])
        .output()
        .unwrap();
    assert!(still_present.status.success(), "{still_present:?}");

    let applied = command(&root)
        .args(["prune", "--before", cutoff, "--json"])
        .output()
        .unwrap();
    assert!(applied.status.success(), "{applied:?}");
    let report: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(report["dry_run"], false);
    assert_eq!(report["removed"].as_array().unwrap().len(), 1);

    let removed = command(&root)
        .args(["lookup", assignment.session_id.as_str()])
        .output()
        .unwrap();
    assert!(!removed.status.success());
    assert!(!root
        .path()
        .join(format!("by-name/{}.json", assignment.slug))
        .exists());
    assert!(!root
        .path()
        .join(format!("by-name/{}", assignment.slug))
        .exists());
}

#[test]
fn registration_auto_creates_realm_when_missing() {
    let root = TempDir::new().unwrap();
    let config_dir = TempDir::new().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_agent-id"));
    command
        .env("AGENT_ID_HOME", root.path())
        .env("XDG_CONFIG_HOME", config_dir.path())
        .env_remove("AGENT_REALM")
        .env_remove("AGENT_ID_SESSION_ID");

    let output = command
        .args(["register", "session-auto-realm", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    let assignment: Assignment = serde_json::from_slice(&output.stdout).unwrap();
    let realm_file = config_dir.path().join("agent-id/realm");
    assert!(realm_file.is_file());
    let persisted_realm = std::fs::read_to_string(&realm_file).unwrap();
    assert_eq!(persisted_realm.trim(), assignment.realm);
}
