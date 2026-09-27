"""Send structured LiveKit session observations to the platform backend.

The worker remains responsible for capturing timestamps close to the audio and
model pipeline. Supabase is responsible for durable storage, retry handling,
and materializing turns, traces, and tool calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
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


@dataclass(slots=True)
class Observation:
    """One ordered observation waiting to be persisted by the sender."""

    event_type: str
    occurred_at: str
    sequence_number: int
    turn_number: int | None
    payload: dict[str, Any]


class ObservabilityClient:
    """Queue and deliver retry-safe observations for one LiveKit session."""

    def __init__(self, session_id: str, supabase_url: str, supabase_secret_key: str) -> None:
        self.session_id = session_id
        self.endpoint = f"{supabase_url.rstrip('/')}/functions/v1/session-observability"
        self._secret_key = supabase_secret_key
        self._sequence_number = 0
        self._last_session_usage_signature: str | None = None
        self._queue: asyncio.Queue[Observation | None] = asyncio.Queue()
        self._client = httpx.AsyncClient(timeout=10.0)
        self._sender_task = asyncio.create_task(self._send_queued_observations())

    def emit_nowait(
        self,
        event_type: str,
        *,
        occurred_at: float | None = None,
        turn_number: int | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        """Queue an observation without blocking LiveKit's event callback."""

        self._sequence_number += 1
        self._queue.put_nowait(
            Observation(
                event_type=event_type,
                occurred_at=timestamp_from_seconds(occurred_at),
                sequence_number=self._sequence_number,
                turn_number=turn_number,
                payload=json_safe(dict(payload or {})),
            )
        )

    def emit_session_usage_if_changed(
        self,
        usage: Any,
        *,
        occurred_at: float | None = None,
        turn_number: int | None = None,
    ) -> bool:
        """Queue a usage snapshot only when its structured contents changed."""

        usage_payload = json_safe(usage)
        signature = json.dumps(usage_payload, sort_keys=True, separators=(",", ":"), default=str)
        if signature == self._last_session_usage_signature:
            return False
        self._last_session_usage_signature = signature
        self.emit_nowait(
            "session.usage",
            occurred_at=occurred_at,
            turn_number=turn_number,
            payload={"usage": usage_payload},
        )
        return True

    async def close(self) -> None:
        """Flush queued observations before closing the HTTP client."""

        await self._queue.join()
        self._queue.put_nowait(None)
        await self._sender_task
        await self._client.aclose()

    async def _send_queued_observations(self) -> None:
        while True:
            observation = await self._queue.get()
            if observation is None:
                self._queue.task_done()
                return

            try:
                await self._send_with_retries(observation)
            except Exception:
                logger.exception("Could not persist observability event %s", observation.event_type)
            finally:
                self._queue.task_done()

    async def _send_with_retries(self, observation: Observation) -> None:
        body = {
            "event_id": str(uuid.uuid4()),
            "session_id": self.session_id,
            "event_type": observation.event_type,
            "occurred_at": observation.occurred_at,
            "turn_number": observation.turn_number,
            "sequence_number": observation.sequence_number,
            "payload": observation.payload,
        }
        headers = {
            "Content-Type": "application/json",
            "apikey": self._secret_key,
        }

        for attempt in range(3):
            try:
                response = await self._client.post(self.endpoint, headers=headers, json=body)
                if response.is_error:
                    response_detail = response.text.replace("\n", " ")[:500]
                    raise httpx.HTTPStatusError(
                        f"Observability endpoint returned {response.status_code}: {response_detail}",
                        request=response.request,
                        response=response,
                    )
                return
            except (httpx.HTTPError, ValueError) as error:
                logger.warning(
                    "Observability event %s failed on attempt %d/3 (%s)",
                    observation.event_type,
                    attempt + 1,
                    error,
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

        turn_number = self.ensure_turn() if event.new_state == "speaking" else self.current_turn_number
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
        closed_at = occurred_at if isinstance(occurred_at, (int, float)) else time.time()
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
                    "metadata": {"speaker": "user", "state": "speaking", "closed_with_session": True},
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
                    "metadata": {"speaker": "agent", "state": "speaking", "closed_with_session": True},
                },
            )
            self.client.emit_nowait("turn.completed", occurred_at=closed_at, turn_number=turn_number)
        else:
            self.client.emit_nowait("turn.cancelled", occurred_at=closed_at, turn_number=turn_number)
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
                "status": "completed" if not getattr(metrics, "cancelled", False) else "failed",
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
            arguments = function_call.arguments
            try:
                arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
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
            status = "tool.failed" if update.status == "error" else "tool.succeeded"
            payload: dict[str, Any] = {
                "tool_call_id": call_id,
                "result": update.message,
                "duration_ms": round(max(0.0, event.created_at - started_at) * 1000),
            }
            if update.status == "error":
                payload["error_message"] = update.message
            self.client.emit_nowait(
                status,
                occurred_at=event.created_at,
                turn_number=self.current_turn_number,
                payload=payload,
            )
