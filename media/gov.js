// Governance (ADR-0038) and the semantic level (ADR-0037). Pure logic over the working model (media/model.js), no DOM.
// Three ideas: a TAG is a label that may bring policies; a POLICY is a rule with parents (a DAG: attaching a policy applies it and all its
// ancestors); COMMON PROPERTIES (owner, steward, classification, criticality, lifecycle) describe an object on its own level. Two directions
// (ADR-0041): what MANAGES the data (policies, owner, steward, criticality, lifecycle) is inherited down the containment of one level (physical:
// project > catalog > schema > table > column; conceptual: project > concept; logical: project > entity; semantic: project > metric) and through
// the realised-from links; the project holds a default per level. What the data IS (classification) is bottom-up: a column owns it, a table /
// schema / catalog / entity / concept / metric rolls up the highest of what it holds, and its own value is only a floor (never pushed down).
// Loaded by the webview, by node tests, the embeddings and the skill script.
(function (g) {
  'use strict';
  const SM = g.StrataModel || (typeof require === 'function' ? require('./model.js') : null);
  const lib = (n, f) => g[n] || require(f); // align.js / impact.js
  const SA = () => lib('StrataAlign', './align.js');

  const LEVELS = ['conceptual', 'logical', 'physical', 'semantic'];
  const COMMON = [
    { key: 'owner', label: 'Owner', type: 'person', hint: 'The one person, role or team accountable for it on this level' },
    { key: 'steward', label: 'Steward', type: 'person', hint: 'Looks after it day to day' },
    { key: 'classification', label: 'Classification', values: ['Public', 'Internal', 'Confidential', 'Restricted'], hint: 'How sensitive it is, lowest to highest' },
    { key: 'criticality', label: 'Criticality', values: ['Low', 'Medium', 'High', 'Critical'], hint: 'How important it is for the business' },
    { key: 'lifecycle', label: 'Lifecycle', values: ['Proposed', 'Active', 'Deprecated', 'Retired'], hint: 'Where it is in its life' },
  ];
  const POLICY_TYPES = ['business', 'regulatory', 'security', 'privacy', 'protection', 'retention', 'access', 'residency', 'quality'];
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  const rank = (d, v) => (d.values || []).findIndex((x) => x.toLowerCase() === String(v).toLowerCase());
  const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v));
  const CLS = COMMON.find((d) => d.key === 'classification');
  // own values in a fixed order, empties dropped (keys it does not know stay, at the end)
  function tidy(gv) {
    const order = [...COMMON.map((d) => d.key), 'policies', 'off', ...LEVELS], out = {};
    for (const k of [...order.filter((k) => k in gv), ...Object.keys(gv).filter((k) => !order.includes(k))]) if (!empty(gv[k]) && !(typeof gv[k] === 'object' && !Array.isArray(gv[k]) && !Object.keys(gv[k]).length)) out[k] = gv[k];
    return out;
  }

  // ---------- where an object sits: its kind, level and container on that level ----------
  // Kinds, containers, names, policies and tags of every object, for one pass over an unchanged model. `memo` is a Map the caller keeps for
  // that pass (reach and roots cache per object in it too); without one each call builds its own index.
  function index(m, memo) {
    const hit = memo && memo.get(index);
    if (hit) return hit;
    const p = m.project, kind = new Map(), up = new Map(), cat = new Map(m.catalogs.map((c) => [c.id, c])), sch = new Map(m.schemas.map((s) => [s.id, s]));
    if (p) kind.set(p, 'project');
    for (const [list, k] of [[m.metrics, 'metric'], [m.concepts, 'concept'], [m.entities, 'entity'], [m.catalogs, 'catalog']]) for (const x of list) { kind.set(x, k); up.set(x, p); }
    for (const s of m.schemas) { kind.set(s, 'schema'); up.set(s, (p && p.threePart && cat.get(s.catalogId)) || p); }
    for (const t of m.tables) { kind.set(t, t.kind === 'view' ? 'view' : 'table'); up.set(t, sch.get(t.schemaId) || p); for (const c of t.columns) { kind.set(c, 'column'); up.set(c, t); } }
    const down = new Map();
    for (const [x, c] of up) if (c && c !== p) { if (!down.has(c)) down.set(c, []); down.get(c).push(x); }
    // Domains (release 2, ADR-0045): optional, given as `m.domains` (the manifest's `domains`, attached to the loaded model by the host / CLI /
    // skill; never written by media/model.js). A synthetic object per domain, one level above the concepts it names in the management chain
    // (see `realisedFrom`): it is never part of `down` (classification's bottom-up roll-up, ADR-0041, never sees a domain).
    const domainOfConcept = new Map();
    for (const d of m.domains || []) {
      const dobj = { name: d.name, gov: { owner: d.owner, steward: d.steward, criticality: d.criticality, lifecycle: d.lifecycle, policies: d.policies } };
      kind.set(dobj, 'domain');
      for (const cn of d.concepts || []) { const c = m.concepts.find((y) => y.name === cn); if (c && !domainOfConcept.has(c)) domainOfConcept.set(c, dobj); }
    }
    const x = { R: SM.refs(m), kind, up, down, P: policyMap(m), tags: new Map(allTags(m).map((t) => [t.name, t])), domainOfConcept };
    if (memo) memo.set(index, x);
    return x;
  }
  // the domain a concept belongs to (its manifest group), or null: exported for the skill script and tests
  const domainOf = (m, c, memo = new Map()) => index(m, memo).domainOfConcept.get(c) || null;
  const kindOf = (m, o, memo) => index(m, memo).kind.get(o) || 'column';
  const LEVEL_OF = { concept: 'conceptual', entity: 'logical', metric: 'semantic', catalog: 'physical', schema: 'physical', table: 'physical', view: 'physical', column: 'physical', project: 'project' };
  const levelOf = (m, o, memo) => LEVEL_OF[kindOf(m, o, memo)];
  const containerOf = (m, o, memo) => (o === m.project ? null : index(m, memo).up.get(o));
  function nameOf(m, o, memo) {
    const R = index(m, memo).R, k = kindOf(m, o, memo);
    return k === 'schema' ? R.sch.get(o.id) : k === 'table' || k === 'view' ? R.tab.get(o.id) : k === 'column' ? R.col.get(o.id) : o.name;
  }
  const src = (m, o, memo) => ({ kind: kindOf(m, o, memo), name: nameOf(m, o, memo) });
  // The levels are linked (concept > entity > table, ADR-0032), so an object also takes what it is realised from (ADR-0040): a table or view
  // the entities it realises, an entity its concept, a concept its domain if any (release 2, R8: one more level above the concept, checked
  // after the concept's own value and before the project default). `realised` = all of them, nearest first.
  function realisedFrom(m, o, memo) {
    const k = kindOf(m, o, memo);
    if (k === 'table' || k === 'view') return SA().entitiesOfTable(m, o, memo);
    if (k === 'entity') { const c = SA().conceptOf(m, o, memo); return c ? [c] : []; }
    if (k === 'concept') { const d = domainOf(m, o, memo); return d ? [d] : []; }
    return [];
  }
  function realised(m, o, memo) {
    const out = [];
    for (let i = 0, q = [o]; i < q.length; i++) for (const p of realisedFrom(m, q[i], memo)) if (!out.includes(p)) { out.push(p); q.push(p); }
    return out;
  }
  // the object, everything above it on its level (project left out), then what those are realised from
  function chain(m, o, memo) {
    const out = [];
    for (let x = o; x && x !== m.project; x = containerOf(m, x, memo)) out.push(x);
    for (const x of [...out]) for (const p of realised(m, x, memo)) if (!out.includes(p)) out.push(p);
    return out;
  }
  const fromText = (f) => (!f ? '' : f.kind === 'project' ? (f.level ? `project (${f.level} default)` : 'project') : `${f.kind} ${f.name}`);

  // ---------- policies: a DAG through `parents` ----------
  // Once a project is split (release 2 part 2, ADR-0045 point 4), tag / policy definitions live in the project's governance.json, not in this
  // part's own file: attached to the working model as `m.sharedGovernance` the same way `m.domains` is (host / CLI / skill script; read-only
  // here, never written back by media/model.js). A project of one part never carries it, so every lookup below is exactly release 1 then.
  const allTags = (m) => [...((m.sharedGovernance || {}).tags || []), ...m.governance.tags];
  const allPolicies = (m) => [...((m.sharedGovernance || {}).policies || []), ...m.governance.policies]; // local wins a name clash (last in)
  const policyMap = (m) => new Map(allPolicies(m).map((p) => [p.name, p]));
  // the policy and all its ancestors: [[name, via]] (via = the policy that was attached, for the ancestors); cycle safe. Policies in
  // `off` are skipped with everything that is reached only through them.
  function ancestors(m, name, P = policyMap(m), off) {
    if (off && off.has(name)) return [];
    const out = [[name, null]], seen = new Set([name]);
    for (let i = 0; i < out.length; i++) for (const p of (P.get(out[i][0]) || {}).parents || []) if (!seen.has(p) && !(off && off.has(p))) { seen.add(p); out.push([p, name]); }
    return out;
  }
  // policies that have `name` among their ancestors (they bring it wherever they are attached)
  const descendants = (m, name, P = policyMap(m)) => allPolicies(m).filter((p) => p.name !== name && ancestors(m, p.name, P).some(([n]) => n === name)).map((p) => p.name);
  // parent cycles: each as a list of names, once
  function cycles(m) {
    const P = policyMap(m), out = [], keys = new Set();
    const walk = (n, path) => {
      const i = path.indexOf(n);
      if (i >= 0) { const c = path.slice(i), k = [...c].sort().join('|'); if (!keys.has(k)) { keys.add(k); out.push(c); } return; }
      if (!P.has(n)) return;
      for (const p of P.get(n).parents || []) walk(p, [...path, n]);
    };
    for (const p of allPolicies(m)) walk(p.name, []);
    return out;
  }

  // Where policies come from, before they are expanded: [{name, how, from}]. how: 'direct' (attached to it), 'tag' (a tag it carries brings
  // it, from = {kind:'tag', name}), 'inherited' (from above it on its level, from = where it was attached or which tag brought it there).
  function roots(m, o, memo) {
    const key = 'r', mm = memo.get(o) || {};
    if (mm[key]) return mm[key];
    const out = [], tagDefs = index(m, memo).tags;
    for (const n of (o.gov || {}).policies || []) out.push({ name: n, how: 'direct', from: null });
    for (const t of SA().effective(m, o, memo).tags) for (const n of (tagDefs.get(t.name) || {}).policies || []) out.push({ name: n, how: 'tag', from: { kind: 'tag', name: (tagDefs.get(t.name) || {}).displayName || t.name } });
    const c = containerOf(m, o, memo);
    if (c) for (const r of roots(m, c, memo)) out.push({ name: r.name, how: 'inherited', from: r.how === 'inherited' ? r.from : r.how === 'tag' ? { ...src(m, c, memo), tag: r.from.name } : src(m, c, memo) });
    for (const p of realised(m, o, memo)) for (const n of (p.gov || {}).policies || []) out.push({ name: n, how: 'inherited', from: src(m, p, memo) }); // only what is attached to them: tags cross levels through effective tags, and a dropped tag stays dropped
    memo.set(o, { ...(memo.get(o) || {}), [key]: out });
    return out;
  }
  // Policies switched off at the object or above it on its level: Map name -> where (null = on the object itself). ADR-0039: switching off a
  // policy removes it however it arrives (attached above, through a child policy, via a tag) and with it whatever arrives only through it
  // (its parents); a child policy that brings it stays on.
  function offOf(m, o, memo) {
    const mm = memo.get(o) || {};
    if (mm.off) return mm.off;
    const out = new Map();
    for (const x of chain(m, o, memo)) for (const n of (x.gov || {}).off || []) if (!out.has(n)) out.set(n, x === o ? null : src(m, x, memo));
    memo.set(o, { ...(memo.get(o) || {}), off: out });
    return out;
  }
  // Everything that applies to an object: [{name, how, from, via}] (via = the attached policy when this one is an ancestor of it). The first
  // way found wins (direct, tag, inherited).
  function reach(m, o, memo = new Map(), noOff) {
    const mm = memo.get(o) || {}, key = noOff ? 'all' : 'on';
    if (mm[key]) return mm[key];
    const out = [], seen = new Set(), P = index(m, memo).P, off = noOff ? null : new Set(offOf(m, o, memo).keys());
    for (const r of roots(m, o, memo)) for (const [n, via] of ancestors(m, r.name, P, off)) if (!seen.has(n)) { seen.add(n); out.push({ name: n, how: r.how, from: r.from, via }); }
    memo.set(o, { ...(memo.get(o) || {}), [key]: out });
    return out;
  }
  // policies that would reach the object but do not because of a switch-off: [{name, how: 'off', cause (the switched-off policy: itself, or
  // the one it came through), from (where that was switched off: null = here)}]
  function switchedOff(m, o, memo = new Map()) {
    const off = offOf(m, o, memo);
    if (!off.size) return [];
    const on = new Set(reach(m, o, memo).map((r) => r.name)), P = index(m, memo).P;
    return reach(m, o, memo, true).filter((r) => !on.has(r.name)).map((r) => {
      const cause = off.has(r.name) ? r.name : [...off.keys()].find((n) => ancestors(m, n, P).some(([a]) => a === r.name)) || r.name;
      return { name: r.name, how: 'off', cause, from: off.get(cause) || null };
    });
  }

  // ---------- classification: information about the data itself, bottom-up (ADR-0041) ----------
  const higher = (a, b) => !a || rank(CLS, b.v) > rank(CLS, a.v);
  // what sits below an object on its level: physical containment, entity > tables, concept > entities, metric > the columns and metrics it reads
  function below(m, o, memo) {
    const X = index(m, memo), k = X.kind.get(o);
    if (k === 'concept') return SA().entitiesOf(m, o, memo);
    if (k === 'entity') return SA().tablesOf(m, o, memo);
    if (k !== 'metric') return X.down.get(o) || [];
    if (!X.mx) { X.mx = { MX: SM.metricIndex(m), col: new Map(), met: new Map(m.metrics.map((y) => [y.id, y])) }; for (const t of m.tables) for (const c of t.columns) X.mx.col.set(c.id, c); }
    const r = SM.metricRefs(m, o, X.mx.MX);
    return [...[...r.columns].map((id) => X.mx.col.get(id)), ...[...r.metrics].map((id) => X.mx.met.get(id))].filter(Boolean);
  }
  // The object's OWN classification {v, from}: its declared value (from null); on a column also raised by the minimum of the policies attached
  // to it or brought by its own tags (from = {kind:'policy'}): a policy attached higher up governs how the data is managed, it does not
  // classify it. Nothing arrives from above: policies and tags inherited from a container or a realised parent do not count.
  function ownClass(m, o, memo) {
    const declared = (o.gov || {}).classification, X = index(m, memo);
    let best = !empty(declared) && rank(CLS, declared) >= 0 ? { v: declared, from: null } : undefined;
    if (X.kind.get(o) !== 'column') return best;
    const off = new Set(offOf(m, o, memo).keys()), names = [...((o.gov || {}).policies || [])];
    for (const t of o.tags || []) if (t[0] !== '-') names.push(...((X.tags.get(t) || {}).policies || []));
    for (const n of names) for (const [a] of ancestors(m, n, X.P, off)) {
      const c = (X.P.get(a) || {}).classification;
      if (c && rank(CLS, c) >= 0 && higher(best, { v: c })) best = { v: c, from: { kind: 'policy', name: a } };
    }
    return best;
  }
  // {own, rolled}: rolled = the highest of the own value and everything below it (`from` = the object that holds it, null when it is the object's
  // own declared value, a policy when that raised it); an object that has nothing takes the project's default for its level.
  function classify(m, o, memo = new Map()) {
    let C = memo.get(classify);
    if (!C) memo.set(classify, C = new Map());
    if (C.has(o)) return C.get(o);
    C.set(o, {}); // a metric that reads itself sees nothing
    const lv = levelOf(m, o, memo), own = ownClass(m, o, memo);
    let top = own && { ...own };
    for (const x of below(m, o, memo)) { const r = classify(m, x, memo).rolled; if (r && higher(top, r)) top = { v: r.v, from: r.from && r.from.kind !== 'policy' ? r.from : src(m, x, memo) }; }
    if (!top && lv !== 'project' && !empty(((m.project.gov || {})[lv] || {}).classification)) top = { v: m.project.gov[lv].classification, from: { kind: 'project', name: m.project.name, level: lv } };
    const r = { own, rolled: top };
    C.set(o, r);
    return r;
  }

  // Effective common properties {key: {v, from}}: own, else the nearest container on the same level, else what the object is realised from
  // (entities, concepts; the highest criticality when several entities have one), else the project's default for the level. Classification
  // is not inherited but rolled up (classify): the highest of its own value and what it holds.
  function effective(m, o, memo = new Map()) {
    const lv = levelOf(m, o, memo), out = {}, ch = chain(m, o, memo);
    for (const d of COMMON) {
      if (d === CLS) continue;
      let x = ch.find((y) => !empty((y.gov || {})[d.key]));
      if (x && x !== o && kindOf(m, x, memo) === 'entity' && d.key === 'criticality') x = ch.filter((y) => kindOf(m, y, memo) === 'entity' && !empty((y.gov || {})[d.key])).reduce((a, b) => (rank(d, b.gov[d.key]) > rank(d, a.gov[d.key]) ? b : a));
      if (x) out[d.key] = { v: x.gov[d.key], from: x === o ? null : src(m, x, memo) };
      else if (o !== m.project && !empty(((m.project.gov || {})[lv] || {})[d.key])) out[d.key] = { v: m.project.gov[lv][d.key], from: { kind: 'project', name: m.project.name, level: lv } };
    }
    if (lv !== 'project') { const r = classify(m, o, memo).rolled; if (r) out.classification = r; }
    return out;
  }

  // every object that can carry governance: {o, kind, level, ref (warning keys), label, go (where to jump)}
  function objects(m, memo) {
    const R = index(m, memo).R, out = [];
    const add = (o, kind, ref, label, go) => out.push({ o, kind, level: LEVEL_OF[kind], ref, label, go });
    if (m.project) add(m.project, 'project', 'project', 'Project ' + m.project.name, { kind: 'project' });
    for (const c of m.concepts) add(c, 'concept', 'concept:' + c.name, 'Concept ' + c.name, { kind: 'concept', id: c.id });
    for (const e of m.entities) add(e, 'entity', 'entity:' + e.name, 'Entity ' + e.name, { kind: 'entity', id: e.id });
    for (const c of m.catalogs) add(c, 'catalog', 'catalog:' + c.name, 'Catalog ' + c.name, { kind: 'catalog', id: c.id });
    for (const s of m.schemas) add(s, 'schema', 'schema:' + R.sch.get(s.id), 'Schema ' + R.sch.get(s.id), { kind: 'schema', id: s.id });
    for (const t of m.tables) {
      add(t, t.kind === 'view' ? 'view' : 'table', R.tab.get(t.id), R.tab.get(t.id), { kind: 'table', id: t.id });
      for (const c of t.columns) add(c, 'column', R.col.get(c.id), R.col.get(c.id), { kind: 'table', id: t.id, column: c.name });
    }
    for (const x of m.metrics) add(x, 'metric', 'metric:' + x.name, 'Metric ' + x.name, { kind: 'metric', id: x.id });
    return out;
  }

  // For one policy: every object it reaches and how (for the list counts and the graph). [{x (from objects()), how, from, via}]
  function coverage(m, name, objs = objects(m), memo = new Map()) {
    const out = [];
    for (const x of objs) { const r = reach(m, x.o, memo).find((p) => p.name === name) || switchedOff(m, x.o, memo).find((p) => p.name === name); if (r) out.push({ x, ...r }); }
    return out;
  }

  // ---------- warnings (Alignment panel; same keys and Accept as ADR-0032) ----------
  const KINDS = {
    'gov-protection': 'Restricted data without a protection policy',
    'gov-class-below-floor': 'Items classified below the minimum of what contains them',
    'gov-owner': 'High or critical items without an owner on their level',
    'gov-retired': 'Retired items still in use',
    'metric-ref': 'Metrics that reference something missing',
    'policy-cycle': 'Policies that are their own ancestor',
    'gov-unknown': 'Unknown policies or tags',
    'gov-off': 'Policies switched off lower down',
    'domain-dup': 'Domain names defined more than once',
    'domain-multi': 'Concepts listed in more than one domain',
    'cross-part-dup': 'Metric or entity names defined in more than one part',
  };
  // Whether a metric's missing reference (a qualified column/table, or a grain entry) resolves in another part of the same split project:
  // `m.crossPart` (ADR-0045 point 6, see media/align.js's crossHas for the sibling check on broken-ref). A one-part project never carries it.
  function crossResolves(m, q) {
    const X = m.crossPart;
    if (!X) return false;
    if (q.kind === 'metric') return X.metrics.includes(String(q.ref).trim().toLowerCase());
    const s = String(q.ref).replace(/\s+/g, '').toLowerCase(), hit = (arr, x) => arr.some((full) => full === x || full.endsWith('.' + x));
    if (q.kind === 'column') return hit(X.columns, s);
    // kind 'table': SM.metricRefs gives the WHOLE chain (table.column) here whenever even the table part does not resolve locally, so a
    // reference to another part's column reads as a "missing table", not a "missing column" — check both readings
    return hit(X.columns, s) || hit(X.tables, s.split('.').slice(0, -1).join('.'));
  }
  const crossGrain = (m, gr) => { const X = m.crossPart, s = String(gr).trim().toLowerCase(); return !!X && (X.entities.includes(s) || X.tables.some((t) => t === s || t.endsWith('.' + s))); };
  function check(m, memo = new Map()) {
    const all = [], { R, P } = index(m, memo), eff = new Map();
    const add = (kind, ref, level, text, go, fix) => all.push({ key: kind + ':' + ref, kind, level, text, go, ...(fix ? { fix } : {}) });
    const E = (o) => { if (!eff.has(o)) eff.set(o, effective(m, o, memo)); return eff.get(o); };
    const lvl = (x) => (x.level === 'project' ? 'governance' : x.level);
    const objs = objects(m, memo), tagNames = new Set(allTags(m).map((t) => t.name));
    for (const x of objs) {
      for (const n of (x.o.gov || {}).policies || []) if (!P.has(n)) add('gov-unknown', `${x.ref}:${n}`, lvl(x), `${x.label} links to policy "${n}", which is not defined`, x.go);
      for (const n of (x.o.gov || {}).off || []) {
        if (!P.has(n)) add('gov-unknown', `${x.ref}:off:${n}`, lvl(x), `${x.label} switches off policy "${n}", which is not defined`, x.go);
        else add('gov-off', `${x.ref}:${n}`, lvl(x), reach(m, x.o, memo, true).some((r) => r.name === n) ? `${n} is switched off on ${x.label.replace(/^(Concept|Entity|Metric|Schema|Catalog|Project) /, (w) => w.toLowerCase())}` : `${n} is switched off on ${x.label} but does not reach it`, x.go, { label: `Switch ${n} on again`, off: n, ref: x.ref });
      }
      for (const t of x.o.tags || []) { const n = t.replace(/^-/, ''); if (!tagNames.has(n)) add('gov-unknown', `${x.ref}:#${n}`, lvl(x), `${x.label} carries tag "${n}", which is not defined`, x.go); }
      if (['concept', 'entity', 'table', 'view', 'metric'].includes(x.kind)) {
        const e = E(x.o);
        if (e.criticality && rank(COMMON[3], e.criticality.v) >= 2 && !e.owner) add('gov-owner', x.ref, lvl(x), `${x.label} is ${e.criticality.v}${e.criticality.from ? ` (from ${fromText(e.criticality.from)})` : ''} but has no ${x.level} owner`, x.go);
      }
    }
    for (const t of allTags(m)) for (const n of t.policies || []) if (!P.has(n)) add('gov-unknown', `tag:${t.name}:${n}`, 'governance', `Tag ${t.displayName || t.name} brings policy "${n}", which is not defined`, { kind: 'policy', name: n });
    for (const p of allPolicies(m)) for (const n of p.parents || []) if (!P.has(n)) add('gov-unknown', `policy:${p.name}:${n}`, 'governance', `Policy ${p.name} names parent "${n}", which is not defined`, { kind: 'policy', name: p.name });
    // Domains (release 2, R16): a duplicate name, a concept in more than one, an unknown policy named on one.
    const domCount = new Map(), domConcept = new Map();
    for (const d of m.domains || []) {
      for (const n of d.policies || []) if (!P.has(n)) add('gov-unknown', `domain:${d.name}:${n}`, 'governance', `Domain ${d.name} links to policy "${n}", which is not defined`, { kind: 'project' });
      const k = String(d.name).toLowerCase();
      domCount.set(k, (domCount.get(k) || 0) + 1);
      for (const cn of d.concepts || []) { if (!domConcept.has(cn)) domConcept.set(cn, []); domConcept.get(cn).push(d.name); }
    }
    for (const [k, n] of domCount) if (n > 1) add('domain-dup', k, 'governance', `Domain "${k}" is defined more than once`, { kind: 'project' });
    for (const [cn, ds] of domConcept) if (ds.length > 1) { const c = m.concepts.find((y) => y.name === cn); add('domain-multi', cn, 'conceptual', `Concept ${cn} is listed in more than one domain (${ds.join(', ')})`, c ? { kind: 'concept', id: c.id } : { kind: 'project' }); }
    // Restricted physical data needs a policy of type protection. Reported where the classification is the object's OWN (declared, or by a
    // policy or tag on it): a container that only rolls it up is not asked again.
    const guarded = (o) => reach(m, o, memo).some((r) => /protect/i.test((P.get(r.name) || {}).type || ''));
    const PHYS = new Set(['catalog', 'schema', 'table', 'view', 'column']), lab = new Map(objs.map((x) => [x.o, x.label])), own = (o) => classify(m, o, memo).own;
    for (const x of objs) if (PHYS.has(x.kind)) {
      const c = own(x.o);
      if (c && rank(CLS, c.v) >= CLS.values.length - 1 && !guarded(x.o)) add('gov-protection', x.ref, 'physical', `${x.label} is ${c.v}${c.from ? ` (by policy ${c.from.name})` : ''} but no policy of type protection (masking, encryption) covers it`, x.go);
    }
    // A container's own classification is a floor for what it holds, never passed down: a column classified lower than a container's floor is
    // reported, not overwritten (a column with no value is simply unclassified)
    for (const x of objs) {
      const c = x.kind === 'column' ? own(x.o) : null;
      if (!c) continue;
      let top = null;
      for (let u = containerOf(m, x.o, memo); u && u !== m.project; u = containerOf(m, u, memo)) { const f = own(u); if (f && rank(CLS, f.v) > rank(CLS, c.v) && (!top || rank(CLS, f.v) > rank(CLS, top.f.v))) top = { u, f }; }
      if (top) add('gov-class-below-floor', x.ref, lvl(x), `${x.label} is ${c.v}, below the ${top.f.v} minimum of ${lab.get(top.u).replace(/^(Concept|Entity|Metric|Schema|Catalog) /, (w) => w.toLowerCase())} (a minimum is not passed down)`, x.go);
    }
    // Retired, but something that is not retired still uses it
    const gone = (o) => { const l = E(o).lifecycle; return !!l && /^retired$/i.test(l.v); };
    const reads = lib('StrataImpact', './impact.js').graph(m).reads, MX = SM.metricIndex(m), refs = new Map(m.metrics.map((x) => [x.id, SM.metricRefs(m, x, MX)]));
    const warn = (o, ref, level, label, go, users) => { const u = users.filter((x) => !gone(x.o)); if (u.length) add('gov-retired', ref, level, `${label} is retired but still used by ${u.slice(0, 3).map((x) => x.n).join(', ')}${u.length > 3 ? ` and ${u.length - 3} more` : ''}`, go); };
    for (const t of m.tables) if (gone(t)) warn(t, R.tab.get(t.id), 'physical', R.tab.get(t.id), { kind: 'table', id: t.id }, [
      ...m.tables.filter((x) => x !== t && x.columns.some((c) => c.foreignKey && c.foreignKey.tableId === t.id)).map((x) => ({ o: x, n: R.tab.get(x.id) })),
      ...[...reads].filter(([, r]) => r.tables.has(t.id)).map(([vid]) => ({ o: m.tables.find((x) => x.id === vid), n: R.tab.get(vid) })),
      ...m.metrics.filter((x) => refs.get(x.id).tables.has(t.id)).map((x) => ({ o: x, n: 'metric ' + x.name }))]);
    for (const x of m.metrics) if (gone(x)) warn(x, 'metric:' + x.name, 'semantic', 'Metric ' + x.name, { kind: 'metric', id: x.id }, m.metrics.filter((y) => refs.get(y.id).metrics.has(x.id)).map((y) => ({ o: y, n: 'metric ' + y.name })));
    // metrics: every qualified name and grain must resolve
    for (const x of m.metrics) {
      const go = { kind: 'metric', id: x.id };
      for (const q of refs.get(x.id).missing) if (!crossResolves(m, q)) add('metric-ref', `${x.name}:${q.ref}`, 'semantic', `Metric ${x.name} uses ${q.kind} ${q.kind === 'metric' ? '{' + q.ref + '}' : q.ref}, which does not exist`, go);
      for (const gr of x.grain || []) if (!grainOf(m, gr, R) && !crossGrain(m, gr)) add('metric-ref', `${x.name}:grain:${gr}`, 'semantic', `Metric ${x.name} has grain "${gr}", which is neither an entity nor a table`, go);
    }
    // Project-wide uniqueness once a project has more than one part (R11): a metric or entity name defined in more than one part
    // (`m.crossPart.duplicates`, lib/project.js#buildIndex). Reported once per part that holds one (the object at hand, when it is here).
    for (const d of (m.crossPart || {}).duplicates || []) {
      const here = d.kind === 'metric' ? m.metrics.find((x) => x.name.toLowerCase() === d.name) : m.entities.find((x) => x.name.toLowerCase() === d.name);
      if (here) add('cross-part-dup', `${d.kind}:${d.name}`, d.kind === 'metric' ? 'semantic' : 'logical', `${d.kind === 'metric' ? 'Metric' : 'Entity'} "${d.name}" is defined in more than one part (${d.parts.join(', ')})`, { kind: d.kind, id: here.id });
    }
    for (const c of cycles(m)) {
      const a = c[c.length - 1], b = c[0]; // a names b as a parent and closes the loop
      add('policy-cycle', [...c].sort().join('>'), 'governance', `Policy cycle: ${[...c, c[0]].join(' → ')} (each names the next as its parent)`, { kind: 'policy', name: c[0] }, { label: `Remove ${b} from the parents of ${a}`, policy: a, parent: b });
    }
    return all;
  }
  function applyFix(m, w) {
    if (w.kind === 'gov-off' && w.fix) { const x = objects(m).find((y) => y.ref === w.fix.ref); if (x) x.o.gov = tidy({ ...x.o.gov, off: (x.o.gov.off || []).filter((n) => n !== w.fix.off) }); return !!x; }
    if (w.kind !== 'policy-cycle' || !w.fix) return false;
    const p = m.governance.policies.find((x) => x.name === w.fix.policy);
    if (p) p.parents = (p.parents || []).filter((n) => n !== w.fix.parent);
    return !!p;
  }

  // ---------- semantic level: what the canvas draws, shaped like the working model (like SA.view for concepts / entities) ----------
  // Metrics get transient drawing fields: layer 'metric', schemaId of the metrics frame and `columns` = one input row per column or metric
  // their calculation reads (ref = {tableId, columnId}; a metric input has columnId null). The tables they read are drawn as they are.
  const AGG = { sum: 'SUM', count: 'COUNT', count_distinct: 'COUNT DISTINCT', avg: 'AVG', min: 'MIN', max: 'MAX', none: 'non-additive' };
  const AGG_SHORT = { sum: 'SUM', count: 'COUNT', count_distinct: 'DISTINCT', avg: 'AVG', min: 'MIN', max: 'MAX', none: 'RATIO' }; // card badges
  function semView(m) {
    const frame = { id: '_metrics', name: 'Semantic layer', catalogId: null }, used = new Set(), MX = SM.metricIndex(m);
    for (const x of m.metrics) {
      const r = SM.metricRefs(m, x, MX), rows = [];
      for (const t of m.tables) for (const c of t.columns) if (r.columns.has(c.id)) { used.add(t.id); rows.push({ id: `mi:${x.id}:${c.id}`, name: c.name, dataType: t.name, ref: { tableId: t.id, columnId: c.id }, foreignKey: { tableId: t.id, columnId: c.id } }); }
      for (const y of m.metrics) if (r.metrics.has(y.id)) rows.push({ id: `mi:${x.id}:${y.id}`, name: `{${y.name}}`, dataType: 'metric', ref: { tableId: y.id, columnId: null }, foreignKey: { tableId: y.id, columnId: null } });
      Object.assign(x, { layer: 'metric', schemaId: frame.id, columns: rows });
    }
    const tables = m.tables.filter((t) => used.has(t.id)), sch = new Set(tables.map((t) => t.schemaId));
    return { project: m.project, catalogs: [], governance: m.governance, layer: 'metric', schemas: [...(m.metrics.length ? [frame] : []), ...m.schemas.filter((x) => sch.has(x.id))], tables: [...m.metrics, ...tables], relations: [] };
  }
  // metrics that use a table, a column or another metric (directly)
  function usedBy(m, kind, id) {
    const MX = SM.metricIndex(m);
    return m.metrics.filter((x) => { const r = SM.metricRefs(m, x, MX); return kind === 'metric' ? r.metrics.has(id) : kind === 'column' ? r.columns.has(id) : r.tables.has(id); });
  }
  // a metric's grain: an entity name, else a table ref (full, schema.table or a unique table name)
  function grainOf(m, gr, R = SM.refs(m)) {
    const s = String(gr).toLowerCase();
    const e = m.entities.find((x) => x.name.toLowerCase() === s);
    if (e) return { kind: 'entity', o: e };
    const ts = m.tables.filter((t) => { const r = R.tab.get(t.id).toLowerCase(); return r === s || r.endsWith('.' + s); });
    return ts.length === 1 ? { kind: 'table', o: ts[0] } : null;
  }

  const api = { LEVELS, COMMON, POLICY_TYPES, KINDS, AGG, AGG_SHORT, rank, show, tidy, nameOf, fromText, ancestors, descendants, cycles, reach, switchedOff, effective, classify, objects, coverage, check, applyFix, semView, usedBy, domainOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataGov = api;
})(typeof window !== 'undefined' ? window : globalThis);
