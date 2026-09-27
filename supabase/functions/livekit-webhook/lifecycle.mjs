const ACTIVE_SESSION_STATUSES = ["connecting", "active"];

/**
 * Convert one verified LiveKit lifecycle event into an idempotent session update.
 * This pure decision function is shared by the Edge Function and its Node tests.
 */
export function getLifecycleUpdate({ eventType, currentStatus, hasStartedAt, occurredAt }) {
  const baseUpdate = { last_livekit_event_at: occurredAt };

  if (eventType === "room_started" || eventType === "participant_joined") {
    return {
      update: {
        ...baseUpdate,
        status: "active",
        ...(hasStartedAt ? {} : { started_at: occurredAt }),
      },
      allowedCurrentStatuses: ACTIVE_SESSION_STATUSES,
    };
  }

  if (eventType === "room_finished") {
    return {
      update: { ...baseUpdate, status: "completed", ended_at: occurredAt },
      allowedCurrentStatuses: ACTIVE_SESSION_STATUSES,
    };
  }

  if (eventType === "participant_connection_aborted" && currentStatus === "connecting") {
    return {
      update: { ...baseUpdate, status: "failed", ended_at: occurredAt },
      allowedCurrentStatuses: ["connecting"],
    };
  }

  return null;
}
