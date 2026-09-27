from livekit.agents import AgentSession
from test_collection_runtime import ScriptedLLM, Store

from collection_agent import ConfiguredAssistant


async def test_ui_instructions_and_tool_assignments_are_authoritative():
    backend = Store().backend()
    model = ScriptedLLM(["Hello from your configured assistant."])
    agent = ConfiguredAssistant(
        backend=backend,
        instructions="You are a library assistant.",
        enabled_tools=["request_callback"],
    )
    assert agent.instructions == "You are a library assistant."
    assert {tool.id for tool in agent.tools} == {"request_callback"}
    async with AgentSession(llm=model) as session:
        await session.start(agent)
        await session.run(user_input="Hello")
    assert model.seen_tools == [{"request_callback"}]
    await backend.close()


async def test_no_assignment_means_no_tools_even_with_customer():
    backend = Store().backend()
    agent = ConfiguredAssistant(
        backend=backend, instructions="Be concise.", enabled_tools=[]
    )
    assert agent.tools == []
    await backend.close()


async def test_greeting_only_for_agent_initiated_call():
    from agent import start_call_direction

    class Session:
        def __init__(self):
            self.replies = []

        def generate_reply(self, **kwargs):
            self.replies.append(kwargs)

    session = Session()
    await start_call_direction(session, "user_calls_agent")
    assert not session.replies
    await start_call_direction(session, "agent_calls_user")
    assert len(session.replies) == 1
    assert session.replies[0]["tool_choice"] == "none"


async def test_unbound_normal_call_does_not_request_unverifiable_identity():
    model = ScriptedLLM(["Hello from your configured assistant."])
    agent = ConfiguredAssistant(instructions="You are a library assistant.", enabled_tools=["verify_identity", "evaluate_offer"])
    async with AgentSession(llm=model) as session:
        await session.start(agent)
        await session.run(user_input="Hello")
    assert model.seen_tools == [set()]
    assert agent.instructions == "You are a library assistant."
