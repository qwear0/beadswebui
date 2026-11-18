#!/usr/bin/env python3
"""Private, durable SQLite queue for Dashboard descriptions.

Runtime state defaults to $XDG_STATE_HOME/bead-me-up-scotty (or
~/.local/state/bead-me-up-scotty). Set BMUS_DASHBOARD_QUEUE_STATE_DIR to an
absolute state base directory; the queue uses its bead-me-up-scotty child. That
app-owned directory is created/restricted to 0700 and the database/WAL files to
0600. Requires Python 3 stdlib sqlite3.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import sys
import time
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 1_048_576
MAX_ADMIT = 200
MAX_STATUS = 200
MAX_OUTSTANDING = 2_000
VISIBLE_RESERVE = 250
MAX_BATCH = 4
MAX_INVITES_PER_CALL = 2
MAX_INVITATIONS = 128
INVITATION_TTL_MS = 30_000
WORKER_DEADLINE_MS = 180_000
LEASE_MARGIN_MS = 30_000
MAX_ACTIVE_PER_ROUTE = 3
AGE_BOOST_MS = 120_000
MALFORMED_LIMIT = 3
MAX_TEXT = 8_000
MAX_PROMPT = 16_000
TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
MAX_TERMINAL_ROWS = 5_000
MAX_RECEIPTS = 4_096
MAX_ATTEMPTS = 4_096
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_PROVIDER = 200
HEX64 = re.compile(r"^[a-f0-9]{64}$")
PROVIDER = re.compile(r"^[A-Za-z0-9_.:/-]{1,200}$")
REF_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,511}$")
SAFE_REASON = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
TOKEN = re.compile(r"^[a-f0-9]{32}$")
EFFORTS = {"low", "medium", "high", "xhigh"}
PRIORITIES = {"retry", "visible", "prefetch"}
OUTCOMES = {
    "result", "obsolete", "source_retry", "malformed", "split", "invalid",
    "route_transient", "route_blocked", "shared_transient", "shared_blocked",
}


class QueueError(Exception):
    def __init__(self, code: str):
        self.code = code


def invalid() -> None:
    raise QueueError("invalid_request")


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def exact_keys(value: Any, required: set[str], optional: set[str] = set()) -> dict[str, Any]:
    if not isinstance(value, dict) or not required.issubset(value) or set(value) - required - optional:
        invalid()
    return value


def safe_string(value: Any, maximum: int, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        invalid()
    if pattern and not pattern.fullmatch(value):
        invalid()
    return value


def safe_reason(value: Any, fallback: str) -> str:
    if value is None:
        return fallback
    if not isinstance(value, str) or not SAFE_REASON.fullmatch(value):
        invalid()
    return value


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def ensure_state_path() -> Path:
    override = os.environ.get("BMUS_DASHBOARD_QUEUE_STATE_DIR")
    if override is not None:
        if not os.path.isabs(override) or "\x00" in override:
            invalid()
        state_home = override
    else:
        state_home = os.environ.get("XDG_STATE_HOME")
        if state_home is None:
            state_home = str(Path.home() / ".local" / "state")
    if not os.path.isabs(state_home) or "\x00" in state_home:
        invalid()
    directory = Path(state_home) / "bead-me-up-scotty"
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise QueueError("queue_unavailable")
        os.chmod(directory, 0o700)
        db_path = directory / "dashboard-queue.sqlite3"
        try:
            info = db_path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise QueueError("queue_unavailable")
            os.chmod(db_path, 0o600)
        except FileNotFoundError:
            pass
        return db_path
    except QueueError:
        raise
    except Exception:
        raise QueueError("queue_unavailable") from None


def connect() -> sqlite3.Connection:
    os.umask(0o077)
    db_path = ensure_state_path()
    try:
        conn: sqlite3.Connection | None = None
        conn = sqlite3.connect(str(db_path), timeout=5.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS queue_items (
                id TEXT PRIMARY KEY,
                ref_id TEXT NOT NULL,
                ref_key TEXT NOT NULL,
                settings_json TEXT NOT NULL,
                priority TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                retry_at INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                malformed_count INTEGER NOT NULL DEFAULT 0,
                single_only INTEGER NOT NULL DEFAULT 0,
                current_token TEXT,
                reason TEXT,
                text TEXT,
                route TEXT,
                model TEXT,
                scope TEXT,
                replayable INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS queue_ready_idx
                ON queue_items(state, retry_at, priority, created_at);
            CREATE INDEX IF NOT EXISTS queue_ref_idx ON queue_items(ref_id, ref_key);
            CREATE TABLE IF NOT EXISTS attempts (
                token TEXT PRIMARY KEY,
                route TEXT NOT NULL,
                deadline_at INTEGER NOT NULL,
                lease_until INTEGER NOT NULL,
                items_json TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                shared_probe INTEGER NOT NULL DEFAULT 0,
                route_probe INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS attempts_active_idx ON attempts(state, lease_until, route);
            CREATE TABLE IF NOT EXISTS invitations (
                id TEXT PRIMARY KEY,
                items_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS invitations_expiry_idx ON invitations(expires_at);
            CREATE TABLE IF NOT EXISTS circuits (
                scope TEXT NOT NULL,
                route TEXT NOT NULL DEFAULT '',
                hard_blocked INTEGER NOT NULL DEFAULT 0,
                open_until INTEGER NOT NULL DEFAULT 0,
                transient_count INTEGER NOT NULL DEFAULT 0,
                probe_required INTEGER NOT NULL DEFAULT 0,
                probe_token TEXT,
                backoff_count INTEGER NOT NULL DEFAULT 0,
                reason TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(scope, route)
            );
            CREATE TABLE IF NOT EXISTS item_route_failures (
                item_id TEXT NOT NULL,
                route TEXT NOT NULL,
                retry_at INTEGER NOT NULL,
                reason TEXT NOT NULL,
                PRIMARY KEY(item_id, route)
            );
            CREATE INDEX IF NOT EXISTS item_route_retry_idx ON item_route_failures(route, retry_at);
            CREATE TABLE IF NOT EXISTS receipts (
                token TEXT PRIMARY KEY,
                payload_hash TEXT NOT NULL,
                completed_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS receipts_age_idx ON receipts(completed_at);
            CREATE TABLE IF NOT EXISTS queue_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        # SQLite creates these with the process umask. Reassert private modes
        # after connection setup in case the DB already existed with loose mode.
        for file in (db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
            try:
                info = file.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                    raise QueueError("queue_unavailable")
                os.chmod(file, 0o600)
            except FileNotFoundError:
                pass
        return conn
    except QueueError:
        if conn is not None:
            conn.close()
        raise
    except Exception:
        if conn is not None:
            conn.close()
        raise QueueError("queue_unavailable") from None


def validate_settings(value: Any) -> dict[str, Any]:
    value = exact_keys(value, {"providers", "reasoningEffort", "prompt"})
    providers = value["providers"]
    if not isinstance(providers, list) or not 1 <= len(providers) <= 2:
        invalid()
    providers = [safe_string(item, MAX_PROVIDER, PROVIDER) for item in providers]
    if len(set(providers)) != len(providers):
        invalid()
    providers.sort()
    effort = value["reasoningEffort"]
    prompt = value["prompt"]
    if not isinstance(effort, str) or effort not in EFFORTS or not isinstance(prompt, str) or not 20 <= len(prompt) <= MAX_PROMPT or "\x00" in prompt:
        invalid()
    return {"providers": providers, "reasoningEffort": effort, "prompt": prompt}


def validate_entry(value: Any) -> dict[str, Any]:
    value = exact_keys(value, {"id", "ref", "settings", "priority"})
    ident = safe_string(value["id"], 64, HEX64)
    ref = exact_keys(value["ref"], {"id", "key"})
    ref_id = safe_string(ref["id"], 512, REF_ID)
    ref_key = safe_string(ref["key"], 64, HEX64)
    settings = validate_settings(value["settings"])
    priority = value["priority"]
    if not isinstance(priority, str) or priority not in PRIORITIES:
        invalid()
    return {
        "id": ident,
        "ref": {"id": ref_id, "key": ref_key},
        "settings": settings,
        "settings_json": canonical(settings),
        "priority": priority,
    }


def validate_input(action: Any, value: Any) -> tuple[str, Any]:
    if not isinstance(action, str):
        invalid()
    if action == "admit":
        value = exact_keys(value, {"entries"}, {"replayIds"})
        entries = value["entries"]
        replay_ids = value.get("replayIds", [])
        if not isinstance(entries, list) or len(entries) > MAX_ADMIT or not isinstance(replay_ids, list) or len(replay_ids) > MAX_ADMIT:
            invalid()
        entries = [validate_entry(entry) for entry in entries]
        if len({entry["id"] for entry in entries}) != len(entries):
            invalid()
        replay_ids = [safe_string(item, 64, HEX64) for item in replay_ids]
        if len(set(replay_ids)) != len(replay_ids):
            invalid()
        return action, {"entries": entries, "replay_ids": set(replay_ids)}
    if action == "status":
        value = exact_keys(value, {"ids"})
        ids = value["ids"]
        if not isinstance(ids, list) or len(ids) > MAX_STATUS:
            invalid()
        ids = [safe_string(item, 64, HEX64) for item in ids]
        if len(set(ids)) != len(ids):
            invalid()
        return action, {"ids": ids}
    if action == "invite":
        exact_keys(value, set())
        return action, {}
    if action == "claim":
        value = exact_keys(value, {"invitation"})
        return action, {"invitation": safe_string(value["invitation"], 32, TOKEN)}
    if action == "resolve":
        value = exact_keys(value, {"token"})
        return action, {"token": safe_string(value["token"], 32, TOKEN)}
    if action == "complete":
        value = exact_keys(value, {"token", "outcomes"})
        token = safe_string(value["token"], 32, TOKEN)
        outcomes = value["outcomes"]
        if not isinstance(outcomes, list) or not 1 <= len(outcomes) <= MAX_BATCH:
            invalid()
        normalized = []
        for outcome in outcomes:
            outcome = exact_keys(outcome, {"id", "kind"}, {"reason", "text", "model", "retryAfterMs"})
            ident = safe_string(outcome["id"], 64, HEX64)
            kind = outcome["kind"]
            if not isinstance(kind, str) or kind not in OUTCOMES:
                invalid()
            reason = safe_reason(outcome.get("reason"), kind)
            text = outcome.get("text")
            model = outcome.get("model")
            retry_after = outcome.get("retryAfterMs", 0)
            if text is not None and (not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or "\x00" in text):
                invalid()
            if kind == "result" and text is None:
                invalid()
            if model is not None:
                model = safe_string(model, MAX_PROVIDER, PROVIDER)
            if (isinstance(retry_after, bool) or not isinstance(retry_after, int)
                    or not 0 <= retry_after <= MAX_SAFE_INTEGER - now_ms()):
                invalid()
            normalized.append({"id": ident, "kind": kind, "reason": reason, "text": text, "model": model, "retry_after": retry_after})
        if len({item["id"] for item in normalized}) != len(normalized):
            invalid()
        return action, {"token": token, "outcomes": normalized}
    if action == "recheck":
        value = exact_keys(value, {"scope"}, {"route"})
        scope = value["scope"]
        route = value.get("route")
        if not isinstance(scope, str) or scope not in {"shared", "route"}:
            invalid()
        if scope == "route":
            route = safe_string(route, MAX_PROVIDER, PROVIDER)
        elif route is not None:
            invalid()
        return action, {"scope": scope, "route": route}
    invalid()


def tx_begin(conn: sqlite3.Connection, write: bool) -> None:
    conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")


def get_circuit(conn: sqlite3.Connection, scope: str, route: str = "") -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM circuits WHERE scope=? AND route=?", (scope, route)).fetchone()


def set_circuit(conn: sqlite3.Connection, scope: str, route: str = "", **fields: Any) -> None:
    current = get_circuit(conn, scope, route)
    values = {
        "hard_blocked": int(current["hard_blocked"]) if current else 0,
        "open_until": int(current["open_until"]) if current else 0,
        "transient_count": int(current["transient_count"]) if current else 0,
        "probe_required": int(current["probe_required"]) if current else 0,
        "probe_token": current["probe_token"] if current else None,
        "backoff_count": int(current["backoff_count"]) if current else 0,
        "reason": current["reason"] if current else None,
        "updated_at": now_ms(),
    }
    values.update(fields)
    conn.execute(
        "INSERT INTO circuits(scope,route,hard_blocked,open_until,transient_count,probe_required,probe_token,backoff_count,reason,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,route) DO UPDATE SET "
        "hard_blocked=excluded.hard_blocked,open_until=excluded.open_until,transient_count=excluded.transient_count," 
        "probe_required=excluded.probe_required,probe_token=excluded.probe_token,backoff_count=excluded.backoff_count," 
        "reason=excluded.reason,updated_at=excluded.updated_at",
        (scope, route, values["hard_blocked"], values["open_until"], values["transient_count"], values["probe_required"],
         values["probe_token"], values["backoff_count"], values["reason"], values["updated_at"]),
    )


def jittered(base_ms: int) -> int:
    spread = max(1, base_ms // 5)
    return max(1, base_ms - spread + secrets.randbelow(spread * 2 + 1))


def item_backoff(retry_count: int) -> int:
    return jittered(min(900_000, 15_000 * (2 ** min(max(retry_count, 0), 6))))


def record_route_transient(conn: sqlite3.Connection, route: str, now: int, retry_after: int = 0) -> tuple[int, bool]:
    current = get_circuit(conn, "route", route)
    count = int(current["transient_count"]) + 1 if current else 1
    backoff_count = int(current["backoff_count"]) if current else 0
    base = min(900_000, 15_000 * (2 ** min(backoff_count, 6)))
    delay = max(jittered(base), retry_after, 60_000 if count >= 2 else 0)
    probe = count >= 2
    set_circuit(conn, "route", route,
                hard_blocked=0, open_until=now + delay, transient_count=count,
                probe_required=int(probe), probe_token=None, backoff_count=min(backoff_count + 1, 6),
                reason="route_transient")
    return now + delay, probe


def record_shared_transient(conn: sqlite3.Connection, now: int, retry_after: int = 0) -> int:
    current = get_circuit(conn, "shared")
    backoff_count = int(current["backoff_count"]) if current else 0
    base = min(900_000, 15_000 * (2 ** min(backoff_count, 6)))
    delay = max(jittered(base), retry_after)
    set_circuit(conn, "shared", "", hard_blocked=0, open_until=now + delay,
                transient_count=(int(current["transient_count"]) + 1 if current else 1),
                probe_required=1, probe_token=None, backoff_count=min(backoff_count + 1, 6),
                reason="shared_transient")
    return now + delay


def prune_metadata(conn: sqlite3.Connection, now: int) -> None:
    conn.execute("DELETE FROM invitations WHERE expires_at<=?", (now,))
    cutoff = now - TERMINAL_RETENTION_MS
    conn.execute("DELETE FROM queue_items WHERE state IN ('failed','obsolete') AND updated_at<?", (cutoff,))
    conn.execute(
        "DELETE FROM queue_items WHERE id IN (SELECT id FROM queue_items WHERE state IN ('failed','obsolete') "
        "ORDER BY updated_at DESC LIMIT -1 OFFSET ?)", (MAX_TERMINAL_ROWS,)
    )
    conn.execute("DELETE FROM item_route_failures WHERE item_id NOT IN (SELECT id FROM queue_items)")
    conn.execute("DELETE FROM receipts WHERE completed_at<?", (cutoff,))
    conn.execute("DELETE FROM receipts WHERE token IN (SELECT token FROM receipts ORDER BY completed_at DESC LIMIT -1 OFFSET ?)", (MAX_RECEIPTS,))
    conn.execute("DELETE FROM attempts WHERE state!='active' AND created_at<?", (cutoff,))
    conn.execute("DELETE FROM attempts WHERE token IN (SELECT token FROM attempts WHERE state!='active' ORDER BY created_at DESC LIMIT -1 OFFSET ?)", (MAX_ATTEMPTS,))
    # Retain circuits referenced by outstanding work; bound idle route history.
    active_routes: set[str] = set()
    for row in conn.execute("SELECT settings_json,route FROM queue_items WHERE state IN ('queued','running')"):
        active_routes.update(json.loads(row["settings_json"])["providers"])
        if row["route"]:
            active_routes.add(row["route"])
    route_circuits = conn.execute("SELECT route FROM circuits WHERE scope='route' AND probe_token IS NULL ORDER BY updated_at ASC").fetchall()
    excess = max(0, len(route_circuits) - 256)
    for circuit in route_circuits:
        if excess == 0:
            break
        if circuit["route"] not in active_routes:
            conn.execute("DELETE FROM circuits WHERE scope='route' AND route=?", (circuit["route"],))
            excess -= 1


def recover_expired_attempts(conn: sqlite3.Connection, now: int) -> None:
    expired = conn.execute("SELECT * FROM attempts WHERE state='active' AND lease_until<=?", (now,)).fetchall()
    for attempt in expired:
        token = attempt["token"]
        route = attempt["route"]
        ids = json.loads(attempt["items_json"])
        retry_at, _ = record_route_transient(conn, route, now)
        for ident in ids:
            row = conn.execute("SELECT * FROM queue_items WHERE id=? AND current_token=? AND state='running'", (ident, token)).fetchone()
            if row is None:
                continue
            retry_count = int(row["retry_count"]) + 1
            conn.execute(
                "UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,retry_count=?,reason='attempt_expired',"
                "route=?,scope='route',updated_at=? WHERE id=? AND current_token=?",
                (retry_count, route, now, ident, token),
            )
            conn.execute(
                "INSERT INTO item_route_failures(item_id,route,retry_at,reason) VALUES(?,?,?,'attempt_expired') "
                "ON CONFLICT(item_id,route) DO UPDATE SET retry_at=excluded.retry_at,reason=excluded.reason",
                (ident, route, retry_at),
            )
        if attempt["shared_probe"]:
            shared = get_circuit(conn, "shared")
            if shared and shared["probe_token"] == token:
                set_circuit(conn, "shared", "", probe_token=None, probe_required=1,
                            open_until=max(int(shared["open_until"]), now + item_backoff(0)), reason="shared_transient")
        route_circuit = get_circuit(conn, "route", route)
        if route_circuit and route_circuit["probe_token"] == token:
            set_circuit(conn, "route", route, probe_token=None, probe_required=1,
                        open_until=max(int(route_circuit["open_until"]), retry_at), reason="route_transient")
        conn.execute("UPDATE attempts SET state='expired' WHERE token=?", (token,))


def queue_row(conn: sqlite3.Connection, ident: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM queue_items WHERE id=?", (ident,)).fetchone()


def active_count(conn: sqlite3.Connection, route: str, now: int) -> int:
    return int(conn.execute("SELECT COUNT(*) FROM attempts WHERE state='active' AND route=? AND lease_until>?", (route, now)).fetchone()[0])


def shared_route_state(conn: sqlite3.Connection, now: int) -> tuple[bool, int, bool, str | None]:
    circuit = get_circuit(conn, "shared")
    if not circuit:
        return True, 0, False, None
    if circuit["hard_blocked"]:
        return False, 0, False, "shared_blocked"
    if int(circuit["open_until"]) > now:
        return False, int(circuit["open_until"]), False, "shared_transient"
    if circuit["probe_required"]:
        if circuit["probe_token"]:
            attempt = conn.execute("SELECT lease_until FROM attempts WHERE token=? AND state='active'", (circuit["probe_token"],)).fetchone()
            return False, int(attempt["lease_until"]) if attempt else now + 1, False, "shared_transient"
        return True, 0, True, "shared_transient"
    return True, 0, False, None


def route_state(conn: sqlite3.Connection, route: str, now: int) -> tuple[bool, int, bool, str | None]:
    circuit = get_circuit(conn, "route", route)
    if not circuit:
        return True, 0, False, None
    if circuit["hard_blocked"]:
        return False, 0, False, "route_blocked"
    if int(circuit["open_until"]) > now:
        return False, int(circuit["open_until"]), False, "route_transient"
    if circuit["probe_required"]:
        if circuit["probe_token"]:
            attempt = conn.execute("SELECT lease_until FROM attempts WHERE token=? AND state='active'", (circuit["probe_token"],)).fetchone()
            return False, int(attempt["lease_until"]) if attempt else now + 1, False, "route_transient"
        return True, 0, True, "route_transient"
    return True, 0, False, None


def route_candidates(conn: sqlite3.Connection, row: sqlite3.Row, now: int, require_slot: bool) -> list[dict[str, Any]]:
    shared_ok, shared_retry, shared_probe, shared_reason = shared_route_state(conn, now)
    if not shared_ok:
        return []
    settings = json.loads(row["settings_json"])
    candidates = []
    for route in settings["providers"]:
        ok, retry_at, probe, reason = route_state(conn, route, now)
        if not ok:
            continue
        failure = conn.execute("SELECT retry_at FROM item_route_failures WHERE item_id=? AND route=?", (row["id"], route)).fetchone()
        if failure and int(failure["retry_at"]) > now:
            continue
        free = MAX_ACTIVE_PER_ROUTE - active_count(conn, route, now)
        if free <= 0 and require_slot:
            continue
        candidates.append({"route": route, "free": free, "route_probe": probe, "shared_probe": shared_probe})
    return candidates


def choose_route(conn: sqlite3.Connection, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not candidates:
        return None
    most_free = max(item["free"] for item in candidates)
    tied = sorted((item for item in candidates if item["free"] == most_free), key=lambda item: item["route"])
    if len(tied) == 1:
        return tied[0]
    meta = conn.execute("SELECT value FROM queue_meta WHERE key='last_tie_route'").fetchone()
    previous = meta[0] if meta else None
    for item in tied:
        if item["route"] > (previous or ""):
            return item
    return tied[0]


def ordered_queued(conn: sqlite3.Connection, now: int, excluded: set[str]) -> list[sqlite3.Row]:
    rows = conn.execute("SELECT * FROM queue_items WHERE state='queued' AND retry_at<=?", (now,)).fetchall()
    def key(row: sqlite3.Row) -> tuple[int, int, int, str]:
        ready_at = max(int(row["created_at"]), int(row["retry_at"]))
        aged = now - ready_at >= AGE_BOOST_MS
        pri = {"retry": 0, "visible": 1, "prefetch": 2}.get(row["priority"], 3)
        return (0 if aged else 1, pri, ready_at, row["id"])
    return [row for row in sorted(rows, key=key) if row["id"] not in excluded]


def make_plan(conn: sqlite3.Connection, now: int, excluded: set[str]) -> tuple[list[sqlite3.Row], str, bool, bool] | None:
    for first in ordered_queued(conn, now, excluded):
        candidates = route_candidates(conn, first, now, True)
        selected = choose_route(conn, candidates)
        if selected is None:
            continue
        batch = [first]
        if not first["single_only"]:
            for row in ordered_queued(conn, now, excluded | {first["id"]}):
                if row["single_only"] or row["settings_json"] != first["settings_json"]:
                    continue
                options = {item["route"]: item for item in route_candidates(conn, row, now, True)}
                if selected["route"] in options:
                    batch.append(row)
                    if len(batch) >= MAX_BATCH:
                        break
        return batch, selected["route"], bool(selected["shared_probe"]), bool(selected["route_probe"])
    return None


def result_item(row: sqlite3.Row, conn: sqlite3.Connection, now: int) -> dict[str, Any]:
    ident = row["id"]
    state = row["state"]
    output: dict[str, Any] = {"id": ident, "state": state}
    if state == "queued":
        retry_at = int(row["retry_at"])
        shared_ok, shared_due, _, shared_reason = shared_route_state(conn, now)
        if not shared_ok and shared_reason == "shared_blocked":
            output.update(state="blocked", reason="shared_blocked", scope="shared")
            return output
        routes = json.loads(row["settings_json"])["providers"]
        options = route_candidates(conn, row, now, False)
        if options:
            if retry_at > now:
                output.update(state="retrying", reason=row["reason"] or "retry_backoff", retryAt=retry_at)
                if row["scope"] in ("shared", "route"):
                    output["scope"] = row["scope"]
            else:
                output["state"] = "waiting"
            return output
        if not shared_ok:
            output.update(state="retrying", reason=shared_reason or "shared_transient", scope="shared", retryAt=max(shared_due, retry_at, now + 1))
            return output
        retry_times: list[int] = []
        transient_routes = 0
        for route in routes:
            circuit = get_circuit(conn, "route", route)
            failure = conn.execute("SELECT retry_at FROM item_route_failures WHERE item_id=? AND route=?", (ident, route)).fetchone()
            if circuit and circuit["hard_blocked"]:
                continue
            transient_routes += 1
            route_due = max(retry_at, now)
            if circuit and int(circuit["open_until"]) > route_due:
                route_due = int(circuit["open_until"])
            if circuit and circuit["probe_required"] and circuit["probe_token"]:
                active = conn.execute("SELECT lease_until FROM attempts WHERE token=? AND state='active'", (circuit["probe_token"],)).fetchone()
                route_due = max(route_due, int(active["lease_until"]) if active else now + 1)
            if failure and int(failure["retry_at"]) > route_due:
                route_due = int(failure["retry_at"])
            retry_times.append(route_due)
        if transient_routes:
            retry_at = min(retry_times) if retry_times else now + 1
            output.update(state="retrying", reason=row["reason"] or "route_transient", scope="route", retryAt=retry_at)
        else:
            output.update(state="blocked", reason="route_blocked", scope="route")
        return output
    if state == "running":
        output["state"] = "running"
        if row["route"]:
            output["route"] = row["route"]
        return output
    if state == "done":
        for name in ("text", "route", "model"):
            if row[name] is not None:
                output[name] = row[name]
        return output
    if row["reason"]:
        output["reason"] = row["reason"]
    if row["route"]:
        output["route"] = row["route"]
    if row["model"]:
        output["model"] = row["model"]
    output["replayable"] = bool(row["replayable"])
    return output


def handle_admit(conn: sqlite3.Connection, data: dict[str, Any], now: int) -> dict[str, Any]:
    replay_ids: set[str] = data["replay_ids"]
    entries_by_id = {entry["id"]: entry for entry in data["entries"]}
    if not replay_ids.issubset(entries_by_id):
        invalid()
    outstanding = int(conn.execute("SELECT COUNT(*) FROM queue_items WHERE state IN ('queued','running')").fetchone()[0])
    nonvisible = int(conn.execute("SELECT COUNT(*) FROM queue_items WHERE state IN ('queued','running') AND priority!='visible'").fetchone()[0])
    for ident in replay_ids:
        row = queue_row(conn, ident)
        entry = entries_by_id[ident]
        if (row and row["state"] == "failed" and row["replayable"]
                and row["ref_id"] == entry["ref"]["id"] and row["ref_key"] == entry["ref"]["key"]
                and row["settings_json"] == entry["settings_json"]
                and outstanding < MAX_OUTSTANDING
                and (row["priority"] == "visible" or nonvisible < MAX_OUTSTANDING - VISIBLE_RESERVE)):
            conn.execute("DELETE FROM item_route_failures WHERE item_id=?", (ident,))
            conn.execute(
                "UPDATE queue_items SET state='queued',priority='retry',created_at=?,updated_at=?,retry_at=0,retry_count=0,malformed_count=0,"
                "single_only=0,current_token=NULL,reason=NULL,text=NULL,route=NULL,model=NULL,scope=NULL,replayable=0 WHERE id=?",
                (now, now, ident),
            )
            outstanding += 1
            if row["priority"] != "visible":
                nonvisible += 1
    response: list[dict[str, Any]] = []
    for entry in data["entries"]:
        ident = entry["id"]
        row = queue_row(conn, ident)
        if row:
            if row["ref_id"] != entry["ref"]["id"] or row["ref_key"] != entry["ref"]["key"] or row["settings_json"] != entry["settings_json"]:
                response.append({"id": ident, "state": "not_accepted", "reason": "id_conflict", "replayable": False})
                continue
            current_priority = row["priority"]
            rank = {"retry": 0, "visible": 1, "prefetch": 2}
            if rank[entry["priority"]] < rank[current_priority]:
                conn.execute("UPDATE queue_items SET priority=?,updated_at=? WHERE id=?", (entry["priority"], now, ident))
                row = queue_row(conn, ident)
            response.append(result_item(row, conn, now))
            continue
        if outstanding >= MAX_OUTSTANDING or (entry["priority"] != "visible" and nonvisible >= MAX_OUTSTANDING - VISIBLE_RESERVE):
            response.append({"id": ident, "state": "not_accepted", "reason": "queue_capacity", "replayable": False})
            continue
        conn.execute(
            "INSERT INTO queue_items(id,ref_id,ref_key,settings_json,priority,state,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)",
            (ident, entry["ref"]["id"], entry["ref"]["key"], entry["settings_json"], entry["priority"], now, now),
        )
        outstanding += 1
        if entry["priority"] != "visible":
            nonvisible += 1
        response.append(result_item(queue_row(conn, ident), conn, now))
    return {"items": response}


def handle_status(conn: sqlite3.Connection, data: dict[str, Any], now: int) -> dict[str, Any]:
    items = []
    for ident in data["ids"]:
        row = queue_row(conn, ident)
        if row:
            items.append(result_item(row, conn, now))
    return {"items": items}


def handle_invite(conn: sqlite3.Connection, now: int) -> dict[str, Any]:
    invitations: list[str] = []
    for _ in range(MAX_INVITES_PER_CALL):
        if int(conn.execute("SELECT COUNT(*) FROM invitations WHERE expires_at>?", (now,)).fetchone()[0]) >= MAX_INVITATIONS:
            break
        covered: set[str] = set()
        for row in conn.execute("SELECT items_json FROM invitations WHERE expires_at>?", (now,)).fetchall():
            covered.update(json.loads(row["items_json"]))
        plan = make_plan(conn, now, covered)
        if plan is None:
            break
        rows, _, _, _ = plan
        invitation = secrets.token_hex(16)
        ids = [row["id"] for row in rows]
        conn.execute("INSERT INTO invitations(id,items_json,created_at,expires_at) VALUES(?,?,?,?)",
                     (invitation, canonical(ids), now, now + INVITATION_TTL_MS))
        invitations.append(invitation)
    return {"invitations": invitations}


def claim_object(conn: sqlite3.Connection, attempt: sqlite3.Row) -> dict[str, Any] | None:
    items = []
    for ident in json.loads(attempt["items_json"]):
        row = queue_row(conn, ident)
        if not row:
            return None
        items.append({"id": ident, "ref": {"id": row["ref_id"], "key": row["ref_key"]}, "settings": json.loads(row["settings_json"])})
    return {"token": attempt["token"], "route": attempt["route"], "deadlineAt": int(attempt["deadline_at"]), "items": items}


def handle_claim(conn: sqlite3.Connection, data: dict[str, Any], now: int) -> dict[str, Any]:
    invitation = conn.execute("SELECT * FROM invitations WHERE id=? AND expires_at>?", (data["invitation"], now)).fetchone()
    if not invitation:
        conn.execute("DELETE FROM invitations WHERE id=?", (data["invitation"],))
        return {"claim": None}
    ids = json.loads(invitation["items_json"])
    rows = [queue_row(conn, ident) for ident in ids]
    if not rows or any(row is None or row["state"] != "queued" or int(row["retry_at"]) > now for row in rows):
        conn.execute("DELETE FROM invitations WHERE id=?", (data["invitation"],))
        return {"claim": None}
    if any(row["settings_json"] != rows[0]["settings_json"] or row["single_only"] for row in rows[1:]) or (rows[0]["single_only"] and len(rows) > 1):
        conn.execute("DELETE FROM invitations WHERE id=?", (data["invitation"],))
        return {"claim": None}
    candidates = {item["route"]: item for item in route_candidates(conn, rows[0], now, True)}
    for row in rows[1:]:
        available = {item["route"] for item in route_candidates(conn, row, now, True)}
        candidates = {route: choice for route, choice in candidates.items() if route in available}
    selected = choose_route(conn, list(candidates.values()))
    if selected is None or selected["route"] not in candidates:
        return {"claim": None}
    # Recheck capacity and circuit probe ownership under BEGIN IMMEDIATE.
    route = selected["route"]
    if active_count(conn, route, now) >= MAX_ACTIVE_PER_ROUTE:
        return {"claim": None}
    shared = get_circuit(conn, "shared")
    route_circuit = get_circuit(conn, "route", route)
    shared_probe = bool(shared and shared["probe_required"])
    route_probe = bool(route_circuit and route_circuit["probe_required"])
    if shared_probe and shared["probe_token"]:
        return {"claim": None}
    if route_probe and route_circuit["probe_token"]:
        return {"claim": None}
    token = secrets.token_hex(16)
    deadline = now + WORKER_DEADLINE_MS
    lease_until = deadline + LEASE_MARGIN_MS
    conn.execute("INSERT INTO attempts(token,route,deadline_at,lease_until,items_json,state,created_at,shared_probe,route_probe) VALUES(?,?,?,?,?,'active',?,?,?)",
                 (token, route, deadline, lease_until, canonical(ids), now, int(shared_probe), int(route_probe)))
    for ident in ids:
        conn.execute("UPDATE queue_items SET state='running',current_token=?,route=?,retry_at=0,reason=NULL,scope=NULL,updated_at=? WHERE id=? AND state='queued'",
                     (token, route, now, ident))
    if shared_probe:
        set_circuit(conn, "shared", "", probe_token=token)
    if route_probe:
        set_circuit(conn, "route", route, probe_token=token)
    if selected["free"] == max(item["free"] for item in candidates.values()) and len([item for item in candidates.values() if item["free"] == selected["free"]]) > 1:
        conn.execute("INSERT INTO queue_meta(key,value) VALUES('last_tie_route',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (route,))
    conn.execute("DELETE FROM invitations WHERE id=?", (data["invitation"],))
    attempt = conn.execute("SELECT * FROM attempts WHERE token=?", (token,)).fetchone()
    return {"claim": claim_object(conn, attempt)}


def handle_resolve(conn: sqlite3.Connection, data: dict[str, Any], now: int) -> dict[str, Any]:
    attempt = conn.execute("SELECT * FROM attempts WHERE token=? AND state='active' AND deadline_at>?", (data["token"], now)).fetchone()
    if not attempt:
        return {"claim": None}
    ids = json.loads(attempt["items_json"])
    for ident in ids:
        row = queue_row(conn, ident)
        if not row or row["state"] != "running" or row["current_token"] != data["token"]:
            return {"claim": None}
    return {"claim": claim_object(conn, attempt)}


def item_retry(conn: sqlite3.Connection, row: sqlite3.Row, now: int, reason: str, hint: int = 0, single_only: bool | None = None) -> None:
    retry_count = int(row["retry_count"]) + 1
    retry_at = now + max(item_backoff(retry_count - 1), hint)
    conn.execute(
        "UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=?,retry_count=?,reason=?,route=NULL,model=NULL,scope=NULL,"
        "single_only=COALESCE(?,single_only),updated_at=? WHERE id=?",
        (retry_at, retry_count, reason, int(single_only) if single_only is not None else None, now, row["id"]),
    )


def handle_complete(conn: sqlite3.Connection, data: dict[str, Any], now: int) -> dict[str, Any]:
    token = data["token"]
    outcomes = data["outcomes"]
    request_hash = hashlib.sha256(canonical(outcomes).encode("utf-8")).hexdigest()
    receipt = conn.execute("SELECT payload_hash FROM receipts WHERE token=?", (token,)).fetchone()
    if receipt:
        return {"status": "committed" if receipt["payload_hash"] == request_hash else "stale"}
    attempt = conn.execute("SELECT * FROM attempts WHERE token=? AND state='active' AND lease_until>=?", (token, now)).fetchone()
    if not attempt:
        return {"status": "stale"}
    ids = json.loads(attempt["items_json"])
    if set(item["id"] for item in outcomes) != set(ids) or len(outcomes) != len(ids):
        return {"status": "stale"}
    rows: dict[str, sqlite3.Row] = {}
    for ident in ids:
        row = queue_row(conn, ident)
        if row is None or row["state"] != "running" or row["current_token"] != token:
            return {"status": "stale"}
        rows[ident] = row
    kinds = {outcome["kind"] for outcome in outcomes}
    route = attempt["route"]
    shared_error = "shared_blocked" in kinds or "shared_transient" in kinds
    route_error = "route_blocked" in kinds or "route_transient" in kinds
    shared_hint = max((item["retry_after"] for item in outcomes if item["kind"] == "shared_transient"), default=0)
    route_hint = max((item["retry_after"] for item in outcomes if item["kind"] == "route_transient"), default=0)
    route_retry_at = 0
    response_kinds = {"result", "malformed", "split", "invalid", "route_transient", "route_blocked"}
    route_response = any(item["kind"] in response_kinds for item in outcomes)
    shared_response = route_response
    if "shared_blocked" in kinds:
        set_circuit(conn, "shared", "", hard_blocked=1, open_until=0, probe_required=0, probe_token=None,
                    reason="shared_blocked", transient_count=0, backoff_count=0)
    elif "shared_transient" in kinds:
        record_shared_transient(conn, now, shared_hint)
    elif attempt["shared_probe"] and shared_response:
        set_circuit(conn, "shared", "", hard_blocked=0, open_until=0, transient_count=0,
                    probe_required=0, probe_token=None, backoff_count=0, reason=None)
    if "route_blocked" in kinds:
        set_circuit(conn, "route", route, hard_blocked=1, open_until=0, probe_required=0, probe_token=None,
                    reason="route_blocked", transient_count=0, backoff_count=0)
    elif "route_transient" in kinds:
        route_retry_at, _ = record_route_transient(conn, route, now, route_hint)
    elif (route_response and not shared_error) or any(item["kind"] == "result" for item in outcomes):
        set_circuit(conn, "route", route, hard_blocked=0, open_until=0, transient_count=0,
                    probe_required=0, probe_token=None, backoff_count=0, reason=None)
    for outcome in outcomes:
        ident = outcome["id"]
        row = rows[ident]
        kind = outcome["kind"]
        reason = outcome["reason"]
        if kind == "result":
            conn.execute("UPDATE queue_items SET state='done',current_token=NULL,retry_at=0,reason=NULL,text=?,route=?,model=?,scope=NULL,replayable=0,updated_at=? WHERE id=? AND current_token=?",
                         (outcome["text"], route, outcome["model"], now, ident, token))
            conn.execute("DELETE FROM item_route_failures WHERE item_id=?", (ident,))
        elif kind == "obsolete":
            conn.execute("UPDATE queue_items SET state='obsolete',current_token=NULL,retry_at=0,reason=?,text=NULL,route=?,model=NULL,scope=NULL,replayable=0,updated_at=? WHERE id=? AND current_token=?",
                         (reason, route, now, ident, token))
            conn.execute("DELETE FROM item_route_failures WHERE item_id=?", (ident,))
        elif kind == "source_retry":
            item_retry(conn, row, now, reason, outcome["retry_after"])
        elif kind == "malformed":
            if len(ids) > 1:
                conn.execute("UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,reason='split_required',single_only=1,route=NULL,model=NULL,scope=NULL,updated_at=? WHERE id=? AND current_token=?",
                             (now, ident, token))
            else:
                malformed_count = int(row["malformed_count"]) + 1
                if malformed_count >= MALFORMED_LIMIT:
                    conn.execute("UPDATE queue_items SET state='failed',priority='retry',current_token=NULL,retry_at=0,malformed_count=?,reason='malformed',route=?,model=NULL,scope=NULL,replayable=1,updated_at=? WHERE id=? AND current_token=?",
                                 (malformed_count, route, now, ident, token))
                else:
                    item_retry(conn, row, now, reason, outcome["retry_after"])
                    conn.execute("UPDATE queue_items SET malformed_count=? WHERE id=?", (malformed_count, ident))
        elif kind == "split":
            if len(ids) > 1:
                conn.execute("UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,reason='split_required',single_only=1,route=NULL,model=NULL,scope=NULL,updated_at=? WHERE id=? AND current_token=?",
                             (now, ident, token))
            else:
                conn.execute("UPDATE queue_items SET state='failed',priority='retry',current_token=NULL,retry_at=0,reason='unsplittable',route=?,replayable=1,updated_at=? WHERE id=? AND current_token=?",
                             (route, now, ident, token))
        elif kind == "invalid":
            conn.execute("UPDATE queue_items SET state='failed',priority='retry',current_token=NULL,retry_at=0,reason=?,route=?,model=NULL,scope=NULL,replayable=1,updated_at=? WHERE id=? AND current_token=?",
                         (reason, route, now, ident, token))
        elif kind in {"route_transient", "route_blocked"}:
            if kind == "route_transient":
                retry_at = now + max(item_backoff(int(row["retry_count"])), outcome["retry_after"], route_retry_at - now)
                retry_count = int(row["retry_count"]) + 1
                conn.execute("UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,retry_count=?,reason=?,route=?,scope='route',updated_at=? WHERE id=? AND current_token=?",
                             (retry_count, reason, route, now, ident, token))
                conn.execute("INSERT INTO item_route_failures(item_id,route,retry_at,reason) VALUES(?,?,?,?) ON CONFLICT(item_id,route) DO UPDATE SET retry_at=excluded.retry_at,reason=excluded.reason",
                             (ident, route, retry_at, reason))
            else:
                conn.execute("UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,reason=?,route=?,scope='route',updated_at=? WHERE id=? AND current_token=?",
                             (reason, route, now, ident, token))
        elif kind in {"shared_transient", "shared_blocked"}:
            if kind == "shared_transient":
                retry_count = int(row["retry_count"]) + 1
                conn.execute("UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,retry_count=?,reason=?,route=?,scope='shared',updated_at=? WHERE id=? AND current_token=?",
                             (retry_count, reason, route, now, ident, token))
            else:
                conn.execute("UPDATE queue_items SET state='queued',priority='retry',current_token=NULL,retry_at=0,reason=?,route=?,scope='shared',updated_at=? WHERE id=? AND current_token=?",
                             (reason, route, now, ident, token))
    # A transient/blocked route result does not consume a shared probe if the
    # shared API itself responded; route-only errors keep the peer selectable.
    shared = get_circuit(conn, "shared")
    if attempt["shared_probe"] and shared and shared["probe_token"] == token and not shared_error:
        set_circuit(conn, "shared", "", probe_token=None)
    circuit = get_circuit(conn, "route", route)
    if circuit and circuit["probe_token"] == token and not route_error:
        set_circuit(conn, "route", route, probe_token=None)
    conn.execute("UPDATE attempts SET state='completed' WHERE token=?", (token,))
    conn.execute("INSERT INTO receipts(token,payload_hash,completed_at) VALUES(?,?,?)", (token, request_hash, now))
    return {"status": "committed"}


def handle_recheck(conn: sqlite3.Connection, data: dict[str, Any], now: int) -> dict[str, Any]:
    scope = data["scope"]
    route = data["route"] or ""
    set_circuit(conn, scope, route, hard_blocked=0, open_until=now, transient_count=0,
                probe_required=1, probe_token=None, backoff_count=0, reason="recheck")
    return {"ok": True}


def dispatch(action: str, raw_input: Any) -> dict[str, Any]:
    action, data = validate_input(action, raw_input)
    conn = connect()
    try:
        now = now_ms()
        write = action not in {"status", "resolve"}
        tx_begin(conn, write)
        if write:
            recover_expired_attempts(conn, now)
            prune_metadata(conn, now)
        if action == "admit":
            result = handle_admit(conn, data, now)
        elif action == "status":
            result = handle_status(conn, data, now)
        elif action == "invite":
            result = handle_invite(conn, now)
        elif action == "claim":
            result = handle_claim(conn, data, now)
        elif action == "resolve":
            result = handle_resolve(conn, data, now)
        elif action == "complete":
            result = handle_complete(conn, data, now)
        elif action == "recheck":
            result = handle_recheck(conn, data, now)
        else:
            invalid()
        if write:
            prune_metadata(conn, now)
        conn.commit()
        return result
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise QueueError("invalid_request")
        request = json.loads(raw.decode("utf-8"))
        request = exact_keys(request, {"action", "input"})
        result = dispatch(request["action"], request["input"])
        output = result
    except QueueError as error:
        output = {"error": error.code}
    except Exception:
        output = {"error": "queue_unavailable"}
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
