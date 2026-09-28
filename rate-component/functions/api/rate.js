// =============================================================================
//  /api/rate — budgeted-JEV "rate my work" backend (drop-in Pages Function)
// =============================================================================
//  Any static/offline-first app gets a live verdict on the visitor's own work
//  ("rate my chart", "rate my route", "grade my draft") with a hard per-visitor
//  budget cap, a global daily backstop, and a MANDATORY graceful degrade — the
//  app never breaks, it just quietly stops offering the live extra.
//
//  Pattern source: AI-Writings situations/arch/CF-BACKEND-WOW-BUDGET.md,
//  live-verified by dispatch-ledger entries d070/d077 (aha-budget-proof,
//  https://aha-budget-proof.pages.dev) and d083 (qthe-looking-glass).
//
//  Wire contract
//  --------------
//    POST /api/rate   (same-origin only, <= MAX_BODY_BYTES JSON body)
//      { "content": "<the visitor's own work, as text>", "question"?: "<custom ask>" }
//
//    200 (live verdict):
//      { degraded:false, verdict: { score, confidence, noul, raw }, budget:{...} }
//
//    200 (graceful degrade — ALWAYS 200, never a hard wall to the app):
//      { degraded:true, reason: 'budget_spent'|'not_configured'|'upstream_error',
//        message: "<safe to show the visitor>", budget?:{...} }
//
//    403 same-origin only (evil-origin rejected)
//    413 request body over MAX_BODY_BYTES
//    400 malformed body
//    405 method not POST/OPTIONS
//
//  Security invariants
//  -------------------
//    - TYPESAFEAI_KEY is read ONLY from the Pages secret / Secrets Store
//      binding (env.TYPESAFEAI_KEY). It is never placed in a response body,
//      a header, a log line, or a KV value — grep this file: there is no
//      console.* call, and every place the key is used it goes straight into
//      the one outbound Authorization header for the upstream call.
//    - Same-origin enforcement: the Origin (or Sec-Fetch-Site) header must
//      match this Function's own origin. No Origin/Sec-Fetch-Site at all
//      (a bare server-to-server curl) is rejected too — same-origin means
//      "called from this site's own browser tab", not "authenticated".
//    - Server-side budget only: the KV token buckets are checked and spent
//      *before* the upstream call is ever made — a client can't lie its way
//      to more calls, and a failing upstream can't be retried for free.
// =============================================================================

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_CONTENT_CHARS = 4000;
const MAX_QUESTION_CHARS = 300;

// ---- tunable caps (override per-deploy via Pages env vars; see README) ----
export const CONFIG_DEFAULTS = {
  VISITOR_LIMIT: 30,             // calls per rolling 24h, per visitor (cookie AND ip bucket each enforce this; tighter wins)
  GLOBAL_DAILY_LIMIT: 4000,      // calls per rolling 24h, across every visitor — the botnet backstop
  MAX_BODY_BYTES: 4096,          // request size cap
  WINDOW_MS: 24 * 60 * 60 * 1000,// rolling window length for every bucket
  UPSTREAM_TIMEOUT_MS: 12000,
  COOKIE_NAME: 'sr_visitor',
  COOKIE_MAX_AGE_SECONDS: 60 * 60 * 24 * 365,
  RECEIPT_LOG_KEY: 'rate:receipts',
  RECEIPT_LOG_CAP: 500,
};

function readConfig(env) {
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return {
    ...CONFIG_DEFAULTS,
    VISITOR_LIMIT: n(env.RATE_VISITOR_LIMIT, CONFIG_DEFAULTS.VISITOR_LIMIT),
    GLOBAL_DAILY_LIMIT: n(env.RATE_GLOBAL_DAILY_LIMIT, CONFIG_DEFAULTS.GLOBAL_DAILY_LIMIT),
    MAX_BODY_BYTES: n(env.RATE_MAX_BODY_BYTES, CONFIG_DEFAULTS.MAX_BODY_BYTES),
  };
}

// Accept either binding name: RATE_KV is this component's own convention;
// BUDGET_KV matches the naming already live on aha-budget-proof (d077).
function resolveKv(env) {
  return env.RATE_KV || env.BUDGET_KV || null;
}

// --- same-origin ------------------------------------------------------------

export function isSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin !== null) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite !== null) {
    return secFetchSite === 'same-origin' || secFetchSite === 'none';
  }
  // No Origin and no Sec-Fetch-Site at all — not a browser fetch/XHR call.
  // Reject: "same-origin" means "from this site's own page", not merely
  // "no explicit foreign origin claimed".
  return false;
}

// --- hashing / cookies -------------------------------------------------------

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function newVisitorId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// --- KV rolling-window token bucket ------------------------------------------
//
// Each bucket is stored as {windowStart, count}. Once now - windowStart
// exceeds WINDOW_MS the bucket rolls: it resets to {windowStart: now, count: 0}
// on next read — a true rolling per-key 24h window (not a calendar-day reset).
// Checked, then spent, server-side only; a client-sent counter is never
// trusted.

export async function readBucket(kv, key, now, windowMs) {
  let raw = null;
  try {
    raw = await kv.get(key, 'json');
  } catch {
    raw = null;
  }
  if (raw && typeof raw.windowStart === 'number' && now - raw.windowStart < windowMs) {
    return { windowStart: raw.windowStart, count: raw.count || 0 };
  }
  return { windowStart: now, count: 0 };
}

export async function spendBucket(kv, key, bucket, windowMs) {
  const ttlSeconds = Math.max(60, Math.ceil(windowMs / 1000));
  await kv.put(
    key,
    JSON.stringify({ windowStart: bucket.windowStart, count: bucket.count + 1 }),
    { expirationTtl: ttlSeconds },
  );
}

export function bucketRemaining(bucket, limit) {
  return Math.max(0, limit - bucket.count);
}

// Two per-visitor buckets (first-party cookie AND hashed IP — defeats
// cookie-clearing) plus one global daily ceiling. Tighter always wins.
export async function checkBudget(kv, keys, cfg, now) {
  const [cookieB, ipB, globalB] = await Promise.all([
    readBucket(kv, keys.cookie, now, cfg.WINDOW_MS),
    readBucket(kv, keys.ip, now, cfg.WINDOW_MS),
    readBucket(kv, keys.global, now, cfg.WINDOW_MS),
  ]);
  const remaining = {
    cookie: bucketRemaining(cookieB, cfg.VISITOR_LIMIT),
    ip: bucketRemaining(ipB, cfg.VISITOR_LIMIT),
    global: bucketRemaining(globalB, cfg.GLOBAL_DAILY_LIMIT),
  };
  const tightest = Math.min(remaining.cookie, remaining.ip, remaining.global);
  return { cookieB, ipB, globalB, remaining, tightest, allowed: tightest > 0 };
}

export async function spendBudget(kv, keys, budget, cfg) {
  await Promise.all([
    spendBucket(kv, keys.cookie, budget.cookieB, cfg.WINDOW_MS),
    spendBucket(kv, keys.ip, budget.ipB, cfg.WINDOW_MS),
    spendBucket(kv, keys.global, budget.globalB, cfg.WINDOW_MS),
  ]);
}

// --- cost booking (receipts, best-effort, never fails the request) ---------

export async function bookReceipt(kv, cfg, row) {
  let log = [];
  try {
    const raw = await kv.get(cfg.RECEIPT_LOG_KEY, 'json');
    if (Array.isArray(raw)) log = raw;
  } catch {
    log = [];
  }
  log.push(row);
  if (log.length > cfg.RECEIPT_LOG_CAP) log = log.slice(-cfg.RECEIPT_LOG_CAP);
  try {
    await kv.put(cfg.RECEIPT_LOG_KEY, JSON.stringify(log));
  } catch {
    // Best-effort accounting only — never let a bookkeeping failure break
    // a request that already has (or was correctly denied) its verdict.
  }
}

// --- response helpers ---------------------------------------------------------

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function degrade(reason, message, extra = {}) {
  // Graceful degrade is mandatory and is ALWAYS HTTP 200: the calling app's
  // own offline logic must never see this as a request failure.
  return json({ degraded: true, reason, message, ...extra }, 200);
}

function withCookie(response, setCookie) {
  if (setCookie) response.headers.append('Set-Cookie', setCookie);
  return response;
}

// --- the handler --------------------------------------------------------------

export async function onRequestPost(context) {
  const { request, env } = context;
  const cfg = readConfig(env);
  const now = Date.now();

  if (!isSameOrigin(request)) {
    return json({ error: 'forbidden', detail: 'same-origin requests only' }, 403);
  }

  const lenHeader = request.headers.get('Content-Length');
  if (lenHeader && Number(lenHeader) > cfg.MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large', limit_bytes: cfg.MAX_BODY_BYTES }, 413);
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  if (new TextEncoder().encode(rawBody).length > cfg.MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large', limit_bytes: cfg.MAX_BODY_BYTES }, 413);
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return json({ error: 'invalid_body', detail: '"content" (string) is required' }, 400);
  }
  const trimmedContent = content.slice(0, MAX_CONTENT_CHARS);
  const question = typeof body.question === 'string' && body.question.trim()
    ? body.question.trim().slice(0, MAX_QUESTION_CHARS)
    : 'Rate the quality and honesty of this work.';

  // --- visitor identity: first-party cookie + hashed IP -----------------
  const cookies = parseCookies(request.headers.get('Cookie'));
  let visitorId = cookies[cfg.COOKIE_NAME];
  let setCookie = null;
  if (!visitorId) {
    visitorId = newVisitorId();
    setCookie = `${cfg.COOKIE_NAME}=${visitorId}; Max-Age=${cfg.COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const [visitorHash, ipHash] = await Promise.all([sha256Hex(visitorId), sha256Hex(ip)]);

  const keys = {
    cookie: `rate:v:cookie:${visitorHash}`,
    ip: `rate:v:ip:${ipHash}`,
    global: 'rate:global:daily',
  };

  const kv = resolveKv(env);
  if (!kv) {
    // No KV bound at all: degrade rather than run unmetered or crash.
    return withCookie(
      degrade('not_configured', 'Live scoring storage is not bound yet — the app keeps working without it.'),
      setCookie,
    );
  }

  const budget = await checkBudget(kv, keys, cfg, now);
  const budgetInfo = {
    remaining: budget.tightest,
    per_visitor_limit: cfg.VISITOR_LIMIT,
    global_daily_limit: cfg.GLOBAL_DAILY_LIMIT,
  };

  if (!budget.allowed) {
    return withCookie(
      degrade(
        'budget_spent',
        "You've used today's live credits — everything else still works; come back later for more live scoring.",
        { budget: budgetInfo },
      ),
      setCookie,
    );
  }

  if (!env.TYPESAFEAI_KEY) {
    return withCookie(
      degrade('not_configured', 'Live scoring is not deployed yet — the app keeps working without it.', { budget: budgetInfo }),
      setCookie,
    );
  }

  // Reserve the spend BEFORE calling upstream: a timing-out or erroring
  // upstream must not be free to retry unmetered, and a client can never
  // race the check.
  await spendBudget(kv, keys, budget, cfg);
  const spentBudgetInfo = { ...budgetInfo, remaining: Math.max(0, budgetInfo.remaining - 1) };

  const upstreamBody = {
    model: 'jev-latest',
    state: trimmedContent,
    questions: {
      quality: { type: 'score', question, criteria: ['honesty', 'quality', 'completeness'] },
      verdict: {
        type: 'noul',
        instructions: 'Is this work good as-is (closer to 1) or does it need real work (closer to 0)?',
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    const res = await fetch(SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        // The key touches the network exactly once, here, and nowhere else
        // in this file — never a response, a header sent back, or a log.
        Authorization: `Bearer ${env.TYPESAFEAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
    const text = await res.text();
    upstream = { ok: res.ok, status: res.status, text };
  } catch {
    upstream = { ok: false, status: controller.signal.aborted ? 408 : 0, text: '' };
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    await bookReceipt(kv, cfg, {
      ts: now, visitor: visitorHash, ip: ipHash, tool: 'jev',
      status: upstream.status, degraded: true,
    });
    return withCookie(
      degrade('upstream_error', 'The live judge is unavailable right now — the app keeps working on its own logic.', {
        budget: spentBudgetInfo,
        upstream_status: upstream.status || null,
      }),
      setCookie,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(upstream.text);
  } catch {
    await bookReceipt(kv, cfg, {
      ts: now, visitor: visitorHash, ip: ipHash, tool: 'jev',
      status: upstream.status, degraded: true, note: 'bad_upstream_json',
    });
    return withCookie(
      degrade('upstream_error', 'The live judge returned something unexpected — the app keeps working on its own logic.', {
        budget: spentBudgetInfo,
      }),
      setCookie,
    );
  }

  await bookReceipt(kv, cfg, {
    ts: now, visitor: visitorHash, ip: ipHash, tool: 'jev',
    status: upstream.status, degraded: false, usage: parsed.usage ?? null,
  });

  const answers = parsed.answers || {};
  return withCookie(
    json({
      degraded: false,
      verdict: {
        score: answers.quality?.score ?? answers.quality?.value ?? null,
        confidence: answers.quality?.confidence ?? null,
        noul: answers.verdict?.noul ?? answers.verdict?.value ?? null,
        raw: answers,
      },
      budget: spentBudgetInfo,
    }, 200),
    setCookie,
  );
}

export async function onRequestOptions() {
  // Same-origin only, no CORS: this endpoint is never meant to be called
  // cross-origin, so no Access-Control-* headers are ever emitted.
  return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
}

export async function onRequest(context) {
  // Pages Functions dispatches onRequestPost/onRequestOptions ahead of this
  // for those methods; this only runs for anything else.
  return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' });
}
