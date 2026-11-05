#!/usr/bin/env python3
"""Run real SQL regressions in a disposable PostgreSQL cluster, never a configured DB."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration_plan', ROOT / 'scripts/migration-plan.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def main():
    required = ['initdb', 'pg_ctl', 'psql']
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        raise SystemExit('Install PostgreSQL locally to run isolated database tests: ' + ', '.join(missing))
    with tempfile.TemporaryDirectory(prefix='voice-platform-db-') as tmp:
        path = Path(tmp)
        data = path / 'data'
        socket = path / 'socket'
        socket.mkdir()
        # Explicit socket, port and empty listening address prevent contact with
        # developer/production databases, even if PG* env vars are configured.
        env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        env.update(PGHOST=str(socket), PGPORT='55439', PGDATABASE='postgres', PGUSER='postgres')
        def run(args, **kwargs):
            result = subprocess.run(args, env=env, text=True, capture_output=True, **kwargs)
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
            return result
        run(['initdb', '-D', str(data), '-U', 'postgres', '--auth=trust', '--no-locale'])
        started = False
        try:
            run(['pg_ctl', '-D', str(data), '-l', str(path/'server.log'), '-o',
                 f"-k {socket} -p 55439 -c listen_addresses=''", '-w', 'start'])
            started = True
            bootstrap = """
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema public,auth to anon,authenticated,service_role;
grant execute on function auth.uid() to public;
grant select on auth.users to authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
"""
            run(['psql', '-X', '-v', 'ON_ERROR_STOP=1'], input=bootstrap)
            for migration in plan.migration_paths():
                run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-f', str(migration)])
            for test in sorted((ROOT/'supabase/tests').glob('*.sql')):
                run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-f', str(test)])
                print(f'PASS {test.relative_to(ROOT)}')
            integration = ROOT/'tests/integration/observability.mts'
            if integration.exists():
                env['VALIDATION_PSQL'] = json.dumps(['psql', '-X', '-v', 'ON_ERROR_STOP=1'])
                result = run(['node', '--experimental-strip-types', str(integration)])
                print(result.stdout, end='')
            collection = ROOT/'tests/integration/collection.py'
            if collection.exists():
                env['VALIDATION_PSQL'] = json.dumps(['psql', '-X', '-v', 'ON_ERROR_STOP=1'])
                result = run(['uv', 'run', '--project', str(ROOT/'Livekit-Agents'), '--no-env-file', '--no-sync', 'python', str(collection)])
                print(result.stdout, end='')
            print(f'PASS fresh database: {len(plan.migration_paths())} migrations (including manual history)')
        finally:
            if started:
                subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'],
                               env=env, capture_output=True, text=True, check=True)


if __name__ == '__main__':
    main()
