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
# transient failures of Sigstore / GitHub are retried, and the release step is re-run safe (rc.18: two manual reruns)
sign = open('.github/scripts/sign-image.sh').read()
for call in ('cosign sign', 'cosign attest'):
    if not re.search(rf'retry "[^"]*" {call} ', sign): problems.append(f'sign-image.sh: `{call}` must run through retry')
if 'retry.sh "cosign sign chart" cosign sign' not in open('.github/workflows/release.yml').read(): problems.append('release.yml: the chart signature must run through retry.sh')
if 'publish-release.sh' not in steps: problems.append('release.yml: the GitHub Release is created by .github/scripts/publish-release.sh (retried, idempotent)')
pubrel = open('.github/scripts/publish-release.sh').read()
if 'retry ' not in pubrel or 'gh release view' not in pubrel or '--clobber' not in pubrel: problems.append('publish-release.sh: must retry, and update an existing release (view → edit + upload --clobber)')
for p in problems: print(f'check-workflows: {p}', file=sys.stderr)
sys.exit(1 if problems else 0)
PY
# retry.sh itself: fails twice then succeeds → 0 with two warnings; always fails → the last exit code, one error
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 0 > "$T/n"
flaky() { local n; n=$(($(cat "$T/n") + 1)); printf '%s' "$n" > "$T/n"; [ "$n" -ge 3 ]; }
# shellcheck source=.github/scripts/retry.sh
. .github/scripts/retry.sh
RETRY_DELAYS="0 0" retry "flaky" flaky 2> "$T/err" || { echo "check-workflows: retry.sh did not succeed on the third attempt" >&2; exit 1; }
[ "$(grep -c '::warning::flaky: attempt' "$T/err")" = 2 ] || { echo "check-workflows: retry.sh must log each failure: $(cat "$T/err")" >&2; exit 1; }
if RETRY_DELAYS="0 0" retry "always" sh -c 'exit 7' 2> "$T/err"; then echo "check-workflows: retry.sh must fail when every attempt fails" >&2; exit 1; fi
rc=0; RETRY_DELAYS="0 0" retry "always" sh -c 'exit 7' 2> /dev/null || rc=$?
[ "$rc" = 7 ] || { echo "check-workflows: retry.sh must return the last exit code (got $rc)" >&2; exit 1; }
grep -q '::error::always: failed 3 times (last exit 7)' "$T/err" || { echo "check-workflows: retry.sh final error: $(cat "$T/err")" >&2; exit 1; }
echo "workflows ok (timeouts on every job, pack dir created, worker from the api job, release re-run safe, cosign / gh release retried)"
