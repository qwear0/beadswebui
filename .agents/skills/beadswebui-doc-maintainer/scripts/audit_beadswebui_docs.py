#!/usr/bin/env python3
"""Read-only Beadswebui doc audit, adapted from the QSD documentation auditor."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit

SKILL_ROOT = Path(".agents/skills/beadswebui-doc-maintainer")
REPO_DIRECTORIES = (
    "docs", "app", "components", "hooks", "lib", "bin", "scripts", "public",
    "design", ".agents", ".github", ".claude", ".codex",
)
ROOT_FILES = {
    "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "README.md", "SECURITY.md",
    "Dockerfile", "package.json", "package-lock.json", "next.config.ts",
    "tsconfig.json", "eslint.config.mjs", "postcss.config.mjs", "proxy.ts",
    "instrumentation.ts", "instrumentation-node.ts", ".gitignore",
}
PATH_TOKEN_RE = re.compile(
    r"(?<![\w./-])(?:" + "|".join(re.escape(p) for p in REPO_DIRECTORIES)
    + r")/[^\s`\"'<>(),;]+"
)
MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
SECTION_RE = re.compile(r"^##\s+(\d+)\.\s+", re.MULTILINE)
BULLET_LABEL_RE = re.compile(r"^\s*[-*+]\s+`?([A-Za-z0-9_-]+)`?:")
MAP_LINE_RE = re.compile(r"^\s*[-*+]\s+doc:\s+`?(docs/[A-Za-z0-9_./-]+\.md)`?\s+-\s+.+$")
ALLOWED_LABELS = {
    "owner", "owner-rule", "reads-after", "entrypoint", "code", "runtime",
    "contract", "doc", "zone", "create-doc-when", "required-fields",
    "update-when", "skip-when", "check", "step", "failure-clue", "absent-path",
}


@dataclass
class Finding:
    level: str
    message: str


def prose_lines(text: str) -> list[tuple[int, str]]:
    """Exclude fenced examples without losing source line numbers."""
    result = []
    fence = ""
    for number, line in enumerate(text.splitlines(), 1):
        marker = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
        if fence:
            if (
                marker
                and marker[1][0] == fence[0]
                and len(marker[1]) >= len(fence)
                and not marker[2].strip()
            ):
                fence = ""
            continue
        if marker:
            fence = marker[1]
            continue
        result.append((number, line))
    return result


def code_spans(line: str) -> tuple[list[tuple[int, int, str]], bool]:
    """Match equal-length delimiters, including literal backticks inside a span."""
    delimiters = list(re.finditer(r"(?<!\\)`+", line))
    spans = []
    index = 0
    while index < len(delimiters):
        opening = delimiters[index]
        closing_index = index + 1
        while closing_index < len(delimiters):
            if delimiters[closing_index][0] == opening[0]:
                break
            closing_index += 1
        if closing_index == len(delimiters):
            return spans, False
        closing = delimiters[closing_index]
        spans.append((opening.start(), closing.end(), line[opening.end():closing.start()]))
        index = closing_index + 1
    return spans, True


def normalize(path: str) -> str:
    return path.strip().strip("`'\"").rstrip(".,:;")


def to_repo_relative(path: str, repo_root: Path) -> str:
    normalized = normalize(path)
    # Mounted files, HTTP endpoints, and template expressions
    # are not repository paths. Never "repair" them by substituting repo folders.
    if (
        not normalized
        or normalized.startswith(("/", "~", "#"))
        or "://" in normalized
        or any(char in normalized for char in " *{}|()'\",<>`=")
    ):
        return ""
    normalized = normalized.split("#", 1)[0].split("?", 1)[0]
    while normalized.startswith("./"):
        normalized = normalized[2:]
    parts = Path(normalized).parts
    if not parts:
        return ""
    # Dependency/build directories are generated locally and may be absent in
    # a clean checkout; their presence is not a documentation freshness check.
    if any(part in {"node_modules", ".venv", ".next", "__pycache__"} for part in parts):
        return ""
    if parts[0] in REPO_DIRECTORIES or normalized in ROOT_FILES:
        return normalized
    if (repo_root / normalized).exists():
        return normalized
    # Unknown slash tokens may be runtime tags; require explicit repo prefixes
    # for missing-path assertions rather than guessing a responsibility area.
    return ""


def path_exists(path: str, repo_root: Path, container_root: Path) -> bool:
    if not path:
        return False
    if Path(path).parts[0] in REPO_DIRECTORIES:
        return (repo_root / path).exists()
    return (repo_root / path).exists() or (container_root / path).exists()


def choose_structure_doc(doc_dir: Path, container: str) -> Path | None:
    preferred = doc_dir / f"{container}_structure.md"
    if preferred.exists():
        return preferred
    return next((p for p in sorted(doc_dir.glob("*structure*.md")) if p.is_file()), None)


def extract_section(text: str, number: int) -> str:
    text = "\n".join(line for _, line in prose_lines(text))
    starts = list(SECTION_RE.finditer(text))
    for index, match in enumerate(starts):
        if int(match[1]) == number:
            end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
            return text[match.end():end]
    return ""


def extract_paths(text: str, repo_root: Path) -> set[str]:
    paths = set()
    for _, line in prose_lines(text):
        # Only the first code span of a negative anchor declares absence.
        # Other references on that line or elsewhere still need verification.
        absent_anchor = bool(re.match(r"^\s*- absent-path:", line))
        line = MARKDOWN_LINK_RE.sub("", line)
        spans, _ = code_spans(line)
        checked_spans = spans[1:] if absent_anchor else spans
        tokens = [content for _, _, content in checked_spans]
        # Do not reinterpret fragments of a code expression as bare paths.
        outside = list(line)
        for start, end, _ in spans:
            outside[start:end] = " " * (end - start)
        tokens.extend(match[0] for match in PATH_TOKEN_RE.finditer("".join(outside)))
        for token in tokens:
            normalized = to_repo_relative(token, repo_root)
            if normalized:
                paths.add(normalized)
    return paths


def audit_sections(text: str, rel_path: str, minimum: int) -> list[Finding]:
    text = "\n".join(line for _, line in prose_lines(text))
    numbers = [int(value) for value in SECTION_RE.findall(text)]
    findings = []
    duplicates = sorted({number for number in numbers if numbers.count(number) > 1})
    if duplicates:
        findings.append(Finding("warn", f"{rel_path}: duplicate numbered sections {duplicates}"))
    missing = sorted(set(range(1, max([minimum, *numbers]) + 1)) - set(numbers))
    if missing:
        findings.append(Finding("warn", f"{rel_path}: missing numbered sections {missing}"))
    if numbers != sorted(numbers):
        findings.append(Finding("warn", f"{rel_path}: numbered sections are out of order"))
    return findings


def audit_markdown_file_content(
    text: str,
    rel_path: str,
    container: str,
    repo_root: Path,
    container_root: Path,
    is_structure_doc: bool = False,
) -> list[Finding]:
    findings = []
    for line_number, line in prose_lines(text):
        location = f"{rel_path}:{line_number}"
        spans, balanced = code_spans(line)
        if not balanced:
            findings.append(Finding("warn", f"{location}: unmatched inline-code backticks"))
        for start, _, content in spans:
            if line.startswith("``", start) and "`" not in content:
                findings.append(Finding("warn", f"{location}: use single backticks unless the code contains literal backticks"))
        if is_structure_doc:
            label = BULLET_LABEL_RE.match(line)
            if label and label[1] not in ALLOWED_LABELS:
                findings.append(Finding("warn", f"{location}: invalid label '{label[1]}'"))

        for link in MARKDOWN_LINK_RE.finditer(line):
            if any(start <= link.start() < end for start, end, _ in spans):
                continue
            try:
                target = urlsplit(link[1])
            except ValueError:
                findings.append(Finding("warn", f"{location}: malformed Markdown link: {link[1]}"))
                continue
            if target.scheme or target.netloc or not target.path:
                continue
            path = unquote(target.path)
            if path.startswith("/"):
                destination = repo_root / path.lstrip("/")
            else:
                destination = (repo_root / rel_path).parent / path
            if not destination.exists():
                findings.append(Finding("warn", f"{location}: Markdown link target does not exist: {link[1]}"))

        cleaned = MARKDOWN_LINK_RE.sub("", line)
        cleaned_spans, _ = code_spans(cleaned)
        for match in PATH_TOKEN_RE.finditer(cleaned):
            if not any(start <= match.start() < end for start, end, _ in cleaned_spans):
                findings.append(Finding("warn", f"{location}: path '{match[0]}' should be wrapped in backticks"))

    for path in sorted(extract_paths(text, repo_root)):
        if not path_exists(path, repo_root, container_root):
            findings.append(Finding("warn", f"{container}: {rel_path}: referenced path does not exist: {path}"))
    return findings


def audit_structure_doc(repo_root: Path, container: str) -> list[Finding]:
    doc_dir = repo_root / "docs" / container
    container_root = repo_root if container == "repo" else repo_root / container
    if not doc_dir.exists() and not container_root.exists():
        return []
    if not doc_dir.exists():
        return [Finding("error", f"{container}: docs directory missing at docs/{container}")]
    structure_doc = choose_structure_doc(doc_dir, container)
    if not structure_doc:
        return [Finding("error", f"{container}: no structure doc found in docs/{container}")]

    text = structure_doc.read_text(encoding="utf-8")
    rel_structure = structure_doc.relative_to(repo_root).as_posix()
    findings = [Finding("ok", f"{container}: structure doc found at {rel_structure}")]
    findings.extend(audit_markdown_file_content(
        text, rel_structure, container, repo_root, container_root, is_structure_doc=True,
    ))
    findings.extend(audit_sections(text, rel_structure, 8))
    line_count = len(text.splitlines())
    if line_count > 260:
        findings.append(Finding("warn", f"{container}: structure doc is long ({line_count} lines) in {rel_structure}"))
    elif line_count < 40:
        findings.append(Finding("warn", f"{container}: structure doc may be too thin ({line_count} lines) in {rel_structure}"))

    map_number = 5
    map_section = extract_section(text, map_number)
    map_paths = set()
    if not map_section.strip():
        findings.append(Finding("warn", f"{container}: section {map_number} documentation map is empty in {rel_structure}"))
    for line in map_section.splitlines():
        if line.strip().startswith("- doc:"):
            match = MAP_LINE_RE.match(line)
            if match:
                map_paths.add(match[1])
            else:
                findings.append(Finding("warn", f"{container}: invalid map format in {rel_structure}: {line.strip()}"))
        elif re.match(r"^\s*[-*+]\s+", line) and ".md" in line and not line.strip().startswith("- contract:"):
            findings.append(Finding("warn", f"{container}: invalid map format in {rel_structure}: {line.strip()}"))

    actual_docs = {p.relative_to(repo_root).as_posix() for p in doc_dir.rglob("*.md") if p.is_file()}
    for path in sorted(actual_docs - map_paths):
        findings.append(Finding("warn", f"{container}: documentation map is missing {path}"))
    for path in sorted(map_paths):
        if not (repo_root / path).is_file():
            findings.append(Finding("warn", f"{container}: documentation map points to missing file {path}"))

    # Audit unmapped docs too; an absent map entry must not hide other defects.
    for path in sorted(actual_docs | map_paths):
        file_path = repo_root / path
        if path == rel_structure or not file_path.is_file():
            continue
        narrow_text = file_path.read_text(encoding="utf-8")
        findings.extend(audit_sections(narrow_text, path, 6))
        findings.extend(audit_markdown_file_content(
            narrow_text, path, container, repo_root, container_root,
        ))
    return findings


def render(findings: list[Finding]) -> str:
    level_order = {"error": 0, "warn": 1, "ok": 2}
    lines = []
    for finding in sorted(findings, key=lambda value: (level_order[value.level], value.message)):
        lines.append(f"[{finding.level.upper()}] {finding.message}")
    return "\n".join(lines) + ("\n" if lines else "")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit Beadswebui documentation without rewriting files.")
    parser.add_argument("repo_root", nargs="?", default=".", help="Repository root (default: current directory)")
    args = parser.parse_args()
    repo_root = Path(args.repo_root).resolve()
    findings = audit_structure_doc(repo_root, "repo")
    skill_root = repo_root / SKILL_ROOT
    if not (skill_root / "SKILL.md").is_file():
        findings.append(Finding("error", f"skill entrypoint missing at {SKILL_ROOT}/SKILL.md"))
    else:
        skill_docs = sorted(skill_root.rglob("*.md"))
        for doc in skill_docs:
            findings.extend(audit_markdown_file_content(
                doc.read_text(encoding="utf-8"), doc.relative_to(repo_root).as_posix(),
                "skill", repo_root, repo_root,
            ))
        findings.append(Finding("ok", f"skill: checked {len(skill_docs)} Markdown files"))
    print(render(findings), end="")
    return int(any(finding.level in {"error", "warn"} for finding in findings))


if __name__ == "__main__":
    raise SystemExit(main())
