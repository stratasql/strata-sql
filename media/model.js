// Pure model logic (no DOM, no VS Code): file format <-> working model, compact JSON,
// flat entity maps, and the delta/snapshot version-history engine. Loaded by the webview and by node tests.
(function (g) {
  'use strict';

  const LEVELS = ['conceptual', 'logical', 'physical', 'semantic'];
  // database platforms: how many name parts (2 = schema.table, 3 = catalog.schema.table) and the default schema / catalog of a new project
  const PLATFORMS = { 'SQL Server': { parts: 3, schema: 'dbo', catalog: 'master' }, PostgreSQL: { parts: 2, schema: 'public' }, MySQL: { parts: 2, schema: 'app' }, Oracle: { parts: 2, schema: 'app' }, SQLite: { parts: 2, schema: 'main' }, Databricks: { parts: 3, schema: 'default', catalog: 'main' }, Snowflake: { parts: 3, schema: 'PUBLIC', catalog: 'MY_DB' }, 'Google BigQuery': { parts: 3, schema: 'dataset', catalog: 'my-project' }, 'Trino/Presto': { parts: 3, schema: 'default', catalog: 'hive' }, DuckDB: { parts: 3, schema: 'main', catalog: 'memory' } };
  const METHODS = ['ER - 1NF', 'ER - 2NF', 'ER - 3NF', 'Dimensional Modelling', 'Data Vault', 'One Big Table'];
  const STREAMS = ['modelling', 'governance', 'semantic']; // ADR-0039: metrics are their own stream (ids s1, s2, …)
  const PREFIX = { modelling: 'm', governance: 'g', semantic: 's' };
  // accepted warnings are versioned with the stream of what they are about: metric warnings -> semantic, governance -> governance
  const ackStream = (k) => (/^metric-/.test(k) ? 'semantic' : /^(gov|policy)-/.test(k) ? 'governance' : 'modelling');
  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

  // ---------- helpers ----------
  const canon = (v) => {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
  };
  function hash(str) { // cyrb53
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  // SHA-256, synchronous and dependency-free so the webview and Node share it (WebCrypto is async). UTF-8 in, lower-case hex out.
  const K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  // pure JS because the webview has no crypto module; Node (host, CLI, tests) hashes natively, about 20x faster, with the same digest
  const nodeCrypto = typeof require === 'function' && typeof process !== 'undefined' && process.versions && process.versions.node ? require('crypto') : null;
  const sha256 = (str) => (nodeCrypto ? nodeCrypto.createHash('sha256').update(str, 'utf8').digest('hex') : sha256js(str));
  function sha256js(str) {
    const m = new TextEncoder().encode(str), n = m.length, len = (n + 72) & ~63; // message + 0x80 + 8 length bytes, padded to 64
    const buf = new Uint8Array(len), dv = new DataView(buf.buffer), w = new Uint32Array(64), rr = (x, k) => (x >>> k) | (x << (32 - k));
    buf.set(m); buf[n] = 0x80; dv.setUint32(len - 8, Math.floor(n / 0x20000000)); dv.setUint32(len - 4, (n << 3) >>> 0);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (let o = 0; o < len; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const a = w[i - 15], c = w[i - 2]; w[i] = w[i - 16] + (rr(a, 7) ^ rr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rr(c, 17) ^ rr(c, 19) ^ (c >>> 10)); }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0, t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  const stateHash = (flat) => sha256(canon(flat)); // hash of one stream's content: what an entry's `hash` and the model are compared by
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const hasKeys = (o) => o && Object.keys(o).length > 0;

  // Compact JSON: anything that fits on one line stays on one line (columns, tags, coordinates...).
  function inline(v) {
    if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
    if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + inline(x)).join(', ') + '}';
    return JSON.stringify(v);
  }
  function stringify(v, ind = '') {
    const one = inline(v);
    if (one.length <= 118 || typeof v !== 'object' || v === null) return one;
    const ni = ind + '  ';
    if (Array.isArray(v)) return '[\n' + v.map((x) => ni + stringify(x, ni)).join(',\n') + '\n' + ind + ']';
    return '{\n' + Object.entries(v).map(([k, x]) => ni + JSON.stringify(k) + ': ' + stringify(x, ni)).join(',\n') + '\n' + ind + '}';
  }

  // ---------- working model ----------
  // gov: the object's governance values (owner, steward, classification, criticality, lifecycle, policies, off), only what is set;
  // "governance" in the file
  // tags and properties are copied: objects built from a history state must never share (and so mutate) the state, which is read-only
  const norm = (o) => Object.assign(o, { displayName: o.displayName || '', description: o.description || '', tags: Array.isArray(o.tags) ? [...o.tags] : [], properties: o.properties && typeof o.properties === 'object' ? { ...o.properties } : {}, gov: o.gov || {} });
  // concepts / entities: the conceptual and logical layers (ADR-0032); crels / lrels: their relationships; ack: acknowledged alignment warnings
  // metrics: the semantic level (ADR-0037); governance.policies: the policies (ADR-0038)
  const blank = () => ({ project: null, catalogs: [], schemas: [], tables: [], relations: [], concepts: [], entities: [], crels: [], lrels: [], metrics: [], ack: [], governance: { tags: [], propertyKeys: [], policies: [] }, dangling: [], extra: {}, warnings: [] });
  // what a level draws: its own layer when it has one, otherwise the physical tables (legacy behaviour); semantic: metrics and the tables they
  // read; the governance tab draws no canvas
  const nodesOf = (m, lv) => (lv === 'governance' || lv === 'domains' ? [] : lv === 'semantic' ? semanticNodes(m) : lv === 'conceptual' && m.concepts.length ? m.concepts : lv === 'logical' && m.entities.length ? m.entities : m.tables);
  function semanticNodes(m) {
    const used = new Set(), X = metricIndex(m);
    for (const x of m.metrics) metricRefs(m, x, X).tables.forEach((id) => used.add(id));
    return [...m.metrics, ...m.tables.filter((t) => used.has(t.id))];
  }

  // What a metric's calculation reads (ADR-0037): qualified columns (table.column, schema.table.column or the full ref; bare names are not
  // resolved) and other metrics written as {Metric name}. Unresolved qualified names come back in `missing` ({kind, ref}).
  const PART = '(?:[A-Za-z_][\\w$]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
  const CHAIN = new RegExp(`${PART}(?:\\s*\\.\\s*${PART})+(?![\\w$]|\\s*\\()`, 'g'); // not a function call; a keyword may follow (END, AS)
  const unq = (x) => x.trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase();
  // lower-case lookups for metricRefs: tables by full ref, schema.table and unique bare name; columns per table; metrics by name
  function metricIndex(m) {
    const R = refs(m), full = new Map(), two = new Map(), bare = new Map(), cols = new Map(), mets = new Map();
    for (const t of m.tables) {
      const r = R.tab.get(t.id).toLowerCase(), n = t.name.toLowerCase(), cs = new Map();
      full.set(r, t); two.set(r.split('.').slice(-2).join('.'), t); bare.set(n, bare.has(n) ? null : t);
      for (const c of t.columns) { const k = c.name.toLowerCase(); if (!cs.has(k)) cs.set(k, c); }
      cols.set(t, cs);
    }
    for (const x of m.metrics) { const k = x.name.toLowerCase(); if (!mets.has(k)) mets.set(k, x); }
    return { full, two, bare, cols, mets };
  }
  function metricRefs(m, mt, X = metricIndex(m)) {
    const { full, two, bare } = X, out = { tables: new Set(), columns: new Set(), metrics: new Set(), missing: [] };
    const src = String(mt.calculation || '').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, ' ').replace(/\{([^}]*)\}/g, (_, n) => {
      const x = X.mets.get(n.trim().toLowerCase());
      if (x && x.id !== mt.id) out.metrics.add(x.id); else out.missing.push({ kind: 'metric', ref: n.trim() }); // itself counts as missing
      return ' ';
    });
    for (const chain of src.match(CHAIN) || []) {
      const p = chain.split('.').map(unq), path = p.slice(0, -1).join('.');
      const t = full.get(path) || (p.length === 3 ? two.get(path) : p.length === 2 ? bare.get(path) : null);
      const c = t && X.cols.get(t).get(p[p.length - 1]);
      if (c) { out.tables.add(t.id); out.columns.add(c.id); } else out.missing.push({ kind: t ? 'column' : 'table', ref: chain.replace(/\s+/g, '') });
    }
    return out;
  }

  // Rewrite-safe calculations (ADR-0040). metricSnap(m) is taken before an edit: where each calculation reads a table.column (the position of
  // every name part, and the names as they were). metricRewrite(m, snap) runs after it and rewrites the parts whose object was renamed
  // (column, table, schema, catalog), keeping the writer's depth (bare table, schema.table, full) and quoting. Returns the names of the metrics changed.
  const blank_ = (x) => ' '.repeat(x.length);
  function tabPartsOf(m) { // [catalog?, schema, table] of a table
    const sch = new Map(m.schemas.map((x) => [x.id, x])), cat = new Map(m.catalogs.map((x) => [x.id, x])), three = !!(m.project && m.project.threePart);
    return (t) => { const s = sch.get(t.schemaId), c = three && s && cat.get(s.catalogId); return [...(c ? [c.name] : []), s ? s.name : '?', t.name]; };
  }
  function metricSnap(m) {
    const X = metricIndex(m), parts = tabPartsOf(m), out = [];
    for (const mt of m.metrics) {
      const text = mt.calculation || '', masked = text.replace(/--[^\n]*/g, blank_).replace(/'(?:[^']|'')*'/g, blank_).replace(/\{[^}]*\}/g, blank_), chains = [];
      for (const hit of masked.matchAll(CHAIN)) {
        const ps = [...hit[0].matchAll(new RegExp(PART, 'g'))].map((q) => ({ at: hit.index + q.index, text: q[0] })), p = ps.map((q) => unq(q.text)), path = p.slice(0, -1).join('.');
        const t = X.full.get(path) || (p.length === 3 ? X.two.get(path) : p.length === 2 ? X.bare.get(path) : null), c = t && X.cols.get(t).get(p[p.length - 1]);
        if (c) chains.push({ parts: ps, t: t.id, c: c.id, was: [...parts(t).slice(-(p.length - 1)), c.name].map((x) => x.toLowerCase()) });
      }
      if (chains.length) out.push({ mt, text, chains });
    }
    return out;
  }
  function metricRewrite(m, snap) {
    const T = new Map(m.tables.map((t) => [t.id, t])), parts = tabPartsOf(m), changed = [];
    for (const { mt, text, chains } of snap) {
      if (!m.metrics.includes(mt) || mt.calculation !== text) continue; // deleted, or edited since: the positions no longer hold
      const edits = [];
      for (const ch of chains) {
        const t = T.get(ch.t), c = t && t.columns.find((x) => x.id === ch.c);
        if (!c) continue;
        const names = [...parts(t).slice(-(ch.was.length - 1)), c.name];
        if (names.length !== ch.was.length) continue;
        ch.parts.forEach((q, i) => {
          if (names[i].toLowerCase() === ch.was[i]) return;
          const [o, cl] = q.text[0] === '"' ? ['"', '"'] : q.text[0] === '`' ? ['`', '`'] : q.text[0] === '[' ? ['[', ']'] : /^[A-Za-z_][\w$]*$/.test(names[i]) ? ['', ''] : ['"', '"'];
          edits.push({ at: q.at, len: q.text.length, text: o + names[i] + cl });
        });
      }
      if (!edits.length) continue;
      let out = text;
      for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);
      mt.calculation = out; changed.push(mt.name);
    }
    return changed;
  }

  function refs(m) {
    const three = !!(m.project && m.project.threePart);
    const cat = new Map(m.catalogs.map((c) => [c.id, c]));
    const sch = new Map(), tab = new Map(), col = new Map();
    for (const s of m.schemas) { const c = three && cat.get(s.catalogId); sch.set(s.id, c ? c.name + '.' + s.name : s.name); }
    for (const t of m.tables) {
      tab.set(t.id, (sch.get(t.schemaId) || '?') + '.' + t.name);
      for (const c of t.columns) col.set(c.id, tab.get(t.id) + '.' + c.name);
    }
    return { three, sch, tab, col };
  }

  // key -> id of everything, used to keep ids stable when a model is rebuilt from a version
  function idIndex(m) {
    const R = refs(m), ix = new Map();
    for (const c of m.catalogs) ix.set('catalog:' + c.name, c.id);
    for (const s of m.schemas) ix.set('schema:' + R.sch.get(s.id), s.id);
    for (const t of m.tables) { ix.set('table:' + R.tab.get(t.id), t.id); for (const c of t.columns) ix.set('column:' + R.col.get(c.id), c.id); }
    for (const c of m.concepts) ix.set('concept:' + c.name, c.id);
    for (const e of m.entities) ix.set('entity:' + e.name, e.id);
    for (const x of m.metrics) ix.set('metric:' + x.name, x.id);
    return ix;
  }

  const tp = (o) => ({ ...(o.tags && o.tags.length ? { tags: [...o.tags] } : {}), ...(hasKeys(o.properties) ? { properties: { ...o.properties } } : {}), ...(hasKeys(o.gov) ? { governance: clone(o.gov) } : {}) });
  const meta = (o) => ({ ...(o.displayName ? { displayName: o.displayName } : {}), ...(o.description ? { description: o.description } : {}) });

  // data-availability SLA of a table: {frequency, time?} or {exclude:true} (static/reference data, left out of SLA calculations)
  const slaFile = (a) => (a.exclude ? { exclude: true } : { frequency: a.frequency, ...(a.time ? { time: a.time } : {}) });

  // a table's logical entity: one name, or a list when one table realises several entities (One Big Table, wide dimension)
  const entityOf = (t, eName) => { const n = [...(t.entityIds || []).map((id) => eName.get(id)).filter(Boolean), ...((t.broken || {}).entity || [])]; return n.length ? { entity: n.length === 1 ? n[0] : n } : {}; };

  const tagFile = (t) => ({ name: t.name, ...(t.displayName ? { displayName: t.displayName } : {}), ...(t.description ? { description: t.description } : {}), ...(t.owner ? { owner: t.owner } : {}), ...(t.domain ? { domain: t.domain } : {}), ...(t.policies && t.policies.length ? { policies: [...t.policies] } : {}), enabled: t.enabled !== false, ...(t.ext || {}) });
  // a policy (ADR-0038): parents = the broader policies whose requirements it takes on (several allowed)
  const POLICY_KEYS = ['name', 'parents', 'type', 'jurisdiction', 'classification', 'owner', 'description'];
  const policyFile = (p) => ({ ...Object.fromEntries(POLICY_KEYS.filter((k) => (Array.isArray(p[k]) ? p[k].length : p[k])).map((k) => [k, Array.isArray(p[k]) ? [...p[k]] : p[k]])), ...(p.ext || {}) });
  // Unknown keys are kept (ADR-0042): what a file says beyond the keys Strata knows rides along on the object as `ext` and is written back after
  // the known keys, verbatim. It is part of the versioned entity, so history, diff and drift see it. m.extra holds the same for the file itself
  // (unknown top-level keys, and unknown keys of the sections governance / conceptual / logical / semantic / alignment).
  const META = ['displayName', 'description', 'tags', 'properties', 'governance'];
  const KNOWN = { project: ['name', 'description', 'technology', 'methodology', 'naming', 'stakeholders', 'tags', 'properties', 'governance'], tag: ['name', 'displayName', 'description', 'owner', 'domain', 'policies', 'enabled'], policy: POLICY_KEYS,
    catalog: ['name', ...META], schema: ['name', 'catalog', ...META], schema2: ['name', ...META], concept: ['name', ...META], entity: ['name', 'concept', ...META],
    table: ['name', 'kind', 'viewType', 'schema', 'entity', 'sla', 'definition', 'columns', ...META], column: ['name', 'type', 'pk', 'notNull', 'unique', 'default', ...META],
    metric: ['name', 'calculation', 'aggregation', 'grain', ...META], rel: ['parent', 'child', 'cardinality', 'name', 'description', 'via'], lrel: ['parent', 'child', 'cardinality', 'name', 'description'] };
  const TOP = ['strata', 'project', 'governance', 'conceptual', 'logical', 'catalogs', 'schemas', 'tables', 'relationships', 'semantic', 'alignment', 'layout', 'version'];
  const SECTION_KEYS = { governance: ['tags', 'propertyKeys', 'policies'], conceptual: ['concepts', 'relationships'], logical: ['entities', 'relationships'], semantic: ['metrics'], alignment: ['acknowledged'] };
  const SECTIONS = Object.keys(SECTION_KEYS);
  const ext = (src, kind) => { const e = {}; if (src && typeof src === 'object') for (const k of Object.keys(src)) if (!KNOWN[kind].includes(k)) e[k] = clone(src[k]); return hasKeys(e) ? { ext: e } : {}; };
  const metricFile = (x) => ({ name: x.name, ...meta(x), ...(x.calculation ? { calculation: x.calculation } : {}), ...(x.aggregation ? { aggregation: x.aggregation } : {}), ...(x.grain && x.grain.length ? { grain: [...x.grain] } : {}), ...tp(x), ...(x.ext || {}) });

  const relOrder = (a, b) => (a.parent + '>' + a.child).localeCompare(b.parent + '>' + b.child) || (a.name || '').localeCompare(b.name || '');

  // working model -> LLM-friendly file object (readable references, defaults omitted). Canvas positions and version pointers are not part
  // of it (ADR-0042): positions go to <name>.model.layout.json (layoutOf), the current version is found by content hash. What the file said
  // beyond what Strata knows (unknown keys, unresolved relationships and links) is written back as it was.
  function toFile(m) {
    if (!m.project) return {};
    const R = refs(m), p = m.project, X = m.extra || {}, dl = (list) => (m.dangling || []).filter((d) => d.list === list).map((d) => d.r);
    const F = { strata: 2 };
    F.project = {
      name: p.name, ...(p.description ? { description: p.description } : {}), technology: p.technology, methodology: p.methodology,
      naming: p.threePart ? 'catalog.schema.table' : 'schema.table',
      ...(p.stakeholders && p.stakeholders.length ? { stakeholders: p.stakeholders.map((s) => ({ ...s })) } : {}), ...tp(p), ...(p.ext || {}),
    };
    const g = m.governance || {}, gp = g.policies || [];
    if ((g.tags || []).length || (g.propertyKeys || []).length || gp.length || hasKeys(X.governance)) {
      F.governance = {};
      if (g.tags.length) F.governance.tags = [...g.tags].sort((a, b) => a.name.localeCompare(b.name)).map(tagFile);
      if (g.propertyKeys.length) F.governance.propertyKeys = [...g.propertyKeys];
      if (gp.length) F.governance.policies = [...gp].sort((a, b) => a.name.localeCompare(b.name)).map(policyFile);
      Object.assign(F.governance, X.governance);
    }
    const cName = new Map(m.concepts.map((c) => [c.id, c.name])), eName = new Map(m.entities.map((e) => [e.id, e.name]));
    const byName = (a, b) => a.name.localeCompare(b.name);
    const layerRels = (list, nm) => list.filter((r) => nm.get(r.parentId) && nm.get(r.childId))
      .map((r) => ({ parent: nm.get(r.parentId), child: nm.get(r.childId), ...(r.cardinality ? { cardinality: r.cardinality } : {}), ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}), ...(r.ext || {}) }));
    const crels = [...layerRels(m.crels, cName), ...dl('conceptual')].sort(relOrder), lrels = [...layerRels(m.lrels, eName), ...dl('logical')].sort(relOrder);
    if (m.concepts.length || crels.length || hasKeys(X.conceptual)) F.conceptual = { ...(m.concepts.length ? { concepts: [...m.concepts].sort(byName).map((c) => ({ name: c.name, ...meta(c), ...tp(c), ...(c.ext || {}) })) } : {}), ...(crels.length ? { relationships: crels } : {}), ...X.conceptual };
    if (m.entities.length || lrels.length || hasKeys(X.logical)) {
      const cn = (e) => cName.get(e.conceptId) || (e.broken || {}).concept; // a concept that does not exist is kept by name (a warning)
      F.logical = { ...(m.entities.length ? { entities: [...m.entities].sort(byName).map((e) => ({ name: e.name, ...(cn(e) ? { concept: cn(e) } : {}), ...meta(e), ...tp(e), ...(e.ext || {}) })) } : {}), ...(lrels.length ? { relationships: lrels } : {}), ...X.logical };
    }
    if (R.three) F.catalogs = [...m.catalogs].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, ...meta(c), ...tp(c), ...(c.ext || {}) }));
    F.schemas = m.schemas.map((s) => ({ ref: R.sch.get(s.id), s })).sort((a, b) => a.ref.localeCompare(b.ref))
      .map(({ s }) => ({ name: s.name, ...(R.three ? { catalog: (m.catalogs.find((c) => c.id === s.catalogId) || {}).name } : {}), ...meta(s), ...tp(s), ...(s.ext || {}) }));
    F.tables = m.tables.map((t) => ({ ref: R.tab.get(t.id), t })).sort((a, b) => a.ref.localeCompare(b.ref)).map(({ t }) => ({
      name: t.name, ...(t.kind === 'view' ? { kind: 'view', ...(t.viewType && t.viewType !== 'view' ? { viewType: t.viewType } : {}) } : {}),
      schema: R.sch.get(t.schemaId), ...entityOf(t, eName), ...meta(t), ...tp(t), ...(t.sla && (t.sla.exclude || t.sla.frequency) ? { sla: slaFile(t.sla) } : {}), ...(t.kind === 'view' && t.definition ? { definition: t.definition } : {}),
      columns: t.columns.map((c) => ({
        name: c.name, ...(c.displayName ? { displayName: c.displayName } : {}), type: c.dataType,
        ...(c.description ? { description: c.description } : {}), ...(c.primaryKey ? { pk: true } : {}), ...(c.notNull && !c.primaryKey ? { notNull: true } : {}),
        ...(c.unique ? { unique: true } : {}), ...(c.default ? { default: c.default } : {}), ...tp(c), ...(c.ext || {}),
      })),
      ...(t.ext || {}),
    }));
    const rels = dl('relationships');
    for (const t of m.tables) for (const c of t.columns) {
      const f = c.foreignKey;
      if (f && R.col.get(f.columnId)) rels.push({ parent: R.col.get(f.columnId), child: R.col.get(c.id), cardinality: f.cardinality || '1..M', ...(f.name ? { name: f.name } : {}), ...(f.description ? { description: f.description } : {}), ...(f.ext || {}) });
    }
    for (const r of m.relations) {
      if (R.tab.get(r.parentId) && R.tab.get(r.childId)) rels.push({ parent: R.tab.get(r.parentId), child: R.tab.get(r.childId), cardinality: r.cardinality, ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}), ...(r.viaId && R.tab.get(r.viaId) ? { via: R.tab.get(r.viaId) } : {}), ...(r.ext || {}) });
    }
    if (rels.length) F.relationships = rels.sort(relOrder);
    if (m.metrics.length || hasKeys(X.semantic)) F.semantic = { ...(m.metrics.length ? { metrics: [...m.metrics].sort(byName).map(metricFile) } : {}), ...X.semantic };
    if (m.ack.length || hasKeys(X.alignment)) F.alignment = { ...(m.ack.length ? { acknowledged: [...new Set(m.ack)].sort() } : {}), ...X.alignment };
    for (const [k, v] of Object.entries(X)) if (!SECTIONS.includes(k)) F[k] = v; // unknown top-level keys (exposes, links, x-...) come last
    return F;
  }

  // canvas positions, one map per level: tables by ref, concepts / entities / metrics by name. Written to <name>.model.layout.json, never versioned.
  function layoutOf(m, level) {
    const R = refs(m), layout = {};
    for (const lv of LEVELS) {
      const o = {}, nodes = nodesOf(m, lv), ref = (t) => R.tab.get(t.id) || t.name;
      for (const t of [...nodes].sort((a, b) => ref(a).localeCompare(ref(b)))) {
        const ps = lv === level && typeof t.x === 'number' ? { x: t.x, y: t.y } : t.pos && t.pos[lv];
        if (ps) o[ref(t)] = [Math.round(ps.x), Math.round(ps.y)];
      }
      if (hasKeys(o)) layout[lv] = o;
    }
    return layout;
  }
  const xy = (q) => ({ x: +q[0] || 0, y: +q[1] || 0 }); // a position from a file or a log: always numbers, since they end up in inline styles
  const layoutFile = (m, level) => ({ strata: 'layout/1', positions: layoutOf(m, level) });
  const layoutRead = (text) => { try { const o = JSON.parse(text); return o && typeof o === 'object' ? o.positions || (o.strata ? {} : o) : null; } catch { return null; } };

  // file object -> working model. idHint keeps ids stable across rebuilds; layout = positions from the sidecar (an inline `layout` of an older file is used when there is none).
  function fromFile(o, level, idHint, layout) {
    if (o && o.strata !== 2 && (o.tables || []).some((t) => t.schemaId)) return fromLegacy(o, level);
    const m = blank();
    if (!o || !o.project) return m;
    const id = (key) => (idHint && idHint.get(key)) || uid();
    const L = layout || o.layout || {}, at = (lv, key) => L[lv] && L[lv][key];
    const p = o.project;
    m.project = norm({ name: p.name || 'Untitled', description: p.description || '', technology: p.technology || 'PostgreSQL', methodology: p.methodology || 'ER - 3NF', threePart: p.naming === 'catalog.schema.table', stakeholders: (p.stakeholders || []).map((x) => ({ ...x })), tags: p.tags, properties: p.properties, gov: gv(p), ...ext(p, 'project') });
    const three = m.project.threePart;
    for (const k of Object.keys(o)) if (!TOP.includes(k)) m.extra[k] = clone(o[k]); // unknown keys stay
    for (const [sec, known] of Object.entries(SECTION_KEYS)) if (o[sec] && typeof o[sec] === 'object') { const e = Object.fromEntries(Object.entries(o[sec]).filter(([k]) => !known.includes(k))); if (hasKeys(e)) m.extra[sec] = clone(e); }
    if (!three && o.catalogs) m.extra.catalogs = clone(o.catalogs); // a 2-part project has none: kept as it was
    const g = o.governance || {};
    m.governance = {
      tags: (g.tags || []).map((t) => ({ name: t.name, displayName: t.displayName || '', description: t.description || '', owner: t.owner || '', domain: t.domain || '', policies: [].concat(t.policies || []), enabled: t.enabled !== false, ...ext(t, 'tag') })),
      propertyKeys: [...(g.propertyKeys || [])],
      policies: (g.policies || []).filter((x) => x && x.name).map((x) => ({ ...Object.fromEntries(POLICY_KEYS.map((k) => [k, k === 'parents' ? [].concat(x.parents || []) : x[k] || ''])), ...ext(x, 'policy') })),
    };
    const catByName = new Map();
    const addCatalog = (c) => { const x = norm({ id: id('catalog:' + c.name), name: c.name, displayName: c.displayName, description: c.description, tags: c.tags, properties: c.properties, gov: gv(c), ...ext(c, 'catalog') }); m.catalogs.push(x); catByName.set(c.name, x); return x; };
    if (three) (o.catalogs || []).forEach(addCatalog);
    const schemaByRef = new Map();
    const addSchema = (s, catName) => {
      let c = null;
      if (three) { c = catByName.get(catName) || [...catByName.values()][0] || addCatalog({ name: catName || 'main' }); }
      const ref = (c ? c.name + '.' : '') + s.name;
      if (schemaByRef.has(ref)) return schemaByRef.get(ref);
      const x = norm({ id: id('schema:' + ref), name: s.name, catalogId: c ? c.id : null, displayName: s.displayName, description: s.description, tags: s.tags, properties: s.properties, gov: gv(s), ...ext(s, three ? 'schema' : 'schema2') });
      m.schemas.push(x); schemaByRef.set(ref, x); return x;
    };
    (o.schemas || []).forEach((s) => addSchema(s, s.catalog));
    // conceptual and logical layers: identified by name, linked child -> parent
    const lay = (n, list, key) => (o[n] && o[n][key]) || list;
    const conByName = new Map(), entByName = new Map();
    for (const c of lay('conceptual', [], 'concepts')) {
      if (!c.name || conByName.has(c.name)) { m.warnings.push(`concept "${c.name}" is duplicated or has no name and was ignored`); continue; }
      const x = norm({ id: id('concept:' + c.name), name: c.name, description: c.description, displayName: c.displayName, tags: c.tags, properties: c.properties, gov: gv(c), pos: {}, ...ext(c, 'concept') });
      const q = at('conceptual', c.name); if (q) x.pos.conceptual = xy(q);
      m.concepts.push(x); conByName.set(c.name, x);
    }
    for (const e of lay('logical', [], 'entities')) {
      if (!e.name || entByName.has(e.name)) { m.warnings.push(`entity "${e.name}" is duplicated or has no name and was ignored`); continue; }
      const c = e.concept ? conByName.get(e.concept) : null;
      const x = norm({ id: id('entity:' + e.name), name: e.name, conceptId: c ? c.id : null, description: e.description, displayName: e.displayName, tags: e.tags, properties: e.properties, gov: gv(e), pos: {}, ...(e.concept && !c ? { broken: { concept: e.concept } } : {}), ...ext(e, 'entity') });
      const q = at('logical', e.name); if (q) x.pos.logical = xy(q);
      m.entities.push(x); entByName.set(e.name, x);
    }
    // a relationship that points at nothing (or a second foreign key on one column) is kept as it was, with a warning (SA.check 'broken-ref')
    const layerRel = (r, byName, what) => {
      const p = r && byName.get(r.parent), c = r && byName.get(r.child);
      if (!p || !c) { m.dangling.push({ list: what, r: clone(r) }); return null; }
      return { id: uid(), parentId: p.id, childId: c.id, cardinality: r.cardinality || '', name: r.name || '', description: r.description || '', ...ext(r, 'lrel') };
    };
    m.crels = lay('conceptual', [], 'relationships').map((r) => layerRel(r, conByName, 'conceptual')).filter(Boolean);
    m.lrels = lay('logical', [], 'relationships').map((r) => layerRel(r, entByName, 'logical')).filter(Boolean);
    m.ack = [...((o.alignment && o.alignment.acknowledged) || [])];
    const colByRef = new Map(), tabByRef = new Map();
    for (const t of o.tables || []) {
      let s = schemaByRef.get(t.schema);
      if (!s) { const parts = String(t.schema || 'main').split('.'); s = addSchema({ name: parts.at(-1) }, parts.length > 1 ? parts[0] : null); m.warnings.push(`schema "${t.schema}" was missing and has been created`); }
      const ref = (t.schema || s.name) + '.' + t.name;
      const x = norm({ id: id('table:' + ref), name: t.name, kind: t.kind === 'view' ? 'view' : 'table', viewType: t.viewType || 'view', definition: t.definition || '', schemaId: s.id, displayName: t.displayName, description: t.description, tags: t.tags, properties: t.properties, gov: gv(t), ...(t.sla ? { sla: slaFile(t.sla) } : {}), entityIds: [], pos: {}, columns: [], ...ext(t, 'table') });
      for (const n of t.entity == null ? [] : [].concat(t.entity)) { const e = entByName.get(n); if (e) x.entityIds.push(e.id); else (x.broken ||= { entity: [] }).entity.push(n); }
      for (const c of t.columns || []) {
        const cx = norm({ id: id('column:' + ref + '.' + c.name), name: c.name, displayName: c.displayName, dataType: c.type || 'STRING', description: c.description, primaryKey: !!c.pk, notNull: !!(c.notNull || c.pk), unique: !!c.unique, default: c.default || '', tags: c.tags, properties: c.properties, gov: gv(c), foreignKey: null, ...ext(c, 'column') });
        x.columns.push(cx); colByRef.set(ref + '.' + c.name, { t: x, c: cx });
      }
      for (const lv of LEVELS) { const q = at(lv, ref); if (q) x.pos[lv] = xy(q); }
      m.tables.push(x); tabByRef.set(ref, x);
    }
    for (const r of o.relationships || []) {
      const pc = r && colByRef.get(r.parent), cc = r && colByRef.get(r.child), pt = r && tabByRef.get(r.parent), ct = r && tabByRef.get(r.child);
      if (pc && cc && !cc.c.foreignKey) cc.c.foreignKey = { tableId: pc.t.id, columnId: pc.c.id, cardinality: r.cardinality || '1..M', name: r.name || '', description: r.description || '', ...ext(r, 'rel') };
      else if (pt && ct) {
        const rx = ext(r, 'rel');
        if (r.via && !tabByRef.get(r.via)) rx.ext = { ...rx.ext, via: r.via }; // bridge table not in this file (another part): kept by name, not dropped (ADR-0043)
        m.relations.push({ id: uid(), parentId: pt.id, childId: ct.id, cardinality: r.cardinality || '1..M', name: r.name || '', description: r.description || '', viaId: (r.via && tabByRef.get(r.via) && tabByRef.get(r.via).id) || null, ...rx });
      }
      else m.dangling.push({ list: 'relationships', r: clone(r) });
    }
    // semantic level: metrics by name (ADR-0037); columns = transient input rows filled by the semantic view
    for (const x of (o.semantic && o.semantic.metrics) || []) {
      if (!x.name || m.metrics.some((y) => y.name === x.name)) { m.warnings.push(`metric "${x.name}" is duplicated or has no name and was ignored`); continue; }
      const mt = norm({ id: id('metric:' + x.name), name: x.name, displayName: x.displayName, description: x.description, calculation: x.calculation || '', aggregation: x.aggregation || '', grain: [].concat(x.grain || []), tags: x.tags, properties: x.properties, gov: gv(x), pos: {}, columns: [], ...ext(x, 'metric') });
      const q = at('semantic', x.name); if (q) mt.pos.semantic = xy(q);
      m.metrics.push(mt);
    }
    for (const t of nodesOf(m, level)) if (t.pos[level]) { t.x = t.pos[level].x; t.y = t.pos[level].y; }
    return m;
  }
  const gv = (o) => (o.governance && typeof o.governance === 'object' && !Array.isArray(o.governance) ? clone(o.governance) : {});

  function fromLegacy(o, level) {
    const m = blank();
    m.project = norm({ ...o.project });
    m.catalogs = (o.catalogs || []).map((c) => norm({ ...c }));
    m.schemas = (o.schemas || []).map((s) => norm({ ...s }));
    m.tables = (o.tables || []).map((t) => norm({ ...t, pos: { physical: { x: t.x, y: t.y } }, columns: (t.columns || []).map((c) => norm({ ...c, foreignKey: c.foreignKey ? { ...c.foreignKey, cardinality: '1..M' } : null })) }));
    m.warnings.push('Converted from the legacy Strata 1 format; old embedded versions were dropped.');
    for (const t of m.tables) if (t.pos[level]) { t.x = t.pos[level].x; t.y = t.pos[level].y; }
    return m;
  }

  // ---------- flat entity maps (unit of versioning) ----------
  const strip = (o) => { const { tags, properties, governance, ...r } = o; return r; };
  // relationship entities are keyed <prefix><parent>><child>; parallel relationships between the same pair (billing and shipping address,
  // ADR-0040) add their label: <prefix><parent>><child>#<name>. A pair with one relationship keeps the plain key.
  function relEntities(M, prefix, list) {
    const n = new Map();
    for (const r of list) n.set(r.parent + '>' + r.child, (n.get(r.parent + '>' + r.child) || 0) + 1);
    for (const r of list) {
      let k = prefix + r.parent + '>' + r.child;
      if (n.get(r.parent + '>' + r.child) > 1) { k += '#' + (r.name || ''); while (k in M) k += '#'; }
      M[k] = r;
    }
  }
  function flatten(F) {
    const M = {}, G = {}, S = {};
    const asg = (key, o) => { if ((o.tags && o.tags.length) || hasKeys(o.properties) || hasKeys(o.governance)) G['assign:' + key] = { ...(o.tags && o.tags.length ? { tags: o.tags } : {}), ...(hasKeys(o.properties) ? { properties: o.properties } : {}), ...(hasKeys(o.governance) ? { governance: o.governance } : {}) }; };
    if (F.project) { M.project = strip(F.project); asg('project', F.project); }
    for (const c of F.catalogs || []) { M['catalog:' + c.name] = strip(c); asg('catalog:' + c.name, c); }
    for (const s of F.schemas || []) { const ref = (s.catalog ? s.catalog + '.' : '') + s.name; M['schema:' + ref] = strip(s); asg('schema:' + ref, s); }
    for (const t of F.tables || []) {
      const ref = t.schema + '.' + t.name, { columns, ...rest } = strip(t);
      M['table:' + ref] = { ...rest, columns: (columns || []).map((c) => c.name) };
      asg('table:' + ref, t);
      for (const c of columns || []) { M['column:' + ref + '.' + c.name] = strip(c); asg('column:' + ref + '.' + c.name, c); }
    }
    relEntities(M, 'rel:', F.relationships || []);
    const C = F.conceptual || {}, Lg = F.logical || {};
    for (const c of C.concepts || []) { M['concept:' + c.name] = strip(c); asg('concept:' + c.name, c); }
    relEntities(M, 'crel:', C.relationships || []);
    for (const e of Lg.entities || []) { M['entity:' + e.name] = strip(e); asg('entity:' + e.name, e); }
    relEntities(M, 'lrel:', Lg.relationships || []);
    for (const x of (F.semantic && F.semantic.metrics) || []) { S['metric:' + x.name] = strip(x); asg('metric:' + x.name, x); }
    // unknown keys of the file and of its sections (ADR-0042) are versioned as entities of their own
    for (const k of Object.keys(F)) if (!TOP.includes(k)) M['extra:' + k] = F[k];
    for (const [sec, known] of Object.entries(SECTION_KEYS)) if (F[sec] && typeof F[sec] === 'object') { const e = Object.fromEntries(Object.entries(F[sec]).filter(([k]) => !known.includes(k))); if (hasKeys(e)) M['extra:' + sec] = e; }
    const acks = (F.alignment && F.alignment.acknowledged) || [], by = (st) => acks.filter((k) => ackStream(k) === st);
    if (by('modelling').length) M.alignment = { acknowledged: by('modelling') };
    if (by('governance').length) G.acknowledged = by('governance');
    if (by('semantic').length) S.acknowledged = by('semantic');
    const Gv = F.governance || {};
    for (const t of Gv.tags || []) G['tag:' + t.name] = t;
    if (Gv.propertyKeys) G.propertyKeys = Gv.propertyKeys;
    for (const p of Gv.policies || []) G['policy:' + p.name] = p;
    return { modelling: M, governance: G, semantic: S };
  }

  function unflatten(M, G, S = {}) {
    const F = { strata: 2 };
    const keys = (o, p) => Object.keys(o).filter((k) => k.startsWith(p)).sort();
    const A = (key, o) => (G['assign:' + key] ? { ...o, ...G['assign:' + key] } : o);
    if (M.project) F.project = A('project', M.project);
    const tags = keys(G, 'tag:').map((k) => G[k]), policies = keys(G, 'policy:').map((k) => G[k]);
    const X = (sec) => M['extra:' + sec] || {}, section = (sec, base) => { if (base || hasKeys(X(sec))) F[sec] = { ...(base || {}), ...X(sec) }; };
    section('governance', tags.length || (G.propertyKeys || []).length || policies.length ? { ...(tags.length ? { tags } : {}), ...(G.propertyKeys && G.propertyKeys.length ? { propertyKeys: G.propertyKeys } : {}), ...(policies.length ? { policies } : {}) } : null);
    const layer = (ek, rk, list) => { const e = keys(M, ek).map((k) => A(k, M[k])), r = keys(M, rk).map((k) => M[k]); return e.length || r.length ? { ...(e.length ? { [list]: e } : {}), ...(r.length ? { relationships: r } : {}) } : null; };
    section('conceptual', layer('concept:', 'crel:', 'concepts'));
    section('logical', layer('entity:', 'lrel:', 'entities'));
    const cats = keys(M, 'catalog:').map((k) => A(k, M[k]));
    if (cats.length) F.catalogs = cats;
    F.schemas = keys(M, 'schema:').map((k) => A(k, M[k]));
    F.tables = keys(M, 'table:').map((k) => {
      const ref = k.slice(6), { columns, ...rest } = M[k];
      return { ...A(k, rest), columns: (columns || []).map((n) => A('column:' + ref + '.' + n, M['column:' + ref + '.' + n])).filter(Boolean) };
    });
    const rels = keys(M, 'rel:').map((k) => M[k]);
    if (rels.length) F.relationships = rels;
    const metrics = keys(S, 'metric:').map((k) => A(k, S[k]));
    section('semantic', metrics.length ? { metrics } : null);
    const acks = [...((M.alignment || {}).acknowledged || []), ...(G.acknowledged || []), ...(S.acknowledged || [])].sort();
    section('alignment', acks.length ? { acknowledged: acks } : null);
    for (const k of keys(M, 'extra:')) if (!SECTIONS.includes(k.slice(6))) F[k.slice(6)] = M[k];
    return F;
  }

  // ---------- version history (ADR-0042) ----------
  // A log is a list of entries, one per line in <name>.model.history.jsonl, appended and never changed. Each entry belongs to one stream and
  // carries: `id` (m3: a label), `ts` and `hlc` (hybrid logical clock: wall ms . counter . node, sorts as a string), the author, `kind` and
  // its content (the first entry of a stream is a full `snapshot`, every later one a `delta` {set, del} of whole entities), `hash` (SHA-256
  // of the stream's content after it: how the model file finds its version), `prev` (chain of the entry it was made from) and `chain`
  // = SHA-256(prev + canonical(entry without chain)): editing any entry, or dropping one from the middle, is detected. Entries form a DAG
  // through `prev` (and `merge`, the other branches a merge entry joins); `abandon` names a head that an edit after an undo left behind.
  const newHistory = () => ({ strata: 'history/2', entries: [] });
  const entriesOf = (h, s) => h.entries.filter((e) => e.stream === s);
  const caches = new WeakMap(), indexes = new WeakMap(), seeds = new WeakMap(); // states, structure and preloaded snapshots stay out of the serialised history
  const cacheOf = (h) => { if (!caches.has(h)) caches.set(h, new Map()); return caches.get(h); };
  const parentsOf = (e) => [e.prev, ...(e.merge || [])].filter(Boolean);
  const hlcOf = (wall, counter, node) => `${String(wall).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${node}`;
  const hlcAt = (s) => { const [w, c] = String(s || '').split('.'); return [parseInt(w, 10) || 0, parseInt(c, 10) || 0]; };
  const newer = (a, b) => (!a || String(b.hlc) > String(a.hlc) ? b : a);
  const chainOf = (e) => { const { chain, ...rest } = e; return sha256((e.prev || '') + canon(rest)); };
  const seal = (e) => Object.assign(e, { chain: chainOf(e) });

  // structure of a log: entries by chain, their children, and per stream the live heads (not abandoned; when every head is abandoned, all of them)
  function ix(h) {
    const hit = indexes.get(h);
    if (hit && hit.arr === h.entries && hit.n === h.entries.length) return hit;
    const byKey = new Map(), ref = new Set(), gone = new Set();
    for (const e of h.entries) byKey.set(e.chain, e);
    for (const e of h.entries) { parentsOf(e).forEach((p) => ref.add(p)); (e.abandon || []).forEach((a) => gone.add(a)); }
    const heads = {};
    for (const s of STREAMS) { const all = h.entries.filter((e) => e.stream === s && !ref.has(e.chain)), live = all.filter((e) => !gone.has(e.chain)); heads[s] = live.length ? live : all; }
    const x = { arr: h.entries, n: h.entries.length, byKey, heads };
    indexes.set(h, x);
    return x;
  }
  const entry = (h, key) => ix(h).byKey.get(key) || null;
  const headsOf = (h, s) => ix(h).heads[s];
  function ancestors(h, key) { // the entry itself and everything it was made from
    const X = ix(h), out = new Set(), todo = [key];
    while (todo.length) { const k = todo.pop(); if (!k || out.has(k)) continue; out.add(k); const e = X.byKey.get(k); if (e) todo.push(...parentsOf(e)); }
    return out;
  }
  // entries that are part of a stream's current history (reachable from a live head); the others were undone and left behind
  function liveKeys(h, s) { const out = new Set(); for (const x of headsOf(h, s)) ancestors(h, x.chain).forEach((k) => out.add(k)); return out; }

  // a stream's content after an entry: the nearest snapshot (or preloaded one, if its hash still holds) plus the deltas since
  function stateAt(h, key) {
    const c = cacheOf(h), X = ix(h), path = [];
    let e = X.byKey.get(key), st = null;
    if (!e) return null;
    for (;;) {
      if (c.has(e.chain)) { st = c.get(e.chain); break; }
      const seed = (seeds.get(h) || {})[e.chain];
      if (seed && stateHash(seed) === e.hash) { st = seed; c.set(e.chain, st); break; } // a stale or damaged cache is ignored
      if (e.kind === 'snapshot') { st = clone(e.snapshot); c.set(e.chain, st); break; }
      path.push(e);
      e = X.byKey.get(e.prev);
      if (!e) return null; // the log lost an entry this one depends on
    }
    for (const x of path.reverse()) { // a patch replaces whole entities, so the unchanged ones are shared with the previous state (states are read-only)
      st = { ...st };
      for (const k of x.patch.del) delete st[k];
      Object.assign(st, clone(x.patch.set));
      c.set(x.chain, st);
    }
    return st;
  }
  // snapshots as a rebuildable local cache (.strata/cache/): the head of each stream and every 20th entry along its history
  function snapshots(h) {
    const out = {};
    for (const s of STREAMS) for (const x of headsOf(h, s)) {
      const path = []; for (let e = x; e; e = entry(h, e.prev)) path.push(e);
      path.reverse().forEach((e, i) => { if (e === x || (i && i % 20 === 0)) { const st = stateAt(h, e.chain); if (st) out[e.chain] = st; } });
    }
    return out;
  }
  const useSnapshots = (h, obj) => { if (obj && typeof obj === 'object') seeds.set(h, obj); };

  function diffFlat(a, b) {
    const set = {}, del = [];
    for (const k of Object.keys(b)) if (!(k in a) || canon(a[k]) !== canon(b[k])) set[k] = b[k];
    for (const k of Object.keys(a)) if (!(k in b)) del.push(k);
    return { set, del };
  }

  // changed fields of one entity: [{f, before, after}] (a non-object value is one field named '')
  function fieldDiff(a, b) {
    const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (!obj(a) || !obj(b)) return [{ f: '', before: a, after: b }];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => canon(a[f]) !== canon(b[f])).map((f) => ({ f, before: a[f], after: b[f] }));
  }

  // what a history entry did compared with the entry it was made from: added (+), changed (~, with before and after values per field) and
  // removed (−, with the removed content). The first entry of a stream is the initial state.
  function changesOf(h, e) {
    const par = entry(h, e.prev), now = stateAt(h, e.chain) || {};
    let items, initial = !par;
    if (!par) items = Object.keys(now).sort().map((k) => ({ op: '+', k, after: now[k] }));
    else {
      const prev = stateAt(h, par.chain) || {}, d = e.kind === 'delta' ? e.patch : diffFlat(prev, now); // a delta's patch is that diff
      items = [
        ...Object.keys(d.set).sort().map((k) => (k in prev ? { op: '~', k, before: prev[k], after: now[k], fields: fieldDiff(prev[k], now[k]) } : { op: '+', k, after: now[k] })),
        ...[...d.del].sort().map((k) => ({ op: '−', k, before: prev[k] })),
      ];
    }
    // a domain change (e.moved, recorded by applyProjectEdit): the object leaves one part's log and joins another's; it is one item marked
    // `moved: {from|to}` (its columns travel with it and are not listed), not an unrelated delete and add. A part's first entry can carry it too.
    const mv = new Map();
    for (const g of e.moved || []) for (const k of g.keys) mv.set(k, g);
    if (!mv.size) return { initial, items };
    const root = (k) => (k.startsWith('column:') ? 'table:' + k.slice(7, k.lastIndexOf('.')) : k);
    return { initial: initial && !items.some((it) => mv.has(it.k)), items: items.filter((it) => root(it.k) === it.k || !mv.has(root(it.k))).map((it) => (mv.has(it.k) ? { ...it, moved: { from: mv.get(it.k).from, to: mv.get(it.k).to } } : it)) };
  }

  // Record `flat` as the next entry of a stream, made from `base` (the entry the model is at; the newest head when unknown). The log only
  // grows. Made from an earlier entry than the head (an edit after an undo), the entry `abandon`s that head instead of deleting it; with
  // several live heads (a log merged by Git) it also `merge`s the others, so one entry joins the branches again. info.at = clock (tests).
  function commit(h, stream, base, flat, info, extra = {}) {
    const X = ix(h), heads = X.heads[stream];
    let b = base && X.byKey.get(base);
    if (!b || b.stream !== stream) b = heads.reduce(newer, null);
    const prev = b ? stateAt(h, b.chain) : null, d = prev && diffFlat(prev, flat);
    if (prev && !Object.keys(d.set).length && !d.del.length && !extra.force) return null;
    if (!prev && !Object.keys(flat).length && !entriesOf(h, stream).length && !extra.force) return null; // an empty stream that never had content gets no entry (a model without metrics gets no s1)
    const above = b ? ancestors(h, b.chain) : new Set(), undone = b && heads.length === 1 && heads[0] !== b && ancestors(h, heads[0].chain).has(b.chain) ? heads[0] : null, others = b && !undone ? heads.filter((x) => x !== b && !above.has(x.chain)) : [];
    const n = entriesOf(h, stream).reduce((a, x) => Math.max(a, parseInt(x.id.slice(1), 10) || 0), 0) + 1;
    const now = info.at ?? Date.now(), top = h.entries.reduce((a, x) => (String(x.hlc) > String(a) ? x.hlc : a), ''), [tw, tc] = hlcAt(top);
    const wall = Math.max(now, tw), node = info.node || sha256(`${info.email || ''}|${info.system || ''}|${info.user || ''}`).slice(0, 6);
    const e = { id: PREFIX[stream] + n, stream, ts: new Date(wall).toISOString(), hlc: hlcOf(wall, wall === tw ? tc + 1 : 0, node), user: info.user || 'unknown', email: info.email || '', ...(info.system ? { system: info.system } : {}), message: info.message };
    if (!prev) { e.kind = 'snapshot'; e.snapshot = clone(flat); } else { e.kind = 'delta'; e.patch = d; }
    if (extra.layout) e.layout = extra.layout; // optional auto-layout payload {level, before, after}
    if (extra.moved) e.moved = extra.moved; // objects that changed PART (domain) in this edit: [{from|to: part, keys}] (lib/project.js#applyProjectEdit)
    if (undone) e.abandon = [undone.chain];
    if (others.length) e.merge = others.map((x) => x.chain);
    e.hash = stateHash(flat); e.prev = b ? b.chain : '';
    h.entries.push(seal(e));
    return e;
  }

  // ---------- the log as text: JSON Lines ----------
  const ENTRY_KEYS = ['id', 'stream', 'ts', 'hlc', 'user', 'email', 'system', 'message', 'kind', 'snapshot', 'patch', 'layout', 'moved', 'abandon', 'merge'];
  const ENTRY_END = ['hash', 'prev', 'chain'];
  const lineOf = (e) => { const o = {}; for (const k of [...ENTRY_KEYS, ...Object.keys(e).filter((k) => ![...ENTRY_KEYS, ...ENTRY_END].includes(k)), ...ENTRY_END]) if (k in e && e[k] !== undefined) o[k] = e[k]; return JSON.stringify(o); };
  const logText = (h) => h.entries.map((e) => lineOf(e) + '\n').join('');
  const MARK = /^(<{7}|={7}|>{7}|\|{7})/;
  // Older logs were one JSON document (`.model.version.json`, media/legacy.js reads them): its first line is a bare `{`
  const isLegacyLog = (text) => { const first = String(text || '').split('\n').map((l) => l.trim()).find((l) => l && !MARK.test(l)); return first === '{'; };
  // Text -> {history, error?}. Lines Git may have left as conflict markers are skipped (with merge=union it writes none): every line is an entry of its own.
  function parseLog(text) {
    const h = newHistory(), seen = new Set();
    let n = 0;
    for (const line of String(text || '').split('\n')) {
      n++;
      if (!line.trim() || MARK.test(line)) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { return { history: newHistory(), error: `line ${n} is not valid JSON (${err.message})` }; }
      if (!e || typeof e !== 'object' || !e.id || !STREAMS.includes(e.stream)) return { history: newHistory(), error: `line ${n} is not a version entry` };
      const k = e.chain || 'line' + n;
      if (!seen.has(k)) { seen.add(k); h.entries.push(e); } // union merges can repeat a line
    }
    return { history: h };
  }

  // Is the log itself intact? Every entry's chain hash must hold and every parent must exist. -> [problem text]
  function verifyLog(h) {
    const keys = new Set(h.entries.map((e) => e.chain)), out = [];
    for (const e of h.entries) {
      if (e.chain !== chainOf(e)) out.push(`${e.id} (${e.stream}, ${e.user || '?'}, ${e.ts || '?'}) was changed after it was recorded`);
      else if (parentsOf(e).some((p) => !keys.has(p))) out.push(`${e.id} (${e.stream}) refers to an entry that is not in the log`);
    }
    return out;
  }

  // Which entry does the model's content match? Per stream the newest entry (by clock) whose hash equals the content's, preferring the current
  // history over undone entries. -> {pointers: {stream: chain}, problems}
  function locate(h, flats) {
    const pointers = {}, problems = [];
    for (const s of STREAMS) {
      const flat = flats[s], list = entriesOf(h, s), hs = stateHash(flat), live = liveKeys(h, s);
      const hits = list.filter((e) => e.hash === hs), best = hits.filter((e) => live.has(e.chain)).reduce(newer, null) || hits.reduce(newer, null);
      if (best) pointers[s] = best.chain;
      else if (Object.keys(flat).length || list.length) problems.push(`${s}: the content matches none of the recorded versions${list.length ? ` (newest is ${headsOf(h, s).reduce(newer, null).id})` : ''}`);
    }
    return { pointers, problems };
  }
  // Does the model on disk agree with the history? The log's own integrity and the content against the versions.
  const verify = (h, flats) => [...verifyLog(h), ...locate(h, flats).problems];

  // Branches of a log that several people appended to (a merge=union in Git leaves every side's lines): per stream with more than one live head, the
  // objects both sides changed differently. Nothing is decided here: the model file is what Git and the user made of it, and recording the merge
  // (a commit with `merge`) confirms it. flats (optional): which side's version the model holds. -> [{stream, heads, conflicts: [{key, sides}]}]
  function forks(h, flats) {
    const out = [];
    for (const s of STREAMS) {
      const hs = headsOf(h, s);
      if (hs.length < 2) continue;
      const anc = hs.map((x) => ancestors(h, x.chain)), states = hs.map((x) => stateAt(h, x.chain) || {});
      const touched = anc.map((a, i) => {
        const set = new Set();
        for (const k of a) if (!anc.some((o, j) => j !== i && o.has(k))) { // only what this side added
          const e = entry(h, k), par = e && entry(h, e.prev), st = e && stateAt(h, k);
          if (!e || !st) continue;
          const d = e.kind === 'delta' ? e.patch : diffFlat(par ? stateAt(h, par.chain) || {} : {}, st);
          Object.keys(d.set).forEach((x) => set.add(x)); d.del.forEach((x) => set.add(x));
        }
        return set;
      });
      const bad = new Set();
      for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) for (const k of touched[i]) if (touched[j].has(k) && canon(states[i][k]) !== canon(states[j][k])) bad.add(k);
      out.push({ stream: s, heads: hs, conflicts: [...bad].sort().map((k) => ({ key: k, sides: hs.map((x, i) => ({ entry: x, has: flats ? canon((flats[s] || {})[k]) === canon(states[i][k]) : null })) })) });
    }
    return out;
  }

  // Undo goes to the entry the current one was made from; redo to the newest entry made from it that is still part of the history. Across
  // streams the most recent change (by clock) is undone first, the earliest undone change redone first. pointers: {stream: chain}.
  function undoTarget(h, pointers) {
    let best = null;
    for (const s of STREAMS) { const e = pointers[s] && entry(h, pointers[s]), p = e && entry(h, e.prev); if (p && (!best || String(e.hlc) > best.hlc)) best = { stream: s, key: p.chain, hlc: e.hlc }; }
    return best;
  }
  function redoTarget(h, pointers) {
    let best = null;
    for (const s of STREAMS) {
      const e = pointers[s] && entry(h, pointers[s]);
      if (!e) continue;
      const live = liveKeys(h, s), kid = h.entries.filter((x) => x.stream === s && x.prev === e.chain && live.has(x.chain)).reduce(newer, null);
      if (kid && (!best || String(kid.hlc) < best.hlc)) best = { stream: s, key: kid.chain, hlc: kid.hlc };
    }
    return best;
  }
  // entries crossed going from one entry to another of a stream: {back: true, list} when `to` is older (list = from ... just after `to`), else {back: false, list} (just after `from` ... to)
  function between(h, from, to) {
    const back = ancestors(h, from).has(to), [hi, lo] = back ? [from, to] : [to, from], list = [];
    if (!ancestors(h, hi).has(lo)) return { back: true, list: [] };
    for (let e = entry(h, hi); e && e.chain !== lo; e = entry(h, e.prev)) list.push(e);
    return { back, list: back ? list : list.reverse() };
  }

  // ---------- saved canvas state (.strata/layout.json, ADR-0033): one state per level, names instead of ids ----------
  // in memory: {level, mode, history, levels: {<level>: {autoFit, view{x,y,k}, scope{c,s,k: Sets of ids}, panels{impact, order, orderView, align}, selected: id}}}
  const VIEWS = ['stages', 'pipeline', 'tree'];
  function canvasOut(m, st) {
    const R = refs(m), name = (list, id) => (list.find((x) => x.id === id) || {}).name, out = { level: st.level, mode: st.mode, history: !!st.history, minimap: st.minimap !== false, levels: {} };
    if (st.governance) out.governance = st.governance; // the Governance tab (ADR-0038): {view, sel, graph} by policy name
    for (const [lv, x] of Object.entries(st.levels || {})) {
      const ns = nodesOf(m, lv), sel = x.selected && ns.find((n) => n.id === x.selected);
      out.levels[lv] = {
        autoFit: !!x.autoFit, view: { x: Math.round(x.view.x), y: Math.round(x.view.y), k: Math.round(x.view.k * 1000) / 1000 },
        scope: { c: [...x.scope.c].map((id) => name(m.catalogs, id)).filter(Boolean), s: [...x.scope.s].map((id) => R.sch.get(id)).filter(Boolean), k: [...(x.scope.k || [])].map((id) => name(m.concepts, id)).filter(Boolean) },
        panels: { impact: !!x.panels.impact, order: !!x.panels.order, orderView: x.panels.orderView, align: !!x.panels.align },
        selected: sel ? R.tab.get(sel.id) || sel.name : null,
      };
    }
    return out;
  }
  // the saved state back to ids. Old files (one state, no `levels`): scope and panels count for every level, view and selection
  // only for the level they were saved on.
  function canvasIn(m, L) {
    if (!L || typeof L !== 'object') return null;
    const R = refs(m), okView = (v) => v && [v.x, v.y, v.k].every(Number.isFinite) && v.k > 0.05 && v.k < 6;
    const ids = (names, list, key) => (names || []).map((n) => (list.find((x) => key(x) === n) || {}).id).filter(Boolean);
    const one = (lv, x, withView) => {
      const ns = nodesOf(m, lv), sc = x.scope || {}, P = x.panels || {};
      const sel = withView && x.selected && ns.find((n) => (R.tab.get(n.id) || n.name) === x.selected);
      const fixed = withView && x.autoFit === false && okView(x.view);
      return {
        autoFit: !fixed, view: fixed ? { x: x.view.x, y: x.view.y, k: x.view.k } : { x: 40, y: 60, k: 1 },
        scope: { c: new Set(ids(sc.c, m.catalogs, (c) => c.name)), s: new Set(ids(sc.s, m.schemas, (s) => R.sch.get(s.id))), k: new Set(ids(sc.k, m.concepts, (c) => c.name)) },
        panels: { impact: !!P.impact, order: !!P.order, orderView: VIEWS.includes(P.orderView) ? P.orderView : 'stages', align: !!P.align },
        selected: sel ? sel.id : null,
      };
    };
    const level = LEVELS.includes(L.level) || L.level === 'governance' || L.level === 'domains' ? L.level : 'physical', levels = {}; // governance, domains: tabs, no canvas
    if (L.levels) { for (const lv of LEVELS) if (L.levels[lv]) levels[lv] = one(lv, L.levels[lv], true); }
    else for (const lv of LEVELS) levels[lv] = one(lv, L, lv === level); // the old single-state shape
    const G = L.governance, pols = new Set(((m.governance || {}).policies || []).map((p) => p.name)); // names that no longer exist are dropped
    const governance = G && typeof G === 'object' ? { governance: { view: G.view === 'graph' ? 'graph' : 'list', sel: pols.has(G.sel) ? G.sel : null, graph: (Array.isArray(G.graph) ? G.graph : []).filter((n) => pols.has(n)) } } : {};
    return { level, mode: L.mode === 'data' ? 'data' : 'schema', history: !!(L.levels ? L.history : (L.panels || {}).history), minimap: L.minimap !== false, levels, ...governance };
  }

  // ---------- CSV ----------
  function parseCsv(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }
  const csvCell = (v) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

  const api = { xy, sha256js, LEVELS, STREAMS, PLATFORMS, METHODS, PREFIX, uid, canon, hash, sha256, stateHash, clone, stringify, blank, nodesOf, metricIndex, metricRefs, metricSnap, metricRewrite, norm, refs, idIndex, toFile, layoutOf, layoutFile, layoutRead, fromFile, flatten, unflatten,
    newHistory, entriesOf, entry, headsOf, ancestors, liveKeys, stateAt, snapshots, useSnapshots, commit, seal, hlcOf, parseLog, logText, isLegacyLog, verifyLog, locate, verify, forks, undoTarget, redoTarget, between, canvasIn, canvasOut, diffFlat, changesOf, parseCsv, csvCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
