# ⚡ quilt-cloudflare

> **A Quilt reactive runtime that runs entirely on Cloudflare's edge — Workers, D1, Vectorize, KV, R2, Pages.**

The same cell model, the same YAML sheets, but every cell is persisted in D1, every value is searchable via Vectorize, every state change fans out across the edge. Build a personal data mesh that lives on Cloudflare's infrastructure.

```bash
# Deploy your own Quilt
npm install -g wrangler
wrangler init my-quilt --from quilt-cloudflare
cd my-quilt
wrangler d1 create quilt-db
wrangler vectorize create quilt-embeddings --dimensions=768
wrangler deploy
# → https://my-quilt.your-account.workers.dev
```

Then open the URL. You have a full Quilt runtime on the edge.

---

## ⚡ See it in 30 seconds

```typescript
// src/worker.ts
import { QuiltEngine, parseSheet, D1Storage, CloudflareAI } from 'quilt-cloudflare';

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  CACHE: KVNamespace;
  AI: Ai;
}

export default {
  async fetch(req: Request, env: Env) {
    const engine = new QuiltEngine({
      storage: new D1Storage(env.DB),
      ai: new CloudflareAI(env.AI),
      vectorize: env.VECTORIZE,
      cache: env.CACHE,
    });

    // Load a sheet from a URL or YAML body
    const url = new URL(req.url);
    if (url.pathname === '/run') {
      const yaml = await req.text();
      const sheet = parseSheet(yaml);
      await engine.load(sheet);
      return Response.json(await engine.getAll());
    }

    // Or call a cell by name
    if (url.pathname.startsWith('/cell/')) {
      const id = url.pathname.slice(6);
      const result = await engine.get(id);
      return Response.json(result);
    }

    return new Response('Quilt is running.');
  }
};
```

That's a complete Quilt runtime on the edge. Every cell is addressable over HTTP. Every state is persisted in D1. Every value is searchable via Vectorize. Every computation is reactive.

---

## 🎬 Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │          Cloudflare Edge (300+ cities)      │
                    │                                             │
   ┌─────────┐      │   ┌──────────────────────────────────────┐  │
   │ Browser │◀────▶│   │     Worker (the Quilt engine)        │  │
   │   UI    │      │   │                                      │  │
   └────┬────┘      │   │   ┌────────────┐   ┌─────────────┐   │  │
        │           │   │   │  Reactive  │   │  AI cells   │   │  │
        │           │   │   │   engine   │──▶│  (LLM, etc) │   │  │
        │           │   │   └─────┬──────┘   └──────┬──────┘   │  │
        │           │   └─────────┼────────────────┼──────────┘  │
        │           │             │                │              │
        │           │   ┌─────────▼──────┐  ┌──────▼──────┐       │
        │           │   │       D1       │  │  Vectorize  │       │
        │           │   │  (cell state)  │  │ (semantic)  │       │
        │           │   └────────────────┘  └─────────────┘       │
        │           │   ┌────────────────┐  ┌─────────────┐       │
        │           │   │       KV       │  │     R2      │       │
        │           │   │   (cache)      │  │  (backups)  │       │
        │           │   └────────────────┘  └─────────────┘       │
        │           │                                             │
        │           │   ┌──────────────────────────────────────┐  │
        │           │   │       Pages (the web UI)            │  │
        │           │   │   Studio / Live / Playground        │  │
        │           │   └──────────────────────────────────────┘  │
        │           │                                             │
        └───────────┴─────────────────────────────────────────────┘
```

The Quilt engine runs in a Worker. State persists in D1. Semantic search uses Vectorize. The UI is a Page. Everything is global, low-latency, and scales to zero when not in use.

---

## 🎁 What's in the box

- **`QuiltEngine`** — the reactive engine, runs in a Worker
- **`D1Storage`** — persist cells in D1 (SQLite at the edge)
- **`VectorizeSearch`** — semantic search across cell values
- **`KVCache`** — fast ephemeral state (formulas, listeners)
- **`R2Backup`** — versioned backups in R2 object storage
- **`CloudflareAI`** — AI cells using Workers AI (LLM, embeddings, image classification)
- **15 cell kinds** — value, formula, program, sensor, api, listener, router, io, **ai.llm**, **ai.embed**, **ai.image**, **ai.translate**, **ai.sentiment**, **ai.summarize**, **ai.code**
- **MCP server** — every cell is an MCP tool over HTTP/SSE
- **Web UI** — Studio + Live + Playground, deployed as Pages
- **CLI** — `wrangler` integration; deploy with one command

---

## 🎬 30-second deploy

```bash
# 1. Install
npm install -g wrangler
wrangler login

# 2. Clone the template
wrangler init my-quilt --from quilt-cloudflare
cd my-quilt

# 3. Provision resources
wrangler d1 create quilt-db
wrangler vectorize create quilt-embeddings --dimensions=768
wrangler kv:namespace create CACHE

# 4. Bind them in wrangler.toml
# [[d1_databases]]
# binding = "DB"
# database_name = "quilt-db"
# database_id = "..."

# 5. Deploy
wrangler deploy
# → https://my-quilt.YOUR_SUBDOMAIN.workers.dev
```

You now have a personal Quilt running on Cloudflare's edge.

---

## 🎁 The AI cells

```yaml
# Use any model via Workers AI
- id: llm.explain
  kind: ai.llm
  model: "@cf/meta/llama-3-8b-instruct"
  prompt: '"Explain this code: " + input.code'
  description: "LLM cell — calls Workers AI"

# Embeddings
- id: embedding
  kind: ai.embed
  model: "@cf/baai/bge-base-en-v1.5"
  input: input.text

# Image classification
- id: image_class
  kind: ai.image
  model: "@cf/microsoft/resnet-50"
  input: image.url

# Translation
- id: translated
  kind: ai.translate
  model: "@cf/meta/m2m100-1.2b"
  from: "en"
  to: "es"
  input: input.text

# Sentiment
- id: sentiment
  kind: ai.sentiment
  input: input.text

# Summarization
- id: summary
  kind: ai.summarize
  input: input.long_text
  max_tokens: 100

# Code generation
- id: generated_code
  kind: ai.code
  language: "python"
  prompt: "Write a function that " + input.task
```

Every AI cell is just a cell. Reactive, addressable, MCP-accessible, persistent.

---

## 🏗️ Architecture deep-dive

### D1 schema

```sql
CREATE TABLE cells (
  id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT,                    -- JSON-serialized
  value_type TEXT,               -- 'string', 'number', 'object', etc.
  t INTEGER NOT NULL,             -- Lamport timestamp
  author TEXT,                    -- who/what wrote it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,                  -- JSON: {description, source, etc.}
  PRIMARY KEY (sheet_id, id)
);

CREATE TABLE edges (
  sheet_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (sheet_id, from_id, to_id)
);

CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  t INTEGER NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE listeners (
  sheet_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  watch TEXT NOT NULL,
  condition TEXT,
  action TEXT,
  PRIMARY KEY (sheet_id, cell_id)
);

CREATE INDEX idx_cells_sheet ON cells(sheet_id);
CREATE INDEX idx_history_cell ON history(sheet_id, cell_id, t);
```

### The worker

```typescript
// src/worker.ts
import { QuiltEngine, parseSheet, D1Storage } from 'quilt-cloudflare';

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const engine = new QuiltEngine({
      storage: new D1Storage(env.DB, 'default'),
    });

    if (url.pathname === '/sheet' && req.method === 'POST') {
      const yaml = await req.text();
      const sheet = parseSheet(yaml);
      await engine.load(sheet);
      return Response.json({ ok: true, cells: sheet.cells.length });
    }

    if (url.pathname.startsWith('/cell/')) {
      const id = decodeURIComponent(url.pathname.slice(6));
      const result = await engine.get(id);
      return Response.json(result);
    }

    return new Response('Quilt is running. POST to /sheet, GET /cell/<id>.');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Run sensor cells on a schedule
    const engine = new QuiltEngine({ storage: new D1Storage(env.DB, 'default') });
    await engine.runSensors();
    ctx.waitUntil(engine.flush());
  },
};
```

### The CLI

```bash
# Load a sheet
quilt-cloudflare load ./weather.yaml --url https://my-quilt.workers.dev

# Get a cell
quilt-cloudflare get budget.total --url https://my-quilt.workers.dev

# Set a value
quilt-cloudflare set budget.total 6000 --url https://my-quilt.workers.dev

# Tail the event log
quilt-cloudflare tail --url https://my-quilt.workers.dev
```

---

## 🛠️ Develop

```bash
git clone https://github.com/SuperInstance/quilt-cloudflare
cd quilt-cloudflare
npm install
npm run dev
# → http://localhost:8787
```

Local dev uses miniflare to emulate Workers, D1, Vectorize, KV, R2.

---

## 📦 Build targets

```bash
npm run build          # Build the worker
npm run build:ui       # Build the Pages UI
npm run deploy         # Deploy worker + UI
```

---

## 🗺️ Roadmap

- [x] Quilt engine in a Worker
- [x] D1 storage backend
- [x] Vectorize semantic search
- [x] Workers AI integration (LLM, embed, image, translate, sentiment, summarize, code)
- [x] MCP server over HTTP/SSE
- [x] Pages UI (Studio + Live + Playground)
- [x] CLI
- [ ] Durable Objects for stateful sheets (multi-region consistency)
- [ ] Quarantine Cells (compute at the edge, in a sandboxed isolate)
- [ ] Real-time WebSocket mesh (Cloudflare Realtime / Durable Objects)
- [ ] Cron triggers for sensor cells
- [ ] R2-backed versioned history
- [ ] Workers AI fine-tuning
- [ ] BYO model (OpenAI, Anthropic, etc.)
- [ ] Federated Quilt (multiple Workers, one sheet)

---

## 🔗 Related

- [Quilt (TypeScript)](https://github.com/SuperInstance/quilt) — the canonical runtime
- [Quilt (Rust)](https://github.com/SuperInstance/quilt-rust) — the desktop runtime
- [Quilt Live](https://github.com/SuperInstance/quilt-live) — single-file browser runtime
- [Quilt Mesh](https://github.com/SuperInstance/quilt-mesh) — peer-to-peer CRDT
- [Quilt Time](https://github.com/SuperInstance/quilt-time) — time travel
- [Quilt Vault](https://github.com/SuperInstance/quilt-vault) — encryption
- [Cloudflare Workers](https://workers.cloudflare.com/) — the runtime
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — the database
- [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) — the search engine
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) — the LLM

## Related Quilt repos

Quilt is an ecosystem of 15 repos, 5 deployment tiers, 3 languages. This repo is part of:

| Tier | Repo | What it is |
|---|---|---|
| **Canonical** | [quilt](https://github.com/SuperInstance/quilt) | TypeScript core (this ecosystem's home base) |
| **Compiled** | [quilt-rust](https://github.com/SuperInstance/quilt-rust) | Rust port — single static binary, axum, crossterm |
| **Browser** | [quilt-live](https://github.com/SuperInstance/quilt-live) | Single 70KB HTML file that runs anywhere |
| **IoT** | [quilt-esp32](https://github.com/SuperInstance/quilt-esp32) | no_std Rust for ESP32, sensors + actuators |
| **Edge** | [quilt-cloudflare](https://github.com/SuperInstance/quilt-cloudflare) | Cloudflare Workers + D1 + Vectorize + R2 |
| **Codespace** | [quilt-codespace](https://github.com/SuperInstance/quilt-codespace) | GitHub Codespace as a live Quilt runtime |
| **AI** | [quilt-ai](https://github.com/SuperInstance/quilt-ai) | LLM cells across 4 providers (z.ai, Kimi, DeepSeek, Cloudflare) |
| **Evolution** | [quilt-evolve](https://github.com/SuperInstance/quilt-evolve) | Self-improvement loops, 4 components, 5 scopes |
| **Mesh** | [quilt-mesh](https://github.com/SuperInstance/quilt-mesh) | CRDT-backed cross-tab / cross-device sync |
| **Agent** | [quilt-agent](https://github.com/SuperInstance/quilt-agent) | LLM agent as a sheet — memory, tools, reasoning |
| **Time** | [quilt-time](https://github.com/SuperInstance/quilt-time) | Time-series cells with rolling windows |
| **Vault** | [quilt-vault](https://github.com/SuperInstance/quilt-vault) | Secrets cells with per-cell ACLs |
| **Vision** | [quilt-vision](https://github.com/SuperInstance/quilt-vision) | Computer-vision cells (camera → scene → caption) |
| **ZK** | [quilt-zk](https://github.com/SuperInstance/quilt-zk) | Zero-knowledge cell verification primitives |
| **Flow** | [quilt-flow](https://github.com/SuperInstance/quilt-flow) | Workflow cells — DAG execution, retry, rollback |

See the [Federation landing page](https://superinstance.github.io/quilt/landing/federation.html) for the architecture and the [Engineering Bar](https://github.com/SuperInstance/quilt/blob/main/docs/engineering-bar.md) for what "done right" means across all 15 repos.

---

## License

MIT.
