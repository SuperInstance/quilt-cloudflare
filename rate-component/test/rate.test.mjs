// =============================================================================
//  Offline test harness for functions/api/rate.js
// =============================================================================
//  Exercises the visitor-bucket, global-cap, and graceful-degrade logic with
//  an in-memory fake KV and a stubbed global fetch — no real TYPESAFEAI_KEY,
//  no network egress, no Cloudflare runtime required. Run with:
//
//      node --test test/rate.test.mjs
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/rate.js';

const FAKE_SECRET = 'sk-fake-typesafeai-key-should-never-leak';
const SELF_ORIGIN = 'https://example.pages.dev';

class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async get(key, type) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) {
    this.store.set(key, value);
  }
}

function makeRequest({
  origin = SELF_ORIGIN,
  cookie,
  ip = '203.0.113.7',
  body = { content: 'my chart shows a 12% margin gain over 3 quarters' },
  bodyString,
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin !== null) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (ip !== null) headers['CF-Connecting-IP'] = ip;
  const payload = bodyString !== undefined ? bodyString : JSON.stringify(body);
  return new Request(`${SELF_ORIGIN}/api/rate`, {
    method: 'POST',
    headers,
    body: payload,
  });
}

function baseEnv(overrides = {}) {
  return {
    TYPESAFEAI_KEY: FAKE_SECRET,
    RATE_KV: new FakeKV(),
    RATE_VISITOR_LIMIT: '3',
    RATE_GLOBAL_DAILY_LIMIT: '1000',
    ...overrides,
  };
}

// Extract sr_visitor cookie value from a Set-Cookie header, if present.
function cookieFrom(response) {
  const sc = response.headers.get('Set-Cookie');
  if (!sc) return null;
  const m = /sr_visitor=([^;]+)/.exec(sc);
  return m ? `sr_visitor=${m[1]}` : null;
}

function stubUpstreamOk({ score = 0.82, confidence = 0.71, noul = 0.8 } = {}) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: { quality: { score, confidence }, verdict: { noul } },
    usage: { in: 350, out: 35 },
  }), { status: 200 });
}

function stubUpstreamStatus(status) {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status });
}

function stubUpstreamNetworkError() {
  globalThis.fetch = async () => {
    throw new Error('simulated network failure');
  };
}

// NOTE: pass a response whose body has NOT been read yet (or a res.clone()
// taken before any .json()/.text() call) — Response bodies are one-shot
// streams and .clone() cannot run after the original has been consumed.
async function assertNeverLeaksSecret(response, extraStrings = []) {
  const bodyText = await response.text();
  assert.ok(!bodyText.includes(FAKE_SECRET), 'response body must never contain the secret key');
  for (const h of response.headers.keys()) {
    assert.ok(!response.headers.get(h).includes(FAKE_SECRET), `header ${h} must never contain the secret key`);
  }
  for (const s of extraStrings) {
    assert.ok(!s.includes(FAKE_SECRET), 'no incidental string may contain the secret key');
  }
}

// ---------------------------------------------------------------------------
// 1. Same-origin enforcement
// ---------------------------------------------------------------------------

test('same-origin: same-origin call is accepted (200, not degraded)', async () => {
  stubUpstreamOk();
  const env = baseEnv();
  const res = await onRequestPost({ request: makeRequest({ origin: SELF_ORIGIN }), env });
  assert.equal(res.status, 200);
  const leakCheck = res.clone();
  const data = await res.json();
  assert.equal(data.degraded, false);
  await assertNeverLeaksSecret(leakCheck);
});

test('same-origin: cross-origin call is rejected 403', async () => {
  stubUpstreamOk();
  const env = baseEnv();
  const res = await onRequestPost({ request: makeRequest({ origin: 'https://evil.example' }), env });
  assert.equal(res.status, 403);
  await assertNeverLeaksSecret(res);
});

test('same-origin: no Origin/Sec-Fetch-Site header at all is rejected 403', async () => {
  stubUpstreamOk();
  const env = baseEnv();
  const res = await onRequestPost({ request: makeRequest({ origin: null }), env });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// 2. Request size cap
// ---------------------------------------------------------------------------

test('size cap: a body over 4KB is rejected 413', async () => {
  stubUpstreamOk();
  const env = baseEnv();
  const bigContent = 'x'.repeat(5000);
  const res = await onRequestPost({
    request: makeRequest({ bodyString: JSON.stringify({ content: bigContent }) }),
    env,
  });
  assert.equal(res.status, 413);
});

// ---------------------------------------------------------------------------
// 3. Per-visitor bucket (token bucket, rolling 24h)
// ---------------------------------------------------------------------------

test('visitor bucket: exhausts at the configured limit, then degrades gracefully at HTTP 200', async () => {
  stubUpstreamOk();
  const env = baseEnv({ RATE_VISITOR_LIMIT: '3', RATE_GLOBAL_DAILY_LIMIT: '1000' });
  let cookie;
  const results = [];
  for (let i = 0; i < 5; i++) {
    const res = await onRequestPost({ request: makeRequest({ cookie }), env });
    cookie = cookieFrom(res) || cookie;
    const leakCheck = res.clone();
    const data = await res.json();
    results.push({ status: res.status, degraded: data.degraded, reason: data.reason, remaining: data.budget?.remaining });
    await assertNeverLeaksSecret(leakCheck);
  }
  // First 3 calls succeed live; the 4th and 5th degrade — but every single
  // response is still HTTP 200 (graceful degrade, never a hard wall).
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.deepEqual(results.map((r) => r.degraded), [false, false, false, true, true]);
  assert.equal(results[3].reason, 'budget_spent');
  assert.equal(results[4].reason, 'budget_spent');
  console.log('  [bucket] per-visitor sequence:', results.map((r) => (r.degraded ? 'degraded' : 'live')).join(' -> '));
});

test('visitor bucket: cookie-cleared visitor is still capped by the hashed-IP bucket', async () => {
  stubUpstreamOk();
  const env = baseEnv({ RATE_VISITOR_LIMIT: '2', RATE_GLOBAL_DAILY_LIMIT: '1000' });
  const ip = '198.51.100.42';
  // Same IP, but a fresh (no-cookie) request each time — simulates the
  // visitor clearing cookies between calls.
  const r1 = await onRequestPost({ request: makeRequest({ ip }), env });
  const r2 = await onRequestPost({ request: makeRequest({ ip }), env });
  const r3 = await onRequestPost({ request: makeRequest({ ip }), env }); // over the IP-bucket limit
  assert.equal((await r1.json()).degraded, false);
  assert.equal((await r2.json()).degraded, false);
  const d3 = await r3.json();
  assert.equal(d3.degraded, true);
  assert.equal(d3.reason, 'budget_spent');
  assert.equal(r3.status, 200);
});

// ---------------------------------------------------------------------------
// 4. Global daily ceiling (tighter-wins backstop)
// ---------------------------------------------------------------------------

test('global cap: a shared global ceiling degrades every visitor once it is spent, even with room left on their own bucket', async () => {
  stubUpstreamOk();
  const env = baseEnv({ RATE_VISITOR_LIMIT: '1000', RATE_GLOBAL_DAILY_LIMIT: '2' });
  const resA = await onRequestPost({ request: makeRequest({ ip: '10.0.0.1' }), env });
  const resB = await onRequestPost({ request: makeRequest({ ip: '10.0.0.2' }), env });
  const resC = await onRequestPost({ request: makeRequest({ ip: '10.0.0.3' }), env }); // 3rd distinct visitor, global cap = 2
  assert.equal((await resA.json()).degraded, false);
  assert.equal((await resB.json()).degraded, false);
  const dataC = await resC.json();
  assert.equal(resC.status, 200, 'global-cap degrade is still HTTP 200');
  assert.equal(dataC.degraded, true);
  assert.equal(dataC.reason, 'budget_spent');
  console.log('  [global-cap] 3rd distinct visitor with a fresh per-visitor budget still degrades:', dataC.reason);
});

// ---------------------------------------------------------------------------
// 5. Graceful degrade — missing key
// ---------------------------------------------------------------------------

test('degrade: missing TYPESAFEAI_KEY degrades gracefully at HTTP 200 and never calls upstream', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must not be called');
  };
  const env = baseEnv({ TYPESAFEAI_KEY: undefined });
  const res = await onRequestPost({ request: makeRequest(), env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.degraded, true);
  assert.equal(data.reason, 'not_configured');
  assert.equal(called, false, 'no upstream call should be attempted without a key');
});

test('degrade: missing KV binding degrades gracefully at HTTP 200 (fails safe, never unmetered)', async () => {
  const env = baseEnv({ RATE_KV: undefined });
  const res = await onRequestPost({ request: makeRequest(), env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.degraded, true);
  assert.equal(data.reason, 'not_configured');
});

// ---------------------------------------------------------------------------
// 6. Graceful degrade — upstream 401 / error (the one fully live-verifiable
//    path right now: the org-wide TYPESAFEAI_KEY currently returns 401
//    pending owner rotation, per the dispatch ledger)
// ---------------------------------------------------------------------------

test('degrade: upstream 401 degrades gracefully at HTTP 200, budget still spent', async () => {
  stubUpstreamStatus(401);
  const env = baseEnv({ RATE_VISITOR_LIMIT: '5' });
  const res = await onRequestPost({ request: makeRequest(), env });
  const leakCheck = res.clone();
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.degraded, true);
  assert.equal(data.reason, 'upstream_error');
  assert.equal(data.upstream_status, 401);
  assert.equal(data.budget.remaining, 4, 'the reservation is spent even though upstream failed');
  await assertNeverLeaksSecret(leakCheck);
});

test('degrade: upstream network failure / timeout degrades gracefully at HTTP 200', async () => {
  stubUpstreamNetworkError();
  const env = baseEnv();
  const res = await onRequestPost({ request: makeRequest(), env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.degraded, true);
  assert.equal(data.reason, 'upstream_error');
});

test('degrade: upstream 500 degrades gracefully at HTTP 200', async () => {
  stubUpstreamStatus(500);
  const env = baseEnv();
  const res = await onRequestPost({ request: makeRequest(), env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.degraded, true);
  assert.equal(data.reason, 'upstream_error');
});

// ---------------------------------------------------------------------------
// 7. Secret never echoed — across every path, including the live-verdict path
// ---------------------------------------------------------------------------

test('secret hygiene: the key never appears in any response across live, degraded, or rejected paths', async () => {
  const scenarios = [];

  stubUpstreamOk();
  scenarios.push(await onRequestPost({ request: makeRequest(), env: baseEnv() }));

  stubUpstreamStatus(401);
  scenarios.push(await onRequestPost({ request: makeRequest(), env: baseEnv() }));

  scenarios.push(await onRequestPost({ request: makeRequest(), env: baseEnv({ TYPESAFEAI_KEY: undefined }) }));
  scenarios.push(await onRequestPost({ request: makeRequest({ origin: 'https://evil.example' }), env: baseEnv() }));

  for (const res of scenarios) {
    await assertNeverLeaksSecret(res);
  }
});
