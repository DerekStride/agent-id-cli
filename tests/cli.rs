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
fn register_rejects_a_session_that_already_has_an_identity() {
    let root = TempDir::new().unwrap();
    let first = command(&root)
        .args(["register", "session-3"])
        .output()
        .unwrap();
    assert!(first.status.success(), "{first:?}");

    let second = command(&root)
        .args(["register", "session-3"])
        .output()
        .unwrap();
    assert!(!second.status.success());
    let error = String::from_utf8(second.stderr).unwrap();
    assert!(error.contains("already has an identity"), "{error:?}");
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
    let mut command = command(&root);
    command.env("OMP_SESSION_ID", "legacy-session");
    let output = command.args(["lookup"]).output().unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("no session ID found"));
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
