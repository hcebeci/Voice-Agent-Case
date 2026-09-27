"""Collection business rules. No model input can change identity or policy.

The caller supplies trusted session state, customer data, clock and message evidence.
Transitions are pure; the repository atomically commits state, effects and audit.
"""

from copy import deepcopy
from datetime import date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

POLICY = {
    "version": "collection-demo-v1",
    "minimum_payment_cents": 80000,
    "maximum_extension_days": 14,
    "maximum_verification_attempts": 3,
}
TOOLS = {
    "verify_identity",
    "evaluate_offer",
    "create_payment_commitment",
    "request_callback",
}


def response(tool, state, code, data=None, status="rejected"):
    return {
        "tool_name": tool,
        "status": status,
        "code": code,
        "verified_user": bool(state.get("verified")),
        "data": data or {},
    }


def parse_date(value):
    if not isinstance(value, str):
        raise ValueError("date required")
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("use YYYY-MM-DD")
    return parsed


def account_context(customer, now, policy):
    today = now.astimezone(ZoneInfo(customer["timezone"])).date()
    overdue = (today - parse_date(customer["payment_due_date"])).days
    account = {
        k: customer[k]
        for k in (
            "balance_cents",
            "currency",
            "payment_due_date",
            "timezone",
            "late_interest_cents",
            "credit_reporting_status",
            "account_status",
        )
    }
    account.update(
        days_overdue=max(0, overdue),
        collection_stage=(
            "reminder" if overdue <= 0 else "early" if overdue <= 30 else "medium"
        ),
    )
    return {
        "account": account,
        "policy": dict(
            policy,
            minimum_payment_cents=min(
                customer["balance_cents"], policy["minimum_payment_cents"]
            ),
            latest_payment_date=(
                today + timedelta(days=policy["maximum_extension_days"])
            ).isoformat(),
            partial_payment_settles_account=False,
        ),
    }


def offer_error(customer, policy, amount, payment_date, now):
    context = account_context(customer, now, policy)
    if customer["account_status"] != "open" or customer["balance_cents"] == 0:
        return "NEGOTIATION_NOT_ALLOWED", {}
    minimum = context["policy"]["minimum_payment_cents"]
    if amount < minimum:
        return "BELOW_MINIMUM_PAYMENT", {
            "minimum_payment_cents": minimum,
            "currency": customer["currency"],
        }
    if amount > customer["balance_cents"]:
        return "ABOVE_OUTSTANDING_BALANCE", {"balance_cents": customer["balance_cents"]}
    today = now.astimezone(ZoneInfo(customer["timezone"])).date()
    if parse_date(payment_date) < today:
        return "PAYMENT_DATE_IN_PAST", {}
    if payment_date > context["policy"]["latest_payment_date"]:
        return "PAYMENT_DATE_TOO_LATE", {
            "latest_payment_date": context["policy"]["latest_payment_date"]
        }
    return None


def transition(
    tool, arguments, state, customer, now, *, user_turn_id=None, user_turn_at=None
):
    state = deepcopy(state)
    policy = state.get("policy", POLICY)

    def done(code, data=None, status="rejected", effect=None):
        return state, response(tool, state, code, data, status), effect

    schemas = {
        "verify_identity": {"date_of_birth", "postal_code"},
        "evaluate_offer": {"amount_cents", "payment_date"},
        "create_payment_commitment": {"proposal_id"},
        "request_callback": {"callback_at"},
    }
    if (
        tool not in schemas
        or not isinstance(arguments, dict)
        or set(arguments) != schemas[tool]
    ):
        return done("INVALID_ARGUMENTS")
    try:
        if tool == "verify_identity":
            parse_date(arguments["date_of_birth"])
            postal = arguments["postal_code"]
            if (
                not isinstance(postal, str)
                or len(postal) != 5
                or not postal.isascii()
                or not postal.isdigit()
            ):
                raise ValueError("postal code")
        elif tool == "evaluate_offer":
            parse_date(arguments["payment_date"])
            amount = arguments["amount_cents"]
            if type(amount) is not int or not 0 < amount <= 2147483647:
                raise ValueError("amount")
        elif tool == "create_payment_commitment":
            if (
                not isinstance(arguments["proposal_id"], str)
                or not arguments["proposal_id"]
            ):
                raise ValueError("proposal")
        else:
            callback_at = datetime.fromisoformat(arguments["callback_at"])
            if callback_at.tzinfo is None:
                raise ValueError("timezone required")
    except (ValueError, TypeError, OverflowError):
        return done("INVALID_ARGUMENTS")

    if tool == "verify_identity":
        if state.get("verified") and customer:
            return done(
                "IDENTITY_ALREADY_VERIFIED",
                account_context(customer, now, policy),
                "success",
            )
        if state.get("attempts", 0) >= policy["maximum_verification_attempts"]:
            return done("VERIFICATION_LOCKED")
        if not customer or any(arguments[k] != customer[k] for k in arguments):
            state["attempts"] = state.get("attempts", 0) + 1
            return done(
                "VERIFICATION_LOCKED"
                if state["attempts"] >= policy["maximum_verification_attempts"]
                else "IDENTITY_NOT_VERIFIED"
            )
        state["verified"] = True
        return done(
            "IDENTITY_VERIFIED", account_context(customer, now, policy), "success"
        )

    if tool in {"evaluate_offer", "create_payment_commitment"}:
        if not state.get("verified"):
            return done("IDENTITY_VERIFICATION_REQUIRED")
        if not customer:
            return done("CUSTOMER_CONTEXT_UNAVAILABLE", status="error")

    if tool == "evaluate_offer":
        if state.get("commitments"):
            return done("COMMITMENT_ALREADY_RECORDED")
        error = offer_error(customer, policy, amount, arguments["payment_date"], now)
        if error:
            # A changed, even ineligible offer cannot leave an older approval usable.
            if state.get("proposal") and any(
                state["proposal"].get(k) != v for k, v in arguments.items()
            ):
                state["review"] = None
            return done(*error)
        proposal = state.get("proposal")
        if (
            not proposal
            or any(proposal[k] != arguments[k] for k in arguments)
            or proposal["policy_version"] != policy["version"]
        ):
            proposal = dict(
                arguments,
                proposal_id=str(uuid4()),
                currency=customer["currency"],
                policy_version=policy["version"],
            )
            state["proposal"] = proposal
            state["review"] = None
        return done("OFFER_ELIGIBLE", proposal, "success")

    if tool == "create_payment_commitment":
        proposal_id = arguments["proposal_id"]
        existing = state.get("commitments", {}).get(proposal_id)
        if existing:
            return done("COMMITMENT_ALREADY_EXISTS", existing, "success")
        proposal = state.get("proposal")
        if not proposal:
            return done("PROPOSAL_NOT_AVAILABLE")
        if proposal_id != proposal["proposal_id"]:
            return done("CONFIRMATION_REQUIRED")
        review = state.get("review")
        if (
            not review
            or review["proposal_id"] != proposal_id
            or not user_turn_id
            or user_turn_id == review["user_turn_id"]
            or user_turn_at is None
            or user_turn_at <= review["delivered_at"]
        ):
            return done("CONFIRMATION_REQUIRED")
        if proposal["policy_version"] != policy["version"] or offer_error(
            customer, policy, proposal["amount_cents"], proposal["payment_date"], now
        ):
            state["review"] = None
            return done("PROPOSAL_REVALIDATION_REQUIRED")
        receipt = {
            "commitment_id": str(uuid4()),
            "amount_cents": proposal["amount_cents"],
            "currency": proposal["currency"],
            "payment_date": proposal["payment_date"],
            "payment_collected": False,
        }
        state.setdefault("commitments", {})[proposal_id] = receipt
        state["review"] = None
        return done(
            "COMMITMENT_CREATED",
            receipt,
            "success",
            dict(
                receipt,
                kind="commitment",
                proposal_id=proposal_id,
                confirmation_turn_id=user_turn_id,
                policy_version=policy["version"],
            ),
        )

    if callback_at <= now:
        return done("CALLBACK_TIME_IN_PAST")
    if not customer or not customer.get("phone_e164"):
        return done("CALLBACK_CONTACT_MISSING")
    receipt = {
        "request_id": str(uuid4()),
        "callback_at": callback_at.isoformat(),
        "timezone": customer["timezone"],
        "status": "pending",
    }
    return done(
        "CALLBACK_REQUESTED", receipt, "success", dict(receipt, kind="callback")
    )
