// Vector embeddings of a Strata model: chunking, providers, generation, search. Node only (extension host + skill script).
// Hosted providers use the global fetch (Node 18+); their request shapes come from the public API docs and are exercised
// with a fake fetch in tests/embed.check.js (not run against the live services). Local providers run open models on this
// machine with the npm library @huggingface/transformers (ONNX): no API key, no network after the first model download
// (ADR-0018). The library is loaded lazily, so everything else works without it.
'use strict';
const os = require('os');
const path = require('path');
const M = require('./model.js');

const DIMS = 512; // every provider is asked for (or cut to) 512 dimensions, then L2-normalised: small files, dot product = cosine
const norm = (v) => { const t = v.slice(0, DIMS); const n = Math.sqrt(t.reduce((s, x) => s + x * x, 0)) || 1; return t.map((x) => x / n); };
const byIndex = (j) => [...j.data].sort((a, b) => a.index - b.index).map((d) => norm(d.embedding));

async function post(f, url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// One cache for the extension and the skill script, so a model is downloaded once. Override with STRATA_MODEL_CACHE.
const MODEL_CACHE = process.env.STRATA_MODEL_CACHE || path.join(os.homedir(), '.cache', 'strata', 'models');
const loaded = new Map();
function localModel(id, status, load) {
  if (!loaded.has(id)) {
    let T;
    try { T = require('@huggingface/transformers'); } catch (e) { throw new Error('the local embedding library is not installed (run `npm install` in the Strata SQL folder)'); }
    T.env.cacheDir = MODEL_CACHE;
    const seen = {};
    const cb = (p) => { // report each file at most once per 10%
      const b = Math.floor((p.progress || 0) / 10);
      if (status && p.status === 'progress' && seen[p.file] !== b) { seen[p.file] = b; status(`downloading ${p.file} ${b * 10}%`); }
    };
    loaded.set(id, Promise.resolve(load(T, cb)).catch((e) => { loaded.delete(id); throw e; }));
  }
  return loaded.get(id);
}

// key: env var names holding the API key (null = none needed). Claude has no first-party embeddings model, so the
// "claude" slot uses Voyage AI (Anthropic's recommended provider). OpenAI, Gemini and Voyage embedding models exist only as hosted
// services (they cannot be run locally); "gemma" and "minilm" are open models that run locally.
const PROVIDERS = {
  openai: {
    label: 'OpenAI', model: 'text-embedding-3-small', env: ['OPENAI_API_KEY'], batch: 96,
    embed: async (f, key, texts) => byIndex(await post(f, 'https://api.openai.com/v1/embeddings', { authorization: `Bearer ${key}` }, { model: 'text-embedding-3-small', input: texts, dimensions: DIMS })),
  },
  gemini: {
    label: 'Google Gemini', model: 'gemini-embedding-001', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], batch: 50,
    embed: async (f, key, texts, kind) => (await post(f, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', { 'x-goog-api-key': key },
      { requests: texts.map((t) => ({ model: 'models/gemini-embedding-001', content: { parts: [{ text: t }] }, taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: DIMS })) })).embeddings.map((e) => norm(e.values)),
  },
  claude: {
    label: 'Claude (via Voyage AI)', model: 'voyage-3.5', env: ['VOYAGE_API_KEY'], batch: 32,
    embed: async (f, key, texts, kind) => byIndex(await post(f, 'https://api.voyageai.com/v1/embeddings', { authorization: `Bearer ${key}` }, { model: 'voyage-3.5', input: texts, input_type: kind, output_dimension: DIMS })),
  },
  // ---- local: open models run on this machine via @huggingface/transformers; weights are downloaded once into MODEL_CACHE ----
  gemma: {
    label: 'Gemma (EmbeddingGemma 300M)', model: 'onnx-community/embeddinggemma-300m-ONNX', env: null, local: true, download: '~200 MB', batch: 8,
    embed: async (f, key, texts, kind, status) => {
      const { tok, model } = await localModel('gemma', status, async (T, cb) => ({
        tok: await T.AutoTokenizer.from_pretrained('onnx-community/embeddinggemma-300m-ONNX', { progress_callback: cb }),
        model: await T.AutoModel.from_pretrained('onnx-community/embeddinggemma-300m-ONNX', { dtype: 'q4', progress_callback: cb }),
      }));
      const wrap = kind === 'query' ? (t) => `task: search result | query: ${t}` : (t) => `title: none | text: ${t}`; // prompts from the model card
      const out = await model(await tok(texts.map(wrap), { padding: true, truncation: true, max_length: 1024 }));
      return out.sentence_embedding.tolist().map(norm); // 768 -> first 512 (Matryoshka), re-normalised
    },
  },
  minilm: {
    label: 'MiniLM (all-MiniLM-L6-v2)', model: 'Xenova/all-MiniLM-L6-v2', env: null, local: true, download: '~25 MB', batch: 16,
    embed: async (f, key, texts, kind, status) => {
      const pipe = await localModel('minilm', status, (T, cb) => T.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', progress_callback: cb }));
      return (await pipe(texts, { pooling: 'mean', normalize: true })).tolist().map(norm); // 384 dimensions
    },
  },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

// ---------- chunking: the model file (metadata only, never sample data) -> retrieval chunks ----------
const redact = (s) => String(s).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'); // e-mail addresses never leave the machine
const contentOf = (F) => { const { layout, version, ...content } = F; return content; };
const contentHash = (F) => M.hash(M.canon(contentOf(F)));

function buildChunks(F) {
  const out = [];
  const add = (kind, ref, text) => { text = redact(text).slice(0, 6000); out.push({ id: `${kind}:${ref}`, kind, ref, hash: M.hash(text), text }); };
  const tags = (o) => ((o.tags || []).length ? ` Tags: ${o.tags.join(', ')}.` : '');
  const props = (o) => (Object.keys(o.properties || {}).length ? ` Properties: ${Object.entries(o.properties).map(([k, v]) => `${k}=${v}`).join('; ')}.` : '');
  const label = (o) => (o.displayName && o.displayName !== o.name ? ` (${o.displayName})` : '');
  const P = F.project;
  if (!P) return out;
  const G = require('./gov.js'), gm = M.fromFile(F, 'physical'), memo = new Map(), R = M.refs(gm), objs = G.objects(gm, memo), byRef = new Map(objs.map((x) => [x.ref, x]));
  // effective governance values with their source (so "who owns customer data" finds the tables that inherit an owner) and the policies
  // that reach the object on its own level; columns only what is their own (attached or by their tags), so a table's inherited values are
  // not repeated on every column line. Classification is bottom-up (ADR-0041): a column carries its own value, a container its own minimum
  // and the highest value it rolls up from what it holds (with the source)
  const gov = (ref) => {
    const x = byRef.get(ref);
    if (!x) return '';
    const own = x.kind === 'column', e = G.effective(gm, x.o, memo), c = G.classify(gm, x.o, memo);
    if (c.rolled && !own) e.classification = { ...c.rolled, own: c.own };
    else if (c.own) e.classification = { ...c.own };
    else delete e.classification;
    const cls = (d) => { const v = e[d.key], why = own ? (v.from ? ` (by policy ${v.from.name})` : '') : `${v.from ? ` (rolled up from ${G.fromText(v.from)})` : ''}${v.own && v.own.v !== v.v ? `, own minimum ${v.own.v}` : ''}`; return `classification ${v.v}${why}`; };
    const parts = G.COMMON.filter((d) => e[d.key] && (d.key === 'classification' || !own || !e[d.key].from)).map((d) => (d.key === 'classification' ? cls(d) : `${d.label.toLowerCase()} ${e[d.key].v}${e[d.key].from ? ` (from ${G.fromText(e[d.key].from)})` : ''}`));
    const ps = G.reach(gm, x.o, memo).filter((p) => !own || p.how !== 'inherited');
    const off = G.switchedOff(gm, x.o, memo).filter((r) => !own || !r.from);
    const txt = (parts.length ? `${parts.join(', ')}.` : '') + (ps.length ? `${parts.length ? ' ' : ''}Policies: ${ps.map((p) => p.name + (p.how === 'tag' ? ` (via tag ${p.from.name})` : p.how === 'inherited' ? ` (from ${G.fromText(p.from)})` : '')).join(', ')}.` : '') + (off.length ? ` Switched off: ${off.map((r) => r.name).join(', ')}.` : '');
    return !txt ? '' : own ? ` (${txt.replace(/\.$/, '')})` : ` Governance on the ${x.level} level: ${txt}`;
  };
  add('project', P.name, `Project ${P.name}: ${P.description || ''} Technology ${P.technology}, methodology ${P.methodology}, naming ${P.naming}.${tags(P)}${props(P)} Stakeholder roles: ${(P.stakeholders || []).map((s) => s.role).filter(Boolean).join(', ') || 'none'}.`);
  // conceptual and logical levels (ADR-0032): one chunk per concept and per entity, with its relationships and realisations
  const C = F.conceptual || {}, Lg = F.logical || {}, ents = Lg.entities || [];
  const relText = (rs, n) => (rs || []).filter((r) => r.parent === n || r.child === n).map((r) => `${r.parent} ${r.name || 'relates to'} ${r.child}${r.cardinality ? ' (' + r.cardinality + ')' : ''}`).join('; ');
  for (const c of C.concepts || []) add('concept', c.name, `Concept ${c.name} (conceptual level): ${c.description || ''}${tags(c)}${props(c)}${gov('concept:' + c.name)} Logical entities: ${ents.filter((e) => e.concept === c.name).map((e) => e.name).join(', ') || 'none'}.${relText(C.relationships, c.name) ? ' Relationships: ' + relText(C.relationships, c.name) + '.' : ''}`);
  for (const e of ents) add('entity', e.name, `Logical entity ${e.name}${e.concept ? ` of concept ${e.concept}` : ''}: ${e.description || ''}${tags(e)}${props(e)}${gov('entity:' + e.name)} Realised by: ${(F.tables || []).filter((t) => [].concat(t.entity || []).includes(e.name)).map((t) => `${t.schema}.${t.name}`).join(', ') || 'no table yet'}.${relText(Lg.relationships, e.name) ? ' Relationships: ' + relText(Lg.relationships, e.name) + '.' : ''}`);
  for (const c of F.catalogs || []) add('catalog', c.name, `Catalog ${c.name}${label(c)}: ${c.description || ''}${tags(c)}${props(c)}${gov('catalog:' + c.name)}`);
  const parentOf = new Map((F.relationships || []).map((r) => [r.child, r.parent]));
  for (const s of F.schemas || []) {
    const ref = (s.catalog ? s.catalog + '.' : '') + s.name;
    const ts = (F.tables || []).filter((t) => t.schema === ref).map((t) => t.name);
    add('schema', ref, `Schema ${ref}${label(s)}: ${s.description || ''}${tags(s)}${props(s)}${gov('schema:' + ref)} Contains ${ts.length} tables/views: ${ts.join(', ')}.`);
  }
  for (const t of F.tables || []) {
    const ref = `${t.schema}.${t.name}`;
    const cols = (t.columns || []).map((c) => {
      const flags = [c.pk && 'PK', c.notNull && 'NOT NULL', c.unique && 'UNIQUE', parentOf.has(`${ref}.${c.name}`) && `FK -> ${parentOf.get(`${ref}.${c.name}`)}`].filter(Boolean).join(', ');
      return `- ${c.name}${label(c)} ${c.type}${flags ? ` [${flags}]` : ''}${c.description ? ': ' + c.description : ''}${(c.tags || []).length ? ` (tags: ${c.tags.join(', ')})` : ''}${gov(`${ref}.${c.name}`)}`;
    });
    const kind = t.kind === 'view' ? `${t.viewType && t.viewType !== 'view' ? t.viewType + ' ' : ''}view` : 'table';
    add(t.kind === 'view' ? 'view' : 'table', ref, `${kind[0].toUpperCase()}${kind.slice(1)} ${ref}${label(t)}: ${t.description || ''}${t.entity ? ` Realises logical entity ${[].concat(t.entity).join(', ')}.` : ''}${tags(t)}${props(t)}${gov(ref)}${t.sla ? (t.sla.exclude ? ' SLA: out of SLA (static / reference data).' : ` SLA: refreshed ${t.sla.frequency}${t.sla.time ? ', data available by ' + t.sla.time : ''}.`) : ''}${t.definition ? `\nDefinition:\n${t.definition.slice(0, 1500)}` : ''}\nColumns:\n${cols.join('\n')}`);
  }
  for (const r of F.relationships || []) {
    add('relationship', `${r.parent}>${r.child}`, `Relationship${r.name ? ` "${r.name}"` : ''}: ${r.child} references ${r.parent}, cardinality ${r.cardinality} (parent..child).${r.description ? ' ' + r.description : ''}${r.via ? ` Realised by bridge table ${r.via}.` : ''}`);
  }
  // semantic level: one chunk per metric (definition, calculation, grain, inputs, governance) and one per policy
  const MX = M.metricIndex(gm), mName = new Map(gm.metrics.map((y) => [y.id, y.name]));
  for (const x of gm.metrics) {
    const r = M.metricRefs(gm, x, MX), agg = G.AGG[x.aggregation];
    add('metric', x.name, `Metric ${x.name} (semantic level): ${x.description || ''} Calculation: ${agg && x.aggregation !== 'none' ? agg + ' of ' : ''}${x.calculation || 'not set'}${x.aggregation === 'none' ? ' (non-additive)' : ''}.${(x.grain || []).length ? ` Grain: ${x.grain.join(', ')}.` : ''} Computed from: ${[...[...r.columns].map((id) => R.col.get(id)), ...[...r.metrics].map((id) => 'metric ' + mName.get(id))].join(', ') || 'nothing resolved'}.${tags(x)}${props(x)}${gov('metric:' + x.name)}`);
  }
  const attached = new Map(); // policy -> labels of the objects it is attached to
  for (const x of objs) for (const n of new Set((x.o.gov || {}).policies || [])) { if (!attached.has(n)) attached.set(n, []); attached.get(n).push(x.label); }
  for (const p of gm.governance.policies) {
    const linked = attached.get(p.name) || [], tags = gm.governance.tags.filter((t) => t.policies.includes(p.name)).map((t) => t.displayName || t.name), kids = G.descendants(gm, p.name);
    add('policy', p.name, `Governance policy ${p.name}${p.type ? ` (${p.type})` : ''}${p.jurisdiction ? `, jurisdiction ${p.jurisdiction}` : ''}: ${p.description || ''}${p.parents.length ? ` Parents (it takes on their requirements): ${p.parents.join(', ')}.` : ''}${kids.length ? ` Brought along by: ${kids.join(', ')}.` : ''}${p.classification ? ` What it covers is at least ${p.classification}.` : ''}${p.owner ? ` Owner of the rule: ${p.owner}.` : ''}${tags.length ? ` Brought by tags: ${tags.join(', ')}.` : ''} Attached to: ${linked.join(', ') || 'nothing directly'}.`);
  }
  const g = F.governance || {};
  const users = (tag) => {
    const refs = [];
    const use = (ref, o) => { if ((o.tags || []).includes(tag)) refs.push(ref); };
    use(`project ${P.name}`, P);
    (F.catalogs || []).forEach((c) => use(`catalog ${c.name}`, c));
    (F.schemas || []).forEach((s) => use(`schema ${(s.catalog ? s.catalog + '.' : '') + s.name}`, s));
    (F.tables || []).forEach((t) => { use(`${t.schema}.${t.name}`, t); (t.columns || []).forEach((c) => use(`${t.schema}.${t.name}.${c.name}`, c)); });
    return refs;
  };
  for (const t of g.tags || []) {
    const u = users(t.name);
    add('tag', t.name, `Governance tag ${t.name}${t.displayName ? ` (${t.displayName})` : ''}: ${t.description || ''} Domain: ${t.domain || 'n/a'}. Owner: ${t.owner || 'n/a'}. ${t.enabled === false ? 'Disabled.' : 'Enabled.'} Applied to ${u.length} objects: ${u.slice(0, 25).join(', ')}${u.length > 25 ? ', ...' : ''}.`);
  }
  if ((g.propertyKeys || []).length) add('governance', 'propertyKeys', `User-defined property keys: ${g.propertyKeys.join(', ')}.`);
  return out;
}

// ---------- generation (incremental: unchanged chunks reuse their previous vectors) ----------
// enabled: provider ids; keys: {provider: apiKey}. Providers without a key (or that fail) keep their previous block.
async function generate({ modelText, modelName, previous, enabled, keys, fetch: f = fetch, onProgress = () => {}, onStatus = () => {} }) {
  const F = JSON.parse(modelText);
  const chunks = buildChunks(F);
  const providers = {}, results = {};
  for (const id of PROVIDER_IDS) {
    if (!enabled.includes(id)) continue;
    const p = PROVIDERS[id], old = previous && previous.providers && previous.providers[id];
    const prevBlock = old && old.model === p.model ? old : null;
    if (p.env && !keys[id]) { results[id] = { ok: false, skipped: true, error: `no API key (set ${p.env[0]} or use "Set key" in Settings)` }; if (old) providers[id] = old; continue; }
    const have = new Map(((prevBlock && prevBlock.items) || []).map((i) => [`${i.id}\n${i.hash}`, i.v]));
    const todo = chunks.filter((c) => !have.has(`${c.id}\n${c.hash}`));
    try {
      for (let i = 0; i < todo.length; i += p.batch) {
        const batch = todo.slice(i, i + p.batch);
        const vecs = await p.embed(f, keys[id], batch.map((c) => c.text), 'document', (msg) => onStatus(id, msg));
        if (vecs.length !== batch.length) throw new Error(`provider returned ${vecs.length} vectors for ${batch.length} inputs`);
        batch.forEach((c, k) => have.set(`${c.id}\n${c.hash}`, vecs[k]));
        onProgress(id, Math.min(i + p.batch, todo.length), todo.length);
      }
      const items = chunks.map((c) => ({ id: c.id, hash: c.hash, v: have.get(`${c.id}\n${c.hash}`) }));
      providers[id] = { model: p.model, dimensions: items.length ? items[0].v.length : DIMS, items }; // MiniLM is 384-dim, the others 512
      results[id] = { ok: true, embedded: todo.length, reused: chunks.length - todo.length };
    } catch (err) {
      results[id] = { ok: false, error: err.message + (p.local ? ' (local model: needs `npm install` and, the first time, internet access to download it once)' : '') };
      if (old) providers[id] = old;
    }
  }
  return {
    file: { strata: 'embeddings/1', model: modelName, ...(F.version ? { version: F.version } : {}), contentHash: contentHash(F), generatedAt: new Date().toISOString(), chunks, providers },
    results,
  };
}

// One chunk / one vector per line: diff friendly and easy to stream. Numbers are rounded to 5 decimals.
const r5 = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);
function serialize(e) {
  const head = ['strata', 'model', 'version', 'contentHash', 'generatedAt'].filter((k) => k in e).map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(e[k])}`);
  const chunks = e.chunks.map((c) => '    ' + JSON.stringify(c)).join(',\n');
  const provs = Object.entries(e.providers).map(([id, p]) => `    ${JSON.stringify(id)}: {"model": ${JSON.stringify(p.model)}, "dimensions": ${p.dimensions}, "items": [\n${p.items.map((i) => `      {"id": ${JSON.stringify(i.id)}, "hash": ${JSON.stringify(i.hash)}, "v": ${JSON.stringify(r5(i.v))}}`).join(',\n')}\n    ]}`).join(',\n');
  return `{\n${head.join(',\n')},\n  "chunks": [\n${chunks}\n  ],\n  "providers": {\n${provs}\n  }\n}\n`;
}

// ---------- search: vector when a provider + key are available, otherwise BM25 over the chunk text ----------
const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
function lexical(chunks, query, k) {
  const q = tokens(query), docs = chunks.map((c) => tokens(c.text)), N = docs.length, avg = docs.reduce((s, d) => s + d.length, 0) / (N || 1);
  const df = new Map();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  return chunks.map((c, i) => {
    const tf = new Map();
    docs[i].forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (f) score += Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)) * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * docs[i].length) / (avg || 1))));
    }
    return { ...c, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

async function search({ file, query, k = 8, provider = 'auto', keys = {}, fetch: f = fetch }) {
  const chunks = new Map(file.chunks.map((c) => [c.id, c]));
  const usable = (id) => file.providers[id] && (!PROVIDERS[id].env || keys[id]);
  const pick = provider === 'auto' ? PROVIDER_IDS.find(usable) : provider !== 'lexical' && usable(provider) ? provider : null;
  if (!pick) return { mode: 'lexical', results: lexical(file.chunks, query, k).map(({ id, kind, ref, score, text }) => ({ id, kind, ref, score, text })) };
  let q;
  try { [q] = await PROVIDERS[pick].embed(f, keys[pick], [query], 'query'); }
  catch (err) { // provider down / model missing / bad key: still answer, with keyword search
    return { mode: 'lexical', warning: `${pick} query failed (${err.message.slice(0, 160)}); used keyword search`, results: lexical(file.chunks, query, k).map(({ id, kind, ref, score, text }) => ({ id, kind, ref, score, text })) };
  }
  const scored = [];
  let stale = 0;
  for (const it of file.providers[pick].items) {
    const c = chunks.get(it.id);
    if (!c || c.hash !== it.hash) { stale++; continue; }
    let s = 0;
    for (let i = 0; i < q.length; i++) s += q[i] * it.v[i];
    scored.push({ id: c.id, kind: c.kind, ref: c.ref, score: s, text: c.text });
  }
  return { mode: 'vector', provider: pick, skippedStale: stale, results: scored.sort((a, b) => b.score - a.score).slice(0, k) };
}

module.exports = { PROVIDERS, PROVIDER_IDS, buildChunks, contentHash, generate, serialize, search, lexical };
