// Impact analysis over the working model (no DOM): what breaks if a catalog, schema, table, view or column is deleted or
// changed, plus unreferenced-column detection. Loaded by the webview and by node tests.
//
// Dependencies ("A depends on B" = A breaks when B goes away or changes):
//   - an FK column depends on the column it references
//   - a view depends on every table it reads and on every column its SQL mentions, and every column of a view depends
//     on the view (a view that no longer compiles is broken as a whole)
// Upstream (what the selection depends on / reads from) counts as much as downstream: a selection is only "safe" when nothing depends
// on it AND it depends on nothing (no FK to another table, no view reading it or read by it, no table-level relationship).
// View SQL is not fully parsed: comments and string literals are removed, then table names (full, schema.table or a unique
// bare name) and column names are matched as identifiers. That over-approximates usage on purpose, so the analysis errs
// towards "impacted" and a column is only called unused when nothing plausible mentions it.
(function (g) {
  'use strict';
  const SM = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./model.js') : g.StrataModel;

  const key = (kind, id) => `${kind}:${id}`; // kind: catalog | schema | table (tables and views) | column | metric

  const PART = '(?:[A-Za-z_][\\w$]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
  const CHAIN = `${PART}(?:\\s*\\.\\s*(?:${PART}|\\*))*`;
  const KEYWORDS = new Set(['where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group', 'order', 'having', 'limit', 'union', 'using', 'select', 'from', 'lateral', 'qualify', 'window']);
  const unq = (p) => p.trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase();
  const stripSql = (sql) => String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, ' ');

  function buildIndex(m) {
    const R = SM.refs(m), full = new Map(), two = new Map(), bare = new Map(), byId = new Map(m.tables.map((t) => [t.id, t]));
    for (const t of m.tables) {
      const ref = R.tab.get(t.id).toLowerCase();
      full.set(ref, t.id);
      two.set(ref.split('.').slice(-2).join('.'), t.id);
      const n = t.name.toLowerCase();
      if (!bare.has(n)) bare.set(n, []);
      bare.get(n).push(t.id);
    }
    return { full, two, bare, byId };
  }
  function resolveTable(parts, idx) {
    if (parts.length >= 3 && idx.full.has(parts.slice(0, 3).join('.'))) return idx.full.get(parts.slice(0, 3).join('.'));
    if (parts.length >= 2 && idx.two.has(parts.slice(0, 2).join('.'))) return idx.two.get(parts.slice(0, 2).join('.'));
    const b = idx.bare.get(parts[0]);
    return b && b.length === 1 ? b[0] : null;
  }

  // tables and columns a view's SQL reads
  function viewReads(v, m, idx) {
    const sql = stripSql(v.definition);
    const tables = new Set(), words = new Set(), aliases = new Map(), starTables = new Set();
    const chains = (sql.match(new RegExp(CHAIN, 'g')) || []).map((c) => c.split('.').map(unq));
    for (const parts of chains) {
      const tid = resolveTable(parts, idx);
      if (tid && tid !== v.id) tables.add(tid);
      words.add(parts[parts.length - 1]);
    }
    const fromRe = new RegExp(`\\b(?:from|join)\\s+(${CHAIN})(?:\\s+(?:as\\s+)?([A-Za-z_][\\w$]*))?`, 'gi');
    for (const [, chain, alias] of sql.matchAll(fromRe)) {
      const tid = resolveTable(chain.split('.').map(unq), idx);
      if (tid && alias && !KEYWORDS.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), tid);
    }
    for (const parts of chains) if (parts[parts.length - 1] === '*' && parts.length > 1) {
      const tid = aliases.get(parts[0]) || resolveTable(parts.slice(0, -1), idx);
      if (tid) starTables.add(tid);
    }
    const noCount = sql.replace(/count\s*\(\s*\*\s*\)/gi, ' ');
    const bareStar = /\bselect\s+(?:distinct\s+)?\*|,\s*\*\s*(?=,|\bfrom\b)/i.test(noCount);
    const columns = new Set();
    for (const tid of tables) {
      for (const c of idx.byId.get(tid).columns) if (bareStar || starTables.has(tid) || words.has(c.name.toLowerCase())) columns.add(c.id);
    }
    return { tables, columns };
  }

  function graph(m) {
    const idx = buildIndex(m), dependents = new Map(), prereqs = new Map(), reads = new Map(), used = new Set();
    const add = (from, to) => {
      if (!dependents.has(from)) dependents.set(from, new Set());
      dependents.get(from).add(to);
      if (!prereqs.has(to)) prereqs.set(to, new Set());
      prereqs.get(to).add(from); // reverse edge: what `to` depends on
    };
    for (const t of m.tables) for (const c of t.columns) if (c.foreignKey) { add(key('column', c.foreignKey.columnId), key('column', c.id)); used.add(key('column', c.foreignKey.columnId)); }
    for (const v of m.tables) {
      if (v.kind !== 'view') continue;
      const r = viewReads(v, m, idx);
      reads.set(v.id, r);
      r.tables.forEach((tid) => add(key('table', tid), key('table', v.id)));
      r.columns.forEach((cid) => { add(key('column', cid), key('table', v.id)); used.add(key('column', cid)); });
      v.columns.forEach((c) => add(key('table', v.id), key('column', c.id)));
    }
    // metrics (semantic level, ADR-0037): a metric depends on the columns its calculation reads and on the metrics it builds on
    const MX = (m.metrics || []).length ? SM.metricIndex(m) : null;
    for (const x of m.metrics || []) {
      const r = SM.metricRefs(m, x, MX);
      r.columns.forEach((cid) => { add(key('column', cid), key('metric', x.id)); used.add(key('column', cid)); });
      r.metrics.forEach((id) => add(key('metric', id), key('metric', x.id)));
    }
    return { dependents, prereqs, reads, used };
  }

  // the node plus everything inside it (deleting a schema deletes its tables and their columns)
  function expand(m, node) {
    const [kind, id] = [node.slice(0, node.indexOf(':')), node.slice(node.indexOf(':') + 1)];
    const out = new Set([node]);
    if (kind === 'catalog') m.schemas.filter((s) => s.catalogId === id).forEach((s) => expand(m, key('schema', s.id)).forEach((x) => out.add(x)));
    if (kind === 'schema') m.tables.filter((t) => t.schemaId === id).forEach((t) => expand(m, key('table', t.id)).forEach((x) => out.add(x)));
    if (kind === 'table') { const t = m.tables.find((x) => x.id === id); if (t) t.columns.forEach((c) => out.add(key('column', c.id))); }
    return out;
  }

  // selection: node keys. mode 'delete' | 'change' (both follow dependents; delete additionally removes what is inside).
  function analyse(m, selection, mode) {
    const G = graph(m), sources = new Set(), impacted = new Set(), queue = [];
    selection.forEach((s) => expand(m, s).forEach((x) => sources.add(x)));
    queue.push(...sources);
    while (queue.length) {
      for (const d of G.dependents.get(queue.pop()) || []) if (!sources.has(d) && !impacted.has(d)) { impacted.add(d); queue.push(d); }
    }
    const tableOf = new Map(m.tables.flatMap((t) => t.columns.map((c) => [key('column', c.id), t.id])));
    const byId = new Map(m.tables.map((t) => [t.id, t]));
    const hot = (n) => sources.has(n) || impacted.has(n);
    // roll columns up to their table/view
    const srcTables = new Set(), impTables = new Set(), impViews = new Set();
    for (const n of sources) if (n.startsWith('table:')) srcTables.add(n.slice(6)); else if (tableOf.has(n)) srcTables.add(tableOf.get(n));
    for (const n of impacted) {
      const tid = n.startsWith('table:') ? n.slice(6) : tableOf.get(n);
      if (tid) (byId.get(tid).kind === 'view' ? impViews : impTables).add(tid);
    }
    // lineage edges into impacted views: one table-level edge when the table itself is hot, else one per hot column
    const lineage = [];
    for (const [vid, r] of G.reads) {
      if (!impacted.has(key('table', vid)) && !sources.has(key('table', vid))) continue;
      for (const tid of r.tables) {
        if (hot(key('table', tid))) { lineage.push({ view: vid, table: tid, column: null }); continue; }
        for (const c of byId.get(tid).columns) if (r.columns.has(c.id) && hot(key('column', c.id))) lineage.push({ view: vid, table: tid, column: c.id });
      }
    }
    const impactedRelations = (m.relations || []).filter((r) => srcTables.has(r.parentId) || srcTables.has(r.childId) || impTables.has(r.parentId) || impTables.has(r.childId));

    // upstream: everything the selection depends on (transitively), outside the selection itself
    const upstream = new Set(), uq = [...sources];
    while (uq.length) for (const p of G.prereqs.get(uq.pop()) || []) if (!sources.has(p) && !upstream.has(p)) { upstream.add(p); uq.push(p); }
    const upTables = new Set(), upViews = new Set();
    for (const n of upstream) {
      const tid = n.startsWith('table:') ? n.slice(6) : tableOf.get(n);
      if (tid && !srcTables.has(tid)) (byId.get(tid).kind === 'view' ? upViews : upTables).add(tid);
    }
    // table-level relationships: the parent side is upstream of the child side (they carry no columns, so they do not propagate)
    const selTab = new Set([...sources].filter((n) => n.startsWith('table:')).map((n) => n.slice(6))); // tables selected as a whole (not just one of their columns)
    const upstreamRelations = (m.relations || []).filter((r) => selTab.has(r.childId) && !selTab.has(r.parentId));
    upstreamRelations.forEach((r) => (byId.get(r.parentId).kind === 'view' ? upViews : upTables).add(r.parentId));
    // dashed lineage from what a selected (or upstream) view reads, drawn towards the view
    const upLineage = [];
    for (const [vid, r] of G.reads) {
      if (!sources.has(key('table', vid)) && !upstream.has(key('table', vid))) continue;
      for (const tid of r.tables) upLineage.push({ view: vid, table: tid, column: null, up: true });
    }
    const relTouched = (m.relations || []).some((r) => selTab.has(r.parentId) || selTab.has(r.childId));
    const metricIds = (set) => new Set([...set].filter((n) => n.startsWith('metric:')).map((n) => n.slice(7)));
    const linked = impacted.size === 0 && (upstream.size > 0 || relTouched);
    return {
      mode, sources, impacted, srcTables, impTables, impViews, lineage: [...lineage, ...upLineage], impactedRelations,
      impactedColumns: [...impacted].filter((n) => n.startsWith('column:')),
      upstream, upTables, upViews, upstreamColumns: [...upstream].filter((n) => n.startsWith('column:')), upstreamRelations,
      impMetrics: metricIds(impacted), upMetrics: metricIds(upstream), srcMetrics: metricIds(sources),
      // 'impacted' (things depend on it), 'linked' (nothing depends on it but it has upstream references or relationships), 'safe'
      state: impacted.size ? 'impacted' : linked ? 'linked' : 'safe',
      linked, safe: impacted.size === 0 && !linked,
    };
  }

  // columns nothing in the model depends on: no FK points to them and no view mentions them. FK columns (they carry a
  // relationship) and view columns are left out; key columns only when includeKeys.
  function unusedColumns(m, includeKeys) {
    const G = graph(m), out = [];
    for (const t of m.tables) {
      if (t.kind === 'view') continue;
      for (const c of t.columns) {
        if (G.used.has(key('column', c.id)) || c.foreignKey) continue;
        const isKey = !!(c.primaryKey || c.unique);
        if (isKey && !includeKeys) continue;
        out.push({ tableId: t.id, columnId: c.id, key: isKey });
      }
    }
    return out;
  }

  const api = { key, graph, analyse, unusedColumns };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataImpact = api;
})(typeof window !== 'undefined' ? window : globalThis);
