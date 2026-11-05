from datetime import datetime, timezone

from test_collection import CUSTOMER

from collection import transition

NOW = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
CUSTOMER_WITH_PHONE = dict(CUSTOMER, phone_e164="+905551234567")


def callback(state, turn="user-1", at="2026-09-28T14:00:00+03:00"):
    return transition(
        "request_callback",
        {"callback_at": at},
        state,
        CUSTOMER_WITH_PHONE,
        NOW,
        user_turn_id=turn,
    )


def test_callback_retry_with_regenerated_call_id_reuses_durable_user_action():
    state, one, effect = callback({})
    state, two, replay_effect = callback(state)
    assert one == two
    assert effect["operation_id"]
    assert replay_effect is None


def test_callback_equivalent_timezones_are_same_action():
    state, one, _ = callback({})
    _, two, effect = callback(state, at="2026-09-28T11:00:00+00:00")
    assert one == two
    assert effect is None


def test_callback_later_user_message_is_new_intent_even_at_same_time():
    state, one, _ = callback({})
    _, two, effect = callback(state, turn="user-2")
    assert one["data"]["request_id"] != two["data"]["request_id"]
    assert effect is not None


def test_callback_requires_runtime_user_evidence():
    _, result, effect = callback({}, turn=None)
    assert result["code"] == "USER_MESSAGE_REQUIRED"
    assert effect is None


def test_callback_changed_time_is_distinct_action():
    state, one, _ = callback({})
    _, two, effect = callback(state, at="2026-09-28T15:00:00+03:00")
    assert one["data"]["request_id"] != two["data"]["request_id"]
    assert effect is not None
