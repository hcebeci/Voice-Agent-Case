"""Independent fault and stale-snapshot probes; disposable SQL fixtures only."""
import importlib.util
from pathlib import Path
import subprocess
import time
from uuid import uuid4

spec = importlib.util.spec_from_file_location('database_lead_fixture', Path(__file__).parents[1] / 'test_database_idempotency.py')
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


def test_connection_terminated_before_commit_rolls_back_and_same_key_retries():
    sid = db.seed()
    payload = db.raw_payload(sid)
    app = 'validator_' + uuid4().hex
    statement = "SET application_name=" + db.quoted(app) + "; BEGIN; " + db.commit_sql(sid, 'killed-before-commit', payload) + '; SELECT pg_sleep(30); COMMIT;'
    child = subprocess.Popen(db.PSQL + ['-A', '-t', '-c', statement], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            pids = db.sql("SELECT pid FROM pg_stat_activity WHERE application_name=" + db.quoted(app) + " AND wait_event='PgSleep'")
            if pids:
                break
            time.sleep(.02)
        assert pids, 'child did not reach post-effect, pre-COMMIT sleep'
        assert db.sql('SELECT pg_terminate_backend(' + pids + ')') == 't'
        child.communicate(timeout=5)
        assert child.returncode != 0
        assert all(db.count(table, sid) == 0 for table in ['follow_up_requests', 'collection_operations', 'session_events'])
        assert db.sql('SELECT version FROM collection_sessions WHERE session_id=' + db.quoted(sid)) == '0'
        replay = db.scalar(db.commit_sql(sid, 'killed-before-commit', payload))
        assert replay['result']['code'] == 'CALLBACK_REQUESTED'
        assert all(db.count(table, sid) == 1 for table in ['follow_up_requests', 'collection_operations', 'session_events'])
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()


def test_customer_snapshot_change_conflicts_without_consuming_request_key():
    sid = db.seed()
    old = db.raw_payload(sid)
    db.sql('UPDATE customers SET balance_cents=balance_cents+1 WHERE id=(SELECT customer_id FROM collection_sessions WHERE session_id=' + db.quoted(sid) + ')')
    assert db.scalar(db.commit_sql(sid, 'stale-customer', old)) == {'conflict': True}
    assert all(db.count(table, sid) == 0 for table in ['follow_up_requests', 'collection_operations', 'session_events'])
    fresh = db.raw_payload(sid)
    assert db.scalar(db.commit_sql(sid, 'stale-customer', fresh))['result']['code'] == 'CALLBACK_REQUESTED'
    assert db.count('follow_up_requests', sid) == db.count('collection_operations', sid) == 1


def test_local_fixture_does_not_model_supabase_service_role_bypassrls():
    # This is a coverage limitation, not evidence that deployed Supabase fails.
    assert db.sql("SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role'") == 'f'
    assert db.sql("SELECT has_function_privilege('service_role','collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb,text)','EXECUTE')") == 't'
    assert db.sql("SELECT prosecdef FROM pg_proc WHERE oid='collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure") == 'f'
