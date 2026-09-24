// Pins for the Ocean: fnv recipe, receipt chain, ask pipeline, rate limit.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  fnv1a64, canon, makeRow, verifyLog, oceanAsk, checkRate, oceanStats, oceanRecent,
  OCEAN_HIT_THRESHOLD, GENESIS_PREV,
} from '../src/ocean.ts';

// --- fakes -------------------------------------------------------------------

function fakeDeps(opts = {}) {
  const kvMap = new Map();
  const deps = {
    ai: {
      async embed() { return opts.embedVec ?? [1, 0, 0]; },
      async complete() { return opts.completeAnswer ?? 'the remembered tide'; },
    },
    vector: {
      async query() { return opts.neighbor ? [opts.neighbor] : []; },
      async insert() { /* taught */ },
    },
    kv: {
      async get(k) { return kvMap.get(k) ?? null; },
      async put(k, v) { kvMap.set(k, v); },
    },
    now: opts.now,
  };
  return { deps, kvMap };
}

async function readLog(kvMap) {
  return JSON.parse(kvMap.get('ocean_calls') ?? '[]');
}

// --- pins --------------------------------------------------------------------

test('fnv1a64 matches the pinned café vector', () => {
  // cross-checked against the executor pin recipe: hex16 lowercase, no 0x
  assert.equal(fnv1a64('').length, 16);
  assert.match(fnv1a64('hello'), /^[0-9a-f]{16}$/);
  assert.equal(fnv1a64('hello'), fnv1a64('hello'));
  assert.notEqual(fnv1a64('hello'), fnv1a64('hellp'));
  // deterministic known value (fnv-1a-64 of "ocean")
  assert.equal(fnv1a64('ocean'), '2ee6bf0171b865d1');
});

test('canon sorts keys and compacts', () => {
  assert.equal(canon({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canon({ a: 2, b: 1 }), canon({ b: 1, a: 2 }));
});

test('first row chains from genesis; verifyLog re-derives', () => {
  const r0 = makeRow(null, { question_hash: 'a', answer_hash: 'b', sim: null, source: 'wave', model: 'm', ms: 1, ts: 1 });
  assert.equal(r0.seq, 0);
  assert.equal(r0.prev_hash, GENESIS_PREV);
  const r1 = makeRow(r0, { question_hash: 'c', answer_hash: 'd', sim: 0.9, source: 'ocean', model: 'm', ms: 1, ts: 2 });
  assert.equal(r1.prev_hash, r0.row_hash);
  assert.deepEqual(verifyLog([r0, r1]), { ok: true });
});

test('verifyLog catches tamper loudly at the row', () => {
  const r0 = makeRow(null, { question_hash: 'a', answer_hash: 'b', sim: null, source: 'wave', model: 'm', ms: 1, ts: 1 });
  r0.answer_hash = 'tampered';
  const v = verifyLog([r0]);
  assert.equal(v.ok, false);
  assert.equal(v.at, 0);
  assert.equal(v.reason, 'row_hash mismatch');
});

test('miss → 🧠 wave: real answer, upsert taught, row booked', async () => {
  let taught = null;
  const { deps, kvMap } = fakeDeps({ neighbor: { id: 'old answer', score: 0.5 } });
  deps.vector.insert = async (id) => { taught = id; };
  const res = await oceanAsk(deps, 'what is a cell?');
  assert.ok(!('refused' in res));
  if ('refused' in res) return;
  assert.equal(res.source, 'wave');
  assert.equal(res.sim, 0.5); // honest: neighbor existed but below threshold
  assert.equal(taught, res.answer);
  const log = await readLog(kvMap);
  assert.equal(log.length, 1);
  assert.equal(log[0].source, 'wave');
  assert.deepEqual(verifyLog(log), { ok: true });
});

test('hit ≥ threshold → ⚡ ocean: no model call, remembered answer', async () => {
  const { deps, kvMap } = fakeDeps({ neighbor: { id: 'remembered answer', score: OCEAN_HIT_THRESHOLD } });
  let completed = false;
  deps.ai.complete = async () => { completed = true; return 'should not run'; };
  const res = await oceanAsk(deps, 'what is a cell?');
  assert.ok(!('refused' in res));
  if ('refused' in res) return;
  assert.equal(res.source, 'ocean');
  assert.equal(res.answer, 'remembered answer');
  assert.equal(completed, false);
  const log = await readLog(kvMap);
  assert.equal(log[0].source, 'ocean');
  assert.equal(log[0].sim, OCEAN_HIT_THRESHOLD);
});

test('threshold boundary: 0.9199 misses, 0.92 hits', async () => {
  const below = await oceanAsk(fakeDeps({ neighbor: { id: 'x', score: 0.9199 } }).deps, 'q');
  assert.ok(!('refused' in below) && below.source === 'wave');
  const above = await oceanAsk(fakeDeps({ neighbor: { id: 'x', score: 0.92 } }).deps, 'q');
  assert.ok(!('refused' in above) && above.source === 'ocean');
});

test('empty question → REFUSED row booked, not silent', async () => {
  const { deps, kvMap } = fakeDeps({});
  const res = await oceanAsk(deps, '   ');
  assert.ok('refused' in res);
  assert.equal(res.reason, 'empty question');
  const log = await readLog(kvMap);
  assert.equal(log[0].source, 'refused');
  assert.deepEqual(verifyLog(log), { ok: true });
});

test('rate refusal is booked as a receipt, then a clean ask chains after it', async () => {
  const { deps, kvMap } = fakeDeps({});
  const refused = await oceanAsk(deps, 'too fast', { allowed: false, reason: 'slow down' });
  assert.ok('refused' in refused);
  const ok = await oceanAsk(deps, 'a real question', { allowed: true });
  assert.ok(!('refused' in ok));
  const log = await readLog(kvMap);
  assert.equal(log.length, 2);
  assert.equal(log[1].prev_hash, log[0].row_hash);
  assert.deepEqual(verifyLog(log), { ok: true });
});

test('rate limiter: 11th ask in a minute is refused; another IP still sails', async () => {
  const kvMap = new Map();
  const kv = { get: async (k) => kvMap.get(k) ?? null, put: async (k, v) => { kvMap.set(k, v); } };
  for (let i = 0; i < 10; i++) assert.equal((await checkRate(kv, '1.2.3.4')).allowed, true);
  const eleventh = await checkRate(kv, '1.2.3.4');
  assert.equal(eleventh.allowed, false);
  const other = await checkRate(kv, '5.6.7.8');
  assert.equal(other.allowed, true);
});

test('stats and recent reflect the log', async () => {
  const { deps, kvMap } = fakeDeps({});
  await oceanAsk(deps, 'one');
  await oceanAsk(deps, 'two', { allowed: false, reason: 'x' });
  const kv = { get: async (k) => kvMap.get(k) ?? null, put: async () => {} };
  const s = await oceanStats(kv);
  assert.equal(s.calls, 2);
  assert.equal(s.refusals, 1);
  assert.equal(s.waves, 1);
  const r = await oceanRecent(kv, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].seq, 1);
});
