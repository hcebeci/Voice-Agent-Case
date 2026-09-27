"""Four model tools plus a before-response verification guard.

SDK references: /agents/logic/tools/definition and /agents/build/nodes.
"""

import time

from livekit.agents import Agent, RunContext, function_tool, llm

from collection import TOOLS, response


def before_agent_response(chat_ctx, tools, verified):
    """Apply before every inference, including inference after a tool result."""
    context = chat_ctx.copy()
    instruction = (
        "Identity is verified for this session. Use only returned account facts."
        if verified
        else "Identity is NOT verified. Verify using DOB and postal code before discussing account details. "
        "Do not discuss debt, balance, due date, interest or collection stage."
    )
    if not verified and not any(t.id == "verify_identity" for t in tools):
        instruction += " Verification is unavailable: explain that account assistance cannot proceed."
    context.add_message(role="system", content=instruction)
    allowed = (
        tools
        if verified
        else [t for t in tools if t.id in {"verify_identity", "request_callback"}]
    )
    return context, allowed


class ConfiguredAssistant(Agent):
    """The UI owns persona/instructions and the enabled tool set."""

    def __init__(
        self,
        *,
        backend=None,
        instructions="",
        enabled_tools=(),
        language="en",
        **kwargs,
    ):
        self.collection_tools = CollectionTools(backend, language, enabled_tools)
        super().__init__(
            instructions=instructions,
            tools=[
                getattr(self.collection_tools, name)
                for name in self.collection_tools.enabled_tools
            ],
            **kwargs,
        )

    async def llm_node(self, chat_ctx, tools, model_settings):
        runtime = self.collection_tools
        users = [
            item
            for item in chat_ctx.items
            if isinstance(item, llm.ChatMessage) and item.role == "user"
        ]
        if users:
            runtime.user_turn_id, runtime.user_turn_at = (
                users[-1].id,
                users[-1].created_at,
            )
        if runtime.backend is None and runtime.enabled_tools:
            context = chat_ctx.copy()
            context.add_message(role="system", content="No customer account is linked to this call. Follow your configured instructions for general conversation. Account lookup, identity verification and payment actions are unavailable. Do not ask for DOB or postal code because you cannot verify them. Explain the limitation if account assistance is requested; never invent account details or claim an action succeeded.")
            allowed = []
        elif runtime.enabled_tools & {
            "verify_identity",
            "evaluate_offer",
            "create_payment_commitment",
        }:
            context, allowed = before_agent_response(
                chat_ctx, tools, bool(runtime.backend and runtime.backend.verified)
            )
        else:
            context, allowed = chat_ctx, tools
        async for chunk in Agent.default.llm_node(
            self, context, allowed, model_settings
        ):
            yield chunk


class CollectionTools:
    def __init__(self, backend, language, enabled_tools):
        self.backend = backend
        self.language = language
        self.enabled_tools = frozenset(enabled_tools)
        if self.enabled_tools - TOOLS:
            raise ValueError("Unsupported tool execution key")
        self.user_turn_id = None
        self.user_turn_at = None

    async def invoke(self, context, tool, arguments):
        state = self.backend.state if self.backend else {}
        if tool not in self.enabled_tools:
            return response(tool, state, "TOOL_NOT_ENABLED")
        if self.backend is None:
            return response(tool, state, "CUSTOMER_CONTEXT_REQUIRED")
        return await self.backend.execute(
            tool,
            arguments,
            context.function_call.call_id,
            user_turn_id=self.user_turn_id,
            user_turn_at=self.user_turn_at,
        )

    @function_tool()
    async def verify_identity(
        self, context: RunContext, date_of_birth: str, postal_code: str
    ):
        """Verify DOB (YYYY-MM-DD) and five-digit postal code. Never guess answers.
        Failure returns no account data; do not repeat the customer's answers.
        """
        return await self.invoke(
            context,
            "verify_identity",
            {"date_of_birth": date_of_birth, "postal_code": postal_code},
        )

    @function_tool()
    async def evaluate_offer(
        self, context: RunContext, amount_cents: int, payment_date: str
    ):
        """Evaluate USD cents and YYYY-MM-DD date. Use again if the customer changes
        amount or date. This does not commit; runtime speaks eligible terms for review;
        do not repeat that review. Never call create_payment_commitment until a later
        customer message agrees to the exact terms. A promise does not reduce balance.
        """
        result = await self.invoke(
            context,
            "evaluate_offer",
            {"amount_cents": amount_cents, "payment_date": payment_date},
        )
        if result["code"] == "OFFER_ELIGIBLE":
            proposal = result["data"]
            amount = f"{proposal['amount_cents'] / 100:.2f}"
            if self.language == "tr":
                text = f"{proposal['payment_date']} tarihinde {amount} Amerikan doları ödemeyi taahhüt ediyor musunuz? Bu, kalan borcun silinmesi anlamına gelmez."  # noqa: RUF001
            else:
                text = f"Do you confirm a payment commitment of {amount} US dollars on {proposal['payment_date']}? This does not forgive the remaining balance."
            await context.wait_for_playout()
            presented_for = self.user_turn_id
            handle = context.session.say(text, allow_interruptions=True)
            await handle.wait_for_playout()
            if (
                not handle.interrupted
                and handle.exception() is None
                and self.user_turn_id == presented_for
            ):
                await self.backend.execute(
                    "_review_delivered",
                    {
                        "proposal_id": proposal["proposal_id"],
                        "user_turn_id": presented_for,
                        "delivered_at": time.time(),
                    },
                    context.function_call.call_id + ":review",
                )
        return result

    @function_tool()
    async def create_payment_commitment(self, context: RunContext, proposal_id: str):
        """Save only after a later customer message confirms the exact presented
        proposal. A correction, condition, cancellation, or question is not approval.
        """
        context.disallow_interruptions()
        return await self.invoke(
            context, "create_payment_commitment", {"proposal_id": proposal_id}
        )

    @function_tool()
    async def request_callback(self, context: RunContext, callback_at: str):
        """Record a requested future callback at an ISO timestamp with UTC offset.
        Use the registered number; if missing, do not claim a callback was arranged.
        """
        context.disallow_interruptions()
        return await self.invoke(
            context, "request_callback", {"callback_at": callback_at}
        )
