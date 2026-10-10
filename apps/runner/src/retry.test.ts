import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, retryTransient } from './retry';

test('transient: network errors and 502/503/504/429; not 401/400/500', () => {
  assert.equal(isTransient(new Error('fetch failed')), true);
  assert.equal(isTransient(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isTransient(new Error('/runner/register → 503: <html>')), true);
  assert.equal(isTransient(new Error('/runner/register → 502: bad gateway')), true);
  assert.equal(isTransient(new Error('/runner/register → 401: Invalid managed runner secret')), false);
  assert.equal(isTransient(new Error('/runner/register → 400: name required')), false);
  assert.equal(isTransient(new Error('/runner/register → 500: boom')), false);
  assert.equal(isTransient(new Error('RUNNER_URL is required')), false);
});

test('retryTransient keeps trying through outages with backoff and gives up on a 401 at once', async () => {
  const logs: string[] = [];
  let calls = 0;
  const result = await retryTransient('register', async () => { calls++; if (calls < 3) throw new Error('fetch failed'); return 'ok'; }, { log: (m) => logs.push(m), maxDelayMs: 10 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.match(logs[0]!, /register failed \(fetch failed\); retrying in 2 s/);

  calls = 0;
  await assert.rejects(retryTransient('register', async () => { calls++; throw new Error('/runner/register → 401: nope'); }, { log: () => undefined }), /401/);
  assert.equal(calls, 1);

  // the loop stops when the runner is shutting down
  let stopping = false;
  await assert.rejects(retryTransient('register', async () => { stopping = true; throw new Error('fetch failed'); }, { until: () => stopping, log: () => undefined }), /fetch failed/);
});
