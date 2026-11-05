"""Capture session observations and retain unacknowledged events in a disk outbox.

Synthetic assessment transcripts and tool arguments are intentionally complete.
The outbox lives outside the source tree; the backend deduplicates stable event IDs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import time
import uuid
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("agent.observability")


def timestamp_from_seconds(seconds: float | None = None) -> str:
    """Convert a LiveKit UNIX timestamp into an ISO-8601 UTC timestamp."""
    value = time.time() if seconds is None else seconds
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()


def json_safe(value: Any) -> Any:
    """Convert provider objects into JSON-safe values without exposing failures."""
    if is_dataclass(value) and not isinstance(value, type):
        return json_safe(asdict(value))
    if hasattr(value, "model_dump"):
        try:
            return value.model_dump(mode="json")
        except Exception:
            return repr(value)
    if isinstance(value, Mapping):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


class ObservabilityClient:
    """Durable, bounded, at-least-once delivery for a single backend endpoint.

    Event capture commits a small local SQLite transaction before returning. It
    never waits for the network. Endpoint-scoped replay also recovers events from
    earlier worker sessions. Concurrent workers may replay the same event; its ID
    stays unchanged and backend uniqueness makes that safe.
    """

    def __init__(
        self,
        session_id: str,
        supabase_url: str,
        supabase_secret_key: str,
        *,
        spool_dir: str | Path | None = None,
        client: httpx.AsyncClient | None = None,
        max_events: int = 10_000,
        max_bytes: int = 32 * 1024 * 1024,
        shutdown_timeout: float = 3.0,
        retry_interval: float = 5.0,
    ) -> None:
        self.session_id = session_id
        self.endpoint = f"{supabase_url.rstrip('/')}/functions/v1/session-observability"
        self._secret_key = supabase_secret_key
        self._last_session_usage_signature: str | None = None
        self._max_events, self._max_bytes = max_events, max_bytes
        self._shutdown_timeout, self._retry_interval = shutdown_timeout, retry_interval
        self.dropped_events = 0
        self.last_delivery_error: str | None = None
        self._closing = False
        self._close_task: asyncio.Task | None = None
        self._pending_after_close = 0
        self._wake = asyncio.Event()
        self._drained = asyncio.Event()
        if spool_dir is None:
            state_root = Path(
                os.getenv("XDG_STATE_HOME", str(Path.home() / ".local/state"))
            )
            spool_dir = os.getenv(
                "VOICE_AGENT_OBSERVABILITY_SPOOL_DIR",
                str(state_root / "voice-agent-case/observability"),
            )
        directory = Path(spool_dir).expanduser()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        namespace = hashlib.sha256(self.endpoint.encode()).hexdigest()[:24]
        self.spool_path = directory / f"{namespace}.sqlite3"
        # A short busy timeout bounds synchronous callback contention. Failure is
        # explicit instead of silently reverting to an unbounded in-memory queue.
        self._db = sqlite3.connect(self.spool_path, timeout=0.05)
        self.spool_path.chmod(0o600)
        self._db.execute("pragma journal_mode=truncate")
        self._db.execute("pragma synchronous=full")
        self._db.execute(
            "pragma max_page_count=16384"
        )  # 64 MiB at default 4 KiB pages.
        # Capacity checks run in voice callbacks. Keep totals transactionally in
        # SQLite so a delivery outage cannot turn each callback into a spool scan.
        # Triggers cover other worker connections (including older workers), and
        # initialize existing spools once while holding the same write lock.
        with self._db:
            self._db.executescript("""
            begin immediate;
            create table if not exists events (
                event_id text primary key, session_id text not null,
                sequence_number integer not null, body text not null, bytes integer not null
            );
            create table if not exists sequences (
                session_id text primary key, value integer not null
            );
            create table if not exists outbox_usage (
                singleton integer primary key check(singleton=1),
                event_count integer not null, byte_count integer not null
            );
            create trigger if not exists events_usage_insert after insert on events
            begin
                update outbox_usage set event_count=event_count+1,
                    byte_count=byte_count+new.bytes where singleton=1;
            end;
            create trigger if not exists events_usage_delete after delete on events
            begin
                update outbox_usage set event_count=event_count-1,
                    byte_count=byte_count-old.bytes where singleton=1;
            end;
            create trigger if not exists events_usage_update after update of bytes on events
            begin
                update outbox_usage set byte_count=byte_count+new.bytes-old.bytes
                    where singleton=1;
            end;
            """)
            if (
                self._db.execute(
                    "select 1 from outbox_usage where singleton=1"
                ).fetchone()
                is None
            ):
                self._db.execute(
                    "insert into outbox_usage select 1,count(*),coalesce(sum(bytes),0) from events"
                )
        self._client = client or httpx.AsyncClient(timeout=10.0)
        self._sender_task = asyncio.create_task(self._send_queued_observations())
        self._wake.set()

    @property
    def pending_count(self) -> int:
        if self._db is None:
            return self._pending_after_close
        return self._db.execute(
            "select event_count from outbox_usage where singleton=1"
        ).fetchone()[0]

    def emit_nowait(
        self,
        event_type: str,
        *,
        occurred_at: float | None = None,
        turn_number: int | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> bool:
        """Persist without network waiting; return False and log any capture loss."""
        if self._closing:
            self.dropped_events += 1
            logger.error(
                "Observability capture rejected after close session=%s event=%s",
                self.session_id,
                event_type,
            )
            return False
        try:
            with self._db:
                self._db.execute("begin immediate")
                row = self._db.execute(
                    "select value from sequences where session_id=?", (self.session_id,)
                ).fetchone()
                sequence = row[0] + 1 if row else 1
                event_id = str(uuid.uuid4())
                body = json.dumps(
                    {
                        "event_id": event_id,
                        "session_id": self.session_id,
                        "event_type": event_type,
                        "occurred_at": timestamp_from_seconds(occurred_at),
                        "turn_number": turn_number,
                        "sequence_number": sequence,
                        "payload": json_safe(dict(payload or {})),
                    },
                    separators=(",", ":"),
                )
                size = len(body.encode())
                count, used = self._db.execute(
                    "select event_count,byte_count from outbox_usage where singleton=1"
                ).fetchone()
                if count >= self._max_events or used + size > self._max_bytes:
                    raise BufferError("observability outbox full")
                self._db.execute(
                    "insert into events values(?,?,?,?,?)",
                    (
                        event_id,
                        self.session_id,
                        sequence,
                        body,
                        size,
                    ),
                )
                self._db.execute(
                    "insert into sequences values(?,?) on conflict(session_id) do update set value=excluded.value",
                    (self.session_id, sequence),
                )
        except (OSError, sqlite3.Error, BufferError, ValueError, TypeError) as exc:
            self.dropped_events += 1
            self.last_delivery_error = type(exc).__name__
            logger.error(
                "Observability capture failed session=%s event=%s: %s",
                self.session_id,
                event_type,
                "outbox full" if isinstance(exc, BufferError) else type(exc).__name__,
            )
            return False
        self._drained.clear()
        self._wake.set()
        return True

    def emit_session_usage_if_changed(
        self,
        usage: Any,
        *,
        occurred_at: float | None = None,
        turn_number: int | None = None,
    ) -> bool:
        usage_payload = json_safe(usage)
        signature = json.dumps(
            usage_payload, sort_keys=True, separators=(",", ":"), default=str
        )
        if signature == self._last_session_usage_signature:
            return False
        accepted = self.emit_nowait(
            "session.usage",
            occurred_at=occurred_at,
            turn_number=turn_number,
            payload={"usage": usage_payload},
        )
        if accepted is False:
            return False
        self._last_session_usage_signature = signature
        return True

    async def close(self) -> None:
        """Try to drain within a deadline; keep every unacknowledged event on disk."""
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        self._closing = True
        self._wake.set()
        try:
            await asyncio.wait_for(self._drained.wait(), timeout=self._shutdown_timeout)
        except asyncio.TimeoutError:
            self.last_delivery_error = (
                self.last_delivery_error or "shutdown deadline exceeded"
            )
        finally:
            self._sender_task.cancel()
            await asyncio.gather(self._sender_task, return_exceptions=True)
            self._pending_after_close = self.pending_count
            if self._pending_after_close:
                logger.error(
                    "Observability shutdown retained %d pending events for replay spool=%s",
                    self._pending_after_close,
                    self.spool_path,
                )
            await self._client.aclose()
            self._db.close()
            self._db = None

    async def _send_queued_observations(self) -> None:
        while True:
            self._wake.clear()
            try:
                while row := self._db.execute(
                    "select event_id,body from events order by rowid limit 1"
                ).fetchone():
                    await self._send_with_retries(json.loads(row[1]))
                    with self._db:
                        self._db.execute(
                            "delete from events where event_id=?", (row[0],)
                        )
                self._drained.set()
            except (httpx.HTTPError, ValueError, sqlite3.Error) as exc:
                self.last_delivery_error = type(exc).__name__
                logger.error(
                    "Observability delivery pending; retained for replay (%s)",
                    type(exc).__name__,
                )
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self._retry_interval)

    async def _send_with_retries(self, body: dict[str, Any]) -> None:
        headers = {"Content-Type": "application/json", "apikey": self._secret_key}
        for attempt in range(3):
            try:
                response = await self._client.post(
                    self.endpoint, headers=headers, json=body
                )
                response.raise_for_status()
                return
            except (httpx.HTTPError, ValueError) as exc:
                self.last_delivery_error = type(exc).__name__
                # Response bodies and exception text can contain submitted identity
                # data. Keep failure status visible without copying content to logs.
                logger.warning(
                    "Observability event %s failed attempt=%d/3 error=%s",
                    body["event_type"],
                    attempt + 1,
                    type(exc).__name__,
                )
                if attempt == 2:
                    raise
                await asyncio.sleep(0.25 * (attempt + 1))


@dataclass(slots=True)
class TurnTracker:
    """Translate LiveKit state changes into stable conversational turn numbers."""

    client: ObservabilityClient
    current_turn_number: int | None = None
    next_turn_number: int = 1
    active_tool_started_at: dict[str, float] = field(default_factory=dict)
    active_tool_names: dict[str, str] = field(default_factory=dict)
    active_user_speech_started_at: float | None = None
    active_agent_speech_started_at: float | None = None

    def ensure_turn(self) -> int:
        """Return the current turn, creating the next one when necessary."""

        if self.current_turn_number is None:
            self.current_turn_number = self.next_turn_number
            self.next_turn_number += 1
        return self.current_turn_number

    def on_user_state_changed(self, event: Any) -> None:
        """Record the VAD-backed moment when the user stops speaking."""

        turn_number = (
            self.ensure_turn()
            if event.new_state == "speaking"
            else self.current_turn_number
        )
        if event.new_state == "speaking":
            self.active_user_speech_started_at = event.created_at
        if event.old_state == "speaking" and event.new_state != "speaking":
            turn_number = self.ensure_turn()
            started_at = self.active_user_speech_started_at or event.created_at
            duration_ms = round(max(0.0, event.created_at - started_at) * 1000)
            self.client.emit_nowait(
                "turn.user_speech_stopped",
                occurred_at=event.created_at,
                turn_number=turn_number,
            )
            self.client.emit_nowait(
                "trace.user_speaking",
                occurred_at=event.created_at,
                turn_number=turn_number,
                payload={
                    "started_at": timestamp_from_seconds(started_at),
                    "ended_at": timestamp_from_seconds(event.created_at),
                    "duration_ms": duration_ms,
                    "status": "completed",
                    "metadata": {"speaker": "user", "state": "speaking"},
                },
            )
            self.active_user_speech_started_at = None

    def on_user_transcript(self, event: Any) -> None:
        """Persist only the final STT transcript, ignoring partial hypotheses."""

        if not event.is_final or not event.transcript.strip():
            return
        turn_number = self.ensure_turn()
        self.client.emit_nowait(
            "turn.transcript_completed",
            occurred_at=event.created_at,
            turn_number=turn_number,
            payload={"transcript": event.transcript, "language": event.language},
        )

    def on_conversation_item(self, event: Any) -> None:
        """Store the final assistant message when it enters conversation history."""

        item = event.item
        if getattr(item, "role", None) != "assistant":
            return
        transcript = item.text_content or ""
        if not transcript.strip():
            return
        turn_number = self.ensure_turn()
        self.client.emit_nowait(
            "turn.response_ready",
            occurred_at=event.created_at,
            turn_number=turn_number,
            payload={"transcript": transcript, "metrics": json_safe(item.metrics)},
        )

    def on_agent_state_changed(self, event: Any) -> None:
        """Use the agent speaking state as the first-audio timing boundary."""

        if event.new_state == "speaking":
            turn_number = self.ensure_turn()
            self.active_agent_speech_started_at = event.created_at
            self.client.emit_nowait(
                "turn.agent_audio_started",
                occurred_at=event.created_at,
                turn_number=turn_number,
            )
        elif event.old_state == "speaking" and event.new_state != "speaking":
            if self.current_turn_number is None:
                return
            started_at = self.active_agent_speech_started_at or event.created_at
            duration_ms = round(max(0.0, event.created_at - started_at) * 1000)
            self.client.emit_nowait(
                "trace.agent_speaking",
                occurred_at=event.created_at,
                turn_number=self.current_turn_number,
                payload={
                    "started_at": timestamp_from_seconds(started_at),
                    "ended_at": timestamp_from_seconds(event.created_at),
                    "duration_ms": duration_ms,
                    "status": "completed",
                    "metadata": {"speaker": "agent", "state": "speaking"},
                },
            )
            self.client.emit_nowait(
                "turn.completed",
                occurred_at=event.created_at,
                turn_number=self.current_turn_number,
            )
            self.current_turn_number = None
            self.active_agent_speech_started_at = None

    def on_session_close(self, occurred_at: float | None = None) -> None:
        """Close the final turn when the room ends before a normal state transition."""

        if self.current_turn_number is None:
            return
        closed_at = (
            occurred_at if isinstance(occurred_at, (int, float)) else time.time()
        )
        turn_number = self.current_turn_number
        if self.active_user_speech_started_at is not None:
            started_at = self.active_user_speech_started_at
            duration_ms = round(max(0.0, closed_at - started_at) * 1000)
            self.client.emit_nowait(
                "turn.user_speech_stopped",
                occurred_at=closed_at,
                turn_number=turn_number,
            )
            self.client.emit_nowait(
                "trace.user_speaking",
                occurred_at=closed_at,
                turn_number=turn_number,
                payload={
                    "started_at": timestamp_from_seconds(started_at),
                    "ended_at": timestamp_from_seconds(closed_at),
                    "duration_ms": duration_ms,
                    "status": "completed",
                    "metadata": {
                        "speaker": "user",
                        "state": "speaking",
                        "closed_with_session": True,
                    },
                },
            )
            self.active_user_speech_started_at = None
        if self.active_agent_speech_started_at is not None:
            started_at = self.active_agent_speech_started_at
            duration_ms = round(max(0.0, closed_at - started_at) * 1000)
            self.client.emit_nowait(
                "trace.agent_speaking",
                occurred_at=closed_at,
                turn_number=turn_number,
                payload={
                    "started_at": timestamp_from_seconds(started_at),
                    "ended_at": timestamp_from_seconds(closed_at),
                    "duration_ms": duration_ms,
                    "status": "completed",
                    "metadata": {
                        "speaker": "agent",
                        "state": "speaking",
                        "closed_with_session": True,
                    },
                },
            )
            self.client.emit_nowait(
                "turn.completed", occurred_at=closed_at, turn_number=turn_number
            )
        else:
            self.client.emit_nowait(
                "turn.cancelled", occurred_at=closed_at, turn_number=turn_number
            )
        self.current_turn_number = None
        self.active_agent_speech_started_at = None
        self.active_user_speech_started_at = None

    def on_component_metrics(self, component_name: str, metrics: Any) -> None:
        """Persist provider timing metrics as a completed waterfall span."""

        turn_number = self.current_turn_number
        timestamp = float(getattr(metrics, "timestamp", time.time()))
        duration_seconds = max(0.0, float(getattr(metrics, "duration", 0.0)))
        self.client.emit_nowait(
            f"trace.{component_name}",
            occurred_at=timestamp,
            turn_number=turn_number,
            payload={
                "trace_id": str(uuid.uuid4()),
                "started_at": timestamp_from_seconds(timestamp - duration_seconds),
                "ended_at": timestamp_from_seconds(timestamp),
                "duration_ms": round(duration_seconds * 1000),
                "status": "completed"
                if not getattr(metrics, "cancelled", False)
                else "failed",
                "metadata": json_safe(metrics),
            },
        )

    def on_tool_update(self, event: Any) -> None:
        """Record backend tool start and terminal events with their duration."""

        update = event.update
        update_type = getattr(update, "type", "")
        if update_type == "tool_call_started":
            function_call = update.function_call
            call_id = function_call.call_id
            self.active_tool_started_at[call_id] = event.created_at
            self.active_tool_names[call_id] = function_call.name
            arguments = function_call.arguments
            try:
                arguments = (
                    json.loads(arguments) if isinstance(arguments, str) else arguments
                )
            except json.JSONDecodeError:
                arguments = {"raw": arguments}
            self.client.emit_nowait(
                "tool.started",
                occurred_at=event.created_at,
                turn_number=self.current_turn_number,
                payload={
                    "tool_call_id": call_id,
                    "tool_name": function_call.name,
                    "arguments": arguments,
                },
            )
        elif update_type == "tool_call_ended":
            call_id = update.call_id
            started_at = self.active_tool_started_at.pop(call_id, event.created_at)
            tool_name = self.active_tool_names.pop(call_id, "unknown")
            failed = update.status == "error"
            try:
                structured_result = (
                    json.loads(update.message)
                    if isinstance(update.message, str)
                    else update.message
                )
                if (
                    isinstance(structured_result, dict)
                    and structured_result.get("status") == "error"
                ):
                    failed = True
            except (json.JSONDecodeError, TypeError):
                pass
            status = "tool.failed" if failed else "tool.succeeded"
            payload: dict[str, Any] = {
                "tool_call_id": call_id,
                "tool_name": tool_name,
                "result": update.message,
                "duration_ms": round(max(0.0, event.created_at - started_at) * 1000),
            }
            if failed:
                payload["error_message"] = update.message
            self.client.emit_nowait(
                status,
                occurred_at=event.created_at,
                turn_number=self.current_turn_number,
                payload=payload,
            )
