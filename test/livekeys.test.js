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

// Recorded live fixture (2026-09-25, real HTTP 200, model jev-1.13.0):
// response carries { model, answers: { name: { ... } }, usage: {...} }.
const SYSTEMONE_UPSTREAM = {
  model: 'jev-1.13.0',
  answers: {
    deploy: { choice: 'b', probabilities: { a: 0.2, b: 0.7, c: 0.1 }, confidence: 0.91 },
  },
  usage: { input_tokens: 390, output_tokens: 66 },
};

function trueShapeBody() {
  return {
    state: 'candidate: deploy now?',
    questions: {
      deploy: {
        type: 'choice',
        question: 'Should we deploy?',
        options: ['a', 'b', 'c'],
      },
    },
  };
}

// --- 1. systemone happy path — true verified wire shape ----------------------

test('systemone: true { state, questions } shape — 200, default model jev-latest, passthrough', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'test-key-ts', CACHE: mapKv() };
  const res = await handleLiveKeys(postJson('/api/systemone', trueShapeBody()), env);
  assert.ok(res);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-served-by'), 'typesafe-systemone');
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer test-key-ts');
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.model, 'jev-latest', 'model defaults to jev-latest');
  assert.strictEqual(sent.state, 'candidate: deploy now?');
  assert.deepStrictEqual(sent.questions.deploy.type, 'choice');
  assert.deepStrictEqual(sent.questions.deploy.options, ['a', 'b', 'c']);
  assert.strictEqual(sent.schema, undefined, 'stale schema field must never be forwarded');
  assert.strictEqual(sent.context, undefined);
  assert.strictEqual(sent.samples, undefined);
  assert.strictEqual(await res.text(), JSON.stringify(SYSTEMONE_UPSTREAM));
});

test('systemone: explicit model + object state (serialized) + score/noul questions', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };
  const res = await handleLiveKeys(postJson('/api/systemone', {
    model: 'jev-1.13.0',
    state: { cell: 'x', tick: 3 },
    questions: {
      urgency: { type: 'score', question: 'How urgent?', scale: ['low', 'high'], criteria: ['low', 'high'] },
      witness: { type: 'noul', question: 'This cell should be witnessed.', instructions: 'Decide.' },
    },
  }), env);
  assert.strictEqual(res.status, 200);
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.model, 'jev-1.13.0');
  assert.strictEqual(sent.state, JSON.stringify({ cell: 'x', tick: 3 }));
  assert.strictEqual(sent.questions.urgency.type, 'score');
  assert.strictEqual(sent.questions.witness.type, 'noul');
});

// --- 2. true-shape validation → 400 ------------------------------------------

test('systemone: validation rejects bad question type, options>255, state>20000, score without rubric, >32 questions', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };

  const badType = await handleLiveKeys(postJson('/api/systemone', {
    state: 'x', questions: { q: { type: 'freetext' } },
  }), env);
  assert.strictEqual(badType.status, 400);

  const tooManyOptions = await handleLiveKeys(postJson('/api/systemone', {
    state: 'x',
    questions: { q: { type: 'choice', options: Array.from({ length: 256 }, (_, i) => `o${i}`) } },
  }), env);
  assert.strictEqual(tooManyOptions.status, 400);

  const longState = await handleLiveKeys(postJson('/api/systemone', {
    state: 'x'.repeat(20001), questions: { q: { type: 'noul', question: 'ok?' } },
  }), env);
  assert.strictEqual(longState.status, 400);

  const scoreNoRubric = await handleLiveKeys(postJson('/api/systemone', {
    state: 'x', questions: { q: { type: 'score', question: 'how much?' } },
  }), env);
  assert.strictEqual(scoreNoRubric.status, 400);

  const tooManyQuestions = await handleLiveKeys(postJson('/api/systemone', {
    state: 'x',
    questions: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, { type: 'noul', question: 'ok?' }])),
  }), env);
  assert.strictEqual(tooManyQuestions.status, 400);

  const missingQuestions = await handleLiveKeys(postJson('/api/systemone', {
    state: 'x',
  }), env);
  assert.strictEqual(missingQuestions.status, 400);

  assert.strictEqual(calls.length, 0, 'upstream must not be called for invalid bodies');
});

// --- 2b. legacy compat shim: {schema, context} → questions map ---------------

test('systemone: legacy {schema, context} compat shim maps onto true shape (never forwarded verbatim)', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };
  const res = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Choice', options: ['yes', 'no'] },
    context: 'ship it?',
    samples: 4,
  }), env);
  assert.strictEqual(res.status, 200);
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.model, 'jev-latest');
  assert.strictEqual(sent.state, 'ship it?');
  assert.strictEqual(sent.questions.decision.type, 'choice');
  assert.deepStrictEqual(sent.questions.decision.options, ['yes', 'no']);
  assert.strictEqual(sent.samples, undefined, 'legacy samples has no wire counterpart — dropped by design');
  assert.strictEqual(sent.schema, undefined);
  assert.strictEqual(sent.context, undefined);

  // Legacy Noul maps instructions from context.
  const calls2 = withMockFetch(t, async () => jsonResponse(SYSTEMONE_UPSTREAM));
  const env2 = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };
  await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'Noul' }, context: 'decide carefully',
  }), env2);
  const sent2 = JSON.parse(calls2[0].init.body);
  assert.strictEqual(sent2.questions.decision.type, 'noul');
  assert.strictEqual(sent2.questions.decision.instructions, 'decide carefully');

  // Legacy with unknown schema type → 400, no upstream call.
  const bad = await handleLiveKeys(postJson('/api/systemone', {
    schema: { type: 'FreeText' }, context: 'x',
  }), env);
  assert.strictEqual(bad.status, 400);
});

// --- 3. upstream non-2xx passthrough ----------------------------------------

test('systemone: upstream 402 and 500 pass through status + body verbatim', async (t) => {
  const calls = withMockFetch(t, async (_url, init) => {
    const sent = JSON.parse(init.body);
    if (sent.state === 'pay') return jsonResponse({ error: 'quota exhausted' }, 402);
    return jsonResponse({ error: 'internal boom' }, 500);
  });
  const env = { TYPESAFEAI_KEY: 'k', CACHE: mapKv() };

  const r402 = await handleLiveKeys(postJson('/api/systemone', {
    state: 'pay', questions: { q: { type: 'noul', question: 'ok?' } },
  }), env);
  assert.strictEqual(r402.status, 402);
  assert.strictEqual(await r402.text(), JSON.stringify({ error: 'quota exhausted' }));

  const r500 = await handleLiveKeys(postJson('/api/systemone', {
    state: 'boom', questions: { q: { type: 'noul', question: 'ok?' } },
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
  const res = await handleLiveKeys(postJson('/api/systemone', trueShapeBody()), env, { timeoutMs: 30 });
  assert.strictEqual(res.status, 504);
  const body = await res.json();
  assert.strictEqual(body.error, 'upstream_timeout');
});

// --- 5. missing key → 503 key_not_deployed ----------------------------------

test('systemone: missing TYPESAFEAI_KEY → 503 key_not_deployed', async (t) => {
  const calls = withMockFetch(t, async () => jsonResponse({}));
  const env = { CACHE: mapKv() };
  const res = await handleLiveKeys(postJson('/api/systemone', trueShapeBody()), env);
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
      state: `req ${i}`, questions: { q: { type: 'noul', question: 'ok?' } },
    }), env);
    statuses.push(res.status);
  }
  assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
  assert.strictEqual((await handleLiveKeys(postJson('/api/systemone', {
    state: 'again', questions: { q: { type: 'noul', question: 'ok?' } },
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
  const res = await handleLiveKeys(postJson('/api/systemone', trueShapeBody()), env);

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
  const res = await handleLiveKeys(postJson('/api/systemone', trueShapeBody()), env);
  assert.strictEqual(res.status, 200);
  const inserts = db.rows.filter(r => /INSERT OR IGNORE INTO ocean_calls/.test(r.sql));
  assert.strictEqual(inserts.length, 1);
  const row = inserts[0].args;
  assert.strictEqual(row[1], '/api/systemone');
  assert.strictEqual(row[3], 200);
  assert.strictEqual(row[7], '', 'chain_hash is owned by the ocean-api sibling branch');
});
