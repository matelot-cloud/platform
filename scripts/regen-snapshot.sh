#!/usr/bin/env bash
# Regenerates apps/api/drizzle/meta/<last>_snapshot.json from schema.ts without adding a migration.
# Use after hand-writing a migration SQL (and editing schema.ts to match): the snapshot of the last journal entry
# becomes the current schema, so `drizzle-kit generate` is a no-op again. Refuses when the last entry has no SQL file.
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
last=$(node -p "const j=require('./drizzle/meta/_journal.json'); j.entries[j.entries.length-1].tag")
idx=${last%%_*}
[ -f "drizzle/$last.sql" ] || { echo "drizzle/$last.sql missing (journal and files disagree)" >&2; exit 1; }
cp drizzle/meta/_journal.json /tmp/journal.$$.json
before=$(ls drizzle/*.sql | wc -l)
pnpm drizzle-kit generate > /tmp/gen.$$.log 2>&1 || { cat /tmp/gen.$$.log; exit 1; }
if grep -q "No schema changes" /tmp/gen.$$.log; then echo "snapshot already matches schema.ts"; rm -f /tmp/journal.$$.json /tmp/gen.$$.log; exit 0; fi
new=$(ls drizzle/*.sql | tail -1); newidx=$(basename "$new" | cut -d_ -f1)
node -e "
const fs=require('fs'); const s=JSON.parse(fs.readFileSync('drizzle/meta/${newidx}_snapshot.json','utf8'));
const prevs=fs.readdirSync('drizzle/meta').filter(f=>/^\d+_snapshot\.json$/.test(f) && f<'${newidx}_' && f!=='${idx}_snapshot.json').sort();
if (prevs.length) s.prevId=JSON.parse(fs.readFileSync('drizzle/meta/'+prevs[prevs.length-1],'utf8')).id;
fs.writeFileSync('drizzle/meta/${idx}_snapshot.json', JSON.stringify(s,null,2));"
rm -f "$new" "drizzle/meta/${newidx}_snapshot.json"
mv /tmp/journal.$$.json drizzle/meta/_journal.json
pnpm drizzle-kit generate 2>&1 | grep -q "No schema changes" && echo "drizzle/meta/${idx}_snapshot.json regenerated; generate is a no-op" || { echo "generate still proposes changes" >&2; exit 1; }
rm -f /tmp/gen.$$.log
