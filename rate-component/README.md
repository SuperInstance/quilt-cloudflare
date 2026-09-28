# rate-component — budgeted-JEV "rate my work" backend

A self-contained Cloudflare Pages Function (`/api/rate`) that gives any
static, offline-first web app a **live verdict on the visitor's own work**
("rate my chart", "grade my route", "score my draft") — with a per-visitor
budget cap (a soft *guard*, not an atomic hard stop — see **Limitations &
threat model**), a global daily backstop, and a **mandatory graceful
degrade**: if the budget is spent, the key isn't deployed, or the upstream
judge errors, the endpoint still returns HTTP 200 and the calling app keeps
working. The live call is always an enhancement, never load-bearing.

This is the drop-in extraction of the pattern proven live on
`aha-budget-proof.pages.dev` and `qthe-looking-glass` (see
`AI-Writings/situations/arch/CF-BACKEND-WOW-BUDGET.md` and dispatch-ledger
entries d070/d077/d083 for the original live verification).

## Adopt it in ~5 lines

1. Copy `functions/api/rate.js` into your Cloudflare Pages project at the
   same path: `functions/api/rate.js` (Pages' file-based routing wires it
   to `/api/rate` automatically — no other code changes needed).
2. Create a KV namespace and bind it as `RATE_KV` in your `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "RATE_KV"
   id = "<your-kv-namespace-id>"
   ```
3. Set the upstream key as a **secret**, never a plaintext var:
   ```bash
   wrangler pages secret put TYPESAFEAI_KEY
   ```
4. Call it from your app, same-origin, with the visitor's own text:
   ```js
   const res = await fetch('/api/rate', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ content: myChartSummary }),
   });
   const { degraded, verdict, budget } = await res.json();
   ```
5. Render `verdict` when `degraded === false`; when `degraded === true`,
   show `message` (already visitor-safe copy) and keep playing/working —
   that's the whole contract.

That's it — no other files, no build step, no dependencies.

## What it guarantees

- **The key never reaches the client.** `TYPESAFEAI_KEY` is read only from
  the Pages secret / Secrets Store binding, used in exactly one outbound
  `Authorization` header, and never appears in a response body, a response
  header, a KV value, or a log line (there is no `console.*` call in the
  file at all).
- **Same-origin only.** The `Origin` (or `Sec-Fetch-Site`) header must match
  the Function's own origin; a foreign origin — or no origin/browser-fetch
  signal at all (e.g. a bare server-to-server `curl`) — gets `403`.
- **Request size cap.** Bodies over `RATE_MAX_BODY_BYTES` (default 4096)
  are rejected `413`, checked on both `Content-Length` and the actual body.
- **Per-visitor budget, two ways.** The visitor is identified by a
  first-party cookie (`sr_visitor`, `HttpOnly; Secure; SameSite=Lax`) **and**
  a SHA-256 hash of their IP — a rolling 24h KV token bucket for each, so
  clearing cookies doesn't reset the budget. **Tighter always wins.**
- **A global daily ceiling** (also a rolling KV bucket) backstops the whole
  deployment against a botnet running up the bill, independent of any one
  visitor's budget.
- **Server-side enforcement only.** The budget is checked and *spent*
  **before** the upstream call is made — a client-sent counter is never
  trusted, and a failing/timing-out upstream can't be retried for free.
- **Cost is booked to KV.** Every call (live or failed-upstream) appends a
  bounded receipt row `{ts, visitor, ip, tool, status, degraded, usage}` to
  `rate:receipts` — a measured, replayable record of spend, not a guess.
- **Graceful degrade is mandatory, always HTTP 200,** on exactly three
  paths: budget spent, key not configured, upstream error (401, 5xx,
  timeout, network failure, or a malformed upstream body). The app's own
  offline logic never has to handle a request failure for these — only
  `degraded: true` in an otherwise-normal 200 JSON body.

## Wire contract

```
POST /api/rate                     (same-origin, <= 4KB JSON body)
  { "content": "<the visitor's own work, as text, <=4000 chars>",
    "question"?: "<optional custom ask, <=300 chars>" }
```

Live verdict (200):
```json
{
  "degraded": false,
  "verdict": { "score": 0.82, "confidence": 0.71, "noul": 0.8, "raw": { "...": "the full JEV answers object" } },
  "budget": { "remaining": 27, "per_visitor_limit": 30, "global_daily_limit": 4000 }
}
```

Graceful degrade (**always 200**):
```json
{
  "degraded": true,
  "reason": "budget_spent",
  "message": "You've used today's live credits — everything else still works; come back later for more live scoring.",
  "budget": { "remaining": 0, "per_visitor_limit": 30, "global_daily_limit": 4000 }
}
```
`reason` is one of `budget_spent` / `not_configured` / `upstream_error`.

Hard rejections (never disguised as a degrade — these mean the caller did
something wrong, not that the budget ran out): `403` cross-origin, `413`
oversized body, `400` malformed/missing `content`, `405` non-POST/OPTIONS.

## Limitations & threat model

*Audited by playing the quilt situation **S17 "The Weakest Leaf"** against this
component (see `SuperInstance/AI-Writings` `situations/play/weakest-leaf.mjs`,
ledger d098). The decomposing JEV fold located the budget cap as the weakest
guarantee; a Moth quantum-drawn adversary (Bell S=2.801) confirmed the bypasses
below. Stated honestly here rather than overclaimed.*

- **The cap is a soft budget *guard*, not an atomic hard stop.** Workers KV is
  eventually consistent: the bucket is read → checked → written, so a burst of
  simultaneous requests can each read the same pre-decrement value and all pass
  before any write lands. Real spend can therefore *slightly* overshoot the cap
  under concurrency. This is acceptable for a **few-cents aha budget** (the blast
  radius is tiny and JEV is cheap); it is **not** a billing hard-stop.
  - *Mitigation shipped:* the spend is **reserved before** the upstream call
    (`spendBudget` runs ahead of the `fetch`), so the check can't be raced by a
    single client and a timing-out/erroring call still counts — no free retries.
    This narrows, but does not close, the concurrent-burst window (KV is still
    eventually consistent). A failed call is **not** refunded, by design.
  - *For a true hard cap:* back the counter with a **Durable Object** (or D1 with
    a transaction) so the decrement is atomic. Drop-in DO variant is a follow-up.
- **Same-origin is a friction gate, not authentication.** It checks `Origin` /
  `Sec-Fetch-Site`, which a non-browser client can forge. It stops casual
  cross-site embedding and honest browsers; it does not stop a determined script.
  The real backstops against abuse are the per-visitor + global budget caps.
- **Distributed abuse.** A botnet of many residential IPs can each stay under the
  per-visitor cap while collectively approaching the global daily ceiling faster
  than the (eventually consistent) global counter converges. The global cap bounds
  worst-case daily spend to a *fixed, small* number regardless — that is the point.

## KV schema

All keys live in the one bound namespace (`RATE_KV`, or `BUDGET_KV` — both
names are accepted, `BUDGET_KV` matching the naming already live on
`aha-budget-proof`).

| Key | Shape | Purpose |
|---|---|---|
| `rate:v:cookie:<sha256(cookie-id)>` | `{"windowStart": <ms>, "count": <n>}` | Per-visitor bucket, keyed by the first-party cookie. Rolls forward: resets once `now - windowStart` exceeds the window (default 24h). |
| `rate:v:ip:<sha256(ip)>` | `{"windowStart": <ms>, "count": <n>}` | Per-visitor bucket, keyed by hashed IP — survives the visitor clearing cookies. |
| `rate:global:daily` | `{"windowStart": <ms>, "count": <n>}` | The global backstop bucket, shared across every visitor. |
| `rate:receipts` | `[{ts, visitor, ip, tool, status, degraded, usage}, ...]` (capped at 500, oldest dropped) | The cost-booking log — replayable spend record. |

Nothing here ever stores the visitor's raw cookie value or raw IP — only
their SHA-256 hashes.

## Tunable caps

All read from Pages env vars (plain vars, not secrets — they're not
sensitive), with the shown defaults if unset or invalid:

| Env var | Default | Meaning |
|---|---|---|
| `RATE_VISITOR_LIMIT` | `30` | Calls per rolling 24h, per visitor (applies to *each* of the cookie and IP buckets independently; the tighter one governs). |
| `RATE_GLOBAL_DAILY_LIMIT` | `4000` | Calls per rolling 24h, across every visitor combined. |
| `RATE_MAX_BODY_BYTES` | `4096` | Request body size cap. |

Everything else (the 24h window length, the upstream timeout, the cookie
name/lifetime, the receipt-log cap) is a constant at the top of
`functions/api/rate.js` (`CONFIG_DEFAULTS`) — edit it directly if a
deployment needs a different shape than an env var covers.

Tune `RATE_VISITOR_LIMIT` toward the "few cents per visitor" target from
the source pattern doc: JEV's `systemone` call is cheap, so ~20-40 calls is
the reference range for an "enough to get the aha moment, not enough to
abuse the connection" budget. Read the real `usage` numbers back out of
`rate:receipts` and tune from measured cost, not a guess.

## Offline test harness

`test/rate.test.mjs` exercises the visitor-bucket, global-cap, and
graceful-degrade logic entirely offline — an in-memory fake KV, a stubbed
`global.fetch`, no real `TYPESAFEAI_KEY`, no network egress:

```bash
cd rate-component
node --test test/rate.test.mjs
```

It covers: same-origin accept/reject, oversized-body rejection, a
per-visitor bucket exhausting and degrading, the hashed-IP bucket holding
even when cookies are cleared, the global ceiling degrading a visitor who
still has room on their own bucket, degrade-on-missing-key (and confirming
upstream is never called), degrade-on-missing-KV, degrade on upstream
401/500/network-failure, and a secret-hygiene sweep asserting the key
string never appears in any response body or header across every path.

`package.json` in this directory (`"type": "module"`) is local-only, so
Node treats `rate.js`'s ES module syntax correctly for the test run — it is
**not** part of what you copy into your own project; only
`functions/api/rate.js` is.

## Honest limits

- The live org-wide `TYPESAFEAI_KEY` currently returns upstream `401`
  pending a key rotation by the account owner (dispatch-ledger d078/d083).
  The `upstream_error` degrade path is therefore the one directly
  live-verifiable right now; the offline harness covers the full
  bucket/cap/degrade logic that a rotated key doesn't change.
- No published $/token rate was found for `systemone` at the time of
  writing — `usage` is recorded from the upstream response as-is so the
  real cost can be derived later from real numbers, not guessed here.
- KV is eventually consistent; the buckets are a best-effort abuse
  cap, not a hard financial guarantee — consistent with every other
  KV-based rate limiter in this org (see `src/ocean.ts`'s per-IP buckets).
