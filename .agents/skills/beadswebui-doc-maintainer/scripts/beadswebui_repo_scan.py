#!/usr/bin/env python3
"""Read-only documentation anchor discovery, adapted from QSD's repo scanner."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

AREAS = ("app", "components", "hooks", "lib", "bin", "scripts")
IGNORE_DIRS = {
    ".git", ".beads", ".dolt", ".codegraph", ".next", "node_modules", "tmp",
    ".venv", "__pycache__", ".cache", ".qo-validation", "worktrees", "out", "build",
}
ROOT_ANCHORS = (
    "package.json", "package-lock.json", "next.config.ts", "Dockerfile", "proxy.ts",
    "instrumentation.ts", "instrumentation-node.ts", "tsconfig.json", "eslint.config.mjs",
)


def inventory(root: Path) -> list[str]:
    paths = []
    for current, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(
            name for name in directories
            if name not in IGNORE_DIRS and not name.startswith(".cache")
        )
        for name in sorted(files):
            paths.append((Path(current) / name).relative_to(root).as_posix())
    return sorted(paths)


def bounded(paths: list[str], limit: int = 20) -> dict:
    return {"total": len(paths), "paths": paths[:limit], "omitted": max(0, len(paths) - limit)}


def build_report(root: Path) -> dict:
    paths = inventory(root)
    return {
        "repo_root": str(root),
        "agent_instructions": bounded([
            p for p in paths if Path(p).name in {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md"}
        ]),
        "local_skills": bounded([
            p for p in paths if p.startswith(".agents/skills/") and p.endswith("/SKILL.md")
        ]),
        "runtime_config": bounded([p for p in ROOT_ANCHORS if p in paths]),
        "current_docs": bounded([p for p in paths if p.startswith("docs/repo/") and p.endswith(".md")]),
        "historical_docs": bounded([
            p for p in paths if p.startswith(("docs/releases/", "docs/superpowers/")) and p.endswith(".md")
        ]),
        "areas": {area: bounded([p for p in paths if p.startswith(area + "/")]) for area in AREAS},
    }


def render_markdown(report: dict) -> str:
    lines = ["# Beadswebui repository scan", "", f"- repo-root: {report['repo_root']}", ""]
    groups = {key: value for key, value in report.items() if key not in {"repo_root", "areas"}}
    groups.update(report["areas"])
    for name, group in groups.items():
        lines.extend([f"## {name.replace('_', ' ')} ({group['total']})", ""])
        lines.extend(f"- path: `{path}`" for path in group["paths"])
        if group["omitted"]:
            lines.append(f"- omitted: {group['omitted']} additional paths")
        if not group["total"]:
            lines.append("- none detected")
        lines.append("")
    lines.extend([
        "## Limits", "",
        "- Paths are navigation candidates, not proof of behavior or ownership.",
        "- Each group is bounded; inspect source and use targeted searches for exhaustive conclusions.",
        "- Dependencies, build output, local tracker data, indexes, and task artifacts are excluded.",
        "- No application, CLI subprocess, test, or network request is executed.",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo_root", nargs="?", default=".")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    args = parser.parse_args()
    root = Path(args.repo_root).resolve()
    if not (root / "package.json").is_file() or not (root / "app").is_dir():
        parser.error("expected the Beadswebui repository root (package.json and app/)")
    report = build_report(root)
    print(json.dumps(report, indent=2) if args.format == "json" else render_markdown(report), end="\n" if args.format == "json" else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
