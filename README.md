# agent-id

Portable identity registry and OMP companion extension for coding-agent sessions.

The `agent-id` binary assigns a permanent human-readable name to a stable session ID. The registry is durable, realm-aware, and independent of any particular agent harness.

In OMP, the companion extension makes identity automatic: it registers sessions, tracks lifecycle state and working directory, and derives a concise current-work summary from completed agent turns.

The Rust crate is named `agent-id-cli`; the installed binary remains `agent-id`.

## Installation

### Homebrew

```bash
brew install derekstride/tap/agent-id-cli
```

### Cargo

```bash
cargo install agent-id-cli
```

### OMP plugin

Install the binary first, then install the OMP extension from this repository:

```bash
omp plugin install https://github.com/DerekStride/agent-id-cli
```

Once installed, the extension handles the normal identity workflow automatically.

## Usage

With the OMP plugin, each session receives a stable identity and current lifecycle information without manual setup. Inspect recent identities from a terminal:

```bash
agent-id discover
agent-id discover --recent 24
agent-id lookup "Spring Oak of Darkwood"
```

Discovery shows available summaries, activity states, and working directories so a human operator can see which sessions exist and what they are doing.

For standalone use without OMP, register a harness session ID once and look it up later:

```bash
agent-id register SESSION_ID
agent-id lookup SESSION_ID
```

Run `agent-id --help` or `agent-id <command> --help` for all commands and options.

## Origin and companion project

`agent-id` is based on Josh Beckman's [design for coordinating dozens of coding agents](https://gist.github.com/joshbeckman/d21dbd6c566470e4d012392fd3cb8ed8). It carries forward the central identity decisions from that work: externally assigned human-readable names keyed to stable harness session IDs, machine realms that partition allocation, and durable lookup independent of model self-report. This project extracts the identity registry and OMP lifecycle integration; mail, workspaces, and other coordination concerns remain separate.

[AgentMail](https://github.com/DerekStride/agent-mail) extracts the Maildir messaging portion of Josh's design into its own crate. It integrates directly with `agent-id` for human-readable addressing while keeping mailbox delivery and read state separate from identity.
