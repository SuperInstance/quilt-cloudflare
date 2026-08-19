# Deploying Quilt on Cloudflare

This guide walks you through deploying the Quilt reactive runtime to Cloudflare's edge.

## Prerequisites

- A Cloudflare account (free tier is enough to start)
- `wrangler` CLI installed: `npm install -g wrangler`
- A registered Cloudflare account ID (run `wrangler whoami` to check)

## Step 1: Clone the repo

```bash
git clone https://github.com/SuperInstance/quilt-cloudflare.git
cd quilt-cloudflare
npm install
```

## Step 2: Provision Cloudflare resources

```bash
# Create the D1 database for persistent cell storage
wrangler d1 create quilt-db

# Create the Vectorize index for semantic cell search (768 dimensions)
wrangler vectorize create quilt-embeddings --dimensions=768

# Create the KV namespace for fast ephemeral state
wrangler kv:namespace create CACHE
```

Each command will print an ID. Copy them.

## Step 3: Configure `wrangler.toml`

Replace the placeholders in `wrangler.toml` with the IDs from step 2:

```toml
[[d1_databases]]
binding = "DB"
database_name = "quilt-db"
database_id = "abc123-..."  # from step 2

[[vectorize]]
binding = "VECTORIZE"
index_name = "quilt-embeddings"

[[kv_namespaces]]
binding = "CACHE"
id = "xyz789..."  # from step 2
```

## Step 4: Initialize the database

```bash
wrangler d1 execute quilt-db --file=./schema.sql
```

This creates the `cells`, `edges`, `history`, `listeners`, and `ai_usage` tables.

## Step 5: Deploy the Worker

```bash
wrangler deploy
```

Output:
```
Total Upload: 12.34 KiB / gzip: 4.56 KiB
Worker Startup Time: 12 ms
Uploaded quilt-cloudflare (1.23 sec)
Published quilt-cloudflare (0.45 sec)
  https://quilt-cloudflare.YOUR_SUBDOMAIN.workers.dev
```

Copy the URL. That's your Quilt runtime on the edge.

## Step 6: Deploy the UI (optional)

```bash
wrangler pages deploy ui --project-name=quilt-cloudflare
```

Output:
```
Deploying to project "quilt-cloudflare"...
Published to https://quilt-cloudflare.pages.dev
```

Now you have a full visual studio at `https://quilt-cloudflare.pages.dev`.

## Step 7: Try it

### Load a sheet
```bash
curl -X POST https://quilt-cloudflare.YOUR_SUBDOMAIN.workers.dev/sheet?id=default \
  -H "Content-Type: text/plain" \
  --data-binary @examples/weather-ai.yaml
```

Response:
```json
{
  "ok": true,
  "sheetId": "default",
  "cells": 10,
  "edges": 8
}
```

### Get a cell
```bash
curl https://quilt-cloudflare.YOUR_SUBDOMAIN.workers.dev/cell/advice
```

Response:
```json
{
  "data": "Wear a light jacket and bring an umbrella, just in case.",
  "status": "ready",
  "computedAt": 1739840000000,
  "t": 5,
  "author": "cloudflare"
}
```

### Set a cell
```bash
curl -X POST https://quilt-cloudflare.YOUR_SUBDOMAIN.workers.dev/set/sensor.temp \
  -H "Content-Type: application/json" \
  -d '{"value": 35}'
```

### Run as an MCP server
```bash
# Add to Claude Code
claude mcp add quilt --transport http \
  --url https://quilt-cloudflare.YOUR_SUBDOMAIN.workers.dev/mcp
```

Now every cell is an MCP tool Claude can call.

## Local development

```bash
npm run dev
# → http://localhost:8787
```

This uses miniflare to emulate Workers, D1, Vectorize, KV locally.

## Configuration

### Cron triggers

To run sensor cells on a schedule, uncomment the cron trigger in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]  # every 5 minutes
```

Then add a sensor-refreshing handler in `src/worker.ts`:

```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const engine = new QuiltEngine({ storage: new D1Storage(env.DB) });
  await engine.loadFromStorage();
  // For each sensor cell, refresh its value
  for (const cellId of engine.listCells()) {
    if (engine.getCell(cellId).kind === CellKind.Sensor) {
      // Call the sensor source
      const value = await callSensorSource(engine.getCell(cellId).config.source);
      await engine.set(cellId, value);
    }
  }
}
```

### BYO model (OpenAI, Anthropic, etc.)

Replace `CloudflareAI` with your own implementation:

```typescript
class OpenAIProvider {
  constructor(private apiKey: string) {}
  async llm(model: string, prompt: string, maxTokens = 500) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
    });
    return (await res.json()).choices[0].message.content;
  }
}
```

## Monitoring

```bash
# Stream live logs
wrangler tail

# View analytics
# → Cloudflare Dashboard → Workers & Pages → quilt-cloudflare → Analytics
```

## Cost

Cloudflare's free tier gives you:
- 100,000 Worker requests / day
- 5 GB D1 storage
- 30M Workers AI neurons / day
- 100,000 KV reads / day
- 30M Vectorize queries / month

For most personal use cases, this is more than enough.

## Cleanup

```bash
# Delete the worker
wrangler delete

# Delete the D1 database
wrangler d1 delete quilt-db

# Delete the Vectorize index
wrangler vectorize delete quilt-embeddings

# Delete the KV namespace
wrangler kv:namespace delete --namespace-id=YOUR_ID
```

## What's next

- Add Durable Objects for stateful sheets
- Add real-time WebSocket support
- Add R2 for versioned history
- Add fine-tuned Workers AI models

See the [roadmap](README.md#roadmap).
