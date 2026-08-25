#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <version> <arm64_sha256> <x86_64_sha256>" >&2
  exit 1
fi

version="$1"
arm_sha="$2"
intel_sha="$3"

cat <<EOF
class AgentIdCli < Formula
  desc "Portable identity registry for coding-agent sessions"
  homepage "https://github.com/DerekStride/agent-id-cli"
  version "${version}"
  license "MIT"

  on_arm do
    url "https://github.com/DerekStride/agent-id-cli/releases/download/v#{version}/agent-id-cli-v#{version}-aarch64-apple-darwin.tar.gz"
    sha256 "${arm_sha}"
  end

  on_intel do
    url "https://github.com/DerekStride/agent-id-cli/releases/download/v#{version}/agent-id-cli-v#{version}-x86_64-apple-darwin.tar.gz"
    sha256 "${intel_sha}"
  end

  def install
    bin.install "agent-id"
  end

  test do
    ENV["AGENT_ID_HOME"] = testpath/"agent-id"
    ENV["AGENT_REALM"] = "Homebrew"
    output = shell_output("#{bin}/agent-id register test-session --json")
    assert_match '"session_id":"test-session"', output
  end
end
EOF
