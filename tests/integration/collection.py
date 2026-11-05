"""Production worker backend -> real SQL transactions; synthetic disposable fixtures.

Only HTTP transport is substituted by psql. No live Supabase credentials are read.
"""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "Livekit-Agents/src"))
from collection_backend import CollectionBackend

PSQL = json.loads(os.environ["VALIDATION_PSQL"])


def literal(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    text = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
    return "'" + text.replace("'", "''") + "'"


def sql(statement):
    return subprocess.run(PSQL + ["-A", "-t", "-c", statement], capture_output=True, text=True, check=True).stdout.strip()


class DatabaseTransport:
    def __init__(self):
        self.lose_commit_ack = False

    def handle(self, request):
        name = request.url.path.rsplit("/", 1)[-1]
        assert name in {"collection_snapshot", "collection_commit"}
        args = ",".join(key + " => " + literal(value) for key, value in json.loads(request.content).items())
        result = json.loads(sql(f"select public.{name}({args})::text"))
        if name == "collection_commit" and self.lose_commit_ack:
            self.lose_commit_ack = False
            raise httpx.ReadTimeout("Injected lost acknowledgement after durable SQL commit")
        return httpx.Response(200, json=result)


async def main():
    aid, cid, sid = [str(uuid4()) for _ in range(3)]
    now = datetime.now(timezone.utc)
    payment_date = (now + timedelta(days=2)).date().isoformat()
    sql(f"""
      insert into agents(id,name,model) values({literal(aid)},'Collection SQL integration','synthetic');
      insert into customers(id,full_name,date_of_birth,postal_code,account_reference,balance_cents,payment_due_date,is_test_record)
        values({literal(cid)},'Deniz Kaya (fictional)','1988-04-12','34000',{literal(cid)},200000,{literal((now-timedelta(days=10)).date().isoformat())},true);
      insert into sessions(id,agent_id,room_name,source,status) values({literal(sid)},{literal(aid)},{literal('integration-'+sid)},'user_started','active');
      insert into collection_sessions(session_id,customer_id) values({literal(sid)},{literal(cid)});
    """)
    transport = DatabaseTransport()
    backend = CollectionBackend(sid, "http://isolated.invalid", "synthetic", client=httpx.AsyncClient(base_url="http://isolated.invalid/", transport=httpx.MockTransport(transport.handle)))
    try:
        before = await backend.execute("evaluate_offer", {"amount_cents":85000,"payment_date":payment_date}, "unverified")
        assert before["code"] == "IDENTITY_VERIFICATION_REQUIRED", before
        verified = await backend.execute("verify_identity", {"date_of_birth":"1988-04-12","postal_code":"34000"}, "verify")
        assert verified["verified_user"] is True
        below = await backend.execute("evaluate_offer", {"amount_cents":20000,"payment_date":payment_date}, "below")
        assert below["code"] == "BELOW_MINIMUM_PAYMENT"
        offered = await backend.execute("evaluate_offer", {"amount_cents":85000,"payment_date":payment_date}, "offer")
        pid = offered["data"]["proposal_id"]
        early = await backend.execute("create_payment_commitment", {"proposal_id":pid}, "early", user_turn_id="proposal", user_turn_at=now.timestamp())
        assert early["code"] == "CONFIRMATION_REQUIRED"
        review = await backend.execute("_review_delivered", {"proposal_id":pid,"user_turn_id":"proposal","delivered_at":now.timestamp()}, "review")
        assert review["code"] == "REVIEW_DELIVERED"
        transport.lose_commit_ack = True
        saved = await backend.execute("create_payment_commitment", {"proposal_id":pid}, "commit", user_turn_id="agreement", user_turn_at=now.timestamp()+1)
        assert saved["code"] == "COMMITMENT_CREATED", saved
        replay = await backend.execute("create_payment_commitment", {"proposal_id":pid}, "commit", user_turn_id="agreement", user_turn_at=now.timestamp()+1)
        assert replay == saved
        rows = json.loads(sql(f"select json_agg(p) from payment_commitments p where session_id={literal(sid)}"))
        assert len(rows) == 1 and rows[0]["amount_cents"] == 85000 and rows[0]["payment_date"] == payment_date
        assert sql(f"select balance_cents from customers where id={literal(cid)}") == "200000"
        print("PASS production CollectionBackend -> PostgreSQL: identity gate, minimum, review ordering, exact saved effect, lost-ack recovery, duplicate replay, unchanged balance")
    finally:
        await backend.close()


asyncio.run(main())
