#!/usr/bin/env python3
"""Generate GitHub release notes from conventional commit subjects."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
from collections import defaultdict
from dataclasses import dataclass


CONVENTIONAL_COMMIT = re.compile(
    r"^(?P<type>[a-z][a-z0-9-]*)(?:\((?P<scope>[^()\r\n]+)\))?(?P<breaking>!)?:\s+(?P<description>.+)$"
)
BREAKING_CHANGE = re.compile(r"^BREAKING[ -]CHANGE\s*:", re.MULTILINE)

CATEGORIES = {
    "feat": "Features",
    "fix": "Bug Fixes",
    "perf": "Performance",
    "refactor": "Refactoring",
    "docs": "Documentation",
    "test": "Tests",
    "build": "Build",
    "ci": "CI",
    "chore": "Maintenance",
    "revert": "Reverts",
}
CATEGORY_ORDER = (
    "Features",
    "Bug Fixes",
    "Performance",
    "Refactoring",
    "Documentation",
    "Tests",
    "Build",
    "CI",
    "Maintenance",
    "Reverts",
    "Other",
)


@dataclass(frozen=True)
class Commit:
    commit_hash: str
    commit_type: str
    scope: str | None
    description: str
    breaking: bool


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], check=True, stdout=subprocess.PIPE, text=True
    )
    return result.stdout


def previous_tag(tag: str) -> str | None:
    tags = git("tag", "--sort=-version:refname", "--list", "v*").splitlines()
    try:
        index = tags.index(tag)
    except ValueError:
        return None
    return tags[index + 1] if index + 1 < len(tags) else None


def commits_between(tag: str, base: str | None) -> list[Commit]:
    revision = f"{base}..{tag}" if base else tag
    output = git(
        "log",
        "--no-merges",
        "--format=%H%x00%s%x00%B%x00",
        revision,
    )
    fields = output.split("\0")
    commits: list[Commit] = []
    for index in range(0, len(fields) - 2, 3):
        commit_hash, subject, body = fields[index : index + 3]
        commit_hash = commit_hash.strip()
        subject = subject.strip()
        if not subject:
            continue
        match = CONVENTIONAL_COMMIT.match(subject)
        if not match:
            commits.append(
                Commit(
                    commit_hash=commit_hash,
                    commit_type="other",
                    scope=None,
                    description=subject,
                    breaking=False,
                )
            )
            continue
        commit_type = match.group("type")
        scope = match.group("scope")
        description = match.group("description").strip()
        if commit_type == "chore" and scope == "release":
            continue
        commits.append(
            Commit(
                commit_hash=commit_hash,
                commit_type=commit_type,
                scope=scope.strip() if scope else None,
                description=description,
                breaking=bool(match.group("breaking") or BREAKING_CHANGE.search(body)),
            )
        )
    return commits


def repository_url() -> str:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repository = os.environ.get("GITHUB_REPOSITORY")
    if repository:
        return f"{server}/{repository}"
    try:
        remote = git("remote", "get-url", "origin").strip()
    except subprocess.CalledProcessError:
        return ""
    if remote.startswith("git@github.com:"):
        remote = f"https://github.com/{remote.removeprefix('git@github.com:')}"
    elif remote.startswith("ssh://git@github.com/"):
        remote = f"https://github.com/{remote.removeprefix('ssh://git@github.com/')}"
    return remote.removesuffix(".git").rstrip("/")


def render(tag: str, base: str | None, commits: list[Commit]) -> str:
    url = repository_url()
    grouped: dict[str, list[Commit]] = defaultdict(list)
    for commit in commits:
        grouped[CATEGORIES.get(commit.commit_type, "Other")].append(commit)

    lines: list[str] = []
    for category in CATEGORY_ORDER:
        category_commits = grouped.get(category)
        if not category_commits:
            continue
        lines.extend([f"## {category}", ""])
        for commit in category_commits:
            prefix = f"**{commit.scope}:** " if commit.scope else ""
            breaking = " **(breaking)**" if commit.breaking else ""
            short_hash = commit.commit_hash[:7]
            link = ""
            if url:
                link = f" ([{short_hash}]({url}/commit/{commit.commit_hash}))"
            lines.append(f"- {prefix}{commit.description}{breaking}{link}")
        lines.append("")

    if not lines:
        lines.extend(["No conventional commits found for this release.", ""])

    if base and url:
        lines.append(f"**Full Changelog**: {url}/compare/{base}...{tag}")
    elif url:
        lines.append(f"**Full Changelog**: {url}/commits/{tag}")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default=os.environ.get("GITHUB_REF_NAME"), required=False)
    args = parser.parse_args()
    if not args.tag:
        parser.error("--tag or GITHUB_REF_NAME is required")

    base = previous_tag(args.tag)
    print(render(args.tag, base, commits_between(args.tag, base)), end="")


if __name__ == "__main__":
    main()
