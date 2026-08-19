use std::{
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    cli::{LookupArgs, RegisterArgs},
    names,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Assignment {
    pub version: u8,
    pub session_id: String,
    pub name: String,
    pub slug: String,
    pub first_name: String,
    pub family_name: String,
    pub realm: String,
    pub assigned_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct Registry {
    root: PathBuf,
}

impl Registry {
    pub fn from_env() -> Result<Self> {
        let root = if let Some(path) = env::var_os("AGENT_ID_HOME") {
            PathBuf::from(path)
        } else if let Some(path) = env::var_os("XDG_DATA_HOME") {
            PathBuf::from(path).join("agent-id")
        } else {
            home_dir()?.join(".local/share/agent-id")
        };

        Ok(Self::new(root))
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn register(
        &self,
        session_id: &str,
        family_name: Option<&str>,
        realm: &str,
    ) -> Result<Assignment> {
        let session_id = require_nonempty(session_id, "session ID")?;
        let session_path = self.session_path(&session_id);
        if session_path.exists() {
            let existing = read_assignment(&session_path)
                .with_context(|| format!("read existing assignment {}", session_path.display()))?;
            bail!(
                "session {session_id} already has an identity: {}",
                existing.name
            );
        }

        let realm = normalize_component(realm, "realm")?;
        let requested_family = family_name
            .map(|value| normalize_component(value, "family name"))
            .transpose()?;
        let first_names = names::first_names();
        let family_names = names::family_names();
        if first_names.is_empty() || family_names.is_empty() {
            bail!("name lists are empty");
        }

        fs::create_dir_all(self.root.join("by-session"))
            .with_context(|| format!("create {}", self.root.display()))?;
        fs::create_dir_all(self.root.join("by-name"))
            .with_context(|| format!("create {}", self.root.display()))?;

        for attempt in 0..100_000_u64 {
            let (first, family) = candidate(
                &session_id,
                attempt,
                &first_names,
                &family_names,
                requested_family.as_deref(),
            );
            if first == family {
                continue;
            }

            let first_name = title_word(first);
            let family_name = title_word(&family);

            let name = format!("{first_name} {family_name} of {realm}");
            let slug = slug(&first_name, &family_name, &realm);
            let claim_path = self.root.join("by-name").join(&slug);

            match claim_name(&claim_path, &session_id)? {
                Claim::Owned => {}
                Claim::Claimed => {}
                Claim::Other => continue,
            }

            let assignment = Assignment {
                version: 1,
                session_id: session_id.clone(),
                name,
                slug,
                first_name,
                family_name,
                realm: realm.clone(),
                assigned_at: Utc::now(),
            };
            write_assignment(&session_path, &assignment)?;
            return Ok(assignment);
        }

        bail!("exhausted available names for realm {realm}")
    }

    pub fn lookup(&self, session_id: &str) -> Result<Assignment> {
        let session_id = require_nonempty(session_id, "session ID")?;
        let path = self.session_path(&session_id);
        if !path.exists() {
            bail!(
                "no identity registered for session {session_id}; run `agent-id register {session_id}`"
            );
        }

        let assignment = read_assignment(&path)
            .with_context(|| format!("read assignment for session {session_id}"))?;
        if assignment.session_id != session_id {
            bail!("identity registry entry does not belong to session {session_id}");
        }
        Ok(assignment)
    }

    fn session_path(&self, session_id: &str) -> PathBuf {
        self.root
            .join("by-session")
            .join(format!("{}.json", session_key(session_id)))
    }
}

pub fn execute_register(args: &RegisterArgs) -> Result<()> {
    let session_id = resolve_session(args.explicit_session())?;
    let realm = resolve_realm(args.realm.as_deref())?;
    let assignment = Registry::from_env()?.register(&session_id, args.family.as_deref(), &realm)?;
    print_assignment(&assignment, args.json)
}

pub fn execute_lookup(args: &LookupArgs) -> Result<()> {
    let session_id = resolve_session(args.explicit_session())?;
    let assignment = Registry::from_env()?.lookup(&session_id)?;
    print_assignment(&assignment, args.json)
}

pub fn resolve_session(explicit: Option<&str>) -> Result<String> {
    if let Some(session_id) = explicit.filter(|value| !value.trim().is_empty()) {
        return Ok(session_id.trim().to_string());
    }

    for key in ["AGENT_SESSION_ID", "OMP_SESSION_ID", "PI_SESSION_ID"] {
        if let Some(value) = env::var_os(key) {
            let value = value.to_string_lossy();
            if !value.trim().is_empty() {
                return Ok(value.trim().to_string());
            }
        }
    }

    bail!("no session ID found; pass SESSION_ID or --session-id, or set AGENT_SESSION_ID")
}

fn resolve_realm(explicit: Option<&str>) -> Result<String> {
    if let Some(realm) = explicit.filter(|value| !value.trim().is_empty()) {
        return normalize_component(realm, "realm");
    }
    if let Some(realm) = env::var_os("AGENT_REALM") {
        let realm = realm.to_string_lossy();
        if !realm.trim().is_empty() {
            return normalize_component(&realm, "realm");
        }
    }

    let home = home_dir()?;
    let config_home = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let current_path = config_home.join("agent-id/realm");
    let legacy_path = home.join(".config/agent-realm");

    for path in [current_path, legacy_path] {
        if path.is_file() {
            let value = fs::read_to_string(&path)
                .with_context(|| format!("read realm from {}", path.display()))?;
            return normalize_component(&value, "realm");
        }
    }

    bail!("no realm found; pass --realm NAME or set AGENT_REALM")
}

fn print_assignment(assignment: &Assignment, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(assignment)?);
    } else {
        println!("{}", assignment.name);
    }
    Ok(())
}

fn candidate<'a>(
    session_id: &str,
    attempt: u64,
    first_names: &'a [&'a str],
    family_names: &'a [&'a str],
    requested_family: Option<&str>,
) -> (&'a str, String) {
    let digest = Sha256::digest(format!("{session_id}:{attempt}").as_bytes());
    let first_index = usize::try_from(u64::from_be_bytes(digest[0..8].try_into().unwrap()))
        .unwrap_or(0)
        % first_names.len();
    let family_index = usize::try_from(u64::from_be_bytes(digest[8..16].try_into().unwrap()))
        .unwrap_or(0)
        % family_names.len();
    let family = requested_family
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| family_names[family_index].to_string());
    (first_names[first_index], family)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Claim {
    Claimed,
    Owned,
    Other,
}

fn claim_name(path: &Path, session_id: &str) -> Result<Claim> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("name claim has no parent directory"))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;

    let temp = temporary_path(path);
    let mut file = File::create(&temp)
        .with_context(|| format!("create temporary claim {}", temp.display()))?;
    file.write_all(session_id.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;

    let claim = match fs::hard_link(&temp, path) {
        Ok(()) => Claim::Claimed,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let owner = fs::read_to_string(path).unwrap_or_default();
            if owner.trim() == session_id {
                Claim::Owned
            } else {
                Claim::Other
            }
        }
        Err(error) => return Err(error).with_context(|| format!("claim name {}", path.display())),
    };
    let _ = fs::remove_file(temp);
    Ok(claim)
}

fn write_assignment(path: &Path, assignment: &Assignment) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("assignment has no parent directory"))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let contents = format!("{}\n", serde_json::to_string_pretty(assignment)?);
    let temp = temporary_path(path);
    let mut file = File::create(&temp)
        .with_context(|| format!("create temporary assignment {}", temp.display()))?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;

    let result = match fs::hard_link(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            bail!(
                "session {} already has a registered identity",
                assignment.session_id
            )
        }
        Err(error) => Err(error).with_context(|| format!("write assignment {}", path.display())),
    };
    let _ = fs::remove_file(temp);
    result
}

fn read_assignment(path: &Path) -> Result<Assignment> {
    let contents = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents)?)
}

fn temporary_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    path.with_extension(format!("tmp-{}-{nanos}", std::process::id()))
}

fn session_key(session_id: &str) -> String {
    hex::encode(Sha256::digest(session_id.as_bytes()))
}

fn slug(first_name: &str, family_name: &str, realm: &str) -> String {
    [first_name, family_name, realm]
        .iter()
        .map(|part| part.to_ascii_lowercase().replace([' ', '\'', '_'], "-"))
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize_component(value: &str, kind: &str) -> Result<String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphabetic() || character == '-' || character == '\''
        })
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        && value
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_alphabetic());
    if !valid {
        bail!("{kind} must contain only letters, apostrophes, or hyphens")
    }
    Ok(title_word(value))
}

fn title_word(value: &str) -> String {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + &characters.as_str().to_ascii_lowercase()
}

fn require_nonempty(value: &str, kind: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{kind} cannot be empty")
    }
    Ok(value.to_string())
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is not set; set AGENT_ID_HOME explicitly"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_identity_has_canonical_parts() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        let assignment = registry
            .register("session-1", Some("Oak"), "Darkwood")
            .unwrap();

        assert_eq!(assignment.family_name, "Oak");
        assert_eq!(assignment.realm, "Darkwood");
        assert_eq!(
            assignment.slug,
            format!(
                "{}-oak-darkwood",
                assignment.first_name.to_ascii_lowercase()
            )
        );
        assert_eq!(
            assignment.name,
            format!("{} Oak of Darkwood", assignment.first_name)
        );
    }

    #[test]
    fn registering_a_session_twice_fails() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        registry.register("session-1", None, "Darkwood").unwrap();
        let error = registry
            .register("session-1", None, "Darkwood")
            .unwrap_err();
        assert!(error.to_string().contains("already has an identity"));
    }

    #[test]
    fn lookup_requires_a_registered_session() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        let error = registry.lookup("missing").unwrap_err();
        assert!(error.to_string().contains("no identity registered"));
    }
}
