(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const NS = 'http://www.w3.org/2000/svg';

  const KINDS = [['all', 'All'], ['concept', 'Concept'], ['entity', 'Entity'], ['catalog', 'Catalog'], ['schema', 'Schema'], ['table', 'Table / view'], ['column', 'Column'], ['relationship', 'Relationship'], ['metric', 'Metric'], ['tag', 'Tag'], ['property', 'Property / governance'], ['policy', 'Policy']];
  const q = Object.assign(document.createElement('input'), { id: 'q', placeholder: 'Search…', title: 'Search (Cmd/Ctrl+F)' });
  const kind = document.createElement('select');
  kind.id = 'kind';
  kind.title = 'What to search';
  for (const [v, l] of KINDS) kind.append(Object.assign(document.createElement('option'), { value: v, textContent: l }));
  const tree = Object.assign(document.createElement('div'), { id: 'tree' });
  const head = document.createElement('div');
  head.id = 'head';
  const reset = Object.assign(document.createElement('button'), { id: 'reset', textContent: '⟲', title: 'Reset: clear the collapsed / expanded state and every "View more"', onclick: () => { open.clear(); shut.clear(); more.clear(); render(); } });
  head.append(q, kind, reset);
  app.append(head, tree);

  let F = null; // the parsed .model.json (Strata 2 file format); kept when the text is briefly invalid
  let invalid = false; // the current text does not parse: F is the last valid state
  let fileName = '';
  const open = new Set(); // expanded node keys
  const shut = new Set(); // collapsed sections
  const more = new Set(); // lists expanded past MAX items ("View N more")
  const MAX = 10;
  // per model, the expanded / collapsed state is kept in .strata/layout.json (the host reads and writes it)
  let layoutKey = null, lastSig = '', saveT = null;
  const sig = () => JSON.stringify([[...open].sort(), [...shut].sort(), [...more].sort()]);
  const applyLayout = (L) => { open.clear(); shut.clear(); more.clear(); ((L || {}).open || []).forEach((k) => open.add(k)); ((L || {}).shut || []).forEach((k) => shut.add(k)); ((L || {}).more || []).forEach((k) => more.add(k)); lastSig = sig(); };
  function persist() {
    if (layoutKey == null || sig() === lastSig) return;
    lastSig = sig();
    clearTimeout(saveT);
    saveT = setTimeout(() => vscode.postMessage({ type: 'layout', part: 'nav', state: { open: [...open], shut: [...shut], more: [...more] } }), 400);
  }

  const ICONS = {
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
    view: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    catalog: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    schema: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    rel: '<circle cx="5.5" cy="12" r="2.5"/><circle cx="18.5" cy="12" r="2.5"/><path d="M8 12h8"/>',
    concept: '<rect x="2.5" y="6" width="19" height="12" rx="6"/><path d="M8 12h8"/>',
    entity: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M8 13.5h8M8 16.5h5"/>',
    project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    policy: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    metric: '<path d="M17 5H7l6 7-6 7h10"/>',
  };
  function ico(name) {
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'ico' })) s.setAttribute(k, v);
    s.innerHTML = ICONS[name];
    return s;
  }
  const el = (cls, ...kids) => { const e = document.createElement('div'); e.className = cls; e.append(...kids.filter((k) => k != null)); return e; };
  const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
  const cmp = (a, b) => a.localeCompare(b);
  const hoverOf = (o, ...more) => [o.displayName, o.description, ...more].filter(Boolean).join('\n');

  // ---- search ----
  const term = () => q.value.trim().toLowerCase();
  const K = () => kind.value;
  const filtering = () => !!term() || K() !== 'all';
  const inc = (texts) => texts.some((x) => x && String(x).toLowerCase().includes(term()));
  const kindOn = (k) => K() === 'all' || K() === k;
  const hit = (k, texts) => kindOn(k) && (!term() || inc(texts));
  const tagTexts = (o) => (o.tags || []).flatMap((n) => { const d = ((F.governance || {}).tags || []).find((t) => t.name === n); return [n, d && d.displayName]; });
  const govText = (v) => (Array.isArray(v) ? v.join(', ') : String(v));
  const propTexts = (o) => [...Object.entries(o.properties || {}).flat(), ...Object.entries(o.governance || {}).flatMap(([k, v]) => [k, govText(v)])]; // properties and governance values
  // an object matches by its own name, by an attached tag, or by a user-defined property
  function objHit(k, o, names) {
    if (hit(k, names)) return true;
    const byText = K() === 'all' && !!term();
    if ((K() === 'tag' || byText) && (o.tags || []).length && (!term() || inc(tagTexts(o)))) return true;
    if ((K() === 'property' || byText) && propTexts(o).length && (!term() || inc(propTexts(o)))) return true;
    return false;
  }

  function label(text, sub, cls) {
    const t = term();
    const s = span('n' + (cls ? ' ' + cls : ''), '');
    const i = t ? text.toLowerCase().indexOf(t) : -1;
    if (i < 0) s.textContent = text;
    else { const m = document.createElement('mark'); m.textContent = text.slice(i, i + t.length); s.append(text.slice(0, i), m, text.slice(i + t.length)); }
    if (sub) s.append(' ', span('sub', sub));
    return s;
  }

  // one tree row; `kids` is a function returning rows, only called when expanded
  function row(depth, key, icon, lbl, right, onClick, kids, forceOpen, hover) {
    const isOpen = kids && (open.has(key) || forceOpen);
    const r = el('r');
    r.style.paddingLeft = 8 + depth * 14 + 'px';
    if (hover) r.title = hover;
    r.append(span('arrow', kids ? (isOpen ? '▾' : '▸') : ''), icon ? ico(icon) : span('ico', ''), lbl, right ? span('ty', right) : null);
    r.addEventListener('click', () => {
      if (kids) { if (open.has(key)) open.delete(key); else open.add(key); }
      if (onClick) onClick();
      render();
    });
    return isOpen ? [r, ...kids()] : [r];
  }

  function section(title, count, body) {
    const closed = shut.has(title);
    const h = el('sec', span('arrow', closed ? '▸' : '▾'), span('st', title), span('cnt', String(count)));
    h.addEventListener('click', () => { if (closed) shut.delete(title); else shut.add(title); render(); });
    return [h, ...(closed ? [] : body)];
  }

  const go = (k, ref, column) => () => vscode.postMessage({ type: 'reveal', kind: k, ref, column });

  // a list of sibling items (each one row or an array of rows): the first MAX, then "View N more" / "Show fewer". While searching, everything is shown.
  function capped(items, key, depth) {
    if (filtering() || items.length <= MAX) return items.flat();
    const all = more.has(key), b = el('r morebtn', span('arrow', ''), span('more', all ? 'Show fewer' : `View ${items.length - MAX} more`));
    b.style.paddingLeft = 8 + depth * 14 + 'px';
    b.title = all ? `Show only the first ${MAX} of ${items.length}` : `Show all ${items.length} items`;
    b.addEventListener('click', () => { if (all) more.delete(key); else more.add(key); render(); });
    return [...(all ? items : items.slice(0, MAX)).flat(), b];
  }

  // Project > catalog (when 3-part naming) > schema > table/view > column, everything sorted
  function hierarchy() {
    const P = F.project, three = P.naming === 'catalog.schema.table';
    const schemaRef = (s) => (s.catalog ? s.catalog + '.' : '') + s.name;
    const tables = F.tables || [];
    const fkCols = new Set((F.relationships || []).map((r) => r.child));
    const f = filtering();

    const tableRows = (t, depth) => {
      const ref = t.schema + '.' + t.name;
      const cols = [...(t.columns || [])].sort((a, b) => cmp(a.name, b.name));
      const own = objHit('table', t, [ref, t.displayName]);
      const colHits = cols.filter((c) => objHit('column', c, [c.name, c.displayName, c.type]));
      if (f && !own && !colHits.length) return null;
      const shown = f && !own ? colHits : (f && K() !== 'all' && K() !== 'column' ? [] : cols);
      return row(depth, 'T:' + ref, t.kind === 'view' ? 'view' : 'table', label(t.name, t.displayName), t.kind === 'view' ? (t.viewType || 'view') : String(cols.length), go('table', ref),
        () => capped(shown.map((c) => {
          const k = c.pk ? 'PK' : fkCols.has(ref + '.' + c.name) ? 'FK' : '';
          const r = el('r c', span('k' + (c.pk ? '' : ' f'), k), label(c.name, c.displayName), span('ty', c.type || ''));
          r.title = hoverOf(c, (c.tags || []).length ? 'Tags: ' + c.tags.join(', ') : '') || `${c.name} ${c.type || ''}`;
          r.style.paddingLeft = 8 + (depth + 1) * 14 + 'px';
          r.addEventListener('click', go('column', ref, c.name));
          return r;
        }), 'T:' + ref, depth + 1), f && colHits.length > 0, hoverOf(t, (t.tags || []).length ? 'Tags: ' + t.tags.join(', ') : '', t.kind === 'view' && t.definition ? '\n' + t.definition.slice(0, 240) : ''));
    };

    const schemaRows = (s, depth) => {
      const ref = schemaRef(s);
      const ts = tables.filter((t) => t.schema === ref).sort((a, b) => cmp(a.name, b.name));
      const own = objHit('schema', s, [s.name, s.displayName]);
      const kids = ts.map((t) => tableRows(t, depth + 1)).filter(Boolean);
      if (f && !own && !kids.length) return null;
      return row(depth, 'S:' + ref, 'schema', label(s.name, s.displayName), String(ts.length), go('schema', ref), () => capped(kids, 'S:' + ref, depth + 1), f && kids.length > 0, hoverOf(s));
    };

    let body;
    if (three) {
      body = [...(F.catalogs || [])].sort((a, b) => cmp(a.name, b.name)).map((c) => {
        const ss = (F.schemas || []).filter((s) => s.catalog === c.name).sort((a, b) => cmp(a.name, b.name));
        const own = objHit('catalog', c, [c.name, c.displayName]);
        const kids = ss.map((s) => schemaRows(s, 2)).filter(Boolean);
        if (f && !own && !kids.length) return null;
        return row(1, 'C:' + c.name, 'catalog', label(c.name, c.displayName), String(ss.length), go('catalog', c.name), () => capped(kids, 'C:' + c.name, 2), f && kids.length > 0, hoverOf(c));
      }).filter(Boolean);
    } else body = [...(F.schemas || [])].sort((a, b) => cmp(a.name, b.name)).map((s) => schemaRows(s, 1)).filter(Boolean);
    return row(0, 'P', 'project', label(P.name), P.technology, go('project', ''), () => capped(body, 'P', 1), true, hoverOf(P, `${P.technology} · ${P.methodology}`));
  }

  // conceptual > logical > physical (ADR-0032): concept -> its entities -> the tables that realise them
  function layers() {
    const cs = [...((F.conceptual || {}).concepts || [])].sort((a, b) => cmp(a.name, b.name)), es = [...((F.logical || {}).entities || [])].sort((a, b) => cmp(a.name, b.name));
    if (!cs.length && !es.length) return [];
    const f = filtering();
    const entRows = (e, depth) => {
      const ts = (F.tables || []).filter((t) => [].concat(t.entity || []).includes(e.name)).map((t) => ({ t, ref: t.schema + '.' + t.name })).sort((a, b) => cmp(a.ref, b.ref));
      const own = objHit('entity', e, [e.name, e.description]);
      const kids = ts.filter(({ t, ref }) => !f || own || hit('table', [ref, t.displayName]));
      if (f && !own && !kids.length) return null;
      return row(depth, 'E:' + e.name, 'entity', label(e.name), String(ts.length), go('entity', e.name), () => kids.map(({ t, ref }) => {
        const r = el('r c'); r.style.paddingLeft = 8 + (depth + 1) * 14 + 'px'; r.append(ico(t.kind === 'view' ? 'view' : 'table'), label(ref)); r.title = hoverOf(t); r.addEventListener('click', go('table', ref)); return r;
      }), f && kids.length > 0, hoverOf(e, e.concept ? 'Concept: ' + e.concept : ''));
    };
    const groups = cs.map((c) => {
      const kids = es.filter((e) => e.concept === c.name).map((e) => entRows(e, 2)).filter(Boolean), own = objHit('concept', c, [c.name, c.description]);
      if (f && !own && !kids.length) return null;
      return row(1, 'K:' + c.name, 'concept', label(c.name), String(es.filter((e) => e.concept === c.name).length), go('concept', c.name), () => capped(kids, 'K:' + c.name, 2), f && kids.length > 0, hoverOf(c));
    }).filter(Boolean);
    const loose = es.filter((e) => !cs.some((c) => c.name === e.concept)).map((e) => entRows(e, 1)).filter(Boolean); // entities without a concept
    if (f && !groups.length && !loose.length) return [];
    return section('Concepts and entities', `${cs.length} / ${es.length}`, capped([...groups, ...loose], 'Layers', 1));
  }

  function relationships() {
    const all = F.relationships || [];
    const rels = [...all].sort((a, b) => cmp(a.parent + a.child, b.parent + b.child)).filter((r) => hit('relationship', [r.parent, r.child, r.name, r.description, r.cardinality]));
    if (filtering() && !rels.length) return [];
    const rows = rels.map((r) => {
      const r0 = el('r rel');
      r0.style.paddingLeft = '22px';
      r0.append(ico('rel'), label(`${r.child} → ${r.parent}`), span('ty', r.cardinality));
      r0.title = [r.name, r.description].filter(Boolean).join(' — ') || r.cardinality;
      r0.addEventListener('click', go('relationship', r.parent + '>' + r.child));
      const text = [r.name, r.description].filter(Boolean).join(' — ');
      if (!text) return [r0];
      const sub = el('r c');
      sub.style.paddingLeft = '40px';
      sub.append(span('sub', text));
      return [r0, sub];
    });
    return section('Relationships', filtering() ? `${rels.length}/${all.length}` : all.length, capped(rows, 'Relationships', 1));
  }

  function tags() {
    const defs = (F.governance || {}).tags || [];
    const usage = new Map(); // tag -> objects carrying it
    const use = (lbl, o, k, ref, column) => { for (const t of o.tags || []) { if (!usage.has(t)) usage.set(t, []); usage.get(t).push({ lbl, k, ref, column }); } };
    use(F.project.name, F.project, 'project', '');
    (F.catalogs || []).forEach((c) => use(c.name, c, 'catalog', c.name));
    (F.schemas || []).forEach((s) => { const ref = (s.catalog ? s.catalog + '.' : '') + s.name; use(ref, s, 'schema', ref); });
    (F.tables || []).forEach((t) => { const ref = t.schema + '.' + t.name; use(ref, t, 'table', ref); (t.columns || []).forEach((c) => use(ref + '.' + c.name, c, 'column', ref, c.name)); });
    const list = [...defs].sort((a, b) => cmp(a.name, b.name)).filter((t) => hit('tag', [t.name, t.displayName, t.description, t.owner, t.domain]));
    if (filtering() && !list.length) return [];
    const rows = list.map((t) => {
      const users = (usage.get(t.name) || []).sort((a, b) => cmp(a.lbl, b.lbl));
      return row(1, 'G:' + t.name, 'tag', label(t.name, t.displayName, t.enabled === false ? 'off' : ''), String(users.length), go('tag', t.name),
        () => capped(users.map((u) => { const r = el('r c'); r.style.paddingLeft = 8 + 2 * 14 + 'px'; r.append(label(u.lbl)); r.addEventListener('click', go(u.k, u.ref, u.column)); return r; }), 'G:' + t.name, 2), false,
        hoverOf(t, t.owner ? 'Owner: ' + t.owner : '', t.domain ? 'Domain: ' + t.domain : '', (t.policies || []).length ? 'Brings policies: ' + t.policies.join(', ') : '', t.enabled === false ? '(disabled)' : ''));
    });
    return section('Tags', filtering() ? `${list.length}/${defs.length}` : defs.length, rows.length ? capped(rows, 'Tags', 1) : [el('msg', document.createTextNode('No tags defined yet.'))]);
  }

  // semantic level (ADR-0037): the metrics, with their aggregation and calculation
  function metrics() {
    const all = (F.semantic || {}).metrics || [];
    const list = [...all].sort((a, b) => cmp(a.name, b.name)).filter((x) => objHit('metric', x, [x.name, x.description, x.calculation]));
    if (!all.length || (filtering() && !list.length)) return [];
    const rows = list.map((x) => {
      const r = el('r'); r.style.paddingLeft = '22px';
      r.append(ico('metric'), label(x.name), span('ty', (x.aggregation || '').replace('_', ' ')));
      r.title = [x.description, x.calculation && 'Calculation: ' + x.calculation, (x.grain || []).length && 'Grain: ' + x.grain.join(', ')].filter(Boolean).join('\n');
      r.addEventListener('click', go('metric', x.name));
      return r;
    });
    return section('Metrics', filtering() ? `${list.length}/${all.length}` : all.length, capped(rows, 'Metrics', 1));
  }

  // policies (ADR-0038): a tree by parents (a policy with several parents appears under each), each with the objects it is attached to
  function policies() {
    const defs = (F.governance || {}).policies || [];
    if (!defs.length) return [];
    const usage = new Map(), use = (lbl, o, k, ref, column) => { const g0 = o.governance || {}; for (const n of g0.policies || []) { if (!usage.has(n)) usage.set(n, []); usage.get(n).push({ lbl, k, ref, column }); } };
    use(F.project.name, F.project, 'project', '');
    (F.catalogs || []).forEach((c) => use(c.name, c, 'catalog', c.name));
    (F.schemas || []).forEach((s) => { const ref = (s.catalog ? s.catalog + '.' : '') + s.name; use(ref, s, 'schema', ref); });
    ((F.conceptual || {}).concepts || []).forEach((c) => use(c.name, c, 'concept', c.name));
    ((F.logical || {}).entities || []).forEach((e) => use(e.name, e, 'entity', e.name));
    (F.tables || []).forEach((t) => { const ref = t.schema + '.' + t.name; use(ref, t, 'table', ref); (t.columns || []).forEach((c) => use(ref + '.' + c.name, c, 'column', ref, c.name)); });
    ((F.semantic || {}).metrics || []).forEach((x) => use(x.name, x, 'metric', x.name));
    const names = new Set(defs.map((p) => p.name)), kids = (n) => defs.filter((p) => (p.parents || []).includes(n) && p.name !== n).sort((a, b) => cmp(a.name, b.name));
    const f = filtering();
    const prow = (p, depth, path) => {
      if (path.has(p.name)) return null; // a parent cycle
      const sub = kids(p.name).map((k) => prow(k, depth + 1, new Set([...path, p.name]))).filter(Boolean), own = hit('policy', [p.name, p.type, p.jurisdiction, p.owner, p.description]);
      if (f && !own && !sub.length) return null;
      const users = (usage.get(p.name) || []).sort((a, b) => cmp(a.lbl, b.lbl)), key = 'Y:' + [...path, p.name].join('>');
      return row(depth, key, 'policy', label(p.name, [p.type, p.jurisdiction].filter(Boolean).join(' · ')), String(users.length), go('policy', p.name),
        () => capped([...sub, ...users.map((u) => { const r = el('r c'); r.style.paddingLeft = 8 + (depth + 1) * 14 + 'px'; r.append(label(u.lbl)); r.addEventListener('click', go(u.k, u.ref, u.column)); return r; })], key, depth + 1),
        f && sub.length > 0, hoverOf(p, p.owner ? 'Owner: ' + p.owner : '', (p.parents || []).length ? 'Parents: ' + p.parents.join(', ') : ''));
    };
    const roots = defs.filter((p) => !(p.parents || []).some((n) => names.has(n) && n !== p.name)).sort((a, b) => cmp(a.name, b.name));
    const list = (roots.length ? roots : defs).map((p) => prow(p, 1, new Set())).filter(Boolean);
    if (f && !list.length) return [];
    return section('Policies', defs.length, capped(list, 'Policies', 1));
  }

  function render() {
    tree.replaceChildren();
    if (fileName) tree.append(el('fname', document.createTextNode(fileName)));
    if (invalid) tree.append(el('msg warn', document.createTextNode('The file is not valid JSON right now; showing the last valid version.')));
    if (!F) {
      tree.append(el('msg', document.createTextNode('Open a .model.json file to see its tables.')));
      return;
    }
    if (F.strata !== 2 && Array.isArray(F.tables) && F.tables.some((t) => t.schemaId)) {
      tree.append(el('msg', document.createTextNode('This file uses the old Strata 1 format. Open it once in the Strata SQL editor to convert it.')));
      return;
    }
    if (!F.project) {
      tree.append(el('msg', document.createTextNode('No project defined yet. Open the file in the Strata SQL editor to create one.')));
      return;
    }
    const hier = hierarchy(), lay = layers(), rels = relationships(), mets = metrics(), tg = tags(), pol = policies();
    tree.append(...hier, ...lay, ...rels, ...mets, ...tg, ...pol);
    if (filtering() && hier.length <= 1 && !lay.length && !rels.length && !mets.length && !tg.length && !pol.length) tree.append(el('msg', document.createTextNode('No matches.')));
    persist();
  }

  q.addEventListener('input', render);
  kind.addEventListener('change', render);
  const focusSearch = () => { q.focus(); q.select(); };
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); focusSearch(); }
    else if (e.key === 'Escape' && (q.value || kind.value !== 'all')) { q.value = ''; kind.value = 'all'; render(); }
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'model') {
      fileName = m.file || '';
      if (m.layoutKey !== undefined && m.layoutKey !== layoutKey) { layoutKey = m.layoutKey; applyLayout(m.layout); } // another model: its own saved state
      if (m.text == null) { F = null; invalid = false; } // no model file is active
      else if (!m.text.trim()) { F = {}; invalid = false; } // new, empty file
      else { try { F = JSON.parse(m.text); invalid = false; } catch { invalid = true; } } // keep the last valid state while typing
      render();
    } else if (m.type === 'focusSearch') focusSearch();
    else if (m.type === 'theme') { // the canvas theme (Catppuccin, Nord, ...): same variable overrides as the canvas
      let st = document.getElementById('strata-theme');
      if (!st) { st = Object.assign(document.createElement('style'), { id: 'strata-theme' }); document.head.append(st); }
      st.textContent = m.css || '';
    }
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
