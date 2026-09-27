from datetime import datetime, timezone

import pytest

from collection import transition

NOW = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
CUSTOMER = {
    "id": "customer",
    "date_of_birth": "1988-04-12",
    "postal_code": "34000",
    "balance_cents": 200000,
    "currency": "USD",
    "payment_due_date": "2026-09-15",
    "timezone": "Europe/Istanbul",
    "late_interest_cents": 2500,
    "credit_reporting_status": "not_reported",
    "account_status": "open",
    "phone_e164": None,
}


def run(tool, args, state=None, customer=CUSTOMER, **evidence):
    return transition(tool, args, state or {}, customer, NOW, **evidence)


def test_verification_has_same_empty_result_for_wrong_details_and_missing_customer():
    for customer in (CUSTOMER, None):
        state, result, effect = run(
            "verify_identity",
            {"date_of_birth": "1900-01-01", "postal_code": "00000"},
            customer=customer,
        )
        assert result == {
            "tool_name": "verify_identity",
            "status": "rejected",
            "code": "IDENTITY_NOT_VERIFIED",
            "verified_user": False,
            "data": {},
        }
        assert state["attempts"] == 1
        assert effect is None


def test_correct_verification_and_payment_complete_path():
    state, result, _ = run(
        "verify_identity", {"date_of_birth": "1988-04-12", "postal_code": "34000"}
    )
    assert result["verified_user"] is True
    assert "date_of_birth" not in str(result)
    state, result, _ = run(
        "evaluate_offer", {"amount_cents": 85000, "payment_date": "2026-10-05"}, state
    )
    proposal = result["data"]["proposal_id"]
    state["review"] = {
        "proposal_id": proposal,
        "user_turn_id": "turn1",
        "delivered_at": NOW.timestamp() - 1,
    }
    state, result, effect = run(
        "create_payment_commitment",
        {"proposal_id": proposal},
        state,
        user_turn_id="turn2",
        user_turn_at=NOW.timestamp(),
    )
    assert result["code"] == "COMMITMENT_CREATED"
    assert effect["payment_date"] == "2026-10-05"
    assert effect["amount_cents"] == 85000
    assert CUSTOMER["balance_cents"] == 200000
    _, duplicate, effect = run(
        "create_payment_commitment", {"proposal_id": proposal}, state
    )
    assert duplicate["code"] == "COMMITMENT_ALREADY_EXISTS"
    assert effect is None


@pytest.mark.parametrize(
    "amount,day,code",
    [
        (10, "2026-10-05", "BELOW_MINIMUM_PAYMENT"),
        (200001, "2026-10-05", "ABOVE_OUTSTANDING_BALANCE"),
        (80000, "2026-09-26", "PAYMENT_DATE_IN_PAST"),
        (80000, "2026-10-12", "PAYMENT_DATE_TOO_LATE"),
        (80000, "2026-10-11", "OFFER_ELIGIBLE"),
    ],
)
def test_offer_boundaries(amount, day, code):
    _, result, _ = run(
        "evaluate_offer",
        {"amount_cents": amount, "payment_date": day},
        {"verified": True},
    )
    assert result["code"] == code


def test_guard_and_missing_confirmation():
    _, result, _ = run(
        "evaluate_offer", {"amount_cents": 85000, "payment_date": "2026-10-05"}
    )
    assert result["code"] == "IDENTITY_VERIFICATION_REQUIRED"
    state, result, _ = run(
        "evaluate_offer",
        {"amount_cents": 85000, "payment_date": "2026-10-05"},
        {"verified": True},
    )
    _, result, effect = run(
        "create_payment_commitment",
        {"proposal_id": result["data"]["proposal_id"]},
        state,
        user_turn_id="t2",
        user_turn_at=NOW.timestamp(),
    )
    assert result["code"] == "CONFIRMATION_REQUIRED"
    assert effect is None


def test_changed_terms_invalidate_review_and_same_terms_preserve_it():
    args = {"amount_cents": 85000, "payment_date": "2026-10-05"}
    state, result, _ = run("evaluate_offer", args, {"verified": True})
    old = result["data"]["proposal_id"]
    state["review"] = {"proposal_id": old}
    state, result, _ = run("evaluate_offer", args, state)
    assert result["data"]["proposal_id"] == old
    assert state["review"]
    state, result, _ = run(
        "evaluate_offer", dict(args, payment_date="2026-10-07"), state
    )
    assert result["data"]["proposal_id"] != old
    assert state.get("review") is None
    _, result, _ = run("create_payment_commitment", {"proposal_id": old}, state)
    assert result["code"] == "CONFIRMATION_REQUIRED"


def test_three_failed_attempts_lock_and_invalid_input_does_not_count():
    state, result, _ = run(
        "verify_identity", {"date_of_birth": "bad", "postal_code": "34000"}
    )
    assert result["code"] == "INVALID_ARGUMENTS"
    assert not state.get("attempts")
    for _ in range(3):
        state, result, _ = run(
            "verify_identity",
            {"date_of_birth": "1900-01-01", "postal_code": "00000"},
            state,
        )
    assert result["code"] == "VERIFICATION_LOCKED"
    _, result, _ = run(
        "verify_identity",
        {"date_of_birth": "1988-04-12", "postal_code": "34000"},
        state,
    )
    assert result["code"] == "VERIFICATION_LOCKED"


def test_callback_no_contact_then_valid_request():
    args = {"callback_at": "2026-09-28T14:00:00+03:00"}
    _, result, _ = run("request_callback", args)
    assert result["code"] == "CALLBACK_CONTACT_MISSING"
    _, result, effect = run(
        "request_callback", args, customer=dict(CUSTOMER, phone_e164="+905551234567")
    )
    assert result["code"] == "CALLBACK_REQUESTED"
    assert result["verified_user"] is False
    assert effect["kind"] == "callback"
