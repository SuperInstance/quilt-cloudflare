// =============================================================================
//  live-keys — server-side-secret proxy routes
// =============================================================================
//  Routes (all JSON, CORS *, POST only):
//    /api/systemone        → typesafe.ai SystemOne (schema-bounded decisions)
//    /api/quantum/encode   → Moth quantumaudio service
//    /api/quantum/decode   → Moth quantumaudio service
//
//  VERIFIED vs PENDING — honesty over demo:
//    - SystemOne request shape is VERIFIED against
//      AI-Writings/openjev-research/01-typesafe-jev-deep-dive.md:
//      POST https://api.typesafe.ai/v1/systemone
//      body { schema: {type:"Choice",options:[≤255]} | {type:"Score",...} | {type:"Noul"},
//             context: string, samples?: 1..32 }
//    - The Moth quantumaudio base URL is NOT verifiable in-repo.
//      SuperInstance/moth-ledger's README states the endpoint
//      "is undiscovered (~40 probes failed; docs live behind Casey's
//      onboarding)". These routes therefore run behind an explicit flag:
//      they 503 with moth_endpoint_pending until MOTHQUANTUM_BASE is set.
//      Response shapes are NEVER invented here; wiring later is config-only.
//    - A local /api/quantum/local-encode (pure-JS port of
//      SuperInstance/quilt-quantum-audio) was considered and REJECTED:
//      that package's core.py is itself a classical simulation of the
//      quantumaudio interface — porting it would ship a mock of a mock.
//
//  Secrets stay server-side: TYPESAFEAI_KEY / MOTHQUANTUM_KEY are read from
//  env only and never echoed to the client.
//
//  Abuse limits (same convention as the ocean routes): per-IP 10/min + 100/day
//  via env.CACHE KV counters. If the CACHE binding is missing, limiting is
//  skipped by design (deploy-time choice) — see rateLimit() below.
//
//  Receipts: every successful proxied call appends a witness row to
//  ocean_calls when env.DB exists. The sibling ocean-api branch owns chain
//  integrity; this module owns presence — chain_hash is written as "" and
//  INSERT OR IGNORE makes concurrent-branch duplicates harmless. When DB is
//  missing or throws, we fall back to a best-effort KV counter
//  (ocean:log:livekeys) and never crash the request.
// =============================================================================

export interface LiveKeysEnv {
  TYPESAFEAI_KEY?: string;
  MOTHQUANTUM_KEY?: string;
  MOTHQUANTUM_BASE?: string;
  CACHE?: KVNamespace;
  DB?: D1Database;
}

export interface LiveKeysOptions {
  // Default 15000. Exposed so tests can pin the timeout behavior in ms.
  timeoutMs?: number;
}

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_CHOICE_OPTIONS = 255;
const MAX_SAMPLES = 32;
const MINUTE_LIMIT = 10;
const DAY_LIMIT = 100;
const SCHEMA_TYPES = ['Choice', 'Score', 'Noul'];

// NOTE(ocean-api reconciliation): assumed witness-table shape. The sibling
// branch may adjust columns; CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE
// keeps both branches idempotent. chain_hash stays "" here by agreement.
const CREATE_OCEAN_CALLS = `CREATE TABLE IF NOT EXISTS ocean_calls (
  id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  client_ip TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  chain_hash TEXT NOT NULL DEFAULT ''
)`;

const INSERT_OCEAN_CALL = `INSERT OR IGNORE INTO ocean_calls
  (id, route, method, status, client_ip, duration_ms, created_at, chain_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export async function handleLiveKeys(
  request: Request,
  env: LiveKeysEnv,
  opts: LiveKeysOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  const isSystemone = path === '/api/systemone' && request.method === 'POST';
  const isQuantumEncode = path === '/api/quantum/encode' && request.method === 'POST';
  const isQuantumDecode = path === '/api/quantum/decode' && request.method === 'POST';
  if (!isSystemone && !isQuantumEncode && !isQuantumDecode) {
    return null; // not one of ours — let the worker fall through to its 404
  }

  const ip = clientIp(request);
  if (await rateLimited(env, ip)) {
    return json({ error: 'rate_limited', limit: '10/min + 100/day per IP' }, 429);
  }

  if (isSystemone) {
    return await proxySystemOne(request, env, ip, opts);
  }
  return await proxyQuantum(isQuantumEncode ? 'encode' : 'decode', request, env, ip, opts);
}

// ---------------------------------------------------------------------------
//  Route 1 — typesafe.ai SystemOne
// ---------------------------------------------------------------------------

async function proxySystemOne(
  request: Request,
  env: LiveKeysEnv,
  ip: string,
  opts: LiveKeysOptions,
): Promise<Response> {
  if (!env.TYPESAFEAI_KEY) {
    return json({ error: 'key_not_deployed', hint: 'wrangler secret put TYPESAFEAI_KEY' }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const valid = validateSystemOneBody(body);
  if (!valid.ok) {
    return json({ error: 'invalid_body', detail: valid.detail }, 400);
  }

  const started = Date.now();
  const upstream = await timedFetch(
    SYSTEMONE_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TYPESAFEAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schema: valid.value.schema,
        context: valid.value.context,
        samples: valid.value.samples,
      }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!upstream.okResponse && upstream.error === 'timeout') {
    return json({ error: 'upstream_timeout', detail: 'typesafe.ai did not answer within 15s' }, 504);
  }
  if (!upstream.okResponse) {
    return json({ error: 'upstream_unreachable', detail: upstream.detail }, 502);
  }

  const res = await passThrough(upstream.response, 'typesafe-systemone');
  if (res.status >= 200 && res.status < 300) {
    await recordReceipt(env, {
      route: '/api/systemone', method: 'POST', status: res.status,
      client_ip: ip, duration_ms: Date.now() - started,
    });
  }
  return res;
}

function validateSystemOneBody(
  body: unknown,
): { ok: true; value: { schema: unknown; context: string; samples?: number } }
  | { ok: false; detail: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, detail: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.schema !== 'object' || b.schema === null || Array.isArray(b.schema)) {
    return { ok: false, detail: 'schema must be an object' };
  }
  const s = b.schema as Record<string, unknown>;
  if (typeof s.type !== 'string' || !SCHEMA_TYPES.includes(s.type)) {
    return { ok: false, detail: `schema.type must be one of: ${SCHEMA_TYPES.join(', ')}` };
  }
  if (s.type === 'Choice') {
    if (!Array.isArray(s.options)) {
      return { ok: false, detail: 'schema.options must be an array for Choice' };
    }
    if (s.options.length < 1 || s.options.length > MAX_CHOICE_OPTIONS) {
      return { ok: false, detail: `schema.options length must be 1..${MAX_CHOICE_OPTIONS}` };
    }
  }
  if (s.type === 'Score') {
    if (typeof s.rubric !== 'string' || s.rubric.length === 0) {
      return { ok: false, detail: 'schema.rubric must be a non-empty string for Score' };
    }
    if (s.min !== undefined && typeof s.min !== 'number') {
      return { ok: false, detail: 'schema.min must be a number' };
    }
    if (s.max !== undefined && typeof s.max !== 'number') {
      return { ok: false, detail: 'schema.max must be a number' };
    }
  }

  if (typeof b.context !== 'string') {
    return { ok: false, detail: 'context must be a string' };
  }
  if (b.context.length > MAX_CONTEXT_CHARS) {
    return { ok: false, detail: `context must be ≤ ${MAX_CONTEXT_CHARS} chars` };
  }
  if (b.samples !== undefined) {
    const n = b.samples;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SAMPLES) {
      return { ok: false, detail: `samples must be an integer 1..${MAX_SAMPLES}` };
    }
  }
  return {
    ok: true,
    value: {
      schema: b.schema,
      context: b.context,
      samples: b.samples as number | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
//  Route 2 — Moth quantumaudio (endpoint pending honest flag)
// ---------------------------------------------------------------------------

async function proxyQuantum(
  op: 'encode' | 'decode',
  request: Request,
  env: LiveKeysEnv,
  ip: string,
  opts: LiveKeysOptions,
): Promise<Response> {
  // VERIFIED STATUS: no in-repo source names a live Moth quantumaudio HTTP
  // endpoint (moth-ledger: "the real endpoint is undiscovered"). Until
  // MOTHQUANTUM_BASE is configured we fail loudly and honestly rather than
  // invent a response shape.
  if (!env.MOTHQUANTUM_BASE) {
    return json({
      error: 'moth_endpoint_pending',
      hint: 'set MOTHQUANTUM_BASE env var to the service base URL',
    }, 503);
  }
  if (!env.MOTHQUANTUM_KEY) {
    return json({ error: 'key_not_deployed', hint: 'wrangler secret put MOTHQUANTUM_KEY' }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ error: 'invalid_body', detail: 'body must be a JSON object' }, 400);
  }
  // No deeper validation here: the request schema is part of the still-
  // undiscovered endpoint contract. We forward the client's JSON verbatim.

  const started = Date.now();
  const base = env.MOTHQUANTUM_BASE.replace(/\/+$/, '');
  const upstream = await timedFetch(`${base}/${op}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MOTHQUANTUM_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!upstream.okResponse && upstream.error === 'timeout') {
    return json({ error: 'upstream_timeout', detail: 'moth quantumaudio did not answer within 15s' }, 504);
  }
  if (!upstream.okResponse) {
    return json({ error: 'upstream_unreachable', detail: upstream.detail }, 502);
  }

  const res = await passThrough(upstream.response, 'moth-quantum');
  if (res.status >= 200 && res.status < 300) {
    await recordReceipt(env, {
      route: `/api/quantum/${op}`, method: 'POST', status: res.status,
      client_ip: ip, duration_ms: Date.now() - started,
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
//  Plumbing — fetch with timeout, honest passthrough, rate limit, receipts
// ---------------------------------------------------------------------------

type TimedFetchResult =
  | { okResponse: true; response: Response }
  | { okResponse: false; error: 'timeout'; detail?: string }
  | { okResponse: false; error: 'network'; detail: string };

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<TimedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { okResponse: true, response };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (controller.signal.aborted || name === 'AbortError') {
      return { okResponse: false, error: 'timeout' };
    }
    return { okResponse: false, error: 'network', detail: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// Honest errors: upstream non-2xx passes through status + body VERBATIM.
async function passThrough(upstream: Response, servedBy: string): Promise<Response> {
  const body = await upstream.text();
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
    'x-served-by': servedBy,
    ...cors(),
  };
  return new Response(body, { status: upstream.status, headers });
}

async function rateLimited(env: LiveKeysEnv, ip: string): Promise<boolean> {
  const kv = env.CACHE;
  // Missing CACHE binding: limiting is skipped by design (single-line code
  // comment per spec) — deploy env.CACHE to enforce 10/min + 100/day.
  if (!kv) return false;

  const minKey = `livekeys:rl:min:${ip}`;
  const dayKey = `livekeys:rl:day:${ip}`;
  const min = (await kv.get(minKey, 'json')) as { count: number } | null;
  const day = (await kv.get(dayKey, 'json')) as { count: number } | null;
  const minCount = (min?.count ?? 0) + 1;
  const dayCount = (day?.count ?? 0) + 1;
  if (minCount > MINUTE_LIMIT || dayCount > DAY_LIMIT) {
    return true;
  }
  // Fire-and-forget puts; KV is eventually consistent — adequate for abuse
  // limits (same tradeoff as the ocean routes).
  await kv.put(minKey, JSON.stringify({ count: minCount }), { expirationTtl: 60 });
  await kv.put(dayKey, JSON.stringify({ count: dayCount }), { expirationTtl: 86400 });
  return false;
}

interface ReceiptRow {
  route: string;
  method: string;
  status: number;
  client_ip: string;
  duration_ms: number;
}

async function recordReceipt(env: LiveKeysEnv, row: ReceiptRow): Promise<void> {
  if (env.DB) {
    try {
      await insertReceipt(env.DB, row);
      return;
    } catch (e) {
      // First write on a fresh DB may lack the table — create and retry once.
      console.warn('[livekeys] receipt insert failed, ensuring table:', (e as Error)?.message);
      try {
        await env.DB.prepare(CREATE_OCEAN_CALLS).run();
        await insertReceipt(env.DB, row);
        return;
      } catch (e2) {
        console.warn('[livekeys] receipt retry failed, KV fallback:', (e2 as Error)?.message);
      }
    }
  }
  await kvReceiptFallback(env);
}

async function insertReceipt(db: D1Database, row: ReceiptRow): Promise<void> {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `lk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.prepare(INSERT_OCEAN_CALL)
    .bind(id, row.route, row.method, row.status, row.client_ip, row.duration_ms, Date.now(), '')
    .run();
}

async function kvReceiptFallback(env: LiveKeysEnv): Promise<void> {
  const kv = env.CACHE;
  if (!kv) {
    console.warn('[livekeys] no DB and no CACHE — receipt dropped (request unaffected)');
    return;
  }
  try {
    const cur = (await kv.get('ocean:log:livekeys', 'json')) as { count: number } | null;
    await kv.put('ocean:log:livekeys', JSON.stringify({ count: (cur?.count ?? 0) + 1 }), { expirationTtl: 86400 });
  } catch (e) {
    console.warn('[livekeys] KV receipt fallback failed (request unaffected):', (e as Error)?.message);
  }
}

// ---------------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------------

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors(),
      ...extraHeaders,
    },
  });
}

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
