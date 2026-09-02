use crate::activity::ActivityStateValue;

use clap::{Args, Command, CommandFactory, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "agent-id",
    version,
    about = "Portable identity registry for coding-agent sessions",
    long_about = "agent-id assigns permanent human-readable names to stable agent-harness session IDs."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Register a new permanent identity for a session
    Register(RegisterArgs),
    /// Look up the identity already registered for a session
    Lookup(LookupArgs),
    /// Look up the identity for AGENT_ID_SESSION_ID
    Current(CurrentArgs),
    /// Set or clear the current-work summary for a registered session
    Annotate(AnnotateArgs),
    /// List identity assignments; stopped assignments are hidden by default
    Discover(DiscoverArgs),
    /// Remove identity assignments older than a cutoff
    Prune(PruneArgs),
    /// Output the agent-facing identity workflow manual
    Prime(PrimeArgs),
}

#[derive(Debug, Args)]
pub struct CurrentArgs {
    /// Print the complete assignment as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct RegisterArgs {
    /// Harness session ID; falls back to AGENT_ID_SESSION_ID
    #[arg(value_name = "SESSION_ID", conflicts_with = "session_id")]
    pub session: Option<String>,

    /// Explicit harness session ID
    #[arg(long = "session-id", value_name = "ID")]
    pub session_id: Option<String>,

    /// Prefer this family name when allocating the identity
    #[arg(long, value_name = "NAME")]
    pub family: Option<String>,

    /// Computer realm; falls back to AGENT_REALM or config
    #[arg(long, value_name = "NAME")]
    pub realm: Option<String>,

    /// Print the complete assignment as JSON
    #[arg(long)]
    pub json: bool,
}

impl RegisterArgs {
    pub fn explicit_session(&self) -> Option<&str> {
        self.session.as_deref().or(self.session_id.as_deref())
    }
}

#[derive(Debug, Args)]
pub struct LookupArgs {
    /// Session ID, canonical name, or slug; falls back to AGENT_ID_SESSION_ID
    #[arg(value_name = "IDENTIFIER", conflicts_with = "session_id")]
    pub input: Option<String>,

    /// Explicit session ID
    #[arg(long = "session-id", value_name = "ID")]
    pub session_id: Option<String>,

    /// Print the complete assignment as JSON
    #[arg(long)]
    pub json: bool,
}

impl LookupArgs {
    pub fn explicit_input(&self) -> Option<&str> {
        self.input.as_deref().or(self.session_id.as_deref())
    }
}

#[derive(Debug, Args)]
pub struct AnnotateArgs {
    /// Harness session ID; falls back to AGENT_ID_SESSION_ID
    #[arg(value_name = "SESSION_ID", conflicts_with = "session_id")]
    pub session: Option<String>,

    /// Explicit harness session ID
    #[arg(long = "session-id", value_name = "ID")]
    pub session_id: Option<String>,

    /// Set the concise current-work summary
    #[arg(long, value_name = "TEXT", conflicts_with = "clear_summary")]
    pub summary: Option<String>,

    /// Remove the current-work summary
    #[arg(long, conflicts_with = "summary")]
    pub clear_summary: bool,

    /// Set the OMP lifecycle state signal
    #[arg(long, value_name = "VALUE", conflicts_with = "clear_state")]
    pub state: Option<ActivityStateValue>,

    /// Remove the OMP lifecycle state signal
    #[arg(long, conflicts_with = "state")]
    pub clear_state: bool,

    /// Set the current working directory
    #[arg(long, value_name = "PATH", conflicts_with = "clear_cwd")]
    pub cwd: Option<String>,

    /// Remove the current working directory
    #[arg(long, conflicts_with = "cwd")]
    pub clear_cwd: bool,

    /// Set namespaced extension metadata from OWNER=JSON
    #[arg(long = "extension", value_name = "OWNER=JSON")]
    pub extensions: Vec<String>,

    /// Remove one namespaced extension metadata value
    #[arg(long = "clear-extension", value_name = "OWNER")]
    pub clear_extensions: Vec<String>,

    /// Print the complete assignment as JSON
    #[arg(long)]
    pub json: bool,
}

impl AnnotateArgs {
    pub fn explicit_session(&self) -> Option<&str> {
        self.session.as_deref().or(self.session_id.as_deref())
    }
}

#[derive(Debug, Args)]
pub struct DiscoverArgs {
    /// Maximum records to print; zero prints all records
    #[arg(long, default_value_t = 20)]
    pub limit: usize,

    /// Only include records updated within this many hours
    #[arg(long, value_name = "HOURS")]
    pub recent: Option<i64>,

    /// Only include records in this realm
    #[arg(long, value_name = "NAME")]
    pub realm: Option<String>,

    /// Include stopped assignments
    #[arg(long)]
    pub all: bool,

    /// Print the complete assignments as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct PruneArgs {
    /// Remove records with updated_at before this RFC 3339 timestamp
    #[arg(long, value_name = "TIMESTAMP", required = true)]
    pub before: String,

    /// Preview matching records without deleting them
    #[arg(long)]
    pub dry_run: bool,

    /// Print the prune report as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
#[command(about = "Output the agent-facing identity workflow manual")]
pub struct PrimeArgs {
    /// Output only the workflow prelude
    #[arg(long)]
    pub prelude: bool,

    /// Wrap the documentation in a JSON object
    #[arg(long)]
    pub json: bool,
}

pub fn build_cli() -> Command {
    Cli::command()
}
