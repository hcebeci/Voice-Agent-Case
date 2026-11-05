from pathlib import Path
import tempfile,subprocess,json
root=Path(tempfile.mkdtemp(prefix='database-team-', dir='/tmp'))
pg=Path('/opt/homebrew/opt/postgresql@16/bin')
subprocess.run([str(pg/'initdb'),'-D',str(root/'data'),'-A','trust','--no-locale','-E','UTF8'],check=True,stdout=subprocess.DEVNULL)
subprocess.run([str(pg/'pg_ctl'),'-D',str(root/'data'),'-l',str(root/'server.log'),'-o',f"-k {root} -p 55443 -c listen_addresses=''",'-w','start'],check=True,stdout=subprocess.DEVNULL)
conn=[str(pg/'psql'),'-h',str(root),'-p','55443','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(s):return subprocess.run(conn+['-q','-c',s],check=True,capture_output=True,text=True)
sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key);')
repo=Path(__file__).resolve().parents[3]
for f in sorted((repo/'supabase/migrations').glob('*.sql')):
 r=subprocess.run(conn+['-q','-f',str(f)],capture_output=True,text=True)
 if r.returncode:
  print('MIGRATION_FAILED',f.name,r.stderr);raise SystemExit(1)
 print('applied',f.name)
Path('/tmp/database-team-cluster.json').write_text(json.dumps({'root':str(root),'psql':conn}))
print('ISOLATED_CLUSTER_READY',root)
