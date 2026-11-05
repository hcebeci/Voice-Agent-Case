#!/usr/bin/env python3
"""Summarize exported call latency without printing transcripts or customer IDs."""

import argparse
import csv
import json
import math
import re
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def distribution(values):
    values = sorted(values)
    if not values:
        return {"count": 0, "p50": None, "p95": None, "max": None}
    return {
        "count": len(values),
        "p50": round(statistics.median(values), 3),
        "p95": round(values[math.ceil(0.95 * len(values)) - 1], 3),
        "max": round(values[-1], 3),
    }


def timestamp(value):
    if not value or value == "null":
        return None
    try:
        # PostgreSQL CSV exports use +00; older Python needs +00:00.
        normalized = re.sub(r"([+-]\d{2})$", r"\1:00", value.replace("Z", "+00:00"))
        normalized = re.sub(r"\.(\d{1,6})(?=[+-])", lambda match: "." + match[1].ljust(6, "0"), normalized)
        result = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return result if result.tzinfo is not None else None


def analyze(rows):
    latencies = [n for row in rows if (n := number(row.get("total_latency_ms"))) is not None]
    timestamp_latencies = []
    negative_intervals = 0
    mismatches = 0
    for row in rows:
        stopped = timestamp(row.get("user_speech_stopped_at"))
        audio = timestamp(row.get("agent_first_audio_started_at"))
        if stopped is None or audio is None:
            continue
        elapsed = (audio - stopped).total_seconds() * 1000
        if elapsed < 0:
            negative_intervals += 1
            continue
        timestamp_latencies.append(elapsed)
        stored = number(row.get("total_latency_ms"))
        if stored is not None and abs(stored - elapsed) > 1:
            mismatches += 1
    timing_fields = (
        "user_speech_stopped_at", "transcript_completed_at", "model_started_at",
        "model_first_token_at", "model_completed_at", "response_ready_at",
        "agent_first_audio_started_at",
    )
    return {
        "turn_count": len(rows),
        "session_count": len({row["session_id"] for row in rows if row.get("session_id")}),
        "statuses": dict(Counter(row.get("status") or "unknown" for row in rows)),
        "stored_response_latency_ms": distribution(latencies),
        "missing_or_invalid_stored_latency": len(rows) - len(latencies),
        "stored_latency_over_2000ms": sum(n > 2000 for n in latencies),
        "stored_latency_over_5000ms": sum(n > 5000 for n in latencies),
        "timestamp_response_latency_ms": distribution(timestamp_latencies),
        "negative_timestamp_intervals": negative_intervals,
        "stored_timestamp_mismatches_over_1ms": mismatches,
        "valid_timestamp_counts": {
            field: sum(timestamp(row.get(field)) is not None for row in rows)
            for field in timing_fields
        },
        "turns_with_positive_input_tokens": sum((number(row.get("input_tokens")) or 0) > 0 for row in rows),
        "turns_with_positive_output_tokens": sum((number(row.get("output_tokens")) or 0) > 0 for row in rows),
        "method": "Median p50; nearest-rank p95. Missing/invalid durations excluded, never replaced with zero.",
        "limits": "Historical export, not a controlled before/after test. Missing model timestamps prevent component attribution. Timestamp pairs can include unfinished turns; stored latency is reported separately.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "DATA")
    args = parser.parse_args()
    with (args.data_dir / "session_turns_rows.csv").open(newline="", encoding="utf-8") as source:
        result = analyze(list(csv.DictReader(source)))
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
