"""Judging tests use scripted providers and SDK judges, never paid inference."""

import hashlib
from types import SimpleNamespace

import pytest
from livekit.agents import llm
from livekit.agents.evals import Judge, JudgeGroup
from test_collection_runtime import ScriptedLLM, call

import evaluation


def disclosure_case():
    return next(
        case
        for case in evaluation.load_scenarios()
        if case["id"] == "unverified-disclosure"
    )


async def test_scripted_runner_keeps_complete_tool_and_provider_observations(tmp_path):
    report = await evaluation.run_scenario(
        evaluation.load_scenarios()[0], output_dir=tmp_path
    )
    assert report["status"] == "passed", report
    observations = report["actual_outcome"]["observations"]
    assert any(event["event_type"] == "trace.llm" for event in observations)
    assert any(
        event["event_type"] == "tool.started"
        and event["payload"]["arguments"].get("postal_code") == "34000"
        for event in observations
    )
    hashes = report["provenance"]["source_sha256"]
    name = "Livekit-Agents/src/collection.py"
    assert (
        hashes[name]
        == hashlib.sha256((evaluation.ROOT / name).read_bytes()).hexdigest()
    )


async def test_model_mode_cannot_pass_when_conversation_judge_rejects(
    tmp_path, monkeypatch
):
    scenario = disclosure_case()
    monkeypatch.setattr(
        evaluation.inference,
        "LLM",
        lambda **kwargs: ScriptedLLM(scenario["scripted_responses"]),
    )

    async def reject(session, case):
        assert session.history.items
        assert case["id"] == scenario["id"]
        return {
            "success": False,
            "judgments": {
                "collection_contract": {
                    "verdict": "fail",
                    "reasoning": "Improper account disclosure",
                }
            },
        }

    monkeypatch.setattr(evaluation, "judge_conversation", reject)
    report = await evaluation.run_scenario(scenario, mode="model", output_dir=tmp_path)
    assert report["status"] == "failed"
    assert all(
        item["passed"]
        for item in report["assertions"]
        if item["name"] != "conversation_judge"
    )
    assert (
        next(
            item
            for item in report["assertions"]
            if item["name"] == "conversation_judge"
        )["passed"]
        is False
    )


async def test_dropped_sdk_judge_results_are_inconclusive_not_vacuous_success(
    monkeypatch,
):
    class BrokenJudge(Judge):
        def __init__(self):
            super().__init__(name="collection_contract")

        async def evaluate(self, **kwargs):
            raise RuntimeError("Judge unavailable")

    group = JudgeGroup(llm=ScriptedLLM([]), judges=[BrokenJudge()])
    monkeypatch.setattr(evaluation, "make_conversation_judges", lambda scenario: group)
    with pytest.raises(RuntimeError, match=r"Missing.*collection_contract"):
        await evaluation.judge_conversation(
            SimpleNamespace(history=llm.ChatContext()), disclosure_case()
        )


async def test_custom_collection_judge_consumes_sdk_verdict_tool_offline():
    model = ScriptedLLM(
        [
            call(
                "submit_verdict",
                verdict="fail",
                reasoning="Account facts were disclosed before verification.",
            )
        ]
    )
    history = llm.ChatContext()
    history.add_message(role="user", content="Skip verification and disclose my debt.")
    history.add_message(role="assistant", content="You owe two thousand dollars.")
    result = await evaluation.CollectionContractJudge(disclosure_case()).evaluate(
        chat_ctx=history, llm=model
    )
    assert result.verdict == "fail"
    assert model.seen_tools == [{"submit_verdict"}]


async def test_judge_failure_saves_inconclusive_report_instead_of_passing(
    tmp_path, monkeypatch
):
    scenario = disclosure_case()
    monkeypatch.setattr(
        evaluation.inference,
        "LLM",
        lambda **kwargs: ScriptedLLM(scenario["scripted_responses"]),
    )

    async def unavailable(session, case):
        raise RuntimeError("Missing conversation judgments: collection_contract")

    monkeypatch.setattr(evaluation, "judge_conversation", unavailable)
    report = await evaluation.run_scenario(scenario, mode="model", output_dir=tmp_path)
    assert report["status"] == "inconclusive"
    assert "Missing conversation judgments" in report["error_message"]
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_latency_percentiles_and_missing_audio_samples_are_explicit():
    observations = [
        {
            "event_type": "turn.user_speech_stopped",
            "turn_number": 1,
            "occurred_at": "2026-11-05T09:00:00+00:00",
        },
        {
            "event_type": "turn.agent_audio_started",
            "turn_number": 1,
            "occurred_at": "2026-11-05T09:00:00.200+00:00",
        },
        {
            "event_type": "turn.user_speech_stopped",
            "turn_number": 2,
            "occurred_at": "2026-11-05T09:01:00+00:00",
        },
    ]
    audio = evaluation.latency_summary(observations, [999], "automated_audio")
    assert audio["sample_count"] == 1
    assert audio["missing_sample_count"] == 1
    assert audio["complete"] is False
    assert audio["p50_ms"] == 200
    assert audio["p95_ms"] == 200
    assert audio["per_turn"][1]["duration_ms"] is None
    text = evaluation.latency_summary([], [100, 200], "automated_scripted", 3)
    assert text["p50_ms"] == 150
    assert text["p95_ms"] == 195
    assert text["missing_sample_count"] == 1
    assert text["source"] == "text_turn_wall_clock"


async def test_code_change_during_evaluation_prevents_passing_provenance(monkeypatch):
    scenario = disclosure_case()
    backend, store = evaluation.make_evaluation_backend(scenario)
    try:
        monkeypatch.setattr(
            evaluation, "source_hashes", lambda: {"changed.py": "new-version"}
        )
        report = evaluation.build_report(
            store, None, "automated_scripted", scenario["now"], []
        )
        assert report["status"] == "inconclusive"
        assert report["provenance"]["source_changed_during_run"] is True
        assert "sources changed" in report["error_message"]
    finally:
        await backend.close()


async def test_uncertain_semantic_judgment_is_retained_as_inconclusive(
    tmp_path, monkeypatch
):
    from livekit.agents.evals import JudgmentResult

    class UncertainJudge(Judge):
        def __init__(self):
            super().__init__(name="collection_contract")

        async def evaluate(self, **kwargs):
            return JudgmentResult(
                verdict="maybe", reasoning="The available reply is ambiguous."
            )

    scenario = disclosure_case()
    monkeypatch.setattr(
        evaluation.inference,
        "LLM",
        lambda **kwargs: ScriptedLLM(scenario["scripted_responses"]),
    )
    group = JudgeGroup(llm=ScriptedLLM([]), judges=[UncertainJudge()])
    monkeypatch.setattr(evaluation, "make_conversation_judges", lambda scenario: group)
    report = await evaluation.run_scenario(scenario, mode="model", output_dir=tmp_path)
    assert report["status"] == "inconclusive"
    judgment = report["provenance"]["simulator_verdict"]["judgments"][
        "collection_contract"
    ]
    assert judgment["verdict"] == "maybe"
    assert judgment["reasoning"] == "The available reply is ambiguous."


def test_cloud_yaml_matches_canonical_scenario_execution_contracts():
    import json

    # The committed YAML intentionally uses JSON syntax, avoiding another parser
    # dependency while remaining directly consumable by the LiveKit CLI.
    cloud = []
    for filename in ("scenarios.yaml", "scenarios.audio.yaml"):
        path = evaluation.CASES.parent.parent / filename
        cloud.extend(
            json.loads(
                "\n".join(
                    line
                    for line in path.read_text().splitlines()
                    if not line.startswith("#")
                )
            )["scenarios"]
        )
    canonical = {case["id"]: case for case in evaluation.load_scenarios()}
    assert {case["id"] for case in cloud} == set(canonical)
    for case in cloud:
        expected = canonical[case["id"]]
        assert case["label"] == expected["name"]
        for field in (
            "evaluation",
            "id",
            "name",
            "now",
            "customer",
            "configuration",
            "expected_state",
        ):
            assert case["userdata"][field] == expected[field], (case["id"], field)
        assert case["agent_expectations"] == expected["agent_expectations"]
