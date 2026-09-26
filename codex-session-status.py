#!/usr/bin/env python3
"""Show the status of live local Codex CLI sessions.

This uses only local, read-only state:

* ``ps`` finds interactive ``codex`` processes.
* ``lsof`` gets each process's current working directory.
* Codex's local SQLite databases identify the corresponding thread and its
  latest turn status.

The on-disk database schema is an implementation detail of Codex, so this
script is deliberately defensive and degrades gracefully when a database or
utility is unavailable.
"""

from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from typing import Any
from urllib.parse import quote


TERMINAL_TURN_STATUSES = {"completed", "failed", "interrupted", "cancelled"}
WAITING_LOG_STALENESS_SECONDS = 8


def run_command(*args: str, timeout: float = 3.0) -> str:
    try:
        result = subprocess.run(
            args,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout


def process_start_time(date_fields: list[str]) -> float | None:
    try:
        return datetime.strptime(" ".join(date_fields), "%a %b %d %H:%M:%S %Y").timestamp()
    except ValueError:
        return None


def is_interactive_codex(command: str) -> bool:
    try:
        argv = shlex.split(command)
    except ValueError:
        argv = command.split()
    if not argv or Path(argv[0]).name != "codex":
        return False

    # app-server, sandbox, and code-mode-host are Codex helpers, not one
    # interactive user session each.
    helper_args = {"app-server", "sandbox", "codex-code-mode-host"}
    return not any(arg in helper_args for arg in argv[1:])


def live_processes() -> list[dict[str, Any]]:
    output = run_command(
        "ps",
        "-axo",
        "user=,pid=,ppid=,stat=,lstart=,command=",
        timeout=5.0,
    )
    current_user = getpass.getuser()
    processes: list[dict[str, Any]] = []

    for line in output.splitlines():
        # user pid ppid stat + five lstart fields + command
        fields = line.split(None, 9)
        if len(fields) != 10 or fields[0] != current_user:
            continue
        command = fields[9]
        if not is_interactive_codex(command):
            continue
        started_at = process_start_time(fields[4:9])
        if started_at is None:
            continue
        pid = int(fields[1])
        cwd = process_cwd(pid)
        processes.append(
            {
                "pid": pid,
                "ppid": int(fields[2]),
                "stat": fields[3],
                "started_at": started_at,
                "cwd": cwd,
                "command": command,
            }
        )

    return sorted(processes, key=lambda process: (process["started_at"], process["pid"]))


def process_cwd(pid: int) -> str | None:
    output = run_command("lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn")
    for line in output.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


def database_path(codex_home: Path, name: str) -> Path:
    exact = codex_home / name
    if exact.is_file():
        return exact

    # Codex has used numbered database filenames. If the number changes,
    # select the highest numbered file with the same database prefix.
    prefix = name.removesuffix(".sqlite").rsplit("_", 1)[0]
    candidates = []
    for path in codex_home.glob(f"{prefix}_*.sqlite"):
        try:
            number = int(path.stem.rsplit("_", 1)[1])
        except (IndexError, ValueError):
            continue
        candidates.append((number, path))
    return max(candidates, default=(0, exact), key=lambda item: item[0])[1]


def read_rows(path: Path, query: str) -> list[sqlite3.Row]:
    if not path.is_file():
        return []
    uri = f"file:{quote(str(path), safe='/')}?mode=ro"
    try:
        with sqlite3.connect(uri, uri=True, timeout=1.0) as connection:
            connection.row_factory = sqlite3.Row
            return list(connection.execute(query))
    except sqlite3.Error:
        return []


def load_threads(codex_home: Path) -> list[dict[str, Any]]:
    rows = read_rows(
        database_path(codex_home, "state_5.sqlite"),
        """
        SELECT id, cwd, created_at, updated_at
        FROM threads
        WHERE archived = 0
        ORDER BY created_at ASC, id ASC
        """,
    )
    return [dict(row) for row in rows]


def load_latest_turns(codex_home: Path) -> dict[str, dict[str, Any]]:
    rows = read_rows(
        database_path(codex_home, "thread_history_1.sqlite"),
        """
        SELECT thread_id, status, started_at, rollout_ordinal
        FROM thread_turns
        ORDER BY thread_id ASC, COALESCE(started_at, 0) ASC, rollout_ordinal ASC
        """,
    )
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = dict(row)
        previous = latest.get(item["thread_id"])
        item_key = (item["started_at"] or 0, item["rollout_ordinal"] or 0)
        previous_key = (
            (previous["started_at"] or 0, previous["rollout_ordinal"] or 0)
            if previous
            else (-1, -1)
        )
        if previous is None or item_key >= previous_key:
            latest[item["thread_id"]] = item
    return latest


def load_recent_logs(codex_home: Path) -> dict[str, list[dict[str, Any]]]:
    cutoff = int(time.time()) - 3600
    rows = read_rows(
        database_path(codex_home, "logs_2.sqlite"),
        f"""
        SELECT thread_id, ts, target, feedback_log_body
        FROM logs
        WHERE thread_id IS NOT NULL AND ts >= {cutoff}
        ORDER BY ts DESC, ts_nanos DESC
        LIMIT 10000
        """,
    )
    recent: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        item = dict(row)
        recent.setdefault(item["thread_id"], []).append(item)
    return recent


def match_thread(
    process: dict[str, Any], threads: list[dict[str, Any]]
) -> dict[str, Any] | None:
    cwd = process["cwd"]
    if not cwd:
        return None
    candidates = [thread for thread in threads if thread["cwd"] == cwd]
    if not candidates:
        return None

    # A newly started process normally creates its thread within seconds, but
    # ``codex resume`` can attach to a much older thread. Prefer the closest
    # creation time when it is near process startup; otherwise use the latest
    # thread that already existed when the process started.
    near = min(candidates, key=lambda thread: abs(thread["created_at"] - process["started_at"]))
    if abs(near["created_at"] - process["started_at"]) <= 120:
        return near

    before = [thread for thread in candidates if thread["created_at"] <= process["started_at"]]
    return max(before, key=lambda thread: thread["created_at"]) if before else near


def waiting_for_input(
    thread_id: str,
    recent_logs: dict[str, list[dict[str, Any]]],
) -> bool:
    """Return true when a live turn appears paused at a user approval prompt.

    Approval requests are held in Codex's live process and are not represented
    as a durable thread item. Just before pausing, however, the runtime logs a
    tool/function-call event. If that is still the latest activity after a
    short quiet period, the process is waiting for the user's decision rather
    than actively working. This intentionally favors ``working`` during the
    first few seconds to avoid flicker while a command is being dispatched.
    """
    logs = recent_logs.get(thread_id, [])
    if not logs:
        return False

    newest = logs[0]
    if time.time() - newest["ts"] < WAITING_LOG_STALENESS_SECONDS:
        return False

    for log in logs:
        body = log["feedback_log_body"] or ""
        if "item_completed" in body or "function_call_output" in body:
            return False
        if (
            'Output item item_type="function_call"' in body
            or 'Output item item_type="custom_tool_call"' in body
            or "op=exec_approval" in body
        ):
            return True
    return False


def status_for(
    process: dict[str, Any],
    thread: dict[str, Any] | None,
    latest_turns: dict[str, dict[str, Any]],
    recent_logs: dict[str, list[dict[str, Any]]],
) -> str:
    # A zombie has exited, even though its parent has not reaped it yet.
    if process["stat"].startswith("Z"):
        return "done"
    if thread is None:
        return "done"
    turn = latest_turns.get(thread["id"])
    if not turn or turn["status"] in TERMINAL_TURN_STATUSES:
        return "done"
    if turn["status"] == "inProgress":
        return (
            "waiting on input"
            if waiting_for_input(thread["id"], recent_logs)
            else "working"
        )
    return "done"


def project_name(cwd: str | None) -> str:
    if not cwd:
        return "?"
    path = Path(cwd)
    return path.name or str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
        help="Codex state directory (default: CODEX_HOME or ~/.codex)",
    )
    parser.add_argument(
        "--full-path",
        action="store_true",
        help="Print the full working directory in addition to the project name",
    )
    args = parser.parse_args()

    threads = load_threads(args.codex_home)
    latest_turns = load_latest_turns(args.codex_home)
    recent_logs = load_recent_logs(args.codex_home)
    processes = live_processes()
    sessions: list[dict[str, Any]] = []
    matched_thread_ids: set[str] = set()

    for process in processes:
        thread = match_thread(process, threads)
        if thread:
            matched_thread_ids.add(thread["id"])
        sessions.append(
            {
                "cwd": process["cwd"],
                "status": status_for(process, thread, latest_turns, recent_logs),
                "pid": process["pid"],
                "thread": thread["id"] if thread else None,
                "started_at": process["started_at"],
                "updated_at": (
                    thread["updated_at"]
                    if thread and thread["updated_at"] is not None
                    else process["started_at"]
                ),
            }
        )

    # An app-server-backed session may not have its own interactive `codex`
    # process. Include any unmatched thread whose latest turn is in progress.
    for thread in threads:
        if thread["id"] in matched_thread_ids:
            continue
        turn = latest_turns.get(thread["id"])
        if turn and turn["status"] == "inProgress":
            sessions.append(
                {
                    "cwd": thread["cwd"],
                    "status": (
                        "waiting on input"
                        if waiting_for_input(thread["id"], recent_logs)
                        else "working"
                    ),
                    "pid": None,
                    "thread": thread["id"],
                    "started_at": thread["created_at"],
                    "updated_at": thread["updated_at"] or thread["created_at"],
                }
            )

    sessions.sort(
        key=lambda session: (
            session["updated_at"] or 0,
            session["started_at"],
            session["pid"] or 0,
        ),
        reverse=True,
    )
    for number, session in enumerate(sessions, start=1):
        name = project_name(session["cwd"])
        suffix = f" pid={session['pid']}" if session["pid"] else " (app-server)"
        if session["thread"]:
            suffix += f" thread={session['thread'][:8]}"
        if args.full_path and session["cwd"]:
            suffix += f" cwd={session['cwd']}"
        print(f"session {name} {number}: {session['status']}{suffix}")

    if not sessions:
        print("No running Codex sessions found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
