// =============================================================================
//  ocean.ts — The Ocean: a witnessed, self-cheapening inference surface
// =============================================================================
//  Every call is embedded and looked up in Vectorize. A close hit (>= 0.92)
//  is served from the ocean (⚡wave). A miss runs a real Workers AI model
//  (🧠) and the new (question, answer) pair is upserted, so the next stranger
//  sailing the same water gets the cheap path. Every call — hit or miss —
//  is booked as a row in an fnv-1a-64 hash-chained receipt log, the witness
//  idiom: the ocean remembers what it was asked and what it answered.
//
//  This module is deliberately runtime-agnostic: all Cloudflare bindings are
//  injected as narrow interfaces, so the pins run under plain node:test with
//  fakes. The route glue lives in worker.ts.
// =============================================================================

import {
  tideGate, tideIsOut, tideSpend,
  HOURLY_CAP_USD, tideWindowBudgetMicro,
} from './tide.ts';

export {
  createTideWindow, estimateCostMicroUsd, readTideWindow, tideGate, tideIsOut, tideSpend, tideStats,
  HOURLY_CAP_USD, TIDE_KV_KEY, tideWindowBudgetMicro,
  WINDOW_MIN_MINUTES, WINDOW_MAX_MINUTES,
  type TideGate, type TideWindow,
} from './tide.ts';

export const OCEAN_HIT_THRESHOLD = 0.92;
export const OCEAN_LOG_KEY = 'ocean_calls';
export const OCEAN_LOG_CAP = 5000;
export const OCEAN_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

// Per-IP token bucket: 10/min, 100/day — unchanged, and still checked before
// the tide. The old flat 5000/day global counter is gone: the global limit is
// now the dollar-metered leaky tide in tide.ts (HOURLY_CAP_USD per hour).
export const RATE_PER_MINUTE = 10;
export const RATE_PER_DAY_IP = 100;

// fnv-1a 64-bit, hex16 lowercase, no 0x — the same recipe the executor
// pins, so a row born here re-derives anywhere the chart is known.
export function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

// Canonical row form: JSON with sorted keys, compact separators — the chart
// rule. A row must re-derive from its printed form alone.
export function canon(row: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) sorted[k] = row[k];
  return JSON.stringify(sorted);
}

export interface OceanRow {
  seq: number;
  prev_hash: string;
  question_hash: string;
  answer_hash: string;
  sim: number | null;   // null on a 🧠 wave (no prior neighbor)
  source: 'ocean' | 'wave' | 'refused';
  model: string;
  ms: number;
  ts: number;           // epoch ms
  row_hash: string;
}

export const GENESIS_PREV = '0'.repeat(16);

export function makeRow(
  prev: Pick<OceanRow, 'seq' | 'row_hash'> | null,
  fields: Omit<OceanRow, 'seq' | 'prev_hash' | 'row_hash'>,
): OceanRow {
  const seq = prev ? prev.seq + 1 : 0;
  const prev_hash = prev ? prev.row_hash : GENESIS_PREV;
  const body = canon({ ...fields, prev_hash, seq });
  return { ...fields, seq, prev_hash, row_hash: fnv1a64(body) };
}

export function verifyLog(rows: OceanRow[]): { ok: boolean; at?: number; reason?: string } {
  let prev: Pick<OceanRow, 'seq' | 'row_hash'> | null = null;
  for (const row of rows) {
    const expectSeq = prev ? prev.seq + 1 : 0;
    if (row.seq !== expectSeq) return { ok: false, at: row.seq, reason: 'seq gap' };
    if (row.prev_hash !== (prev ? prev.row_hash : GENESIS_PREV))
      return { ok: false, at: row.seq, reason: 'prev_hash mismatch' };
    const { row_hash, ...rest } = row;
    if (fnv1a64(canon(rest)) !== row_hash)
      return { ok: false, at: row.seq, reason: 'row_hash mismatch' };
    prev = row;
  }
  return { ok: true };
}

// --- narrow binding interfaces (faked in tests) -----------------------------

export interface OceanAI {
  embed(text: string): Promise<number[]>;
  complete(prompt: string): Promise<string>;
}

export interface OceanVector {
  // returns [{ id, score, metadata? }] best-first
  query(vec: number[], topK: number): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>>;
  insert(id: string, vec: number[], metadata: Record<string, unknown>): Promise<void>;
}

export interface OceanKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

// --- the ask pipeline -------------------------------------------------------

export interface OceanDeps {
  ai: OceanAI;
  vector: OceanVector;
  kv: OceanKV;
  now?: () => number;
  rand?: () => number; // tide window dice; defaults to Math.random
}

export interface OceanAnswer {
  answer: string;
  source: 'ocean' | 'wave';
  sim: number | null;
  row: OceanRow;
  // Present on an ⚡ hit served while the tide is out: fresh inference is
  // budget-blocked, but the ocean still answers from memory.
  tide?: 'serving_from_memory';
}

export interface TideOutInfo {
  retry_after_seconds: number;
  budget_window_usd: number;
  hourly_cap_usd: number;
}

export type OceanResult =
  | OceanAnswer
  | { refused: true; reason: string; row: OceanRow; tide?: TideOutInfo; bottled?: BottleInfo };

export async function loadLog(kv: OceanKV): Promise<OceanRow[]> {
  const raw = await kv.get(OCEAN_LOG_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as OceanRow[];
}

export async function oceanAsk(
  deps: OceanDeps,
  question: string,
  rate?: { allowed: boolean; reason?: string },
): Promise<OceanResult> {
  const now = deps.now ?? Date.now;
  const rand = deps.rand ?? Math.random;
  const log = await loadLog(deps.kv);
  const prev = log.length ? log[log.length - 1] : null;

  const refuse = async (reason: string, tide?: TideOutInfo, bottled?: BottleInfo) => {
    const row = makeRow(prev, {
      question_hash: fnv1a64(question),
      answer_hash: fnv1a64(''),
      sim: null,
      source: 'refused',
      model: OCEAN_MODEL,
      ms: 0,
      ts: now(),
    });
    await appendLog(deps.kv, [...log, row]);
    return {
      refused: true as const,
      reason,
      row,
      ...(tide ? { tide } : {}),
      ...(bottled ? { bottled } : {}),
    };
  };

  if (rate && !rate.allowed) return refuse(rate.reason ?? 'rate limited');
  const q = (question ?? '').trim();
  if (!q) return refuse('empty question');
  if (q.length > 2000) return refuse('question too long');

  const t0 = now();
  const vec = await deps.ai.embed(q);
  const neighbors = await deps.vector.query(vec, 1);
  const best = neighbors[0];

  const remembered = best && best.score >= OCEAN_HIT_THRESHOLD
    && typeof best.metadata?.answer === 'string' && (best.metadata.answer as string).length > 0;
  if (remembered) {
    // ⚡ ocean: serve the remembered answer. Hits bypass the budget by
    // design — Vectorize dims cost ~$0.000008 and the first 30M/mo are free.
    // When the tide is out we still answer 200, flagged, instead of queuing
    // behind fresh inference: the ocean gets cheaper under load.
    // The vector id is fnv1a64(answer); the answer text rides in metadata.
    const answer = (best!.metadata as Record<string, unknown>).answer as string;
    const tideOut = await tideIsOut(deps.kv, q, now());
    const row = makeRow(prev, {
      question_hash: fnv1a64(q),
      answer_hash: fnv1a64(answer),
      sim: best.score,
      source: 'ocean',
      model: OCEAN_MODEL,
      ms: now() - t0,
      ts: now(),
    });
    await appendLog(deps.kv, [...log, row]);
    return {
      answer,
      source: 'ocean',
      sim: best.score,
      row,
      ...(tideOut ? { tide: 'serving_from_memory' as const } : {}),
    };
  }

  // 🧠 wave: fresh inference — the only path the tide meters. Reserve the
  // estimated cost before the model call; an expired window is rolled fresh
  // by tideGate, so a new tide always answers the first sailor.
  const gate = await tideGate(deps.kv, q, now(), rand);
  if (!gate.allowed) {
    // Low tide: don't just refuse — bottle the question. It waits in the
    // queue and gets answered INTO the ocean when the tide returns, so a
    // 429 becomes a deferred contribution to the commons instead of a
    // dead request. The oldest accepted problem — "rate-limited means
    // lost" — ends here.
    const bottled = await bottleQuestion(deps.kv, q, now());
    return refuse('the tide is out — fresh inference budget exhausted', {
      retry_after_seconds: gate.retryAfterSeconds,
      budget_window_usd: tideWindowBudgetMicro(gate.window.window_minutes) / 1_000_000,
      hourly_cap_usd: HOURLY_CAP_USD,
    }, bottled);
  }
  await tideSpend(deps.kv, gate);
  const answer = await deps.ai.complete(q);
  // Vectorize caps ids at 64 bytes; the answer text cannot be the id (the
  // first wave ever crashed on this: VECTOR_INSERT_ERROR 40008, 348 bytes).
  // The id is the chart-recipe hash; the text rides home in metadata.
  await deps.vector.insert(fnv1a64(answer), vec, { q, answer });
  const row = makeRow(prev, {
    question_hash: fnv1a64(q),
    answer_hash: fnv1a64(answer),
    sim: best ? best.score : null,
    source: 'wave',
    model: OCEAN_MODEL,
    ms: now() - t0,
    ts: now(),
  });
  await appendLog(deps.kv, [...log, row]);
  return { answer, source: 'wave', sim: best ? best.score : null, row };
}

// --- bottles: questions caught at low tide, answered when it returns --------

export const BOTTLES_KEY = 'ocean:bottles';
export const BOTTLES_CAP = 50;
// tide.ts math: a 4-word ask prices at 18 µ$ — the ledger's rough per-row unit.
export const FRESH_COST_ESTIMATE_MICRO = 18;

export interface Bottle { q_hash: string; q: string; ts: number }
export interface BottleInfo { id: string; queue_position: number }
export interface DrainResult { drained: 0 | 1; reason?: string; row?: OceanRow }

export async function bottleQuestion(kv: OceanKV, q: string, nowMs: number): Promise<BottleInfo> {
  const raw = await kv.get(BOTTLES_KEY);
  const bottles: Bottle[] = raw ? JSON.parse(raw) : [];
  const bottle: Bottle = { q_hash: fnv1a64(q), q, ts: nowMs };
  const next = [...bottles, bottle].slice(-BOTTLES_CAP);
  await kv.put(BOTTLES_KEY, JSON.stringify(next));
  return { id: bottle.q_hash, queue_position: next.length };
}

// Answer ONE bottled question per drain, only while the tide is in, and
// teach it to the ocean — the deferred ask becomes a permanent wave that
// serves every future sailor for free.
export async function drainBottles(deps: OceanDeps): Promise<DrainResult> {
  const now = deps.now ?? Date.now;
  const rand = deps.rand ?? Math.random;
  const log = await loadLog(deps.kv);
  const prev = log.length ? log[log.length - 1] : null;
  const raw = await deps.kv.get(BOTTLES_KEY);
  const bottles: Bottle[] = raw ? JSON.parse(raw) : [];
  if (!bottles.length) return { drained: 0, reason: 'no bottles' };

  const oldest = bottles[0];
  const gate = await tideGate(deps.kv, oldest.q, now(), rand);
  if (!gate.allowed) return { drained: 0, reason: 'tide_out' };
  await tideSpend(deps.kv, gate);

  const t0 = now();
  const vec = await deps.ai.embed(oldest.q);
  const answer = await deps.ai.complete(oldest.q);
  await deps.vector.insert(fnv1a64(answer), vec, { q: oldest.q, answer });
  const neighbors = await deps.vector.query(vec, 1);
  const sim = neighbors[0]?.score ?? null;
  const row = makeRow(prev, {
    question_hash: fnv1a64(oldest.q),
    answer_hash: fnv1a64(answer),
    sim,
    source: 'bottle',
    model: OCEAN_MODEL,
    ms: now() - t0,
    ts: now(),
  });
  await appendLog(deps.kv, [...log, row]);
  await deps.kv.put(BOTTLES_KEY, JSON.stringify(bottles.slice(1)));
  return { drained: 1, row };
}

async function appendLog(kv: OceanKV, rows: OceanRow[]): Promise<void> {
  await kv.put(OCEAN_LOG_KEY, JSON.stringify(rows.slice(-OCEAN_LOG_CAP)));
}

// --- rate limiting (token bucket in KV, honest best-effort) -----------------

export function bucketKeys(ip: string, day: string): { min: string; day: string } {
  const safe = fnv1a64(ip);
  return {
    min: `ocean_rate:min:${safe}:${day}:${Math.floor(Date.now() / 60000)}`,
    day: `ocean_rate:day:${safe}:${day}`,
  };
}

export interface RateDecision { allowed: boolean; reason?: string; headers?: Record<string, string> }

// Per-IP only. The flat global counter this function used to keep is replaced
// by the tide (tide.ts): a dollar budget is a strictly better global limit —
// it bounds cost, not ask-count, so a memory-heavy hour answers thousands of
// ⚡ hits while fresh inference spends real cents.
export async function checkRate(kv: OceanKV, ip: string): Promise<RateDecision> {
  const day = new Date().toISOString().slice(0, 10);
  const keys = bucketKeys(ip, day);
  const d = Number(await kv.get(keys.day) ?? '0');
  if (d >= RATE_PER_DAY_IP) return { allowed: false, reason: 'daily per-sailor limit reached' };
  const m = Number(await kv.get(keys.min) ?? '0');
  if (m >= RATE_PER_MINUTE) return { allowed: false, reason: 'slow down — 10 questions per minute' };
  await kv.put(keys.min, String(m + 1));
  await kv.put(keys.day, String(d + 1));
  return { allowed: true };
}

// --- views -------------------------------------------------------------------

export async function oceanStats(kv: OceanKV): Promise<{
  calls: number;
  ocean_hits: number;
  waves: number;
  refusals: number;
  bottles_drained: number;
  hit_rate: number;
  tip: string | null;
  saved_micro_usd: number;
  spent_micro_usd: number;
  net_micro_usd: number;
  bottles_waiting: number;
}> {
  const log = await loadLog(kv);
  const hits = log.filter(r => r.source === 'ocean').length;
  const waves = log.filter(r => r.source === 'wave').length;
  const drained = log.filter(r => r.source === 'bottle').length;
  const raw = await kv.get(BOTTLES_KEY);
  const waiting = raw ? (JSON.parse(raw) as Bottle[]).length : 0;
  // The ledger: every ⚡ hit avoided a fresh inference; every 🧠 wave (and
  // drained bottle) paid one. Rough per-row estimate, clearly labeled.
  const saved = hits * FRESH_COST_ESTIMATE_MICRO;
  const spent = (waves + drained) * FRESH_COST_ESTIMATE_MICRO;
  return {
    calls: log.length,
    ocean_hits: hits,
    waves,
    refusals: log.filter(r => r.source === 'refused').length,
    bottles_drained: drained,
    hit_rate: log.length ? hits / log.length : 0,
    tip: log.length ? log[log.length - 1].row_hash : null,
    saved_micro_usd: saved,
    spent_micro_usd: spent,
    net_micro_usd: saved - spent,
    bottles_waiting: waiting,
  };
}

export async function oceanRecent(kv: OceanKV, n = 20): Promise<Array<Pick<OceanRow, 'seq' | 'source' | 'sim' | 'ms' | 'ts' | 'row_hash'>>> {
  const log = await loadLog(kv);
  return log.slice(-n).map(({ seq, source, sim, ms, ts, row_hash }) => ({ seq, source, sim, ms, ts, row_hash }));
}
