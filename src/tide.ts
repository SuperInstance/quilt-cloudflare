// =============================================================================
//  tide.ts — the leaky tide: a dollar-metered inference budget
// =============================================================================
//  Replaces the old flat 5000/day global counter. The ocean now spends from a
//  real-money budget: HOURLY_CAP_USD per hour, released in semi-random
//  windows of 2–20 minutes. A window's budget is its minutes-fraction of the
//  hourly cap, so Σ(window budgets) == HOURLY_CAP_USD per hour exactly,
//  regardless of how the dice fell (5.45 windows/hour expected).
//
//  Only FRESH INFERENCE is metered. Ocean hits cost ~$0.000008 in Vectorize
//  dims (first 30M dims/mo free) and bypass the budget entirely — when the
//  tide is out, hits still answer 200 with tide:"serving_from_memory". That
//  is the product thesis: the ocean gets cheaper under load.
//
//  UNITS: micro-dollars (1 µ$ = $1e-6), integers for per-call costs. The
//  hourly cap is 0.02 USD = 20_000 µ$. At ~19 µ$/call (4-word prompt,
//  220 est. output tokens) that is ~1000 fresh inferences/hour, ≈ $14.40/mo
//  if fully abused around the clock.
// =============================================================================

export const HOURLY_CAP_USD = 0.02;
export const TIDE_KV_KEY = 'ocean:budget:window';

export const WINDOW_MIN_MINUTES = 2;
export const WINDOW_MAX_MINUTES = 20;

// Cost model — third-party Sept-2026 pricing for llama-3-8b-class inference:
// ≈ $0.05 per 1M input tokens, ≈ $0.08 per 1M output tokens. 1 µ$ = $1e-6, so
// one input token costs 0.05 µ$ and one output token costs 0.08 µ$ directly.
export const COST_INPUT_USD_PER_M = 0.05;
export const COST_OUTPUT_USD_PER_M = 0.08;
export const EST_OUTPUT_TOKENS = 220;   // concise assistant, ≤3 sentences
export const TOKENS_PER_WORD = 1.3;     // empirical English average

const MICRO_USD_PER_DOLLAR = 1_000_000;
export const HOURLY_CAP_MICRO_USD = HOURLY_CAP_USD * MICRO_USD_PER_DOLLAR; // 20_000

export interface TideWindow {
  remaining_micro_usd: number;   // may be fractional: window budgets are 20000×min/60
  reset_at_ms: number;
  window_minutes: number;
}

// A window's whole budget, in micro-dollars, for `windowMinutes` minutes.
// Kept as a pure function so the hourly invariant is auditable in one line.
export function tideWindowBudgetMicro(windowMinutes: number): number {
  return HOURLY_CAP_MICRO_USD * (windowMinutes / 60);
}

// Roll a fresh window. Length is a uniform int in [2, 20] chosen via
// Math.random — the unpredictability IS the anti-farming feature: a farmer
// cannot schedule refreshes around a window whose length they cannot predict.
export function createTideWindow(nowMs: number, rand: () => number = Math.random): TideWindow {
  const span = WINDOW_MAX_MINUTES - WINDOW_MIN_MINUTES + 1;
  const minutes = WINDOW_MIN_MINUTES + Math.floor(rand() * span);
  return {
    remaining_micro_usd: tideWindowBudgetMicro(minutes),
    reset_at_ms: nowMs + minutes * 60_000,
    window_minutes: minutes,
  };
}

// Metered cost of one fresh inference, in integer micro-dollars.
//   est_tokens_in = round(words × 1.3)
//   cost_µ$ = ceil(est_in × 0.05 + 220 × 0.08)     (µ$ per token, see consts)
// A 4-word prompt → est_in 5 → ceil(0.25 + 17.6) = 18 µ$ ≈ $0.000018, matching
// the real third-party price of a short llama-3-8b-class call.
export function estimateCostMicroUsd(prompt: string): number {
  const words = (prompt ?? '').trim().split(/\s+/).filter(Boolean).length;
  const estTokensIn = Math.round(words * TOKENS_PER_WORD);
  return Math.ceil(
    estTokensIn * COST_INPUT_USD_PER_M + EST_OUTPUT_TOKENS * COST_OUTPUT_USD_PER_M,
  );
}

export async function readTideWindow(kv: { get(key: string): Promise<string | null> }): Promise<TideWindow | null> {
  const raw = await kv.get(TIDE_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TideWindow;
  } catch {
    return null; // corrupt state → next gate rolls a fresh window
  }
}

export interface TideGate {
  window: TideWindow;
  costMicro: number;
  allowed: boolean;           // remaining covers this call
  tideOut: boolean;           // !allowed
  retryAfterSeconds: number;  // seconds until the next window rolls in
}

// Read (or roll) the current window and price this question against it.
// Rolls a new window first if the stored one has expired.
export async function tideGate(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> },
  question: string,
  nowMs: number,
  rand: () => number = Math.random,
): Promise<TideGate> {
  let window = await readTideWindow(kv);
  if (!window || nowMs >= window.reset_at_ms) {
    window = createTideWindow(nowMs, rand);
    await kv.put(TIDE_KV_KEY, JSON.stringify(window));
  }
  const costMicro = estimateCostMicroUsd(question);
  const allowed = window.remaining_micro_usd >= costMicro;
  return {
    window,
    costMicro,
    allowed,
    tideOut: !allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((window.reset_at_ms - nowMs) / 1000)),
  };
}

// Spend from the window. NOTE: plain KV get→put — Cloudflare KV has no
// compare-and-swap, so a burst of concurrent asks can overshoot a single
// window slightly. Acceptable: worst case is one window's budget, and the
// hourly invariant holds in expectation.
export async function tideSpend(
  kv: { put(key: string, value: string): Promise<void> },
  gate: TideGate,
): Promise<TideWindow> {
  const window: TideWindow = {
    ...gate.window,
    remaining_micro_usd: gate.window.remaining_micro_usd - gate.costMicro,
  };
  await kv.put(TIDE_KV_KEY, JSON.stringify(window));
  gate.window = window;
  return window;
}

// Is a fresh inference refused right now? Read-only peek used when serving
// ocean hits: a hit arriving while the tide is out answers 200 from memory
// instead of queuing behind fresh inference.
export async function tideIsOut(
  kv: { get(key: string): Promise<string | null> },
  question: string,
  nowMs: number,
): Promise<boolean> {
  const window = await readTideWindow(kv);
  if (!window || nowMs >= window.reset_at_ms) return false; // a fresh window would roll in full
  return window.remaining_micro_usd < estimateCostMicroUsd(question);
}

// Best-effort view for /api/ocean/stats. Never throws, never 500s: on any
// failure (or empty KV) it reports honest zeros.
export async function tideStats(
  kv: { get(key: string): Promise<string | null> },
  nowMs: number = Date.now(),
): Promise<{
  hourly_cap_usd: number;
  budget_window_usd: number;
  budget_remaining_usd: number;
  window_reset_in_seconds: number;
  window_minutes: number;
}> {
  const empty = {
    hourly_cap_usd: HOURLY_CAP_USD,
    budget_window_usd: 0,
    budget_remaining_usd: 0,
    window_reset_in_seconds: 0,
    window_minutes: 0,
  };
  try {
    const w = await readTideWindow(kv);
    if (!w) return empty;
    const full = tideWindowBudgetMicro(w.window_minutes) / MICRO_USD_PER_DOLLAR;
    if (nowMs >= w.reset_at_ms) {
      // Expired: the next ask rolls a fresh window; show the stored window's
      // full budget as the standing approximation.
      return { ...empty, budget_window_usd: full, budget_remaining_usd: full, window_minutes: w.window_minutes };
    }
    return {
      hourly_cap_usd: HOURLY_CAP_USD,
      budget_window_usd: full,
      budget_remaining_usd: Math.max(0, w.remaining_micro_usd) / MICRO_USD_PER_DOLLAR,
      window_reset_in_seconds: Math.max(0, Math.ceil((w.reset_at_ms - nowMs) / 1000)),
      window_minutes: w.window_minutes,
    };
  } catch {
    return empty;
  }
}
