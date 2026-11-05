"""Regression marker; executable current-handler coverage is in fix_validation/."""
from pathlib import Path

def test_session_handler_routes_through_durable_reservation():
    root = Path(__file__).resolve().parents[2]
    source = (root / 'supabase/functions/livekit-session/index.ts').read_text()
    assert 'request.headers.get("Idempotency-Key")' in source
    assert 'rpc("session_start_reserve"' in source
    assert 'SESSION_START_PENDING' in source
