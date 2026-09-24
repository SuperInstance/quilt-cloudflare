// Pins for the Ocean: fnv recipe, receipt chain, ask pipeline, rate limit.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  fnv1a64, canon, makeRow, verifyLog, oceanAsk, checkRate, oceanStats, oceanRecent,
  OCEAN_HIT_THRESHOLD, GENESIS_PREV,
  createTideWindow, estimateCostMicroUsd, tideGate, tideStats, tideWindowBudgetMicro,
  HOURLY_CAP_USD, TIDE_KV_KEY, WINDOW_MIN_MINUTES, WINDOW_MAX_MINUTES,
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

// fake with a live clock and a dice queue, for tide pins
function tideDeps(opts = {}) {
  const kvMap = new Map();
  const state = { t: opts.t ?? 1_700_000_000_000, queue: [...(opts.rands ?? [0.5])], neighbor: opts.neighbor ?? null };
  let completions = 0;
  const deps = {
    ai: {
      async embed() { return [1, 0, 0]; },
      async complete() { completions++; return 'the remembered tide'; },
    },
    vector: {
      async query() { return state.neighbor ? [state.neighbor] : []; },
      async insert() { /* taught */ },
    },
    kv: {
      async get(k) { return kvMap.get(k) ?? null; },
      async put(k, v) { kvMap.set(k, v); },
    },
    now: () => state.t,
    rand: () => state.queue.length > 1 ? state.queue.shift() : state.queue[0],
  };
  return {
    deps, kvMap, state,
    completions: () => completions,
    setNeighbor(n) { state.neighbor = n; },
    setNow(t) { state.t = t; },
    readWindow: async () => JSON.parse(kvMap.get(TIDE_KV_KEY) ?? 'null'),
  };
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

// --- the tide: dollar-metered leaky windows (pins 11–16) --------------------

test('pin 11: first ask rolls a window — minutes in [2,20], budget = 0.02×min/60 ±1µ$', async () => {
  // dice boundaries: 0 → 2min, 0.999… → 20min (uniform int over [2,20])
  assert.equal(createTideWindow(0, () => 0).window_minutes, WINDOW_MIN_MINUTES);
  assert.equal(createTideWindow(0, () => 0.999999).window_minutes, WINDOW_MAX_MINUTES);

  const td = tideDeps({ rands: [0.5] }); // → 11 minutes
  const res = await oceanAsk(td.deps, 'what is a cell?'); // miss → wave, meters one call
  assert.ok(!('refused' in res) && res.source === 'wave');
  const w = await td.readWindow();
  assert.equal(w.window_minutes, 11);
  const expected = tideWindowBudgetMicro(11) - estimateCostMicroUsd('what is a cell?');
  assert.ok(Math.abs(w.remaining_micro_usd - expected) <= 1, `remaining ${w.remaining_micro_usd} ≈ ${expected}`);
  assert.ok(w.reset_at_ms > td.state.t);
});

test('pin 12: budget exhausted → tide_out with retry_after and hourly_cap_usd 0.02', async () => {
  const td = tideDeps({ rands: [0.5] }); // 11-min window ≈ 3666.67 µ$; the ask costs 18 µ$
  let last;
  for (let i = 0; i < 500; i++) {
    last = await oceanAsk(td.deps, 'what is a cell?');
    if ('refused' in last) break;
  }
  assert.ok('refused' in last, 'budget must run dry');
  assert.match(last.reason, /tide is out/);
  assert.ok(last.tide, 'tide payload present');
  assert.ok(last.tide.retry_after_seconds > 0);
  assert.ok(last.tide.retry_after_seconds <= 11 * 60);
  assert.equal(last.tide.hourly_cap_usd, HOURLY_CAP_USD);
  assert.ok(Math.abs(last.tide.budget_window_usd - tideWindowBudgetMicro(11) / 1e6) < 1e-9);
  const w = await td.readWindow();
  assert.ok(w.remaining_micro_usd >= 0 && w.remaining_micro_usd < estimateCostMicroUsd('what is a cell?'));
  const log = JSON.parse(td.kvMap.get('ocean_calls') ?? '[]');
  assert.deepEqual(verifyLog(log), { ok: true }); // the refusal is witnessed too
  assert.equal(log[log.length - 1].source, 'refused');
});

test('pin 13: ocean hit during tide-out still answers 200-equivalent from memory', async () => {
  const td = tideDeps({ rands: [0.5] });
  let last;
  for (let i = 0; i < 500; i++) {
    last = await oceanAsk(td.deps, 'what is a cell?');
    if ('refused' in last) break;
  }
  assert.ok('refused' in last);
  const before = (await td.readWindow()).remaining_micro_usd;
  const completed = td.completions();

  td.setNeighbor({ id: 'the remembered tide', score: 0.99 });
  const hit = await oceanAsk(td.deps, 'what is a cell?');
  assert.ok(!('refused' in hit), 'hit is never budget-blocked');
  assert.equal(hit.source, 'ocean');
  assert.equal(hit.answer, 'the remembered tide');
  assert.equal(hit.tide, 'serving_from_memory');
  assert.equal(td.completions(), completed, 'no model call on a hit');
  assert.equal((await td.readWindow()).remaining_micro_usd, before, 'hits never spend');
  const log = JSON.parse(td.kvMap.get('ocean_calls') ?? '[]');
  assert.equal(log[log.length - 1].source, 'ocean');
  assert.deepEqual(verifyLog(log), { ok: true });
});

test('pin 14: window rollover — advance past reset_at → fresh budget, new random minutes', async () => {
  const td = tideDeps({ rands: [0.5, 0.9] }); // W1 11min, W2 19min
  await oceanAsk(td.deps, 'what is a cell?');
  const w1 = await td.readWindow();
  assert.equal(w1.window_minutes, 11);

  td.setNow(w1.reset_at_ms + 1);
  const res = await oceanAsk(td.deps, 'another question here');
  assert.ok(!('refused' in res));
  const w2 = await td.readWindow();
  assert.equal(w2.window_minutes, 19);
  assert.equal(w2.reset_at_ms, td.state.t + 19 * 60_000);
  const expected = tideWindowBudgetMicro(19) - estimateCostMicroUsd('another question here');
  assert.ok(Math.abs(w2.remaining_micro_usd - expected) <= 1, 'budget restored minus this call');
});

test('pin 15: hourly invariant — a simulated hour of windows sums to 0.02 USD ±2%', async () => {
  // scripted dice → 11 + 19 + 10 + 20 = exactly 60 minutes
  const rands = [0.5, 0.9, 8 / 19, 18 / 19];
  const kvMap = new Map();
  const kv = { get: async (k) => kvMap.get(k) ?? null, put: async (k, v) => { kvMap.set(k, v); } };
  let now = 1_700_000_000_000;
  let i = 0;
  const rand = () => (i < rands.length ? rands[i++] : rands[rands.length - 1]);
  let total = 0;
  for (let w = 0; w < 4; w++) {
    const gate = await tideGate(kv, 'q', now, rand);
    total += tideWindowBudgetMicro(gate.window.window_minutes);
    now = gate.window.reset_at_ms + 1; // sail just past the reset → next window rolls
  }
  const expectedMicro = HOURLY_CAP_USD * 1e6;
  assert.ok(Math.abs(total - expectedMicro) <= expectedMicro * 0.02,
    `window budgets summed ${total} µ$ vs hourly cap ${expectedMicro} µ$`);
});

test('pin 16: tideStats exposes the budget fields and never throws', async () => {
  const kvMap = new Map();
  const kv = { get: async (k) => kvMap.get(k) ?? null, put: async (k, v) => { kvMap.set(k, v); } };

  const empty = await tideStats(kv, 1_700_000_000_000);
  assert.equal(empty.hourly_cap_usd, 0.02);
  assert.equal(empty.budget_remaining_usd, 0);
  assert.equal(empty.window_reset_in_seconds, 0);

  const td = tideDeps({ rands: [0.5] });
  await oceanAsk(td.deps, 'what is a cell?');
  const s = await tideStats(td.deps.kv, td.state.t);
  assert.equal(s.hourly_cap_usd, 0.02);
  assert.equal(s.window_minutes, 11);
  assert.ok(Math.abs(s.budget_window_usd - 0.02 * 11 / 60) < 1e-9);
  assert.ok(s.budget_remaining_usd > 0 && s.budget_remaining_usd < s.budget_window_usd);
  assert.equal(s.window_reset_in_seconds, 660);

  kvMap.set(TIDE_KV_KEY, '{corrupt');
  const corrupted = await tideStats(kv, 1_700_000_000_000);
  assert.equal(corrupted.hourly_cap_usd, 0.02);
  assert.equal(corrupted.budget_remaining_usd, 0);
});
