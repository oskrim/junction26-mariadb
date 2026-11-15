"""Traces of what the assistants did, on disk, for debugging retrieval and answers in detail.

Each POST request (Ask, Learn, …) is one JSON file under TRACE_DIR/<date>/: the request body, then every event in
order with its time in ms: each SSE event the reader saw (steps, answer pieces, sources), each Gemini call with its
full system prompt, contents and config, its reply, and each search with its ranked results and scores. Searches
made outside a POST request (the search bar) go to TRACE_DIR/<date>/searches.jsonl, one line each.

    ls -t ~/.cache/junction26-wiki/traces/$(date +%F) | head      # the latest requests
    python3 -m json.tool <file> | less

Tracing never breaks a request: any failure to record is swallowed. TRACE_DIR="" turns it off.
"""
import json
import os
import re
import time
from pathlib import Path

DIR = os.environ.get("TRACE_DIR", str(Path("~/.cache/junction26-wiki/traces").expanduser()))
_current = None  # each app worker serves one request at a time


def _today():
    return Path(DIR) / time.strftime("%Y-%m-%d")


def start(path, body=None):
    """Begins a trace for one request; body is its JSON body, if known."""
    global _current
    if not DIR:
        return
    _current = {"path": path, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "t0": time.perf_counter(),
                "request": body, "events": []}


def request_body(body):
    """The request's JSON body, recorded once the handler has parsed it."""
    if _current is not None and _current.get("request") is None:
        _current["request"] = body


def event(kind, **data):
    """One thing that happened, with whatever data helps to understand it later."""
    try:
        if _current is not None:
            _current["events"].append({"t_ms": round((time.perf_counter() - _current["t0"]) * 1000), "kind": kind, **data})
        elif kind == "search" and DIR:
            folder = _today()
            folder.mkdir(parents=True, exist_ok=True)
            with open(folder / "searches.jsonl", "a") as f:
                f.write(json.dumps({"at": time.strftime("%H:%M:%S"), **data}, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass


def finish(status=None):
    """Writes the request's trace file and ends it."""
    global _current
    trace, _current = _current, None
    if trace is None:
        return
    try:
        trace["status"] = status
        trace["total_ms"] = round((time.perf_counter() - trace.pop("t0")) * 1000)
        folder = _today()
        folder.mkdir(parents=True, exist_ok=True)
        prompt = str((trace.get("request") or {}).get("prompt", ""))[:40]
        slug = re.sub(r"[^\w]+", "-", prompt).strip("-").lower() or "request"
        name = f"{time.strftime('%H%M%S')}-{trace['path'].strip('/').replace('/', '-')}-{slug}-{os.getpid()}.json"
        (folder / name).write_text(json.dumps(trace, ensure_ascii=False, indent=1, default=str))
    except Exception:
        pass
