import json
from pathlib import Path

import pytest

from evaluation import (
    evaluation_root,
    grade_final_state,
    load_scenarios,
    make_evaluation_backend,
    retain_report,
)


def test_evidence_root_uses_writable_worker_directory_in_container(tmp_path):
    worker = tmp_path / "app"
    module = worker / "src" / "evaluation.py"
    assert evaluation_root(module) == worker
    repo = tmp_path / "checkout"
    (repo / "supabase").mkdir(parents=True)
    assert evaluation_root(repo / "Livekit-Agents" / "src" / "evaluation.py") == repo


def scenario():
    return load_scenarios()[0]


async def test_evaluation_uses_production_backend_without_remote_database():
    case = scenario()
    backend, store = make_evaluation_backend(case)
    try:
        result = await backend.execute(
            "verify_identity",
            {"date_of_birth": "1988-04-12", "postal_code": "34000"},
            "verify",
        )
        assert result["verified_user"] is True
        assert store.operations[0]["arguments"]["date_of_birth"] == "1988-04-12"
        assert store.customer["is_test_record"] is True
        assert store.now == "2026-11-05T09:00:00+00:00"
    finally:
        await backend.close()


def test_final_state_grader_fails_wrong_date_and_missing_effect():
    _, store = make_evaluation_backend(scenario())
    store.effects = [
        {"kind": "commitment", "amount_cents": 85000, "payment_date": "2026-11-10"}
    ]
    store.state = {"verified": True}
    checks = grade_final_state(
        store,
        {
            "verified": True,
            "commitments": [{"amount_cents": 85000, "payment_date": "2026-11-12"}],
            "callbacks": [],
        },
    )
    assert not all(check["passed"] for check in checks)
    assert not all(
        check["passed"] for check in grade_final_state(store, {"commitments": []})
    )


def test_retained_reports_are_append_only_and_keep_failures_and_customer_answers(
    tmp_path,
):
    report = {
        "id": "run-1",
        "status": "failed",
        "customer_snapshot": scenario()["customer"],
        "transcript": [{"role": "user", "content": "DOB 1988-04-12 postal 34000"}],
    }
    path = retain_report(report, tmp_path)
    assert (
        json.loads(path.read_text())["customer_snapshot"]["date_of_birth"]
        == "1988-04-12"
    )
    assert "34000" in path.read_text()
    with pytest.raises(FileExistsError):
        retain_report({**report, "status": "passed"}, tmp_path)
    retain_report({**report, "id": "run-2", "status": "passed"}, tmp_path)
    assert len(list(tmp_path.glob("*.json"))) == 2


def test_scenarios_cover_requested_risks_and_have_full_synthetic_facts():
    cases = load_scenarios()
    assert {
        "happy-path",
        "manager-override",
        "wrong-identity",
        "cancel-after-review",
        "changed-date",
        "interrupted-review",
        "unverified-disclosure",
    } <= {case["id"] for case in cases}
    for case in cases:
        assert case["customer"]["is_test_record"] is True
        assert case["customer"]["date_of_birth"] == "1988-04-12"
        assert case["customer"]["postal_code"] == "34000"
        assert case["expected_state"]
        assert case["configuration"]["instructions"]


async def test_scripted_complete_path_records_one_exact_effect_and_transcript(tmp_path):
    from evaluation import run_scenario

    report = await run_scenario(scenario(), mode="scripted", output_dir=tmp_path)
    assert report["status"] == "passed", report
    assert report["execution_type"] == "automated_scripted"
    assert report["provenance"]["language_understanding_tested"] is False
    assert len(report["actual_outcome"]["commitments"]) == 1
    assert report["actual_outcome"]["commitments"][0]["payment_date"] == "2026-11-10"
    assert any("34000" in message["content"] for message in report["transcript"])
    assert Path(report["artifact_path"]).exists()
