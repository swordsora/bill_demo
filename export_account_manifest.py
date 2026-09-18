import csv, json, subprocess
from pathlib import Path
mdb='/home/ubuntu/upload/Invoice Program.mdb'
raw=subprocess.run(['mdb-export',mdb,'Semsem'],check=True,capture_output=True,text=True,encoding='utf-8').stdout
rows=list(csv.DictReader(raw.splitlines()))
out=[]
for r in rows:
    username=(r.get('User_Name') or r.get('UserName') or '').strip()
    kind=(r.get('PWD_Kind') or '').strip()
    if username:
        out.append({'username':username,'legacyKind':kind,'passwordMigration':'manual-reset-required'})
Path('/home/ubuntu/Invoice Program-pwa/accounts_manifest.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'exported {len(out)} account records without password values')
