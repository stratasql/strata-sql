// Conceptual / logical / physical alignment (ADR-0032). Pure logic over the working model (media/model.js), no DOM:
// what each layer level draws, inheritance of description / tags / properties down the chain, name-based suggestions,
// "generate from physical", merges, and the alignment warnings with their one-click fixes. Loaded by the webview and by node tests.
(function (g) {
  'use strict';
  const SM = g.StrataModel || (typeof require === 'function' ? require('./model.js') : null);

  // Links between the levels by id, for one pass over an unchanged model; kept in the caller's memo (a Map, shared with gov.js) or built per call.
  function lookup(m, memo) {
    const hit = memo && memo.get(lookup);
    if (hit) return hit;
    const ent = new Map(), con = new Map(), byEnt = new Map(), byCon = new Map(), push = (mp, k, v) => { if (!mp.has(k)) mp.set(k, []); mp.get(k).push(v); };
    for (const c of m.concepts) if (!con.has(c.id)) con.set(c.id, c);
    for (const e of m.entities) { if (!ent.has(e.id)) ent.set(e.id, e); push(byCon, e.conceptId, e); }
    for (const t of m.tables) for (const id of new Set(t.entityIds || [])) push(byEnt, id, t);
    const x = { tables: new Set(m.tables), ent, con, byEnt, byCon, eff: new Map() };
    if (memo) memo.set(lookup, x);
    return x;
  }
  const ents = (m, t, memo) => (t.entityIds || []).map((id) => lookup(m, memo).ent.get(id)).filter(Boolean);
  const conceptOf = (m, e, memo) => (e && e.conceptId ? lookup(m, memo).con.get(e.conceptId) || null : null);
  const tablesOf = (m, e, memo) => lookup(m, memo).byEnt.get(e.id) || [];
  const entitiesOf = (m, c, memo) => lookup(m, memo).byCon.get(c.id) || [];
  const hasLayers = (m) => m.concepts.length > 0 || m.entities.length > 0;
  const lib = (n, f) => g[n] || require(f); // impact.js / order.js load after this file in the webview
  const tablesOfConcept = (m, c, memo = new Map()) => [...new Set(entitiesOf(m, c, memo).flatMap((e) => tablesOf(m, e, memo)))];

  // ---------- the other analyses on the conceptual / logical level (ADR-0033): derived from the realising tables ----------
  // group id -> realising table ids, for the objects a level draws (null on a level without a layer)
  function groups(m, level) {
    const memo = new Map();
    if (level === 'conceptual' && m.concepts.length) return new Map(m.concepts.map((c) => [c.id, tablesOfConcept(m, c, memo).map((t) => t.id)]));
    if (level === 'logical' && m.entities.length) return new Map(m.entities.map((e) => [e.id, tablesOf(m, e, memo).map((t) => t.id)]));
    return null;
  }
  // load order of the concepts / entities: an object is ready when all its tables are (order.js rollup)
  function order(m, level, o) {
    const G = groups(m, level), OR = lib('StrataOrder', './order.js'), R = SM.refs(m);
    if (!G) return null;
    const nm = new Map([...m.concepts, ...m.entities].map((x) => [x.id, x.name]));
    return OR.rollup(o || OR.analyse(m), G, (id) => nm.get(id) || '', (id) => R.tab.get(id));
  }
  // impact of deleting / changing concepts or entities: the physical analysis of their tables, rolled up to the level,
  // plus the level's own relationships (the child side depends on the parent side, like a foreign key)
  function impact(m, level, keys, mode) {
    const G = groups(m, level), IM = lib('StrataImpact', './impact.js');
    if (!G) return null;
    const sel = new Set(keys.map((k) => k.slice(k.indexOf(':') + 1)).filter((id) => G.has(id)));
    const srcTables = [...new Set([...sel].flatMap((id) => G.get(id)))];
    const phys = srcTables.length ? IM.analyse(m, srcTables.map((id) => IM.key('table', id)), mode) : null;
    const of = new Map();
    G.forEach((ts, gid) => ts.forEach((t) => { if (!of.has(t)) of.set(t, []); of.get(t).push(gid); }));
    const impacted = new Set(), upstream = new Set(), add = (set, tids) => tids.forEach((t) => (of.get(t) || []).forEach((x) => { if (!sel.has(x)) set.add(x); }));
    if (phys) { add(impacted, [...phys.impTables, ...phys.impViews, ...srcTables]); add(upstream, [...phys.upTables, ...phys.upViews]); }
    const rels = level === 'conceptual' ? m.crels : m.lrels, touched = [];
    for (const r of rels) {
      if (sel.has(r.parentId) && !sel.has(r.childId)) { impacted.add(r.childId); touched.push(r); }
      else if (sel.has(r.childId) && !sel.has(r.parentId)) { upstream.add(r.parentId); touched.push(r); }
    }
    impacted.forEach((x) => upstream.delete(x));
    const state = !sel.size ? null : impacted.size || (phys && phys.state === 'impacted') ? 'impacted' : upstream.size || touched.length || (phys && phys.state === 'linked') ? 'linked' : 'safe';
    return { level, sources: sel, impacted, upstream, touched, state, phys, tables: srcTables };
  }

  // ---------- view scope (ADR-0033): catalogs, schemas and concepts, resolved to what each level shows ----------
  // scope = {c, s, k}: sets of catalog / schema / concept ids; null when nothing picked still exists (= whole project)
  function inScope(m, scope) {
    const memo = new Map(), cs = new Set([...scope.c].filter((id) => m.catalogs.some((c) => c.id === id)));
    const ss = new Set([...scope.s].filter((id) => m.schemas.some((x) => x.id === id)));
    const ks = new Set([...(scope.k || [])].filter((id) => lookup(m, memo).con.has(id)));
    if (!cs.size && !ss.size && !ks.size) return null;
    const schemas = new Set(m.schemas.filter((x) => ss.has(x.id) || cs.has(x.catalogId)).map((x) => x.id));
    const tables = new Set(m.tables.filter((t) => schemas.has(t.schemaId) || ents(m, t, memo).some((e) => ks.has(e.conceptId))).map((t) => t.id));
    const entities = new Set(m.entities.filter((e) => ks.has(e.conceptId) || tablesOf(m, e, memo).some((t) => tables.has(t.id))).map((e) => e.id));
    const concepts = new Set(m.concepts.filter((c) => ks.has(c.id) || entitiesOf(m, c, memo).some((e) => entities.has(e.id))).map((c) => c.id));
    return { catalogs: cs, schemas, tables, entities, concepts };
  }

  // ---------- what a layer level draws, shaped like the working model so the canvas can draw it unchanged ----------
  // Concepts / entities get transient drawing fields (layer, schemaId, columns); those are never written to the file.
  function view(m, level) {
    if (level === 'semantic') return lib('StrataGov', './gov.js').semView(m); // metrics and the tables they read (ADR-0037)
    const base = { project: m.project, catalogs: [], governance: m.governance };
    if (level === 'conceptual' && m.concepts.length) {
      const s = { id: '_concepts', name: 'Concepts', hidden: true, catalogId: null };
      m.concepts.forEach((c) => Object.assign(c, { layer: 'concept', schemaId: s.id, columns: [] }));
      return { ...base, layer: 'concept', schemas: [s], tables: m.concepts, relations: m.crels };
    }
    if (level === 'logical' && m.entities.length) {
      const frames = m.concepts.map((c) => ({ id: 'c:' + c.id, name: c.name, concept: c, catalogId: null }));
      const none = { id: '_none', name: 'No concept', catalogId: null }, memo = new Map();
      for (const e of m.entities) {
        const seen = new Set(), cols = [];
        const ts = tablesOf(m, e, memo), base = ts.filter((t) => t.kind !== 'view'); // views are derived: their columns only when nothing else realises it
        for (const t of base.length ? base : ts) for (const c of t.columns) if (!seen.has(c.name)) { seen.add(c.name); cols.push(c); } // attributes = the realising tables' columns by name (entities have none of their own yet)
        Object.assign(e, { layer: 'entity', schemaId: conceptOf(m, e, memo) ? 'c:' + e.conceptId : none.id, columns: cols });
      }
      const used = new Set(m.entities.map((e) => e.schemaId));
      return { ...base, layer: 'entity', schemas: [...frames, none].filter((s) => used.has(s.id)), tables: m.entities, relations: m.lrels };
    }
    return null;
  }

  // ---------- inheritance: conceptual > logical > physical (tables and views; columns do not inherit) ----------
  // parents of an object: a table -> its entities, an entity -> its concept
  function parentsOf(m, o, memo) {
    const X = lookup(m, memo);
    if (X.tables.has(o)) return ents(m, o, memo).map((e) => ({ o: e, kind: 'entity' }));
    if (X.ent.get(o.id) === o) { const c = conceptOf(m, o, memo); return c ? [{ o: c, kind: 'concept' }] : []; }
    return [];
  }
  // Effective values with their source (from = null when the object's own, else {kind, name} of the level it came from).
  // Nearest level wins for description / display name / each property; tags are a union, and "-tag" in an object's own
  // tags drops an inherited tag there (reported in `dropped`, and an alignment warning).
  function effective(m, o, memo = new Map()) {
    const X = lookup(m, memo);
    if (X.eff.has(o)) return X.eff.get(o);
    const r = { description: null, displayName: null, tags: [], dropped: [], properties: {} };
    const waived = new Set((o.tags || []).filter((n) => n[0] === '-').map((n) => n.slice(1)));
    if (o.description) r.description = { v: o.description, from: null };
    if (o.displayName) r.displayName = { v: o.displayName, from: null };
    for (const n of o.tags || []) if (n[0] !== '-') r.tags.push({ name: n, from: null });
    for (const [k, v] of Object.entries(o.properties || {})) r.properties[k] = { v, from: null };
    for (const p of parentsOf(m, o, memo)) {
      const e = effective(m, p.o, memo), src = (from) => from || { kind: p.kind, name: p.o.name };
      if (!r.description && e.description) r.description = { v: e.description.v, from: src(e.description.from) };
      if (!r.displayName && p.kind === 'entity') r.displayName = { v: p.o.name, from: src(null) };
      for (const t of e.tags) {
        if (r.tags.some((x) => x.name === t.name) || r.dropped.some((x) => x.name === t.name)) continue;
        (waived.has(t.name) ? r.dropped : r.tags).push({ name: t.name, from: src(t.from) });
      }
      for (const [k, x] of Object.entries(e.properties)) if (!(k in r.properties)) r.properties[k] = { v: x.v, from: src(x.from) };
    }
    X.eff.set(o, r);
    return r;
  }
  const fromText = (f) => (f ? `${f.kind} ${f.name}` : '');

  // ---------- names: dim_customer, customers, CustomerAddress -> tokens, "Customer", "Customer Address" ----------
  const PRE = new Set(['dim', 'd', 'fact', 'fct', 'f', 'stg', 'stage', 'staging', 'tbl', 'tb', 't', 'vw', 'v', 'hub', 'h', 'sat', 's', 'lnk', 'link', 'l', 'ref', 'raw', 'int', 'src', 'mv', 'agg', 'bridge', 'brg', 'xref']);
  const POST = new Set(['v', 'vw', 'view', 'hist', 'history', 'snapshot', 'snap', 'scd', 'scd2', 'dim', 'fact', 'tbl', 'current', 'curr', 'latest', 'master', 'data']);
  const single = (w) => (/ies$/.test(w) && w.length > 4 ? w.slice(0, -3) + 'y' : /(sses|xes|ches|shes|zes)$/.test(w) ? w.slice(0, -2) : /(ss|us|is|ics)$/.test(w) ? w : /s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w);
  function tokens(name) {
    const w = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    while (w.length > 1 && PRE.has(w[0])) w.shift();
    while (w.length > 1 && POST.has(w[w.length - 1])) w.pop();
    return w.map(single);
  }
  const title = (w) => w.map((x) => x[0].toUpperCase() + x.slice(1)).join(' ');
  const entityName = (tableName) => title(tokens(tableName));

  // best parent for a name: same tokens, else the longest parent whose tokens start the name (customer_address -> Customer)
  function bestMatch(name, parents) {
    const tk = tokens(name).join(' ');
    let best = null, bestLen = 0;
    for (const p of parents) {
      const pk = tokens(p.name).join(' ');
      if (!pk) continue;
      if (pk === tk) return p;
      if ((tk.startsWith(pk + ' ') || tk.endsWith(' ' + pk)) && pk.length > bestLen) { best = p; bestLen = pk.length; }
    }
    return best;
  }

  // pure bridge tables (only key columns) realise an M..M relationship, not an entity; one with attributes (order lines) is an associative entity
  const via = (m) => new Set(m.relations.map((r) => r.viaId).filter((id) => { const t = m.tables.find((x) => x.id === id); return t && t.columns.every((c) => c.primaryKey || c.foreignKey); }));
  const mappable = (m, t, bridges = via(m)) => t.kind !== 'view' && !bridges.has(t.id);

  // one-click suggestions for unmapped tables (not views or pure bridges: those may stay unmapped) and entities without a concept
  function suggest(m, memo = new Map()) {
    const tables = [], entities = [], bridges = via(m);
    for (const t of m.tables) if (!(t.entityIds || []).length && mappable(m, t, bridges)) { const e = bestMatch(t.name, m.entities); if (e) tables.push({ tableId: t.id, entityId: e.id }); }
    for (const e of m.entities) if (!conceptOf(m, e, memo)) { const c = bestMatch(e.name, m.concepts); if (c) entities.push({ entityId: e.id, conceptId: c.id }); }
    return { tables, entities };
  }

  // ---------- physical relationships as one list: FKs and table-level relations ----------
  function physRels(m) {
    const R = SM.refs(m), out = [];
    for (const t of m.tables) for (const c of t.columns) {
      const f = c.foreignKey;
      if (f && R.col.get(f.columnId)) out.push({ key: R.col.get(f.columnId) + '>' + R.col.get(c.id), p: f.tableId, c: t.id, card: f.cardinality || '1..M', name: f.name || '', description: f.description || '' });
    }
    for (const r of m.relations) if (R.tab.get(r.parentId) && R.tab.get(r.childId)) out.push({ key: R.tab.get(r.parentId) + '>' + R.tab.get(r.childId), p: r.parentId, c: r.childId, card: r.cardinality, name: r.name || '', description: r.description || '', via: r.viaId });
    return out;
  }
  // Relationships between a and b in either direction, told apart by their label when a pair has several (ADR-0040: billing / shipping
  // address). A pair with one relationship matches whatever the label; with several, the label decides, an unlabelled one matches the
  // unlabelled or (for a caller with no label) the first. -> (a, b, role = '') => {r, same} | null; `same` tells whether it runs a -> b
  const low = (x) => String(x || '').trim().toLowerCase();
  function pairs(list) {
    const k = new Map();
    for (const r of list) { const key = r.parentId + '>' + r.childId; if (!k.has(key)) k.set(key, []); k.get(key).push(r); }
    return (a, b, role = '') => {
      for (const [x, y] of [[a, b], [b, a]]) {
        const l = k.get(x + '>' + y);
        if (!l) continue;
        const r = (role && l.find((z) => low(z.name) === role)) || (l.length === 1 ? l[0] : l.find((z) => !z.name) || (role ? null : l[0]));
        if (r) return { r, same: x === a };
      }
      return null;
    };
  }
  const has = (list, p, c, name) => list.some((x) => ((x.parentId === p && x.childId === c) || (x.parentId === c && x.childId === p)) && low(x.name) === low(name)); // the same relationship, label included
  const parallel = (list, r) => list.filter((x) => x.parentId === r.parentId && x.childId === r.childId).length > 1;
  const uniq = (a) => [...new Set(a)];

  // ---------- generate the logical and conceptual layers from the physical model (fills gaps only, so it can run again) ----------
  function generate(m, uid = SM.uid) {
    const n = { entities: 0, concepts: 0, mapped: 0, lrels: 0, crels: 0 }, bridges = via(m);
    const find = (list, name) => list.find((x) => x.name.toLowerCase() === name.toLowerCase());
    for (const t of m.tables) {
      if ((t.entityIds || []).length || !mappable(m, t, bridges)) continue;
      const name = entityName(t.name);
      let e = find(m.entities, name);
      if (!e) { e = SM.norm({ id: uid(), name, conceptId: null, description: t.description, pos: {} }); m.entities.push(e); n.entities++; }
      t.entityIds = [e.id]; n.mapped++;
    }
    for (const e of m.entities) {
      if (e.conceptId && m.concepts.some((c) => c.id === e.conceptId)) continue;
      let c = find(m.concepts, e.name);
      if (!c) { c = SM.norm({ id: uid(), name: e.name, description: e.description, pos: {} }); m.concepts.push(c); n.concepts++; }
      e.conceptId = c.id;
    }
    n.lrels = addMissingLogical(m, uid);
    n.crels = addMissingConceptual(m, uid);
    return n;
  }
  // an M..M above is realised by 1..M relationships below (through a bridge or associative table): compatible, not a conflict
  const fits = (below, above) => !below || !above || below === above || (above === 'M..M' && below === '1..M');
  const WIDE = { 'M..M': 0, '1..M': 1, '1..1': 2, '': 3 }, widestFirst = (a, b) => (WIDE[a.fix.card || ''] ?? 3) - (WIDE[b.fix.card || ''] ?? 3);
  const relOf = (p, c, card, name, description, uid) => ({ id: uid(), parentId: p, childId: c, cardinality: card || '', name: name || '', description: description || '' });
  // logical relationships for every physical one between different entities (or a self reference) that has none yet
  function addMissingLogical(m, uid = SM.uid, only) {
    let k = 0;
    for (const w of check(m).all.filter((x) => x.kind === 'no-logical-rel' && (!only || only.has(x.key))).sort(widestFirst)) { const f = w.fix; if (!has(m.lrels, f.p, f.c, f.name)) { m.lrels.push(relOf(f.p, f.c, f.card, f.name, f.description, uid)); k++; } }
    return k;
  }
  function addMissingConceptual(m, uid = SM.uid, only) {
    let k = 0;
    for (const w of check(m).all.filter((x) => x.kind === 'no-conceptual-rel' && (!only || only.has(x.key))).sort(widestFirst)) { const f = w.fix; if (!has(m.crels, f.p, f.c, f.name)) { m.crels.push(relOf(f.p, f.c, f.card, f.name, f.description, uid)); k++; } }
    return k;
  }

  // ---------- merge one entity / concept into another (the usual step after generating 1:1) ----------
  function mergeInto(m, kind, fromId, toId) {
    if (fromId === toId) return;
    const [list, rels] = kind === 'concept' ? ['concepts', 'crels'] : ['entities', 'lrels'];
    if (kind === 'concept') m.entities.forEach((e) => { if (e.conceptId === fromId) e.conceptId = toId; });
    else m.tables.forEach((t) => { if ((t.entityIds || []).includes(fromId)) t.entityIds = uniq(t.entityIds.map((x) => (x === fromId ? toId : x))); });
    const kept = [];
    m[rels] = m[rels].filter((r) => !((r.parentId === fromId && r.childId === toId) || (r.parentId === toId && r.childId === fromId))) // now internal to the merged one
      .map((r) => ({ ...r, parentId: r.parentId === fromId ? toId : r.parentId, childId: r.childId === fromId ? toId : r.childId }))
      .filter((r) => { if (kept.some((x) => x.parentId === r.parentId && x.childId === r.childId && (!x.name || !r.name || low(x.name) === low(r.name)))) return false; kept.push(r); return true; }); // the same relationship, unless both carry different labels
    const from = m[list].find((x) => x.id === fromId), to = m[list].find((x) => x.id === toId);
    if (from && to) { if (!to.description) to.description = from.description; to.tags = uniq([...(to.tags || []), ...(from.tags || [])]); to.properties = { ...(from.properties || {}), ...(to.properties || {}) }; }
    remove(m, kind, fromId);
  }
  // delete a concept / entity: the links below it are cleared, its relationships go
  function remove(m, kind, id) {
    if (kind === 'concept') { m.concepts = m.concepts.filter((c) => c.id !== id); m.entities.forEach((e) => { if (e.conceptId === id) e.conceptId = null; }); m.crels = m.crels.filter((r) => r.parentId !== id && r.childId !== id); }
    else { m.entities = m.entities.filter((e) => e.id !== id); m.tables.forEach((t) => { if ((t.entityIds || []).includes(id)) t.entityIds = t.entityIds.filter((x) => x !== id); }); m.lrels = m.lrels.filter((r) => r.parentId !== id && r.childId !== id); }
  }

  // ---------- alignment warnings ----------
  // Each warning: {key, kind, level, text, go: {kind, id}, fix?}. A layer's checks run only once that layer exists (legacy files never warn).
  // key = kind:ref, stable across sessions; acknowledged keys live in m.ack ("alignment.acknowledged" in the file).
  const KINDS = {
    'unmapped': 'Tables not mapped to a logical entity',
    'no-concept': 'Entities without a concept',
    'no-entity': 'Concepts without a logical entity',
    'no-table': 'Entities not realised by a table',
    'no-logical-rel': 'Physical relationships missing in the logical model',
    'no-conceptual-rel': 'Logical relationships missing in the conceptual model',
    'logical-rel-unrealised': 'Logical relationships not realised physically',
    'conceptual-rel-unrealised': 'Conceptual relationships not realised logically',
    'cardinality': 'Cardinality differs between levels',
    'tag-dropped': 'Inherited tags dropped lower down',
    'broken-ref': 'References that point at nothing',
  };
  // ---------- references that point at nothing (ADR-0042) ----------
  // A relationship whose end is not in the model (another team's table, a renamed one), a second foreign key on one column, a table mapped to an
  // entity that does not exist, an entity of a missing concept: all are kept as written and reported here. Fix: delete the reference (or add what it
  // points at, and it resolves the next time the file is read). Metric inputs and grains have their own warning (metric-ref).
  const LIST_LEVEL = { relationships: 'physical', logical: 'logical', conceptual: 'conceptual' };
  // A name a dangling reference (or a table/entity's `broken` link) uses that this file cannot find may still resolve in another part of the
  // same project: `m.crossPart` (release 2 part 2, ADR-0045 point 6), the project index built by lib/project.js#buildIndex and attached the
  // same way `m.domains` is (host / CLI / skill script; transient, never round-tripped). A project of one part never carries it, so this is a
  // no-op there and `broken-ref` behaves exactly as release 1.
  function crossHas(m, list, name) {
    const X = m.crossPart;
    if (!X || !name) return false;
    const s = String(name).trim().toLowerCase(), hit = (arr) => arr.some((x) => x === s || s.endsWith('.' + x) || x.endsWith('.' + s));
    if (list === 'conceptual') return X.concepts.includes(s);
    if (list === 'logical') return X.entities.includes(s);
    return hit(X.tables) || hit(X.columns);
  }
  // The readable "what/where" of a dangling reference crossHas() resolves elsewhere in the project (release 2 part 4, ADR-0045 extended):
  // the far object's own name and which part (and, once the project has domains, which domain) holds it — so media/canvas.js can label a
  // cross-part stub ("→ Shippers (Catalog)") instead of the plain "not in this model" a genuinely broken one gets. Always returns something
  // (never null): when the owning part cannot be pinned down (an older project index without `owner`, or a name `crossHas` matched only by
  // its loose suffix rule) the label falls back to the reference's own last segment and `part`/`domain` stay null.
  function crossTarget(m, list, name) {
    const X = m.crossPart || {}, owner = X.owner || {}, dom = X.domainOfPart || {};
    const s = String(name || '').trim().toLowerCase();
    const ownerOf = (map, key) => { if (!map) return null; if (key in map) return map[key]; const k = Object.keys(map).find((x) => x === key || key.endsWith('.' + x) || x.endsWith('.' + key)); return k ? map[k] : null; };
    if (list === 'conceptual' || list === 'logical') {
      const part = ownerOf(list === 'conceptual' ? owner.concepts : owner.entities, s);
      return { label: name, part, domain: part ? dom[part] || null : null };
    }
    const stripped = s.split('.').slice(0, -1).join('.'), tabs = X.tables || [];
    const key = tabs.includes(s) ? s : tabs.includes(stripped) ? stripped : null;
    const part = key ? ownerOf(owner.tables, key) : null;
    return { label: key ? key.split('.').pop() : s.split('.').pop() || name, part, domain: part ? dom[part] || null : null };
  }
  function brokenRefs(m, add) {
    const R = SM.refs(m), tabs = new Map(m.tables.map((t) => [R.tab.get(t.id), t]));
    const tableOf = (ref) => tabs.get(ref) || tabs.get(String(ref).split('.').slice(0, -1).join('.'));
    for (const d of m.dangling || []) {
      const r = d.r || {}, ref = r.parent + '>' + r.child + (r.name ? '#' + r.name : ''), lay = d.list !== 'relationships';
      const at = lay ? (d.list === 'logical' ? m.entities : m.concepts) : null, find = (x) => (lay ? at.find((o) => o.name === x) : tableOf(x)), c = find(r.child), p = find(r.parent), host = c || p;
      const pOk = !!p || crossHas(m, d.list, r.parent), cOk = !!c || crossHas(m, d.list, r.child);
      if (pOk && cOk && !(p && c)) continue; // resolves elsewhere in this project (another part): not broken
      const missing = [!pOk ? r.parent : null, !cOk ? r.child : null].filter(Boolean).join(' and ');
      const what = `${lay ? d.list[0].toUpperCase() + d.list.slice(1) + ' relationship' : 'Relationship'} ${r.parent} → ${r.child}`;
      add('broken-ref', d.list + ':' + ref, LIST_LEVEL[d.list], missing ? `${what} points at ${missing}, which is not in this model` : `${what} is a second foreign key on a column that already has one; only the first is used`,
        host ? { kind: lay ? (d.list === 'logical' ? 'entity' : 'concept') : 'table', id: host.id } : { kind: 'project' }, { label: 'Delete this relationship', drop: { list: d.list, parent: r.parent, child: r.child, name: r.name || '' } });
    }
    const R2 = R.tab;
    for (const t of m.tables) for (const n of (t.broken || {}).entity || []) if (!crossHas(m, 'logical', n)) add('broken-ref', `table:${R2.get(t.id)}:entity:${n}`, 'physical', `${R2.get(t.id)} is mapped to entity "${n}", which does not exist`, { kind: 'table', id: t.id }, { label: 'Remove the link', obj: { kind: 'table', id: t.id }, entity: n });
    for (const e of m.entities) if (e.broken && e.broken.concept && !e.conceptId && !crossHas(m, 'conceptual', e.broken.concept)) add('broken-ref', `entity:${e.name}:concept:${e.broken.concept}`, 'logical', `Entity ${e.name} belongs to concept "${e.broken.concept}", which does not exist`, { kind: 'entity', id: e.id }, { label: 'Remove the link', obj: { kind: 'entity', id: e.id }, concept: e.broken.concept });
  }
  // governance warnings (media/gov.js) come after the alignment ones and share the Accept mechanism
  function check(m, memo = new Map()) {
    const all = [], L = m.entities.length > 0, C = m.concepts.length > 0;
    const done = () => { all.push(...lib('StrataGov', './gov.js').check(m, memo)); const ack = new Set(m.ack || []); return { all, open: all.filter((w) => !ack.has(w.key)), acked: all.filter((w) => ack.has(w.key)) }; };
    const add = (kind, ref, level, text, go, fix) => all.push({ key: kind + ':' + ref, kind, level, text, go, ...(fix ? { fix } : {}) });
    brokenRefs(m, add);
    if (!L && !C) return done();
    const X = lookup(m, memo), R = SM.refs(m), bridges = via(m), eName = (id) => (X.ent.get(id) || {}).name, cName = (id) => (X.con.get(id) || {}).name;
    const sug = suggest(m, memo), sugT = new Map(sug.tables.map((x) => [x.tableId, x])), sugE = new Map(sug.entities.map((x) => [x.entityId, x]));
    if (L) {
      for (const t of m.tables) if (!ents(m, t, memo).length && mappable(m, t, bridges)) {
        const s = sugT.get(t.id);
        add('unmapped', R.tab.get(t.id), 'physical', `${R.tab.get(t.id)} is not mapped to an entity`, { kind: 'table', id: t.id }, s ? { label: `Map to ${eName(s.entityId)}`, entity: s.entityId } : null);
      }
      for (const e of m.entities) if (!tablesOf(m, e, memo).length) add('no-table', e.name, 'logical', `Entity ${e.name} is not realised by any table`, { kind: 'entity', id: e.id });
      const byId = new Map(m.tables.map((t) => [t.id, t])), lr2 = pairs(m.lrels), realised = new Set(); // entity pairs (and pair#label) linked by a physical relationship
      for (const r of physRels(m)) {
        const pe = ents(m, byId.get(r.p), memo), ce = ents(m, byId.get(r.c), memo);
        for (const a of pe) for (const b of ce) realised.add(a.id + '>' + b.id).add(a.id + '>' + b.id + '#' + low(r.name));
        if (!pe.length || !ce.length) continue; // an unmapped end (or a bridge table) is reported on its own
        const self = r.p === r.c;
        if (!self && pe.some((e) => ce.includes(e))) continue; // two tables of one entity: internal to it
        let hit = null;
        for (const a of pe) for (const b of ce) if (!hit && (!self || a === b)) hit = lr2(a.id, b.id, low(r.name));
        const label = `${R.tab.get(r.c)} → ${R.tab.get(r.p)}`;
        if (!hit) add('no-logical-rel', r.key, 'physical', `${label} (${r.card}) has no logical relationship ${pe[0].name} → ${ce[0].name}`, { kind: 'table', id: r.c }, { label: `Add ${pe[0].name} → ${ce[0].name}`, p: pe[0].id, c: ce[0].id, card: r.card, name: r.name, description: r.description });
        else if (hit.same && !fits(r.card, hit.r.cardinality)) add('cardinality', 'physical:' + r.key, 'physical', `${label} is ${r.card} but logical ${eName(hit.r.parentId)} → ${eName(hit.r.childId)} is ${hit.r.cardinality}`, { kind: 'table', id: r.c }, { label: `Use ${r.card} in the logical model`, rel: hit.r.id, list: 'lrels', card: r.card });
      }
      for (const lr of m.lrels) {
        const a = X.ent.get(lr.parentId), b = X.ent.get(lr.childId);
        if (!a || !b || !tablesOf(m, a, memo).length || !tablesOf(m, b, memo).length) continue; // "not realised by any table" already says it
        const one = (x, y) => (parallel(m.lrels, lr) && lr.name ? realised.has(x + '>' + y + '#' + low(lr.name)) || realised.has(x + '>' + y + '#') : realised.has(x + '>' + y)); // parallel relationships each need their own
        if (!one(a.id, b.id) && !one(b.id, a.id)) add('logical-rel-unrealised', a.name + '>' + b.name + (parallel(m.lrels, lr) && lr.name ? '#' + lr.name : ''), 'logical', `Logical ${a.name} → ${b.name}${lr.name ? ' (' + lr.name + ')' : ''} has no physical relationship`, { kind: 'entity', id: b.id });
      }
    }
    if (C) {
      for (const e of m.entities) if (!conceptOf(m, e, memo)) {
        const s = sugE.get(e.id);
        add('no-concept', e.name, 'logical', `Entity ${e.name} has no concept`, { kind: 'entity', id: e.id }, s ? { label: `Link to ${cName(s.conceptId)}`, concept: s.conceptId } : null);
      }
    }
    if (L && C) {
      for (const c of m.concepts) if (!entitiesOf(m, c, memo).length) add('no-entity', c.name, 'conceptual', `Concept ${c.name} has no logical entity`, { kind: 'concept', id: c.id });
      const cr2 = pairs(m.crels), linked = new Set(); // concept pairs (and pair#label) linked by a logical relationship
      for (const lr of m.lrels) {
        const a = X.ent.get(lr.parentId), b = X.ent.get(lr.childId), x = conceptOf(m, a, memo), y = conceptOf(m, b, memo);
        if (x && y) linked.add(x.id + '>' + y.id).add(x.id + '>' + y.id + '#' + low(lr.name));
        if (!x || !y || x === y) continue; // same concept: internal to it
        const hit = cr2(x.id, y.id, low(lr.name));
        if (!hit) add('no-conceptual-rel', a.name + '>' + b.name, 'logical', `Logical ${a.name} → ${b.name} has no conceptual relationship ${x.name} → ${y.name}`, { kind: 'entity', id: b.id }, { label: `Add ${x.name} → ${y.name}`, p: x.id, c: y.id, card: lr.cardinality, name: lr.name, description: lr.description });
        else if (hit.same && !fits(lr.cardinality, hit.r.cardinality)) add('cardinality', 'logical:' + a.name + '>' + b.name + (parallel(m.lrels, lr) && lr.name ? '#' + lr.name : ''), 'logical', `Logical ${a.name} → ${b.name} is ${lr.cardinality} but conceptual ${x.name} → ${y.name} is ${hit.r.cardinality}`, { kind: 'entity', id: b.id }, { label: `Use ${lr.cardinality} in the conceptual model`, rel: hit.r.id, list: 'crels', card: lr.cardinality });
      }
      for (const cr of m.crels) {
        const x = X.con.get(cr.parentId), y = X.con.get(cr.childId);
        if (!x || !y || !entitiesOf(m, x, memo).length || !entitiesOf(m, y, memo).length) continue;
        const one = (p, q) => (parallel(m.crels, cr) && cr.name ? linked.has(p + '>' + q + '#' + low(cr.name)) || linked.has(p + '>' + q + '#') : linked.has(p + '>' + q));
        if (x !== y && !one(x.id, y.id) && !one(y.id, x.id)) add('conceptual-rel-unrealised', x.name + '>' + y.name + (parallel(m.crels, cr) && cr.name ? '#' + cr.name : ''), 'conceptual', `Conceptual ${x.name} → ${y.name}${cr.name ? ' (' + cr.name + ')' : ''} has no logical relationship`, { kind: 'concept', id: y.id });
      }
    }
    const drops = (o, kind, ref, go) => effective(m, o, memo).dropped.forEach((d) => add('tag-dropped', `${kind}:${ref}:${d.name}`, kind === 'table' ? 'physical' : 'logical', `${ref} drops tag ${d.name} inherited from ${fromText(d.from)}`, go, { label: `Restore ${d.name}`, obj: go, tag: d.name }));
    m.tables.forEach((t) => drops(t, 'table', R.tab.get(t.id), { kind: 'table', id: t.id }));
    m.entities.forEach((e) => drops(e, 'entity', e.name, { kind: 'entity', id: e.id }));
    return done();
  }

  // apply a warning's one-click fix; returns false when it has none
  function applyFix(m, w, uid = SM.uid) {
    const f = w.fix;
    if (!f) return false;
    if (w.kind === 'unmapped') { const t = m.tables.find((x) => x.id === w.go.id); t.entityIds = [f.entity]; }
    else if (w.kind === 'no-concept') m.entities.find((e) => e.id === w.go.id).conceptId = f.concept;
    else if (w.kind === 'no-logical-rel') addMissingLogical(m, uid, new Set([w.key]));
    else if (w.kind === 'no-conceptual-rel') addMissingConceptual(m, uid, new Set([w.key]));
    else if (w.kind === 'cardinality') { const r = m[f.list].find((x) => x.id === f.rel); if (r) r.cardinality = f.card; }
    else if (w.kind === 'broken-ref') {
      if (f.drop) m.dangling = m.dangling.filter((d) => !(d.list === f.drop.list && (d.r || {}).parent === f.drop.parent && (d.r || {}).child === f.drop.child && ((d.r || {}).name || '') === f.drop.name));
      else if (f.entity) { const t = m.tables.find((x) => x.id === f.obj.id); t.broken.entity = t.broken.entity.filter((n) => n !== f.entity); if (!t.broken.entity.length) delete t.broken; }
      else if (f.concept) delete m.entities.find((x) => x.id === f.obj.id).broken;
    } else if (w.kind === 'tag-dropped') { const o = (f.obj.kind === 'table' ? m.tables : m.entities).find((x) => x.id === f.obj.id); o.tags = o.tags.filter((n) => n !== '-' + f.tag); }
    else return lib('StrataGov', './gov.js').applyFix(m, w);
    return true;
  }

  const api = { groups, order, impact, inScope, tablesOfConcept, view, effective, fromText, entityName, bestMatch, suggest, generate, mergeInto, remove, check, applyFix, KINDS, mappable, tablesOf, entitiesOf, conceptOf, entitiesOfTable: ents, hasLayers, crossHas, crossTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataAlign = api;
})(typeof window !== 'undefined' ? window : globalThis);
