"""Artifact destinations must work in both repository and non-root images."""

from pathlib import Path

import evaluation


def test_deployed_layout_keeps_reports_under_writable_application(monkeypatch):
    monkeypatch.delenv("VOICE_AGENT_EVALUATION_OUTPUT_DIR", raising=False)
    assert evaluation.evaluation_output_directory(Path("/app/src/evaluation.py")) == Path(
        "/app/validation-results"
    )


def test_repository_layout_preserves_existing_report_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("VOICE_AGENT_EVALUATION_OUTPUT_DIR", raising=False)
    root = tmp_path / "repository"
    root.mkdir()
    # A .git file also covers linked worktrees.
    (root / ".git").write_text("gitdir: /synthetic/worktree")
    source = root / "Livekit-Agents/src/evaluation.py"
    assert evaluation.evaluation_output_directory(source) == root / "validation-results"


def test_deployment_can_select_persistent_report_volume(tmp_path, monkeypatch):
    destination = tmp_path / "persistent" / "evaluations"
    monkeypatch.setenv("VOICE_AGENT_EVALUATION_OUTPUT_DIR", str(destination))
    assert evaluation.evaluation_output_directory(Path("/app/src/evaluation.py")) == destination
