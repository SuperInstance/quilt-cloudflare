// =============================================================================
//  quilt-cloudflare — the Quilt engine for Cloudflare Workers
// =============================================================================
//  This module is the core of the Cloudflare-native Quilt. It exports:
//
//   - QuiltEngine   — the reactive cell engine
//   - parseSheet    — parse a YAML sheet
//   - D1Storage     — persist cells in D1
//   - KVCache       — fast ephemeral state in KV
//   - VectorizeSearch — semantic search via Vectorize
//   - CloudflareAI  — AI cells via Workers AI
//   - MCPHandler    — MCP over HTTP/SSE
//
//  All of this runs in a Worker. The state persists in D1. The semantic
//  search is in Vectorize. The cache is in KV. The LLM is Workers AI.
//
//  This file is part of the quilt-cloudflare package. The whole package
//  is designed to be deployed to Cloudflare's edge with `wrangler deploy`.
// =============================================================================

// ============================================================================
//  Cell kinds
// ============================================================================

export const CellKind = {
  // Core kinds
  Value: 'value',
  Formula: 'formula',
  Program: 'program',
  Sensor: 'sensor',
  Api: 'api',
  Listener: 'listener',
  Router: 'router',
  Io: 'io',
  // AI kinds (Cloudflare-specific)
  AiLlm: 'ai.llm',
  AiEmbed: 'ai.embed',
  AiImage: 'ai.image',
  AiTranslate: 'ai.translate',
  AiSentiment: 'ai.sentiment',
  AiSummarize: 'ai.summarize',
  AiCode: 'ai.code',
} as const;

export type CellKindType = typeof CellKind[keyof typeof CellKind];

export interface Cell {
  id: string;
  kind: CellKindType;
  value?: any;
  config: {
    expr?: string;
    code?: string;
    source?: string;
    endpoint?: string;
    method?: string;
    watch?: string;
    condition?: string;
    action?: string;
    port?: string;
    direction?: 'in' | 'out';
    routes?: Array<{ when: string; expr: string }>;
    model?: string;
    prompt?: string;
    input?: string;
    from?: string;
    to?: string;
    language?: string;
    max_tokens?: number;
    poll_ms?: number;
    default?: any;
    description?: string;
  };
}

export interface Sheet {
  id: string;
  title?: string;
  version?: string;
  cells: Cell[];
  edges?: [string, string][];
}

export interface CellResult<T = any> {
  data: T;
  status: 'ready' | 'pending' | 'error';
  error?: { message: string; stack?: string };
  computedAt: number;
  t: number;
  author: string;
}

export interface CellEvent {
  cellId: string;
  oldValue: any;
  newValue: any;
  t: number;
  author: string;
  timestamp: number;
}

// ============================================================================
//  Storage interface
// ============================================================================

export interface CellStorage {
  load(sheetId: string): Promise<{ cells: Cell[]; edges: [string, string][] }>;
  save(sheetId: string, cells: Cell[]): Promise<void>;
  getValue(sheetId: string, cellId: string): Promise<{ value: any; t: number } | null>;
  setValue(sheetId: string, cellId: string, value: any, t: number, author: string): Promise<void>;
  appendHistory(sheetId: string, cellId: string, oldValue: any, newValue: any, t: number, author: string): Promise<void>;
  getHistory(sheetId: string, cellId: string, limit?: number): Promise<CellEvent[]>;
  listCells(sheetId: string): Promise<string[]>;
  listSheets(): Promise<string[]>;
}

// ============================================================================
//  D1 storage backend
// ============================================================================

export class D1Storage implements CellStorage {
  constructor(private db: D1Database, private author = 'cloudflare') {}

  async load(sheetId: string): Promise<{ cells: Cell[]; edges: [string, string][] }> {
    const cellsRes = await this.db
      .prepare('SELECT id, kind, value, value_type, t, metadata FROM cells WHERE sheet_id = ?')
      .bind(sheetId)
      .all();
    const cells: Cell[] = (cellsRes.results || []).map((row: any) => {
      let value: any = row.value;
      try { value = JSON.parse(row.value); } catch (e) {}
      let metadata: any = {};
      try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) {}
      return {
        id: row.id,
        kind: row.kind as CellKindType,
        value,
        config: metadata.config || {},
      };
    });
    const edgesRes = await this.db
      .prepare('SELECT from_id, to_id FROM edges WHERE sheet_id = ?')
      .bind(sheetId)
      .all();
    const edges: [string, string][] = (edgesRes.results || []).map((row: any) => [row.from_id, row.to_id]);
    return { cells, edges };
  }

  async save(sheetId: string, cells: Cell[]): Promise<void> {
    const now = Date.now();
    for (const cell of cells) {
      await this.db
        .prepare(`INSERT OR REPLACE INTO cells (sheet_id, id, kind, value, value_type, t, author, created_at, updated_at, metadata)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          sheetId,
          cell.id,
          cell.kind,
          JSON.stringify(cell.value),
          typeof cell.value,
          cell.config.t || 0,
          cell.config.author || this.author,
          now,
          now,
          JSON.stringify({ config: cell.config })
        )
        .run();
    }
    // Replace edges
    await this.db.prepare('DELETE FROM edges WHERE sheet_id = ?').bind(sheetId).run();
    for (const [from, to] of cells.flatMap(c => (c.config.expr ? this.findDeps(c.config.expr) : []).map(d => [d, c.id] as [string, string]))) {
      await this.db
        .prepare('INSERT OR REPLACE INTO edges (sheet_id, from_id, to_id) VALUES (?, ?, ?)')
        .bind(sheetId, from, to)
        .run();
    }
  }

  private findDeps(expr: string): string[] {
    const deps = new Set<string>();
    const matches = expr.matchAll(/([a-zA-Z_][a-zA-Z0-9_.]*)/g);
    for (const m of matches) {
      const id = m[1];
      if (!['true', 'false', 'null', 'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number'].includes(id)) {
        deps.add(id);
      }
    }
    return [...deps];
  }

  async getValue(sheetId: string, cellId: string): Promise<{ value: any; t: number } | null> {
    const res = await this.db
      .prepare('SELECT value, t FROM cells WHERE sheet_id = ? AND id = ?')
      .bind(sheetId, cellId)
      .first();
    if (!res) return null;
    try { return { value: JSON.parse((res as any).value), t: (res as any).t }; }
    catch (e) { return { value: (res as any).value, t: (res as any).t }; }
  }

  async setValue(sheetId: string, cellId: string, value: any, t: number, author: string): Promise<void> {
    const now = Date.now();
    const existing = await this.getValue(sheetId, cellId);
    await this.db
      .prepare(`UPDATE cells SET value = ?, value_type = ?, t = ?, author = ?, updated_at = ? WHERE sheet_id = ? AND id = ?`)
      .bind(JSON.stringify(value), typeof value, t, author, now, sheetId, cellId)
      .run();
    if (existing) {
      await this.appendHistory(sheetId, cellId, existing.value, value, t, author);
    }
  }

  async appendHistory(sheetId: string, cellId: string, oldValue: any, newValue: any, t: number, author: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO history (sheet_id, cell_id, old_value, new_value, t, author, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(sheetId, cellId, JSON.stringify(oldValue), JSON.stringify(newValue), t, author, Date.now())
      .run();
  }

  async getHistory(sheetId: string, cellId: string, limit = 100): Promise<CellEvent[]> {
    const res = await this.db
      .prepare('SELECT old_value, new_value, t, author, created_at FROM history WHERE sheet_id = ? AND cell_id = ? ORDER BY t DESC LIMIT ?')
      .bind(sheetId, cellId, limit)
      .all();
    return (res.results || []).map((row: any) => {
      let oldValue: any, newValue: any;
      try { oldValue = JSON.parse(row.old_value); } catch (e) { oldValue = row.old_value; }
      try { newValue = JSON.parse(row.new_value); } catch (e) { newValue = row.new_value; }
      return {
        cellId,
        oldValue,
        newValue,
        t: row.t,
        author: row.author,
        timestamp: row.created_at,
      };
    });
  }

  async listCells(sheetId: string): Promise<string[]> {
    const res = await this.db
      .prepare('SELECT id FROM cells WHERE sheet_id = ? ORDER BY id')
      .bind(sheetId)
      .all();
    return (res.results || []).map((row: any) => row.id);
  }

  async listSheets(): Promise<string[]> {
    const res = await this.db
      .prepare('SELECT DISTINCT sheet_id FROM cells ORDER BY sheet_id')
      .all();
    return (res.results || []).map((row: any) => row.sheet_id);
  }
}

// ============================================================================
//  KV cache (ephemeral state)
// ============================================================================

export class KVCache {
  constructor(private kv: KVNamespace) {}

  async get<T = any>(key: string): Promise<T | null> {
    const v = await this.kv.get(key, 'json');
    return v as T;
  }

  async set(key: string, value: any, ttl = 60): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

// ============================================================================
//  Vectorize semantic search
// ============================================================================

export class VectorizeSearch {
  constructor(private index: VectorizeIndex) {}

  async index(sheetId: string, cellId: string, value: any, vector: number[]): Promise<void> {
    const id = `${sheetId}::${cellId}`;
    await this.index.upsert([{
      id,
      values: vector,
      metadata: { sheetId, cellId, value: JSON.stringify(value).slice(0, 1000) },
    }]);
  }

  async search(sheetId: string, query: number[], topK = 5): Promise<Array<{ cellId: string; score: number; value: any }>> {
    const results = await this.index.query(query, { topK, filter: { sheetId } });
    return (results.matches || []).map((m: any) => ({
      cellId: m.metadata?.cellId,
      score: m.score,
      value: m.metadata?.value,
    }));
  }
}

// ============================================================================
//  Cloudflare AI (Workers AI)
// ============================================================================

export class CloudflareAI {
  constructor(private ai: Ai) {}

  async run(model: string, inputs: any): Promise<any> {
    return await this.ai.run(model as any, inputs);
  }

  async llm(model: string, prompt: string, maxTokens = 500): Promise<string> {
    const res: any = await this.ai.run(model as any, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    });
    return res.response || res.output || JSON.stringify(res);
  }

  async embed(model: string, text: string): Promise<number[]> {
    const res: any = await this.ai.run(model as any, { text });
    return res.data?.[0] || res.embedding || res.vector || [];
  }

  async classify(model: string, image: string | ArrayBuffer): Promise<any> {
    const res: any = await this.ai.run(model as any, { image });
    return res;
  }

  async translate(model: string, text: string, from: string, to: string): Promise<string> {
    const res: any = await this.ai.run(model as any, { text, source_lang: from, target_lang: to });
    return res.translated_text || res.response || JSON.stringify(res);
  }

  async summarize(model: string, text: string, maxTokens = 200): Promise<string> {
    const res: any = await this.ai.run(model as any, { input_text: text, max_length: maxTokens });
    return res.summary || res.response || JSON.stringify(res);
  }

  async sentiment(model: string, text: string): Promise<number> {
    const res: any = await this.ai.run(model as any, { text });
    return res.score || res.sentiment || 0;
  }
}

// ============================================================================
//  YAML sheet parser (subset)
// ============================================================================

export function parseSheet(yaml: string): Sheet {
  const lines = yaml.split('\n');
  const cells: Cell[] = [];
  const edges: [string, string][] = [];
  let current: Cell | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const idMatch = line.match(/^\s*-\s*id:\s*(.+?)\s*$/);
    if (idMatch) {
      if (current) cells.push(current);
      current = { id: idMatch[1].replace(/^["']|["']$/g, ''), kind: 'value', config: {} };
      i++;
      continue;
    }

    if (current) {
      const km = line.match(/^\s+kind:\s*(.+?)\s*$/);
      if (km) {
        current.kind = km[1].trim() as CellKindType;
        i++;
        continue;
      }

      const em = line.match(/^\s+expr:\s*(.+?)\s*$/);
      if (em) { current.config.expr = em[1].replace(/^["']|["']$/g, ''); i++; continue; }

      const cm = line.match(/^\s+code:\s*[|>]-?\s*$/);
      if (cm) {
        const indent = line.match(/^(\s+)/)![1].length;
        let ml = '';
        i++;
        while (i < lines.length) {
          const l = lines[i];
          const m = l.match(/^(\s+)(.*)$/);
          if (!m || m[1].length <= indent || !m[2].trim()) {
            if (m && !m[2].trim()) { i++; continue; }
            break;
          }
          ml += m[2] + '\n';
          i++;
        }
        current.config.code = ml.trim();
        continue;
      }

      const vm = line.match(/^\s+value:\s*(.+?)\s*$/);
      if (vm) {
        let v: any = vm[1];
        if (v === 'true') v = true; else if (v === 'false') v = false; else if (v === 'null') v = null;
        else if (!isNaN(Number(v)) && v !== '') v = Number(v);
        else v = v.replace(/^["']|["']$/g, '');
        current.value = v;
        current.config.value = v;
        i++;
        continue;
      }

      const pm = line.match(/^\s+prompt:\s*(.+?)\s*$/);
      if (pm) { current.config.prompt = pm[1].replace(/^["']|["']$/g, ''); i++; continue; }

      const modm = line.match(/^\s+model:\s*(.+?)\s*$/);
      if (modm) { current.config.model = modm[1].replace(/^["']|["']$/g, ''); i++; continue; }

      const wm = line.match(/^\s+watch:\s*(.+?)\s*$/);
      if (wm) { current.config.watch = wm[1].replace(/^["']|["']$/g, ''); i++; continue; }

      const cdm = line.match(/^\s+condition:\s*(.+?)\s*$/);
      if (cdm) { current.config.condition = cdm[1].replace(/^["']|["']$/g, ''); i++; continue; }

      const am = line.match(/^\s+action:\s*(.+?)\s*$/);
      if (am) { current.config.action = am[1].replace(/^["']|["']$/g, ''); i++; continue; }

      const dsc = line.match(/^\s+description:\s*(.+?)\s*$/);
      if (dsc) { current.config.description = dsc[1].replace(/^["']|["']$/g, ''); i++; continue; }
    }
    i++;
  }
  if (current) cells.push(current);

  // Compute edges from formula deps
  for (const cell of cells) {
    if (cell.config.expr) {
      const deps = findDeps(cell.config.expr);
      for (const dep of deps) {
        if (cells.some(c => c.id === dep) && dep !== cell.id) {
          edges.push([dep, cell.id]);
        }
      }
    }
    if (cell.config.watch && cell.config.watch !== cell.id) {
      edges.push([cell.config.watch, cell.id]);
    }
    if (cell.config.input && cells.some(c => c.id === cell.config.input)) {
      edges.push([cell.config.input, cell.id]);
    }
  }

  return { id: 'default', cells, edges };
}

function findDeps(expr: string): string[] {
  const deps = new Set<string>();
  const matches = expr.matchAll(/([a-zA-Z_][a-zA-Z0-9_.]*)/g);
  for (const m of matches) {
    const id = m[1];
    if (!['true', 'false', 'null', 'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'undefined'].includes(id)) {
      deps.add(id);
    }
  }
  return [...deps];
}

// ============================================================================
//  The Quilt engine
// ============================================================================

export interface EngineOptions {
  storage: CellStorage;
  ai?: CloudflareAI;
  cache?: KVCache;
  vectorize?: VectorizeSearch;
  sheetId?: string;
  author?: string;
}

export class QuiltEngine {
  private cells = new Map<string, Cell>();
  private values = new Map<string, { value: any; t: number; author: string }>();
  private listeners: Array<{ cell: Cell; watch: string; condition?: string; action?: string }> = [];
  private edges: [string, string][] = [];
  private eventLog: CellEvent[] = [];
  private lamport = 0;
  private sheetId: string;
  private author: string;

  constructor(private opts: EngineOptions) {
    this.sheetId = opts.sheetId || 'default';
    this.author = opts.author || 'cloudflare';
  }

  async load(sheet: Sheet): Promise<void> {
    for (const cell of sheet.cells) {
      this.cells.set(cell.id, cell);
      if (cell.value !== undefined) {
        this.values.set(cell.id, { value: cell.value, t: 0, author: this.author });
      }
    }
    this.edges = sheet.edges || [];
    for (const cell of sheet.cells) {
      if (cell.kind === CellKind.Listener && cell.config.watch) {
        this.listeners.push({ cell, watch: cell.config.watch, condition: cell.config.condition, action: cell.config.action });
      }
    }
    await this.opts.storage.save(this.sheetId, sheet.cells);
  }

  async loadFromStorage(): Promise<void> {
    const { cells, edges } = await this.opts.storage.load(this.sheetId);
    for (const cell of cells) {
      this.cells.set(cell.id, cell);
      if (cell.value !== undefined) {
        this.values.set(cell.id, { value: cell.value, t: 0, author: this.author });
      }
    }
    this.edges = edges;
    for (const cell of cells) {
      if (cell.kind === CellKind.Listener && cell.config.watch) {
        this.listeners.push({ cell, watch: cell.config.watch, condition: cell.config.condition, action: cell.config.action });
      }
    }
  }

  tick(): number { return ++this.lamport; }

  async set(id: string, value: any, author = this.author): Promise<void> {
    const cell = this.cells.get(id);
    if (!cell) throw new Error(`cell not found: ${id}`);
    const t = this.tick();
    const oldValue = this.values.get(id)?.value;
    this.values.set(id, { value, t, author });
    const event: CellEvent = { cellId: id, oldValue, newValue: value, t, author, timestamp: Date.now() };
    this.eventLog.push(event);
    if (this.opts.storage) {
      await this.opts.storage.setValue(this.sheetId, id, value, t, author);
    }
    // Cascade
    await this.cascade(id);
  }

  async get(id: string): Promise<CellResult> {
    // Compute if not yet computed
    if (!this.values.has(id)) {
      await this.compute(id);
    }
    const entry = this.values.get(id);
    if (!entry) return { data: null, status: 'error', error: { message: 'not found' }, computedAt: Date.now(), t: 0, author: this.author };
    return { data: entry.value, status: 'ready', computedAt: Date.now(), t: entry.t, author: entry.author };
  }

  async getAll(): Promise<Record<string, CellResult>> {
    const out: Record<string, CellResult> = {};
    for (const id of this.cells.keys()) {
      out[id] = await this.get(id);
    }
    return out;
  }

  async cascade(rootId: string): Promise<void> {
    const visited = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const [from, to] of this.edges) {
        if (from === id && !visited.has(to)) {
          await this.compute(to);
          queue.push(to);
        }
      }
    }
  }

  async compute(id: string): Promise<any> {
    const cell = this.cells.get(id);
    if (!cell) return null;

    try {
      let value: any;
      switch (cell.kind) {
        case CellKind.Value:
          value = cell.value !== undefined ? cell.value : this.values.get(id)?.value;
          break;
        case CellKind.Formula:
          value = this.evalFormula(cell);
          break;
        case CellKind.Program:
          value = await this.evalProgram(cell);
          break;
        case CellKind.AiLlm:
          value = await this.evalAiLlm(cell);
          break;
        case CellKind.AiEmbed:
          value = await this.evalAiEmbed(cell);
          break;
        case CellKind.AiImage:
          value = await this.evalAiImage(cell);
          break;
        case CellKind.AiTranslate:
          value = await this.evalAiTranslate(cell);
          break;
        case CellKind.AiSentiment:
          value = await this.evalAiSentiment(cell);
          break;
        case CellKind.AiSummarize:
          value = await this.evalAiSummarize(cell);
          break;
        case CellKind.AiCode:
          value = await this.evalAiCode(cell);
          break;
        case CellKind.Router:
          value = this.evalRouter(cell);
          break;
        default:
          value = cell.value !== undefined ? cell.value : null;
      }
      const t = this.tick();
      this.values.set(id, { value, t, author: this.author });
      // Fire listeners
      for (const listener of this.listeners) {
        if (listener.watch === id) {
          this.fireListener(listener, value);
        }
      }
      return value;
    } catch (e: any) {
      const error = { data: null, status: 'error', error: { message: e.message, stack: e.stack }, computedAt: Date.now(), t: 0, author: this.author };
      this.values.set(id, { value: null, t: 0, author: this.author });
      return error;
    }
  }

  private evalFormula(cell: Cell): any {
    if (!cell.config.expr) return null;
    const env: Record<string, any> = {};
    for (const [from, to] of this.edges) {
      if (to === cell.id) {
        const v = this.values.get(from)?.value;
        env[from] = v;
        // also expose underscored alias
        env[from.replace(/\./g, '_')] = v;
      }
    }
    const expr = cell.config.expr.replace(/([a-zA-Z_][a-zA-Z0-9_.]*)/g, (m) => m.includes('.') ? m.replace(/\./g, '_') : m);
    const fn = new Function('Math', 'JSON', 'Date', 'with(arguments[3]) { return (' + expr + '); }');
    return fn(Math, JSON, Date, env);
  }

  private async evalProgram(cell: Cell): Promise<any> {
    if (!cell.config.code) return null;
    const runtime = {
      get: (id: string) => this.values.get(id)?.value,
      set: async (id: string, v: any) => { await this.set(id, v); },
      call: async (id: string, args?: any) => this.values.get(id)?.value,
      cells: new Proxy({}, { get: (_, k: string) => this.values.get(k as string)?.value }),
      log: (...args: any[]) => console.log(...args),
      fetch: (url: string, opts?: any) => fetch(url, opts),
    };
    const fn = new Function('runtime', `return (async () => { ${cell.config.code} })();`);
    return await fn(runtime);
  }

  private async evalAiLlm(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const prompt = this.resolveTemplate(cell.config.prompt || '');
    const model = cell.config.model || '@cf/meta/llama-3-8b-instruct';
    return await this.opts.ai.llm(model, prompt, cell.config.max_tokens);
  }

  private async evalAiEmbed(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const input = this.resolveInput(cell.config.input || '');
    const model = cell.config.model || '@cf/baai/bge-base-en-v1.5';
    return await this.opts.ai.embed(model, input);
  }

  private async evalAiImage(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const input = this.resolveInput(cell.config.input || '');
    const model = cell.config.model || '@cf/microsoft/resnet-50';
    return await this.opts.ai.classify(model, input);
  }

  private async evalAiTranslate(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const input = this.resolveInput(cell.config.input || '');
    const model = cell.config.model || '@cf/meta/m2m100-1.2b';
    return await this.opts.ai.translate(model, input, cell.config.from || 'en', cell.config.to || 'es');
  }

  private async evalAiSentiment(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const input = this.resolveInput(cell.config.input || '');
    return await this.opts.ai.sentiment('@cf/huggingface/distilbert-sst-2-int8', input);
  }

  private async evalAiSummarize(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const input = this.resolveInput(cell.config.input || '');
    return await this.opts.ai.summarize('@cf/summarization/distilbart-cnn-12-6', input, cell.config.max_tokens || 200);
  }

  private async evalAiCode(cell: Cell): Promise<any> {
    if (!this.opts.ai) throw new Error('AI not configured');
    const prompt = this.resolveTemplate(cell.config.prompt || '');
    const lang = cell.config.language || 'python';
    const fullPrompt = `Generate ${lang} code for: ${prompt}. Return only the code, no explanation.`;
    return await this.opts.ai.llm('@cf/meta/llama-3-8b-instruct', fullPrompt, cell.config.max_tokens || 500);
  }

  private evalRouter(cell: Cell): any {
    if (!cell.config.routes) return null;
    const env: Record<string, any> = {};
    for (const [from, to] of this.edges) {
      if (to === cell.id) {
        env[from] = this.values.get(from)?.value;
      }
    }
    for (const route of cell.config.routes) {
      try {
        const fn = new Function('caller', 'with(arguments[0]) { return (' + route.when + '); }');
        if (fn({ role: 'caller', ...env })) {
          const expr = route.expr.replace(/([a-zA-Z_][a-zA-Z0-9_.]*)/g, m => m.includes('.') ? m.replace(/\./g, '_') : m);
          const valueFn = new Function('with(arguments[0]) { return (' + expr + '); }');
          return valueFn(env);
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  private resolveTemplate(template: string): string {
    return template.replace(/([a-zA-Z_][a-zA-Z0-9_.]*)/g, (m) => {
      const v = this.values.get(m);
      if (v !== undefined) return JSON.stringify(v.value);
      return m;
    });
  }

  private resolveInput(input: string): string {
    return this.resolveTemplate(input);
  }

  private fireListener(listener: any, value: any): void {
    try {
      let conditionMet = true;
      if (listener.condition) {
        const env: Record<string, any> = { [listener.watch]: value };
        const fn = new Function('with(arguments[0]) { return (' + listener.condition + '); }');
        conditionMet = !!fn(env);
      }
      if (conditionMet && listener.action) {
        console.log(`[listener:${listener.cell.id}] ${listener.action}`);
      }
    } catch (e) { /* ignore */ }
  }

  listCells(): string[] { return [...this.cells.keys()]; }
  listEdges(): [string, string][] { return this.edges; }
  getEventLog(): CellEvent[] { return this.eventLog; }
}

// ============================================================================
//  Worker entry point
// ============================================================================

export interface Env {
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  CACHE?: KVNamespace;
  R2?: R2Bucket;
  AI?: Ai;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const storage = new D1Storage(env.DB);
    const ai = env.AI ? new CloudflareAI(env.AI) : undefined;
    const cache = env.CACHE ? new KVCache(env.CACHE) : undefined;
    const vectorize = env.VECTORIZE ? new VectorizeSearch(env.VECTORIZE) : undefined;
    const engine = new QuiltEngine({ storage, ai, cache, vectorize });

    // CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === '/' || url.pathname === '') {
        return new Response(HTML_INDEX, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() } });
      }

      if (url.pathname === '/sheet' && req.method === 'POST') {
        const yaml = await req.text();
        const sheet = parseSheet(yaml);
        sheet.id = url.searchParams.get('id') || 'default';
        await engine.load(sheet);
        return Response.json({ ok: true, sheetId: sheet.id, cells: sheet.cells.length, edges: sheet.edges?.length || 0 }, { headers: corsHeaders() });
      }

      if (url.pathname === '/sheets' && req.method === 'GET') {
        const sheets = await storage.listSheets();
        return Response.json({ sheets }, { headers: corsHeaders() });
      }

      if (url.pathname.startsWith('/cell/')) {
        const id = decodeURIComponent(url.pathname.slice(6));
        const result = await engine.get(id);
        return Response.json(result, { headers: corsHeaders() });
      }

      if (url.pathname === '/cells' && req.method === 'GET') {
        await engine.loadFromStorage();
        const all = await engine.getAll();
        return Response.json(all, { headers: corsHeaders() });
      }

      if (url.pathname.startsWith('/set/') && req.method === 'POST') {
        const id = decodeURIComponent(url.pathname.slice(5));
        const body = await req.json() as { value: any };
        await engine.loadFromStorage();
        await engine.set(id, body.value);
        return Response.json({ ok: true }, { headers: corsHeaders() });
      }

      if (url.pathname === '/mcp' && req.method === 'POST') {
        return handleMCP(req, env, ctx);
      }

      if (url.pathname === '/mcp/sse') {
        return handleMCPStream(req, env, ctx);
      }

      return new Response('Not found: ' + url.pathname, { status: 404, headers: corsHeaders() });
    } catch (e: any) {
      return Response.json({ error: e.message, stack: e.stack }, { status: 500, headers: corsHeaders() });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Run sensor cells on a schedule (cron trigger)
    const storage = new D1Storage(env.DB);
    const engine = new QuiltEngine({ storage });
    await engine.loadFromStorage();
    // For each sensor cell, refresh
    // (simplified — in production, you'd call the appropriate adapter)
  },
};

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handleMCP(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.json() as any;
  const { method, params, id } = body;
  const storage = new D1Storage(env.DB);
  const engine = new QuiltEngine({ storage });

  if (method === 'tools/list') {
    await engine.loadFromStorage();
    const tools = engine.listCells().map(cellId => ({
      name: cellId,
      description: `Quilt cell: ${cellId}`,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    }));
    return Response.json({ jsonrpc: '2.0', id, result: { tools } }, { headers: corsHeaders() });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    await engine.loadFromStorage();
    if (args?.value !== undefined) {
      await engine.set(name, args.value);
    }
    const result = await engine.get(name);
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        isError: result.status === 'error',
      },
    }, { headers: corsHeaders() });
  }

  return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }, { headers: corsHeaders() });
}

async function handleMCPStream(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('endpoint', { uri: '/mcp' });
      // Keep alive
      const interval = setInterval(() => send('ping', {}), 30000);
      // Close on abort
      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', ...corsHeaders() },
  });
}

const HTML_INDEX = `<!DOCTYPE html>
<html><head><title>Quilt on Cloudflare</title></head>
<body>
<h1>Quilt on Cloudflare</h1>
<p>The reactive runtime, running on the edge.</p>
<h2>Try it</h2>
<pre>
# Load a sheet
curl -X POST https://YOUR_WORKER.workers.dev/sheet -d "$(cat weather.yaml)"

# Get a cell
curl https://YOUR_WORKER.workers.dev/cell/sensor.temp

# Set a cell
curl -X POST https://YOUR_WORKER.workers.dev/set/sensor.temp -H "Content-Type: application/json" -d '{"value": 25}'
</pre>
</body></html>`;
