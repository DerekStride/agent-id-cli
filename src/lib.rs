pub mod cli;
pub mod names;
pub mod prime;
pub mod registry;

use anyhow::Result;

pub fn run(cli: cli::Cli) -> Result<()> {
    match cli.command {
        cli::Commands::Register(args) => registry::execute_register(&args),
        cli::Commands::Lookup(args) => registry::execute_lookup(&args),
        cli::Commands::Prime(args) => prime::execute(&args),
    }
}
