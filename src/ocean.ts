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

export const OCEAN_HIT_THRESHOLD = 0.92;
export const OCEAN_LOG_KEY = 'ocean_calls';
export const OCEAN_LOG_CAP = 5000;
export const OCEAN_MODEL = '@cf/meta/llama-3-8b-instruct';

// Per-IP token bucket: 10/min, 100/day. Global safety: 5000/day.
export const RATE_PER_MINUTE = 10;
export const RATE_PER_DAY_IP = 100;
export const RATE_PER_DAY_GLOBAL = 5000;

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
  // returns [{ id, score }] best-first
  query(vec: number[], topK: number): Promise<Array<{ id: string; score: number }>>;
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
}

export interface OceanAnswer {
  answer: string;
  source: 'ocean' | 'wave';
  sim: number | null;
  row: OceanRow;
}

export async function loadLog(kv: OceanKV): Promise<OceanRow[]> {
  const raw = await kv.get(OCEAN_LOG_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as OceanRow[];
}

export async function oceanAsk(
  deps: OceanDeps,
  question: string,
  rate?: { allowed: boolean; reason?: string },
): Promise<OceanAnswer | { refused: true; reason: string; row: OceanRow }> {
  const now = deps.now ?? Date.now;
  const log = await loadLog(deps.kv);
  const prev = log.length ? log[log.length - 1] : null;

  const refuse = async (reason: string) => {
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
    return { refused: true as const, reason, row };
  };

  if (rate && !rate.allowed) return refuse(rate.reason ?? 'rate limited');
  const q = (question ?? '').trim();
  if (!q) return refuse('empty question');
  if (q.length > 2000) return refuse('question too long');

  const t0 = now();
  const vec = await deps.ai.embed(q);
  const neighbors = await deps.vector.query(vec, 1);
  const best = neighbors[0];

  if (best && best.score >= OCEAN_HIT_THRESHOLD) {
    // ⚡ ocean: serve the remembered answer
    const answer = best.id; // vector id IS the answer text (see worker glue)
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
    return { answer, source: 'ocean', sim: best.score, row };
  }

  // 🧠 wave: real inference, then teach the ocean
  const answer = await deps.ai.complete(q);
  await deps.vector.insert(answer, vec, { q, answer });
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

async function appendLog(kv: OceanKV, rows: OceanRow[]): Promise<void> {
  await kv.put(OCEAN_LOG_KEY, JSON.stringify(rows.slice(-OCEAN_LOG_CAP)));
}

// --- rate limiting (token bucket in KV, honest best-effort) -----------------

export function bucketKeys(ip: string, day: string): { min: string; day: string; global: string } {
  const safe = fnv1a64(ip);
  return {
    min: `ocean_rate:min:${safe}:${day}:${Math.floor(Date.now() / 60000)}`,
    day: `ocean_rate:day:${safe}:${day}`,
    global: `ocean_rate:global:${day}`,
  };
}

export interface RateDecision { allowed: boolean; reason?: string; headers?: Record<string, string> }

export async function checkRate(kv: OceanKV, ip: string): Promise<RateDecision> {
  const day = new Date().toISOString().slice(0, 10);
  const keys = bucketKeys(ip, day);
  const g = Number(await kv.get(keys.global) ?? '0');
  if (g >= RATE_PER_DAY_GLOBAL) return { allowed: false, reason: 'ocean is at its daily global limit' };
  const d = Number(await kv.get(keys.day) ?? '0');
  if (d >= RATE_PER_DAY_IP) return { allowed: false, reason: 'daily per-sailor limit reached' };
  const m = Number(await kv.get(keys.min) ?? '0');
  if (m >= RATE_PER_MINUTE) return { allowed: false, reason: 'slow down — 10 questions per minute' };
  await kv.put(keys.min, String(m + 1));
  await kv.put(keys.day, String(d + 1));
  await kv.put(keys.global, String(g + 1));
  return { allowed: true };
}

// --- views -------------------------------------------------------------------

export async function oceanStats(kv: OceanKV): Promise<{
  calls: number;
  ocean_hits: number;
  waves: number;
  refusals: number;
  hit_rate: number;
  tip: string | null;
}> {
  const log = await loadLog(kv);
  const hits = log.filter(r => r.source === 'ocean').length;
  const waves = log.filter(r => r.source === 'wave').length;
  return {
    calls: log.length,
    ocean_hits: hits,
    waves,
    refusals: log.filter(r => r.source === 'refused').length,
    hit_rate: log.length ? hits / log.length : 0,
    tip: log.length ? log[log.length - 1].row_hash : null,
  };
}

export async function oceanRecent(kv: OceanKV, n = 20): Promise<Array<Pick<OceanRow, 'seq' | 'source' | 'sim' | 'ms' | 'ts' | 'row_hash'>>> {
  const log = await loadLog(kv);
  return log.slice(-n).map(({ seq, source, sim, ms, ts, row_hash }) => ({ seq, source, sim, ms, ts, row_hash }));
}
