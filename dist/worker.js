var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.ts
var CellKind = {
  // Core kinds
  Value: "value",
  Formula: "formula",
  Program: "program",
  Sensor: "sensor",
  Api: "api",
  Listener: "listener",
  Router: "router",
  Io: "io",
  // AI kinds (Cloudflare-specific)
  AiLlm: "ai.llm",
  AiEmbed: "ai.embed",
  AiImage: "ai.image",
  AiTranslate: "ai.translate",
  AiSentiment: "ai.sentiment",
  AiSummarize: "ai.summarize",
  AiCode: "ai.code"
};
var D1Storage = class {
  constructor(db, author = "cloudflare") {
    this.db = db;
    this.author = author;
  }
  db;
  author;
  static {
    __name(this, "D1Storage");
  }
  async load(sheetId) {
    const cellsRes = await this.db.prepare("SELECT id, kind, value, value_type, t, metadata FROM cells WHERE sheet_id = ?").bind(sheetId).all();
    const cells = (cellsRes.results || []).map((row) => {
      let value = row.value;
      try {
        value = JSON.parse(row.value);
      } catch (e) {
      }
      let metadata = {};
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {};
      } catch (e) {
      }
      return {
        id: row.id,
        kind: row.kind,
        value,
        config: metadata.config || {}
      };
    });
    const edgesRes = await this.db.prepare("SELECT from_id, to_id FROM edges WHERE sheet_id = ?").bind(sheetId).all();
    const edges = (edgesRes.results || []).map((row) => [row.from_id, row.to_id]);
    return { cells, edges };
  }
  async save(sheetId, cells) {
    const now = Date.now();
    for (const cell of cells) {
      await this.db.prepare(`INSERT OR REPLACE INTO cells (sheet_id, id, kind, value, value_type, t, author, created_at, updated_at, metadata)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
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
      ).run();
    }
    await this.db.prepare("DELETE FROM edges WHERE sheet_id = ?").bind(sheetId).run();
    for (const [from, to] of cells.flatMap((c) => (c.config.expr ? this.findDeps(c.config.expr) : []).map((d) => [d, c.id]))) {
      await this.db.prepare("INSERT OR REPLACE INTO edges (sheet_id, from_id, to_id) VALUES (?, ?, ?)").bind(sheetId, from, to).run();
    }
  }
  findDeps(expr) {
    const deps = /* @__PURE__ */ new Set();
    const matches = expr.matchAll(/([a-zA-Z_][a-zA-Z0-9_.]*)/g);
    for (const m of matches) {
      const id = m[1];
      if (!["true", "false", "null", "Math", "JSON", "Date", "Array", "Object", "String", "Number"].includes(id)) {
        deps.add(id);
      }
    }
    return [...deps];
  }
  async getValue(sheetId, cellId) {
    const res = await this.db.prepare("SELECT value, t FROM cells WHERE sheet_id = ? AND id = ?").bind(sheetId, cellId).first();
    if (!res) return null;
    try {
      return { value: JSON.parse(res.value), t: res.t };
    } catch (e) {
      return { value: res.value, t: res.t };
    }
  }
  async setValue(sheetId, cellId, value, t, author) {
    const now = Date.now();
    const existing = await this.getValue(sheetId, cellId);
    await this.db.prepare(`UPDATE cells SET value = ?, value_type = ?, t = ?, author = ?, updated_at = ? WHERE sheet_id = ? AND id = ?`).bind(JSON.stringify(value), typeof value, t, author, now, sheetId, cellId).run();
    if (existing) {
      await this.appendHistory(sheetId, cellId, existing.value, value, t, author);
    }
  }
  async appendHistory(sheetId, cellId, oldValue, newValue, t, author) {
    await this.db.prepare(`INSERT INTO history (sheet_id, cell_id, old_value, new_value, t, author, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(sheetId, cellId, JSON.stringify(oldValue), JSON.stringify(newValue), t, author, Date.now()).run();
  }
  async getHistory(sheetId, cellId, limit = 100) {
    const res = await this.db.prepare("SELECT old_value, new_value, t, author, created_at FROM history WHERE sheet_id = ? AND cell_id = ? ORDER BY t DESC LIMIT ?").bind(sheetId, cellId, limit).all();
    return (res.results || []).map((row) => {
      let oldValue, newValue;
      try {
        oldValue = JSON.parse(row.old_value);
      } catch (e) {
        oldValue = row.old_value;
      }
      try {
        newValue = JSON.parse(row.new_value);
      } catch (e) {
        newValue = row.new_value;
      }
      return {
        cellId,
        oldValue,
        newValue,
        t: row.t,
        author: row.author,
        timestamp: row.created_at
      };
    });
  }
  async listCells(sheetId) {
    const res = await this.db.prepare("SELECT id FROM cells WHERE sheet_id = ? ORDER BY id").bind(sheetId).all();
    return (res.results || []).map((row) => row.id);
  }
  async listSheets() {
    const res = await this.db.prepare("SELECT DISTINCT sheet_id FROM cells ORDER BY sheet_id").all();
    return (res.results || []).map((row) => row.sheet_id);
  }
};
var KVCache = class {
  constructor(kv) {
    this.kv = kv;
  }
  kv;
  static {
    __name(this, "KVCache");
  }
  async get(key) {
    const v = await this.kv.get(key, "json");
    return v;
  }
  async set(key, value, ttl = 60) {
    await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  }
  async delete(key) {
    await this.kv.delete(key);
  }
};
var VectorizeSearch = class {
  constructor(index) {
    this.index = index;
  }
  index;
  static {
    __name(this, "VectorizeSearch");
  }
  async index(sheetId, cellId, value, vector) {
    const id = `${sheetId}::${cellId}`;
    await this.index.upsert([{
      id,
      values: vector,
      metadata: { sheetId, cellId, value: JSON.stringify(value).slice(0, 1e3) }
    }]);
  }
  async search(sheetId, query, topK = 5) {
    const results = await this.index.query(query, { topK, filter: { sheetId } });
    return (results.matches || []).map((m) => ({
      cellId: m.metadata?.cellId,
      score: m.score,
      value: m.metadata?.value
    }));
  }
};
var CloudflareAI = class {
  constructor(ai) {
    this.ai = ai;
  }
  ai;
  static {
    __name(this, "CloudflareAI");
  }
  async run(model, inputs) {
    return await this.ai.run(model, inputs);
  }
  async llm(model, prompt, maxTokens = 500) {
    const res = await this.ai.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens
    });
    return res.response || res.output || JSON.stringify(res);
  }
  async embed(model, text) {
    const res = await this.ai.run(model, { text });
    return res.data?.[0] || res.embedding || res.vector || [];
  }
  async classify(model, image) {
    const res = await this.ai.run(model, { image });
    return res;
  }
  async translate(model, text, from, to) {
    const res = await this.ai.run(model, { text, source_lang: from, target_lang: to });
    return res.translated_text || res.response || JSON.stringify(res);
  }
  async summarize(model, text, maxTokens = 200) {
    const res = await this.ai.run(model, { input_text: text, max_length: maxTokens });
    return res.summary || res.response || JSON.stringify(res);
  }
  async sentiment(model, text) {
    const res = await this.ai.run(model, { text });
    return res.score || res.sentiment || 0;
  }
};
function parseSheet(yaml) {
  const lines = yaml.split("\n");
  const cells = [];
  const edges = [];
  let current = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const idMatch = line.match(/^\s*-\s*id:\s*(.+?)\s*$/);
    if (idMatch) {
      if (current) cells.push(current);
      current = { id: idMatch[1].replace(/^["']|["']$/g, ""), kind: "value", config: {} };
      i++;
      continue;
    }
    if (current) {
      const km = line.match(/^\s+kind:\s*(.+?)\s*$/);
      if (km) {
        current.kind = km[1].trim();
        i++;
        continue;
      }
      const em = line.match(/^\s+expr:\s*(.+?)\s*$/);
      if (em) {
        current.config.expr = em[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
      const cm = line.match(/^\s+code:\s*[|>]-?\s*$/);
      if (cm) {
        const indent = line.match(/^(\s+)/)[1].length;
        let ml = "";
        i++;
        while (i < lines.length) {
          const l = lines[i];
          const m = l.match(/^(\s+)(.*)$/);
          if (!m || m[1].length <= indent || !m[2].trim()) {
            if (m && !m[2].trim()) {
              i++;
              continue;
            }
            break;
          }
          ml += m[2] + "\n";
          i++;
        }
        current.config.code = ml.trim();
        continue;
      }
      const vm = line.match(/^\s+value:\s*(.+?)\s*$/);
      if (vm) {
        let v = vm[1];
        if (v === "true") v = true;
        else if (v === "false") v = false;
        else if (v === "null") v = null;
        else if (!isNaN(Number(v)) && v !== "") v = Number(v);
        else v = v.replace(/^["']|["']$/g, "");
        current.value = v;
        current.config.value = v;
        i++;
        continue;
      }
      const pm = line.match(/^\s+prompt:\s*(.+?)\s*$/);
      if (pm) {
        current.config.prompt = pm[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
      const modm = line.match(/^\s+model:\s*(.+?)\s*$/);
      if (modm) {
        current.config.model = modm[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
      const wm = line.match(/^\s+watch:\s*(.+?)\s*$/);
      if (wm) {
        current.config.watch = wm[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
      const cdm = line.match(/^\s+condition:\s*(.+?)\s*$/);
      if (cdm) {
        current.config.condition = cdm[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
      const am = line.match(/^\s+action:\s*(.+?)\s*$/);
      if (am) {
        current.config.action = am[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
      const dsc = line.match(/^\s+description:\s*(.+?)\s*$/);
      if (dsc) {
        current.config.description = dsc[1].replace(/^["']|["']$/g, "");
        i++;
        continue;
      }
    }
    i++;
  }
  if (current) cells.push(current);
  for (const cell of cells) {
    if (cell.config.expr) {
      const deps = findDeps(cell.config.expr);
      for (const dep of deps) {
        if (cells.some((c) => c.id === dep) && dep !== cell.id) {
          edges.push([dep, cell.id]);
        }
      }
    }
    if (cell.config.watch && cell.config.watch !== cell.id) {
      edges.push([cell.config.watch, cell.id]);
    }
    if (cell.config.input && cells.some((c) => c.id === cell.config.input)) {
      edges.push([cell.config.input, cell.id]);
    }
  }
  return { id: "default", cells, edges };
}
__name(parseSheet, "parseSheet");
function findDeps(expr) {
  const deps = /* @__PURE__ */ new Set();
  const matches = expr.matchAll(/([a-zA-Z_][a-zA-Z0-9_.]*)/g);
  for (const m of matches) {
    const id = m[1];
    if (!["true", "false", "null", "Math", "JSON", "Date", "Array", "Object", "String", "Number", "undefined"].includes(id)) {
      deps.add(id);
    }
  }
  return [...deps];
}
__name(findDeps, "findDeps");
var QuiltEngine = class {
  constructor(opts) {
    this.opts = opts;
    this.sheetId = opts.sheetId || "default";
    this.author = opts.author || "cloudflare";
  }
  opts;
  static {
    __name(this, "QuiltEngine");
  }
  cells = /* @__PURE__ */ new Map();
  values = /* @__PURE__ */ new Map();
  listeners = [];
  edges = [];
  eventLog = [];
  lamport = 0;
  sheetId;
  author;
  async load(sheet) {
    for (const cell of sheet.cells) {
      this.cells.set(cell.id, cell);
      if (cell.value !== void 0) {
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
  async loadFromStorage() {
    const { cells, edges } = await this.opts.storage.load(this.sheetId);
    for (const cell of cells) {
      this.cells.set(cell.id, cell);
      if (cell.value !== void 0) {
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
  tick() {
    return ++this.lamport;
  }
  async set(id, value, author = this.author) {
    const cell = this.cells.get(id);
    if (!cell) throw new Error(`cell not found: ${id}`);
    const t = this.tick();
    const oldValue = this.values.get(id)?.value;
    this.values.set(id, { value, t, author });
    const event = { cellId: id, oldValue, newValue: value, t, author, timestamp: Date.now() };
    this.eventLog.push(event);
    if (this.opts.storage) {
      await this.opts.storage.setValue(this.sheetId, id, value, t, author);
    }
    await this.cascade(id);
  }
  async get(id) {
    if (!this.values.has(id)) {
      await this.compute(id);
    }
    const entry = this.values.get(id);
    if (!entry) return { data: null, status: "error", error: { message: "not found" }, computedAt: Date.now(), t: 0, author: this.author };
    return { data: entry.value, status: "ready", computedAt: Date.now(), t: entry.t, author: entry.author };
  }
  async getAll() {
    const out = {};
    for (const id of this.cells.keys()) {
      out[id] = await this.get(id);
    }
    return out;
  }
  async cascade(rootId) {
    const visited = /* @__PURE__ */ new Set();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
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
  async compute(id) {
    const cell = this.cells.get(id);
    if (!cell) return null;
    try {
      let value;
      switch (cell.kind) {
        case CellKind.Value:
          value = cell.value !== void 0 ? cell.value : this.values.get(id)?.value;
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
          value = cell.value !== void 0 ? cell.value : null;
      }
      const t = this.tick();
      this.values.set(id, { value, t, author: this.author });
      for (const listener of this.listeners) {
        if (listener.watch === id) {
          this.fireListener(listener, value);
        }
      }
      return value;
    } catch (e) {
      const error = { data: null, status: "error", error: { message: e.message, stack: e.stack }, computedAt: Date.now(), t: 0, author: this.author };
      this.values.set(id, { value: null, t: 0, author: this.author });
      return error;
    }
  }
  evalFormula(cell) {
    if (!cell.config.expr) return null;
    const env = {};
    for (const [from, to] of this.edges) {
      if (to === cell.id) {
        const v = this.values.get(from)?.value;
        env[from] = v;
        env[from.replace(/\./g, "_")] = v;
      }
    }
    const expr = cell.config.expr.replace(/([a-zA-Z_][a-zA-Z0-9_.]*)/g, (m) => m.includes(".") ? m.replace(/\./g, "_") : m);
    const fn = new Function("Math", "JSON", "Date", "with(arguments[3]) { return (" + expr + "); }");
    return fn(Math, JSON, Date, env);
  }
  async evalProgram(cell) {
    if (!cell.config.code) return null;
    const runtime = {
      get: /* @__PURE__ */ __name((id) => this.values.get(id)?.value, "get"),
      set: /* @__PURE__ */ __name(async (id, v) => {
        await this.set(id, v);
      }, "set"),
      call: /* @__PURE__ */ __name(async (id, args) => this.values.get(id)?.value, "call"),
      cells: new Proxy({}, { get: /* @__PURE__ */ __name((_, k) => this.values.get(k)?.value, "get") }),
      log: /* @__PURE__ */ __name((...args) => console.log(...args), "log"),
      fetch: /* @__PURE__ */ __name((url, opts) => fetch(url, opts), "fetch")
    };
    const fn = new Function("runtime", `return (async () => { ${cell.config.code} })();`);
    return await fn(runtime);
  }
  async evalAiLlm(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const prompt = this.resolveTemplate(cell.config.prompt || "");
    const model = cell.config.model || "@cf/meta/llama-3-8b-instruct";
    return await this.opts.ai.llm(model, prompt, cell.config.max_tokens);
  }
  async evalAiEmbed(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const input = this.resolveInput(cell.config.input || "");
    const model = cell.config.model || "@cf/baai/bge-base-en-v1.5";
    return await this.opts.ai.embed(model, input);
  }
  async evalAiImage(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const input = this.resolveInput(cell.config.input || "");
    const model = cell.config.model || "@cf/microsoft/resnet-50";
    return await this.opts.ai.classify(model, input);
  }
  async evalAiTranslate(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const input = this.resolveInput(cell.config.input || "");
    const model = cell.config.model || "@cf/meta/m2m100-1.2b";
    return await this.opts.ai.translate(model, input, cell.config.from || "en", cell.config.to || "es");
  }
  async evalAiSentiment(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const input = this.resolveInput(cell.config.input || "");
    return await this.opts.ai.sentiment("@cf/huggingface/distilbert-sst-2-int8", input);
  }
  async evalAiSummarize(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const input = this.resolveInput(cell.config.input || "");
    return await this.opts.ai.summarize("@cf/summarization/distilbart-cnn-12-6", input, cell.config.max_tokens || 200);
  }
  async evalAiCode(cell) {
    if (!this.opts.ai) throw new Error("AI not configured");
    const prompt = this.resolveTemplate(cell.config.prompt || "");
    const lang = cell.config.language || "python";
    const fullPrompt = `Generate ${lang} code for: ${prompt}. Return only the code, no explanation.`;
    return await this.opts.ai.llm("@cf/meta/llama-3-8b-instruct", fullPrompt, cell.config.max_tokens || 500);
  }
  evalRouter(cell) {
    if (!cell.config.routes) return null;
    const env = {};
    for (const [from, to] of this.edges) {
      if (to === cell.id) {
        env[from] = this.values.get(from)?.value;
      }
    }
    for (const route of cell.config.routes) {
      try {
        const fn = new Function("caller", "with(arguments[0]) { return (" + route.when + "); }");
        if (fn({ role: "caller", ...env })) {
          const expr = route.expr.replace(/([a-zA-Z_][a-zA-Z0-9_.]*)/g, (m) => m.includes(".") ? m.replace(/\./g, "_") : m);
          const valueFn = new Function("with(arguments[0]) { return (" + expr + "); }");
          return valueFn(env);
        }
      } catch (e) {
      }
    }
    return null;
  }
  resolveTemplate(template) {
    return template.replace(/([a-zA-Z_][a-zA-Z0-9_.]*)/g, (m) => {
      const v = this.values.get(m);
      if (v !== void 0) return JSON.stringify(v.value);
      return m;
    });
  }
  resolveInput(input) {
    return this.resolveTemplate(input);
  }
  fireListener(listener, value) {
    try {
      let conditionMet = true;
      if (listener.condition) {
        const env = { [listener.watch]: value };
        const fn = new Function("with(arguments[0]) { return (" + listener.condition + "); }");
        conditionMet = !!fn(env);
      }
      if (conditionMet && listener.action) {
        console.log(`[listener:${listener.cell.id}] ${listener.action}`);
      }
    } catch (e) {
    }
  }
  listCells() {
    return [...this.cells.keys()];
  }
  listEdges() {
    return this.edges;
  }
  getEventLog() {
    return this.eventLog;
  }
};
var worker_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const storage = new D1Storage(env.DB);
    const ai = env.AI ? new CloudflareAI(env.AI) : void 0;
    const cache = env.CACHE ? new KVCache(env.CACHE) : void 0;
    const vectorize = env.VECTORIZE ? new VectorizeSearch(env.VECTORIZE) : void 0;
    const engine = new QuiltEngine({ storage, ai, cache, vectorize });
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    try {
      if (url.pathname === "/" || url.pathname === "") {
        return new Response(HTML_INDEX, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } });
      }
      if (url.pathname === "/sheet" && req.method === "POST") {
        const yaml = await req.text();
        const sheet = parseSheet(yaml);
        sheet.id = url.searchParams.get("id") || "default";
        await engine.load(sheet);
        return Response.json({ ok: true, sheetId: sheet.id, cells: sheet.cells.length, edges: sheet.edges?.length || 0 }, { headers: corsHeaders() });
      }
      if (url.pathname === "/sheets" && req.method === "GET") {
        const sheets = await storage.listSheets();
        return Response.json({ sheets }, { headers: corsHeaders() });
      }
      if (url.pathname.startsWith("/cell/")) {
        const id = decodeURIComponent(url.pathname.slice(6));
        const result = await engine.get(id);
        return Response.json(result, { headers: corsHeaders() });
      }
      if (url.pathname === "/cells" && req.method === "GET") {
        await engine.loadFromStorage();
        const all = await engine.getAll();
        return Response.json(all, { headers: corsHeaders() });
      }
      if (url.pathname.startsWith("/set/") && req.method === "POST") {
        const id = decodeURIComponent(url.pathname.slice(5));
        const body = await req.json();
        await engine.loadFromStorage();
        await engine.set(id, body.value);
        return Response.json({ ok: true }, { headers: corsHeaders() });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        return handleMCP(req, env, ctx);
      }
      if (url.pathname === "/mcp/sse") {
        return handleMCPStream(req, env, ctx);
      }
      return new Response("Not found: " + url.pathname, { status: 404, headers: corsHeaders() });
    } catch (e) {
      return Response.json({ error: e.message, stack: e.stack }, { status: 500, headers: corsHeaders() });
    }
  },
  async scheduled(event, env, ctx) {
    const storage = new D1Storage(env.DB);
    const engine = new QuiltEngine({ storage });
    await engine.loadFromStorage();
  }
};
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(corsHeaders, "corsHeaders");
async function handleMCP(req, env, ctx) {
  const body = await req.json();
  const { method, params, id } = body;
  const storage = new D1Storage(env.DB);
  const engine = new QuiltEngine({ storage });
  if (method === "tools/list") {
    await engine.loadFromStorage();
    const tools = engine.listCells().map((cellId) => ({
      name: cellId,
      description: `Quilt cell: ${cellId}`,
      inputSchema: { type: "object", properties: { value: { type: "string" } } }
    }));
    return Response.json({ jsonrpc: "2.0", id, result: { tools } }, { headers: corsHeaders() });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    await engine.loadFromStorage();
    if (args?.value !== void 0) {
      await engine.set(name, args.value);
    }
    const result = await engine.get(name);
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        isError: result.status === "error"
      }
    }, { headers: corsHeaders() });
  }
  return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, { headers: corsHeaders() });
}
__name(handleMCP, "handleMCP");
async function handleMCPStream(req, env, ctx) {
  const stream = new ReadableStream({
    start(controller) {
      const send = /* @__PURE__ */ __name((event, data) => {
        controller.enqueue(new TextEncoder().encode(`event: ${event}
data: ${JSON.stringify(data)}

`));
      }, "send");
      send("endpoint", { uri: "/mcp" });
      const interval = setInterval(() => send("ping", {}), 3e4);
      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", ...corsHeaders() }
  });
}
__name(handleMCPStream, "handleMCPStream");
var HTML_INDEX = `<!DOCTYPE html>
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
export {
  CellKind,
  CloudflareAI,
  D1Storage,
  KVCache,
  QuiltEngine,
  VectorizeSearch,
  worker_default as default,
  parseSheet
};
//# sourceMappingURL=worker.js.map
