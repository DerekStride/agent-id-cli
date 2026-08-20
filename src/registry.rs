use std::{
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    cli::{DiscoverArgs, LookupArgs, RegisterArgs},
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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
        let session_id = validate_session_id(session_id)?;
        let session_path = self.session_path(&session_id);
        if session_path.exists() {
            let mut existing = read_assignment(&session_path)
                .with_context(|| format!("read existing assignment {}", session_path.display()))?;
            existing.updated_at = Utc::now();
            replace_assignment(&session_path, &existing)?;
            return Ok(existing);
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

            let now = Utc::now();
            let assignment = Assignment {
                version: 1,
                session_id: session_id.clone(),
                name,
                slug,
                first_name,
                family_name,
                realm: realm.clone(),
                created_at: now,
                updated_at: now,
            };
            write_assignment(&session_path, &assignment)?;
            return Ok(assignment);
        }

        bail!("exhausted available names for realm {realm}")
    }

    pub fn lookup(&self, input: &str) -> Result<Assignment> {
        let input = require_nonempty(input, "lookup identifier")?;
        if let Ok(session_id) = validate_session_id(&input) {
            let session_path = self.session_path(&session_id);
            if session_path.exists() {
                return self.lookup_session(&session_id);
            }
        }

        for slug in lookup_slugs(&input) {
            let claim_path = self.root.join("by-name").join(&slug);
            if !claim_path.is_file() {
                continue;
            }

            let session_id = require_nonempty(
                &fs::read_to_string(&claim_path)
                    .with_context(|| format!("read name claim {}", claim_path.display()))?,
                "claimed session ID",
            )?;
            return self
                .lookup_session(&session_id)
                .with_context(|| format!("resolve name claim {slug}"));
        }

        bail!(
            "no identity found for '{input}'; lookup accepts a session ID, canonical name, or slug"
        )
    }

    fn lookup_session(&self, session_id: &str) -> Result<Assignment> {
        let session_id = validate_session_id(session_id)?;
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
    pub fn discover(
        &self,
        limit: usize,
        recent_hours: Option<i64>,
        realm: Option<&str>,
    ) -> Result<Vec<Assignment>> {
        if recent_hours.is_some_and(|hours| hours < 0) {
            bail!("--recent must be non-negative");
        }
        let realm = realm
            .map(|value| normalize_component(value, "realm"))
            .transpose()?;
        let cutoff = recent_hours.map(|hours| Utc::now() - Duration::hours(hours));
        let path = self.root.join("by-session");
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let mut assignments = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let assignment = read_assignment(&path)
                .with_context(|| format!("read assignment {}", path.display()))?;
            if realm
                .as_deref()
                .is_some_and(|value| value != assignment.realm)
            {
                continue;
            }
            if cutoff.is_some_and(|value| assignment.updated_at < value) {
                continue;
            }
            assignments.push(assignment);
        }
        assignments.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        if limit > 0 {
            assignments.truncate(limit);
        }
        Ok(assignments)
    }

    fn session_path(&self, session_id: &str) -> PathBuf {
        self.root
            .join("by-session")
            .join(format!("{session_id}.json"))
    }
}

pub fn execute_register(args: &RegisterArgs) -> Result<()> {
    let session_id = resolve_session(args.explicit_session())?;
    let realm = resolve_realm(args.realm.as_deref())?;
    let assignment = Registry::from_env()?.register(&session_id, args.family.as_deref(), &realm)?;
    print_assignment(&assignment, args.json)
}

pub fn execute_lookup(args: &LookupArgs) -> Result<()> {
    let input = resolve_session(args.explicit_input())?;
    let assignment = Registry::from_env()?.lookup(&input)?;
    print_assignment(&assignment, args.json)
}

pub fn execute_discover(args: &DiscoverArgs) -> Result<()> {
    let assignments =
        Registry::from_env()?.discover(args.limit, args.recent, args.realm.as_deref())?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&assignments)?);
    } else if assignments.is_empty() {
        println!("(no identities)");
    } else {
        for assignment in assignments {
            println!(
                "{}\t{}\tupdated:{}",
                assignment.name,
                assignment.session_id,
                assignment.updated_at.to_rfc3339()
            );
        }
    }
    Ok(())
}

pub fn resolve_session(explicit: Option<&str>) -> Result<String> {
    if let Some(session_id) = explicit.filter(|value| !value.trim().is_empty()) {
        return Ok(session_id.trim().to_string());
    }

    for key in ["AGENT_ID_SESSION_ID", "OMP_SESSION_ID", "PI_SESSION_ID"] {
        if let Some(value) = env::var_os(key) {
            let value = value.to_string_lossy();
            if !value.trim().is_empty() {
                return Ok(value.trim().to_string());
            }
        }
    }

    bail!(
        "no session ID found; pass SESSION_ID or --session-id, or set AGENT_ID_SESSION_ID, OMP_SESSION_ID, or PI_SESSION_ID"
    )
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
    let realm_path = config_home.join("agent-id/realm");

    if realm_path.is_file() {
        let value = fs::read_to_string(&realm_path)
            .with_context(|| format!("read realm from {}", realm_path.display()))?;
        return normalize_component(&value, "realm");
    }

    auto_create_realm(&realm_path)
}

fn auto_create_realm(path: &Path) -> Result<String> {
    let candidates = names::candidate_realms();
    if candidates.is_empty() {
        bail!("bundled realm candidate list is empty");
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id();
    let hostname = env::var("HOSTNAME").unwrap_or_default();
    let digest = Sha256::digest(format!("{nanos}:{pid}:{hostname}").as_bytes());
    let index = usize::try_from(u64::from_be_bytes(digest[0..8].try_into().unwrap())).unwrap_or(0)
        % candidates.len();
    let realm = normalize_component(candidates[index], "realm")?;

    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("realm path has no parent directory"))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;

    let temp = temporary_path(path);
    let mut file = File::create(&temp)
        .with_context(|| format!("create temporary realm {}", temp.display()))?;
    file.write_all(format!("{realm}\n").as_bytes())?;
    file.sync_all()?;

    match fs::hard_link(&temp, path) {
        Ok(()) => {
            let _ = fs::remove_file(temp);
            Ok(realm)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(temp);
            let value = fs::read_to_string(path)
                .with_context(|| format!("read existing realm {}", path.display()))?;
            normalize_component(&value, "realm")
        }
        Err(error) => {
            let _ = fs::remove_file(temp);
            Err(error).with_context(|| format!("create realm file {}", path.display()))
        }
    }
}

fn print_assignment(assignment: &Assignment, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(assignment)?);
    } else {
        println!("{}", assignment.name);
    }
    Ok(())
}

fn lookup_slugs(input: &str) -> Vec<String> {
    let mut slugs = Vec::new();
    let input = input.trim();
    if is_slug(input) {
        slugs.push(input.to_ascii_lowercase());
    }
    if let Some(slug) = canonical_name_slug(input) {
        if !slugs.contains(&slug) {
            slugs.push(slug);
        }
    }
    slugs
}

fn canonical_name_slug(input: &str) -> Option<String> {
    let mut parts = input.split_whitespace();
    let first = normalize_component(parts.next()?, "first name").ok()?;
    let family = normalize_component(parts.next()?, "family name").ok()?;
    if !parts.next()?.eq_ignore_ascii_case("of") {
        return None;
    }
    let realm = normalize_component(parts.next()?, "realm").ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(slug(&first, &family, &realm))
}

fn is_slug(input: &str) -> bool {
    !input.is_empty()
        && !input.starts_with('-')
        && !input.ends_with('-')
        && input
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
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

fn replace_assignment(path: &Path, assignment: &Assignment) -> Result<()> {
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

    let result =
        fs::rename(&temp, path).with_context(|| format!("replace assignment {}", path.display()));
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn read_assignment(path: &Path) -> Result<Assignment> {
    let contents = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents)?)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temporary_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("tmp-{}-{nanos}-{counter}", std::process::id()))
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

fn validate_session_id(value: &str) -> Result<String> {
    let value = require_nonempty(value, "session ID")?;
    let safe = value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'));
    if !safe || value == "." || value == ".." {
        bail!("session ID must be a filename-safe value using letters, digits, '.', '_' or '-'");
    }
    Ok(value)
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
    fn session_id_is_the_registry_filename() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::new(root.path().to_path_buf());
        registry
            .register("session-visible", None, "Darkwood")
            .unwrap();

        assert!(root
            .path()
            .join("by-session/session-visible.json")
            .is_file());
    }

    #[test]
    fn unsafe_session_ids_are_rejected() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        let error = registry
            .register("../escape", None, "Darkwood")
            .unwrap_err();
        assert!(error.to_string().contains("filename-safe"));
    }

    #[test]
    fn lookup_accepts_session_name_and_slug() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        let assignment = registry
            .register("session-lookup", Some("Oak"), "Darkwood")
            .unwrap();

        assert_eq!(registry.lookup(&assignment.session_id).unwrap(), assignment);
        assert_eq!(registry.lookup(&assignment.name).unwrap(), assignment);
        assert_eq!(registry.lookup(&assignment.slug).unwrap(), assignment);
    }

    #[test]
    fn missing_realm_is_auto_created_and_reused() {
        let config_dir = tempfile::tempdir().unwrap();
        let realm_file = config_dir.path().join("agent-id/realm");
        assert!(!realm_file.exists());

        let first = auto_create_realm(&realm_file).unwrap();
        assert!(realm_file.is_file());
        let contents = fs::read_to_string(&realm_file).unwrap();
        assert_eq!(contents.trim(), first);

        let second = auto_create_realm(&realm_file).unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn concurrent_realm_creation_keeps_one_value() {
        let config_dir = tempfile::tempdir().unwrap();
        let realm_file = std::sync::Arc::new(config_dir.path().join("agent-id/realm"));
        let handles = (0..8)
            .map(|_| {
                let realm_file = std::sync::Arc::clone(&realm_file);
                std::thread::spawn(move || auto_create_realm(&realm_file).unwrap())
            })
            .collect::<Vec<_>>();
        let mut handles = handles.into_iter();
        let first = handles.next().unwrap().join().unwrap();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), first);
        }
    }
    #[test]
    fn registering_a_session_updates_existing_identity() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        let first = registry.register("session-1", None, "Darkwood").unwrap();
        let second = registry.register("session-1", None, "Darkwood").unwrap();

        assert_eq!(second.name, first.name);
        assert_eq!(second.session_id, first.session_id);
        assert_eq!(second.created_at, first.created_at);
        assert!(second.updated_at >= first.updated_at);
    }

    #[test]
    fn lookup_requires_a_registered_session() {
        let registry = Registry::new(tempfile::tempdir().unwrap().path().to_path_buf());
        let error = registry.lookup("missing").unwrap_err();
        assert!(error.to_string().contains("no identity found"));
    }
}
