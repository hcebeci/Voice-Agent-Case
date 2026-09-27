import assert from "node:assert/strict";
import test from "node:test";
import { getLifecycleUpdate } from "./lifecycle.mjs";

const occurredAt = "2026-09-27T12:00:00.000Z";

test("room start activates a connecting session and records its start", () => {
  assert.deepEqual(
    getLifecycleUpdate({
      eventType: "room_started",
      currentStatus: "connecting",
      hasStartedAt: false,
      occurredAt,
    }),
    {
      update: { last_livekit_event_at: occurredAt, status: "active", started_at: occurredAt },
      allowedCurrentStatuses: ["connecting", "active"],
    },
  );
});

test("room finish completes an active session", () => {
  assert.deepEqual(
    getLifecycleUpdate({
      eventType: "room_finished",
      currentStatus: "active",
      hasStartedAt: true,
      occurredAt,
    }),
    {
      update: { last_livekit_event_at: occurredAt, status: "completed", ended_at: occurredAt },
      allowedCurrentStatuses: ["connecting", "active"],
    },
  );
});

test("an aborted connection only fails a session still connecting", () => {
  assert.equal(
    getLifecycleUpdate({
      eventType: "participant_connection_aborted",
      currentStatus: "active",
      hasStartedAt: true,
      occurredAt,
    }),
    null,
  );
  assert.deepEqual(
    getLifecycleUpdate({
      eventType: "participant_connection_aborted",
      currentStatus: "connecting",
      hasStartedAt: false,
      occurredAt,
    }),
    {
      update: { last_livekit_event_at: occurredAt, status: "failed", ended_at: occurredAt },
      allowedCurrentStatuses: ["connecting"],
    },
  );
});

test("unknown events only advance the lifecycle timestamp", () => {
  assert.equal(
    getLifecycleUpdate({
      eventType: "track_published",
      currentStatus: "active",
      hasStartedAt: true,
      occurredAt,
    }),
    null,
  );
});
