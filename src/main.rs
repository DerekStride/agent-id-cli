use anyhow::Result;
use clap::Parser;

fn main() {
    if let Err(error) = run() {
        eprintln!("agent-id: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = agent_id_cli::cli::Cli::parse();
    agent_id_cli::run(cli)
}
