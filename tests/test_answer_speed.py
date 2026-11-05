"""Checks for the aggregate-only latency report (standard-library unittest)."""

import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "answer_speed", Path(__file__).resolve().parents[1] / "scripts/analyze-answer-speed.py"
)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class AnswerSpeedTests(unittest.TestCase):
    def test_missing_invalid_and_negative_measurements_are_not_zero(self):
        result = report.analyze([{"total_latency_ms": value} for value in ["", "null", "nan", "inf", "-1", "0", "3000"]])
        self.assertEqual(result["missing_or_invalid_stored_latency"], 5)
        self.assertEqual(result["stored_response_latency_ms"], {"count": 2, "p50": 1500, "p95": 3000, "max": 3000})

    def test_nearest_rank_tail_and_empty_sample(self):
        self.assertEqual(report.distribution(range(1, 21))["p95"], 19)
        self.assertEqual(report.distribution([]), {"count": 0, "p50": None, "p95": None, "max": None})

    def test_postgres_export_timestamp_and_invalid_timestamp(self):
        self.assertEqual(report.timestamp("2026-09-25 19:08:21.559+00").isoformat(), "2026-09-25T19:08:21.559000+00:00")
        self.assertEqual(report.timestamp("2026-09-25 19:08:21.92+00").microsecond, 920000)
        self.assertIsNone(report.timestamp("2026-09-25T19:08:21"))
        self.assertIsNone(report.timestamp("invalid"))

    def test_timestamp_consistency_and_negative_intervals(self):
        result = report.analyze([
            {"user_speech_stopped_at": "2026-11-01T00:00:00Z", "agent_first_audio_started_at": "2026-11-01T03:00:02+03:00", "total_latency_ms": "2000"},
            {"user_speech_stopped_at": "2026-11-01T00:00:00Z", "agent_first_audio_started_at": "2026-11-01T00:00:03Z", "total_latency_ms": "2000"},
            {"user_speech_stopped_at": "2026-11-01T00:00:02Z", "agent_first_audio_started_at": "2026-11-01T00:00:01Z"},
        ])
        self.assertEqual(result["timestamp_response_latency_ms"]["count"], 2)
        self.assertEqual(result["negative_timestamp_intervals"], 1)
        self.assertEqual(result["stored_timestamp_mismatches_over_1ms"], 1)

    def test_report_does_not_include_transcripts_or_identifiers(self):
        result = report.analyze([{"session_id": "private-session", "user_transcript": "private-words"}])
        encoded = json.dumps(result)
        self.assertNotIn("private-session", encoded)
        self.assertNotIn("private-words", encoded)
        self.assertEqual(result["session_count"], 1)


if __name__ == "__main__":
    unittest.main()
