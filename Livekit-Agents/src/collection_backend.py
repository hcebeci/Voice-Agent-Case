"""Worker-side backend: bounded requests, idempotency and atomic persistence."""

import asyncio
import logging
import time
from datetime import datetime

import httpx

from collection import response, transition

logger = logging.getLogger(__name__)


class CollectionBackend:
    def __init__(self, session_id, url, secret, *, client=None):
        self.session_id = session_id
        self.verified = False
        self.state = {}
        self.lock = asyncio.Lock()
        self.client = client or httpx.AsyncClient(
            base_url=url.rstrip("/") + "/rest/v1/rpc/",
            headers={"apikey": secret, "Content-Type": "application/json"},
            timeout=httpx.Timeout(4.0),
        )

    async def close(self):
        await self.client.aclose()

    async def rpc(self, name, payload):
        result = await self.client.post(name, json=payload)
        result.raise_for_status()
        return result.json()

    async def snapshot(self, request_id):
        value = await self.rpc(
            "collection_snapshot",
            {"p_session_id": self.session_id, "p_request_id": request_id},
        )
        if value:
            self.state = value["state"]
            self.verified = bool(self.state.get("verified"))
        return value

    async def execute(self, tool, arguments, request_id, **evidence):
        """The request ID and evidence come from the runtime, never tool arguments."""
        async with self.lock:
            write_started = False

            async def operation():
                nonlocal write_started
                for attempt in range(2):
                    try:
                        attempt_started = time.monotonic()
                        logger.info(
                            "collection_attempt_started session=%s request=%s tool=%s attempt=%s",
                            self.session_id,
                            request_id,
                            tool,
                            attempt + 1,
                        )
                        snapshot = await self.snapshot(request_id)
                        if snapshot is None:
                            return response(tool, self.state, "SESSION_NOT_ACTIVE")
                        if snapshot["result"] is not None:
                            return snapshot["result"]
                        if snapshot["session_status"] not in (
                            "connecting",
                            "active",
                        ):
                            new_state, result, effect = (
                                self.state,
                                response(tool, self.state, "SESSION_NOT_ACTIVE"),
                                None,
                            )
                        elif tool == "_review_delivered":
                            new_state = dict(self.state)
                            proposal = new_state.get("proposal")
                            if (
                                not proposal
                                or proposal["proposal_id"] != arguments["proposal_id"]
                            ):
                                return response(
                                    tool, self.state, "PROPOSAL_NOT_AVAILABLE"
                                )
                            new_state["review"] = dict(arguments)
                            result, effect = (
                                response(
                                    tool,
                                    new_state,
                                    "REVIEW_DELIVERED",
                                    status="success",
                                ),
                                None,
                            )
                        else:
                            new_state, result, effect = transition(
                                tool,
                                arguments,
                                self.state,
                                snapshot["customer"],
                                datetime.fromisoformat(snapshot["now"]),
                                **evidence,
                            )
                        new_state["customer_updated_at"] = (
                            snapshot["customer"]["updated_at"]
                            if snapshot["customer"]
                            else None
                        )
                        write_started = True
                        committed = await self.rpc(
                            "collection_commit",
                            {
                                "p_session_id": self.session_id,
                                "p_request_id": request_id,
                                "p_version": snapshot["version"],
                                "p_state": new_state,
                                "p_result": result,
                                "p_effect": effect,
                                "p_arguments": {}
                                if tool == "verify_identity"
                                else arguments,
                            },
                        )
                        if committed.get("conflict"):
                            continue
                        logger.info(
                            "collection_attempt_completed session=%s request=%s tool=%s attempt=%s code=%s duration_ms=%s",
                            self.session_id,
                            request_id,
                            tool,
                            attempt + 1,
                            committed["result"]["code"],
                            round((time.monotonic() - attempt_started) * 1000),
                        )
                        self.state = new_state
                        self.verified = committed["result"]["verified_user"]
                        return committed["result"]
                    except (httpx.TransportError, httpx.HTTPStatusError):
                        # A replay first checks the durable result before attempting a write.
                        logger.warning(
                            "collection_attempt_failed session=%s request=%s tool=%s attempt=%s",
                            self.session_id,
                            request_id,
                            tool,
                            attempt + 1,
                        )
                        if attempt == 0:
                            await asyncio.sleep(0.2)
                # Final lookup reconciles a write whose response was lost.
                snapshot = await self.snapshot(request_id)
                if snapshot and snapshot["result"]:
                    return snapshot["result"]

            try:
                result = await asyncio.wait_for(operation(), timeout=12)
                if result is not None:
                    return result
            except (
                asyncio.TimeoutError,
                httpx.HTTPError,
                ValueError,
                KeyError,
                TypeError,
            ):
                logger.warning(
                    "collection_unresolved session=%s request=%s tool=%s write_started=%s",
                    self.session_id,
                    request_id,
                    tool,
                    write_started,
                )
            return response(
                tool,
                self.state,
                "OUTCOME_UNKNOWN" if write_started else "SERVICE_UNAVAILABLE",
                {"request_id": request_id},
                "error",
            )
