#!/usr/bin/env bash
# Guards for .github/workflows (layout CI job): what a regenerated workflow must not lose again.
#   - every job has timeout-minutes (a hung multi-arch build once ran 3 h 37 min)
#   - publish-cli.yml creates the pack directory before `npm pack --pack-destination` (ENOENT on cli-v2.22.4)
#   - release.yml builds the worker as the second target of the api job (no separate full multi-arch build)
#   - release.yml's release job tolerates "Re-run failed jobs" and checks every image digest before publishing
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import re, sys, yaml
problems = []
for f in ['ci', 'release', 'publish-cli', 'docs-sync']:
    d = yaml.safe_load(open(f'.github/workflows/{f}.yml'))
    for name, job in d['jobs'].items():
        if 'timeout-minutes' not in job: problems.append(f'{f}.yml: job {name} has no timeout-minutes')
pub = open('.github/workflows/publish-cli.yml').read()
if not re.search(r'mkdir -p "\$PACK" && .*npm pack --pack-destination "\$PACK"', pub): problems.append('publish-cli.yml: the pack step must be `mkdir -p "$PACK" && … npm pack --pack-destination "$PACK"`')
if '/tmp/pack' in pub.replace('PACK: /tmp/pack', ''): problems.append('publish-cli.yml: use "$PACK", not a literal /tmp/pack')
rel = yaml.safe_load(open('.github/workflows/release.yml'))
legs = rel['jobs']['images']['strategy']['matrix']['include']
names = [l['name'] for l in legs]
if 'worker' in names: problems.append('release.yml: the worker must be the second target of the api leg (also: worker), not its own matrix leg')
api = next((l for l in legs if l['name'] == 'api'), None)
if not api or api.get('also') != 'worker': problems.append('release.yml: api leg must carry `also: worker`')
if rel['jobs']['images'].get('timeout-minutes', 999) > 30: problems.append('release.yml: images timeout-minutes must be ≤ 30')
release = rel['jobs']['release']
if '!cancelled()' not in str(release.get('if', '')) or "needs.images.result == 'success'" not in str(release.get('if', '')): problems.append("release.yml: release job needs `if: !cancelled() && needs.*.result == 'success'` (re-run of a failed leg)")
steps = ' '.join(str(s.get('run', '')) for s in release['steps'])
if 'digest-$n.txt' not in steps: problems.append('release.yml: release job must check every image digest before publishing')
for p in problems: print(f'check-workflows: {p}', file=sys.stderr)
sys.exit(1 if problems else 0)
PY
echo "workflows ok (timeouts on every job, pack dir created, worker from the api job, release re-run safe)"
