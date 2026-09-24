// Live-keys proxy tests — no network. Mock fetch is injected by replacing
// globalThis.fetch; CACHE is a Map-backed KVNamespace stand-in.
import { test } from 'node:test';
import assert from 'node:assert';
import { handleLiveKeys } from '../src/livekeys.ts';

// --- helpers ---------------------------------------------------------------

function mapKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, _opts) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) { store.delete(key); },
  };
}

function okDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT/i.test(sql)) rows.push({ sql, args });
              return { success: true };
            },
            async all() { return { results: [] }; },
            async first() { return null; },
          };
        },
      };
    },
  };
}

function postJson(pathname, body, ip = '203.0.113.7') {
  return new Request(`http://worker.test${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Install a mock fetch for the duration of one test.
function withMockFetch(t, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return await fn(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const SYSTEMONE_UPSTREAM = { choice: 'b', probabilities: { a: 0.2, b: 0.7, c: 0.1 }, latency_ms: 120 };

// --- 1. systemone happy path ------------------------------------------------

test('systemone: Choice schema happy path — 200, x-served-by, bearer auth, passthrough', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'test-key-ts', CACHE: mapKv() };
  const req = postJson('/api/systemone', {
    schema: { type: 'Choice', options: ['a', 'b', 'c'] },
    context: 'pick one',
    samples: 2,
  });
  const res = await handleLiveKeys(req, env);
  assert.ok(res);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-served-by'), 'typesafe-systemone');
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer test-key-ts');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(sent.schema, { type: 'Choice', options: ['a', 'b', 'c'] });
  assert.strictEqual(sent.context, 'pick one');
  assert.strictEqual(sent.samples, 2);
  assert.strictEqual(await res.text(), JSON.stringify(SYSTEMONE_UPSTREAM));
});

// --- 2. schema validation → 400 ---------------------------------------------

test('systemone: validation rejects FreeText type, options>255, context>4000', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };

  const badType = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'FreeText' }, context: 'x',
  }), env);
  assert.strictEqual(badType.status, 400);

  const tooManyOptions = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Choice', options: Array.from({ length: 256 }, (_, i) => `o${i}`) },
    context: 'x',
  }), env);
  assert.strictEqual(tooManyOptions.status, 400);

  const longContext = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'x'.repeat(4001),
  }), env);
  assert.strictEqual(longContext.status, 400);

  assert.strictEqual(calls.length, 0, 'upstream must not be called for invalid bodies');
});

// --- 3. upstream non-2xx passthrough ----------------------------------------

test('systemone: upstream 402 and 500 pass through status + body verbatim', async (t) => {
  const calls = withMockFetch(t, async (_url, init) => {
    const sent = JSON.parse(init.body);
    if (sent.context === 'pay') return jsonResponse({ error: 'quota exhausted' }, 402);
    return jsonResponse({ error: 'internal boom' }, 500);
  });
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };

  const r402 = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'pay',
  }), env);
  assert.strictEqual(r402.status, 402);
  assert.strictEqual(await r402.text(), JSON.stringify({ error: 'quota exhausted' }));

  const r500 = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'boom',
  }), env);
  assert.strictEqual(r500.status, 500);
  assert.strictEqual(r500.headers.get('x-served-by'), 'typesafe-systemone');
  assert.strictEqual(await r500.text(), JSON.stringify({ error: 'internal boom' }));
  assert.strictEqual(calls.length, 2);
});

// --- 4. timeout → 504 --------------------------------------------------------

test('systemone: upstream timeout → 504', async (t) => {
  withMockFetch(t, async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation timed out.', 'AbortError'));
      });
    });
  });
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };
  const res = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'slow',
  }), env, { timeoutMs: 30 });
  assert.strictEqual(res.status, 504);
  const body = await res.json();
  assert.strictEqual(body.error, 'upstream_timeout');
});

// --- 5. missing key → 503 key_not_deployed ----------------------------------

test('systemone: missing TYPESAFEAI_KEY → 503 key_not_deployed', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse({}));
  const env = { CACHE: mapKv() };
  const res = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'x',
  }), env);
  assert.strictEqual(res.status, 503);
  assert.strictEqual((await res.json()).error, 'key_not_deployed');
  assert.strictEqual(calls.length, 0);
});

// --- 6. rate limit: 11 rapid → 429 -------------------------------------------

test('rate limit: 11 rapid requests → first 10 ok, 11th is 429', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await handleLiveKeys(postJson('/api/systemone', {
      schema: { type: 'Noul' }, context: `req ${i}`,
    }), env);
    statuses.push(res.status);
  }
  assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
  assert.strictEqual((await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'again',
  }), env)).status, 429);
  assert.strictEqual(calls.length, 10);
});

// --- 7. quantum pending without MOTHQUANTUM_BASE ------------------------------

test('quantum: MOTHQUANTUM_BASE unset → 503 moth_endpoint_pending (honest flag)', async (t) => {
  let upstreamCalls = 0;
  withMockFetch(t, async () => { upstreamCalls++; return jsonResponse({}); });
  const env = { MOTHQUANTUM_KEY: 'moth-key', CACHE: mapKv() };
  for (const path of ['/api/quantum/encode', '/api/quantum/decode']) {
    const res = await handleLiveKeys(postJson(path, { text: 'hello' }), env);
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.error, 'moth_endpoint_pending');
    assert.match(body.hint, /MOTHQUANTUM_BASE/);
  }
  assert.strictEqual(upstreamCalls, 0, 'no upstream call while pending');
});

// --- 8. quantum passthrough with base + mock fetch ----------------------------

test('quantum: with MOTHQUANTUM_BASE + mock fetch, encode/decode pass through', async (t) => {
  const calls = withMockFetch(t, async (url) => {
    if (String(url).endsWith('/encode')) return jsonResponse({ circuit: 'qpam', shots: 1024 });
    return jsonResponse({ samples: [0.1, 0.2] });
  });
  const env = {
    MOTHQUANTUM_KEY: 'moth-key',
    MOTHQUANTUM_BASE: 'https://quantum.example.com/v1/',
    CACHE: mapKv(),
  };
  const enc = await handleLiveKeys(postJson('/api/quantum/encode', { text: 'lore', shots: 8 }), env);
  assert.strictEqual(enc.status, 200);
  assert.strictEqual(enc.headers.get('x-served-by'), 'moth-quantum');
  assert.strictEqual(await enc.text(), JSON.stringify({ circuit: 'qpam', shots: 1024 }));

  const dec = await handleLiveKeys(postJson('/api/quantum/decode', { samples: [1, 2, 3] }), env);
  assert.strictEqual(dec.status, 200);
  assert.strictEqual(await dec.text(), JSON.stringify({ samples: [0.1, 0.2] }));

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'https://quantum.example.com/v1/encode');
  assert.strictEqual(calls[1].url, 'https://quantum.example.com/v1/decode');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer moth-key');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { text: 'lore', shots: 8 });
});

// --- 9. non-matching path → null ----------------------------------------------

test('router: non-matching paths return null from handleLiveKeys', async (t) => {
  withMockFetch(t, async () => jsonResponse({}));
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };
  assert.strictEqual(await handleLiveKeys(postJson('/api/ocean/status', {}), env), null);
  assert.strictEqual(await handleLiveKeys(postJson('/cell/foo', {}), env), null);
  // Right path, wrong method → also null (falls through to worker 404).
  const getReq = new Request('http://worker.test/api/systemone', { method: 'GET' });
  assert.strictEqual(await handleLiveKeys(getReq, env), null);
});

// --- 10. DB throws → receipt failure invisible to caller -----------------------

test('receipts: DB that throws still returns the upstream response (console.warn only)', async (t) => {
  withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const throwDb = { prepare() { throw new Error('db down'); } };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = originalWarn; });

  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv(), DB: throwDb };
  const res = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Choice', options: ['a', 'b'] }, context: 'witness me',
  }), env);

  assert.strictEqual(res.status, 200, 'caller must see the upstream success');
  assert.strictEqual(await res.text(), JSON.stringify(SYSTEMONE_UPSTREAM));
  assert.ok(warnings.some(w => w.includes('livekeys')), 'expected a console.warn about the receipt failure');
  // KV fallback counter should have been bumped.
  const counter = JSON.parse(env.CACHE.store.get('ocean:log:livekeys'));
  assert.strictEqual(counter.count, 1);
});

// --- bonus: DB happy path records a witness row --------------------------------

test('receipts: successful call inserts an ocean_calls row when DB is present', async (t) => {
  withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const db = okDb();
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv(), DB: db };
  const res = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'receipt please',
  }), env);
  assert.strictEqual(res.status, 200);
  const inserts = db.rows.filter(r => /INSERT OR IGNORE INTO ocean_calls/.test(r.sql));
  assert.strictEqual(inserts.length, 1);
  const row = inserts[0].args;
  assert.strictEqual(row[1], '/api/systemone');
  assert.strictEqual(row[3], 200);
  assert.strictEqual(row[7], '', 'chain_hash is owned by the ocean-api sibling branch');
});
