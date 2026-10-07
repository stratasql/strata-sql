(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const L = window.Layout;
  const SM = window.StrataModel;
  const { W, HEAD, ROW } = L;

  // ---------- reference data ----------
  const T = (s) => s.split('|');
  const TYPES = {
    'SQL Server': T('bigint|int|smallint|tinyint|bit|decimal(18,2)|numeric(18,2)|money|float|real|date|datetime|datetime2|datetimeoffset|time|char(10)|varchar(255)|varchar(max)|nchar(10)|nvarchar(255)|nvarchar(max)|text|binary(16)|varbinary(max)|uniqueidentifier|xml'),
    PostgreSQL: T('smallint|integer|bigint|serial|bigserial|numeric(18,2)|real|double precision|boolean|char(10)|varchar(255)|text|date|time|timestamp|timestamptz|interval|uuid|json|jsonb|bytea|inet'),
    MySQL: T('tinyint|smallint|int|bigint|decimal(18,2)|float|double|boolean|char(10)|varchar(255)|text|longtext|date|time|datetime|timestamp|json|blob|enum'),
    Oracle: T('NUMBER|NUMBER(18,2)|INTEGER|FLOAT|BINARY_DOUBLE|VARCHAR2(255)|NVARCHAR2(255)|CHAR(10)|CLOB|BLOB|DATE|TIMESTAMP|TIMESTAMP WITH TIME ZONE|RAW(16)'),
    SQLite: T('INTEGER|REAL|TEXT|BLOB|NUMERIC|BOOLEAN|DATE|DATETIME'),
    Databricks: T('TINYINT|SMALLINT|INT|BIGINT|DECIMAL(18,2)|FLOAT|DOUBLE|BOOLEAN|STRING|VARCHAR(255)|CHAR(10)|BINARY|DATE|TIMESTAMP|TIMESTAMP_NTZ|INTERVAL|ARRAY<STRING>|MAP<STRING,STRING>|STRUCT<>|VARIANT'),
    Snowflake: T('NUMBER(38,0)|NUMBER(18,2)|INT|BIGINT|FLOAT|DOUBLE|BOOLEAN|VARCHAR|CHAR(10)|STRING|TEXT|BINARY|DATE|TIME|TIMESTAMP_NTZ|TIMESTAMP_LTZ|TIMESTAMP_TZ|VARIANT|OBJECT|ARRAY|GEOGRAPHY'),
    'Google BigQuery': T('INT64|FLOAT64|NUMERIC|BIGNUMERIC|BOOL|STRING|BYTES|DATE|TIME|DATETIME|TIMESTAMP|GEOGRAPHY|JSON|ARRAY|STRUCT|INTERVAL'),
    'Trino/Presto': T('BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|REAL|DOUBLE|DECIMAL(18,2)|VARCHAR|CHAR(10)|VARBINARY|DATE|TIME|TIMESTAMP|TIMESTAMP WITH TIME ZONE|INTERVAL|ARRAY|MAP|ROW|JSON|UUID'),
    DuckDB: T('BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|DECIMAL(18,2)|FLOAT|DOUBLE|VARCHAR|BLOB|DATE|TIME|TIMESTAMP|TIMESTAMPTZ|INTERVAL|UUID|JSON|LIST|STRUCT|MAP'),
  };
  const TECH = Object.fromEntries(Object.entries(SM.PLATFORMS).map(([k, p]) => [k, { ...p, types: TYPES[k] }])); // parts, schema, catalog: media/model.js (shared with the project wizard)
  const METHODS = SM.METHODS;
  const ROLES = ['Owner', 'Data Architect', 'Data Engineer', 'Analyst', 'Business Sponsor', 'Reviewer'];
  const CARDS = ['1..1', '1..M', 'M..M'];
  const isMac = /Mac/.test(navigator.platform);

  // Generic type shown on the logical level.
  function logicalType(dt) {
    const s = String(dt).toLowerCase();
    if (/interval/.test(s)) return 'Interval';
    if (/timestamp|datetime/.test(s)) return 'Timestamp';
    if (/\bdate\b/.test(s)) return 'Date';
    if (/\btime\b/.test(s)) return 'Time';
    if (/bool|\bbit\b/.test(s)) return 'Boolean';
    if (/(^|[^a-z])(tiny|small|big|huge)?int(eger)?(\d+)?\b|serial|number\(\d+,\s*0\)/.test(s)) return 'Integer';
    if (/dec|numeric|number|float|double|real|money/.test(s)) return 'Decimal';
    if (/json|variant|struct|array|map|object|list|row|xml/.test(s)) return 'Structured';
    if (/binary|blob|bytea|raw|bytes/.test(s)) return 'Binary';
    if (/char|text|string|clob|uuid|guid|uniqueidentifier|inet|enum/.test(s)) return 'Text';
    return dt;
  }

  // ---------- state ----------
  let model = SM.blank(); // working model
  let hist = SM.newHistory(); // version log (separate file)
  let pointers = {}; // stream (modelling, governance, semantic) -> chain hash of the entry the model is at (found by content hash on load, then kept here)
  let pending = []; // messages not yet versioned (version-on-save mode)
  let pendingLayout = null; // auto layout waiting to be versioned on save
  let drift = null; // history/model mismatch problems
  let forked = null; // SM.forks: streams whose log has several live branches (merged by Git), until the merge is recorded or dismissed
  let logBad = null; // SM.verifyLog problems: entries changed after they were recorded
  let legacy = null; // {log, inline}: an older file layout was loaded and is converted on the next save (ADR-0042)
  let legacyHide = false;
  let settings = {};
  let preview = null; // { entry, model } while previewing a point in time
  let broken = null; // JSON parse error text
  let level = 'physical'; // governance | domains | conceptual | logical | physical | semantic
  const tabLv = (lv) => lv === 'governance' || lv === 'domains'; // the two tabs that replace the canvas (change 31: Domains is its own level)
  let mode = 'schema'; // schema | data
  let selected = null;
  let historyOpen = false;
  let view = { x: 40, y: 60, k: 1 };
  let autoFit = true;
  let miniOn = true; // mini-map wanted (global, saved in .strata/layout.json); it still hides while the whole diagram is in view
  let first = true;
  const noScope = () => ({ c: new Set(), s: new Set(), k: new Set() });
  let scope = noScope(); // catalogs / schemas / concepts shown together (ADR-0033); all empty = whole project
  let scopeOpen = false;
  let toolsOpen = false;
  // impact analysis: click objects to select them, see what depends on them (see media/impact.js)
  const IM = window.StrataImpact;
  let impactOn = false, impactMode = 'delete', impactKeys = false, impactHi = true, impactRes = null, impactUnused = new Set();
  const impactSel = new Set(); // node keys: table:<id> (tables and views), column:<id>, schema:<id>, catalog:<id>
  // load order: which tables/views load first, which in parallel (see media/order.js)
  const OR = window.StrataOrder, SMD = window.StrataMd;
  let orderOn = false, orderView = 'stages', orderRes = null, orderW = 350, orderFull = false, hasSla = false, orderHideEx = false;
  const orderClosed = new Set(); // tree nodes the user collapsed
  const TH = window.StrataThemes, BRAND = window.StrataBrand, CG = window.StrataCodegen;
  // alignment of the conceptual / logical / physical layers (see media/align.js)
  const SA = window.StrataAlign, GV = window.StrataGov;
  let alignOn = false, alignTab = 'warnings', alignRes = null;
  const alignPick = new Set(); // table ids ticked in the Mapping tab for bulk assignment
  let vscodeThemeName = '', hostTheme = null, lastThemeCss = null; // hostTheme: the VS Code session's theme, when running in a browser
  let viewOnly = false, hostKind = 'vscode'; // viewOnly: exported HTML (read-only); hostKind: 'vscode' | 'live' (browser live view) | 'demo' (the live view's demo) | 'static'
  // indexFile: the project-index file (readOnly + projectView, with a real manifest behind it). Unlike the read-only Project View in general, it enables
  // Project settings, Tools > Generate embeddings (per domain part) and creating / editing a tag or policy (routed to governance.json), plus the
  // object edits routed back to their parts (persistProject).
  let indexFile = false;
  let embedStatus = null, embedKeys = {}, embedProviders = [], embedFile = ''; // vector embeddings (see Tools)
  let embedParts = null; // indexFile only: [{name, hasEmbeddings, upToDate, generatedAt}] per domain part
  // indexFile only (release 2 part 10): a concept's chosen domain, queued by conceptDomainField() and sent with the next edit (a concept's
  // domain lives in the manifest, not on the concept itself, so it cannot just ride along on the model text like a table's/entity's/metric's
  // own ext.homeDomain does) - conceptName -> domain name, or '_unassigned'/'' for none.
  let queuedConceptDomains = {};
  // indexFile only (release 2 part 12): every part's own version log, parsed client-side (SM.parseLog, the same parsing the ordinary editor's
  // own single log already goes through) - [{name, model, domain, gov, hist}], or null before the first model message with `histories` (the
  // ad hoc bespoke Project View panel never sends one, so this stays null there, unaffected - see renderMergedHistoryList()).
  let partHists = null;
  const openVer = new Set(); // history entries whose change details are expanded
  let dragLink = false;
  let searchOpen = false;
  let panelMem = null; // which panels were open before 'toggle all panels' hid them
  let edgeItems = [];
  let dataSel = null;
  const dataCache = new Map(); // csv file -> text | null (missing)
  const asked = new Set(); // csv files already requested from the host
  let dataDirName = 'data'; // set by the host: the name of the sample-data folder beside the model (data/, or <name>_model_data in a converted project)

  const uid = SM.uid;
  const clone = SM.clone;
  const data = () => (preview ? preview.model : model);
  const techOf = (d) => TECH[(d.project || {}).technology] || TECH.PostgreSQL;
  // Derived data of the model on screen, worked out once per change (rev counts loads, edits, undo / redo): the alignment and governance
  // check, the load order and what each level draws, and the memo the SA / GV lookups share while the model stays as it is.
  let rev = 0, derived = null;
  function fresh() {
    const d = data();
    if (!derived || derived.d !== d || derived.rev !== rev) derived = { d, rev, memo: new Map(), views: {}, order: {} };
    return derived;
  }
  const memoOf = (d) => (d === data() ? fresh().memo : new Map());
  const shown = (d = data()) => (d === data() ? (fresh().views[level] ||= SA.view(d, level) || d) : SA.view(d, level) || d); // what the current level draws: concepts, entities, metrics (with their tables) or tables
  const layerRels = () => { const l = shown().layer; return l === 'concept' || l === 'entity'; }; // relationships between concepts / entities (not on the semantic level)
  const tableById = (id) => shown().tables.find((t) => t.id === id);
  const H = (t) => L.height(t, level);
  const label = (o) => (level === 'physical' || level === 'semantic' ? o.name : o.displayName || o.name);
  const versionOnSave = () => settings.versionMode === 'save';

  function fullName(t, d = data()) {
    const s = d.schemas.find((x) => x.id === t.schemaId);
    const parts = [];
    if (d.project && d.project.threePart && s) {
      const c = d.catalogs.find((x) => x.id === s.catalogId);
      if (c) parts.push(c.name);
    }
    if (s) parts.push(s.name);
    parts.push(t.name);
    return parts.join('.');
  }
  const schemaLabel = (s, d = data()) => {
    const c = d.project && d.project.threePart && d.catalogs.find((x) => x.id === s.catalogId);
    return (c ? c.name + '.' : '') + s.name;
  };
  const eachObject = (m, fn) => {
    if (m.project) fn(m.project);
    m.catalogs.forEach(fn); m.schemas.forEach(fn);
    m.tables.forEach((t) => { fn(t); t.columns.forEach(fn); });
    m.concepts.forEach(fn); m.entities.forEach(fn); m.metrics.forEach(fn);
  };

  // ---------- tiny DOM helpers ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    const late = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked') late[k] = v;
      else if (k === 'disabled') e.disabled = true;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
    Object.assign(e, late);
    return e;
  }
  // replaceChildren() turns null / false into the text "null" / "false"; every fill goes through here and drops them like h() does
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const svg = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  };

  // Tooltip attributes: shown only when there is a description (or `always`), so plain objects stay quiet.
  const tipProps = (head, desc, hint, always) => (desc || always ? { 'data-th': head, ...(desc ? { 'data-td': desc + (hint ? `\n\n${hint}` : '') } : {}) } : {});

  // ---------- last canvas layout (.strata/layout.json, written by the host) ----------
  let layoutReady = false, layoutSaved = '', layoutT = null;
  // Each level keeps its own view, scope, open panels (impact, load order, alignment) and selection (ADR-0033); history, search and
  // the sample-data mode are shared. perLevel[level] also keeps the impact selection for the session (not saved).
  const perLevel = {};
  function saveLevel() {
    perLevel[level] = { view: { ...view }, autoFit, scope: { c: new Set(scope.c), s: new Set(scope.s), k: new Set(scope.k) }, panels: { impact: impactOn, order: orderOn, orderView, align: alignOn }, selected, impactSel: [...impactSel] };
  }
  // false when the level has no saved state yet (first visit: keep the scope and panels you came with)
  function loadLevel(lv) {
    const x = perLevel[lv];
    if (!x) return false;
    view = { ...x.view }; autoFit = x.autoFit; scope = { c: new Set(x.scope.c), s: new Set(x.scope.s), k: new Set(x.scope.k) };
    impactOn = !historyOpen && x.panels.impact; orderOn = !historyOpen && !impactOn && x.panels.order; alignOn = !historyOpen && !impactOn && !orderOn && x.panels.align;
    orderView = x.panels.orderView || orderView; selected = x.selected;
    impactSel.clear(); (x.impactSel || []).forEach((k) => impactSel.add(k)); impactRes = null;
    return true;
  }
  function layoutState() {
    saveLevel();
    return SM.canvasOut(model, { level, mode, history: historyOpen, minimap: miniOn, levels: perLevel, governance: { view: govState.view === 'graph' ? 'graph' : 'list', sel: govState.sel, graph: [...govState.gSel] } });
  }
  function scheduleLayoutSave() {
    if (!layoutReady || viewOnly || preview || broken || !model.project) return;
    clearTimeout(layoutT);
    layoutT = setTimeout(saveLayoutNow, 700);
  }
  function saveLayoutNow() { // also right before the live view opens, so it starts where you are
    clearTimeout(layoutT);
    if (!layoutReady || viewOnly || preview || broken || !model.project) return;
    const s = layoutState(), j = JSON.stringify(s);
    if (j !== layoutSaved) { layoutSaved = j; vscode.postMessage({ type: 'layout', part: 'canvas', state: s }); }
  }
  // put the canvas back as the user left it: level, sample-data mode, history, and per level its view, scope, panels and selection
  // (SM.canvasIn resolves the stored names; an old single-state file counts for every level)
  function restoreLayout(L) {
    const st = SM.canvasIn(model, L);
    if (!st) return { fit: true };
    Object.assign(perLevel, st.levels);
    historyOpen = st.history; miniOn = st.minimap;
    if (st.governance) { govState.view = st.governance.view; govState.sel = st.governance.sel; govState.gSel = new Set(st.governance.graph); }
    if (st.mode === 'data') mode = 'data';
    if (st.level !== level) { stash(model); level = st.level; ensurePositions(); }
    return { fit: !loadLevel(level) || autoFit };
  }

  // ---------- colour theme ----------
  // Auto follows the VS Code theme: a matching palette (Catppuccin, Tokyo Night, Rosé Pine, Nord) when the theme is one of those,
  // otherwise the VS Code colours themselves. In a browser (live view, export) "VS Code" means the colours copied from the user's session.
  const themeStyle = Object.assign(document.createElement('style'), { id: 'strata-theme' });
  document.head.append(themeStyle);
  const themeKind = () => (hostKind === 'vscode' ? (/vscode-(high-contrast-)?light/.test(document.body.className) ? 'light' : 'dark') : (hostTheme && hostTheme.kind) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  function applyTheme(force) { // force: { theme, variant } previews a choice from the settings dialog
    const pick = force || { theme: settings.theme, variant: settings.themeVariant };
    const name = hostKind === 'vscode' ? vscodeThemeName : (hostTheme && hostTheme.name) || '';
    const r = TH.resolve(pick.theme || 'auto', pick.variant || 'auto', name, themeKind() === 'dark'), kind = r.real ? themeKind() : r.kind;
    const css = !r.real ? TH.css(r.family, r.variant) : hostKind !== 'vscode' && hostTheme && hostTheme.vars ? TH.cssVars(hostTheme.vars, kind) : '';
    themeStyle.textContent = css;
    if (css !== lastThemeCss) { lastThemeCss = css; vscode.postMessage({ type: 'themeCss', css, kind }); } // the navigator view / pane follows
  }
  // inside VS Code: tell the host the real theme colours so a browser live view / export can match them
  function reportVsCodeTheme() {
    if (hostKind !== 'vscode') return;
    const vars = {};
    for (const v of TH.VARS) { const x = document.documentElement.style.getPropertyValue('--vscode-' + v).trim(); if (x) vars[v] = x; }
    if (Object.keys(vars).length) vscode.postMessage({ type: 'themeVars', kind: themeKind(), vars });
  }
  let themeTimer = null;
  new MutationObserver(() => { clearTimeout(themeTimer); themeTimer = setTimeout(() => { reportVsCodeTheme(); applyTheme(); }, 200); }).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });

  // ---------- skeleton ----------
  const app = document.getElementById('app');
  const bar = h('div', { id: 'bar' });
  const banner = h('div', { id: 'banner', hidden: true });
  const framesLayer = h('div', { id: 'frames' });
  const edgesSvg = svg('svg', { id: 'edges' });
  edgesSvg.innerHTML =
    '<defs><marker id="one" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1 1 L9 5 L1 9 z" class="mk"/></marker>' +
    '<marker id="many" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6"><circle cx="5" cy="5" r="3.5" class="mk"/></marker></defs>';
  const edgePaths = svg('g');
  edgesSvg.append(edgePaths);
  const cardsLayer = h('div', { id: 'cards' });
  const world = h('div', { id: 'world' }, framesLayer, edgesSvg, cardsLayer);
  const empty = h('div', { id: 'empty', hidden: true },
    h('h2', null, 'No project yet'),
    h('p', null, 'Create a project to start modelling, or let the wizard set up a project with a template (Northwind, FpML, a star schema).'),
    h('div', { style: 'display:flex;gap:8px' }, h('button', { class: 'primary', onclick: () => openProject() }, 'Create project'), h('button', { onclick: () => vscode.postMessage({ type: 'newProject' }) }, 'New project wizard…')));
  const mini = svg('svg', { id: 'mini', role: 'img', 'aria-label': 'Mini-map: click or drag to move the view, wheel to zoom', hidden: '' });
  const miniG = svg('g'), miniVp = svg('rect', { class: 'mv' });
  mini.append(miniG, miniVp);
  const ctl = h('div', { id: 'ctl', role: 'toolbar', 'aria-label': 'Canvas controls' }); // always-on graph controls, bottom-right (renderCtl)
  const domlegend = h('div', { id: 'domlegend', hidden: true, 'aria-label': 'Domains' }); // Project View only: domain name -> colour (renderDomLegend)
  const semEmpty = h('div', { id: 'semempty', class: 'empty2', hidden: true }, h('h2', null, 'No metrics yet'),
    h('p', null, 'The Semantic level holds metrics: what a number means and how it is calculated from table columns.'),
    h('button', { class: 'primary', onclick: () => openMetric(null) }, 'Add a metric'));
  const vp = h('div', { id: 'vp' }, world, empty, semEmpty, mini, ctl, domlegend);
  const dataView = h('div', { id: 'dataview', hidden: true });
  const govView = h('div', { id: 'govview', hidden: true }); // the Governance tab (ADR-0038)
  const hq = h('input', { class: 'hq', placeholder: 'Search message, user, version…', oninput: () => renderHistoryList() });
  const hs = h('select', { onchange: () => renderHistoryList() }, h('option', { value: '' }, 'All changes'), h('option', { value: 'modelling' }, 'Modelling'), h('option', { value: 'governance' }, 'Governance'), h('option', { value: 'semantic' }, 'Semantic'));
  const ha = h('select', { title: 'Filter by what the version did', onchange: () => renderHistoryList() }, h('option', { value: '' }, 'All actions'), h('option', { value: 'added' }, 'Added'), h('option', { value: 'updated' }, 'Updated'), h('option', { value: 'deleted' }, 'Deleted'), h('option', { value: 'moved' }, 'Moved (domain change)'));
  const hu = h('input', { type: 'checkbox', onchange: () => renderHistoryList() });
  const hf = h('input', { type: 'datetime-local', title: 'From date and time', onchange: () => renderHistoryList() });
  const ht = h('input', { type: 'datetime-local', title: 'To date and time', onchange: () => renderHistoryList() });
  // indexFile only (release 2 part 12): a part/domain filter for the merged history list, and the merged Undo/Redo affordance - both hidden
  // (see renderHistory()) unless this tab's own drawer is showing the merged list (indexFile && partHists), so the ordinary single-part
  // drawer (every other view) is unaffected byte-for-byte.
  const hp = h('select', { title: 'Filter by part (the project-index file\'s merged history only)', onchange: () => renderHistoryList() }, h('option', { value: '' }, 'All parts'));
  const hpRow = h('div', { class: 'hrow', hidden: true }, hp);
  const undoAllBtn = h('button', { class: 'ib', hidden: true, title: 'Undo the single most recent change across every part', onclick: () => vscode.postMessage({ type: 'projectUndo' }) }, '↶ Undo');
  const redoAllBtn = h('button', { class: 'ib', hidden: true, title: 'Redo the single earliest undone change across every part', onclick: () => vscode.postMessage({ type: 'projectRedo' }) }, '↷ Redo');
  const hlist = h('div', { class: 'dl' });
  const drawer = h('div', { id: 'history', hidden: true },
    h('div', { class: 'dh' }, h('strong', null, 'Version history'), h('div', { class: 'dhr' }, undoAllBtn, redoAllBtn, h('button', { class: 'ib', onclick: () => { historyOpen = false; render(); } }, '✕'))),
    h('div', { class: 'hf' }, hq,
      h('div', { class: 'hrow' }, hs, ha, h('label', { class: 'chk', title: 'Also list the versions an edit after an undo left behind (the history is never rewritten)' }, hu, 'Undone'), h('button', { class: 'ib', title: 'Clear filters', onclick: () => { hq.value = ''; hs.value = ''; ha.value = ''; hf.value = ''; ht.value = ''; hu.checked = false; hp.value = ''; renderHistoryList(); } }, 'Clear')),
      hpRow,
      h('div', { class: 'hd' }, h('label', null, 'From', hf), h('label', null, 'To', ht))),
    hlist);
  const scopePop = h('div', { id: 'scopepop', class: 'pop', hidden: true });
  const toolsPop = h('div', { id: 'toolspop', class: 'pop', hidden: true });
  const viewPop = h('div', { id: 'viewpop', class: 'pop', hidden: true });
  const impactDrawer = h('div', { id: 'impact', hidden: true });
  const orderDrawer = h('div', { id: 'order', hidden: true });
  const alignDrawer = h('div', { id: 'align', hidden: true });
  const SEARCH_KINDS = [['all', 'All'], ['concept', 'Concept'], ['entity', 'Entity'], ['catalog', 'Catalog'], ['schema', 'Schema'], ['table', 'Table / view'], ['column', 'Column'], ['relationship', 'Relationship'], ['metric', 'Metric'], ['tag', 'Tag'], ['property', 'Property / governance'], ['policy', 'Policy']];
  const sq = h('input', { class: 'sq', placeholder: 'Search the model…', oninput: () => runSearch(), onkeydown: (e) => searchKey(e) });
  const sk = h('select', { class: 'sk', title: 'What to search', onchange: () => runSearch() }, SEARCH_KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const sres = h('div', { class: 'sres' });
  const searchBox = h('div', { id: 'search', hidden: true },
    h('div', { class: 'srow' }, h('span', { class: 'sgrip', title: 'Drag to move', onpointerdown: (e) => dragSearch(e) }, '⠿'), sq, sk, h('button', { class: 'ib', title: 'Close (Esc)', onclick: () => closeSearch() }, '✕')), sres);
  app.append(bar, banner, h('div', { id: 'main' }, vp, dataView, govView, drawer, impactDrawer, orderDrawer, alignDrawer, searchBox, scopePop, toolsPop, viewPop));

  // ---------- loading, saving, versioning ----------
  const modelText = () => SM.stringify(SM.toFile(model)) + '\n';
  const histText = () => SM.logText(hist);
  const posText = () => SM.stringify(SM.layoutFile(model, level)) + '\n'; // canvas positions: <name>.model.layout.json, never versioned, never part of an edit
  // Positions go to their own file, a little after they change; the model document stays clean. While an older layout is waiting to be converted
  // they travel with the edit instead, so the conversion writes everything at the next save.
  let posSent = null, posT = null;
  const sendPositions = () => { if (viewOnly || broken || preview || !model.project || legacy) return; const t = posText(); if (t !== posSent) { posSent = t; vscode.postMessage({ type: 'positions', text: t }); } };
  const positionsChanged = () => { stash(model); if (legacy) persist(false); else { clearTimeout(posT); posT = setTimeout(sendPositions, 400); } }; // stash: a moved card keeps its new place when the canvas is drawn again
  const persist = (withHistory) => {
    stash(model);
    const msg = { type: 'edit', text: modelText(), history: withHistory || legacy ? histText() : undefined };
    if (legacy) msg.positions = posText(); else positionsChanged();
    return vscode.postMessage(msg);
  };

  const vpAspect = () => { const r = vp.getBoundingClientRect(); return r.width > 100 && r.height > 100 ? r.width / r.height : 1.6; };

  const stash = (m) => SM.nodesOf(m, level).forEach((t) => { if (typeof t.x === 'number') (t.pos ||= {})[level] = { x: t.x, y: t.y }; });

  // Every table needs a position on the current level; missing ones come from the auto layout.
  function ensurePositions(m = model) {
    const missing = [];
    for (const t of SM.nodesOf(m, level)) {
      t.pos ||= {};
      if (t.pos[level]) { t.x = t.pos[level].x; t.y = t.pos[level].y; } else missing.push(t);
    }
    if (!missing.length) return;
    const v = SA.view(m, level) || m, placed = SM.nodesOf(m, level).filter((t) => !missing.includes(t));
    if (placed.length) { // a few new ones: in rows under what is already placed, so nothing moves or overlaps
      let x = Math.min(...placed.map((t) => t.x)), y = Math.max(...placed.map((t) => t.y + H(t))) + 80, rowH = 0, k = 0;
      const x0 = x;
      for (const t of missing) {
        if (k++ && k % 6 === 1) { x = x0; y += rowH + 60; rowH = 0; }
        t.x = x; t.y = y; t.pos[level] = { x, y }; x += W + 60; rowH = Math.max(rowH, H(t));
      }
      return;
    }
    const pos = L.compute(v, level, vpAspect());
    for (const t of missing) { const p = pos[t.id] || { x: 0, y: 0 }; t.x = p.x; t.y = p.y; t.pos[level] = { ...p }; }
  }

  const LOG_ERR = 'The version log (history/<name>.history.jsonl)';
  const LG = window.StrataLegacy;
  // text: the model file, histTxt: the version log (current or older layout), layoutTxt: the positions file, cache: preloaded snapshots (all may be missing)
  function load(text, histTxt, layoutTxt, cache) {
    broken = null; rev++;
    let o = {};
    try { o = text.trim() ? JSON.parse(text) : {}; } catch (e) { broken = e.message; }
    const oldLog = SM.isLegacyLog(histTxt), ph = oldLog ? LG.parseHistory(histTxt) : SM.parseLog(histTxt);
    if (ph.error) broken = LOG_ERR + ' cannot be read: ' + ph.error;
    if (broken) { hist = SM.newHistory(); return; }
    const sidecar = layoutTxt ? SM.layoutRead(layoutTxt) : null, prior = model.project ? SM.layoutOf(model, level) : null; // what the canvas already shows beats the file, which lags a moment
    const merge = (a, b) => (a && b ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((lv) => [lv, { ...a[lv], ...b[lv] }])) : a || b);
    model = SM.fromFile(o, level, model.project ? SM.idIndex(model) : null, merge(sidecar, prior));
    preview = null; pending = []; pendingLayout = null; pointers = {}; drift = null; forked = null; logBad = null; legacy = null; legacyHide = false;
    ensurePositions();
    if (!model.project) { hist = SM.newHistory(); posSent = posText(); return; }
    const flats = SM.flatten(SM.toFile(model));
    if (oldLog) { // converted in memory; nothing is written until the user saves
      const truth = Object.fromEntries(SM.STREAMS.filter((st) => (o.version || {})[st]).map((st) => [st, { id: o.version[st], flat: flats[st] }]));
      const cv = LG.load(histTxt, truth);
      hist = cv.history; legacy = { log: true, inline: !!(o.layout || o.version), merged: cv.replayed };
    } else { hist = ph.history; if (o.layout || o.version) legacy = { log: false, inline: true }; }
    SM.useSnapshots(hist, cache);
    if (!hist.entries.length) record('Baseline: existing model'); // no history at all yet: baseline it silently
    else {
      const loc = SM.locate(hist, flats), bad = SM.verifyLog(hist), fk = SM.forks(hist, flats);
      pointers = loc.pointers;
      if (loc.problems.length) drift = loc.problems;
      if (bad.length) logBad = bad;
      if (fk.length) forked = fk;
    }
    posSent = posText();
  }

  // Record whatever changed as new entries, per stream. Returns true when something was recorded.
  function record(message, layout) {
    const f = SM.flatten(SM.toFile(model));
    const info = { message, user: settings.name, email: settings.email, system: settings.system };
    let any = false;
    for (const s of SM.STREAMS) {
      // an auto-layout version carries its before/after positions on a modelling entry (even if nothing else changed)
      const e = SM.commit(hist, s, pointers[s], f[s], info, s === 'modelling' && layout ? { force: true, layout } : {});
      if (e) { pointers[s] = e.chain; any = true; }
    }
    return any;
  }

  function flushPending() {
    if (!pending.length) return false;
    const msgs = pending.filter((m, i) => m !== pending[i - 1]);
    const layout = pendingLayout;
    pending = []; pendingLayout = null;
    record(msgs.length > 3 ? `${msgs.slice(0, 3).join('; ')} (+${msgs.length - 3} more)` : msgs.join('; '), layout);
    return true;
  }

  function commitChange(message, layout) {
    rev++;
    // The project-index file (release 2 part 10) has no one log of its own to version against (every part keeps its own, independent
    // history, unaffected by this): every edit here is sent, and saved, at once - "version on save" batching and the pending-changes badge
    // do not apply to this view (there is nothing to batch against). See persistProject() for what actually gets sent.
    if (indexFile) { persistProject(message); render(); return; }
    if (versionOnSave()) {
      pending.push(message);
      if (layout) pendingLayout = { level: layout.level, before: pendingLayout && pendingLayout.level === layout.level ? pendingLayout.before : layout.before, after: layout.after };
      persist(false);
    } else { record(message, layout); persist(true); }
    render();
  }
  // Sends the whole edited, assembled model back for lib/project.js#applyProjectEdit to re-route. No reply on success (the webview's model already is
  // the edit); a failure (e.g. an object routed to a domain with no part on disk) is a native error message and the webview's copy is not rolled back.
  // queuedConceptDomains: a concept's domain lives in the manifest, so it rides along as its own field (see conceptDomainField()).
  function persistProject(message) {
    stash(model);
    const msg = { type: 'editProject', text: modelText(), message };
    if (Object.keys(queuedConceptDomains).length) { msg.conceptDomains = { ...queuedConceptDomains }; queuedConceptDomains = {}; }
    vscode.postMessage(msg);
  }

  // Positions on the current level for auto-layout versions: tables by ref, concepts / entities / metrics by name
  const nodeRef = (m, lvl) => { const R = SM.refs(m), ns = SM.nodesOf(m, lvl); return (t) => (ns === m.tables ? R.tab.get(t.id) : t.name); };
  function layoutSnap() {
    const ref = nodeRef(model, level);
    return Object.fromEntries(SM.nodesOf(model, level).map((t) => [ref(t), [Math.round(t.x), Math.round(t.y)]]));
  }
  function applyLayoutSnap(m, lvl, snap) {
    const ref = nodeRef(m, lvl);
    for (const t of SM.nodesOf(m, lvl)) {
      const p = snap[ref(t)];
      if (!p) continue;
      const q = SM.xy(p);
      (t.pos ||= {})[lvl] = q;
      if (lvl === level) { t.x = q.x; t.y = q.y; }
    }
  }
  // Layout payloads crossed when moving one stream's pointer to entry `to`: backwards restores `before`, forwards `after`.
  function crossedLayouts(stream, to) {
    if (!pointers[stream]) return [];
    const { back, list } = SM.between(hist, pointers[stream], to.chain);
    return list.filter((e) => e.layout).map((e) => [e.layout.level, back ? e.layout.before : e.layout.after]);
  }

  const dataNames = () => { const R = SM.refs(model); return new Map(model.tables.map((t) => [t.id, R.tab.get(t.id)])); };

  function mutate(message, fn) {
    // release 2 part 10: every dialog's Save/Delete button already only ever calls mutate() to change the model, so this one gate is the
    // whole of "editing is allowed from the project-index file" (indexFile) - reused, not duplicated, at every place that opens a dialog.
    if (preview || broken || (viewOnly && !indexFile)) return;
    const before = dataNames(), snap = model.metrics.length ? SM.metricSnap(model) : null;
    fn();
    for (const [id, name] of dataNames()) {
      const old = before.get(id);
      if (old && old !== name) vscode.postMessage({ type: 'data', op: 'rename', file: `${dataDirName}/${old}.csv`, to: `${dataDirName}/${name}.csv` });
    }
    const fixed = snap ? SM.metricRewrite(model, snap) : []; // a renamed table / column / schema / catalog follows into the metric calculations that read it (same version)
    commitChange(fixed.length ? `${message}; updated the calculation of ${fixed.length > 3 ? fixed.slice(0, 3).join(', ') + ` (+${fixed.length - 3} more)` : fixed.join(', ')}` : message);
    if (fixed.length) toast(`Updated the calculation of ${plural(fixed.length, 'metric')}: ${fixed.slice(0, 4).join(', ')}${fixed.length > 4 ? '…' : ''}`);
  }

  // Layout is never versioned and never touches the model file: positions go to the layout file.
  function layoutChange(fn) {
    if (preview || broken || viewOnly) return;
    fn();
    positionsChanged();
    render();
  }

  // Build a working model from history entries (the other streams stay where they are).
  function rebuild(ptrs) {
    const [M, G, S] = SM.STREAMS.map((st) => (ptrs[st] && SM.stateAt(hist, ptrs[st])) || {});
    const F = SM.unflatten(M, G, S);
    stash(model);
    const m = SM.fromFile(F, level, SM.idIndex(model), SM.layoutOf(model, level));
    ensurePositions(m);
    return m;
  }

  function gotoEntry(e) {
    if (preview || broken || viewOnly || !e) return;
    const ops = crossedLayouts(e.stream, e);
    pointers = { ...pointers, [e.stream]: e.chain };
    model = rebuild(pointers); rev++;
    ops.forEach(([lvl, snap]) => applyLayoutSnap(model, lvl, snap));
    pending = []; pendingLayout = null;
    persist(false);
    render();
  }
  const undo = () => { const t = SM.undoTarget(hist, pointers); if (t) gotoEntry(SM.entry(hist, t.key)); };
  const redo = () => { const t = SM.redoTarget(hist, pointers); if (t) gotoEntry(SM.entry(hist, t.key)); };

  function startPreview(e) {
    const pm = rebuild({ ...pointers, [e.stream]: e.chain });
    crossedLayouts(e.stream, e).forEach(([lvl, snap]) => applyLayoutSnap(pm, lvl, snap));
    preview = { entry: e, model: pm };
    render();
  }
  function applyPreview() {
    const { entry, model: pm } = preview;
    preview = null;
    model = pm;
    commitChange(`Restored ${entry.stream} ${entry.id}`);
  }

  // ---------- modal helpers ----------
  function modal(title, body, actions, wide, onClose) {
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && ov === [...document.querySelectorAll('.overlay')].pop()) close(); };
    const err = h('div', { class: 'err' });
    const ov = h('div', { class: 'overlay' },
      h('div', { class: 'modal' + (wide ? ' wide' : '') },
        h('h2', null, title), body, err,
        h('div', { class: 'actions' }, actions.map((a) =>
          h('button', {
            class: a.primary ? 'primary' : a.danger ? 'danger' : '',
            disabled: a.disabled,
            onclick: () => {
              const r = a.fn ? a.fn() : undefined;
              if (typeof r === 'string') err.textContent = r;
              else close();
            },
          }, a.label)))));
    document.addEventListener('keydown', onKey);
    document.body.append(ov);
    const f = ov.querySelector('input:not([type=checkbox]),select,textarea');
    if (f) f.focus();
    return close;
  }
  const field = (lbl, input, hint) => h('label', { class: 'field' }, h('span', null, lbl), input, hint && h('small', null, hint));
  const check = (lbl, checked) => {
    const i = h('input', { type: 'checkbox', checked });
    return { el: h('label', { class: 'chk' }, i, lbl), input: i };
  };
  const dropdown = (options, value) => {
    const s = h('select', null, options.map((o) => (typeof o === 'string' ? h('option', { value: o }, o) : h('option', { value: o.value }, o.label))));
    s.value = value;
    return s;
  };
  const confirmDlg = (title, msg, lbl, fn) => modal(title, h('p', null, msg), [{ label: 'Cancel' }, { label: lbl, danger: true, fn }]);
  const identOk = (v) => /^[^\s.]+$/.test(v);
  const identRule = 'Name is required and cannot contain spaces or dots.';

  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleString('en-GB', { timeZone: settings.timezone || undefined, dateStyle: 'medium', timeStyle: 'medium' }); }
    catch { return new Date(iso).toLocaleString(); }
  };

  // ---------- governance in object dialogs (media/gov.js, ADR-0038): one collapsed box ----------
  // people for the owner / steward boxes: stakeholders plus every owner / steward already used
  function peopleList() {
    const s = new Set(), add = (v) => { if (v && typeof v === 'string') s.add(v); };
    (model.project ? model.project.stakeholders : []).forEach((x) => { add(x.name); add(x.role); });
    GV.objects(model).forEach((x) => { const g0 = x.o.gov || {}; add(g0.owner); add(g0.steward); GV.LEVELS.forEach((lv) => { add((g0[lv] || {}).owner); add((g0[lv] || {}).steward); }); });
    model.governance.policies.forEach((p) => add(p.owner));
    return h('datalist', { id: 'govpeople' }, [...s].sort().map((v) => h('option', { value: v })));
  }
  // one input for a common property; inh = the inherited {v, from}, shown as the placeholder / first option
  function govInput(d, v, inh) {
    const ph = inh ? `↑ ${inh.v} (${GV.fromText(inh.from)})` : '';
    if (d.values) { const s = dropdown([{ value: '', label: inh ? ph : '— not set —' }, ...d.values, ...(v && !d.values.includes(v) ? [v] : [])], v || ''); return { el: s, get: () => s.value }; }
    const i = h('input', { value: v || '', placeholder: ph || d.hint, list: 'govpeople' });
    return { el: i, get: () => i.value.trim() };
  }
  // Classification (information about the data itself, ADR-0041): a lock coloured by level; `clsFrom` says where a value comes from
  const clsBadge = (v, text, size = 12) => h('span', { class: 'clsb cls-' + v.toLowerCase() }, icon('lock', false, size), text === undefined ? v : text);
  const clsFrom = (c) => (!c.from ? 'its own value' : c.from.kind === 'policy' ? `raised by policy ${c.from.name}` : 'from ' + GV.fromText(c.from));
  // own = what the object says (declared, or on a column brought by its policy / tags); rolled = the highest of that and everything below it
  const clsOf = (o, d = model, memo = memoOf(d)) => GV.classify(d, o, memo);
  // small lock on a card: the rolled-up value (containers) or the own value (columns), with where it comes from
  function clsChip(o, column) {
    const d = data(), c = clsOf(o, d), v = column ? c.own : c.rolled;
    if (!v) return null;
    const own = c.own && !column ? `\nOwn value: ${c.own.v}, a minimum that is not passed down.` : '';
    return h('span', { class: 'clsb cls-' + v.v.toLowerCase() + (column ? ' col' : ''), ...tipProps('Classification: ' + v.v, (column ? `${clsFrom(v)[0].toUpperCase()}${clsFrom(v).slice(1)}.` : `Highest of what it holds: ${clsFrom(v)}.`) + own, '', true) }, icon('lock', false, column ? 10 : 12));
  }
  const howText = (r) => (r.how === 'tag' ? `via tag ${r.from.name}` : r.how === 'inherited' ? `from ${GV.fromText(r.from)}${r.from.tag ? ` (tag ${r.from.tag})` : ''}` : '') + (r.via ? `${r.how === 'direct' ? '' : ', '}through ${r.via}` : '');
  // attached policies as removable chips plus a picker; the rest of what applies is listed below it
  function policyPicker(names) {
    const have = [...names], box = h('div', { class: 'chips' }), pick = h('select');
    const paint = () => {
      fill(box, ...have.map((n) => h('span', { class: 'chip' }, n, h('button', { class: 'ib', title: 'Detach', onclick: () => { have.splice(have.indexOf(n), 1); paint(); } }, '✕'))));
      fill(pick, h('option', { value: '' }, model.governance.policies.length ? '+ Attach a policy…' : 'No policies yet (Governance tab)'), ...model.governance.policies.filter((p) => !have.includes(p.name)).map((p) => h('option', { value: p.name }, p.name + (p.type ? ` (${p.type})` : ''))));
    };
    pick.addEventListener('change', () => { if (pick.value) have.push(pick.value); paint(); });
    paint();
    return { el: h('div', { class: 'polpick' }, box, pick), get: () => have };
  }
  function openGovTab(view, name) { // from a dialog or a link: close the dialogs and open the Governance tab
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
    if (name) govState.sel = name;
    govState.view = view || govState.view;
    setLevel('governance'); render();
  }
  // kind: project | catalog | schema | table | column | concept | entity | metric. The box shows this level's owner, steward,
  // classification, criticality and lifecycle (inherited values greyed), the attached policies, and what else applies.
  function govBox(o, kind) {
    const own = o.gov || {}, isProj = kind === 'project', real = !isProj && o.id ? o : null, memo = memoOf(model);
    const ef = real ? GV.effective(model, real, memo) : {}, ins = [];
    const cell = (d, v, inh, key) => { const x = govInput(d, v, inh); ins.push([key, x]); return h('label', { class: 'field', title: d.hint }, h('span', null, d.label), x.el); };
    let grid;
    if (isProj) { // defaults per level: used by everything on that level that sets nothing itself
      grid = h('table', { class: 'govdef' }, h('tr', null, h('th', null, ''), ...GV.COMMON.map((d) => h('th', null, d.label))),
        ...GV.LEVELS.map((lv) => h('tr', null, h('th', null, lv[0].toUpperCase() + lv.slice(1)), ...GV.COMMON.map((d) => { const x = govInput(d, (own[lv] || {})[d.key], null); ins.push([lv + '.' + d.key, x]); return h('td', null, x.el); }))));
    } else grid = h('div', { class: 'govgrid' }, GV.COMMON.filter((d) => d.key !== 'classification').map((d) => cell(d, own[d.key], ef[d.key] && ef[d.key].from ? ef[d.key] : null, d.key)));
    // security / classification: the object's own value, and on a container what it rolls up from what it holds (nothing is inherited from above)
    const ci = real ? clsOf(real, model, memo) : {}, cd = GV.COMMON.find((d) => d.key === 'classification'), cin = isProj ? null : govInput(cd, own.classification, null);
    if (cin) ins.push(['classification', cin]);
    const container = kind !== 'column';
    const secure = isProj ? null : h('div', { class: 'govsec' },
      h('div', { class: 'govst' }, icon('lock', false, 13), 'Security / classification'),
      h('small', { class: 'muted' }, container ? 'What the data is. A value set here is a minimum for what this holds and is never pushed down; the rolled-up value is the highest of it and everything below.' : 'What the data is. A column owns its classification (set here, or brought by a policy on it or a tag it carries); nothing comes down from its table, schema or concepts.'),
      h('div', { class: 'clsrow' }, h('label', { class: 'field', title: cd.hint }, h('span', null, container ? 'Own minimum' : 'Classification'), cin.el),
        h('div', { class: 'clsread' }, ci.rolled ? [h('span', { class: 'muted' }, container ? 'Rolled up ' : 'Effective '), clsBadge(ci.rolled.v), h('small', null, ' ' + clsFrom(ci.rolled))] : h('small', { class: 'muted' }, container ? 'Nothing classified here or below yet' : 'Not classified'))));
    const pol = policyPicker(own.policies || []), off = [...(own.off || [])];
    const more = real ? GV.reach(model, real, memo).filter((r) => r.how !== 'direct' || r.via) : [];
    // switching off a policy that reaches it from above or through a tag (ADR-0039); always reported until accepted
    const offBox = h('div', { class: 'offbox' });
    const paintOff = () => {
      const cut = real ? GV.switchedOff(model, real, memo).filter((r) => !off.includes(r.name) && r.from) : []; // switched off higher up
      fill(offBox,
        more.length ? h('small', null, 'Also applies: ', ...more.flatMap((r, i) => [i ? '; ' : '', `${r.name} (${howText(r)}) `, off.includes(r.name) ? null : h('button', { class: 'lnk', title: `Switch ${r.name} off here and below. It stays reported under Alignment until you accept it.`, onclick: (e) => { e.preventDefault(); off.push(r.name); paintOff(); } }, 'switch off')]).filter((x) => x !== null)) : null,
        off.length ? h('div', { class: 'chips' }, h('small', null, 'Switched off here:'), ...off.map((n) => h('span', { class: 'chip off' }, n, h('button', { class: 'ib', title: 'Switch it on again', onclick: (e) => { e.preventDefault(); off.splice(off.indexOf(n), 1); paintOff(); } }, '✕')))) : null,
        cut.length ? h('small', null, 'Switched off above: ' + cut.map((r) => `${r.name} (on ${GV.fromText(r.from)})`).join(', ')) : null);
    };
    paintOff();
    const sum = [ef.owner && 'Owner ' + ef.owner.v + (ef.owner.from ? ' ↑' : ''), ef.classification && ef.classification.v, (own.off || []).length && `${own.off.length} switched off`, (real ? GV.reach(model, real, memo).length : (own.policies || []).length) && plural(real ? GV.reach(model, real, memo).length : own.policies.length, 'policy', 'policies')].filter(Boolean).join(' · ');
    const lvWord = isProj ? '' : { concept: 'conceptual', entity: 'logical', metric: 'semantic' }[kind] || 'physical';
    return {
      el: h('details', { class: 'govbox' }, h('summary', null, h('b', null, 'Security and governance'), sum ? h('span', { class: 'muted' }, ' · ' + sum) : null), peopleList(),
        secure,
        h('div', { class: 'govsec' },
          h('div', { class: 'govst' }, icon('user', false, 13), 'Governance / ownership'),
          h('small', { class: 'muted' }, isProj ? 'Defaults per level: everything on a level that sets nothing itself uses these (a classification here is what an unclassified column takes). Owners are per level: the conceptual owner of Customer is not the owner of its tables.' : `How this ${kind} is managed, on the ${lvWord} level. Empty = inherited from above it (greyed). Owner, steward, criticality, lifecycle and policies flow down.`),
          grid,
          h('div', { class: 'field' }, h('span', null, isProj ? 'Policies for the whole project' : 'Attached policies'), pol.el, offBox)),
        h('button', { class: 'lnk', onclick: () => openGovTab('list') }, 'Open the Governance tab: all policies and what they cover')),
      values: () => {
        const gv = { ...own };
        for (const [k, x] of ins) { if (isProj) { const [lv, key] = k.split('.'); gv[lv] = GV.tidy({ ...(gv[lv] || {}), [key]: x.get() }); } else gv[k] = x.get(); }
        gv.policies = pol.get(); gv.off = off;
        return GV.tidy(gv);
      },
    };
  }

  // Governance fields shared by every object modal: governance values, tags and user-defined properties.
  // Tags inherited from a concept / entity show as ticked "↑" chips; unticking one drops it here (stored as "-tag").
  function govFields(o, kind = 'table') {
    const defs = model.governance.tags;
    const have = new Set(o.tags || []);
    const ef = SA.effective(model, o, memoOf(model)), inh = [...ef.tags.filter((x) => x.from), ...ef.dropped];
    const gs = govBox(o, kind);
    const chips = h('div', { class: 'chips' });
    const boxes = [], inhBoxes = [];
    for (const x of inh) {
      const g = defs.find((t) => t.name === x.name), cb = h('input', { type: 'checkbox', checked: !have.has('-' + x.name) });
      inhBoxes.push([x.name, cb]);
      chips.append(h('label', { class: 'chip inh', title: `Inherited from ${SA.fromText(x.from)}. Untick to drop it here (reported under Alignment until you accept it).` }, cb, '↑ ' + (g ? g.displayName || g.name : x.name)));
    }
    for (const t of defs) {
      if (inhBoxes.some(([n]) => n === t.name)) continue;
      if (!t.enabled && !have.has(t.name)) continue;
      const cb = h('input', { type: 'checkbox', checked: have.has(t.name) });
      boxes.push([t.name, cb]);
      chips.append(h('label', { class: 'chip' + (t.enabled ? '' : ' off'), title: (t.description || '') + (t.policies.length ? ` Brings ${t.policies.join(', ')}.` : '') + (t.enabled ? '' : ' (disabled)') }, cb, t.displayName || t.name));
    }
    if (!defs.length) chips.append(h('small', null, 'No tags defined yet — create them under Governance.'));
    const keys = [...new Set([...model.governance.propertyKeys, ...(() => { const s = new Set(); eachObject(model, (x) => Object.keys(x.properties || {}).forEach((k) => s.add(k))); return [...s]; })()])];
    const rows = h('div', { class: 'holders' });
    const addRow = (k, v) => rows.append(h('div', { class: 'prop' },
      h('input', { class: 'pk', placeholder: 'Property', list: 'propkeys', value: k }), h('input', { class: 'pv', placeholder: 'Value', value: v }),
      h('button', { class: 'ib', title: 'Remove', onclick: (e) => e.target.closest('.prop').remove() }, '✕')));
    Object.entries(o.properties || {}).forEach(([k, v]) => addRow(k, v));
    const inhProps = Object.entries(ef.properties).filter(([, x]) => x.from);
    return {
      el: h('div', null, gs.el,
        inhProps.length ? h('div', { class: 'field inh' }, h('span', null, 'Inherited properties'), h('small', null, 'Add the same property below to override it here.'),
          h('div', { class: 'inhp' }, inhProps.map(([k, x]) => h('div', null, h('code', null, k), ` = ${x.v} `, h('small', null, `(${SA.fromText(x.from)})`))))) : null,
        h('div', { class: 'field' }, h('span', null, 'Tags'), chips),
        h('div', { class: 'field' }, h('span', null, 'Properties'), rows, h('button', { onclick: () => addRow('', '') }, '+ Add property'),
          h('datalist', { id: 'propkeys' }, keys.map((k) => h('option', { value: k }))))),
      values: () => ({
        tags: [...(o.tags || []).filter((n) => !defs.some((t) => t.name === n) && !inhBoxes.some(([x]) => '-' + x === n)), ...boxes.filter(([, cb]) => cb.checked).map(([n]) => n),
          ...inhBoxes.filter(([, cb]) => !cb.checked).map(([n]) => '-' + n)],
        properties: Object.fromEntries([...rows.children].map((r) => [r.querySelector('.pk').value.trim(), r.querySelector('.pv').value.trim()]).filter(([k]) => k)),
        gov: gs.values(),
      }),
    };
  }

  // ---------- project ----------
  function openProject() {
    const creating = !model.project;
    const p = clone(model.project || { name: '', description: '', stakeholders: [], technology: 'PostgreSQL', methodology: 'ER - 3NF', threePart: false, tags: [], properties: {} });
    const name = h('input', { value: p.name, placeholder: 'e.g. Sales Warehouse' });
    const desc = h('textarea', { rows: 3, value: p.description });
    const tech = dropdown(Object.keys(TECH), p.technology);
    const meth = dropdown(METHODS, p.methodology);
    const three = check('Use 3-part naming (catalog.schema.table)', p.threePart);
    const hint = h('small', null);
    const syncTech = (changed) => {
      const parts = TECH[tech.value].parts;
      three.input.disabled = parts !== 3;
      if (parts !== 3) three.input.checked = false;
      else if (changed) three.input.checked = true;
      hint.textContent = parts === 3 ? `${tech.value} supports catalog.schema.table` : `${tech.value} uses schema.table (2-part naming)`;
    };
    tech.addEventListener('change', () => syncTech(true));
    syncTech(false);

    const holders = h('div', { class: 'holders' });
    const addHolder = (s) => holders.append(h('div', { class: 'holder' },
      h('input', { class: 'sn', placeholder: 'Name', value: s.name }),
      h('input', { class: 'sr', placeholder: 'Role', list: 'roles', value: s.role }),
      h('input', { class: 'se', placeholder: 'Email', type: 'email', value: s.email }),
      h('button', { class: 'ib', title: 'Remove', onclick: (e) => e.target.closest('.holder').remove() }, '✕')));
    p.stakeholders.forEach(addHolder);
    const gov = govFields(p, 'project');
    const body = h('div', null,
      field('Project name', name), field('Description', desc),
      h('div', { class: 'two' }, field('Database technology', tech), field('Methodology', meth)),
      h('div', { class: 'field' }, three.el, hint),
      creating ? h('p', { class: 'muted' }, 'Want a template (Northwind, FpML, a star schema) or Git setup? ', h('button', { class: 'lnk', onclick: () => vscode.postMessage({ type: 'newProject' }) }, 'Use the New Project wizard'), '.') : null,
      h('div', { class: 'field' }, h('span', null, 'Stakeholders'), holders,
        h('button', { onclick: () => addHolder({ name: '', role: '', email: '' }) }, '+ Add stakeholder')),
      h('datalist', { id: 'roles' }, ROLES.map((r) => h('option', { value: r }))), gov.el);

    modal(creating ? 'New project' : 'Project', body, [
      { label: 'Cancel' },
      {
        label: creating ? 'Create' : 'Save', primary: true,
        fn: () => {
          if (!name.value.trim()) return 'Project name is required.';
          const stakeholders = [...holders.children]
            .map((r) => ({ name: r.querySelector('.sn').value.trim(), role: r.querySelector('.sr').value.trim(), email: r.querySelector('.se').value.trim() }))
            .filter((s) => s.name || s.email);
          const proj = { ...p, name: name.value.trim(), description: desc.value.trim(), stakeholders, technology: tech.value, methodology: meth.value, threePart: three.input.checked, ...gov.values() };
          // The `project` block is identical in every part, so this is not an edit of one file: the same project is written into every part as its own
          // versioned edit (lib/project.js#updateProjectSettings). No local mutate() / history.
          if (indexFile) {
            model.project = proj;
            vscode.postMessage({ type: 'projectSettings', project: SM.toFile(model).project });
            render();
          } else {
            mutate(creating ? 'Create project' : 'Update project', () => {
              model.project = proj;
              const tc = TECH[proj.technology];
              if (proj.threePart && !model.catalogs.length) model.catalogs.push(SM.norm({ id: uid(), name: tc.catalog || 'main' }));
              if (!model.schemas.length) model.schemas.push(SM.norm({ id: uid(), name: tc.schema, catalogId: proj.threePart ? model.catalogs[0].id : null }));
              if (proj.threePart) for (const s of model.schemas) if (!model.catalogs.some((c) => c.id === s.catalogId)) s.catalogId = model.catalogs[0].id;
            });
            if (creating) fit();
          }
        },
      },
    ], true);
  }

  // ---------- catalog / schema ----------
  function removeTables(ids) {
    const gone = new Set(ids);
    model.tables = model.tables.filter((t) => !gone.has(t.id));
    model.relations = model.relations.filter((r) => !gone.has(r.parentId) && !gone.has(r.childId));
    model.relations.forEach((r) => { if (gone.has(r.viaId)) r.viaId = null; });
    for (const t of model.tables) for (const c of t.columns) if (c.foreignKey && gone.has(c.foreignKey.tableId)) c.foreignKey = null;
  }

  function openCatalog(c) {
    const name = h('input', { value: c ? c.name : '' });
    const disp = h('input', { value: c ? c.displayName : '', placeholder: 'Business-friendly name' });
    const desc = h('textarea', { rows: 2, value: c ? c.description : '' });
    const gov = govFields(c || {}, 'catalog');
    modal(c ? 'Edit catalog' : 'Add catalog', h('div', null, field('Catalog name', name), field('Display name', disp), field('Description', desc), gov.el), [
      { label: 'Cancel' },
      c && {
        label: 'Delete', danger: true,
        fn: () => {
          const rest = model.schemas.filter((s) => s.catalogId !== c.id);
          if (model.catalogs.length < 2) return 'At least one catalog is required.';
          if (!rest.length) return 'At least one schema is required, so this catalog cannot be deleted.';
          confirmDlg('Delete catalog', `Delete catalog "${c.name}" with its schemas and tables?`, 'Delete', () =>
            mutate('Delete catalog ' + c.name, () => {
              const gone = new Set(model.schemas.filter((s) => s.catalogId === c.id).map((s) => s.id));
              removeTables(model.tables.filter((t) => gone.has(t.schemaId)).map((t) => t.id));
              model.schemas = rest;
              model.catalogs = model.catalogs.filter((x) => x.id !== c.id);
            }));
        },
      },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim();
          if (!identOk(v)) return identRule;
          if (model.catalogs.some((x) => x !== c && x.name === v)) return 'A catalog with this name exists.';
          mutate(c ? `Edit catalog ${c.name}` : 'Add catalog ' + v, () => {
            const vals = { name: v, displayName: disp.value.trim(), description: desc.value.trim(), ...gov.values() };
            if (c) Object.assign(c, vals); else model.catalogs.push(SM.norm({ id: uid(), ...vals }));
          });
        },
      },
    ].filter(Boolean));
  }

  function openSchema(s) {
    const three = model.project.threePart;
    const name = h('input', { value: s ? s.name : '' });
    const disp = h('input', { value: s ? s.displayName : '', placeholder: 'Business-friendly name' });
    const desc = h('textarea', { rows: 2, value: s ? s.description : '' });
    const cat = dropdown(model.catalogs.map((c) => ({ value: c.id, label: c.name })), (s && s.catalogId) || model.catalogs[0]?.id);
    const gov = govFields(s || {}, 'schema');
    modal(s ? 'Edit schema' : 'Add schema', h('div', null, field('Schema name', name), field('Display name', disp), three && field('Catalog', cat), field('Description', desc), gov.el), [
      { label: 'Cancel' },
      s && {
        label: 'Delete', danger: true,
        fn: () => {
          if (model.schemas.length < 2) return 'At least one schema is required.';
          const n = model.tables.filter((t) => t.schemaId === s.id).length;
          confirmDlg('Delete schema', `Delete schema "${s.name}"${n ? ` and its ${n} table(s)` : ''}?`, 'Delete', () =>
            mutate('Delete schema ' + s.name, () => {
              removeTables(model.tables.filter((t) => t.schemaId === s.id).map((t) => t.id));
              model.schemas = model.schemas.filter((x) => x !== s);
            }));
        },
      },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim();
          const catalogId = three ? cat.value : null;
          if (!identOk(v)) return identRule;
          if (model.schemas.some((x) => x !== s && x.name === v && x.catalogId === catalogId)) return 'A schema with this name exists.';
          mutate(s ? `Edit schema ${s.name}` : 'Add schema ' + v, () => {
            const vals = { name: v, catalogId, displayName: disp.value.trim(), description: desc.value.trim(), ...gov.values() };
            if (s) Object.assign(s, vals); else model.schemas.push(SM.norm({ id: uid(), ...vals }));
          });
        },
      },
    ].filter(Boolean));
  }

  // ---------- table ----------
  const at = (x, y) => ({ x, y, pos: { [level]: { x, y } } }); // a new object's place on the current level (x, y and its saved position)
  function placeNew(schemaId) {
    if (SA.view(model, level)) return {}; // tables are not drawn on this level: placed when the physical level is shown
    const mine = model.tables.filter((t) => t.schemaId === schemaId);
    const all = model.tables;
    if (!all.length) return at(0, 0);
    const bottom = (ts) => Math.max(...ts.map((t) => t.y + H(t)));
    const left = (ts) => Math.min(...ts.map((t) => t.x));
    return mine.length ? at(left(mine), bottom(mine) + 50) : at(left(all), bottom(all) + 140);
  }
  // a new concept / entity goes under the others when its level is on screen (elsewhere it is placed when that level is shown)
  function placeNode(lv) {
    if (lv !== level) return {};
    const ns = lv === 'conceptual' ? model.concepts : lv === 'semantic' ? model.metrics : model.entities;
    SA.view(model, lv);
    if (!ns.length || ns.some((n) => typeof n.x !== 'number')) return at(0, 0);
    return at(Math.min(...ns.map((n) => n.x)), Math.max(...ns.map((n) => n.y + H(n))) + 50);
  }

  // ---------- domain routing for a split project (project-index file only) ----------
  // A table / entity / metric's "Domain" field is its `homeDomain` (lib/project.js#homeParts reads it, ADR-0045 R10 / R11). A concept's domain lives in
  // the manifest, so it is queued and sent with the edit (persistProject()). Shown only once at least one domain already has a part on disk.
  const slugify = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''); // mirrors lib/project.js#slug
  const homePartNames = () => new Set((embedParts || []).map((p) => p.name));
  function domainOptions(withShared) {
    const parts = homePartNames();
    const opts = (model.domains || []).filter((d) => parts.has(slugify(d.name))).map((d) => ({ value: d.name, label: d.name }));
    if (parts.has('_unassigned')) opts.push({ value: '_unassigned', label: 'Unassigned' });
    if (withShared && parts.has('_shared')) opts.push({ value: '_shared', label: 'Shared' });
    return opts;
  }
  // o: the existing table/entity/metric being edited, or null when creating one. apply(obj) writes the choice onto obj.ext.homeDomain (or
  // clears it) — called once the real object exists (a new one only gets its id/position once mutate() itself runs).
  function domainField(o, withShared) {
    const opts = domainOptions(withShared);
    if (!indexFile || !opts.length) return null;
    const cur = (o && o.ext && o.ext.homeDomain) || '';
    const sel = dropdown([{ value: '', label: '— use the usual rule (based on what it is linked to) —' }, ...opts], cur);
    return {
      el: field('Domain', sel, 'Which part this is saved into.'),
      apply: (obj) => { const v = sel.value, ext = { ...(obj.ext || {}) }; if (v) ext.homeDomain = v; else delete ext.homeDomain; obj.ext = Object.keys(ext).length ? ext : undefined; },
    };
  }
  // c: the existing concept, or null when creating one. apply(name) queues the FINAL concept name (after a possible rename) with its chosen
  // domain; lib/project.js#applyProjectEdit reconciles it (removed from every domain, added to the one named, unless '_unassigned'/none).
  function conceptDomainField(c) {
    const parts = homePartNames(), doms = (model.domains || []).filter((d) => parts.has(slugify(d.name)));
    if (!indexFile || !doms.length) return null;
    const cur = c && doms.find((d) => (d.concepts || []).some((n) => n.toLowerCase() === c.name.toLowerCase()));
    const sel = dropdown([{ value: '_unassigned', label: 'Unassigned' }, ...doms.map((d) => ({ value: d.name, label: d.name }))], cur ? cur.name : '_unassigned');
    return { el: field('Domain', sel, 'Which part this concept (and what realises it) is saved into.'), apply: (name) => { queuedConceptDomains[name] = sel.value; } };
  }

  // t: existing table/view or null. presetKind: 'table' | 'view' for new objects.
  function openTable(t, preSchema, presetKind) {
    const kind0 = t ? (t.kind === 'view' ? 'view' : 'table') : presetKind || 'table';
    const kindSel = dropdown([{ value: 'table', label: 'Table' }, { value: 'view', label: 'View' }], kind0);
    const name = h('input', { value: t ? t.name : `${kind0}_${model.tables.length + 1}` });
    const ef = t ? SA.effective(model, t) : null, inhD = ef && ef.description && ef.description.from ? ef.description : null;
    const disp = h('input', { value: t ? t.displayName : '', placeholder: ef && ef.displayName && ef.displayName.from ? `${ef.displayName.v} (from ${SA.fromText(ef.displayName.from)})` : 'e.g. Customer' });
    const desc = h('textarea', { rows: 3, value: t ? t.description : '', placeholder: inhD ? `Inherited from ${SA.fromText(inhD.from)}: ${inhD.v}` : '' });
    const ents = entityPicker(t ? t.entityIds || [] : []);
    const schema = dropdown(model.schemas.map((x) => ({ value: x.id, label: schemaLabel(x, model) })), (t && t.schemaId) || preSchema || model.schemas[0].id);
    const vtype = dropdown([{ value: 'view', label: 'View' }, { value: 'temporary', label: 'Temporary view' }, { value: 'materialized', label: 'Materialized view' }], (t && t.viewType) || 'view');
    const defn = h('textarea', { rows: 6, class: 'code', value: t ? t.definition || '' : '', placeholder: 'SELECT …' });
    const viewBox = h('div', null, field('View type', vtype), field('View definition (SQL)', defn));
    const sync = () => { viewBox.hidden = kindSel.value !== 'view'; };
    kindSel.addEventListener('change', sync); sync();
    const slaFreq = dropdown([{ value: '', label: 'No SLA' }, { value: 'exclude', label: 'Out of SLA (static / reference data)' }, ...OR.FREQ.map((f) => ({ value: f, label: f[0].toUpperCase() + f.slice(1) }))], t && t.sla ? (t.sla.exclude ? 'exclude' : t.sla.frequency) : '');
    const slaTime = h('input', { value: (t && t.sla && t.sla.time) || '', placeholder: 'HH:MM, 24-hour', maxlength: 5 });
    const slaTimeField = field('Available by', slaTime, 'Clock time each cycle when the data is ready');
    const slaHelp = h('small', { class: 'muted' });
    const syncSla = () => { slaTimeField.hidden = !OR.CLOCK.has(slaFreq.value); slaHelp.textContent = slaFreq.value === 'exclude' ? 'Left out of SLA and load-time calculations (it still appears in the load order). Use it for tables that are not refreshed on a schedule.' : slaFreq.value ? '' : 'Optional. Set how often the data is refreshed and when it is available.'; };
    slaFreq.addEventListener('change', syncSla); syncSla();
    const gov = govFields(t || {}, 'table');
    const dom = domainField(t);
    const noun = () => (kindSel.value === 'view' ? 'view' : 'table');
    modal(t ? `Edit ${kind0}` : `Add ${kind0}`, h('div', null,
      h('div', { class: 'two' }, field('Name', name), field('Type', kindSel)), field('Display name', disp), field('Schema', schema), ents && ents.el, field('Description', desc, inhD ? 'Empty = inherited (shown greyed). Type to override it here.' : ''), viewBox, h('div', { class: 'two' }, field('Data availability SLA', slaFreq), slaTimeField), slaHelp, dom && dom.el, gov.el), [
      { label: 'Cancel' },
      t && {
        label: 'Delete', danger: true,
        fn: () => confirmDlg(`Delete ${kind0}`, `Delete ${kind0} "${t.name}"? Relationships to it will be removed.`, 'Delete', () =>
          mutate(`Delete ${kind0} ${t.name}`, () => { removeTables([t.id]); if (selected === t.id) selected = null; })),
      },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim();
          if (!identOk(v)) return identRule;
          if (model.tables.some((x) => x !== t && x.name === v && x.schemaId === schema.value)) return 'A table or view with this name exists in that schema.';
          const isView = kindSel.value === 'view';
          const sla = slaFreq.value === 'exclude' ? { exclude: true } : slaFreq.value ? { frequency: slaFreq.value, ...(OR.CLOCK.has(slaFreq.value) ? { time: slaTime.value.trim() } : {}) } : undefined;
          const bad = OR.slaProblem(sla);
          if (bad) return bad;
          mutate(t ? `Edit ${noun()} ${t.name}` : `Add ${noun()} ${v}`, () => {
            const vals = {
              name: v, kind: isView ? 'view' : 'table', viewType: isView ? vtype.value : 'view', definition: isView ? defn.value.trim() : '',
              schemaId: schema.value, displayName: disp.value.trim(), description: desc.value.trim(), sla, ...gov.values(), ...(ents ? { entityIds: ents.ids() } : {}),
            };
            let target = t;
            if (t) Object.assign(t, vals);
            else {
              const nt = SM.norm({ id: uid(), ...vals, pos: {}, ...placeNew(schema.value), columns: [] });
              model.tables.push(nt);
              selected = nt.id;
              target = nt;
            }
            if (dom) dom.apply(target);
          });
        },
      },
    ].filter(Boolean), true);
  }

  // ---------- column ----------
  function openColumn(t, c) {
    const tc = techOf(model);
    const name = h('input', { value: c ? c.name : `column_${t.columns.length + 1}` });
    const disp = h('input', { value: c ? c.displayName : '', placeholder: 'e.g. Customer Name' });
    const types = tc.types.includes(c?.dataType) || !c ? tc.types : [c.dataType, ...tc.types];
    const type = dropdown(types, c ? c.dataType : tc.types.find((x) => /^varchar|^VARCHAR|^STRING/.test(x)) || tc.types[0]);
    const desc = h('textarea', { rows: 2, value: c ? c.description : '' });
    const pk = check('Primary key', c?.primaryKey), nn = check('Non null', c?.notNull), uq = check('Unique', c?.unique);
    const def = h('input', { value: c ? c.default || '' : '', placeholder: 'e.g. 0, now(), \'n/a\'' });
    const fkOpts = [{ value: '', label: '— none —' }];
    for (const ot of model.tables) for (const oc of ot.columns) if (oc !== c) fkOpts.push({ value: ot.id + '|' + oc.id, label: `${fullName(ot, model)}.${oc.name}` });
    const fk = dropdown(fkOpts, c && c.foreignKey ? c.foreignKey.tableId + '|' + c.foreignKey.columnId : '');
    const card = dropdown(['1..1', '1..M'], (c && c.foreignKey && c.foreignKey.cardinality) || '1..M');
    const syncFk = () => { card.disabled = !fk.value; };
    fk.addEventListener('change', syncFk); syncFk();
    pk.input.addEventListener('change', () => { if (pk.input.checked) nn.input.checked = true; });
    const gov = govFields(c || {}, 'column');

    const body = h('div', null,
      h('div', { class: 'two' }, field('Column name', name, 'No spaces'), field('Display name', disp)),
      field('Data type', type), field('Description', desc),
      h('div', { class: 'checks' }, pk.el, nn.el, uq.el),
      field('Default value', def),
      h('div', { class: 'two' }, field('Foreign key → references', fk), field('Cardinality (parent..child)', card)), gov.el);
    modal(c ? `Edit column · ${t.name}.${c.name}` : `Add column · ${t.name}`, body, [
      { label: 'Cancel' },
      c && {
        label: 'Delete', danger: true,
        fn: () => mutate('Delete column ' + t.name + '.' + c.name, () => {
          t.columns = t.columns.filter((x) => x !== c);
          for (const ot of model.tables) for (const oc of ot.columns) if (oc.foreignKey && oc.foreignKey.columnId === c.id) oc.foreignKey = null;
        }),
      },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim();
          if (!v || /\s/.test(v)) return 'Column name is required and cannot contain spaces.';
          if (t.columns.some((x) => x !== c && x.name === v)) return 'A column with this name exists.';
          const [ft, fc] = fk.value ? fk.value.split('|') : [];
          const next = {
            name: v, displayName: disp.value.trim(), dataType: type.value, description: desc.value.trim(),
            primaryKey: pk.input.checked, notNull: nn.input.checked || pk.input.checked, unique: uq.input.checked,
            default: def.value.trim(), foreignKey: ft ? { tableId: ft, columnId: fc, cardinality: card.value } : null, ...gov.values(),
          };
          mutate(c ? `Edit column ${t.name}.${c.name}` : `Add column ${t.name}.${v}`, () => {
            if (c) Object.assign(c, next); else t.columns.push(SM.norm({ id: uid(), ...next }));
          });
        },
      },
    ].filter(Boolean), true);
  }

  // ---------- concepts and entities (conceptual / logical layers, ADR-0032) ----------
  const openNode = (t) => (t.layer === 'concept' ? openConcept(t) : t.layer === 'entity' ? openEntity(t) : t.layer === 'metric' ? openMetric(t) : openTable(t));
  const byName = (a, b) => a.name.localeCompare(b.name);
  // which logical entities a table realises (usually one; several for a One Big Table or a wide dimension)
  function entityPicker(ids) {
    if (!model.entities.length) return null;
    const boxes = [...model.entities].sort(byName).map((e) => [e.id, h('input', { type: 'checkbox', checked: ids.includes(e.id) })]);
    const chips = boxes.map(([id, cb]) => h('label', { class: 'chip' }, cb, model.entities.find((e) => e.id === id).name));
    // ticked entities stay visible while filtering; Enter ticks the first match, Esc clears before it closes the dialog
    const filter = () => { const s = q.value.trim().toLowerCase(); chips.forEach((c, i) => { c.style.display = !s || boxes[i][1].checked || c.textContent.toLowerCase().includes(s) ? '' : 'none'; }); };
    const q = boxes.length > 6 && h('input', {
      type: 'search', class: 'entq', placeholder: `Search ${boxes.length} entities…`, oninput: filter,
      onkeydown: (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); const i = chips.findIndex((c, j) => c.style.display !== 'none' && !boxes[j][1].checked); if (q.value && i >= 0) { boxes[i][1].checked = true; q.value = ''; filter(); } }
        else if (ev.key === 'Escape' && q.value) { ev.stopPropagation(); q.value = ''; filter(); }
      },
    });
    return {
      el: h('div', { class: 'field' }, h('span', null, 'Realises logical entity'), q || null, h('div', { class: 'chips ents' }, chips),
        h('small', null, 'Usually one. Tick several for a table that combines entities (One Big Table, wide dimension); the first ticked is the main one.')),
      ids: () => { const on = boxes.filter(([, cb]) => cb.checked).map(([id]) => id); return [...ids.filter((x) => on.includes(x)), ...on.filter((x) => !ids.includes(x))]; },
    };
  }
  const mergeField = (list, o, noun) => {
    const others = list.filter((x) => x !== o).sort(byName);
    return others.length ? dropdown([{ value: '', label: '— keep separate —' }, ...others.map((x) => ({ value: x.id, label: x.name }))], '') : null;
  };
  const nameClash = (list, o, v) => list.some((x) => x !== o && x.name.toLowerCase() === v.toLowerCase());

  function openConcept(c) {
    const name = h('input', { value: c ? c.name : '', placeholder: 'e.g. Customer' });
    const desc = h('textarea', { rows: 3, value: c ? c.description : '', placeholder: 'Business definition, e.g. "A person or company that buys from us."' });
    const gov = govFields(c || {}, 'concept'), merge = c && mergeField(model.concepts, c), es = c ? SA.entitiesOf(model, c) : [];
    const dom = !merge && conceptDomainField(c); // no domain picker while merging: the concept is about to disappear into another one
    modal(c ? 'Edit concept' : 'Add concept', h('div', null,
      h('p', { class: 'muted' }, 'A business concept (conceptual level). Its description, tags and properties are inherited by its logical entities and their tables.'),
      field('Concept name', name, 'The business name; spaces are fine'), field('Description', desc),
      c ? h('p', { class: 'muted' }, es.length ? `Logical entities: ${es.map((e) => e.name).join(', ')}` : 'No logical entity yet: link one from an entity dialog or under Alignment → Mapping.') : null,
      dom && dom.el, gov.el, merge ? field('Merge into another concept', merge, 'Moves its entities and relationships there, then removes this concept') : null), [
      { label: 'Cancel' },
      c && { label: 'Delete', danger: true, fn: () => confirmDlg('Delete concept', `Delete concept "${c.name}"? Its entities stay, without a concept, and its relationships go.`, 'Delete', () => mutate('Delete concept ' + c.name, () => SA.remove(model, 'concept', c.id))) },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim(), into = merge && merge.value && model.concepts.find((x) => x.id === merge.value);
          if (!v) return 'A concept needs a name.';
          if (nameClash(model.concepts, c, v)) return 'A concept with this name exists.';
          const first = !model.concepts.length;
          mutate(into ? `Merge concept ${c.name} into ${into.name}` : c ? `Edit concept ${c.name}` : 'Add concept ' + v, () => {
            const vals = { name: v, description: desc.value.trim(), ...gov.values() };
            if (c) { Object.assign(c, vals); if (into) SA.mergeInto(model, 'concept', c.id, into.id); } else model.concepts.push(SM.norm({ id: uid(), ...vals, pos: {}, ...placeNode('conceptual') }));
            if (dom) dom.apply(v);
          });
          if (first && level === 'conceptual') fit();
        },
      },
    ].filter(Boolean), true);
  }

  function openEntity(e) {
    const name = h('input', { value: e ? e.name : '', placeholder: 'e.g. Customer Address' });
    const NEW = '+new';
    const con = dropdown([{ value: '', label: '— no concept —' }, ...[...model.concepts].sort(byName).map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: '+ New concept with the same name' }], (e && e.conceptId) || '');
    const ef = e ? SA.effective(model, e) : null, inhD = ef && ef.description && ef.description.from ? ef.description : null;
    const desc = h('textarea', { rows: 3, value: e ? e.description : '', placeholder: inhD ? `Inherited from ${SA.fromText(inhD.from)}: ${inhD.v}` : 'What one instance of it is, e.g. "A postal address of a customer."' });
    const gov = govFields(e || {}, 'entity'), merge = e && mergeField(model.entities, e), ts = e ? SA.tablesOf(model, e) : [];
    const dom = !merge && domainField(e); // release 2 part 10: overrides what it would otherwise take from its concept (or _unassigned)
    const R = SM.refs(model);
    modal(e ? 'Edit entity' : 'Add entity', h('div', null,
      h('p', { class: 'muted' }, 'A logical entity: one business thing with its own identity, realised physically by one or more tables. It inherits from its concept.'),
      h('div', { class: 'two' }, field('Entity name', name, 'Business name; spaces are fine'), field('Concept', con)),
      field('Description', desc, inhD ? 'Empty = inherited from the concept.' : ''),
      e ? h('p', { class: 'muted' }, ts.length ? `Realised by ${ts.map((t) => R.tab.get(t.id)).join(', ')}` : 'No table realises it yet: tick it in a table dialog or map tables under Alignment → Mapping.') : null,
      dom && dom.el, gov.el, merge ? field('Merge into another entity', merge, 'Moves its tables and relationships there, then removes this entity') : null), [
      { label: 'Cancel' },
      e && { label: 'Delete', danger: true, fn: () => confirmDlg('Delete entity', `Delete entity "${e.name}"? Its tables stay, unmapped, and its logical relationships go.`, 'Delete', () => mutate('Delete entity ' + e.name, () => SA.remove(model, 'entity', e.id))) },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim(), into = merge && merge.value && model.entities.find((x) => x.id === merge.value);
          if (!v) return 'An entity needs a name.';
          if (nameClash(model.entities, e, v)) return 'An entity with this name exists.';
          if (con.value === NEW && nameClash(model.concepts, null, v)) return 'A concept with this name exists already: pick it in the list.';
          const first = !model.entities.length;
          mutate(into ? `Merge entity ${e.name} into ${into.name}` : e ? `Edit entity ${e.name}` : 'Add entity ' + v, () => {
            let conceptId = con.value || null;
            if (conceptId === NEW) { const c = SM.norm({ id: uid(), name: v, pos: {}, ...placeNode('conceptual') }); model.concepts.push(c); conceptId = c.id; }
            const vals = { name: v, conceptId, description: desc.value.trim(), ...gov.values() };
            let target = e;
            if (e) { Object.assign(e, vals); if (into) SA.mergeInto(model, 'entity', e.id, into.id); }
            else { target = SM.norm({ id: uid(), ...vals, pos: {}, ...placeNode('logical') }); model.entities.push(target); }
            if (dom) dom.apply(target);
          });
          if (first && level === 'logical') fit();
        },
      },
    ].filter(Boolean), true);
  }

  // a relationship between concepts (conceptual level) or entities (logical level); r: existing, preset: {parentId, childId} from a drag
  function openLayerRelation(r, preset) {
    const con = level === 'conceptual', list = con ? model.concepts : model.entities, rels = con ? 'crels' : 'lrels', noun = con ? 'concept' : 'entity';
    if (list.length < 2 && !r) return toast(`Add at least two ${con ? 'concepts' : 'entities'} first.`);
    const opts = [...list].sort(byName).map((x) => ({ value: x.id, label: x.name }));
    const parent = dropdown(opts, r ? r.parentId : preset ? preset.parentId : opts[0].value);
    const child = dropdown(opts, r ? r.childId : preset ? preset.childId : opts[1].value);
    const card = dropdown([...(con ? [{ value: '', label: '— not specified —' }] : []), ...CARDS], r ? r.cardinality : con ? '' : '1..M');
    const nm = h('input', { value: r ? r.name : '', placeholder: con ? 'A business verb, e.g. places' : 'Label shown on the line, e.g. places' });
    const desc = h('textarea', { rows: 3, value: r ? r.description : '', placeholder: 'e.g. "A customer places many orders."' });
    const what = con ? 'conceptual' : 'logical';
    modal(r ? `${con ? 'Conceptual' : 'Logical'} relationship` : `Add ${what} relationship`, h('div', null,
      h('div', { class: 'two' }, field(`Parent ${noun}`, parent), field(`Child ${noun}`, child)),
      field('Cardinality (parent..child)', card, con ? 'Optional at the conceptual level.' : '1..M: one parent, many children. M..M needs a bridge table physically.'),
      field(con ? 'Verb' : 'Label', nm), field('Description', desc)), [
      { label: 'Cancel' },
      r && { label: 'Delete', danger: true, fn: () => mutate(`Delete ${what} relationship`, () => { model[rels] = model[rels].filter((x) => x !== r); }) },
      {
        label: 'Save', primary: true,
        fn: () => {
          const twins = model[rels].filter((x) => x !== r && x.parentId === parent.value && x.childId === child.value), label = nm.value.trim().toLowerCase();
          if (twins.some((x) => (x.name || '').trim().toLowerCase() === label)) return label ? 'A relationship with this label exists between these two already.' : 'This relationship exists already. To add a second one between the same pair (billing and shipping address, say), give each its own label.';
          if (twins.length && !label) return 'Give this relationship a label to tell it apart from the other one between the same pair (for example billing or shipping).';
          mutate(r ? `Edit ${what} relationship` : `Add ${what} relationship`, () => {
            const vals = { parentId: parent.value, childId: child.value, cardinality: card.value, name: nm.value.trim(), description: desc.value.trim() };
            if (r) Object.assign(r, vals); else model[rels].push({ id: uid(), ...vals });
          });
        },
      },
    ].filter(Boolean), true);
  }

  // ---------- metrics (semantic level, ADR-0037) ----------
  const AGGS = [['', '— not set —'], ['sum', 'Sum'], ['count', 'Count'], ['count_distinct', 'Count distinct'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['none', 'None: non-additive (ratios, derived metrics)']];
  function openMetric(x) {
    if (!model.project) return;
    const name = h('input', { value: x ? x.name : '', placeholder: 'e.g. Revenue' });
    const desc = h('textarea', { rows: 3, value: x ? x.description : '', placeholder: 'What it means for the business, e.g. "Sales value of order lines after discount."' });
    const calc = h('textarea', { rows: 3, class: 'code', value: x ? x.calculation : '', placeholder: 'order_details.unit_price * order_details.quantity   or   {Revenue} / {Order Count}' });
    const agg = dropdown(AGGS.map(([value, label]) => ({ value, label })), x ? x.aggregation : '');
    const R = SM.refs(model), have = new Set(x ? x.grain : []), ents = [...model.entities].sort(byName);
    const gBoxes = ents.map((e) => [e.name, h('input', { type: 'checkbox', checked: have.has(e.name) })]);
    const gOther = h('input', { value: [...have].filter((g) => !ents.some((e) => e.name === g)).join(', '), placeholder: ents.length ? 'Tables, comma separated (optional)' : 'Entities or tables, comma separated, e.g. order_details', list: 'grainrefs' });
    const reads = h('small', { class: 'muted calcnote' });
    const preview = () => {
      const r = SM.metricRefs(model, { id: x ? x.id : null, name: name.value, calculation: calc.value });
      reads.textContent = (r.columns.size || r.metrics.size ? 'Reads ' + [...[...r.columns].map((id) => R.col.get(id)), ...[...r.metrics].map((id) => `{${model.metrics.find((y) => y.id === id).name}}`)].join(', ') + '. ' : '') +
        (r.missing.length ? 'Not found: ' + r.missing.map((q) => q.ref).join(', ') + '. ' : '') + 'Write columns as table.column (schema.table.column when a name is not unique) and other metrics as {Metric name}.';
    };
    calc.addEventListener('input', preview); preview();
    const gov = govFields(x || {}, 'metric');
    const dom = domainField(x, true); // release 2 part 10: a metric may also be homeDomain: "_shared" (the literal split()/homeParts fallback)
    modal(x ? 'Edit metric' : 'Add metric', h('div', null,
      h('p', { class: 'muted' }, 'A metric (semantic level): what a number means, how it is calculated from table columns and at which grain it is valid. Impact analysis shows the metrics a column change breaks.'),
      h('div', { class: 'two' }, field('Metric name', name, 'Business name; spaces are fine'), field('Aggregation', agg, 'Applied to the calculation')),
      field('Definition', desc), field('Calculation', calc), reads,
      h('div', { class: 'field' }, h('span', null, 'Grain: the entities or tables it is valid at'), gBoxes.length ? h('div', { class: 'chips ents' }, gBoxes.map(([n, cb]) => h('label', { class: 'chip' }, cb, n))) : null, gOther,
        h('datalist', { id: 'grainrefs' }, model.tables.map((t) => h('option', { value: R.tab.get(t.id) })))),
      dom && dom.el, gov.el), [
      { label: 'Cancel' },
      x && { label: 'Delete', danger: true, fn: () => confirmDlg('Delete metric', `Delete metric "${x.name}"? Metrics built on it keep their calculation and are reported under Alignment.`, 'Delete', () => mutate('Delete metric ' + x.name, () => { model.metrics = model.metrics.filter((y) => y !== x); if (selected === x.id) selected = null; })) },
      {
        label: 'Save', primary: true,
        fn: () => {
          const v = name.value.trim();
          if (!v || /[{}]/.test(v)) return 'A metric needs a name without { or }.';
          if (nameClash(model.metrics, x, v)) return 'A metric with this name exists.';
          const grain = [...gBoxes.filter(([, cb]) => cb.checked).map(([n]) => n), ...gOther.value.split(',').map((g) => g.trim()).filter(Boolean)];
          const first = !model.metrics.length;
          mutate(x ? `Edit metric ${x.name}` : 'Add metric ' + v, () => {
            const vals = { name: v, description: desc.value.trim(), calculation: calc.value.trim(), aggregation: agg.value, grain, ...gov.values() };
            if (x && x.name !== v) { // a rename follows into the metrics built on it
              const re = new RegExp('\\{\\s*' + x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}', 'gi');
              model.metrics.forEach((y) => { if (y !== x) y.calculation = y.calculation.replace(re, `{${v}}`); });
            }
            let target = x;
            if (x) Object.assign(x, vals); else { target = SM.norm({ id: uid(), ...vals, pos: {}, columns: [], ...placeNode('semantic') }); model.metrics.push(target); selected = target.id; }
            if (dom) dom.apply(target);
          });
          if (first && level === 'semantic') fit();
        },
      },
    ].filter(Boolean), true);
  }

  // ---------- relationships ----------
  // Physically an M..M relationship needs a bridge table: create it (composite PK, one FK to each side) and link it.
  function createBridge(r) {
    const p = model.tables.find((x) => x.id === r.parentId), c = model.tables.find((x) => x.id === r.childId);
    const tc = techOf(model);
    const schemaId = c.schemaId;
    let name = `${p.name}_${c.name}`, n = 2;
    while (model.tables.some((x) => x.schemaId === schemaId && x.name === name)) name = `${p.name}_${c.name}_${n++}`;
    const key = (t) => t.columns.find((x) => x.primaryKey) || t.columns[0];
    const mk = (t) => {
      const k = key(t);
      return SM.norm({ id: uid(), name: `${t.name}_${k ? k.name : 'id'}`, dataType: k ? k.dataType : tc.types[0], primaryKey: true, notNull: true, unique: false, default: '',
        foreignKey: k ? { tableId: t.id, columnId: k.id, cardinality: '1..M', name: '', description: '' } : null });
    };
    const cols = [mk(p), mk(c)];
    if (cols[0].name === cols[1].name) cols[1].name += '_2';
    const bt = SM.norm({ id: uid(), name, kind: 'table', viewType: 'view', definition: '', schemaId, description: `Bridge table for ${p.name} ↔ ${c.name}`, pos: {}, columns: cols, ...placeNew(schemaId) });
    model.tables.push(bt);
    r.viaId = bt.id;
    if (r.ext) delete r.ext.via; // a bridge kept by name from another part (model.js) gives way to the new one
  }

  // item: an edge from relItems() (kind 'fk' | 'rel'), or null to create a table-level relationship.
  // preset: {parentId, childId} for a new relationship (e.g. dragged between conceptual entities).
  function openRelation(item, preset) {
    const tables = model.tables.map((t) => ({ value: t.id, label: fullName(t, model) }));
    const nm = h('input', { placeholder: 'Label shown on the line, e.g. places' });
    const desc = h('textarea', { rows: 3, placeholder: 'Describe the relationship in words, e.g. "A customer places many orders."' });
    if (item && item.kind === 'fk') {
      const t = model.tables.find((x) => x.id === item.t.id), c = t.columns.find((x) => x.id === item.col.id);
      const p = model.tables.find((x) => x.id === c.foreignKey.tableId);
      const card = dropdown(CARDS, c.foreignKey.cardinality || '1..M');
      nm.value = c.foreignKey.name || ''; desc.value = c.foreignKey.description || '';
      modal('Relationship', h('div', null,
        h('p', { class: 'muted' }, `${t.name}.${c.name}  →  ${p.name}.${p.columns.find((x) => x.id === c.foreignKey.columnId).name}`),
        field('Label', nm), field('Description', desc),
        field('Cardinality (parent..child)', card, '1..M: one parent row, many child rows. 1..1: at most one child row. M..M turns this foreign key into a table-level relationship (physically it needs a bridge table).')), [
        { label: 'Cancel' },
        { label: 'Delete', danger: true, fn: () => mutate(`Delete relationship ${t.name}.${c.name}`, () => { c.foreignKey = null; }) },
        {
          label: 'Save', primary: true,
          fn: () => mutate(`Edit relationship ${t.name}.${c.name}`, () => {
            const vals = { name: nm.value.trim(), description: desc.value.trim() };
            if (card.value === 'M..M') { c.foreignKey = null; model.relations.push({ id: uid(), parentId: p.id, childId: t.id, cardinality: 'M..M', viaId: null, ...vals }); }
            else Object.assign(c.foreignKey, { cardinality: card.value, ...vals });
          }),
        },
      ], true);
      return;
    }
    if (tables.length < 2 && !item) return toast('Add at least two tables first.');
    const r = item ? item.rel : null;
    const parent = dropdown(tables, r ? r.parentId : (preset && preset.parentId) || tables[0].value);
    const child = dropdown(tables, r ? r.childId : (preset && preset.childId) || tables[1].value);
    const card = dropdown(CARDS, r ? r.cardinality : 'M..M');
    if (r) { nm.value = r.name || ''; desc.value = r.description || ''; }
    const via = r && r.viaId && model.tables.find((x) => x.id === r.viaId);
    modal(r ? 'Table relationship' : 'Add table relationship', h('div', null,
      h('div', { class: 'two' }, field('Parent table', parent), field('Child table', child)),
      field('Cardinality (parent..child)', card, 'Table-level relationships need no columns. M..M is the classic many-to-many.'),
      field('Label', nm), field('Description', desc),
      via ? h('p', { class: 'muted' }, `Realised physically by bridge table ${fullName(via, model)} (shown on the physical and logical levels).`) : null), [
      { label: 'Cancel' },
      r && { label: 'Delete', danger: true, fn: () => mutate('Delete table relationship', () => { model.relations = model.relations.filter((x) => x !== r); }) },
      r && r.cardinality === 'M..M' && !r.viaId && { label: 'Create bridge table', fn: () => mutate('Create bridge table for ' + fullName(model.tables.find((x) => x.id === r.parentId), model) + ' ↔ ' + model.tables.find((x) => x.id === r.childId).name, () => createBridge(r)) },
      {
        label: 'Save', primary: true,
        fn: () => {
          mutate(r ? 'Edit table relationship' : 'Add table relationship', () => {
            const vals = { parentId: parent.value, childId: child.value, cardinality: card.value, name: nm.value.trim(), description: desc.value.trim() };
            if (r) Object.assign(r, vals); else model.relations.push({ id: uid(), viaId: null, ...vals });
          });
        },
      },
    ].filter(Boolean), true);
  }

  // ---------- tags (the toolbar's tag icon): generic labels; a tag may bring policies (ADR-0038) ----------
  function openTags() {
    const draft = clone(model.governance.tags);
    draft.forEach((t) => { t._orig = t.name; });
    const usage = (name) => { let n = 0; eachObject(model, (o) => { if ((o.tags || []).includes(name)) n++; }); return n; };
    const list = h('div', { class: 'gov' });
    const keys = h('textarea', { rows: 2, value: model.governance.propertyKeys.join(', '), placeholder: 'organization_unit, source_system' });
    const renderList = () => fill(list,
      h('div', { class: 'grow4 gh' }, h('span', null, 'Tag'), h('span', null, 'Brings policies'), h('span', null, 'On'), h('span', null, '')),
      ...(draft.length ? draft.map((t, i) => h('div', { class: 'grow4' + (t.enabled ? '' : ' off') },
        h('span', { title: t.description }, h('b', null, t.displayName || t.name), h('small', null, ` ${t.name} · used ${usage(t._orig)}×${t.owner ? ' · ' + t.owner : ''}`)),
        h('span', null, t.policies.length ? t.policies.join(', ') : '—'),
        h('input', { type: 'checkbox', checked: t.enabled, title: 'Enable / disable', onchange: (e) => { t.enabled = e.target.checked; renderList(); } }),
        h('span', null, h('button', { onclick: () => editTag(t) }, 'Edit'), ' ', h('button', { class: 'ib', title: 'Delete', onclick: () => { draft.splice(i, 1); renderList(); } }, '✕'))))
        : [h('p', { class: 'muted' }, 'No tags yet. A tag is a label (Personal Data, Financial, Certified) you can put on anything.')]));
    const editTag = (t) => {
      const isNew = !t;
      const name = h('input', { value: t ? t.name : '', placeholder: 'e.g. pii' });
      const disp = h('input', { value: t ? t.displayName : '', placeholder: 'e.g. Personal Data' });
      const desc = h('textarea', { rows: 2, value: t ? t.description : '' });
      const owner = h('input', { value: t ? t.owner : '' }), domain = h('input', { value: t ? t.domain : '' });
      const pol = policyPicker(t ? t.policies : []);
      const en = check('Enabled', t ? t.enabled : true);
      modal(isNew ? 'Create tag' : 'Edit tag', h('div', null, field('Tag name', name), field('Display name', disp), field('Description', desc),
        h('div', { class: 'two' }, field('Owner', owner), field('Domain', domain)),
        h('div', { class: 'field' }, h('span', null, 'Brings policies'), pol.el, h('small', null, 'Anything carrying this tag gets these policies (and their parents), for example Personal Data → GDPR.')), h('div', { class: 'field' }, en.el)), [
        { label: 'Cancel' },
        { label: 'Save', primary: true, fn: () => {
          const v = name.value.trim();
          if (!identOk(v)) return identRule;
          if (draft.some((x) => x !== t && x.name === v)) return 'A tag with this name exists.';
          const vals = { name: v, displayName: disp.value.trim(), description: desc.value.trim(), owner: owner.value.trim(), domain: domain.value.trim(), policies: pol.get(), enabled: en.input.checked };
          if (isNew) draft.push({ ...vals, _orig: v }); else Object.assign(t, vals);
          renderList();
        } },
      ]);
    };
    renderList();
    modal('Tags', h('div', null, h('p', { class: 'muted' }, 'Tags are labels you can put on anything: project, catalogs, schemas, tables, columns, concepts, entities, metrics. A tag can bring policies with it; the policies themselves live in the Governance tab.'),
      list, h('button', { class: 'primary', onclick: () => editTag(null) }, '+ Create tag'),
      field('Property keys', keys, 'Suggested keys for user-defined properties (comma separated).')), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, fn: () => {
        // In the project-index file, creating / editing a tag writes to governance.json (its own versioned stream). Renaming a tag does not rewrite the
        // objects in other parts that carry it, a known narrow gap like attaching a policy from here.
        if (indexFile) {
          model.governance.tags = draft.map(({ _orig, ...t }) => t);
          model.governance.propertyKeys = keys.value.split(',').map((k) => k.trim()).filter(Boolean);
          vscode.postMessage({ type: 'governance', governance: SM.toFile(model).governance || { tags: [], propertyKeys: [], policies: [] } });
          render();
          return;
        }
        mutate('Update tags', () => {
          const renames = new Map(draft.filter((t) => t._orig !== t.name && model.governance.tags.some((x) => x.name === t._orig)).map((t) => [t._orig, t.name]));
          const live = new Set(draft.map((t) => t.name));
          const ren = (n) => (n[0] === '-' ? '-' + (renames.get(n.slice(1)) || n.slice(1)) : renames.get(n) || n);
          eachObject(model, (o) => { o.tags = (o.tags || []).map(ren).filter((n) => live.has(n.replace(/^-/, ''))); });
          model.governance.tags = draft.map(({ _orig, ...t }) => t);
          model.governance.propertyKeys = keys.value.split(',').map((k) => k.trim()).filter(Boolean);
        });
      } },
    ], true);
  }

  // ---------- the Governance tab (ADR-0038): Policies (list with filters), Graph (what a policy reaches), Edit (create / change) ----------
  // view: list | graph | edit; sel = the highlighted policy; picked = ticked rows; gSel = the policies shown in the graph
  const govState = { view: 'list', sel: null, picked: new Set(), gSel: new Set(), gQ: '', gOpen: false, q: '', type: '', parent: '', owner: '', lv: '', att: '', gLv: new Set(['project', 'conceptual', 'logical', 'physical', 'semantic']), gKind: '', gHow: new Set(['direct', 'tag', 'off']), edit: null };
  // the Domains tab (change 31, ADR-0047: its own level next to Governance; release 2 part 3 had it as a fourth Governance view): view = list | edit, edit = the domain being created / edited
  const domState = { view: 'list', edit: null };
  const LV_NAME = { project: 'Project', conceptual: 'Conceptual', logical: 'Logical', physical: 'Physical', semantic: 'Semantic' };
  const LV_KEYS = ['project', 'conceptual', 'logical', 'physical', 'semantic'];
  const OBJ_KINDS = ['concept', 'entity', 'catalog', 'schema', 'table', 'view', 'column', 'metric'];
  const POL_COLOURS = ['blue', 'purple', 'green', 'orange', 'yellow', 'red']; // one per policy picked in the graph (theme chart colours)
  // policy name -> every object it reaches, with how
  function govCover(d) {
    if (d === data() && fresh().cover) return fresh().cover;
    const memo = memoOf(d), by = new Map();
    for (const x of GV.objects(d, memo)) for (const r of GV.reach(d, x.o, memo)) { if (!by.has(r.name)) by.set(r.name, []); by.get(r.name).push({ x, ...r }); }
    if (d === data()) fresh().cover = by;
    return by;
  }
  // objects where the policy is switched off (only where a switch-off exists, so this stays cheap)
  function govOff(d, name) {
    const out = [], memo = memoOf(d), objs = GV.objects(d, memo), any = objs.some((x) => ((x.o.gov || {}).off || []).length);
    if (!any) return out;
    for (const x of objs) { const r = GV.switchedOff(d, x.o, memo).find((y) => y.name === name); if (r) out.push({ x, ...r }); }
    return out;
  }
  // jump to an object on its level (leaves the Governance tab)
  function govGo(x) {
    const d = data(), R = SM.refs(d), k = x.kind;
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
    if (k === 'project') return openProject();
    if (k === 'concept' || k === 'entity' || k === 'metric') return revealNode(k, x.o.name);
    mode = 'schema';
    if (k === 'catalog') { setLevel('physical'); return revealItem('catalog', x.o.name); }
    if (k === 'schema') { setLevel('physical'); return revealItem('schema', R.sch.get(x.o.id)); }
    if (k === 'column') { const t = d.tables.find((y) => y.columns.includes(x.o)); return reveal(R.tab.get(t.id), x.o.name, true); }
    return reveal(R.tab.get(x.o.id), undefined, true);
  }
  const govSelect = (name, scroll) => { // highlight one policy in the list (kept when filters change while it is visible, and in layout.json)
    govState.sel = name; scheduleLayoutSave();
    if (govState.view !== 'list') { govState.view = 'list'; renderGovView(); }
    else if (govView._paint) govView._paint();
    if (scroll) { const tr = govView.querySelector(`tr[data-pol="${CSS.escape(name)}"]`); if (tr) tr.scrollIntoView({ block: 'center' }); }
  };
  const govGraphOf = (names) => { govState.gSel = new Set(names); govState.view = 'graph'; scheduleLayoutSave(); renderGovView(); };
  const govFilterOwner = (owner) => { Object.assign(govState, { q: '', type: '', parent: '', lv: '', att: '', owner }); govState.view = 'list'; renderGovView(); };
  // a link that is a real button (focusable, Enter / Space work)
  const glink = (txt, fn, title) => h('button', { class: 'glink', title, onclick: (e) => { e.stopPropagation(); fn(); } }, txt);

  function renderGovView() {
    const d = data(), ro = !!preview || viewOnly || !!broken, cov = govCover(d);
    // Creating/editing a tag or policy is allowed from the project-index file (release 2 part 9, ADR-0045 amended): it routes to
    // governance.json, not to any part's file. Everything else in this tab (deleting a policy) stays exactly as read-only as ever.
    const roPol = ro && !indexFile;
    if (govState.view === 'edit' && (roPol || !govState.edit)) govState.view = 'list';
    const body = h('div', { class: 'gvbody' });
    govView._paint = null;
    fill(govView, h('div', { class: 'gvhead' }, h('strong', null, 'Governance'),
      govState.view === 'edit' ? glink('← Policies', () => { govState.edit = null; govState.view = 'list'; renderGovView(); }, 'Back to the list without saving')
        : seg([['list', 'Policies'], ['graph', 'Graph']], govState.view, (v) => { if (v === 'graph' && !govState.gSel.size && govState.sel) govState.gSel = new Set([govState.sel]); govState.view = v; scheduleLayoutSave(); renderGovView(); }),
      h('span', { class: 'grow' }),
      h('small', { class: 'muted' }, `${plural(d.governance.policies.length, 'policy', 'policies')} · ${plural(d.governance.tags.filter((t) => t.policies.length).length, 'tag')} bring policies`),
      roPol ? null : h('button', { onclick: openTags, title: 'Tags are managed with the tag icon in the toolbar' }, 'Tags…')), body);
    if (govState.view === 'graph') govGraph(body, d, cov);
    else if (govState.view === 'edit') govEdit(body, d);
    else govList(body, d, cov, ro, roPol);
  }

  // the Domains tab: same header + body frame as the Governance tab (its CSS and #govview element are reused)
  function renderDomView() {
    const d = data(), ro = !!preview || viewOnly || !!broken;
    // editable from the project-index file too (concepts moving domain move between parts); a part opened on its own in a split project
    // is not the place (the other parts would change under it), so it is read-only there with a pointer to the Project View
    const roDom = ro ? !indexFile : !!model.crossPart;
    if (domState.view === 'edit' && (roDom || !domState.edit)) domState.view = 'list';
    const body = h('div', { class: 'gvbody' });
    govView._paint = null;
    fill(govView, h('div', { class: 'gvhead' }, h('strong', null, 'Domains'),
      domState.view === 'edit' ? glink('← Domains', () => { domState.edit = null; domState.view = 'list'; renderDomView(); }, 'Back to the list without saving') : null,
      h('span', { class: 'grow' }),
      h('small', { class: 'muted' }, d.domains === undefined ? '' : plural(d.domains.length, 'domain'))), body);
    if (domState.view === 'edit') govDomainEdit(body, d); else govDomains(body, d, roDom);
  }

  // --- 1. the list: a table with fixed columns, filters, ticks for several policies, one highlighted policy, links
  function govList(body, d, cov, ro, roPol = ro) {
    const P = d.governance.policies, uniq = (a) => [...new Set(a.filter(Boolean))].sort();
    const sel = (key, opts, all) => { const s = dropdown([{ value: '', label: all }, ...opts.map((v) => (typeof v === 'string' ? { value: v, label: v } : v))], govState[key]); s.addEventListener('change', () => { govState[key] = s.value; paint(); }); return s; };
    const txt = (key, ph) => h('input', { type: 'search', value: govState[key], placeholder: ph, oninput: (e) => { govState[key] = e.target.value; paint(); } });
    const tbody = h('tbody'), bar = h('div', { class: 'gvselbar' }), all = h('input', { type: 'checkbox', title: 'Tick every policy shown', 'aria-label': 'Select all shown' });
    let shown = [];
    all.addEventListener('change', () => { shown.forEach((p) => (all.checked ? govState.picked.add(p.name) : govState.picked.delete(p.name))); paint(); });
    const reachOf = (n) => { const c = cov.get(n) || []; return { total: c.length, by: LV_KEYS.map((lv) => [lv, c.filter((x) => x.x.level === lv).length]).filter(([, k]) => k), direct: c.filter((x) => x.how === 'direct' && !x.via).length }; };
    const paint = () => {
      const q = govState.q.toLowerCase(), att = govState.att.toLowerCase();
      shown = P.filter((p) => (!q || [p.name, p.description, p.type, p.jurisdiction].some((x) => (x || '').toLowerCase().includes(q)))
        && (!govState.type || p.type === govState.type) && (!govState.owner || p.owner === govState.owner)
        && (!govState.parent || GV.ancestors(d, p.name).slice(1).some(([n]) => n === govState.parent))
        && (!govState.lv || (cov.get(p.name) || []).some((c) => c.x.level === govState.lv))
        && (!att || (cov.get(p.name) || []).some((c) => c.x.label.toLowerCase().includes(att)))).sort((a, b) => a.name.localeCompare(b.name));
      [...govState.picked].forEach((n) => { if (!P.some((p) => p.name === n)) govState.picked.delete(n); });
      all.checked = shown.length > 0 && shown.every((p) => govState.picked.has(p.name));
      fill(tbody, ...(shown.length ? shown.map((p) => {
        const r = reachOf(p.name), cb = h('input', { type: 'checkbox', checked: govState.picked.has(p.name), 'aria-label': 'Select ' + p.name, onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) govState.picked.add(p.name); else govState.picked.delete(p.name); paint(); } });
        return h('tr', { class: p.name === govState.sel ? 'on' : null, 'data-pol': p.name, onclick: () => govSelect(p.name) },
          h('td', null, cb),
          h('td', { class: 'gvname' }, h('button', { class: 'glink gvn', 'data-tk': 'policy:' + p.name, onclick: (e) => { e.stopPropagation(); govSelect(p.name); } }, p.name), p.description ? h('div', { class: 'gvx muted' }, p.description.split('\n')[0]) : null),
          h('td', null, h('span', { class: 'gvc' }, [p.type, p.jurisdiction].filter(Boolean).join(' · ') || '—')),
          h('td', null, p.owner ? glink(p.owner, () => govFilterOwner(p.owner), 'Show the policies owned by ' + p.owner) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'gvpar' }, p.parents.length ? p.parents.flatMap((n, i) => [i ? ', ' : null, glink(n, () => { Object.assign(govState, { q: '', type: '', parent: '', owner: '', lv: '', att: '' }); renderGovView(); govSelect(n, true); }, 'Select ' + n)]) : h('span', { class: 'muted' }, '—')),
          h('td', { title: `Attached directly to ${plural(r.direct, 'object')}; reaches ${r.by.map(([lv, k]) => `${k} ${LV_NAME[lv].toLowerCase()}`).join(', ') || 'nothing'} (attached, through a child policy, via a tag or inherited)` },
            h('b', null, String(r.total)), r.by.length ? h('small', { class: 'muted' }, ' ' + r.by.map(([lv, k]) => `${lv === 'project' ? 'Pr' : LV_NAME[lv][0]}${k}`).join(' ')) : null),
          h('td', { class: 'gvact' }, h('button', { class: 'ib', 'data-tip': 'View', 'aria-label': 'View ' + p.name, onclick: (e) => { e.stopPropagation(); govSelect(p.name); viewPolicy(p.name); } }, icon('view', false, 15)),
            roPol ? null : h('button', { class: 'ib', 'data-tip': 'Edit', 'aria-label': 'Edit ' + p.name, onclick: (e) => { e.stopPropagation(); govSelect(p.name); startEdit(p.name); govState.view = 'edit'; renderGovView(); } }, '✎')));
      }) : [h('tr', null, h('td', { colspan: 7, class: 'muted' }, P.length ? 'No policy matches the filters.' : 'No policies yet. A policy is a rule such as GDPR, "Retention 7 years" or "Mask personal data": create one, attach it to the project, concepts, entities, schemas, tables or columns, or let a tag bring it.'))]));
      const n = govState.picked.size;
      bar.hidden = !n;
      fill(bar, h('b', null, `${n} selected`), h('button', { onclick: () => govGraphOf([...govState.picked]) }, 'View graph'),
        ro ? null : h('button', { class: 'danger', onclick: () => deletePolicies([...govState.picked]) }, 'Delete…'), glink('Clear', () => { govState.picked.clear(); paint(); }, 'Clear the selection (Esc)'));
    };
    govView._paint = paint;
    fill(body, h('div', { class: 'gvfilters' }, txt('q', 'Search policies…'), sel('type', uniq(P.map((p) => p.type)), 'Any type'), sel('parent', uniq(P.flatMap((p) => p.parents)), 'Any parent'),
      sel('owner', uniq(P.map((p) => p.owner)), 'Any owner'), sel('lv', LV_KEYS.map((v) => ({ value: v, label: 'Covers ' + LV_NAME[v].toLowerCase() })), 'Any level'),
      txt('att', 'Covers an object named…'), roPol ? null : h('button', { class: 'primary', onclick: () => { startEdit(null); govState.view = 'edit'; renderGovView(); } }, '+ New policy')),
      bar,
      h('table', { class: 'gvtab' }, h('colgroup', null, ...['32px', '30%', '14%', '15%', '19%', '11%', '72px'].map((w) => h('col', { style: 'width:' + w }))),
        h('thead', null, h('tr', null, h('th', null, all), ...['Policy', 'Type', 'Owner', 'Parents', 'Reach', ''].map((x) => h('th', null, x)))), tbody));
    paint();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && level === 'governance' && govState.picked.size && !document.querySelector('.overlay') && govView._paint) { govState.picked.clear(); govView._paint(); } });

  // --- a policy, read-only: what it is, where it sits in the hierarchy, what brings it and what it reaches; links everywhere
  function viewPolicy(name) {
    const d = data(), p = d.governance.policies.find((x) => x.name === name);
    if (!p) return;
    const cov = govCover(d).get(name) || [], kids = d.governance.policies.filter((x) => x.parents.includes(name)).map((x) => x.name);
    const tags = d.governance.tags.filter((t) => t.policies.includes(name)), attached = cov.filter((c) => c.how === 'direct' && !c.via);
    const links = (arr) => (arr.length ? h('span', null, ...arr.flatMap((x, i) => [i ? ', ' : null, x])) : h('span', { class: 'muted' }, '—'));
    const pol = (n) => glink(n, () => { document.querySelectorAll('.overlay').forEach((o) => o.remove()); viewPolicy(n); }, 'View ' + n);
    const row = (k, v) => [h('span', { class: 'tk' }, k), h('span', { class: 'tv' }, v)];
    const ro = !!preview || viewOnly || !!broken;
    modal(`Policy: ${p.name}`, h('div', { class: 'gvview' },
      p.description ? h('div', { class: 'tmd' }, ...mdNodes(SMD.parse(p.description))) : h('p', { class: 'muted' }, 'No description.'),
      h('div', { class: 'tkv derived' },
        ...row('Type', p.type || '—'), ...row('Jurisdiction', p.jurisdiction || '—'), ...row('Minimum classification', p.classification || '—'),
        ...row('Owner of the rule', p.owner ? glink(p.owner, () => { document.querySelectorAll('.overlay').forEach((o) => o.remove()); govFilterOwner(p.owner); }, 'Show the policies owned by ' + p.owner) : '—'),
        ...row('Parents', links(p.parents.map(pol))), ...row('Child policies (bring it)', links(kids.map(pol))),
        ...row('Tags that bring it', links(tags.map((t) => glink(t.displayName || t.name, () => { document.querySelectorAll('.overlay').forEach((o) => o.remove()); openTags(); }, 'Open the tags')))),
        ...row('Attached to', links(attached.slice(0, 30).map((c) => glink(c.x.label, () => govGo(c.x), 'Open it on its level')))),
        ...row('Reaches', LV_KEYS.map((lv) => [lv, cov.filter((c) => c.x.level === lv).length]).filter(([, k]) => k).map(([lv, k]) => `${LV_NAME[lv]} ${k}`).join(' · ') || 'nothing'))), [
      { label: 'Close' },
      { label: 'Open graph', fn: () => { govGraphOf([name]); } },
      ...(ro ? [] : [{ label: 'Edit', primary: true, fn: () => { govSelect(name); startEdit(name); govState.view = 'edit'; renderGovView(); } }]),
    ], true);
  }

  // delete one or several policies in one version (governance stream), after showing what refers to them
  function deletePolicies(names) {
    const d = model, gone = new Set(names), objs = GV.objects(d);
    const lines = names.map((n) => {
      const kids = d.governance.policies.filter((x) => !gone.has(x.name) && x.parents.includes(n)).map((x) => x.name), tags = d.governance.tags.filter((t) => t.policies.includes(n)).map((t) => t.displayName || t.name);
      const att = objs.filter((x) => ((x.o.gov || {}).policies || []).includes(n)).map((x) => x.label), off = objs.filter((x) => ((x.o.gov || {}).off || []).includes(n)).map((x) => x.label);
      const bits = [kids.length && `parent of ${kids.join(', ')}`, tags.length && `brought by tag ${tags.join(', ')}`, att.length && `attached to ${plural(att.length, 'object')} (${att.slice(0, 3).join(', ')}${att.length > 3 ? ', …' : ''})`, off.length && `switched off on ${plural(off.length, 'object')}`].filter(Boolean);
      return h('li', null, h('b', null, n), bits.length ? ': ' + bits.join('; ') : ': nothing refers to it');
    });
    modal(names.length === 1 ? `Delete policy ${names[0]}?` : `Delete ${names.length} policies?`, h('div', null,
      h('p', null, 'Each is removed from the parents of other policies, from the tags that bring it, and from everything it is attached to or switched off on. One version in the Governance stream: Undo brings it all back.'),
      h('ul', { class: 'gvdel' }, ...lines)), [
      { label: 'Cancel' },
      { label: 'Delete', danger: true, fn: () => {
        mutate(names.length === 1 ? 'Delete policy ' + names[0] : `Delete ${names.length} policies: ${names.join(', ')}`, () => {
          const G0 = model.governance, drop = (list) => (list || []).filter((y) => !gone.has(y));
          G0.policies = G0.policies.filter((x) => !gone.has(x.name));
          G0.policies.forEach((x) => { x.parents = drop(x.parents); });
          G0.tags.forEach((t) => { t.policies = drop(t.policies); });
          GV.objects(model).forEach((x) => { const g0 = x.o.gov || {}; if ((g0.policies || []).some((y) => gone.has(y)) || (g0.off || []).some((y) => gone.has(y))) x.o.gov = GV.tidy({ ...g0, policies: drop(g0.policies), off: drop(g0.off) }); });
        });
        names.forEach((n) => { govState.picked.delete(n); govState.gSel.delete(n); });
        if (gone.has(govState.sel)) govState.sel = null;
        govState.edit = null; govState.view = 'list'; render();
        toast(`Deleted ${plural(names.length, 'policy', 'policies')}. Undo brings ${names.length === 1 ? 'it' : 'them'} back.`);
      } },
    ], true);
  }

  // --- 2. the graph of one or several policies: parents | the policies | the policies and tags that bring them | the objects they reach
  function govGraph(body, d, cov) {
    const P = d.governance.policies, names = [...P].map((p) => p.name).sort((a, b) => a.localeCompare(b));
    if (!P.length) return fill(body, h('p', { class: 'muted' }, 'No policies yet.'));
    [...govState.gSel].forEach((n) => { if (!names.includes(n)) govState.gSel.delete(n); });
    if (!govState.gSel.size) govState.gSel.add(govState.sel && names.includes(govState.sel) ? govState.sel : names[0]);
    const again = () => { scheduleLayoutSave(); paintGraph(); paintChips(); };
    // the picker: chips of the chosen policies, a dropdown with search and select all / none
    const chips = h('span', { class: 'gpchips' }), list = h('div', { class: 'gplist' }), search = h('input', { type: 'search', value: govState.gQ, placeholder: 'Search policies…' });
    const pop = h('div', { class: 'gppop', hidden: !govState.gOpen }, search, h('div', { class: 'irow' }, glink('Select all', () => { names.forEach((n) => govState.gSel.add(n)); paintList(); again(); }), glink('None', () => { govState.gSel.clear(); paintList(); again(); })), list);
    const paintList = () => fill(list, ...names.filter((n) => !govState.gQ || n.toLowerCase().includes(govState.gQ.toLowerCase())).map((n) =>
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: govState.gSel.has(n), onchange: (e) => { if (e.target.checked) govState.gSel.add(n); else govState.gSel.delete(n); again(); } }), n)));
    search.addEventListener('input', () => { govState.gQ = search.value; paintList(); });
    const colourOf = (n) => POL_COLOURS[[...govState.gSel].indexOf(n) % POL_COLOURS.length];
    const paintChips = () => fill(chips, ...(govState.gSel.size ? [...govState.gSel].map((n) => h('span', { class: 'chip gpc c-' + colourOf(n) }, n, h('button', { class: 'ib', title: 'Remove from the graph', onclick: (e) => { e.stopPropagation(); govState.gSel.delete(n); paintList(); again(); } }, '✕'))) : [h('span', { class: 'muted' }, 'No policy chosen')]));
    const toggle = h('button', { class: 'gptoggle', 'aria-expanded': String(govState.gOpen), onclick: (e) => { e.stopPropagation(); govState.gOpen = !govState.gOpen; pop.hidden = !govState.gOpen; toggle.setAttribute('aria-expanded', String(govState.gOpen)); if (govState.gOpen) search.focus(); } }, 'Policies ▾');
    paintList(); paintChips();
    const tick = (set, v, lbl) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: set.has(v), onchange: (e) => { if (e.target.checked) set.add(v); else set.delete(v); again(); } }), lbl);
    const ksel = dropdown([{ value: '', label: 'Any kind' }, ...OBJ_KINDS], govState.gKind);
    ksel.addEventListener('change', () => { govState.gKind = ksel.value; again(); });
    const box = h('div', { class: 'gvgraphwrap' });
    const paintGraph = () => {
      const picked = [...govState.gSel], pol = (n) => P.find((p) => p.name === n) || { name: n, parents: [] };
      const anc = [...new Set(picked.flatMap((n) => GV.ancestors(d, n).slice(1).map(([a]) => a)))].filter((n) => !picked.includes(n));
      const desc = [...new Set(picked.flatMap((n) => GV.descendants(d, n)))].filter((n) => !picked.includes(n) && !anc.includes(n));
      const shownP = new Set([...anc, ...picked, ...desc]);
      const tags = d.governance.tags.filter((t) => t.policies.some((n) => picked.includes(n) || desc.includes(n)));
      // objects: the union of what the picked policies reach, each object once with the policies that reach it
      const byObj = new Map();
      for (const n of picked) for (const c of [...(cov.get(n) || []), ...govOff(d, n)]) {
        if (!govState.gLv.has(c.x.level) || (govState.gKind && c.x.kind !== govState.gKind) || !govState.gHow.has(c.how)) continue;
        if (!byObj.has(c.x.ref)) byObj.set(c.x.ref, { x: c.x, via: [] });
        byObj.get(c.x.ref).via.push({ ...c, policy: n });
      }
      const objs = [...byObj.values()], total = new Set(picked.flatMap((n) => [...(cov.get(n) || []), ...govOff(d, n)].map((c) => c.x.ref))).size;
      const MAX = 150, cut = objs.slice(0, MAX);
      const NW = 230, NH = 34, GX = 70, GY = 8, colX = (i) => 12 + i * (NW + GX), ys = [12, 12, 12, 12], nodes = [], pos = new Map();
      const node = (col, key, lbl, sub, cls, onclick, title, extra) => { const y = ys[col]; ys[col] += NH + GY; pos.set(key, { x: colX(col), y }); nodes.push(h('div', { class: 'gn ' + cls, style: `left:${colX(col)}px;top:${y}px;width:${NW}px;height:${NH}px`, title: title || lbl, onclick, tabindex: onclick ? 0 : null, onkeydown: onclick ? (e) => { if (e.key === 'Enter') onclick(); } : null }, h('span', { class: 'gnl' }, lbl, extra || null), sub ? h('small', null, sub) : null)); };
      const heads = [], head = (col, t) => { heads.push(h('div', { class: 'gnh', style: `left:${colX(col)}px;top:${ys[col]}px;width:${NW}px` }, t)); ys[col] += 22; };
      const focus = (n) => { govState.gSel = new Set([n]); paintList(); again(); };
      head(0, 'Parents'); anc.forEach((n) => node(0, 'p:' + n, n, pol(n).type, 'pol', () => focus(n)));
      head(1, picked.length > 1 ? 'Policies' : 'Policy');
      picked.forEach((n) => node(1, 'p:' + n, n, [pol(n).type, pol(n).jurisdiction].filter(Boolean).join(' · '), 'pol sel c-' + colourOf(n), () => viewPolicy(n), pol(n).description || n));
      head(2, 'Brought by (child policies, tags)'); desc.forEach((n) => node(2, 'p:' + n, n, 'child policy', 'pol', () => focus(n)));
      tags.forEach((t) => node(2, 't:' + (t.displayName || t.name), t.displayName || t.name, 'tag', 'gtag', openTags, t.description));
      head(3, `Reaches ${plural(total, 'object')}${objs.length !== total ? ` · ${objs.length} shown` : ''}`);
      const how1 = (c) => (c.how === 'off' ? `switched off${c.cause !== c.policy ? ' with ' + c.cause : ''}${c.from ? ' on ' + GV.fromText(c.from) : ' here'}` : c.how === 'direct' ? (c.via ? 'through ' + c.via : 'attached') : c.how === 'tag' ? 'via tag ' + c.from.name : 'inherited from ' + GV.fromText(c.from));
      for (const lv of LV_KEYS) {
        const inLv = cut.filter((o) => o.x.level === lv);
        if (!inLv.length) continue;
        head(3, LV_NAME[lv]);
        inLv.forEach((o) => { const c = o.via[0], many = o.via.length > 1;
          node(3, 'o:' + o.x.ref, o.x.label.replace(/^(Project|Concept|Entity|Catalog|Schema|Metric) /, ''), o.x.kind + ' · ' + (many ? `${o.via.length} policies: ${o.via.map((v) => v.policy).join(', ')}` : how1(c)),
            'obj h-' + (o.via.every((v) => v.how === 'off') ? 'off' : o.via.some((v) => v.how === 'direct') ? 'direct' : c.how), () => govGo(o.x), o.via.map((v) => `${v.policy}: ${how1(v)}`).join('\n'),
            picked.length > 1 ? h('span', { class: 'gdots' }, ...o.via.map((v) => h('i', { class: 'c-' + colourOf(v.policy) }))) : null); });
      }
      // edges: parent -> child policy, policy -> tag that brings it, source -> object (coloured by the picked policy)
      const edges = [], E = (a, b, cls, col) => { if (pos.has(a) && pos.has(b)) edges.push([a, b, cls, col]); };
      for (const n of shownP) for (const q of pol(n).parents) if (shownP.has(q)) E('p:' + q, 'p:' + n, 'pe');
      tags.forEach((t) => t.policies.filter((n) => picked.includes(n) || desc.includes(n)).forEach((n) => E('p:' + n, 't:' + (t.displayName || t.name), 'te')));
      const objKey = (f) => f && cut.find((o) => GV.nameOf(d, o.x.o) === f.name && o.x.kind === f.kind);
      for (const o of cut) for (const c of o.via) {
        const to = 'o:' + o.x.ref, col = picked.length > 1 ? colourOf(c.policy) : null;
        if (c.how === 'off') E('p:' + c.policy, to, 'oe off', col);
        else if (c.how === 'tag') E('t:' + c.from.name, to, 'oe tag', col);
        else if (c.how === 'inherited') { const up = objKey(c.from); E(up ? 'o:' + up.x.ref : 'p:' + (c.via || c.policy), to, 'oe inh', col); }
        else E('p:' + (c.via && shownP.has(c.via) ? c.via : c.policy), to, 'oe', col);
      }
      const H2 = Math.max(...ys) + 10, W2 = colX(4);
      const sv = svg('svg', { class: 'gedges', width: W2, height: H2 });
      for (const [a, b, cls, col] of edges) {
        const p1 = pos.get(a), p2 = pos.get(b), x1 = p1.x + NW, y1 = p1.y + NH / 2, fwd = p2.x > p1.x, x2 = fwd ? p2.x : p2.x + NW, y2 = p2.y + NH / 2, dx = fwd ? Math.max(30, (x2 - x1) / 2) : 40;
        sv.append(svg('path', { class: 'ge ' + cls + (col ? ' c-' + col : ''), d: fwd ? `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}` : `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 + dx} ${y2} ${x2} ${y2}` }));
      }
      fill(box, objs.length > MAX ? h('div', { class: 'ibox note' }, `Showing ${MAX} of ${objs.length}: narrow the filters (level, kind) to see the rest.`) : null,
        h('div', { class: 'gvgraph', style: `width:${W2}px;height:${H2}px` }, sv, ...heads, ...nodes));
    };
    fill(body, h('div', { class: 'gvfilters' }, h('div', { class: 'gppick' }, toggle, pop), chips),
      h('div', { class: 'gvfilters' }, ...LV_KEYS.map((lv) => tick(govState.gLv, lv, LV_NAME[lv])), ksel,
        tick(govState.gHow, 'direct', 'Attached'), tick(govState.gHow, 'tag', 'Via tag'), tick(govState.gHow, 'inherited', 'Inherited'), tick(govState.gHow, 'off', 'Switched off')),
      h('small', { class: 'muted' }, 'Solid lines: attached, through a child policy or brought by a tag (the line starts at the tag). Dashed: inherited from above on the same level. Red, crossed out: switched off there. Only the picked policies are marked; with several, their lines and dots take each policy\'s colour and an object reached by several is drawn once. Click an object to open it on its level, a policy to view it.'),
      box);
    paintGraph();
  }
  document.addEventListener('pointerdown', (e) => { if (govState.gOpen && !e.target.closest('.gppick')) { govState.gOpen = false; const p = govView.querySelector('.gppop'); if (p) p.hidden = true; const t = govView.querySelector('.gptoggle'); if (t) t.setAttribute('aria-expanded', 'false'); } });

  // --- 3. create or edit a policy: its fields, parents, tags that bring it, and where it is attached
  function startEdit(orig) {
    const d = model, p = orig && d.governance.policies.find((x) => x.name === orig);
    govState.edit = { orig: p ? p.name : null, p: p ? clone(p) : { name: '', parents: [], type: '', jurisdiction: '', classification: '', owner: '', description: '' },
      tags: new Set(p ? d.governance.tags.filter((t) => t.policies.includes(p.name)).map((t) => t.name) : []),
      att: new Set(p ? GV.objects(d).filter((x) => ((x.o.gov || {}).policies || []).includes(p.name)).map((x) => x.ref) : []), filter: '', open: new Set() };
  }
  function govEdit(body, d) {
    const E = govState.edit, p = E.p;
    const name = h('input', { value: p.name, placeholder: 'e.g. GDPR' }), type = h('input', { value: p.type, list: 'poltypes', placeholder: 'e.g. regulatory' });
    const owner = h('input', { value: p.owner, list: 'govpeople', placeholder: 'Who owns the rule' }), jur = h('input', { value: p.jurisdiction, placeholder: 'e.g. EU' });
    const cls = dropdown([{ value: '', label: '— none —' }, ...GV.COMMON[2].values], p.classification || '');
    const desc = h('textarea', { rows: 3, value: p.description, placeholder: 'What it requires, in words' });
    const below = E.orig ? new Set([E.orig, ...GV.descendants(d, E.orig)]) : new Set(); // parents that would create a cycle are not offered
    const parents = d.governance.policies.filter((x) => !below.has(x.name)).map((x) => [x.name, h('input', { type: 'checkbox', checked: p.parents.includes(x.name) })]);
    const tagBoxes = d.governance.tags.map((t) => [t.name, h('input', { type: 'checkbox', checked: E.tags.has(t.name), onchange: (e) => (e.target.checked ? E.tags.add(t.name) : E.tags.delete(t.name)) })]);
    // attachments: every object, filterable; columns listed under their table (opened, or when the filter matches them)
    const objs = GV.objects(d), attBox = h('div', { class: 'btargets gvatt' });
    const row = (x, lbl, cls) => h('label', { class: cls || 'bi' }, h('input', { type: 'checkbox', checked: E.att.has(x.ref), disabled: indexFile || undefined, onchange: (e) => (e.target.checked ? E.att.add(x.ref) : E.att.delete(x.ref)) }), lbl);
    const paintAtt = () => {
      const f = E.filter.toLowerCase(), hit = (x) => !f || x.label.toLowerCase().includes(f), out = [];
      const grp = (title, list) => { const l = list.filter(hit); if (l.length) out.push(h('div', { class: 'bh' }, title), ...l.map((x) => row(x, x.label.replace(/^(Project|Concept|Entity|Catalog|Schema|Metric) /, '')))); };
      grp('Project (every level)', objs.filter((x) => x.kind === 'project'));
      grp('Concepts', objs.filter((x) => x.kind === 'concept')); grp('Entities', objs.filter((x) => x.kind === 'entity')); grp('Metrics', objs.filter((x) => x.kind === 'metric'));
      grp('Catalogs', objs.filter((x) => x.kind === 'catalog')); grp('Schemas', objs.filter((x) => x.kind === 'schema'));
      const tabs = objs.filter((x) => x.kind === 'table' || x.kind === 'view'), cols = (t) => objs.filter((x) => x.kind === 'column' && t.o.columns.includes(x.o));
      const shownT = tabs.filter((t) => hit(t) || cols(t).some(hit));
      if (shownT.length) out.push(h('div', { class: 'bh' }, 'Tables, views and their columns'));
      for (const t of shownT) {
        const open = E.open.has(t.ref) || (f && cols(t).some(hit)), n = cols(t).filter((c) => E.att.has(c.ref)).length;
        out.push(h('div', { class: 'bt' }, row(t, t.label, 'bi'), h('button', { class: 'lnk', onclick: () => { if (!E.open.delete(t.ref)) E.open.add(t.ref); paintAtt(); } }, `${open ? '▾' : '▸'} columns${n ? ` (${n} attached)` : ''}`)));
        if (open) out.push(...cols(t).filter((c) => !f || hit(c) || hit(t)).map((c) => row(c, c.o.name, 'bi bc')));
      }
      fill(attBox, ...(out.length ? out : [h('p', { class: 'muted' }, 'Nothing matches.')]));
    };
    const save = () => {
      const v = name.value.trim();
      if (!v) return toast('A policy needs a name.');
      if (d.governance.policies.some((x) => x.name === v && x.name !== E.orig)) return toast('A policy with this name exists.');
      const vals = { name: v, parents: parents.filter(([, cb]) => cb.checked).map(([n]) => n), type: type.value.trim(), jurisdiction: jur.value.trim(), classification: cls.value, owner: owner.value.trim(), description: desc.value.trim() };
      const orig = E.orig;
      // The definition (name, parents, tags that bring it) is governance.json content once split; attaching it to an object edits that object in its own
      // part, which the project-index file does not do: the "Attached to" checkboxes are shown disabled (see `row` above) rather than silently dropped.
      const applyDef = () => {
        const G0 = model.governance, rn = (n) => (n === orig ? v : n);
        let q = orig && G0.policies.find((x) => x.name === orig);
        if (q) Object.assign(q, vals); else G0.policies.push(q = vals);
        if (orig && orig !== v) { G0.policies.forEach((x) => { x.parents = x.parents.map(rn); }); G0.tags.forEach((t) => { t.policies = t.policies.map(rn); }); }
        G0.tags.forEach((t) => { const on = E.tags.has(t.name), has = t.policies.includes(v); if (on && !has) t.policies.push(v); if (!on && has) t.policies = t.policies.filter((n) => n !== v); });
        if (!indexFile) GV.objects(model).forEach((x) => {
          const g0 = { ...(x.o.gov || {}) }, list = (g0.policies || []).map(rn), on = E.att.has(x.ref), has = list.includes(v);
          g0.policies = on && !has ? [...list, v] : !on && has ? list.filter((n) => n !== v) : list;
          if ((x.o.gov || {}).policies || g0.policies.length) x.o.gov = GV.tidy(g0);
        });
      };
      if (indexFile) {
        applyDef();
        vscode.postMessage({ type: 'governance', governance: SM.toFile(model).governance || { tags: [], propertyKeys: [], policies: [] } });
      } else {
        mutate(orig ? (orig !== v ? `Rename policy ${orig} to ${v}` : `Edit policy ${v}`) : `Add policy ${v}`, applyDef);
      }
      govState.sel = v; govState.edit = null; govState.view = 'list'; scheduleLayoutSave(); render();
      setTimeout(() => { const tr = govView.querySelector(`tr[data-pol="${CSS.escape(v)}"]`); if (tr) tr.scrollIntoView({ block: 'center' }); });
    };
    const del = () => deletePolicies([E.orig]);
    const filterIn = h('input', { type: 'search', value: E.filter, placeholder: 'Filter: a name of a concept, schema, table, column…', oninput: (e) => { E.filter = e.target.value; paintAtt(); } });
    const keep = () => Object.assign(p, { name: name.value, type: type.value, owner: owner.value, jurisdiction: jur.value, classification: cls.value, description: desc.value, parents: parents.filter(([, cb]) => cb.checked).map(([n]) => n) });
    [name, type, owner, jur, cls, desc].forEach((x) => x.addEventListener('change', keep)); parents.forEach(([, cb]) => cb.addEventListener('change', keep));
    paintAtt();
    fill(body, h('div', { class: 'gvedit' }, peopleList(), h('datalist', { id: 'poltypes' }, GV.POLICY_TYPES.map((x) => h('option', { value: x }))),
      h('div', { class: 'gvcols' },
        h('div', null,
          h('div', { class: 'two' }, field('Name', name), field('Type', type, 'Use "protection" for masking / encryption rules')),
          h('div', { class: 'two' }, field('Owner of the rule', owner), field('Jurisdiction', jur)),
          field('Minimum classification', cls, 'A column this policy is attached to, or that carries a tag bringing it, is at least this sensitive (GDPR → Restricted). Tables, schemas and concepts show the highest of their columns.'), field('Description', desc),
          h('div', { class: 'field' }, h('span', null, 'Parents: it takes on their requirements'), h('div', { class: 'chips' }, parents.map(([n, cb]) => h('label', { class: 'chip' }, cb, n))),
            h('small', null, 'Several allowed. Attaching this policy applies its parents too.')),
          h('div', { class: 'field' }, h('span', null, 'Tags that bring it'), h('div', { class: 'chips' }, tagBoxes.map(([n, cb]) => h('label', { class: 'chip' }, cb, (d.governance.tags.find((t) => t.name === n) || {}).displayName || n))))),
        h('div', null, h('div', { class: 'field' }, h('span', null, 'Attached to'), filterIn,
          h('small', null, indexFile ? 'Not available from the whole-project view: attaching a policy to a table, concept, etc. edits that object, in whichever part holds it. Open the part directly to attach it there.' : 'Tick where it applies. It is inherited below on the same level: a schema covers its tables and columns, the project covers every level.')), attBox)),
      h('div', { class: 'irow' }, h('button', { class: 'primary', onclick: save }, E.orig ? 'Save' : 'Create policy'), h('button', { onclick: () => { govState.edit = null; govState.view = 'list'; renderGovView(); } }, 'Cancel'),
        E.orig && !indexFile ? h('button', { class: 'danger', onclick: del }, 'Delete') : null)));
  }

  // --- the Domains tab (release 2 part 3, ADR-0045 amended; its own level since change 31, ADR-0047): the manifest's `domains`, edited here instead of by hand. A domain is project
  // metadata, not model content: saving posts straight to the host (`{type: 'domains', domains}`, no reply needed, written by
  // lib/project.js#setDomains) and there is no version to undo — the same as a settings change, not a `mutate()`.
  function startDomainEdit(orig) {
    const dm = orig && (model.domains || []).find((x) => x.name === orig);
    domState.edit = { orig: dm ? dm.name : null, p: dm ? clone(dm) : { name: '', owner: '', steward: '', criticality: '', lifecycle: '', policies: [], concepts: [] } };
  }
  function saveDomains(list) { model.domains = list; vscode.postMessage({ type: 'domains', domains: list }); }
  function deleteDomain(name) {
    modal(`Delete domain ${name}?`, h('p', null, indexFile ? 'Its concepts become unassigned and their objects move to the _unassigned part (created if needed). The domain\'s own file stays, empty.' : 'Its concepts become unassigned; nothing about the model itself changes until the project is split.'), [
      { label: 'Cancel' },
      { label: 'Delete', danger: true, fn: () => { saveDomains((model.domains || []).filter((x) => x.name !== name)); domState.edit = null; domState.view = 'list'; renderDomView(); } },
    ]);
  }
  function govDomains(body, d, ro) {
    if (d.domains === undefined) {
      fill(body, h('p', { class: 'muted' }, ro ? 'Domains are project metadata and are not shown in this read-only view.'
        : ['A domain is a named group of concepts — Sales, Finance, Customer Success — that gives them a shared owner, steward, criticality, lifecycle and policies, and is the unit a project splits into separate files (', h('b', null, 'Strata SQL: Split into Domains'), '). Save this model once first: Strata SQL creates the project files at the first save, then domains can be added here.']));
      return;
    }
    const domains = d.domains, concepts = d.concepts || [];
    const takenBy = new Map();
    domains.forEach((dm) => (dm.concepts || []).forEach((cn) => { if (!takenBy.has(cn.toLowerCase())) takenBy.set(cn.toLowerCase(), dm.name); }));
    const unassigned = concepts.filter((c) => !takenBy.has(c.name.toLowerCase()));
    const openEdit = (name) => { startDomainEdit(name); domState.view = 'edit'; renderDomView(); };
    const rows = domains.length ? domains.map((dm) => h('tr', { onclick: () => openEdit(dm.name) },
      h('td', { class: 'gvname' }, h('button', { class: 'glink gvn', onclick: (e) => { e.stopPropagation(); openEdit(dm.name); } }, dm.name)),
      h('td', null, dm.owner || h('span', { class: 'muted' }, '—')),
      h('td', { title: dm.description || '' }, dm.description ? (dm.description.length > 80 ? dm.description.slice(0, 79) + '…' : dm.description) : h('span', { class: 'muted' }, '—')),
      h('td', null, (dm.concepts || []).length ? dm.concepts.join(', ') : h('span', { class: 'muted' }, 'none yet')),
      h('td', { class: 'gvact' }, ro ? null : h('button', { class: 'ib', 'data-tip': 'Edit', 'aria-label': 'Edit ' + dm.name, onclick: (e) => { e.stopPropagation(); openEdit(dm.name); } }, '✎'))))
      : [h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No domains yet.'))];
    const ready = domains.length > 0 && domains.every((dm) => (dm.concepts || []).length > 0);
    const split = !!model.crossPart || indexFile, splitTip = split ? 'This project is already split into parts.' : !domains.length ? 'Add at least one domain first.' : !ready ? 'Every domain needs at least one concept.' : 'Split into one file per domain (also on the Command Palette: Strata SQL: Split into Domains).';
    fill(body, h('div', { class: 'gvfilters' }, ro ? null : h('button', { class: 'primary', onclick: () => openEdit(null) }, '+ New domain'),
        h('button', { disabled: ro || !ready || split, 'data-tip': splitTip, onclick: () => vscode.postMessage({ type: 'splitIntoDomains' }) }, 'Split into Domains…'),
        // Project View (release 2 part 4, ADR-0045 extended): this is where a multi-part user already is, so it sits right next to Split
        // rather than adding a new toolbar icon (ponytail: reuse first) — every part assembled read-only, on one canvas (Strata: Open Project View).
        h('button', { disabled: !model.crossPart, 'data-tip': model.crossPart ? 'See every part on one read-only canvas (also on the Command Palette: Strata SQL: Open Project View).' : 'Split into domains first: the Project View needs more than one part.', onclick: () => vscode.postMessage({ type: 'openProjectView' }) }, 'Project View…')),
      !indexFile && model.crossPart && !viewOnly ? h('p', { class: 'muted' }, 'This part belongs to a split project: edit its domains from the Project View (the project-index file), where every part is visible.') : null,
      h('table', { class: 'gvtab' }, h('thead', null, h('tr', null, ...['Domain', 'Owner', 'Description', 'Concepts', ''].map((x) => h('th', null, x)))), h('tbody', null, ...rows)),
      unassigned.length ? h('p', { class: 'muted' }, `${plural(unassigned.length, 'concept')} not in a domain yet (${unassigned.map((c) => c.name).join(', ')}) — ${split ? 'kept in the _unassigned part' : 'would go to _unassigned if split now'}.`) : null);
  }
  function govDomainEdit(body, d) {
    const E = domState.edit, p = E.p;
    const name = h('input', { value: p.name, placeholder: 'e.g. Sales', disabled: !!(E.orig && indexFile), title: E.orig && indexFile ? 'A split project keeps its domains\' names: its files are named after them' : '' });
    const desc = h('textarea', { rows: 2, value: p.description || '', placeholder: 'What this domain covers' });
    const owner = h('input', { value: p.owner, list: 'govpeople', placeholder: 'Who owns the domain' });
    const steward = h('input', { value: p.steward, list: 'govpeople', placeholder: 'Looks after it day to day' });
    const critDef = GV.COMMON.find((x) => x.key === 'criticality'), lifeDef = GV.COMMON.find((x) => x.key === 'lifecycle');
    const crit = dropdown([{ value: '', label: '— not set —' }, ...critDef.values], p.criticality || '');
    const life = dropdown([{ value: '', label: '— not set —' }, ...lifeDef.values], p.lifecycle || '');
    const pol = policyPicker(p.policies || []);
    // Concepts: a concept already in ANOTHER domain cannot be picked here (R16, enforced in the UI as it is edited, not only warned about
    // afterwards). One already double-assigned by a hand-edited manifest stays exactly as it is — still shown, not silently untangled —
    // but can be unticked here to fix it, since that is a change the user is making on purpose.
    const takenBy = new Map();
    (d.domains || []).filter((x) => x.name !== E.orig).forEach((x) => (x.concepts || []).forEach((cn) => takenBy.set(cn.toLowerCase(), x.name)));
    const have = new Set(p.concepts || []);
    const conceptRows = (d.concepts || []).map((c) => {
      const busy = takenBy.get(c.name.toLowerCase()), lockedElsewhere = busy && !have.has(c.name);
      const cb = h('input', { type: 'checkbox', checked: have.has(c.name), disabled: lockedElsewhere, onchange: (e) => { if (e.target.checked) have.add(c.name); else have.delete(c.name); } });
      return h('label', { class: 'chip' + (busy ? ' off' : ''), title: busy ? (lockedElsewhere ? `Already in domain ${busy} — remove it there first` : `Also listed in domain ${busy} (an existing conflict; unticking here only removes it from this domain)`) : '' }, cb, c.name + (busy ? ` (${busy})` : ''));
    });
    const save = () => {
      const v = name.value.trim();
      if (!v) return toast('A domain needs a name.');
      if ((d.domains || []).some((x) => x.name.toLowerCase() === v.toLowerCase() && x.name !== E.orig)) return toast('A domain with this name exists.');
      const vals = { name: v, ...(desc.value.trim() ? { description: desc.value.trim() } : {}), ...(owner.value.trim() ? { owner: owner.value.trim() } : {}), ...(steward.value.trim() ? { steward: steward.value.trim() } : {}),
        ...(crit.value ? { criticality: crit.value } : {}), ...(life.value ? { lifecycle: life.value } : {}), ...(pol.get().length ? { policies: pol.get() } : {}), concepts: [...have] };
      const list = (d.domains || []).map((x) => (x.name === E.orig ? vals : x));
      if (!E.orig) list.push(vals);
      saveDomains(list);
      domState.edit = null; domState.view = 'list'; renderDomView();
    };
    fill(body, h('div', { class: 'gvedit' }, peopleList(),
      h('div', { class: 'two' }, field('Name', name), field('Owner', owner)),
      field('Description', desc),
      h('div', { class: 'two' }, field('Steward', steward), field('Criticality', crit)),
      field('Lifecycle', life),
      h('div', { class: 'field' }, h('span', null, 'Policies'), pol.el, h('small', null, 'Every concept in this domain takes these too, unless it has its own.')),
      h('div', { class: 'field' }, h('span', null, 'Concepts'), h('div', { class: 'chips' }, conceptRows.length ? conceptRows : [h('small', { class: 'muted' }, 'No concepts yet — add some at the Conceptual level.')]),
        h('small', null, 'A concept can be in at most one domain; one already in another is disabled here.')),
      h('div', { class: 'irow' }, h('button', { class: 'primary', onclick: save }, E.orig ? 'Save' : 'Create domain'), h('button', { onclick: () => { domState.edit = null; domState.view = 'list'; renderDomView(); } }, 'Cancel'),
        E.orig ? h('button', { class: 'danger', onclick: () => deleteDomain(E.orig) }, 'Delete') : null)));
  }

  // ---------- settings ----------
  const embedKeyText = (id) => {
    const p = embedProviders.find((x) => x.id === id) || {};
    return { secret: 'key saved in VS Code', env: 'key from environment' }[embedKeys[id]] || (p.local ? `runs on this machine, no key (downloads ${p.download} once)` : 'no key: skipped');
  };

  function openSettings() {
    const f = {
      name: h('input', { value: settings.name || '' }),
      email: h('input', { value: settings.email || '', type: 'email' }),
      timezone: h('input', { value: settings.timezone || '', list: 'tzs' }),
      system: h('input', { value: settings.system || '' }),
      theme: dropdown(TH.OPTIONS.map(([value, label]) => ({ value, label })), TH.OPTIONS.some((o) => o[0] === settings.theme) ? settings.theme : 'auto'),
      variant: dropdown([{ value: 'auto', label: 'Auto' }], 'auto'),
      mode: dropdown([{ value: 'auto', label: 'Automatic — a version for every change' }, { value: 'save', label: 'On save (Ctrl/Cmd + S) — one version per save' }], settings.versionMode || 'auto'),
    };
    const recLayout = check('Record auto layout as a version', !!settings.recordLayout);
    const emb = Object.fromEntries(embedProviders.map((p) => [p.id, check(p.label, !settings.embed || settings.embed[p.id] !== false)]));
    embedProviders.forEach((p) => { emb[p.id].el.title = p.model; });
    const preview = () => applyTheme({ theme: f.theme.value, variant: f.variant.value });
    const fillVariants = (keep) => { // the flavours of the chosen theme
      fill(f.variant, ...TH.variantOptions(f.theme.value).map(([v, l]) => h('option', { value: v }, l)));
      f.variant.value = [...f.variant.options].some((o) => o.value === keep) ? keep : 'auto';
      f.variant.disabled = f.theme.value === 'auto';
    };
    fillVariants(settings.themeVariant);
    f.theme.addEventListener('change', () => { fillVariants(f.variant.value); preview(); });
    f.variant.addEventListener('change', preview);
    const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
    const body = h('div', null,
      field('User name', f.name, 'Defaults to git config user.name'),
      field('Email', f.email, 'Defaults to git config user.email'),
      field('Timezone', f.timezone, 'Defaults to the system timezone'),
      field('System', f.system, 'System name recorded with changes'),
      h('datalist', { id: 'tzs' }, zones.map((z) => h('option', { value: z }))),
      h('h3', { class: 'sec' }, 'Visualization'),
      field('Theme', f.theme, 'Auto uses a matching palette when your VS Code theme is Catppuccin, Tokyo Night, Rosé Pine or Nord, otherwise the VS Code colours. Try one: it previews at once.'),
      field('Flavour', f.variant, 'Catppuccin: Latte, Frappé, Macchiato, Mocha. Tokyo Night: Night, Storm, Moon, Day. Rosé Pine: Rosé Pine, Moon, Dawn. Nord: Polar Night, Snow Storm. VS Code: the current theme or a built-in one.'),
      h('div', { class: 'field' }, h('span', null, 'Arrows and animation'), h('small', null, 'Set them under View settings (the eye) in the canvas controls, bottom-left of the diagram.')),
      h('div', { class: 'field' }, h('span', null, 'Saved layout'), h('button', { onclick: () => { vscode.postMessage({ type: 'layout', part: 'canvas', state: null }); layoutSaved = ''; toast('Saved canvas layout cleared. It is saved again as you work.'); } }, 'Forget the saved canvas layout'), h('small', null, 'The level you were on and, for each level, its view scope, panels, selection and zoom are remembered per model in .strata/layout.json, as is whether the mini-map is on.')),
      h('h3', { class: 'sec' }, 'Vector embeddings'),
      h('p', { class: 'muted' }, 'Models to create embeddings for (Tools → Generate / refresh embeddings). Local models run on this machine with no key. Hosted models are skipped until you add a key; keys are kept in VS Code secret storage or read from environment variables, never written to a file.'),
      embedProviders.map((p) => h('div', { class: 'emb-row' }, emb[p.id].el,
        h('small', { 'data-embkey': p.id }, embedKeyText(p.id)),
        p.needsKey ? h('button', { onclick: () => vscode.postMessage({ type: 'embedKey', provider: p.id }) }, 'Set key…') : null)),
      h('h3', { class: 'sec' }, 'Versioning'),
      field('Create versions', f.mode),
      h('div', { class: 'field' }, recLayout.el),
      h('div', { class: 'field' }, h('span', null, 'Version history'), h('small', null, 'The history is append-only: versions are never deleted, and an edit after an undo leaves the undone versions in the file (tick Show undone versions in the history drawer to see them).')),
      h('small', { class: 'muted' }, 'Saved to .strata/settings.json in the workspace.'));
    modal('Settings', body, [
      { label: 'Cancel' },
      {
        label: 'Save', primary: true,
        fn: () => {
          settings = {
            ...settings, name: f.name.value.trim(), email: f.email.value.trim(), timezone: f.timezone.value.trim(), system: f.system.value.trim(),
            theme: f.theme.value, themeVariant: f.variant.value, versionMode: f.mode.value, recordLayout: recLayout.input.checked,
            embed: Object.fromEntries(embedProviders.map((p) => [p.id, emb[p.id].input.checked])),
          };
          vscode.postMessage({ type: 'settings', settings });
          if (!versionOnSave() && flushPending()) persist(true);
          render();
        },
      },
    ], false, () => applyTheme());
  }

  // ---------- toolbar / banner / history ----------
  // Inline SVG icons (24x24, stroke = currentColor). "add" variants shrink the base and put a + in the corner.
  const ICONS = {
    project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    catalog: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    schema: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
    relationship: '<circle cx="5.5" cy="12" r="2.5"/><circle cx="18.5" cy="12" r="2.5"/><path d="M8 12h8"/>',
    layout: '<rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="3" width="7" height="6" rx="1"/><rect x="8.5" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v3h11V9M12 12v3"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    governance: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    schemaMode: '<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/><path d="M10 7h4a3 3 0 0 1 3 3v4"/>',
    view: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.6a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1 1-1.1 1.8M12 17h.01"/>',
    order: '<rect x="3" y="4" width="7" height="4" rx="1"/><rect x="14" y="10" width="7" height="4" rx="1"/><rect x="3" y="16" width="7" height="4" rx="1"/><path d="M10 6h2a2 2 0 0 1 2 2v2M10 18h2a2 2 0 0 0 2-2v-2"/>',
    impact: '<circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/>',
    tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3 17.7 6.3 21l6.3-6.3a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    export: '<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    navigator: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 9h5M13 13h5M13 17h3"/>',
    add: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    embed: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="8" r="2.2"/><circle cx="8" cy="18" r="2.2"/><circle cx="17" cy="17" r="2.2"/><path d="M8 7l8 1M7 8l1 8M10 18l5-1M18 10l-1 5"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    concept: '<rect x="2.5" y="6" width="19" height="12" rx="6"/><path d="M8 12h8"/>',
    entity: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M8 13.5h8M8 16.5h5"/>',
    align: '<rect x="7" y="3" width="10" height="4" rx="1"/><rect x="5" y="10" width="14" height="4" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/><path d="M12 7v3M12 14v3"/>',
    zoomIn: '<path d="M12 5v14M5 12h14"/>',
    zoomOut: '<path d="M5 12h14"/>',
    minimap: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11.5" y="11" width="7" height="6" rx="1"/><path d="M6 8h4M6 11h3"/>',
    dataMode: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11M15 9v11"/>',
    metric: '<path d="M17 5H7l6 7-6 7h10"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  };
  function icon(name, plus, size = 18) {
    const s = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    s.innerHTML = plus ? `<g transform="translate(1 4) scale(.76)">${ICONS[name]}</g><path d="M19 2.5v6M16 5.5h6"/>` : ICONS[name];
    return s;
  }
  // Icon button; the label shows instantly on hover (CSS tooltip from data-tip) and is the accessible name.
  const ib = (name, tip, fn, o = {}) => h('button', { class: 'tb' + (o.on ? ' on' : '') + (o.right ? ' tip-r' : ''), 'data-tip': tip, 'aria-label': tip, disabled: o.disabled, onclick: fn }, icon(name, o.plus));
  const seg = (opts, val, fn, dis) => h('div', { class: 'seg' }, opts.map(([v, l, tip]) => h('button', { class: v === val ? 'on' : '', 'data-tip': tip, 'aria-label': tip || l, disabled: dis, onclick: () => fn(v) }, l)));
  const segIcons = (opts, val, fn, dis) => h('div', { class: 'seg' }, opts.map(([v, name, tip]) => h('button', { class: 'tb' + (v === val ? ' on' : ''), 'data-tip': tip, 'aria-label': tip, disabled: dis, onclick: () => fn(v) }, icon(name))));

  // the Strata mark: a mountain of four coloured layers (blue, purple, green, orange), coloured by the theme
  function logo(size = 24) {
    const e = svg('svg', { viewBox: '0 0 32 32', width: size, height: size, class: 'logo', 'aria-hidden': 'true' });
    e.innerHTML = '<polygon class="l1" points="16,3.5 20.3,11 11.7,11"/><polygon class="l2" points="10.9,12.6 21.1,12.6 24.5,18.4 7.5,18.4"/><polygon class="l3" points="6.6,20 25.4,20 28.1,24.4 3.9,24.4"/><polygon class="l4" points="3.2,26 28.8,26 30.5,29 1.5,29"/>';
    return e;
  }
  // ---- small menu under a button (used by "Add" and by the "⋯" overflow) ----
  let menuEl = null;
  const closeMenu = () => { if (menuEl) { menuEl.remove(); menuEl = null; } };
  function openMenu(anchor, rows) {
    closeMenu();
    menuEl = h('div', { class: 'menu', role: 'menu' }, rows.map((r) => h('button', { class: 'mitem', role: 'menuitem', disabled: r.disabled, onclick: () => { closeMenu(); r.fn(); } }, icon(r.icon, r.plus, 18), h('span', null, r.label))));
    document.body.append(menuEl);
    const b = anchor.getBoundingClientRect();
    menuEl.style.left = Math.max(4, Math.min(b.left, innerWidth - menuEl.offsetWidth - 6)) + 'px';
    menuEl.style.top = b.bottom + 4 + 'px';
  }
  document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.menubtn')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // The toolbar is always ONE line: [ model | add | canvas | history ]  (mark)  [ levels | explore | app ]. Icons that matter least leave the
  // bar first (in DROP order) into the "⋯" menu when the editor is narrow, for example with the navigator open.
  const DROP = ['help', 'tools', 'governance', 'order', 'impact', 'project', 'align', 'search'];
  function renderBar(lop) { // lop: lopsided, each half takes the room it needs instead of equal halves (very narrow editors)
    const d = data(), hasProject = !!d.project;
    const ro0 = !!preview || !!broken || !hasProject, ro = ro0 || viewOnly;
    // release 2 part 10: adding a table/view/relationship/concept/entity/metric is allowed from the project-index file too (routed to its
    // correct part, see lib/project.js#applyProjectEdit); catalogs/schemas stay out of scope (a shared structural container, not named by the
    // task), so the Add menu's own two entries for them are left disabled even here (see the addRows list below).
    const roAdd = ro0 || (viewOnly && !indexFile);
    const canvasOnly = mode === 'schema';
    const nWarn = alignRes ? alignRes.open.length : 0;
    const key = isMac ? '⌘' : 'Ctrl+';
    const group = (name, ...kids) => h('div', { class: 'tgroup', 'data-group': name }, ...kids.filter(Boolean));
    const defs = { // the icons that can move into the "⋯" menu
      help: { icon: 'help', tip: `Help and shortcuts (${key}F1)`, fn: () => vscode.postMessage({ type: 'help' }) },
      // The Project View / project-index file (d.projectView) is the one read-only view where the menu still opens (ro0, not the fuller ro): ETL / HTML
      // export are pure reads; renderToolsPop disables embeddings and the live view individually, with their own reason.
      tools: { icon: 'tools', tip: 'Tools: embeddings, ETL code, export, live view', fn: () => { toolsOpen = true; syncToolsPop(); }, disabled: ro0 || (viewOnly && !d.projectView) },
      // release 2 part 9: creating/editing a tag from the project-index file routes to governance.json, so this shortcut stays enabled there.
      governance: { icon: 'governance', tip: 'Tags: labels you can put on anything; a tag can bring policies', fn: () => openTags(), disabled: ro0 || (viewOnly && !indexFile) },
      order: { icon: 'order', tip: 'Load order: which tables load first, which can load in parallel and what waits for what', fn: toggleOrder, disabled: !canvasOnly || level === 'semantic' || tabLv(level), on: orderOn },
      impact: { icon: 'impact', tip: 'Impact analysis: what breaks if something is deleted or changed, and which columns are unused', fn: toggleImpact, disabled: ro0 || !canvasOnly || tabLv(level), on: impactOn },
      align: { icon: 'align', tip: `Alignment and governance checks: map tables to entities and concepts, see what needs attention${nWarn ? ` (${plural(nWarn, 'warning')})` : ''}`, fn: toggleAlign, disabled: !hasProject || !!broken || !canvasOnly, on: alignOn },
      search: { icon: 'search', tip: `Search (${key}F)`, fn: () => openSearch(), on: searchOpen },
      // release 2 part 9: Project settings is editable from the project-index file too (writes to EVERY part's own model), so its own
      // read-only exception mirrors the Tools item's above rather than the fuller `ro`.
      project: { icon: 'project', tip: 'Project settings', fn: openProject, disabled: !!preview || !!broken || (viewOnly && !indexFile) },
    };
    const item = (id) => {
      const x = defs[id];
      const e = id === 'tools'
        ? h('button', { class: 'tb toolsbtn menubtn' + (toolsOpen ? ' on' : ''), 'data-tip': x.tip, 'aria-label': 'Tools', disabled: x.disabled || undefined, onclick: (ev) => { ev.stopPropagation(); toolsOpen = !toolsOpen; syncToolsPop(); } }, icon('tools'))
        : ib(x.icon, x.tip, x.fn, { disabled: x.disabled, on: x.on });
      e.dataset.item = id;
      if (id === 'align' && nWarn) e.append(h('span', { class: 'nbadge' }, nWarn > 99 ? '99+' : String(nWarn)));
      return e;
    };
    let dropped = [];
    const moreBtn = h('button', { class: 'tb morebtn menubtn', hidden: true, 'data-tip': 'More', 'aria-label': 'More tools', onclick: (ev) => { ev.stopPropagation(); openMenu(ev.currentTarget, dropped.map((id) => ({ icon: defs[id].icon, label: defs[id].tip.replace(/[:(].*$/, '').trim(), disabled: defs[id].disabled, fn: defs[id].fn }))); } }, icon('more'));
    // release 2 part 10: every row is allowed from the project-index file (roAdd). Catalog/schema (release 2 part 11: reopened — a shared
    // structural container that split()/applyProjectEdit derive from which tables use them; a brand new, still-tableless one is routed to
    // _unassigned instead, same as a homeless table already is, see lib/project.js#applyProjectEdit's own orphan-container handling).
    const addRows = [
      ...(hasProject && d.project.threePart ? [{ icon: 'catalog', plus: true, label: 'Catalog', fn: () => openCatalog(null), disabled: roAdd }] : []),
      { icon: 'schema', plus: true, label: 'Schema', fn: () => openSchema(null), disabled: roAdd },
      { icon: 'table', plus: true, label: 'Table', fn: () => openTable(null), disabled: roAdd },
      { icon: 'view', plus: true, label: 'View (view, temporary, materialized)', fn: () => openTable(null, undefined, 'view'), disabled: roAdd },
      { icon: 'relationship', plus: true, label: 'Relationship (1..1, 1..M, M..M)', fn: () => (layerRels() ? openLayerRelation(null) : openRelation(null)), disabled: roAdd },
      { icon: 'concept', plus: true, label: 'Concept (conceptual level)', fn: () => openConcept(null), disabled: roAdd },
      { icon: 'entity', plus: true, label: 'Entity (logical level)', fn: () => openEntity(null), disabled: roAdd },
      { icon: 'metric', plus: true, label: 'Metric (semantic level)', fn: () => openMetric(null), disabled: roAdd },
    ];
    const lvKey = (c) => ` (${isMac ? '⌥⌘' : 'Ctrl+Alt+'}${c})`;
    const levelTips = [['governance', 'Governance', 'Governance: policies, the tags that bring them and what they cover' + lvKey('G')], ['domains', 'Domains', 'Domains: named groups of concepts with a shared owner, and the split of the project into one file per domain'], ['conceptual', 'Conceptual', 'Conceptual: business entities and cardinality' + lvKey('C')], ['logical', 'Logical', 'Logical: attributes with display names and generic types' + lvKey('L')], ['physical', 'Physical', 'Physical: tables, columns and data types' + lvKey('P')], ['semantic', 'Semantic', 'Semantic: metrics, how they are calculated and the columns they use' + lvKey('S')]];
    bar.classList.toggle('lop', !!lop);
    bar.classList.remove('notitle');
    fill(bar, 
      h('div', { class: 'bl' },
        group('model', ib('navigator', `Navigator: the model as a tree (${key}L)`, () => vscode.postMessage({ type: 'toggleNav' })), item('project'), item('governance')),
        group('add', h('button', { class: 'tb menubtn', 'data-tip': 'Add: catalog, schema, table, view, relationship, concept, entity, metric', 'aria-label': 'Add', disabled: roAdd || undefined, onclick: (ev) => { ev.stopPropagation(); openMenu(ev.currentTarget, addRows); } }, icon('add'))),
        group('canvas', hasProject && !tabLv(level) && scopeButton(d)),
        group('history',
          ib('undo', 'Undo version', undo, { disabled: ro || !SM.undoTarget(hist, pointers) }),
          ib('redo', 'Redo version', redo, { disabled: ro || !SM.redoTarget(hist, pointers) }),
          ib('history', `Version history (${key}Y)`, () => { historyOpen = !historyOpen; if (historyOpen) impactOn = orderOn = alignOn = false; render(); }, { disabled: !!broken, on: historyOpen }))),
      h('button', { class: 'brand', 'data-tip': `${BRAND.name} · ${BRAND.url}`, 'aria-label': BRAND.name + ' website', onclick: () => vscode.postMessage({ type: 'openBrand' }) }, logo(26)),
      h('div', { class: 'br' },
        pending.length ? h('span', { class: 'pend', title: pending.join('\n') }, `● ${pending.length}`, h('span', { class: 'ptxt' }, ' change(s) — version is created on save')) : null,
        hasProject ? h('span', { class: 'ptitle' }, d.project.name, h('em', null, ` · ${d.project.technology} · ${d.project.methodology}`)) : null,
        group('levels',
          h('div', { class: 'seg' }, levelTips.map(([v, l, tip]) => h('button', { class: (v === level ? 'on' : '') + (v === 'domains' ? ' gvseg' : ''), 'data-tip': tip, 'aria-label': tip, disabled: !hasProject || mode === 'data', onclick: () => setLevel(v) }, h('span', { class: 'full' }, l), h('span', { class: 'short' }, l.slice(0, 3))))),
          segIcons([['schema', 'schemaMode', 'Schema canvas'], ['data', 'dataMode', 'Sample data (CSV files in the data folder next to the model)']], mode, setMode, !hasProject || tabLv(level))),
        group('explore', item('search'), item('impact'), item('order'), item('align')),
        group('app', item('tools'), item('help'), moreBtn, ib('settings', 'Settings', openSettings, { right: true }))));
    // one line, always: move the least important icons into the "⋯" menu until both halves fit
    // measure by the width the children need, not by scrollWidth: the right half is right-aligned, so its overflow would go to the LEFT
    // (over the mark and the left half) where scrollWidth cannot see it
    const bl = bar.querySelector('.bl'), br = bar.querySelector('.br'), brand = bar.querySelector('.brand');
    const need = (c) => [...c.children].reduce((sum, e) => sum + (e.offsetWidth ? e.offsetWidth + 2 : 0), 0);
    const tight = () => (lop ? need(bl) + need(br) + brand.offsetWidth + 24 > bar.clientWidth : need(bl) > bl.clientWidth || need(br) > br.clientWidth);
    // 1) the project name and the pending-change text give way, 2) the halves stop being equal (the mark drifts off-centre), 3) icons move into the "⋯" menu
    if (tight()) bar.classList.add('notitle');
    if (!lop && tight()) return renderBar(true);
    for (const id of lop ? DROP : []) {
      if (!tight()) break;
      const e = bar.querySelector(`[data-item="${id}"]`);
      if (e) { e.remove(); dropped.push(id); moreBtn.hidden = false; }
    }
  }
  let barW = 0;
  new ResizeObserver(() => { try { if (bar.clientWidth !== barW) { barW = bar.clientWidth; renderBar(); } } catch (err) { console.error('toolbar', err); } }).observe(bar);

  const hasScope = () => scope.c.size > 0 || scope.s.size > 0 || scope.k.size > 0;
  function scopeChanged() { autoFit = true; fit(); render(); }
  function clearScope() { scope = noScope(); scopeChanged(); }

  function scopeLabel(d) {
    const names = [...[...scope.c].map((id) => d.catalogs.find((c) => c.id === id)), ...[...scope.s].map((id) => d.schemas.find((x) => x.id === id)), ...[...scope.k].map((id) => d.concepts.find((x) => x.id === id))].filter(Boolean);
    if (!names.length) return 'Whole project';
    return names.length === 1 ? names[0].name : `${names.length} selected`;
  }

  function scopeButton(d) {
    return h('button', {
      class: 'scopebtn' + (hasScope() ? ' active' : ''), 'data-tip': 'View scope: choose catalogs, schemas or concepts to show together', 'aria-label': 'View scope',
      onclick: (e) => { e.stopPropagation(); scopeOpen = !scopeOpen; syncScopePop(); },
    }, icon('filter', false, 16), h('span', { class: 'sl' }, scopeLabel(d)), h('span', { class: 'caret' }, '▾'));
  }

  function renderScopePop() {
    const d = data(), three = d.project.threePart, memo = memoOf(d);
    const n = (f) => d.tables.filter(f).length;
    const row = (checked, lbl, sub, onchange, disabled, tipText) => h('label', { class: 'sp-row' + (disabled ? ' dis' : ''), ...(tipText ? { 'data-th': lbl, 'data-td': tipText } : {}) },
      h('input', { type: 'checkbox', checked, disabled, onchange }), h('span', { class: 'sp-l' }, lbl), h('small', null, sub));
    fill(scopePop, 
      h('div', { class: 'sp-head' }, h('strong', null, 'View scope'), h('button', { class: 'sp-all' + (hasScope() ? '' : ' on'), disabled: !hasScope(), onclick: clearScope }, hasScope() ? 'Show whole project' : '✓ Whole project')),
      h('div', { class: 'sp-body' },
        three && d.catalogs.length ? h('div', { class: 'sp-sec' }, 'Catalogs') : null,
        three ? d.catalogs.map((c) => row(scope.c.has(c.id), c.name, `${n((t) => d.schemas.some((s) => s.id === t.schemaId && s.catalogId === c.id))} tables`, (e) => {
          if (e.target.checked) { scope.c.add(c.id); d.schemas.filter((s) => s.catalogId === c.id).forEach((s) => scope.s.delete(s.id)); } else scope.c.delete(c.id);
          scopeChanged();
        }, false, c.description)) : null,
        h('div', { class: 'sp-sec' }, 'Schemas'),
        d.schemas.map((x) => {
          const viaCatalog = three && scope.c.has(x.catalogId);
          return row(viaCatalog || scope.s.has(x.id), schemaLabel(x, d), `${n((t) => t.schemaId === x.id)} tables`, (e) => {
            if (e.target.checked) scope.s.add(x.id); else scope.s.delete(x.id);
            scopeChanged();
          }, viaCatalog, x.description);
        }),
        d.concepts.length ? h('div', { class: 'sp-sec' }, 'Concepts') : null,
        [...d.concepts].sort(byName).map((c) => row(scope.k.has(c.id), c.name, `${n((t) => SA.entitiesOfTable(d, t, memo).some((e) => e.conceptId === c.id))} tables`, (e) => {
          if (e.target.checked) scope.k.add(c.id); else scope.k.delete(c.id);
          scopeChanged();
        }, false, c.description))),
      h('div', { class: 'sp-foot' }, 'Everything ticked is shown together, on every level: a concept brings its entities and their tables, a schema its tables and the entities and concepts they realise.'));
  }

  // Anchor a popover under its toolbar button.
  function placePop(pop, btnSel) {
    const btn = document.querySelector(btnSel);
    if (!btn) return;
    const mainR = pop.parentNode.getBoundingClientRect(), b = btn.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(b.left - mainR.left, mainR.width - 310)) + 'px';
    pop.style.top = b.bottom - mainR.top + 4 + 'px';
  }
  function syncScopePop() {
    scopePop.hidden = !scopeOpen || !data().project;
    if (scopePop.hidden) return;
    renderScopePop();
    placePop(scopePop, '.scopebtn');
  }

  // ---- Tools menu: generate / refresh vector embeddings for AI assistants ----
  function embedState() {
    if (indexFile) return embedStateProject();
    if (!embedStatus) return { cls: 'none', text: 'Not generated yet' };
    const names = Object.keys(embedStatus.providers).map((id) => (embedProviders.find((p) => p.id === id) || { label: id }).label).join(', ');
    const when = fmtTime(embedStatus.generatedAt);
    const { layout, version, ...content } = JSON.parse(modelText());
    return embedStatus.contentHash === SM.hash(SM.canon(content)) ? { cls: 'ok', text: `Up to date · ${names} · ${when}` } : { cls: 'stale', text: `Out of date: the model changed since ${when} · ${names}` };
  }
  // In the project-index file embeddings are generated once per domain PART, so the status is "N of M parts up to date" (one number would hide a
  // project where only some parts changed); the hover title breaks it down by part.
  function embedStateProject() {
    const parts = embedParts || [];
    if (!parts.length) return { cls: 'none', text: 'No parts to generate embeddings for.' };
    const upToDate = parts.filter((p) => p.upToDate).length, none = parts.filter((p) => !p.hasEmbeddings).length;
    const title = parts.map((p) => `${p.name}: ${p.upToDate ? 'up to date' : p.hasEmbeddings ? 'out of date' : 'not generated'}`).join('; ');
    if (upToDate === parts.length) return { cls: 'ok', text: `Up to date · ${parts.length} of ${parts.length} part(s)`, title };
    return { cls: none === parts.length ? 'none' : 'stale', text: `${upToDate} of ${parts.length} part(s) up to date`, title };
  }
  function renderToolsPop() {
    const st = embedState();
    // Read-only, assembled views (Project View, project-index file, exported / live HTML): ETL / HTML export are pure reads and work. Embeddings (per domain
    // part) and the live view (lib/live.js#startProjectLive) are enabled for the project-index file only (`indexFile`): no other read-only view has a manifest
    // of parts or an index file behind it.
    const embedWhy = 'Not available for this read-only, assembled project view: embeddings are generated and searched per model part. Open a single part to generate its own.';
    const liveWhy = 'Not available for this read-only view: there is no single model file (or project-index file) behind it for the live view to serve. Open a single part, or split into domains, for the live view.';
    const demoOff = hostKind === 'demo', demoWhy = 'Not available in the demo: it needs files on your disk. Run the live view on your own project.'; // the demo keeps everything in the browser tab
    const embedBlocked = (viewOnly && !indexFile) || demoOff, liveBlocked = viewOnly && !indexFile;
    fill(toolsPop,
      h('div', { class: 'sp-head' }, h('strong', null, 'Tools')),
      h('div', { class: 'sp-body' }, h('button', { class: 'tool', disabled: embedBlocked || undefined, title: embedBlocked ? (demoOff ? demoWhy : embedWhy) : (indexFile ? st.title : undefined), onclick: () => { toolsOpen = false; syncToolsPop(); (indexFile ? generateEmbeddingsProject : generateEmbeddings)(); } }, icon('embed', false, 22),
        h('span', null, h('b', null, 'Generate / refresh embeddings'), h('small', { class: 'tst ' + (embedBlocked ? '' : st.cls) }, embedBlocked ? (demoOff ? demoWhy : embedWhy) : st.text))),
        h('button', { class: 'tool', onclick: () => { toolsOpen = false; syncToolsPop(); exportCode(); } }, icon('code', false, 22),
          h('span', null, h('b', null, 'Export ETL / ELT code'), h('small', { class: 'tst' }, 'Airflow DAG, Dagster assets or a Jupyter notebook'))),
        h('button', { class: 'tool', disabled: demoOff || undefined, title: demoOff ? demoWhy : undefined, onclick: () => { toolsOpen = false; syncToolsPop(); vscode.postMessage({ type: 'exportHtml' }); } }, icon('export', false, 22),
          h('span', null, h('b', null, 'Export interactive HTML'), h('small', { class: 'tst' }, demoOff ? demoWhy : 'One self-contained, read-only file to open or share'))),
        hostKind === 'vscode' ? h('button', { class: 'tool', disabled: liveBlocked || undefined, title: liveBlocked ? liveWhy : undefined, onclick: () => { toolsOpen = false; syncToolsPop(); saveLayoutNow(); vscode.postMessage({ type: 'openLive' }); } }, icon('globe', false, 22),
          h('span', null, h('b', null, 'Open live view in browser'), h('small', { class: 'tst' }, liveBlocked ? liveWhy : 'The full tool in your default browser'))) : null),
      h('div', { class: 'sp-foot' }, indexFile ? "Each part gets its own <part>.model.embeddings.json, used by the strata-model skill. ETL/ELT and HTML export write to a file you choose." : viewOnly ? 'ETL/ELT and HTML export write to a file you choose.' : `Saved next to the model as ${embedFile || '<model>.model.embeddings.json'} and used by the strata-model skill.`));
  }
  function syncToolsPop() {
    toolsPop.hidden = !toolsOpen || !data().project;
    if (toolsPop.hidden) return;
    renderToolsPop();
    placePop(toolsPop, bar.querySelector('.toolsbtn') ? '.toolsbtn' : '.morebtn');
  }
  // boilerplate ETL / ELT code (media/codegen.js): the load order becomes tasks / assets / notebook stages
  function exportCode() {
    if (!model.project || !model.tables.length) return toast('Add some tables first.');
    const target = dropdown(Object.entries(CG.TARGETS).map(([value, t]) => ({ value, label: `${t.label} (.${t.ext})` })), 'airflow');
    const mode = dropdown([{ value: 'append', label: 'Append: INSERT ... SELECT' }, { value: 'replace', label: 'Replace: DELETE, then INSERT ... SELECT' }], 'append');
    const staging = h('input', { value: 'staging' });
    const sla = model.tables.some((t) => t.sla && (t.sla.exclude || t.sla.frequency));
    modal('Export ETL / ELT code', h('div', null,
      h('p', null, `One task per table and view (${model.tables.length}), wired by the load order: foreign keys and view reads decide what runs after what, and what can run in parallel.${sla ? ' The schedule and the SLA minutes come from the SLAs in the model; tables marked out of SLA are flagged as reference data.' : ' Add SLAs to tables to get a schedule.'} Each load is a starting point: an INSERT ... SELECT from a staging schema, or the view definition.`),
      field('Target', target), field('Load mode', mode), field('Staging schema', staging, 'Where the raw data lands: each table loads from <staging>.<table>')), [
      { label: 'Cancel' },
      { label: 'Export', primary: true, fn: () => {
        if (!identOk(staging.value.trim())) return 'The staging schema needs a name without spaces or dots.';
        let out;
        try { out = CG.generate(model, target.value, { mode: mode.value, staging: staging.value.trim() }); } catch (err) { return err.message; }
        vscode.postMessage({ type: 'saveFile', name: out.name, text: out.text });
      } },
    ]);
  }
  function generateEmbeddings() {
    const on = embedProviders.filter((p) => !settings.embed || settings.embed[p.id] !== false);
    if (!on.length) return toast('No embedding model is enabled. Turn some on under Settings → Vector embeddings.');
    const remote = on.filter((p) => p.needsKey && embedKeys[p.id]).map((p) => p.label), local = on.filter((p) => p.local);
    const skipped = on.filter((p) => p.needsKey && !embedKeys[p.id]).map((p) => p.label);
    modal('Generate / refresh embeddings', h('div', null,
      h('p', null, `Creates search vectors for the current model (versions ${SM.STREAMS.map((st) => (SM.entry(hist, pointers[st]) || {}).id || '–').join(' / ')}) and saves them as ${embedFile}. Unchanged parts reuse their previous vectors.`),
      remote.length ? h('p', null, h('b', null, 'Sent to (hosted APIs): '), remote.join(', '), '. Only model metadata leaves this machine (names, descriptions, view definitions, tags, relationship text). Sample data is never sent and e-mail addresses are removed.') : h('p', null, h('b', null, 'Nothing leaves this machine'), ' unless you add API keys for the hosted providers.'),
      local.length ? h('p', null, h('b', null, 'Runs on this machine, no key: '), local.map((p) => `${p.label} (${p.download} model, downloaded once from Hugging Face; works offline afterwards)`).join('; '), '.') : null,
      skipped.length ? h('p', { class: 'muted' }, `Skipped without an API key: ${skipped.join(', ')}. Add keys under Settings → Vector embeddings.`) : null), [
      { label: 'Cancel' },
      { label: 'Generate', primary: true, fn: () => { vscode.postMessage({ type: 'embed' }); toast('Generating embeddings…'); } },
    ]);
  }
  // The project-index file (release 2 part 9, ADR-0045 amended): the SAME "embed" message, but the host runs the existing single-part
  // embeddings pipeline once per domain part (lib/project.js's manifest), saving each part's own <part>.model.embeddings.json - not one
  // project-wide file (there is no single part-file at the index file's own path to save one next to).
  function generateEmbeddingsProject() {
    const parts = embedParts || [];
    if (!parts.length) return toast('No parts to generate embeddings for.');
    modal('Generate / refresh embeddings (every domain)', h('div', null,
      h('p', null, `Creates search vectors for each of the ${parts.length} part(s) of this project (${parts.map((p) => p.name).join(', ')}), saved as each part's own <part>.model.embeddings.json. Unchanged parts reuse their previous vectors.`),
      h('p', { class: 'muted' }, 'Uses the embedding models enabled under Settings → Vector embeddings, the same as generating embeddings for a single part.')), [
      { label: 'Cancel' },
      { label: 'Generate', primary: true, fn: () => { vscode.postMessage({ type: 'embed' }); toast('Generating embeddings for every part…'); } },
    ]);
  }
  document.addEventListener('pointerdown', (e) => { if (scopeOpen && !scopePop.contains(e.target) && !e.target.closest('.scopebtn')) { scopeOpen = false; syncScopePop(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && scopeOpen) { scopeOpen = false; syncScopePop(); } });
  document.addEventListener('pointerdown', (e) => { if (toolsOpen && !toolsPop.contains(e.target) && !e.target.closest('.toolsbtn')) { toolsOpen = false; syncToolsPop(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && toolsOpen) { toolsOpen = false; syncToolsPop(); } });

  // The part of what the level draws (d = tables, or the concepts / entities of SA.view) inside the current view scope (SA.inScope).
  function scoped(d) {
    if (!d.project || !hasScope()) return d;
    const S = SA.inScope(data(), scope);
    if (!S) return d; // everything picked has since been deleted
    let keep = d.layer === 'concept' ? S.concepts : d.layer === 'entity' ? S.entities : S.tables;
    if (d.layer === 'metric') { // metrics that read a table in scope (or build on such a metric), plus those tables
      keep = new Set(S.tables);
      for (let i = 0; i < 3; i++) d.tables.forEach((x) => { if (x.layer === 'metric' && x.columns.some((c) => keep.has(c.ref.tableId))) keep.add(x.id); });
    }
    const tables = d.tables.filter((t) => keep.has(t.id)), tids = new Set(tables.map((t) => t.id));
    const schemas = d.schemas.filter((x) => (!d.layer && S.schemas.has(x.id)) || tables.some((t) => t.schemaId === x.id));
    return {
      ...d, schemas, tables,
      catalogs: d.catalogs.filter((c) => S.catalogs.has(c.id) || schemas.some((x) => x.catalogId === c.id)),
      relations: (d.relations || []).filter((r) => tids.has(r.parentId) && tids.has(r.childId)),
    };
  }

  // what an older file layout turns into on the next save (ADR-0042)
  const legacyNote = () => `This model uses an older file layout (${[legacy.inline && 'canvas positions and version pointers inside the model file', legacy.log && 'its history in <name>.model.version.json'].filter(Boolean).join('; ')}). It is converted when you next save: the model file loses layout and version (it stays where it is), the history goes to history/<name>.history.jsonl (same versions, ids, times, users and messages; new hashes), the positions to <name>.model.layout.json beside the model, and a strata.project.json is added if the folder has none. Nothing is written before you save, and nothing is moved or deleted.${legacy.log ? ' The old <name>.model.version.json stays where it is: delete it once the new files are committed.' : ''}${legacy.merged ? ' Git had merged the old log; its versions were put in time order first.' : ''}`;
  // a log several people appended to (Git's merge=union keeps every line): the objects both changed differently, and which side the model holds
  const forkNote = () => forked.map((f) => {
    const who = f.heads.map((x) => `${x.id} by ${x.user}`).join(' and '), sides = (c) => c.sides.map((x) => (x.has ? '✓ ' : '') + x.entry.user).join(' / ');
    return `${f.stream}: ${f.heads.length} branches of the history (${who}); ${f.conflicts.length ? `changed differently on both sides: ${f.conflicts.slice(0, 8).map((c) => `${c.key} (${sides(c)})`).join(', ')}${f.conflicts.length > 8 ? ` and ${f.conflicts.length - 8} more` : ''}` : 'nothing was changed on both sides'}.`;
  }).join(' ');
  function recordMerge() {
    const f = SM.flatten(SM.toFile(model)), info = { message: 'Merged version histories', user: settings.name, email: settings.email, system: settings.system };
    for (const fk of forked) { const e = SM.commit(hist, fk.stream, pointers[fk.stream], f[fk.stream], info, { force: true }); if (e) pointers[fk.stream] = e.chain; }
    if (drift) record('Synced changes made outside Strata SQL'); // streams that are not forked but differ
    forked = null; drift = null;
    persist(true); render();
  }
  function renderBanner() {
    const box = (cls, ...kids) => { banner.hidden = false; banner.className = cls; fill(banner, ...kids); };
    if (broken) box('err', h('span', null, broken.startsWith(LOG_ERR) ? `${broken}. Open it in a text editor, fix it, then reopen this model.` : `This file is not valid JSON (${broken}). Use "Reopen Editor With… → Text Editor" to fix it.`));
    // an archived (pre-split) file (release 2 part 5): persistent for as long as the file is open (no Dismiss — it stays read-only and this
    // is the one place that says so), naming the parts it split into and the project-index file that shows the whole project assembled.
    else if (model.archived) {
      const a = model.archived, parts = a.parts || [];
      box('note',
        h('span', null, `This model was split into ${parts.length} domain part${parts.length === 1 ? '' : 's'} and archived here, read-only. `),
        ...parts.map((p) => h('button', { onclick: () => vscode.postMessage({ type: 'openPart', file: p.model }) }, p.name)),
        a.index ? h('button', { class: 'primary', onclick: () => vscode.postMessage({ type: 'openPart', file: a.index }) }, 'Open Project View') : null);
    }
    else if (preview) {
      const e = preview.entry;
      box('preview', h('span', null, `Previewing ${e.stream} ${e.id} · ${fmtTime(e.ts)} · ${e.user} — ${e.message}`),
        viewOnly ? null : h('button', { class: 'primary', onclick: applyPreview }, 'Apply this version'),
        h('button', { onclick: () => { preview = null; render(); } }, 'Cancel'));
    } else if (logBad) box('warn', h('span', null, `The version log was edited after it was recorded: ${logBad.slice(0, 3).join('; ')}${logBad.length > 3 ? ` (+${logBad.length - 3} more)` : ''}. Its hash chain no longer holds: the history may not be what was recorded.`), h('button', { onclick: () => { logBad = null; render(); } }, 'Dismiss'));
    else if (drift) {
      box('warn', h('span', null, `Version history doesn't match this model (${drift.join('; ')}). The model may have been edited outside Strata SQL, or copied without its history log (history/<name>.history.jsonl).${forked ? ' ' + forkNote() : ''}`),
        h('button', { onclick: () => { if (forked) recordMerge(); else { record('Synced changes made outside Strata SQL'); drift = null; persist(true); render(); } } }, forked ? 'Record this model as the merge' : 'Record as new version'),
        h('button', { onclick: () => { drift = null; forked = null; render(); } }, 'Dismiss'));
    } else if (forked) box('note', h('span', null, `The version log holds branches that were merged by Git. ${forkNote()} The model on screen is what Git and you made of it.`), viewOnly ? null : h('button', { class: 'primary', title: 'Add one version that joins the branches, with the model as it is', onclick: recordMerge }, 'Record the merge'), h('button', { onclick: () => { forked = null; render(); } }, 'Dismiss'));
    else if (legacy && !legacyHide && !viewOnly) box('note', h('span', null, legacyNote()), h('button', { class: 'primary', title: 'Mark the model changed so that Save writes the new files', onclick: () => { persist(true); toast('Save (Cmd/Ctrl+S) to write the converted files.'); render(); } }, 'Convert now'), h('button', { onclick: () => { legacyHide = true; render(); } }, 'Dismiss'));
    else if (model.warnings && model.warnings.length) {
      box('note', h('span', null, model.warnings[0]), h('button', { onclick: () => { model.warnings = []; render(); } }, 'OK'));
    } else banner.hidden = true;
  }

  function renderHistory() {
    drawer.hidden = !historyOpen || !!broken;
    // indexFile only (release 2 part 12): the part filter and the merged Undo/Redo only make sense, and only show, for the merged list -
    // every other view (including the ad hoc bespoke Project View panel, which never receives `histories`) is unaffected.
    const merged = indexFile && !!partHists;
    hpRow.hidden = undoAllBtn.hidden = redoAllBtn.hidden = !merged;
    if (!drawer.hidden) renderHistoryList();
  }

  // --- readable history: grouped by day, plain-language summary of what each version changed ---
  const KIND_NAME = { project: 'project', catalog: 'catalog', schema: 'schema', table: 'table', column: 'column', rel: 'relationship', tag: 'tag', assign: 'governance assignment', propertyKeys: 'property key list',
    concept: 'concept', entity: 'entity', crel: 'conceptual relationship', lrel: 'logical relationship', alignment: 'accepted alignment warning list', metric: 'metric', policy: 'policy', acknowledged: 'accepted warning list' };
  const keyKind = (k) => { const i = k.indexOf(':'); return i < 0 ? k : k.slice(0, i); };
  const keyName = (k) => { const i = k.indexOf(':'); return i < 0 ? '' : k.slice(i + 1); };
  const plural = (n, w, pl) => `${n} ${n === 1 ? w : pl || w + 's'}`;
  const relTime = (iso) => {
    const sec = (Date.now() - new Date(iso).getTime()) / 1000;
    if (sec < 45) return 'just now';
    if (sec < 3600) return Math.round(sec / 60) + ' min ago';
    if (sec < 86400) return Math.round(sec / 3600) + ' h ago';
    if (sec < 172800) return 'yesterday';
    return Math.round(sec / 86400) + ' days ago';
  };

  // what an entry changed compared with the previous entry of its stream (SM.changesOf: added / updated / deleted with before and after)
  const OPS = { '+': ['added', 'a'], '~': ['updated', 'm'], '−': ['deleted', 'r'] };
  const opOf = (it) => (it.moved ? ['moved', 'm'] : OPS[it.op]); // a domain change: the object left one part and joined another (SM.changesOf)
  const partLabel = (slug) => { const g = (partHists || []).find((x) => x.name === slug); return (g && g.domain) || slug; };
  const moveText = (mv) => (mv.from ? `from ${partLabel(mv.from)}` : `to ${partLabel(mv.to)}`);
  // the three version streams (ADR-0039)
  const STREAM_TIP = { modelling: 'Modelling stream: catalogs, schemas, tables, columns, relationships, concepts, entities, accepted alignment warnings',
    governance: 'Governance stream: tags, policies, owners and the other governance values, attachments, switch-offs, accepted governance warnings',
    semantic: 'Semantic stream: metrics (definition, calculation, aggregation, grain) and accepted metric warnings' };
  const chCache = new WeakMap();
  const entryChanges = (e, h = hist) => { if (!chCache.has(e)) chCache.set(e, SM.changesOf(h, e)); return chCache.get(e); }; // h: another part's own log (indexFile's merged list, release 2 part 12)
  const actionsOf = (e, ch) => { const a = new Set(ch.items.map((it) => opOf(it)[0])); if (e.layout) a.add('updated'); return a; };
  function summarize(e, ch) {
    if (ch.initial) { const kinds = {}; for (const it of ch.items) kinds[keyKind(it.k)] = (kinds[keyKind(it.k)] || 0) + 1; return 'Initial state: ' + Object.entries(kinds).map(([k, n]) => plural(n, KIND_NAME[k] || k)).join(', '); }
    const by = { '+': {}, '~': {}, '−': {} };
    const mv = ch.items.filter((it) => it.moved), kinds = {};
    for (const it of ch.items) if (!it.moved) { const kn = keyKind(it.k); by[it.op][kn] = (by[it.op][kn] || 0) + 1; } else kinds[keyKind(it.k)] = (kinds[keyKind(it.k)] || 0) + 1;
    const part = (op, verb) => { const t = Object.entries(by[op]).map(([k, n]) => plural(n, KIND_NAME[k] || k)).join(', '); return t ? `${verb} ${t}` : ''; };
    const moved = mv.length ? `Moved ${Object.entries(kinds).map(([k, n]) => plural(n, KIND_NAME[k] || k)).join(', ')} ${[...new Set(mv.map((it) => moveText(it.moved)))].join(', ')}` : '';
    const text = [part('+', 'Added'), part('~', 'Changed'), part('−', 'Removed'), moved].filter(Boolean).join(' · ');
    return e.layout ? (text ? text + ' · ' : '') + 'Auto layout (table positions)' : text || 'No content change';
  }
  // value text for before / after
  const fmtVal = (v) => (v === undefined ? '(none)' : v === '' ? '""' : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') || '(empty list)' : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${fmtVal(x)}`).join(', ') : String(v));
  const valEl = (v, cls) => { const t = fmtVal(v); return h('span', { class: 'vval ' + cls, title: t.length > 120 ? t : undefined }, t.length > 120 ? t.slice(0, 119) + '…' : t); };
  // one change: coloured indicator (added green, updated blue, deleted red), what it is, and per field before -> after
  function changeBlock(it) {
    let kk = it.k;
    const gov = keyKind(kk) === 'assign'; // tags / properties of an object: show which object
    if (gov) kk = keyName(kk) || 'project';
    const [word, c] = opOf(it), nm = keyName(kk) || (gov ? '' : keyName(it.k));
    if (it.moved) return h('div', { class: 'vch m' }, h('div', { class: 'vchh' }, h('span', { class: 'vbadge m' }, word), h('span', { class: 'vk' }, gov ? `tags & properties of ${keyKind(kk)}` : KIND_NAME[keyKind(it.k)] || keyKind(it.k)), h('code', null, nm)),
      h('div', { class: 'vf' }, h('span', { class: 'vfn' }, 'domain'), it.moved.from ? [valEl(partLabel(it.moved.from), 'was'), h('span', { class: 'varrow' }, '→'), valEl('this part', 'now')] : [valEl('this part', 'was'), h('span', { class: 'varrow' }, '→'), valEl(partLabel(it.moved.to), 'now')]));
    const fields = it.op === '~' ? it.fields : Object.entries(it.op === '+' ? it.after : it.before).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)).map(([f, v]) => ({ f, [it.op === '+' ? 'after' : 'before']: v }));
    const line = (fl) => h('div', { class: 'vf' }, fl.f ? h('span', { class: 'vfn' }, fl.f) : null,
      it.op === '~' ? [valEl(fl.before, 'was'), h('span', { class: 'varrow' }, '→'), valEl(fl.after, 'now')] : valEl(it.op === '+' ? fl.after : fl.before, it.op === '+' ? 'now' : 'was'));
    return h('div', { class: 'vch ' + c },
      h('div', { class: 'vchh' }, h('span', { class: 'vbadge ' + c }, word), h('span', { class: 'vk' }, gov ? `tags & properties of ${keyKind(kk)}` : KIND_NAME[keyKind(it.k)] || keyKind(it.k)), h('code', null, nm)),
      ...fields.slice(0, 10).map(line), fields.length > 10 ? h('div', { class: 'vf muted' }, `…and ${fields.length - 10} more fields`) : null);
  }

  const VER_PAGE = 50;
  // the calendar helpers of both version lists, in the chosen timezone
  function clock() {
    const tz = settings.timezone || undefined;
    const day = (iso) => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); } catch { return iso.slice(0, 10); } };
    const dayLabel = (iso) => {
      const dk = day(iso);
      if (dk === day(new Date().toISOString())) return 'Today';
      if (dk === day(new Date(Date.now() - 864e5).toISOString())) return 'Yesterday';
      try { return new Date(iso).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); } catch { return dk; }
    };
    const stamp = (iso) => { try { return new Date(iso).toLocaleString('sv-SE', { timeZone: tz, hour12: false }).replace(' ', 'T').slice(0, 16); } catch { return iso.slice(0, 16); } }; // wall-clock 'YYYY-MM-DDTHH:mm' in the chosen timezone
    return { day, dayLabel, stamp };
  }
  // does version `e` pass the drawer's filters? `ch()` = its changes (only read when the action filter is set), `extra` = more searchable text
  const verShown = (e, undone, ck, term, ch, extra = '') => (hu.checked || !undone) && (!hs.value || e.stream === hs.value) && (!hf.value || ck.stamp(e.ts) >= hf.value) && (!ht.value || ck.stamp(e.ts) <= ht.value)
    && (!ha.value || actionsOf(e, ch()).has(ha.value)) && (!term || `${e.id} ${e.stream} ${e.message} ${e.user} ${e.email || ''} ${e.system || ''} ${fmtTime(e.ts)} ${extra}`.toLowerCase().includes(term));
  // one version card. `lead` pills follow the id, `buttons` come before Details, `rerender` redraws the list when Details is toggled
  function verCard(e, ch, { cls = '', lead = [], undone, buttons, rerender }) {
    const opened = openVer.has(e.chain), counts = { added: 0, updated: 0, deleted: 0, moved: 0 };
    ch.items.forEach((it) => { counts[opOf(it)[0]]++; });
    if (e.layout) counts.updated++;
    const details = opened ? (ch.initial ? [h('div', { class: 'vd' }, 'Full initial content of this stream (' + plural(ch.items.length, 'object') + ').')] : [
      ...ch.items.slice(0, 40).map(changeBlock), ch.items.length > 40 ? h('div', { class: 'vd' }, `…and ${ch.items.length - 40} more`) : null,
      e.layout ? h('div', { class: 'vch m' }, h('div', { class: 'vchh' }, h('span', { class: 'vbadge m' }, 'updated'), h('span', { class: 'vk' }, 'table positions'), h('code', null, e.layout.level || ''))) : null]) : [];
    return h('div', { class: 'ver ' + e.stream + cls + (undone ? ' undone' : '') },
      h('div', { class: 'vh' }, h('span', { class: 'pill ' + e.stream, title: STREAM_TIP[e.stream] }, e.stream[0].toUpperCase() + e.stream.slice(1)), h('code', { title: `entry ${e.chain.slice(0, 12)}${e.was ? `, was ${e.was} in the older log` : ''}` }, e.id), ...lead,
        undone ? h('span', { class: 'pill', title: 'An edit after an undo left this version behind; it stays in the file' }, 'Undone') : null, e.merge ? h('span', { class: 'pill', title: 'Joins branches of the history merged by Git' }, 'Merge') : null,
        h('span', { class: 'vtime', title: fmtTime(e.ts) }, relTime(e.ts))),
      h('div', { class: 'vmsg' }, e.message),
      h('div', { class: 'vacts' }, ...Object.entries(counts).filter(([, n]) => n).map(([w, n]) => h('span', { class: 'vact ' + { added: 'a', updated: 'm', deleted: 'r', moved: 'm' }[w], title: `${n} ${w}` }, `${{ added: '＋', updated: '~', deleted: '−', moved: '⇄' }[w]}${n} ${w}`))),
      h('div', { class: 'vsum' }, summarize(e, ch)),
      h('div', { class: 'vm' }, h('span', { class: 'vuser', ...tipProps(e.user, [e.email, e.system && 'Host: ' + e.system].filter(Boolean).join('\n'), '', true) }, '👤 ' + e.user), ` · ${fmtTime(e.ts)}`),
      h('div', { class: 'vb' }, ...buttons, h('button', { class: 'lnk', onclick: () => { if (opened) openVer.delete(e.chain); else openVer.add(e.chain); rerender(); } }, opened ? 'Hide details' : 'Details')),
      ...details);
  }
  // rows: [{ e, card() }] newest first, under one heading per day. Cards (and the changes behind them) are built for the first `verLimit` only:
  // on a large model each one costs a replay of its entry, so a long log opens at once and "Show more" adds a page.
  let verLimit = VER_PAGE;
  function fillVersions(rows, ck, filtered) {
    const perDay = new Map();
    for (const { e } of rows) perDay.set(ck.day(e.ts), (perDay.get(ck.day(e.ts)) || 0) + 1);
    const out = [];
    let lastDay = null;
    for (const { e, card } of rows.slice(0, verLimit)) {
      const dk = ck.day(e.ts);
      if (dk !== lastDay) { lastDay = dk; const n = perDay.get(dk); out.push(h('div', { class: 'vday' }, ck.dayLabel(e.ts), h('small', null, ` · ${n} version${n === 1 ? '' : 's'}`))); }
      out.push(card());
    }
    if (rows.length > verLimit) out.push(h('button', { class: 'lnk', onclick: () => { verLimit += VER_PAGE; renderHistoryList(); } }, `Show ${Math.min(VER_PAGE, rows.length - verLimit)} more (${rows.length - verLimit} older)`));
    fill(hlist, ...(out.length ? out : [h('p', { class: 'muted' }, filtered ? 'No matching versions.' : 'No versions yet.')]));
  }
  const newestFirst = (a, b) => (a.e.hlc < b.e.hlc ? 1 : a.e.hlc > b.e.hlc ? -1 : 0);

  function renderHistoryList() {
    if (indexFile && partHists) return renderMergedHistoryList(); // the project-index file's own tab gets the merged list instead
    const ck = clock(), term = hq.value.trim().toLowerCase();
    const live = new Map(SM.STREAMS.map((st) => [st, SM.liveKeys(hist, st)])), above = new Map(SM.STREAMS.map((st) => [st, pointers[st] ? SM.ancestors(hist, pointers[st]) : new Set()]));
    const rows = [];
    for (const e of hist.entries) {
      const undone = !live.get(e.stream).has(e.chain);
      if (!verShown(e, undone, ck, term, () => entryChanges(e))) continue;
      const cur = e.chain === pointers[e.stream], back = above.get(e.stream).has(e.chain); // back: made before the current version
      const ahead = !pointers[e.stream] || SM.ancestors(hist, e.chain).has(pointers[e.stream]); // made on top of the current version (else: another branch)
      rows.push({ e, card: () => verCard(e, entryChanges(e), { undone, cls: (cur ? ' cur' : '') + (preview && preview.entry.chain === e.chain ? ' prev' : ''), lead: [cur ? h('span', { class: 'pill now' }, 'Current') : null], rerender: renderHistoryList,
        buttons: [cur || undone ? null : h('button', { title: back ? 'Go back to this version' : ahead ? 'Go forward to this version' : 'Show the model as this version of the other branch has it', onclick: () => gotoEntry(e) }, back ? 'Undo to here' : ahead ? 'Redo to here' : 'Switch to here'),
          cur ? null : h('button', { title: 'View this point in time before committing', onclick: () => startPreview(e) }, 'Preview')] }) });
    }
    rows.sort(newestFirst);
    fillVersions(rows, ck, term || hs.value || ha.value || hf.value || ht.value);
  }

  // ---------- the project-index file's own merged history ----------
  // Every part's own log (partHists, parsed on load from `m.histories`) merged into one chronological, read-only list, each entry tagged with its part
  // (governance.json's own log is included too, tagged 'gov'), using the same filters plus a part filter (hp). Per row only "Open <part> →" instead of
  // Preview / Undo to here: previewing an older state across independent per-part histories is a deliberate scope cut; the part's own editor offers it.
  // The one cross-part action is the drawer's Undo/Redo (undoAllBtn / redoAllBtn, lib/project.js#projectGoto).
  function renderMergedHistoryList() {
    const ck = clock(), term = hq.value.trim().toLowerCase(), curHp = hp.value;
    fill(hp, h('option', { value: '' }, 'All parts'), ...partHists.map((g) => h('option', { value: g.name }, (g.gov ? 'governance.json (shared tags/policies)' : g.name + (g.domain ? ` (${g.domain})` : '')))));
    hp.value = curHp;
    const rows = [];
    for (const grp of partHists) {
      if (hp.value && grp.name !== hp.value) continue;
      const live = new Map(SM.STREAMS.map((st) => [st, SM.liveKeys(grp.hist, st)]));
      for (const e of grp.hist.entries) {
        const undone = !live.get(e.stream).has(e.chain);
        if (!verShown(e, undone, ck, term, () => entryChanges(e, grp.hist), `${grp.name} ${grp.domain || ''}`)) continue;
        rows.push({ e, card: () => verCard(e, entryChanges(e, grp.hist), { undone, rerender: renderMergedHistoryList,
          lead: [h('span', { class: 'pill', title: grp.gov ? 'governance.json: shared tags and policies' : `Part: ${grp.name}${grp.domain ? ` · domain ${grp.domain}` : ''}` }, grp.gov ? 'governance.json' : grp.name)],
          buttons: [grp.gov ? null : h('button', { title: `Open ${grp.name}'s own editor: its own History drawer previews or undoes to any of its versions`, onclick: () => vscode.postMessage({ type: 'openPart', file: grp.model }) }, `Open ${grp.name} →`)] }) });
      }
    }
    rows.sort(newestFirst);
    fillVersions(rows, ck, term || hs.value || ha.value || hf.value || ht.value || hp.value);
  }

  // ---------- canvas rendering ----------
  function frameRects(d) {
    const P = 24, TOP = 44, three = d.project && d.project.threePart, all = d.tables;
    const bounds = (rs, pad, top) => {
      const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
      return { x: x0 - pad, y: y0 - top, w: x1 - x0 + 2 * pad, h: y1 - y0 + top + pad };
    };
    const fx = all.length ? Math.min(...all.map((t) => t.x)) : 0;
    let fy = all.length ? Math.max(...all.map((t) => t.y + H(t))) + 140 : 0;
    const sr = d.schemas.map((s) => {
      const ts = all.filter((t) => t.schemaId === s.id);
      let r;
      if (ts.length) r = bounds(ts.map((t) => ({ x: t.x, y: t.y, w: W, h: H(t) })), P, TOP);
      else { r = { x: fx - P, y: fy, w: W + 2 * P, h: 100 }; fy += 160; }
      return { s, r };
    });
    const cr = [];
    if (three) for (const c of d.catalogs) {
      const rs = sr.filter((o) => o.s.catalogId === c.id).map((o) => o.r);
      let r;
      if (rs.length) r = bounds(rs, 16, 32);
      else { r = { x: fx - P - 16, y: fy, w: W + 2 * P + 32, h: 90 }; fy += 150; }
      cr.push({ c, r });
    }
    return { sr, cr };
  }
  const rectStyle = (r) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;

  function drawFrames() {
    const d = scoped(shown());
    if (!d.project) return framesLayer.replaceChildren();
    const { sr, cr } = frameRects(d);
    const lbl = (o) => (level === 'physical' ? o.name : o.displayName || o.name);
    const frameClick = (s) => (impactOn && d.layer ? null : s.concept ? openConcept(s.concept) : s.id.startsWith('_') ? null : openSchema(s)); // logical level: one frame per concept
    fill(framesLayer, 
      ...cr.map(({ c, r }) => h('div', { class: 'frame catalog' + impactFrame('catalog', c.id, d.schemas.filter((x) => x.catalogId === c.id).map((x) => x.id), d), style: rectStyle(r) },
        h('span', { class: 'flabel', 'data-tk': 'catalog:' + c.id, onclick: () => (impactOn ? toggleImpactNode('catalog', c.id) : !preview && !viewOnly && openCatalog(c)) }, '▣ ' + lbl(c)))),
      ...sr.filter(({ s }) => !s.hidden).map(({ s, r }) => h('div', { class: 'frame schema' + (s.concept || s.id === '_none' ? ' cframe' : '') + impactFrame('schema', s.id, [s.id], d), style: rectStyle(r) },
        h('span', { class: 'flabel', 'data-tk': s.concept ? 'concept:' + s.concept.id : s.id.startsWith('_') ? null : 'schema:' + s.id, onclick: () => (impactOn ? toggleImpactNode('schema', s.id) : !preview && !viewOnly && frameClick(s)) }, (s.concept ? '◎ ' : '▤ ') + lbl(s)))));
  }

  // Tables to keep at full strength: the selected table plus tables it relates to. null = no focus.
  function focusSet() {
    const d = scoped(shown());
    if (impactOn || orderOn || !selected || dragLink || !d.tables.some((t) => t.id === selected)) return null;
    const s = new Set([selected]);
    for (const t of d.tables) for (const c of t.columns) {
      const f = c.foreignKey;
      if (!f) continue;
      if (t.id === selected) s.add(f.tableId);
      if (f.tableId === selected) s.add(t.id);
    }
    for (const r of d.relations || []) {
      if (r.parentId === selected) s.add(r.childId);
      if (r.childId === selected) s.add(r.parentId);
    }
    return s;
  }

  function applyFocus() {
    const f = focusSet();
    cardsLayer.querySelectorAll('.card').forEach((c) => {
      c.classList.toggle('sel', c.dataset.t === selected);
      c.classList.toggle('dim', !!f && !f.has(c.dataset.t));
    });
    drawEdges(); drawMini(true);
  }

  const SLA_SHORT = { realtime: 'RT', minute: '1m', hourly: '1h', daily: 'D', weekly: 'W', biweekly: '2W', monthly: 'M', quarterly: 'Q', yearly: 'Y' };
  const slaText = (a) => (a.exclude ? 'Out of SLA: static / reference data, left out of the SLA calculation' : `SLA: data is refreshed ${a.frequency}${a.time ? ' and available by ' + a.time : ''}`);
  function slaChip(t) {
    const a = t.sla;
    return a && (a.exclude || a.frequency) ? h('span', { class: 'slachip' + (a.exclude ? ' ex' : ''), title: slaText(a) }, a.exclude ? '⏱ n/a' : `⏱ ${SLA_SHORT[a.frequency]}${a.time ? ' ' + a.time : ''}`) : null;
  }

  // Project View only: which domain a table / concept / entity came from, badged on its card like the classification lock badge: a colour cycling through
  // the six chart colours. Built once per render() (`domByTable` avoids an O(tables²) `SM.refs` per card) from every domain name in `model.domainOf`.
  const DOM_PALETTE = ['charts-blue', 'charts-green', 'charts-orange', 'charts-purple', 'charts-red', 'charts-yellow'];
  let domColors = new Map(), domByTable = new Map();
  function buildDomColors() {
    domColors = new Map(); domByTable = new Map();
    if (!model.domainOf) return;
    const names = new Set();
    for (const kind of ['tables', 'concepts', 'entities']) for (const v of Object.values(model.domainOf[kind] || {})) names.add(v);
    [...names].sort().forEach((n, i) => domColors.set(n, DOM_PALETTE[i % DOM_PALETTE.length]));
    if (model.domainOf.tables && model.tables.length) { const R = SM.refs(model); for (const t of model.tables) { const nm = model.domainOf.tables[(R.tab.get(t.id) || '').toLowerCase()]; if (nm) domByTable.set(t.id, nm); } }
  }
  function domainBadge(name) {
    return name ? h('span', { class: 'dombadge ' + (domColors.get(name) || DOM_PALETTE[0]), 'data-tip': name + ' domain' }, name) : null;
  }
  const domainOfLayer = (t) => model.domainOf && ((t.layer === 'concept' ? model.domainOf.concepts : model.domainOf.entities) || {})[t.name.toLowerCase()];
  // one small fixed legend, bottom-left (Project View only): domain name -> the same colour its badges use
  function renderDomLegend() {
    domlegend.hidden = !domColors.size || mode === 'data' || tabLv(level);
    if (domlegend.hidden) return;
    fill(domlegend, ...[...domColors].map(([name, c]) => h('span', { class: 'dlrow' }, h('i', { class: 'dot ' + c }), name)));
  }

  // open alignment warnings about one node, as a small amber badge on its card
  function alignBadge(t) {
    const ws = (alignRes && fresh().byGo.get(t.id)) || [];
    return ws.length ? h('span', { class: 'alnbadge', ...tipProps(`Alignment: ${plural(ws.length, 'warning')}`, ws.map((w) => '• ' + w.text).join('\n'), 'Open Alignment in the toolbar to fix or accept them.', true) }, '⚠ ' + ws.length) : null;
  }
  const tagsTip = (ef) => tipProps('Tags', ef.tags.map((x) => tagLine(x.name) + (x.from ? ` (from ${SA.fromText(x.from)})` : '')).join('\n'), '', true);

  // a concept (conceptual level) or a logical entity (logical level) when the model has that layer
  function layerCard(t, focus) {
    const d = data(), memo = memoOf(d), isC = t.layer === 'concept', ef = SA.effective(d, t, memo);
    const head = h('div', { class: 'head', 'data-tk': t.layer + ':' + t.id },
      h('span', { class: 'kico' }, icon(t.layer, false, 14)),
      h('span', { class: 'tname' }, t.name),
      impactBadge(t),
      orderBadge(t),
      alignBadge(t),
      clsChip(t),
      domainBadge(domainOfLayer(t)),
      ef.tags.length ? h('span', { class: 'tagn', ...tagsTip(ef) }, '#' + ef.tags.length) : null,
      h('button', { class: 'ib', dataset: { act: 'edit-table' }, title: isC ? 'Edit concept' : 'Edit entity' }, '✎'));
    const cls = 'card lv-' + level + ' layer-' + t.layer + (t.id === selected ? ' sel' : '') + (focus && !focus.has(t.id) ? ' dim' : '') + impactCard(t) + orderCard(t);
    const st = `left:${t.x}px;top:${t.y}px;height:${H(t)}px`;
    if (isC) {
      const es = SA.entitiesOf(d, t, memo), nt = new Set(es.flatMap((e) => SA.tablesOf(d, e, memo))).size;
      return h('div', { class: cls, dataset: { t: t.id }, style: st }, head,
        h('div', { class: 'concept', title: 'Drag onto another concept to relate them' }, h('div', { class: 'cdesc' }, (ef.description && ef.description.v) || 'No description yet'),
          h('div', { class: 'cmeta' }, `${plural(es.length, 'entity', 'entities')} · ${plural(nt, 'table')}${es.length ? ': ' + es.map((e) => e.name).join(', ') : ''}`)));
    }
    const ts = SA.tablesOf(d, t, memo);
    return h('div', { class: cls, dataset: { t: t.id }, style: st, title: 'Drag from the body onto another entity to relate them' }, head,
      t.columns.map((c) => h('div', { class: 'row', dataset: { t: t.id, c: c.id }, 'data-tk': 'column:' + c.id },
        h('span', { class: 'badge ' + (c.primaryKey ? 'pk' : c.foreignKey ? 'fk' : '') }, c.primaryKey && c.foreignKey ? 'PF' : c.primaryKey ? 'PK' : c.foreignKey ? 'FK' : ''),
        h('span', { class: 'cname' + (c.notNull ? ' nn' : '') }, label(c)),
        h('span', { class: 'ctype' }, logicalType(c.dataType)))),
      h('div', { class: 'foot realised', title: ts.map((x) => fullName(x, d)).join('\n') }, ts.length ? 'Realised by ' + ts.map((x) => x.name).join(', ') : 'Not realised by a table yet'));
  }

  // a metric on the semantic level: aggregation and tag count in the header, one row per input (column or metric), grain at the foot
  function metricCard(t, focus) {
    const agg = GV.AGG_SHORT[t.aggregation];
    const head = h('div', { class: 'head', 'data-tk': 'metric:' + t.id },
      h('span', { class: 'kico' }, icon('metric', false, 14)), h('span', { class: 'tname' }, t.name),
      agg ? h('span', { class: 'vt', title: 'Aggregation: ' + GV.AGG[t.aggregation] }, agg) : null,
      impactBadge(t), alignBadge(t), clsChip(t),
      t.tags.length ? h('span', { class: 'tagn', ...tagsTip(SA.effective(data(), t, memoOf(data()))) }, '#' + t.tags.length) : null,
      h('button', { class: 'ib', dataset: { act: 'edit-table' }, title: 'Edit metric' }, '✎'));
    const cls = 'card lv-semantic layer-metric' + (t.id === selected ? ' sel' : '') + (focus && !focus.has(t.id) ? ' dim' : '') + impactCard(t);
    return h('div', { class: cls, dataset: { t: t.id }, style: `left:${t.x}px;top:${t.y}px;height:${H(t)}px` }, head,
      t.columns.map((c) => h('div', { class: 'row', dataset: { t: t.id, c: c.id } },
        h('span', { class: 'badge ' + (c.ref.columnId ? '' : 'fk') }, c.ref.columnId ? '' : 'M'), h('span', { class: 'cname' }, c.name), h('span', { class: 'ctype' }, c.dataType))), // column + its table, or {metric} + "metric"
      h('div', { class: 'foot realised', title: t.calculation }, (t.grain || []).length ? 'Grain: ' + t.grain.join(', ') : 'No grain set'));
  }

  function cardEl(t, focus) {
    if (t.layer === 'metric') return metricCard(t, focus);
    if (t.layer) return layerCard(t, focus);
    const fkOf = (c) => !!c.foreignKey;
    const eff = SA.effective(data(), t, memoOf(data())), tagN = eff.tags.length; // own and inherited tags
    const isView = t.kind === 'view';
    const vlabel = { view: 'View', temporary: 'Temporary view', materialized: 'Materialized view' }[t.viewType || 'view'];
    const head = h('div', { class: 'head', 'data-tk': 'table:' + t.id },
      h('span', { class: 'kico' }, icon(isView ? 'view' : 'table', false, 14)),
      h('span', { class: 'tname' }, label(t)),
      slaChip(t),
      isView && t.viewType && t.viewType !== 'view' ? h('span', { class: 'vt', title: vlabel }, t.viewType === 'materialized' ? 'MAT' : 'TEMP') : null,
      impactBadge(t),
      orderBadge(t),
      alignBadge(t),
      clsChip(t),
      domainBadge(domByTable.get(t.id)),
      tagN ? h('span', { class: 'tagn', ...tagsTip(eff) }, '#' + tagN) : null,
      h('button', { class: 'ib', dataset: { act: 'edit-table' }, title: isView ? 'Edit view' : 'Edit table' }, '✎'));
    const cls = 'card lv-' + level + (isView ? ' kind-view' : '') + (t.id === selected ? ' sel' : '') + (focus && !focus.has(t.id) ? ' dim' : '') + impactCard(t) + orderCard(t);
    const st = `left:${t.x}px;top:${t.y}px;height:${H(t)}px`;
    if (level === 'conceptual') {
      return h('div', { class: cls, dataset: { t: t.id }, style: st }, head,
        h('div', { class: 'concept', title: 'Drag onto another entity to relate them' }, h('div', { class: 'cdesc' }, t.description || 'No description yet'),
          h('div', { class: 'cmeta' }, `${isView ? vlabel + ' · ' : ''}${t.columns.length} attribute${t.columns.length === 1 ? '' : 's'}${t.name !== label(t) ? ' · ' + t.name : ''}`)));
    }
    return h('div', { class: cls, dataset: { t: t.id }, style: st }, head,
      t.columns.map((c) => h('div', { class: 'row' + impactRow(c), dataset: { t: t.id, c: c.id }, 'data-tk': 'column:' + c.id },
        h('span', { class: 'badge ' + (c.primaryKey ? 'pk' : fkOf(c) ? 'fk' : '') }, c.primaryKey && fkOf(c) ? 'PF' : c.primaryKey ? 'PK' : fkOf(c) ? 'FK' : ''),
        h('span', { class: 'cname' + (c.notNull ? ' nn' : '') }, label(c)),
        clsChip(c, true),
        h('span', { class: 'ctype' }, level === 'logical' ? logicalType(c.dataType) : c.dataType))),
      h('div', { class: 'foot' }, h('button', { dataset: { act: 'add-col' } }, '+ Add column')));
  }

  function drawCards() {
    const f = focusSet();
    fill(cardsLayer, ...scoped(shown()).tables.map((t) => cardEl(t, f)));
  }

  // Relationship edges visible at the current level. Conceptual collapses everything to one edge per table pair.
  function relItems(d) {
    const byId = new Map(d.tables.map((t) => [t.id, t]));
    const items = [];
    for (const t of d.tables) t.columns.forEach((c, i) => {
      const f = c.foreignKey, p = f && byId.get(f.tableId);
      if (!p) return;
      if (t.layer === 'metric') { items.push({ kind: 'lin', metric: true, t, p, ci: i, pj: c.ref.columnId ? p.columns.findIndex((x) => x.id === c.ref.columnId) : -1, card: '' }); return; } // what a metric reads
      const j = p.columns.findIndex((x) => x.id === f.columnId);
      if (j >= 0) items.push({ kind: 'fk', t, p, ci: i, pj: j, card: f.cardinality || '1..M', col: c, name: f.name, description: f.description });
    });
    for (const r of d.relations || []) {
      const t = byId.get(r.childId), p = byId.get(r.parentId);
      if (!t || !p) continue;
      if (level !== 'conceptual' && r.viaId && byId.has(r.viaId)) continue; // realised by a bridge table: physical/logical show the bridge instead
      items.push({ kind: 'rel', t, p, ci: -1, pj: -1, card: r.cardinality || '', rel: r, name: r.name, description: r.description });
    }
    if (level !== 'conceptual' || layerRels()) return items; // concepts keep parallel relationships; tables collapse to one edge per pair
    const seen = new Set();
    return items.filter((it) => { const k = it.t.id + '>' + it.p.id; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // Edge geometry. d1/d2 are the outward directions (-1 left, 1 right) at each end.
  function edgePath(x1, y1, d1, x2, y2, d2) {
    if (settings.arrows === 'curved') {
      const off = d1 === d2 ? 60 + Math.abs(y2 - y1) / 6 : Math.max(40, Math.abs(x2 - x1) / 2);
      return `M${x1} ${y1} C${x1 + d1 * off} ${y1} ${x2 + d2 * off} ${y2} ${x2} ${y2}`;
    }
    let pts;
    if (d1 === d2) {
      const ox = d1 > 0 ? Math.max(x1, x2) + 30 : Math.min(x1, x2) - 30;
      pts = [[x1, y1], [ox, y1], [ox, y2], [x2, y2]];
    } else {
      const mx = (x1 + x2) / 2;
      pts = [[x1, y1], [mx, y1], [mx, y2], [x2, y2]];
    }
    const R = 8, step = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [l, l ? (b[0] - a[0]) / l : 0, l ? (b[1] - a[1]) / l : 0]; };
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [l1, ux1, uy1] = step(pts[i - 1], pts[i]), [l2, ux2, uy2] = step(pts[i], pts[i + 1]);
      const r = Math.min(R, l1 / 2, l2 / 2), p = pts[i];
      d += ` L${p[0] - ux1 * r} ${p[1] - uy1 * r} Q${p[0]} ${p[1]} ${p[0] + ux2 * r} ${p[1] + uy2 * r}`;
    }
    return d + ` L${x2} ${y2}`;
  }

  // Relationships that point at nothing locally (ADR-0042) are kept as written; a stub runs out from the card at the end that exists. A genuinely broken
  // reference (found nowhere in the project) is the dashed red "✕ name"; one that is a real object in another part of a split project (m.crossPart,
  // SA.crossHas) is a neutral accent stub "→ Name (Domain)" and is not a warning (broken-ref only fires for the first kind).
  function brokenStubs(d, anchorY) {
    const src = data(), lists = d.layer === 'concept' ? ['conceptual'] : d.layer === 'entity' ? ['logical'] : d.layer ? [] : ['relationships'], out = [], used = new Map();
    if (!(src.dangling || []).length || !lists.length) return out;
    const R = SM.refs(src), byRef = new Map(src.tables.map((t) => [R.tab.get(t.id), t])), inD = new Map(d.tables.map((t) => [t.id, t]));
    const find = (list, ref) => { // -> {t, ci} of the card a reference names, when it is drawn
      if (list !== 'relationships') { const t = d.tables.find((x) => x.name === ref); return t && { t, ci: -1 }; }
      const tb = byRef.get(ref), cb = !tb && byRef.get(String(ref).split('.').slice(0, -1).join('.')), t = inD.get((tb || cb || {}).id);
      return t && { t, ci: cb ? t.columns.findIndex((c) => c.name === String(ref).split('.').pop()) : -1 };
    };
    for (const dg of src.dangling) {
      const r = dg.r || {};
      if (!lists.includes(dg.list)) continue;
      const end = find(dg.list, r.child) || find(dg.list, r.parent);
      if (!end) continue;
      const missing = find(dg.list, r.child) ? r.parent : r.child, n = used.get(end.t.id) || 0, y = anchorY(end.t, end.ci) + n * 12, x = end.t.x + W;
      used.set(end.t.id, n + 1);
      const cross = SA.crossHas(src, dg.list, missing);
      const info = cross && SA.crossTarget(src, dg.list, missing);
      const where = info && (info.domain ? `the ${info.domain} domain` : info.part ? `the "${info.part}" part` : 'another part of this project');
      const text = cross ? '→ ' + info.label + (info.domain ? ` (${info.domain})` : info.part ? ` (${info.part})` : '') : '✕ ' + missing;
      const file = cross && info.part && (src.crossPart.partModel || {})[info.part]; // clickable: opens that part (change 30)
      const tx = svg('text', { class: (cross ? 'xpart' : 'brk') + (file ? ' xopen' : ''), x: x + 60, y: y + 4 });
      if (file) tx.dataset.file = file;
      tx.textContent = text.length > 34 ? (cross ? text.slice(0, 33) + '…' : '…' + text.slice(-29)) : text;
      const th = cross ? `Relationship into another part: ${r.parent} → ${r.child}` : `Broken relationship: ${r.parent} → ${r.child}`;
      const td = cross ? `${info.label} is a real ${dg.list === 'conceptual' ? 'concept' : dg.list === 'logical' ? 'entity' : 'table'}, in ${where} — the reference is fine, only not drawn here. ${file ? 'Click the name to open it.' : 'Open Strata SQL: Open Project View to see it as a real edge.'}`
        : `${missing} is not in this model. It is kept as written (nothing is lost); Alignment → warnings can delete it, or accept it.`;
      out.push(svg('path', { class: 'edge ' + (cross ? 'cross' : 'broken'), d: `M${x} ${y} H${x + 54}` }), tx,
        svg('path', { class: 'hitb' + (file ? ' xopen' : ''), d: `M${x} ${y} H${x + 54}`, 'data-th': th, 'data-td': td, ...(file ? { 'data-file': file } : {}) }));
    }
    return out;
  }

  function drawEdges() {
    const d = scoped(shown());
    const focus = focusSet();
    edgeItems = relItems(d);
    if (impactOn && impactRes && impactRes.lineage) { // lineage into impacted views: source table/column -> view
      for (const e of impactRes.lineage) {
        const v = d.tables.find((x) => x.id === e.view), src = d.tables.find((x) => x.id === e.table);
        if (v && src) edgeItems.push({ kind: 'lin', up: !!e.up, t: v, p: src, ci: -1, pj: e.column ? src.columns.findIndex((c) => c.id === e.column) : -1, card: '' });
      }
    }
    if (orderOn && orderRes) { // a view reads its tables: dashed edge table -> view
      orderRes.deps.forEach((m2, vid) => m2.forEach((kind, tid) => {
        const v = d.tables.find((x) => x.id === vid), src = d.tables.find((x) => x.id === tid);
        if (kind === 'view' && v && src) edgeItems.push({ kind: 'lin', t: v, p: src, ci: -1, pj: -1, card: '' });
      }));
    }
    const anchorY = (t, idx) => (level === 'conceptual' ? t.y + H(t) / 2 : idx >= 0 ? t.y + HEAD + idx * ROW + ROW / 2 : t.y + HEAD / 2);
    const els = [], named = [];
    // parallel edges (same two cards, same anchors: billing and shipping address) run in lanes 16 px apart instead of on top of each other
    const lanes = new Map(), laneOf = new Map();
    edgeItems.forEach((it) => { const key = [it.t.id, it.p.id].sort().join('>') + '@' + [anchorY(it.t, it.ci), anchorY(it.p, it.pj)].join(','); if (!lanes.has(key)) lanes.set(key, []); lanes.get(key).push(it); });
    lanes.forEach((l) => l.forEach((it, i) => laneOf.set(it, (i - (l.length - 1) / 2) * 16)));
    edgeItems.forEach((it, k) => {
      const { t, p } = it, off = laneOf.get(it) || 0;
      const lane = (c, idx) => (off ? Math.min(Math.max(anchorY(c, idx) + off, c.y + 8), c.y + H(c) - 8) : anchorY(c, idx)), y1 = lane(t, it.ci), y2 = lane(p, it.pj);
      let x1, x2, d1, d2;
      if (p.x + W + 40 <= t.x) { x1 = t.x; x2 = p.x + W; d1 = -1; d2 = 1; }
      else if (t.x + W + 40 <= p.x) { x1 = t.x + W; x2 = p.x; d1 = 1; d2 = -1; }
      else { x1 = t.x + W; x2 = p.x + W; d1 = 1; d2 = 1; }
      const touches = selected && (t.id === selected || p.id === selected);
      const dPath = edgePath(x1, y1, d1, x2, y2, d2);
      const lin = it.kind === 'lin';
      const path = svg('path', { class: 'edge' + (it.kind === 'rel' ? ' rel' : '') + (lin ? ' lin' : '') + (touches ? ' hl' : focus ? ' dim' : '') + (touches && settings.animate ? ' flow' : '') + impactEdge(it) + orderEdge(it), d: dPath, ...(lin ? {} : { 'marker-start': 'url(#many)', 'marker-end': 'url(#one)' }) });
      const edgeHead = lin ? `${p.name}${it.pj >= 0 ? '.' + p.columns[it.pj].name : ''} feeds ${t.name}` : (it.kind === 'fk' ? `${t.name}.${it.col.name} → ${p.name}.${p.columns[it.pj].name}` : `${t.name} → ${p.name}${it.name ? ' · ' + it.name : ''}`) + (it.card ? `  (${it.card})` : '');
      const edgeTip = { 'data-th': edgeHead, ...(it.name || it.description ? { 'data-td': [it.name, it.description].filter(Boolean).join('\n') } : {}) };
      const [pc, cc] = it.card.split('..');
      const lbl = (txt, x, y, dir) => { const e = svg('text', { class: 'lbl' + (touches ? ' hl' : ''), x: x + dir * 13, y: y - 7, 'text-anchor': 'middle' }); e.textContent = txt; return e; };
      els.push(path);
      if (!lin && it.card) els.push(lbl(cc, x1, y1, d1), lbl(pc, x2, y2, d2));
      if (it.name) { // the relationship's text label sits in the middle of the line
        const tx = svg('text', { class: 'rname' + (touches ? ' hl' : ''), 'text-anchor': 'middle' });
        tx.textContent = it.name.length > 28 ? it.name.slice(0, 27) + '…' : it.name;
        els.push(tx); named.push([path, tx]);
      }
      els.push(svg('path', { class: 'hit', d: dPath, 'data-k': k, ...edgeTip }));
    });
    els.push(...brokenStubs(d, anchorY));
    fill(edgePaths, ...els);
    for (const [p, tx] of named) {
      try { const pt = p.getPointAtLength(p.getTotalLength() / 2); tx.setAttribute('x', pt.x); tx.setAttribute('y', pt.y - 5); } catch { /* not rendered yet */ }
    }
  }

  function applyView() {
    scheduleLayoutSave();
    drawMini();
    if (zoomLbl) zoomLbl.textContent = Math.round(view.k * 100) + '%';
    world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
    world.classList.toggle('lod-mid', view.k < 0.6);
    world.classList.toggle('lod-low', view.k < 0.32);
  }

  function render() {
    const D = fresh();
    if (!D.align) { D.align = D.d.project ? SA.check(D.d, D.memo) : null; D.byGo = new Map(); for (const w of D.align ? D.align.open : []) { if (!D.byGo.has(w.go.id)) D.byGo.set(w.go.id, []); D.byGo.get(w.go.id).push(w); } }
    alignRes = D.align; // alignment of the levels (once they exist) and governance (media/gov.js)
    renderBar();
    syncScopePop();
    syncToolsPop();
    renderBanner();
    renderHistory();
    const d = data();
    app.classList.toggle('preview', !!preview);
    vp.hidden = mode === 'data';
    dataView.hidden = mode !== 'data';
    empty.hidden = !!d.project || !!broken;
    semEmpty.hidden = !d.project || !!broken || mode !== 'schema' || level !== 'semantic' || d.metrics.length > 0;
    const gvOn = tabLv(level); // the Governance / Domains tab replaces the canvas (ADR-0038, ADR-0047)
    if (level === 'semantic' || gvOn) orderOn = false; // load order is about tables: not on the semantic level
    if (gvOn) { impactOn = false; mode = 'schema'; vp.hidden = true; }
    govView.hidden = !gvOn;
    if (impactOn) runImpact();
    hasSla = data().tables.some((t) => t.sla && (t.sla.exclude || t.sla.frequency));
    orderRes = orderOn || hasSla ? (D.order[level] ||= SA.order(data(), level) || OR.analyse(data())) : null; // also feeds the load estimate in tooltips; concepts / entities: rolled up from their tables
    renderImpact();
    renderOrder();
    renderAlign();
    buildDomColors(); renderDomLegend();
    if (gvOn) { if (d.project) (level === 'domains' ? renderDomView : renderGovView)(); }
    else if (mode === 'data') renderData();
    else { if (d.project) ensurePositions(d); drawFrames(); drawCards(); drawEdges(); applyView(); }
    drawMini(true);
    renderCtl();
  }

  // ---------- canvas controls (bottom-right, always on the schema canvas): zoom, fit, auto layout, mini-map, view settings ----------
  // next to the mini-map so the two work as one unit; on narrow editors an open side panel moves the strip to the left edge (canvas.css)
  let zoomLbl = null, viewOpen = false;
  function zoomAt(k, px, py) { // zoom to k keeping the canvas point under (px, py) in place; same limits as the wheel
    k = Math.max(0.1, Math.min(2, k));
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k; autoFit = false;
    applyView();
  }
  const zoomCentre = (k) => { const r = vp.getBoundingClientRect(); zoomAt(k, r.width / 2, r.height / 2); };
  function renderCtl() {
    const d = data(), key = isMac ? '⌘' : 'Ctrl+';
    ctl.hidden = !d.project || !!broken || mode !== 'schema' || tabLv(level); // data mode, governance / domains tab: nothing here applies
    if (ctl.hidden) { viewOpen = false; syncViewPop(); return; }
    const b = (name, tip, fn, o = {}) => { const e = ib(name, tip, fn, o); e.dataset.ctl = name; return e; };
    zoomLbl = h('button', { class: 'tb zl', 'data-ctl': 'zoom', 'data-tip': 'Zoom level: click for 100%', 'aria-label': 'Reset zoom to 100%', onclick: () => zoomCentre(1) }, Math.round(view.k * 100) + '%');
    fill(ctl, 
      b('zoomIn', 'Zoom in', () => zoomCentre(view.k * 1.25)), zoomLbl, b('zoomOut', 'Zoom out', () => zoomCentre(view.k / 1.25)),
      h('span', { class: 'csep' }),
      b('fit', 'Fit to view', fit),
      viewOnly ? null : b('layout', `Auto layout (${key}1)`, autoLayout, { disabled: !!preview }), // the read-only export must not move tables
      b('minimap', 'Mini-map: bird\'s-eye view, click or drag it to move around', toggleMini, { on: miniOn }),
      viewOnly ? null : b('view', 'View settings: arrows and animation', () => { viewOpen = !viewOpen; renderCtl(); }, { on: viewOpen }));
    syncViewPop();
  }
  // View settings: the display-only options of .strata/settings.json (visualization.arrows / animate), applied and saved at once
  function setView(p) { settings = { ...settings, ...p }; vscode.postMessage({ type: 'settings', settings }); render(); }
  function syncViewPop() {
    viewPop.hidden = !viewOpen || ctl.hidden;
    if (viewPop.hidden) return;
    const anim = check('Animate the relationships of the selected table (child → referenced table)', !!settings.animate);
    anim.input.addEventListener('change', () => setView({ animate: anim.input.checked }));
    fill(viewPop, h('div', { class: 'sp-head' }, h('strong', null, 'View settings')),
      h('div', { class: 'sp-body' },
        h('div', { class: 'field' }, h('span', null, 'Arrows'), seg([['squared', 'Squared'], ['curved', 'Curved']], settings.arrows === 'curved' ? 'curved' : 'squared', (v) => setView({ arrows: v }))),
        h('div', { class: 'field' }, anim.el),
        h('small', { class: 'muted' }, 'Saved for this workspace in .strata/settings.json. Theme and the rest: Settings in the toolbar.')));
    // beside the strip, bottom-aligned, on the side with room (left of it in the corner); otherwise above it
    const mr = viewPop.parentNode.getBoundingClientRect(), cr = ctl.getBoundingClientRect(), pw = viewPop.offsetWidth, ph = viewPop.offsetHeight;
    let x = cr.left - mr.left - 8 - pw, y = cr.bottom - mr.top - ph;
    if (x < 4) x = cr.right - mr.left + 8;
    if (x + pw > mr.width - 4) { x = Math.max(4, Math.min(cr.left - mr.left, mr.width - pw - 4)); y = cr.top - mr.top - ph - 8; }
    viewPop.style.left = x + 'px';
    viewPop.style.top = Math.max(4, y) + 'px';
  }
  document.addEventListener('pointerdown', (e) => { if (viewOpen && !viewPop.contains(e.target) && !e.target.closest('[data-ctl="view"]')) { viewOpen = false; renderCtl(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && viewOpen) { viewOpen = false; renderCtl(); } });

  // ---------- mini-map: bird's-eye view; click or drag to move the view, wheel to zoom ----------
  // It mirrors the frames and cards already drawn (their inline positions and state classes such as sel / imp-red / ord-up) as plain
  // SVG rects, rebuilt at most once per frame and only when the cards changed; panning and zooming only move the view rectangle.
  let miniRaf = 0, miniDirty = true, miniBox = null, miniFits = true;
  const MINI_STATE = /^(sel|dim|imp-\S+|ord-\S+)$/;
  function drawMini(cards) { if (cards) miniDirty = true; if (!miniRaf) miniRaf = requestAnimationFrame(paintMini); }
  function paintMini() {
    miniRaf = 0;
    const px = (v) => parseFloat(v) || 0;
    if (miniDirty) {
      miniDirty = false;
      const rs = [], rect = (q, cls, rx) => { rs.push(q); return svg('rect', { class: cls, x: q.x, y: q.y, width: q.w, height: q.h, rx }); };
      fill(miniG, 
        ...[...framesLayer.children].map((f) => rect({ x: px(f.style.left), y: px(f.style.top), w: px(f.style.width), h: px(f.style.height) }, f.classList.contains('catalog') ? 'mf cat' : 'mf', 12)),
        ...[...cardsLayer.children].map((c) => rect({ x: px(c.style.left), y: px(c.style.top), w: W, h: px(c.style.height) }, 'mc ' + [...c.classList].filter((k) => MINI_STATE.test(k)).join(' '), 6)));
      const x = Math.min(...rs.map((q) => q.x)), y = Math.min(...rs.map((q) => q.y));
      miniBox = rs.length ? { x, y, w: Math.max(...rs.map((q) => q.x + q.w)) - x, h: Math.max(...rs.map((q) => q.y + q.h)) - y } : null;
    }
    const r = vp.getBoundingClientRect(), b = miniBox, v = { x: -view.x / view.k, y: -view.y / view.k, w: r.width / view.k, h: r.height / view.k };
    miniFits = !b || (v.x <= b.x + 2 && v.y <= b.y + 2 && v.x + v.w >= b.x + b.w - 2 && v.y + v.h >= b.y + b.h - 2); // nothing to navigate to
    const off = !miniOn || miniFits || mode !== 'schema' || !r.width;
    mini.toggleAttribute('hidden', off);
    if (off) return;
    const p = 30, bw = b.w + 2 * p, bh = b.h + 2 * p, s = Math.min(200 / bw, 150 / bh);
    mini.setAttribute('viewBox', `${b.x - p} ${b.y - p} ${bw} ${bh}`);
    mini.setAttribute('width', Math.round(bw * s)); mini.setAttribute('height', Math.round(bh * s));
    for (const [k, val] of Object.entries({ x: v.x, y: v.y, width: v.w, height: v.h })) miniVp.setAttribute(k, val);
  }
  function toggleMini() {
    miniOn = !miniOn;
    renderCtl(); scheduleLayoutSave(); paintMini();
    if (miniOn && miniFits && mode === 'schema') toast('The mini-map appears when part of the diagram is out of view: zoom in or pan.');
  }
  // click: centre the view there; drag the view rectangle (or anywhere, after the first click) to pan
  mini.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = vp.getBoundingClientRect(), inv = mini.getScreenCTM().inverse(), at = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv);
    const p0 = at(e), c = { x: (r.width / 2 - view.x) / view.k, y: (r.height / 2 - view.y) / view.k };
    const grip = e.target === miniVp ? { x: p0.x - c.x, y: p0.y - c.y } : { x: 0, y: 0 }; // grabbing the rectangle keeps the point under the pointer
    const go = (ev) => { const q = at(ev); view.x = r.width / 2 - (q.x - grip.x) * view.k; view.y = r.height / 2 - (q.y - grip.y) * view.k; autoFit = false; applyView(); };
    go(e);
    track(e, go, () => {});
  });

  // ---------- sample data viewer ----------
  const dataFile = (t) => `${dataDirName}/${SM.refs(data()).tab.get(t.id)}.csv`;

  function requestData(t) { vscode.postMessage({ type: 'data', op: 'read', file: dataFile(t) }); }

  function renderData() {
    const d = scoped(data());
    const R = SM.refs(data());
    const tables = [...d.tables].sort((a, b) => R.tab.get(a.id).localeCompare(R.tab.get(b.id)));
    if (!tables.some((t) => t.id === dataSel)) dataSel = tables[0] && tables[0].id;
    const t = tables.find((x) => x.id === dataSel);
    const side = h('div', { class: 'dlist' }, tables.length ? tables.map((x) => {
      const txt = dataCache.get(dataFile(x));
      const n = txt ? Math.max(0, SM.parseCsv(txt).length - 1) : null;
      return h('div', { class: 'ditem' + (x.id === dataSel ? ' on' : ''), onclick: () => { dataSel = x.id; requestData(x); renderData(); } },
        h('span', null, R.tab.get(x.id)), h('small', null, txt == null ? (dataCache.has(dataFile(x)) ? 'no csv' : '…') : `${n} rows`));
    }) : h('p', { class: 'muted' }, 'No tables in this view.'));
    let main;
    if (!t) main = h('div', { class: 'dmain' }, h('p', { class: 'muted' }, 'Add a table to attach sample data.'));
    else {
      const file = dataFile(t), txt = dataCache.get(file);
      const head = h('div', { class: 'dhead' }, h('b', null, R.tab.get(t.id)), h('code', null, file),
        h('span', { class: 'grow' }),
        h('button', { onclick: () => requestData(t) }, 'Refresh'),
        txt != null && h('button', { onclick: () => vscode.postMessage({ type: 'data', op: 'open', file }) }, 'Open CSV'));
      if (txt == null) {
        main = h('div', { class: 'dmain' }, head, h('div', { class: 'dempty' },
          h('p', null, dataCache.has(file) ? `No sample data yet for ${t.name}.` : 'Loading…'),
          dataCache.has(file) && !preview && !viewOnly && h('button', { class: 'primary', onclick: () => {
            vscode.postMessage({ type: 'data', op: 'create', file, text: t.columns.map((c) => SM.csvCell(c.name)).join(',') + '\n' });
            vscode.postMessage({ type: 'data', op: 'open', file });
          } }, 'Create CSV with column headers')));
      } else {
        const rows = SM.parseCsv(txt), header = rows[0] || [], body = rows.slice(1);
        const want = t.columns.map((c) => c.name);
        const missing = want.filter((n) => !header.includes(n)), extra = header.filter((n) => !want.includes(n));
        const shown = body.slice(0, 300);
        main = h('div', { class: 'dmain' }, head,
          (missing.length || extra.length) ? h('div', { class: 'dwarn' }, missing.length ? `Missing columns: ${missing.join(', ')}. ` : '', extra.length ? `Not in model: ${extra.join(', ')}.` : '') : null,
          h('div', { class: 'dgrid' }, h('table', null,
            h('thead', null, h('tr', null, h('th', { class: 'rn' }, '#'), header.map((n) => h('th', { class: want.includes(n) ? '' : 'x' }, n)))),
            h('tbody', null, shown.map((r, i) => h('tr', null, h('td', { class: 'rn' }, i + 1), header.map((_, j) => h('td', null, r[j] ?? '')))))) ),
          h('div', { class: 'dfoot' }, `${body.length} row${body.length === 1 ? '' : 's'}${body.length > shown.length ? ` (showing first ${shown.length})` : ''} · ${header.length} columns`));
      }
    }
    fill(dataView, side, main);
    for (const x of tables) { const f = dataFile(x); if (!dataCache.has(f) && !asked.has(f)) { asked.add(f); requestData(x); } }
  }

  // ---------- view: level / mode / fit / layout / reveal ----------
  function setLevel(lv) {
    if (lv === level) return;
    if (tabLv(lv)) { mode = 'schema'; scopeOpen = false; }
    saveLevel();
    stash(model);
    if (preview) stash(preview.model);
    level = lv;
    ensurePositions();
    if (preview) ensurePositions(preview.model);
    if (!loadLevel(lv)) { selected = null; impactSel.clear(); impactRes = null; autoFit = true; } // first visit: same scope and panels, fitted
    if (autoFit) fit(); else applyView();
    render();
  }
  function setMode(m) {
    mode = m;
    render();
    if (m === 'schema') fit();
  }

  function fit() {
    const d = scoped(shown());
    const r = vp.getBoundingClientRect();
    if (!d.project || !d.tables.length || !r.width) { view = { x: 80, y: 80, k: 1 }; applyView(); return; }
    const { sr, cr } = frameRects(d);
    const rs = [...sr, ...cr].map((o) => o.r);
    const x0 = Math.min(...rs.map((q) => q.x)), y0 = Math.min(...rs.map((q) => q.y));
    const x1 = Math.max(...rs.map((q) => q.x + q.w)), y1 = Math.max(...rs.map((q) => q.y + q.h));
    const m = 24, bw = x1 - x0, bh = y1 - y0; // small margin, and up to 1.5x so small diagrams fill the screen
    const k = Math.max(0.1, Math.min(1.5, (r.width - 2 * m) / bw, (r.height - 2 * m) / bh));
    view = { k, x: (r.width - bw * k) / 2 - x0 * k, y: (r.height - bh * k) / 2 - y0 * k };
    autoFit = true;
    applyView();
  }

  function autoLayout() {
    if (preview || broken || viewOnly || !model.project || !model.tables.length || mode !== 'schema' || tabLv(level)) return;
    const apply = () => {
      const pos = L.compute(shown(model), level, vpAspect());
      for (const t of SM.nodesOf(model, level)) Object.assign(t, pos[t.id]);
    };
    if (settings.recordLayout) { // optional: auto layout becomes a version that can be undone / previewed
      const before = layoutSnap();
      apply();
      commitChange('Auto layout', { level, before, after: layoutSnap() });
    } else layoutChange(apply);
    fit();
  }

  // Reveal something from the navigator or search: kind = project | catalog | schema | table | column | relationship | tag | policy | concept | entity | metric
  function revealItem(kindName, ref, column) {
    const d = data(), R = SM.refs(d);
    const toScope = (cs, ss) => { scope = { ...noScope(), c: new Set(cs), s: new Set(ss) }; mode = 'schema'; autoFit = true; render(); fit(); };
    if (kindName === 'project') return openProject();
    if (kindName === 'tag') return openTags();
    if (kindName === 'policy') return openGovTab('graph', ref);
    if (kindName === 'concept' || kindName === 'entity' || kindName === 'metric') return revealNode(kindName, ref);
    if ((kindName === 'catalog' || kindName === 'schema') && tabLv(level)) setLevel('physical');
    if (kindName === 'catalog') { const c = d.catalogs.find((x) => x.name === ref); return c && toScope([c.id], []); }
    if (kindName === 'schema') { const s = d.schemas.find((x) => R.sch.get(x.id) === ref); return s && toScope([], [s.id]); }
    if (kindName === 'relationship') {
      const child = ref.split('>')[1] || '';
      const isTable = [...R.tab.values()].includes(child); // column-level relationships end in a column ref
      return reveal(isTable ? child : child.split('.').slice(0, -1).join('.'));
    }
    return reveal(ref, column);
  }

  function centre(t) {
    const r = vp.getBoundingClientRect();
    view.k = Math.max(view.k, 0.7);
    view.x = r.width / 2 - (t.x + W / 2) * view.k;
    view.y = r.height / 2 - (t.y + H(t) / 2) * view.k;
    autoFit = false;
  }
  // a concept, entity or metric: on its own level
  function revealNode(kindName, name) {
    const lv = { concept: 'conceptual', entity: 'logical', metric: 'semantic' }[kindName], n = (kindName === 'concept' ? data().concepts : kindName === 'metric' ? data().metrics : data().entities).find((x) => x.name === name);
    if (!n) return;
    mode = 'schema';
    setLevel(lv);
    selected = n.id;
    centre(n);
    render();
  }
  function reveal(tableRef, column, physical) {
    if (tabLv(level)) setLevel('physical');
    const R = SM.refs(data());
    const t = data().tables.find((x) => R.tab.get(x.id) === tableRef);
    if (!t) return;
    const v = mode === 'schema' && SA.view(data(), level);
    if (v && v.layer === 'metric') { if (physical || !v.tables.includes(t)) setLevel('physical'); } // semantic: stay when the table is drawn there
    else if (v) { // a level that draws concepts / entities: show the one the table realises, else go to the physical level
      const e = SA.entitiesOfTable(data(), t)[0], n = v.layer === 'entity' ? e : e && SA.conceptOf(data(), e);
      if (n && !physical) return revealNode(v.layer, n.name);
      setLevel('physical');
    }
    selected = t.id;
    if (mode === 'data') { dataSel = t.id; requestData(t); }
    else {
      if (!scoped(data()).tables.includes(t)) scope = noScope();
      centre(t);
    }
    render();
    const col = column && t.columns.find((c) => c.name === column);
    if (col) {
      const row = cardsLayer.querySelector(`.row[data-c="${col.id}"]`);
      if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600); }
    }
  }

  // ---------- impact analysis ----------
  const nodeKind = (n) => n.slice(0, n.indexOf(':')), nodeId = (n) => n.slice(n.indexOf(':') + 1);
  function nodeLabel(n) {
    const d = data(), R = SM.refs(d), k = nodeKind(n), id = nodeId(n);
    if (k === 'concept' || k === 'entity' || k === 'metric') return ((k === 'concept' ? d.concepts : k === 'entity' ? d.entities : d.metrics).find((x) => x.id === id) || {}).name;
    return k === 'column' ? R.col.get(id) : k === 'table' ? R.tab.get(id) : k === 'schema' ? R.sch.get(id) : (d.catalogs.find((c) => c.id === id) || {}).name;
  }
  function nodeExists(n) {
    const d = data(), k = nodeKind(n), id = nodeId(n);
    if (k === 'concept' || k === 'entity' || k === 'metric') return (k === 'concept' ? d.concepts : k === 'entity' ? d.entities : d.metrics).some((x) => x.id === id);
    return k === 'column' ? d.tables.some((t) => t.columns.some((c) => c.id === id)) : k === 'table' ? d.tables.some((t) => t.id === id) : k === 'schema' ? d.schemas.some((x) => x.id === id) : d.catalogs.some((c) => c.id === id);
  }
  function runImpact() {
    [...impactSel].filter((n) => !nodeExists(n)).forEach((n) => impactSel.delete(n));
    if (layerRels()) { impactRes = impactSel.size ? SA.impact(data(), level, [...impactSel], impactMode) : null; impactUnused = new Set(); return; } // concepts / entities, rolled up
    impactRes = impactSel.size ? IM.analyse(data(), [...impactSel], impactMode) : null;
    impactUnused = new Set(IM.unusedColumns(data(), impactKeys).map((u) => IM.key('column', u.columnId)));
  }
  function toggleImpact() {
    impactOn = !impactOn;
    if (impactOn) historyOpen = orderOn = alignOn = false; else { impactSel.clear(); impactRes = null; }
    render();
  }
  function toggleImpactNode(kind, id) {
    const n = IM.key(kind, id);
    if (impactSel.has(n)) impactSel.delete(n); else impactSel.add(n);
    render();
  }

  // card / row / frame / edge state: selected + no impact = green (safe), selected + impact or a dependant = red, rest fades
  const srcCls = (st) => (st === 'impacted' ? ' imp-src' : st === 'linked' ? ' imp-link' : ' imp-safe');
  function impactCard(t) {
    if (!impactOn || !impactRes) return '';
    const r = impactRes, st = r.state;
    if (t.layer === 'metric') { const k = IM.key('metric', t.id); return r.sources.has(k) ? srcCls(st) : r.impacted.has(k) ? ' imp-red' : r.upstream.has(k) ? ' imp-up' : ' imp-off'; }
    if (r.level) return r.sources.has(t.id) ? srcCls(st) : r.impacted.has(t.id) ? ' imp-red' : r.upstream.has(t.id) ? ' imp-up' : ' imp-off'; // concept / entity level
    if (r.sources.has(IM.key('table', t.id))) return st === 'impacted' ? ' imp-src' : st === 'linked' ? ' imp-link' : ' imp-safe';
    if (r.impViews.has(t.id) || r.impTables.has(t.id)) return ' imp-red';
    if (r.upTables.has(t.id) || r.upViews.has(t.id)) return ' imp-up';
    if (r.srcTables.has(t.id)) return st === 'impacted' ? ' imp-has' : st === 'linked' ? ' imp-link-has' : ' imp-safe-has';
    return ' imp-off';
  }
  function impactRow(c) {
    if (!impactOn) return '';
    const n = IM.key('column', c.id), r = impactRes;
    const cls = r && r.sources.has(n) ? (r.state === 'impacted' ? ' imp-src' : r.state === 'linked' ? ' imp-link' : ' imp-safe') : r && r.impacted.has(n) ? ' imp-red' : r && r.upstream.has(n) ? ' imp-up' : '';
    return cls + (impactHi && impactUnused.has(n) ? ' imp-unused' : '');
  }
  function impactBadge(t) {
    if (!impactOn || !impactRes || !impactRes.sources.has(impactRes.level ? t.id : IM.key(t.layer === 'metric' ? 'metric' : 'table', t.id))) return null;
    const st = impactRes.state;
    return h('span', { class: 'impbadge' }, st === 'safe' ? '✓ safe' : st === 'linked' ? 'has upstream' : impactMode === 'delete' ? 'deleted' : 'changed');
  }
  function impactFrame(kind, id, schemaIds, d) {
    if (!impactOn || d.layer) return '';
    const r = impactRes, ids = new Set(d.tables.filter((t) => schemaIds.includes(t.schemaId)).map((t) => t.id));
    const hit = r && [...ids].some((tid) => r.impViews.has(tid) || r.impTables.has(tid)), up = r && [...ids].some((tid) => r.upTables.has(tid) || r.upViews.has(tid));
    return impactSel.has(IM.key(kind, id)) ? (r && r.state === 'impacted' ? ' imp-src' : r && r.state === 'linked' ? ' imp-link' : ' imp-safe') : hit ? ' imp-red' : up ? ' imp-up' : '';
  }
  function impactEdge(it) {
    if (!impactOn || !impactRes) return '';
    const r = impactRes;
    if (r.level) { // the level's own relationships: red when both ends go or depend, blue when it leads to what the selection needs
      const hot = (id) => r.sources.has(id) || r.impacted.has(id), up = (id) => r.sources.has(id) || r.upstream.has(id);
      return it.kind !== 'rel' ? ' imp-off' : hot(it.t.id) && hot(it.p.id) ? ' imp-red' : up(it.t.id) && up(it.p.id) ? ' imp-up' : ' imp-off';
    }
    const hot = (n) => r.sources.has(n) || r.impacted.has(n), inUp0 = (n) => r.sources.has(n) || r.upstream.has(n);
    if (it.metric) { // a metric's input line: red when the input breaks the metric, blue when the selected metric depends on it
      const mk = IM.key('metric', it.t.id), ik = it.pj >= 0 ? IM.key('column', it.p.columns[it.pj].id) : IM.key('metric', it.p.id);
      return hot(mk) && hot(ik) ? ' imp-red' : inUp0(mk) && inUp0(ik) ? ' imp-up' : ' imp-off';
    }
    if (it.kind === 'lin') return it.up ? ' imp-up' : ' imp-red';
    const tHot = (id) => r.srcTables.has(id) || r.impTables.has(id) || r.impViews.has(id);
    const inUp = (n) => r.sources.has(n) || r.upstream.has(n), tUp = (id) => r.srcTables.has(id) || r.upTables.has(id) || r.upViews.has(id), isUp = (id) => r.upTables.has(id) || r.upViews.has(id);
    if (it.kind === 'fk' ? hot(IM.key('column', it.col.id)) && hot(IM.key('column', it.p.columns[it.pj].id)) : tHot(it.t.id) && tHot(it.p.id)) return ' imp-red';
    const up = it.kind === 'fk' ? inUp(IM.key('column', it.col.id)) && inUp(IM.key('column', it.p.columns[it.pj].id)) && (r.upstream.has(IM.key('column', it.col.id)) || r.upstream.has(IM.key('column', it.p.columns[it.pj].id))) : tUp(it.t.id) && tUp(it.p.id) && (isUp(it.t.id) || isUp(it.p.id));
    return up ? ' imp-up' : ' imp-off';
  }

  function renderImpact() {
    impactDrawer.hidden = !impactOn || mode !== 'schema';
    if (impactDrawer.hidden) return;
    const V = shown();
    if (layerRels()) return renderImpactLayer(V); // the semantic level analyses tables, columns and metrics directly
    const d = data(), R = SM.refs(d), r = impactRes, verb = impactMode === 'delete' ? 'delete' : 'change';
    const go = (n) => { const k = nodeKind(n), id = nodeId(n); const t = k === 'table' ? d.tables.find((x) => x.id === id) : null;
      if (k === 'metric') { const x = d.metrics.find((y) => y.id === id); if (x && level !== 'semantic') revealNode('metric', x.name); return; }
      if (k === 'column') { const tt = d.tables.find((x) => x.columns.some((c) => c.id === id)); reveal(R.tab.get(tt.id), tt.columns.find((c) => c.id === id).name); } else if (t) reveal(R.tab.get(id)); };
    const chip = (n, extra) => h('button', { class: 'ichip ' + (extra || ''), title: nodeLabel(n), onclick: () => go(n) }, nodeKind(n) === 'metric' ? 'Σ ' + nodeLabel(n) : nodeLabel(n).split('.').slice(-2).join('.'));
    const metricsSec = (ids, title, cls) => (ids && ids.size ? sec(`${title} (${ids.size})`, h('div', { class: 'chips2' }, ...[...ids].map((id) => chip(IM.key('metric', id), cls)))) : null);
    const cap = (arr, max = 40) => [...arr.slice(0, max), arr.length > max ? h('small', { class: 'muted' }, ` …and ${arr.length - max} more`) : null];
    const sec = (title, body) => h('div', { class: 'isec' }, h('h4', null, title), body);
    const byIdView = (dd, id) => (dd.tables.find((x) => x.id === id) || {}).kind === 'view';

    // result
    let result;
    if (!impactSel.size) result = h('p', { class: 'muted' }, level === 'semantic' ? 'Click metrics, tables or columns on the canvas to select them (click again to deselect). A metric breaks when a column it reads, or a metric it builds on, is deleted or changed.' : 'Click tables, views, columns, or a schema / catalog label on the canvas to select them (click again to deselect). Select as many columns as you like.');
    else {
      const upTab = [...r.upViews, ...r.upTables].sort((x, y) => R.tab.get(x).localeCompare(R.tab.get(y)));
      const upCols = new Map();
      r.upstreamColumns.forEach((n) => { const cid = nodeId(n), t = d.tables.find((x) => x.columns.some((c) => c.id === cid)); if (t) { if (!upCols.has(t.id)) upCols.set(t.id, []); upCols.get(t.id).push(n); } });
      const upM = metricsSec(r.upMetrics, 'Metrics it builds on', 'up');
      const upSec = upTab.length || upCols.size ? sec(`Upstream: what it depends on (${plural(upTab.length, 'table / view', 'tables / views')})`, h('div', null,
        h('small', { class: 'muted' }, 'It references or reads from these. Blue on the canvas.'),
        h('div', { class: 'chips2' }, ...cap(upTab.map((id) => chip(IM.key('table', id), 'up' + (byIdView(d, id) ? ' v' : ''))))),
        ...cap([...upCols].map(([tid, cols]) => h('div', { class: 'itab' }, h('b', null, R.tab.get(tid)), h('div', { class: 'chips2' }, ...cap(cols.map((n) => chip(n, 'up')), 12)))), 12))) : null;
      if (r.state === 'safe') result = h('div', { class: 'ibox ok' }, h('b', null, '✓ Safe to ' + verb), h('div', null, 'Nothing depends on the selection and it does not depend on anything else (no foreign key, no view, no metric, no relationship).'));
      else if (r.state === 'linked') result = h('div', null,
        h('div', { class: 'ibox link' }, h('b', null, `⚠ Not safe to ${verb} without a review`),
          h('div', null, upTab.length || upCols.size ? `Nothing else depends on it, but it depends on ${plural(upTab.length, 'upstream table / view', 'upstream tables / views')}${upCols.size ? ` and ${plural(r.upstreamColumns.length, 'column')}` : ''}. ` : 'Nothing else depends on it, but it is part of a table-level relationship. ',
            impactMode === 'delete' ? 'Deleting it removes those relationships and lineage.' : 'Changing it may break how it uses them.'),
          r.impactedRelations.length ? h('div', null, `${plural(r.impactedRelations.length, 'table-level relationship')} touched.`) : null), upM, upSec);
      else {
        const byTable = new Map();
        r.impactedColumns.forEach((n) => { const cid = nodeId(n), t = d.tables.find((x) => x.columns.some((c) => c.id === cid)); if (t && !r.impViews.has(t.id)) { if (!byTable.has(t.id)) byTable.set(t.id, []); byTable.get(t.id).push(n); } });
        const hidden = new Set(scoped(d).tables.map((t) => t.id));
        const outside = [...r.impViews, ...r.impTables, ...r.srcTables, ...r.upTables, ...r.upViews].filter((id) => !hidden.has(id)).length;
        result = h('div', null,
          h('div', { class: 'ibox bad' }, h('b', null, `${r.impacted.size ? '⚠ ' : ''}${plural(r.impViews.size, 'view')}, ${plural(r.impTables.size, 'table')}, ${plural(r.impactedColumns.length, 'column')}${r.impMetrics.size ? `, ${plural(r.impMetrics.size, 'metric')}` : ''} impacted`),
            h('div', null, `Everything in red depends on the selection. ${impactMode === 'delete' ? 'Deleting it breaks those objects.' : 'Changing it may break those objects.'}`),
            r.upstream.size ? h('div', null, `It also depends on ${plural(upTab.length, 'upstream table / view', 'upstream tables / views')} (blue).`) : null,
            r.impactedRelations.length ? h('div', null, `${plural(r.impactedRelations.length, 'table-level relationship')} touched.`) : null),
          outside ? h('div', { class: 'ibox note' }, `${plural(outside, 'affected object')} outside the current view scope. `, h('button', { class: 'lnk', onclick: () => { scope = noScope(); scopeChanged(); } }, 'Show whole project')) : null,
          metricsSec(r.impMetrics, 'Metrics that break (semantic level)'),
          r.impViews.size ? sec('Views', h('div', { class: 'chips2' }, ...cap([...r.impViews].map((id) => chip(IM.key('table', id), 'v'))))) : null,
          byTable.size ? sec('Tables and columns', h('div', null, ...cap([...byTable].map(([tid, cols]) => h('div', { class: 'itab' }, h('b', null, R.tab.get(tid)), h('div', { class: 'chips2' }, ...cap(cols.map((n) => chip(n)), 12))))))) : null, upM, upSec);
      }
    }

    // unused columns
    const un = IM.unusedColumns(d, impactKeys), grouped = new Map();
    un.forEach((u) => { if (!grouped.has(u.tableId)) grouped.set(u.tableId, []); grouped.get(u.tableId).push(u); });
    const unusedSec = sec(`Unused columns (${un.length})`, h('div', null,
      h('p', { class: 'muted' }, 'Nothing in the model points to these columns: no foreign key references them, no view mentions them and no metric reads them. Foreign-key columns and view columns are not listed. Applications and reports outside the model are not known.'),
      h('div', { class: 'irow' },
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: impactKeys, onchange: (e) => { impactKeys = e.target.checked; render(); } }), 'Include key columns'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: impactHi, onchange: (e) => { impactHi = e.target.checked; render(); } }), 'Highlight on canvas')),
      un.length ? h('button', { onclick: () => { un.forEach((u) => impactSel.add(IM.key('column', u.columnId))); render(); } }, `Select all ${un.length}`) : null,
      ...cap([...grouped].sort((a, b) => R.tab.get(a[0]).localeCompare(R.tab.get(b[0]))).map(([tid, list]) => h('div', { class: 'itab' }, h('b', null, R.tab.get(tid)),
        h('div', { class: 'chips2' }, ...list.map((u) => h('button', { class: 'ichip u' + (impactSel.has(IM.key('column', u.columnId)) ? ' on' : ''), title: 'Click to select and jump to it', onclick: () => { toggleImpactNode('column', u.columnId); go(IM.key('column', u.columnId)); } },
          d.tables.find((t) => t.id === tid).columns.find((c) => c.id === u.columnId).name + (u.key ? ' 🔑' : '')))))), 30)));

    fill(impactDrawer, 
      h('div', { class: 'dh' }, h('strong', null, 'Impact analysis'), h('button', { class: 'ib', onclick: toggleImpact }, '✕')),
      h('div', { class: 'ibody' },
        h('div', { class: 'isec' }, h('div', { class: 'seg' }, [['delete', 'If deleted'], ['change', 'If changed']].map(([v, l]) => h('button', { class: v === impactMode ? 'on' : '', onclick: () => { impactMode = v; render(); } }, l))),
          h('small', { class: 'muted' }, impactMode === 'delete' ? 'The selection and everything inside it disappears.' : 'Renamed, retyped or redefined; it stays but its dependants may break.')),
        impactSel.size ? h('div', { class: 'isec' }, h('div', { class: 'chips2' }, ...[...impactSel].map((n) => h('button', { class: 'ichip sel', title: 'Remove from selection', onclick: () => { impactSel.delete(n); render(); } }, nodeLabel(n).split('.').slice(-2).join('.') + ' ✕')),
          h('button', { class: 'lnk', onclick: () => { impactSel.clear(); render(); } }, 'Clear'))) : null,
        result, unusedSec));
  }

  // impact on the conceptual / logical level (SA.impact): the physical analysis of the selection's tables, rolled up, plus the level's relationships
  function renderImpactLayer(V) {
    const d = data(), R = SM.refs(d), r = impactRes, verb = impactMode === 'delete' ? 'delete' : 'change', lay = V.layer;
    const noun = lay === 'concept' ? ['concept', 'concepts'] : ['entity', 'entities'], nn = (n) => plural(n, noun[0], noun[1]);
    const byId = new Map(V.tables.map((n) => [n.id, n])), sec = (title, body) => h('div', { class: 'isec' }, h('h4', null, title), body);
    const chipN = (id, cls) => h('button', { class: 'ichip ' + (cls || ''), title: 'Show it', onclick: () => revealNode(lay, byId.get(id).name) }, byId.get(id).name);
    const chipT = (tid, cls) => h('button', { class: 'ichip ' + (cls || ''), title: R.tab.get(tid), onclick: () => reveal(R.tab.get(tid), undefined, true) }, R.tab.get(tid).split('.').slice(-2).join('.'));
    const sorted = (set) => [...set].filter((id) => byId.has(id)).sort((a, b) => byId.get(a).name.localeCompare(byId.get(b).name));
    let result;
    if (!r) result = h('p', { class: 'muted' }, `Click ${noun[1]} on the canvas to select them (click again to deselect). Each stands for the tables that realise it${lay === 'concept' ? ' (through its entities)' : ''}: the analysis runs on those tables and is rolled up to this level, together with the ${lay === 'concept' ? 'conceptual' : 'logical'} relationships.`);
    else {
      const p = r.phys, imp = sorted(r.impacted), up = sorted(r.upstream);
      const box = r.state === 'safe' ? h('div', { class: 'ibox ok' }, h('b', null, '✓ Safe to ' + verb), h('div', null, `Nothing depends on it: none of its tables is used elsewhere and it has no ${lay === 'concept' ? 'conceptual' : 'logical'} relationship.`))
        : r.state === 'linked' ? h('div', { class: 'ibox link' }, h('b', null, `⚠ Not safe to ${verb} without a review`), h('div', null, `Nothing else depends on it, but it depends on ${nn(up.length)}${p && p.state !== 'safe' ? ' and its tables have upstream references' : ''}.`))
          : h('div', { class: 'ibox bad' }, h('b', null, `⚠ ${nn(imp.length)} impacted`), h('div', null, `Everything in red depends on the selection${r.touched.length ? `, including ${plural(r.touched.length, 'relationship')} of this level` : ''}. ${impactMode === 'delete' ? 'Deleting it breaks them.' : 'Changing it may break them.'}`));
      result = h('div', null, box,
        !r.tables.length ? h('div', { class: 'ibox note' }, `No table realises the selection yet: only the ${lay === 'concept' ? 'conceptual' : 'logical'} relationships count.`) : null,
        (() => { const vis = new Set(scoped(V).tables.map((n) => n.id)), out = [...imp, ...up].filter((id) => !vis.has(id)).length;
          return out ? h('div', { class: 'ibox note' }, `${plural(out, 'affected ' + noun[0], 'affected ' + noun[1])} outside the current view scope. `, h('button', { class: 'lnk', onclick: () => { scope = noScope(); scopeChanged(); } }, 'Show whole project')) : null; })(),
        imp.length ? sec(`Impacted ${noun[1]} (${imp.length})`, h('div', { class: 'chips2' }, ...imp.map((id) => chipN(id)))) : null,
        up.length ? sec(`Upstream: what it depends on (${up.length})`, h('div', { class: 'chips2' }, ...up.map((id) => chipN(id, 'up')))) : null,
        p ? sec('Behind it: the physical tables', h('div', null,
          h('small', { class: 'muted' }, `Selected ${plural(r.tables.length, 'table')}: `), h('div', { class: 'chips2' }, ...r.tables.map((t) => chipT(t, 'sel'))),
          p.impViews.size || p.impTables.size ? h('div', null, h('small', { class: 'muted' }, `Impacted: ${plural(p.impViews.size, 'view')}, ${plural(p.impTables.size, 'table')}, ${plural(p.impactedColumns.length, 'column')}`), h('div', { class: 'chips2' }, ...[...p.impViews, ...p.impTables].map((t) => chipT(t, byId.has(t) ? '' : 'v')))) : null,
          p.upTables.size || p.upViews.size ? h('div', null, h('small', { class: 'muted' }, 'Upstream'), h('div', { class: 'chips2' }, ...[...p.upTables, ...p.upViews].map((t) => chipT(t, 'up')))) : null)) : null);
    }
    fill(impactDrawer, 
      h('div', { class: 'dh' }, h('strong', null, `Impact analysis · ${noun[1]}`), h('button', { class: 'ib', onclick: toggleImpact }, '✕')),
      h('div', { class: 'ibody' },
        h('div', { class: 'isec' }, h('div', { class: 'seg' }, [['delete', 'If deleted'], ['change', 'If changed']].map(([v, l]) => h('button', { class: v === impactMode ? 'on' : '', onclick: () => { impactMode = v; render(); } }, l))),
          h('small', { class: 'muted' }, impactMode === 'delete' ? `The selected ${noun[1]} and their tables disappear.` : 'Renamed or redefined; they stay but what depends on them may break.')),
        impactSel.size ? h('div', { class: 'isec' }, h('div', { class: 'chips2' }, ...[...impactSel].map((n) => h('button', { class: 'ichip sel', title: 'Remove from selection', onclick: () => { impactSel.delete(n); render(); } }, nodeLabel(n) + ' ✕')),
          h('button', { class: 'lnk', onclick: () => { impactSel.clear(); render(); } }, 'Clear'))) : null,
        result, h('p', { class: 'muted' }, 'Unused columns are listed on the Physical level.')));
  }

  // ---------- load order ----------
  function toggleOrder() {
    orderOn = !orderOn;
    if (orderOn) { historyOpen = alignOn = false; impactOn = false; impactSel.clear(); impactRes = null; }
    render();
  }
  // with a table selected: it, everything that must load before it (blue) and everything that waits for it (orange); rest fades
  function orderSet() {
    if (!orderOn || !orderRes || !selected || !orderRes.stage.has(selected)) return null;
    return { up: orderRes.upstream(selected), down: orderRes.downstream(selected) };
  }
  function orderCard(t) {
    const s = orderSet();
    return !s ? '' : t.id === selected ? ' ord-sel' : s.up.has(t.id) ? ' ord-up' : s.down.has(t.id) ? ' ord-down' : ' ord-off';
  }
  function orderBadge(t) {
    return orderOn && orderRes && orderRes.stage.has(t.id) ? h('span', { class: 'stg', title: `Load stage ${orderRes.stage.get(t.id)}: tables with the same stage can load in parallel` }, orderRes.stage.get(t.id)) : null;
  }
  function orderEdge(it) {
    const s = orderSet();
    if (!s) return '';
    const on = (id) => id === selected || s.up.has(id) || s.down.has(id);
    return on(it.t.id) && on(it.p.id) ? '' : ' imp-off';
  }

  function exportOrder() {
    vscode.postMessage({ type: 'exportOrder', text: JSON.stringify(OR.toJSON(data(), OR.analyse(data()), new Date().toISOString()), null, 2) + '\n' }); // always the tables: what a pipeline loads
  }
  function setOrderWidth(w) {
    orderW = Math.max(300, Math.min(w, innerWidth - 260));
    orderDrawer.style.width = orderW + 'px';
  }
  const orderGrip = h('div', { class: 'ogrip', title: 'Drag to resize', onpointerdown: (e) => { const w0 = orderW; track(e, (ev, dx) => setOrderWidth(w0 - dx), () => {}); } });

  function renderOrder() {
    orderDrawer.hidden = !orderOn || mode !== 'schema';
    if (orderDrawer.hidden) return;
    setOrderWidth(orderW);
    // on the conceptual / logical level the rows are concepts / entities (SA.order: rolled up from their tables, ADR-0033)
    const d = data(), V = shown(), lay = V.layer, R = SM.refs(d), o = orderRes, byId = new Map(V.tables.map((t) => [t.id, t])), hh = OR.hhmm;
    const noun = lay === 'concept' ? ['concept', 'concepts'] : lay === 'entity' ? ['entity', 'entities'] : ['table', 'tables'], nn = (n) => plural(n, noun[0], noun[1]);
    const full = (id) => (lay ? byId.get(id).name : R.tab.get(id));
    const nm = (id) => (lay ? full(id) : full(id).split('.').slice(-2).join('.')), go = (id) => (lay ? revealNode(lay, full(id)) : reveal(full(id)));
    const chip = (id, cls, sfx) => h('button', { class: 'ichip o ' + (cls || ''), title: full(id), onclick: (e) => { e.stopPropagation(); go(id); } }, nm(id) + (sfx || ''));
    const cyc = (id) => o.cycles.some((c) => c.includes(id));
    const anySla = d.tables.some((t) => t.sla && (t.sla.exclude || t.sla.frequency));
    const stageReady = (st) => { const r = st.ids.map((id) => o.avail.get(id).ready).filter((x) => x != null); return r.length ? Math.max(...r) : null; };
    const who = (id, noStage) => {
      const t = byId.get(id);
      return [noStage ? null : h('span', { class: 'stg', title: 'Load stage ' + o.stage.get(id) }, o.stage.get(id)), h('span', { class: 'kico' }, icon(t.kind === 'view' ? 'view' : lay || 'table', false, 13)), h('span', { class: 'oname' }, nm(id)),
        lay ? h('span', { class: 'vt', title: 'Tables that realise it: ' + o.groups.get(id).map((x) => R.tab.get(x)).join(', ') }, plural(o.groups.get(id).length, 'table')) : null,
        t.kind === 'view' ? h('span', { class: 'vt', title: 'A view: refresh it once the tables it reads are loaded' }, t.viewType === 'materialized' ? 'MAT' : 'VIEW') : null,
        cyc(id) ? h('span', { class: 'vt cyc', title: 'Part of a circular dependency' }, '⟲ cycle') : null,
        o.selfRefs.has(id) ? h('span', { class: 'vt', title: 'References itself (no ordering effect)' }, 'self-ref') : null];
    };
    // SLA of the table and the cumulative time its data is ready
    const bits = (id) => {
      const sla = byId.get(id).sla, a = o.avail.get(id), out = [];
      if (a && a.excluded) return h('div', { class: 'osla' }, h('span', { class: 'slachip ex', title: sla ? slaText(sla) : 'All its tables are static / reference data' }, '⏱ out of SLA'));
      if (sla && sla.frequency) out.push(h('span', { class: 'slachip', title: slaText(sla) }, '⏱ ' + sla.frequency + (sla.time ? ' ' + sla.time : '')));
      if (a && a.ready != null) out.push(h('span', { class: 'ready' + (a.atRisk ? ' risk' : ''), title: lay ? `Ready when all its tables are${a.atRisk ? '; one of them promises data earlier than its inputs can be ready' : ''}` : a.atRisk ? `Its SLA (${sla.time}) is earlier than its inputs can be ready${a.via ? ', it waits for ' + nm(a.via) : ''}` : a.derived ? 'No SLA of its own: ready when what it needs is ready' : 'Ready = the later of its own SLA time and everything it needs' }, (a.atRisk ? '⚠ ' : '') + 'ready ' + hh(a.ready)));
      return out.length ? h('div', { class: 'osla' }, ...out) : null;
    };
    const needs = (list, label) => (list.length ? h('div', { class: 'oneeds' }, h('small', { class: 'muted' }, label), ...list.map((x) => chip(x))) : null);
    const tip = (id) => tipProps(nm(id), (lay ? o.explain(id) : OR.explain(d, o, id)).join('\n'), 'Click to show it on the canvas');
    const row = (id) => h('div', { class: 'orow' + (id === selected ? ' on' : ''), ...tip(id), onclick: () => go(id) }, h('div', { class: 'oline' }, ...who(id)), bits(id), needs([...o.deps.get(id).keys()], 'needs'));

    // the pipeline as a DAG: one column per stage, edges from each prerequisite to what needs it
    const dag = () => {
      const NW = 200, NH = 50, GX = 96, GY = 12, TOP = 46, PAD = 14;
      const keep = (id) => !(orderHideEx && o.avail.get(id).excluded);
      const stg = o.stages.map((st) => ({ st, ids: st.ids.filter(keep) })).filter((c) => c.ids.length), pos = new Map(), cols = stg.map((c) => c.ids);
      cols.forEach((ids, ci) => { // rows follow the prerequisites' average height, then are pushed down to avoid overlap
        const want = (id) => { const ys = [...o.deps.get(id).keys()].map((x) => pos.get(x)).filter(Boolean).map((q) => q.y); return ys.length ? ys.reduce((x, y) => x + y, 0) / ys.length : null; };
        const items = ids.map((id) => ({ id, w: want(id) })).sort((a, b) => (a.w ?? 1e9) - (b.w ?? 1e9) || nm(a.id).localeCompare(nm(b.id)));
        let y = TOP;
        items.forEach((it) => { y = Math.max(y, it.w ?? y); pos.set(it.id, { x: PAD + ci * (NW + GX), y }); y += NH + GY; });
      });
      const W2 = PAD * 2 + cols.length * NW + (cols.length - 1) * GX, H2 = Math.max(...[...pos.values()].map((q) => q.y)) + NH + PAD;
      const sset = selected && o.stage.has(selected) ? { up: o.upstream(selected), down: o.downstream(selected) } : null;
      const inUp = (id) => id === selected || (sset && sset.up.has(id)), inDown = (id) => id === selected || (sset && sset.down.has(id));
      // spread the ports of one node so edges do not overlap on a single point
      const outs = new Map(), ins = new Map(), edges = [];
      o.deps.forEach((m2, to) => m2.forEach((kind, from) => { if (keep(from) && keep(to)) edges.push({ from, to, kind }); }));
      edges.forEach((e) => { (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e); (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e); });
      const port = (list, key, other) => list.sort((a, b) => pos.get(a[other]).y - pos.get(b[other]).y).forEach((e, k) => { e[key] = Math.max(-18, Math.min(18, (k - (list.length - 1) / 2) * 5)); });
      outs.forEach((l) => port(l, 'dy1', 'to')); ins.forEach((l) => port(l, 'dy2', 'from'));
      const paths = edges.map((e) => {
        const a = pos.get(e.from), b = pos.get(e.to), x1 = a.x + NW, y1 = a.y + NH / 2 + e.dy1, x2 = b.x, y2 = b.y + NH / 2 + e.dy2, dx = Math.max(28, (x2 - x1) / 2);
        const state = !sset ? '' : inUp(e.from) && inUp(e.to) && e.to !== e.from && (e.to === selected || sset.up.has(e.to)) ? ' up' : inDown(e.from) && sset.down.has(e.to) ? ' down' : ' off';
        return svg('path', { class: 'oedge' + (e.kind === 'view' ? ' view' : '') + state, d: `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, 'marker-end': `url(#oa${state.trim() || 'n'})` });
      });
      const edgeSvg = svg('svg', { class: 'oedges', width: W2, height: H2 });
      edgeSvg.innerHTML = ['n:#8a8a8a', 'up:#3794ff', 'down:#d18616', 'off:#8a8a8a'].map((x) => { const [k, c] = x.split(':'); return `<marker id="oa${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="${c}"/></marker>`; }).join('');
      edgeSvg.append(...paths);
      const heads = stg.map(({ st, ids }, ci) => { const r = stageReady(st); return h('div', { class: 'ocolh', style: `left:${PAD + ci * (NW + GX)}px;width:${NW}px` }, h('b', null, 'Stage ' + st.n), h('small', null, `${ids.length} in parallel`.replace(/^1 in parallel/, 'one table') + (r != null ? ' · ready by ' + hh(r) : ''))); });
      const nodes = [...pos].map(([id, q]) => {
        const t = byId.get(id), a = o.avail.get(id), sla = t.sla;
        const cls = (a.atRisk ? ' risk' : '') + (a.excluded ? ' ex' : '') + (id === selected ? ' on' : '') + (sset ? (inUp(id) && id !== selected ? ' up' : inDown(id) && id !== selected ? ' down' : id === selected ? '' : ' off') : '');
        return h('div', { class: 'dnode' + cls, style: `left:${q.x}px;top:${q.y}px;width:${NW}px;height:${NH}px`, ...tip(id), onclick: () => go(id) },
          h('div', { class: 'nl1' }, h('span', { class: 'kico' }, icon(t.kind === 'view' ? 'view' : lay || 'table', false, 13)), h('span', { class: 'nname' }, t.name), t.kind === 'view' ? h('span', { class: 'vt' }, t.viewType === 'materialized' ? 'MAT' : 'VIEW') : null),
          h('div', { class: 'nl2' }, a.excluded ? h('span', { class: 'slachip ex' }, 'out of SLA') : sla && sla.frequency ? h('span', { class: 'slachip' }, '⏱ ' + (SLA_SHORT[sla.frequency] + (sla.time ? ' ' + sla.time : ''))) : null,
            a.ready != null ? h('span', { class: 'ready' + (a.atRisk ? ' risk' : '') }, (a.atRisk ? '⚠ ' : '') + hh(a.ready)) : null));
      });
      return h('div', { class: 'odag', style: `width:${W2}px;height:${H2}px` }, edgeSvg, ...heads, ...nodes);
    };

    const node = (id) => {
      const kids = o.children.get(id), par = o.parent.get(id);
      const also = [...o.deps.get(id).keys()].filter((x) => x !== par);
      const tog = kids.length ? h('button', { class: 'otog', title: 'Collapse / expand', onclick: (e) => { e.stopPropagation(); if (!orderClosed.delete(id)) orderClosed.add(id); render(); } }, orderClosed.has(id) ? '▸' : '▾') : h('span', { class: 'otog' });
      const head = h('div', { class: 'orow' + (id === selected ? ' on' : ''), ...tip(id), onclick: () => go(id) }, h('div', { class: 'oline' }, tog, ...who(id)), bits(id), needs(also, 'also needs'));
      return h('div', { class: 'onode' }, head, kids.length && !orderClosed.has(id) ? h('div', { class: 'okids' }, ...kids.map(node)) : null);
    };

    let body;
    if (!o.stages.length) body = h('p', { class: 'muted' }, lay ? `No ${noun[0]} is realised by a table yet: map tables under Alignment.` : 'This model has no tables yet.');
    else {
      const sel = selected && o.stage.has(selected) ? { up: [...o.upstream(selected)], down: [...o.downstream(selected)] } : null;
      body = h('div', null,
        h('div', { class: 'ibox note' }, h('b', null, lay ? `${nn(o.stage.size)} load in ${plural(o.stages.length, 'stage')}` : `${plural(d.tables.length, 'table')} and views load in ${plural(o.stages.length, 'stage')}`),
          lay ? h('div', null, `Derived from the tables that realise them: one needs another when one of its tables needs one of the other's tables. It is ready when all its tables are.${V.tables.length > o.stage.size ? ` ${nn(V.tables.length - o.stage.size)} without a table ${V.tables.length - o.stage.size === 1 ? 'is' : 'are'} left out.` : ''}`) : null,
          h('div', null, `Up to ${o.widest} can load at the same time. The longest chain has ${o.longest.length} steps:`), h('div', { class: 'ochain' }, ...o.longest.flatMap((id, i) => [i ? h('span', { class: 'muted' }, ' → ') : null, chip(id)]))),
        anySla ? h('div', { class: 'ibox sla' }, o.readyBy != null ? h('div', { class: 'otimes' }, ...[['Begins', hh(o.beginsAt), 'when the first data of the pipeline is available'], ['Ready by', hh(o.readyBy), 'when the last data is available'], ['Duration', OR.dur(o.duration), 'from the first data to the last']].map(([l, v, tt]) => h('div', { title: tt }, h('small', null, l), h('b', null, v)))) : h('b', null, 'No clock-time SLA in the pipeline yet'),
          o.critical.length ? h('div', null, 'The last data to arrive follows this path (ready time of each table):', h('div', { class: 'ochain' }, ...o.critical.flatMap((id, i) => [i ? h('span', { class: 'muted' }, ' → ') : null, chip(id, '', ' ' + hh(o.avail.get(id).ready))]))) : null,
          o.atRisk.length ? h('div', { class: 'risk' }, lay ? `⚠ ${nn(o.atRisk.length)} with a table that promises data earlier than its inputs can be ready: ` : `⚠ ${o.atRisk.length === 1 ? '1 table promises' : o.atRisk.length + ' tables promise'} data earlier than its inputs can be ready: `, ...o.atRisk.flatMap((id, i) => [i ? ', ' : null, chip(id, 'r')])) : null,
          h('small', { class: 'muted' }, 'Ready = the later of a table\'s own SLA time and when everything it needs is ready. Slower sources (for example monthly) do not hold up faster tables; tables out of SLA are ignored.'))
          : h('p', { class: 'muted' }, 'Add an SLA to tables (edit a table → Data availability SLA) to see when each one, and the whole pipeline, has its data ready.'),
        o.cycles.length ? h('div', { class: 'ibox bad' }, h('b', null, `⚠ ${plural(o.cycles.length, 'circular dependency', 'circular dependencies')}`), h('div', null, 'These tables need each other, so no order works with constraints enforced. Load them together, then add the foreign keys.'),
          ...o.cycles.map((c) => h('div', { class: 'ochain' }, ...c.flatMap((id, i) => [i ? h('span', { class: 'muted' }, ' ⇄ ') : null, chip(id)])))) : null,
        sel ? h('div', { class: 'ibox sel' }, h('b', null, nm(selected)), h('div', null, sel.up.length ? `Needs ${nn(sel.up.length)} loaded first (blue on the canvas).` : 'Needs nothing: it can load first.'),
          h('div', null, sel.down.length ? `${nn(sel.down.length)} must wait for it (orange).` : 'Nothing waits for it.')) : h('p', { class: 'muted' }, 'Click ' + (lay === 'entity' ? 'an ' : 'a ') + noun[0] + ' on the canvas or in the list to see what must load before it (blue) and what waits for it (orange).'),
        h('div', { class: 'isec' }, h('div', { class: 'seg' }, [['stages', 'Stages'], ['pipeline', 'Pipeline'], ['tree', 'Tree']].map(([v, l]) => h('button', { class: v === orderView ? 'on' : '', onclick: () => { orderView = v; render(); } }, l)))),
        orderView === 'stages'
          ? h('div', null, h('small', { class: 'muted' }, lay ? `${noun[1][0].toUpperCase() + noun[1].slice(1)} in one stage do not depend on each other and can load in parallel.` : 'Tables in one stage do not depend on each other and can load in parallel. A table can start as soon as the ones it needs are loaded.'),
            ...o.stages.map((s) => { const r = stageReady(s); return h('div', { class: 'ostage' }, h('h4', null, `Stage ${s.n} · `, s.ids.length > 1 ? `${s.ids.length} in parallel` : 'one ' + noun[0], s.n === 1 ? ' · start here' : '', r != null ? ` · ready by ${hh(r)}` : ''), ...s.ids.map(row)); }))
          : orderView === 'pipeline'
            ? h('div', null, h('small', { class: 'muted' }, 'Stages run left to right; an arrow goes from a table to what needs it, and tables in a column load in parallel. Solid = foreign key, dashed = a view reads it. Use the full-screen button for a bigger view.'),
              [...o.avail.values()].some((a) => a.excluded) ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: orderHideEx, onchange: (e) => { orderHideEx = e.target.checked; render(); } }), 'Hide tables that are out of SLA') : null, h('div', { class: 'odagwrap' }, dag()))
            : h('div', null, h('small', { class: 'muted' }, 'Each table sits under the prerequisite that loads last, so children load after their parent. Other prerequisites are listed as "also needs".'),
              h('div', { class: 'otree' }, ...o.roots.map(node))));
    }
    orderDrawer.classList.toggle('full', orderFull);
    fill(orderDrawer, ...(orderFull ? [] : [orderGrip]), h('div', { class: 'dh' }, h('strong', null, 'Load order'),
      h('span', { class: 'grow' }), h('button', { class: 'ib', title: 'Export the load sequence as a JSON file', onclick: exportOrder }, '⭳ JSON'),
      h('button', { class: 'ib', title: orderFull ? 'Leave full screen' : 'Full screen: use the whole editor', onclick: () => { orderFull = !orderFull; render(); } }, orderFull ? '⛶ Exit' : '⛶'),
      orderFull ? null : h('button', { class: 'ib', title: orderW > 600 ? 'Shrink the panel' : 'Expand the panel', onclick: () => { setOrderWidth(orderW > 600 ? 350 : Math.round(innerWidth * 0.7)); render(); } }, orderW > 600 ? '⤡' : '⤢'),
      h('button', { class: 'ib', onclick: toggleOrder }, '✕')), h('div', { class: 'ibody' }, body));
  }

  // ---------- alignment of the conceptual / logical / physical levels (media/align.js, ADR-0032) ----------
  function toggleAlign() {
    alignOn = !alignOn;
    if (alignOn) { historyOpen = orderOn = impactOn = false; impactSel.clear(); impactRes = null; }
    render();
  }
  // jump to what a warning is about: tables on the physical level, entities / concepts on theirs
  function alignGo(go) {
    const d = data(), R = SM.refs(d);
    if (go.kind === 'table') return reveal(R.tab.get(go.id), undefined, true);
    if (go.kind === 'metric') { const x = d.metrics.find((y) => y.id === go.id); return x && revealNode('metric', x.name); }
    if (go.kind === 'policy') return openGovTab('graph', go.name);
    if (go.kind === 'project') return openProject();
    if (go.kind === 'catalog') { const c = d.catalogs.find((x) => x.id === go.id); return c && !viewOnly && openCatalog(c); }
    if (go.kind === 'schema') { const x = d.schemas.find((y) => y.id === go.id); return x && !viewOnly && openSchema(x); }
    const n = (go.kind === 'concept' ? d.concepts : d.entities).find((x) => x.id === go.id);
    if (n) revealNode(go.kind, n.name);
  }
  function acceptWarnings(ws) {
    mutate(ws.length === 1 ? `Accept alignment warning: ${ws[0].text}` : `Accept ${ws.length} alignment warnings`, () => {
      const live = new Set(SA.check(model).all.map((w) => w.key)); // forget acknowledgements of warnings that no longer exist
      model.ack = [...new Set([...model.ack.filter((k) => live.has(k)), ...ws.map((w) => w.key)])];
    });
  }
  function generateLayers() {
    modal('Generate the logical and conceptual levels', h('div', null,
      h('p', null, 'Creates one logical entity per table and one concept per entity, named from the table names (dim_customer and customers both become Customer), and adds the logical and conceptual relationships from the foreign keys. Views and pure bridge tables (only key columns) are left out.'),
      h('p', null, 'Nothing you already have is changed: only the gaps are filled, so you can run it again after adding tables.'),
      h('p', null, h('b', null, 'Then merge what belongs together: '), 'open an entity or a concept and choose "Merge into", or re-map tables under Alignment → Mapping.')), [
      { label: 'Cancel' },
      { label: 'Generate', primary: true, fn: () => {
        let n = null;
        mutate('Generate logical and conceptual levels from the physical model', () => { n = SA.generate(model, uid); });
        if (n) toast(`Created ${plural(n.entities, 'entity', 'entities')}, ${plural(n.concepts, 'concept')} and ${plural(n.lrels + n.crels, 'relationship')}; mapped ${plural(n.mapped, 'table')}.`);
      } },
    ]);
  }

  function renderAlign() {
    alignDrawer.hidden = !alignOn || mode !== 'schema';
    if (alignDrawer.hidden) return;
    const d = data(), R = SM.refs(d), ro = !!preview || viewOnly || !!broken;
    const sec = (title, ...body) => h('div', { class: 'isec' }, h('h4', null, title), ...body);
    const btn = (label, fn, o = {}) => h('button', { class: o.cls || '', title: o.title, disabled: ro || o.disabled, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    const headEl = h('div', { class: 'dh' }, h('strong', null, 'Alignment and governance'), h('span', { class: 'grow' }), h('button', { class: 'ib', onclick: toggleAlign }, '✕'));
    let body;
    if (!SA.hasLayers(d)) {
      const res = alignRes || SA.check(d);
      body = h('div', null,
        h('div', { class: 'ibox note' }, h('b', null, 'Only the physical level so far'),
          h('div', null, 'Link your tables to logical entities, and entities to business concepts: a concept has one or more entities, an entity one or more tables. Descriptions, tags, properties and governance values are inherited downwards, and anything that does not line up is reported here.')),
        btn('Generate logical and conceptual levels', generateLayers, { cls: 'primary' }),
        h('p', { class: 'muted' }, 'Or start by hand: + → Concept or Entity, then tick the entity in a table dialog or map tables under Mapping.'),
        res.all.length ? warningsTab(res, ro, sec, btn) : null);
    } else {
      const res = alignRes || SA.check(d);
      const tabs = h('div', { class: 'isec' }, h('div', { class: 'seg' }, [['warnings', `Warnings (${res.open.length})`], ['mapping', 'Mapping']].map(([v, l]) => h('button', { class: v === alignTab ? 'on' : '', onclick: () => { alignTab = v; render(); } }, l))));
      body = h('div', null, tabs, alignTab === 'mapping' ? mappingTab(d, R, ro, sec, btn) : warningsTab(res, ro, sec, btn));
    }
    fill(alignDrawer, headEl, h('div', { class: 'ibody' }, body));
  }

  function warningsTab(res, ro, sec, btn) {
    const row = (w, acked) => h('div', { class: 'arow' },
      h('button', { class: 'atext lnk', title: 'Show it', onclick: () => alignGo(w.go) }, w.text),
      h('div', { class: 'aacts' },
        acked ? btn('Undo', () => mutate(`Report again: ${w.text}`, () => { model.ack = model.ack.filter((k) => k !== w.key); }), { title: 'Report this warning again' })
          : [w.fix ? btn(w.fix.label, () => mutate(`Alignment: ${w.fix.label}`, () => SA.applyFix(model, w, uid)), { cls: 'primary' }) : null,
            btn('Accept', () => acceptWarnings([w]), { title: 'Leave it as it is on purpose: stored in the model (versioned) and no longer reported' })]));
    const KINDS = { ...SA.KINDS, ...GV.KINDS };
    const groups = Object.keys(KINDS).map((k) => [k, res.open.filter((w) => w.kind === k)]).filter(([, l]) => l.length);
    const byLevel = ['conceptual', 'logical', 'physical', 'semantic', 'governance'].map((lv) => [lv, res.open.filter((w) => w.level === lv).length]).filter(([, n]) => n);
    return h('div', null,
      res.open.length ? h('div', { class: 'ibox link' }, h('b', null, `⚠ ${plural(res.open.length, 'thing')} to review`), h('div', null, `${byLevel.map(([lv, n]) => `${lv[0].toUpperCase() + lv.slice(1)} ${n}`).join(' · ')}. Fix them, or accept what is intended.`))
        : h('div', { class: 'ibox ok' }, h('b', null, '✓ Nothing to review'), h('div', null, SA.hasLayers(data()) ? 'The levels are aligned (every table realises an entity, every entity has a concept and a table, relationships match) and no governance check fails.' : 'No governance check fails.')),
      SA.hasLayers(data()) ? h('div', { class: 'irow' }, btn('Fill gaps from physical', generateLayers, { title: 'Create entities, concepts and relationships for what is not covered yet' })) : null,
      ...groups.map(([k, list]) => {
        const fixable = list.filter((w) => w.fix);
        return sec(`${KINDS[k]} (${list.length})`,
          h('div', { class: 'irow' }, fixable.length > 1 ? btn(`Fix all ${fixable.length}`, () => mutate(`Alignment: fix ${plural(fixable.length, 'warning')} (${KINDS[k].toLowerCase()})`, () => fixable.forEach((w) => SA.applyFix(model, w, uid)))) : null,
            list.length > 1 ? btn(`Accept all ${list.length}`, () => acceptWarnings(list)) : null),
          ...list.slice(0, 40).map((w) => row(w, false)), list.length > 40 ? h('small', { class: 'muted' }, `…and ${list.length - 40} more`) : null);
      }),
      res.acked.length ? h('details', { class: 'isec' }, h('summary', null, `Accepted (${res.acked.length})`), ...res.acked.map((w) => row(w, true))) : null);
  }

  function mappingTab(d, R, ro, sec, btn) {
    const NEW = '+new', sug = SA.suggest(d), ents = [...d.entities].sort(byName), cons = [...d.concepts].sort(byName);
    const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name;
    const setEntity = (ts, id, msg) => mutate(msg, () => {
      let eid = id;
      if (id === NEW) { const nm = SA.entityName(ts[0].name), ex = model.entities.find((e) => e.name.toLowerCase() === nm.toLowerCase()); eid = ex ? ex.id : uid(); if (!ex) model.entities.push(SM.norm({ id: eid, name: nm, conceptId: null, description: ts[0].description, pos: {}, ...placeNode('logical') })); }
      ts.forEach((t) => { model.tables.find((x) => x.id === t.id).entityIds = eid ? [eid] : []; });
    });
    const entSel = (t) => {
      const cur = t.entityIds || [];
      const opts = [{ value: '', label: '— not mapped —' }, ...ents.map((e) => ({ value: e.id, label: e.name })), { value: NEW, label: `+ New entity "${SA.entityName(t.name)}"` }];
      if (cur.length > 1) opts.unshift({ value: 'multi', label: cur.map((id) => nameOf(ents, id)).join(' + ') });
      const s = dropdown(opts, cur.length > 1 ? 'multi' : cur[0] || '');
      s.disabled = ro;
      s.addEventListener('change', () => { if (s.value !== 'multi') setEntity([t], s.value, s.value ? `Map ${R.tab.get(t.id)} to ${s.value === NEW ? 'a new entity' : nameOf(ents, s.value)}` : `Unmap ${R.tab.get(t.id)}`); });
      return s;
    };
    const conSel = (e) => {
      const s = dropdown([{ value: '', label: '— no concept —' }, ...cons.map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: `+ New concept "${e.name}"` }], e.conceptId || '');
      s.disabled = ro;
      s.addEventListener('change', () => mutate(`Link entity ${e.name} to ${s.value === NEW ? 'a new concept' : nameOf(cons, s.value) || 'no concept'}`, () => {
        const me = model.entities.find((x) => x.id === e.id);
        if (s.value === NEW) { const ex = model.concepts.find((c) => c.name.toLowerCase() === e.name.toLowerCase()); me.conceptId = ex ? ex.id : uid(); if (!ex) model.concepts.push(SM.norm({ id: me.conceptId, name: e.name, pos: {}, ...placeNode('conceptual') })); }
        else me.conceptId = s.value || null;
      }));
      return s;
    };
    const nSug = sug.tables.length + sug.entities.length;
    const sugBox = nSug ? h('div', { class: 'ibox note' }, h('b', null, `${plural(nSug, 'suggestion')} from names`),
      h('div', null, [...sug.tables.map((x) => `${d.tables.find((t) => t.id === x.tableId).name} → ${nameOf(ents, x.entityId)}`), ...sug.entities.map((x) => `${nameOf(ents, x.entityId)} → concept ${nameOf(cons, x.conceptId)}`)].slice(0, 8).join(' · ') + (nSug > 8 ? ' …' : '')),
      btn(`Accept all ${nSug}`, () => mutate(`Accept ${plural(nSug, 'suggested mapping')}`, () => {
        sug.tables.forEach((x) => { model.tables.find((t) => t.id === x.tableId).entityIds = [x.entityId]; });
        sug.entities.forEach((x) => { model.entities.find((e) => e.id === x.entityId).conceptId = x.conceptId; });
      }), { cls: 'primary' })) : null;
    // tables grouped by schema, with tick boxes for bulk assignment
    const schemas = [...d.schemas].sort((a, b) => R.sch.get(a.id).localeCompare(R.sch.get(b.id)));
    [...alignPick].forEach((id) => { if (!d.tables.some((t) => t.id === id)) alignPick.delete(id); });
    const tick = (ids, on) => { ids.forEach((id) => (on ? alignPick.add(id) : alignPick.delete(id))); render(); };
    const tableRows = schemas.map((s) => {
      const ts = d.tables.filter((t) => t.schemaId === s.id).sort(byName);
      if (!ts.length) return null;
      const all = ts.every((t) => alignPick.has(t.id));
      return h('div', { class: 'mgroup' },
        h('label', { class: 'mhead' }, h('input', { type: 'checkbox', checked: all, disabled: ro, onchange: (e) => tick(ts.map((t) => t.id), e.target.checked) }), h('b', null, R.sch.get(s.id)), h('small', { class: 'muted' }, plural(ts.length, 'table'))),
        ...ts.map((t) => {
          const sg = sug.tables.find((x) => x.tableId === t.id);
          return h('div', { class: 'mrow' + ((t.entityIds || []).length || !SA.mappable(d, t) ? '' : ' un') },
            h('input', { type: 'checkbox', checked: alignPick.has(t.id), disabled: ro, onchange: (e) => tick([t.id], e.target.checked) }),
            h('span', { class: 'kico' }, icon(t.kind === 'view' ? 'view' : 'table', false, 13)),
            h('button', { class: 'mname lnk', title: R.tab.get(t.id) + ' (show it)', onclick: () => reveal(R.tab.get(t.id), undefined, true) }, t.name),
            sg ? btn('→ ' + nameOf(ents, sg.entityId), () => setEntity([t], sg.entityId, `Map ${R.tab.get(t.id)} to ${nameOf(ents, sg.entityId)}`), { cls: 'sugg', title: 'Suggested from the name: click to accept' }) : null,
            entSel(t));
        }));
    }).filter(Boolean);
    const bulkSel = dropdown([{ value: '', label: '— not mapped —' }, ...ents.map((e) => ({ value: e.id, label: e.name }))], '');
    const bulk = h('div', { class: 'mbulk' }, h('span', null, `${alignPick.size} ticked →`), bulkSel,
      btn('Assign', () => { const ts = d.tables.filter((t) => alignPick.has(t.id)); alignPick.clear(); setEntity(ts, bulkSel.value, `Map ${plural(ts.length, 'table')} to ${nameOf(ents, bulkSel.value) || 'no entity'}`); }, { cls: 'primary', disabled: !alignPick.size }));
    return h('div', null, sugBox,
      sec('Tables → logical entity', h('small', { class: 'muted' }, 'Tick tables (or a whole schema) and assign them together, or pick per table. Views and bridge tables may stay unmapped.'), ...tableRows, bulk),
      sec('Entities → concept', ...ents.map((e) => h('div', { class: 'mrow' + (e.conceptId ? '' : ' un') },
        h('span', { class: 'kico' }, icon('entity', false, 13)), h('button', { class: 'mname lnk', onclick: () => revealNode('entity', e.name) }, e.name), conSel(e)))));
  }

  // ---------- search (Cmd/Ctrl+F) and panel toggling ----------
  function searchItems(termRaw, kind) {
    const t = termRaw.trim().toLowerCase(), d = data(), R = SM.refs(d), out = [];
    const on = (k) => kind === 'all' || kind === k;
    const inc = (list) => list.some((x) => x && String(x).toLowerCase().includes(t));
    const tagInfo = (o) => (o.tags || []).flatMap((n) => { const g = d.governance.tags.find((x) => x.name === n); return [n, g && g.displayName]; });
    const propsOf = (o) => ({ ...(o.properties || {}), ...Object.fromEntries(Object.entries(o.gov || {}).filter(([, v]) => typeof v === 'string' || Array.isArray(v)).map(([k, v]) => [k, GV.show(v)])) }); // user properties and governance values
    const propInfo = (o) => Object.entries(propsOf(o)).flat();
    const objs = [];
    if (d.project) objs.push({ k: 'project', title: d.project.name, sub: 'project', o: d.project, names: [d.project.name, d.project.description], go: () => openProject() });
    d.concepts.forEach((c) => objs.push({ k: 'concept', title: c.name, sub: 'conceptual', desc: c.description, o: c, names: [c.name, c.description], go: () => revealItem('concept', c.name) }));
    const memo = memoOf(d);
    d.entities.forEach((e) => { const c = SA.conceptOf(d, e, memo); objs.push({ k: 'entity', title: e.name, sub: 'logical' + (c ? ' · ' + c.name : ''), desc: e.description, o: e, names: [e.name, e.description], go: () => revealItem('entity', e.name) }); });
    d.metrics.forEach((x) => objs.push({ k: 'metric', title: x.name, sub: [GV.AGG[x.aggregation], x.calculation].filter(Boolean).join(' · '), desc: x.description, o: x, names: [x.name, x.description, x.calculation], go: () => revealItem('metric', x.name) }));
    d.catalogs.forEach((c) => objs.push({ k: 'catalog', title: c.name, sub: c.displayName, desc: c.description, o: c, names: [c.name, c.displayName, c.description], go: () => revealItem('catalog', c.name) }));
    d.schemas.forEach((x) => objs.push({ k: 'schema', title: R.sch.get(x.id), sub: x.displayName, desc: x.description, o: x, names: [x.name, x.displayName, x.description], go: () => revealItem('schema', R.sch.get(x.id)) }));
    d.tables.forEach((tb) => {
      const ref = R.tab.get(tb.id);
      objs.push({ k: 'table', title: ref, sub: (tb.kind === 'view' ? 'view · ' : '') + (tb.displayName || ''), desc: tb.description, o: tb, names: [ref, tb.displayName, tb.description, tb.kind === 'view' ? tb.definition : ''], go: () => reveal(ref) });
      tb.columns.forEach((c) => objs.push({ k: 'column', title: R.col.get(c.id), sub: c.dataType, desc: c.description, o: c, names: [c.name, c.displayName, c.description, c.dataType], go: () => reveal(ref, c.name) }));
    });
    for (const o of objs) {
      const nameHit = o.k !== 'project' || kind === 'all' ? on(o.k) && (!t || inc(o.names)) : false;
      if (nameHit) { out.push({ k: o.k, title: o.title, sub: o.sub, go: o.go, desc: o.desc }); continue; }
      const byText = kind === 'all' && !!t;
      if ((kind === 'tag' || byText) && (o.o.tags || []).length && (!t || inc(tagInfo(o.o)))) out.push({ k: o.k, title: o.title, sub: 'tag: ' + o.o.tags.join(', '), go: o.go, desc: o.desc });
      else if ((kind === 'property' || byText) && Object.keys(propsOf(o.o)).length && (!t || inc(propInfo(o.o)))) out.push({ k: o.k, title: o.title, sub: Object.entries(propsOf(o.o)).map(([a, b]) => `${a}=${b}`).join(', '), go: o.go, desc: o.desc });
    }
    if (on('relationship')) {
      const rel = (label, texts, sub, childRef, desc) => { if (!t || inc(texts)) out.push({ k: 'relationship', title: label, sub, desc, go: () => reveal(childRef) }); };
      for (const tb of d.tables) for (const c of tb.columns) {
        const f = c.foreignKey, pc = f && R.col.get(f.columnId);
        if (pc) rel(`${R.col.get(c.id)} → ${pc}`, [R.col.get(c.id), pc, f.name, f.description, f.cardinality], [f.cardinality, f.name].filter(Boolean).join(' · '), R.tab.get(tb.id), f.description);
      }
      for (const r of d.relations) rel(`${R.tab.get(r.childId)} → ${R.tab.get(r.parentId)}`, [R.tab.get(r.childId), R.tab.get(r.parentId), r.name, r.description, r.cardinality], [r.cardinality, r.name].filter(Boolean).join(' · '), R.tab.get(r.childId), r.description);
    }
    if (on('policy')) for (const p of d.governance.policies) if (!t || inc([p.name, p.type, p.jurisdiction, p.owner, p.description, ...p.parents])) out.push({ k: 'policy', title: p.name, sub: [p.type, p.jurisdiction, p.parents.length && 'parents: ' + p.parents.join(', ')].filter(Boolean).join(' · '), desc: p.description, go: () => openGovTab('graph', p.name) });
    if (on('tag')) for (const g of d.governance.tags) if (!t || inc([g.name, g.displayName, g.description, g.owner, g.domain, ...g.policies])) out.push({ k: 'tag', title: g.displayName || g.name, sub: g.name + (g.policies.length ? ' · brings ' + g.policies.join(', ') : '') + (g.enabled ? '' : ' (disabled)'), desc: g.description, go: () => openTags() });
    return out;
  }

  let sIdx = 0, sItems = [];
  function runSearch() {
    sItems = searchItems(sq.value, sk.value).slice(0, 80);
    sIdx = 0;
    renderSearch();
  }
  function renderSearch() {
    fill(sres, ...(sItems.length
      ? sItems.map((it, i) => h('div', { class: 'si' + (i === sIdx ? ' on' : ''), ...tipProps(it.title, it.desc), onclick: () => { it.go(); }, onmouseenter: () => { sIdx = i; sres.querySelectorAll('.si').forEach((e, j) => e.classList.toggle('on', j === i)); } },
        h('span', { class: 'sk-' + it.k + ' skind' }, it.k), h('span', { class: 'st' }, it.title), it.sub ? h('span', { class: 'ss' }, it.sub) : null))
      : [h('div', { class: 'muted sn' }, sq.value || sk.value !== 'all' ? 'No matches.' : 'Type to search the whole model.')]));
    const cur = sres.querySelector('.si.on');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function searchKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sIdx = Math.min(sIdx + 1, sItems.length - 1); renderSearch(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sIdx = Math.max(sIdx - 1, 0); renderSearch(); }
    else if (e.key === 'Enter' && sItems[sIdx]) { e.preventDefault(); sItems[sIdx].go(); }
  }
  // The search box starts centred; dragging its grip switches it to explicit coordinates (kept while the tab lives).
  function dragSearch(e) {
    e.preventDefault();
    const m = searchBox.parentNode.getBoundingClientRect(), b = searchBox.getBoundingClientRect();
    const ox = b.left - m.left, oy = b.top - m.top;
    Object.assign(searchBox.style, { transform: 'none', left: ox + 'px', top: oy + 'px' });
    track(e, (ev, dx, dy) => {
      searchBox.style.left = Math.max(0, Math.min(ox + dx, m.width - b.width)) + 'px';
      searchBox.style.top = Math.max(0, Math.min(oy + dy, m.height - 44)) + 'px';
    }, () => {});
  }

  function openSearch() {
    if (!model.project) return;
    searchOpen = true;
    searchBox.hidden = false;
    sq.focus(); sq.select();
    runSearch();
    renderBar();
  }
  function closeSearch() {
    searchOpen = false;
    searchBox.hidden = true;
    renderBar();
  }

  // Cmd/Ctrl+. : hide every open panel (history, search, navigator); press again to bring them back
  function togglePanels(navVisible) {
    if (historyOpen || searchOpen || impactOn || orderOn || alignOn || navVisible) {
      panelMem = { history: historyOpen, search: searchOpen, nav: !!navVisible, impact: impactOn, order: orderOn, align: alignOn };
      historyOpen = false; impactOn = false; orderOn = false; alignOn = false;
      closeSearch();
      vscode.postMessage({ type: 'panels', nav: false });
    } else {
      const m = panelMem || { history: true, nav: true };
      historyOpen = !!m.history; impactOn = !!m.impact && !historyOpen; orderOn = !!m.order && !historyOpen && !impactOn; alignOn = !!m.align && !historyOpen && !impactOn && !orderOn;
      if (m.search) openSearch();
      vscode.postMessage({ type: 'panels', nav: !!m.nav });
    }
    render();
  }

  // ---------- pointer interaction ----------
  const toWorld = (e) => {
    const r = vp.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  function track(e, move, up) {
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const mv = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      move(ev, dx, dy);
    };
    const u = (ev) => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', u);
      up(ev, moved);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', u);
  }

  function select(id) {
    if (selected === id) return;
    selected = id;
    if (orderOn) return render();
    applyFocus();
  }

  // While dragging a relationship every table must be visible: zoom out if any is off screen.
  function showAll() {
    const r = vp.getBoundingClientRect();
    const off = scoped(shown()).tables.some((t) => {
      const x = t.x * view.k + view.x, y = t.y * view.k + view.y;
      return x < 0 || y < 0 || x + W * view.k > r.width || y + H(t) * view.k > r.height;
    });
    if (off) fit();
  }

  function startCardDrag(e, cardNode) {
    const t = tableById(cardNode.dataset.t);
    select(t.id);
    if (!t) return;
    // read-only (viewOnly) or a historical preview: no repositioning, but a plain click (no drag) on the header must still
    // be able to select a table for Impact analysis, exactly as clicking the card body already does (bug found in the
    // read-only Project View / project-index file: a header click silently did nothing there, change 29 release 2 part 8).
    const drag = !preview && !viewOnly, ox = t.x, oy = t.y;
    track(e, (ev, dx, dy) => {
      if (!drag) return;
      t.x = Math.round((ox + dx / view.k) / 10) * 10;
      t.y = Math.round((oy + dy / view.k) / 10) * 10;
      cardNode.style.left = t.x + 'px';
      cardNode.style.top = t.y + 'px';
      drawFrames(); drawEdges(); drawMini(true);
    }, (ev, moved) => { if (moved) { if (drag) { positionsChanged(); render(); } } else if (impactOn) toggleImpactNode(t.layer || 'table', t.id); });
  }

  function startLink(e, rowNode) {
    const t = tableById(rowNode.dataset.t);
    const c = t.columns.find((x) => x.id === rowNode.dataset.c);
    select(t.id);
    const ro = !!preview || (viewOnly && !indexFile); // release 2 part 10: a column can be edited/linked from the project-index file too
    const tmp = svg('path', { class: 'edge tmp' });
    let over = null;
    const clearOver = () => { if (over) over.classList.remove('drop'); over = null; };
    const targetAt = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      return { row: el && el.closest('.row'), card: el && el.closest('.card') };
    };
    track(e, (ev) => {
      if (ro) return;
      if (!dragLink) { dragLink = true; applyFocus(); showAll(); } // undim every table while linking
      if (!tmp.isConnected) edgesSvg.append(tmp);
      const p = toWorld(ev);
      const y = t.y + HEAD + t.columns.indexOf(c) * ROW + ROW / 2;
      const x = p.x < t.x + W / 2 ? t.x : t.x + W;
      tmp.setAttribute('d', `M${x} ${y} L${p.x} ${p.y}`);
      clearOver();
      const { row, card } = targetAt(ev);
      over = row || card;
      if (over) over.classList.add('drop');
    }, (ev, moved) => {
      tmp.remove(); clearOver();
      if (dragLink) { dragLink = false; applyFocus(); }
      if (!moved) { if (!ro) openColumn(t, c); return; }
      if (ro) return;
      const { row, card } = targetAt(ev);
      if (!card) return;
      const tt = tableById(card.dataset.t);
      const tc = row ? tt.columns.find((x) => x.id === row.dataset.c) : tt.columns.find((x) => x.primaryKey);
      if (!tc) return toast(`"${tt.name}" has no primary key — drop on a specific column instead.`);
      if (tc === c) return;
      mutate(`Relate ${t.name}.${c.name} → ${tt.name}.${tc.name}`, () => { c.foreignKey = { tableId: tt.id, columnId: tc.id, cardinality: '1..M' }; });
    });
  }

  // Conceptual level: drag from one entity onto another to define a table-level relationship (with layers: a concept / entity relationship).
  function startConceptLink(e, cardNode) {
    const t = tableById(cardNode.dataset.t);
    select(t.id);
    if (preview || (viewOnly && !indexFile)) return; // release 2 part 10: a concept/entity relationship can be dragged from the index file too
    const tmp = svg('path', { class: 'edge tmp' });
    let over = null;
    const clearOver = () => { if (over) over.classList.remove('drop'); over = null; };
    const cardAt = (ev) => { const el = document.elementFromPoint(ev.clientX, ev.clientY); return el && el.closest('.card'); };
    track(e, (ev) => {
      if (!dragLink) { dragLink = true; applyFocus(); showAll(); }
      if (!tmp.isConnected) edgesSvg.append(tmp);
      const p = toWorld(ev);
      tmp.setAttribute('d', `M${t.x + W / 2} ${t.y + H(t) / 2} L${p.x} ${p.y}`);
      clearOver();
      over = cardAt(ev);
      if (over === cardNode) over = null;
      if (over) over.classList.add('drop');
    }, (ev, moved) => {
      tmp.remove(); clearOver();
      if (dragLink) { dragLink = false; applyFocus(); }
      if (!moved) return;
      const c = cardAt(ev);
      if (c && c !== cardNode) (t.layer ? openLayerRelation : openRelation)(null, { parentId: t.id, childId: c.dataset.t });
    });
  }

  function startPan(e) {
    const ox = view.x, oy = view.y;
    vp.classList.add('panning');
    track(e, (ev, dx, dy) => { view.x = ox + dx; view.y = oy + dy; autoFit = false; applyView(); },
      (ev, moved) => { vp.classList.remove('panning'); if (!moved) select(null); });
  }

  vp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-act],.flabel,#empty,#semempty button,.hit,.xopen,#mini,#ctl')) return;
    const row = e.target.closest('.row'), head = e.target.closest('.head'), card = e.target.closest('.card');
    if (shown().layer === 'metric') { // semantic level: headers drag; in impact analysis a click selects a metric, a table or a column
      const t = card && tableById(card.dataset.t);
      if (head) startCardDrag(e, card); else if (card && impactOn) toggleImpactNode(t.layer ? 'metric' : row ? 'column' : 'table', row && !t.layer ? row.dataset.c : t.id); else if (card) select(card.dataset.t); else startPan(e);
      return;
    }
    if (shown().layer) { // concepts / entities: the header drags, the body draws a relationship (impact analysis: selects)
      if (head) startCardDrag(e, card); else if (card && impactOn) toggleImpactNode(tableById(card.dataset.t).layer, card.dataset.t); else if (card) startConceptLink(e, card); else startPan(e);
      return;
    }
    if (impactOn) { // impact analysis: clicks select (several columns allowed); headers can still be dragged
      if (row && level !== 'conceptual') return toggleImpactNode('column', row.dataset.c);
      if (head) return startCardDrag(e, card);
      if (card) return toggleImpactNode('table', card.dataset.t);
    }
    if (row && level !== 'conceptual') startLink(e, row);
    else if (head) startCardDrag(e, card);
    else if (card && level === 'conceptual' && e.target.closest('.concept')) startConceptLink(e, card);
    else if (card) select(card.dataset.t);
    else startPan(e);
  });
  vp.addEventListener('dblclick', (e) => {
    const head = e.target.closest('.head');
    // release 2 part 10: opening a table/concept/entity/metric's own edit dialog is allowed from the project-index file too (mutate() itself
    // is the one place that still refuses to WRITE anything read-only, e.g. a catalog/schema dialog reached some other way).
    if (head && !preview && (!viewOnly || indexFile)) openNode(tableById(head.parentNode.dataset.t));
  });
  vp.addEventListener('click', (e) => {
    const xo = e.target.closest('.xopen'); // a link to another domain's part: open that part (also in a read-only view)
    if (xo) return vscode.postMessage({ type: 'openPart', file: xo.getAttribute('data-file') });
    const hit = e.target.closest('.hit');
    if (hit && !preview && (!viewOnly || indexFile)) { const it = edgeItems[+hit.dataset.k]; return it.kind === 'lin' ? undefined : layerRels() ? openLayerRelation(it.rel) : openRelation(it); }
    const a = e.target.closest('[data-act]');
    if (!a || preview || (viewOnly && !indexFile)) return;
    const t = tableById(a.closest('.card').dataset.t);
    if (a.dataset.act === 'add-col') openColumn(t, null);
    else if (a.dataset.act === 'edit-table') openNode(t);
  });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    autoFit = false;
    const onMini = e.target.closest('#mini'); // over the mini-map the wheel zooms around the centre of the view
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || onMini) zoomAt(view.k * Math.exp(-Math.max(-30, Math.min(30, e.deltaY)) * 0.01), onMini ? r.width / 2 : e.clientX - r.left, onMini ? r.height / 2 : e.clientY - r.top);
    else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
  }, { passive: false });
  new ResizeObserver(() => { if (autoFit && !first && mode === 'schema') fit(); drawMini(); }).observe(vp);

  let toastTimer;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ---------- instant hover tooltips: heading + description (data-th / data-td) ----------
  const tagLine = (n) => { const g = model.governance.tags.find((x) => x.name === n) || (preview && preview.model.governance.tags.find((x) => x.name === n)); return g ? `• ${g.displayName || g.name}${g.description ? ' — ' + g.description : ''}` : `• ${n}`; };
  const tip = h('div', { id: 'tip', hidden: true });
  document.body.append(tip);
  // The tooltip stays where it appeared and the pointer may enter it to scroll or select and copy its text.
  let tipTimer = null, hideTimer = null, tipEl = null, tipX = 0, tipY = 0, tipBlocked = false, tipOver = false, tipSel = false;
  const placeTip = () => {
    const r = tip.getBoundingClientRect();
    let x = tipX + 10, y = tipY + 12;
    if (x + r.width > innerWidth - 8) x = tipX - r.width - 10;
    if (y + r.height > innerHeight - 8) y = tipY - r.height - 10;
    tip.style.left = Math.max(4, x) + 'px'; tip.style.top = Math.max(4, y) + 'px';
  };
  const hideTip = () => { clearTimeout(tipTimer); clearTimeout(hideTimer); tip.hidden = true; tipOver = tipSel = false; };
  const schedHide = () => { clearTimeout(hideTimer); if (!tipOver && !tipSel) hideTimer = setTimeout(hideTip, 280); };
  tip.addEventListener('mouseenter', () => { tipOver = true; clearTimeout(hideTimer); });
  tip.addEventListener('mouseleave', () => { tipOver = false; if (!tipSel) schedHide(); });
  // Markdown (media/md.js) -> DOM, text nodes only
  const mdInline = (ns) => ns.map((n) => (n.t === 'text' ? n.s : n.t === 'code' ? h('code', null, n.s) : n.t === 'b' ? h('strong', null, ...mdInline(n.c)) : n.t === 'i' ? h('em', null, ...mdInline(n.c)) : h('span', { class: 'mdlink' }, ...mdInline(n.c))));
  const mdNodes = (bs) => bs.map((b) => (b.t === 'h' ? h('div', { class: 'mdh mdh' + Math.min(b.n, 3) }, ...mdInline(b.c)) : b.t === 'p' ? h('p', null, ...mdInline(b.c))
    : b.t === 'ul' || b.t === 'ol' ? h(b.t, null, ...b.items.map((it) => h('li', null, ...mdInline(it)))) : b.t === 'quote' ? h('blockquote', null, ...mdInline(b.c)) : b.t === 'code' ? h('pre', null, b.s) : h('hr', null)));

  // Structured hover information for a catalog, schema, table / view, column, concept, entity, metric or policy. Built when hovered, so it
  // always shows the current model.
  function structuredTip(key) {
    const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1), d = data(), memo = memoOf(d), R = SM.refs(d), rows = [], extra = [], secs = [];
    const list = (a, max = 6) => (a.length > max ? a.slice(0, max).join(', ') + ` … +${a.length - max}` : a.join(', '));
    const tagsOf = (o) => (o.tags || []).map((n) => { const g = d.governance.tags.find((x) => x.name === n); return g ? g.displayName || g.name : n; });
    const meta = (o) => {
      if (o.displayName) rows.push(['Display name', o.displayName]);
      if ((o.tags || []).length) rows.push(['Tags', list(tagsOf(o), 8)]);
      const pr = Object.entries(o.properties || {});
      if (pr.length) rows.push(['Properties', list(pr.map(([k, v]) => `${k}: ${v}`), 5)]);
    };
    const counts = (ts) => { const v = ts.filter((t) => t.kind === 'view').length; rows.push(['Tables', String(ts.length - v)]); if (v) rows.push(['Views', String(v)]); };
    // own and inherited values (↑ = from the concept / entity above); returns the description to show
    const metaEff = (o) => {
      const ef = SA.effective(d, o, memo), up = (x) => (x.from ? ` ↑ ${SA.fromText(x.from)}` : '');
      if (ef.displayName) rows.push(['Display name', ef.displayName.v + up(ef.displayName)]);
      if (ef.tags.length) rows.push(['Tags', list(ef.tags.map((x) => { const g = d.governance.tags.find((y) => y.name === x.name); return (g ? g.displayName || g.name : x.name) + (x.from ? ' ↑' : ''); }), 8)]);
      if (ef.dropped.length) rows.push(['Dropped tags', ef.dropped.map((x) => `${x.name} (from ${SA.fromText(x.from)})`).join(', ')]);
      const pr = Object.entries(ef.properties);
      if (pr.length) rows.push(['Properties', list(pr.map(([k, x]) => `${k}: ${x.v}${x.from ? ' ↑' : ''}`), 5)]);
      if (ef.description && ef.description.from) rows.push(['Description', 'inherited from ' + SA.fromText(ef.description.from)]);
      const src = [...new Set([...ef.tags, ...Object.values(ef.properties)].filter((x) => x.from).map((x) => SA.fromText(x.from)))];
      if (src.length) rows.push(['↑ Inherited', 'from ' + src.join(', ')]);
      return ef.description && ef.description.v;
    };
    // governance values (own and inherited ↑) and the policies that apply; long Markdown fields as their own sections
    // Below the identity (name, type, description, structure) come two sections: Security / classification (what the data is: the object's own value
    // and, on containers, what it rolls up from what it holds) and Governance / ownership (how it is managed; ↑ = inherited from above)
    const govRows = (x) => {
      const ef = GV.effective(d, x, memo), c = clsOf(x, d, memo), sec = [], own = [];
      if (c.rolled) sec.push(['Classification', h('span', null, clsBadge(c.rolled.v), h('small', null, ' ' + clsFrom(c.rolled)))]);
      if (c.own && c.rolled && c.own.v !== c.rolled.v) sec.push(['Own value', `${c.own.v} (${c.own.from ? clsFrom(c.own) : 'a minimum, not passed down'})`]);
      for (const dd of GV.COMMON) { const v = ef[dd.key]; if (v && dd.key !== 'classification') own.push([dd.label, v.v + (v.from ? ` ↑ ${GV.fromText(v.from)}` : '')]); }
      const ps = GV.reach(d, x, memo);
      if (ps.length) own.push(['Policies', list(ps.map((q) => q.name + (q.how === 'tag' ? ' (tag)' : q.how === 'inherited' ? ' ↑' : '')), 6)]);
      if (sec.length) secs.push({ title: 'Security / classification', icon: 'lock', rows: sec });
      if (own.length) secs.push({ title: 'Governance / ownership', icon: 'user', rows: own });
    };
    let head = '', sub = '', o = null, hint = '', md = null;
    if (kind === 'catalog') {
      o = d.catalogs.find((c) => c.id === id); if (!o) return null;
      head = o.name; sub = 'Catalog';
      const ss = d.schemas.filter((x) => x.catalogId === id);
      rows.push(['Schemas', String(ss.length)]); counts(d.tables.filter((t) => ss.some((x) => x.id === t.schemaId))); meta(o); govRows(o);
      hint = impactOn ? 'Click to select for impact analysis' : 'Click to edit';
    } else if (kind === 'schema') {
      o = d.schemas.find((x) => x.id === id); if (!o) return null;
      head = R.sch.get(id); sub = 'Schema';
      const c = d.catalogs.find((x) => x.id === o.catalogId);
      if (c) rows.push(['Catalog', c.name]);
      counts(d.tables.filter((t) => t.schemaId === id)); meta(o); govRows(o);
      hint = impactOn ? 'Click to select for impact analysis' : 'Click to edit';
    } else if (kind === 'table') {
      o = d.tables.find((x) => x.id === id); if (!o) return null;
      const isView = o.kind === 'view';
      head = R.tab.get(id); sub = isView ? { view: 'View', temporary: 'Temporary view', materialized: 'Materialized view' }[o.viewType || 'view'] : 'Table';
      const sch = d.schemas.find((x) => x.id === o.schemaId);
      rows.push(['Schema', sch ? R.sch.get(sch.id) : '?'], ['Columns', String(o.columns.length)]);
      const pk = o.columns.filter((c) => c.primaryKey).map((c) => c.name);
      if (pk.length) rows.push(['Primary key', list(pk)]);
      const parents = new Set(), kids = new Set();
      for (const t of d.tables) for (const c of t.columns) {
        const f = c.foreignKey;
        if (!f) continue;
        if (t.id === id && f.tableId !== id) parents.add(R.tab.get(f.tableId));
        if (f.tableId === id && t.id !== id) kids.add(R.tab.get(t.id));
      }
      for (const r of d.relations || []) { if (r.childId === id) parents.add(R.tab.get(r.parentId)); if (r.parentId === id) kids.add(R.tab.get(r.childId)); }
      if (parents.size) rows.push(['References', list([...parents].sort())]);
      if (kids.size) rows.push(['Referenced by', list([...kids].sort())]);
      if (o.sla && (o.sla.exclude || o.sla.frequency)) rows.push(['SLA', o.sla.exclude ? 'Out of SLA (static / reference)' : `${o.sla.frequency}${o.sla.time ? ' by ' + o.sla.time : ''}`]);
      const es = SA.entitiesOfTable(d, o, memo);
      if (es.length) rows.push(['Realises', es.map((e) => { const c = SA.conceptOf(d, e, memo); return e.name + (c ? ` (concept ${c.name})` : ''); }).join(', ')]);
      const um = GV.usedBy(d, 'table', id);
      if (um.length) rows.push(['Used by metrics', list(um.map((x) => x.name))]);
      md = metaEff(o); govRows(o);
      if (hasSla && orderRes && orderRes.avail.has(id)) extra.push({ title: 'Load estimate (from its SLA and dependencies)', text: OR.explain(d, orderRes, id).join('\n') });
      if (isView && o.definition) extra.push({ title: 'Definition', code: o.definition.length > 400 ? o.definition.slice(0, 400) + ' …' : o.definition });
    } else if (kind === 'column') {
      let t = null;
      for (const x of d.tables) if (x.columns.some((c) => c.id === id)) t = x;
      o = t && t.columns.find((c) => c.id === id); if (!o) return null;
      head = R.col.get(id); sub = 'Column';
      rows.push(['Table', R.tab.get(t.id)], ['Data type', o.dataType]);
      const flags = [o.primaryKey && 'Primary key', o.notNull && !o.primaryKey && 'Not null', o.unique && 'Unique'].filter(Boolean);
      if (flags.length) rows.push(['Constraints', flags.join(', ')]);
      if (o.default) rows.push(['Default', o.default]);
      const f = o.foreignKey;
      if (f) { const pt = d.tables.find((x) => x.id === f.tableId), pc = pt && pt.columns.find((c) => c.id === f.columnId); if (pc) rows.push(['References', `${R.tab.get(pt.id)}.${pc.name} (${f.cardinality || '1..M'})`]); }
      const by = [];
      for (const x of d.tables) for (const c of x.columns) if (c.foreignKey && c.foreignKey.columnId === id) by.push(`${x.name}.${c.name}`);
      if (by.length) rows.push(['Referenced by', list(by.sort())]);
      const um = GV.usedBy(d, 'column', id);
      if (um.length) rows.push(['Used by metrics', list(um.map((x) => x.name))]);
      meta(o); govRows(o);
    } else if (kind === 'policy') { // the Governance tab's list: the description as Markdown, with the facts around it
      o = d.governance.policies.find((x) => x.name === id); if (!o) return null;
      head = o.name; sub = 'Policy';
      for (const [k, v] of [['Type', o.type], ['Jurisdiction', o.jurisdiction], ['Minimum classification', o.classification], ['Owner of the rule', o.owner], ['Parents', o.parents.join(', ')]]) if (v) rows.push([k, v]);
      const tg = d.governance.tags.filter((t) => t.policies.includes(o.name)).map((t) => t.displayName || t.name);
      if (tg.length) rows.push(['Brought by tags', list(tg)]);
      hint = 'Click to select · View and Edit on the right';
    } else if (kind === 'metric') {
      o = d.metrics.find((x) => x.id === id); if (!o) return null;
      head = o.name; sub = 'Metric';
      const r = SM.metricRefs(d, o), ub = GV.usedBy(d, 'metric', id);
      if (o.aggregation) rows.push(['Aggregation', AGGS.find((a) => a[0] === o.aggregation)?.[1] || o.aggregation]);
      if ((o.grain || []).length) rows.push(['Grain', o.grain.join(', ')]);
      rows.push(['Computed from', list([...[...r.columns].map((c) => R.col.get(c)), ...[...r.metrics].map((m2) => (d.metrics.find((x) => x.id === m2) || {}).name)], 5) || 'nothing resolved']);
      if (r.missing.length) rows.push(['Not found', list(r.missing.map((q) => q.ref), 4)]);
      if (ub.length) rows.push(['Used by', list(ub.map((x) => x.name))]);
      govRows(o);
      if (o.calculation) extra.push({ title: 'Calculation', code: o.calculation });
      hint = 'Double-click the header to edit';
    } else if (kind === 'concept' || kind === 'entity') {
      o = (kind === 'concept' ? d.concepts : d.entities).find((x) => x.id === id); if (!o) return null;
      head = o.name; sub = kind === 'concept' ? 'Concept' : 'Logical entity';
      if (kind === 'concept') {
        const es = SA.entitiesOf(d, o, memo);
        rows.push(['Entities', es.length ? list(es.map((e) => e.name)) : 'none yet'], ['Tables', String(new Set(es.flatMap((e) => SA.tablesOf(d, e, memo))).size)]);
      } else {
        const c = SA.conceptOf(d, o, memo), ts = SA.tablesOf(d, o, memo), main = ts.find((t) => t.kind !== 'view' && t.columns.some((x) => x.primaryKey));
        rows.push(['Concept', c ? c.name : 'none'], ['Realised by', ts.length ? list(ts.map((t) => R.tab.get(t.id))) : 'no table yet']);
        if (!(o.gov || {}).businessKey && main) rows.push(['Business key', main.columns.filter((x) => x.primaryKey).map((x) => x.name).join(', ') + ` (default: primary key of ${main.name})`]);
      }
      md = metaEff(o); govRows(o);
      if (orderRes && orderRes.explain && orderRes.avail.has(id)) extra.push({ title: 'Load estimate (from its tables)', text: orderRes.explain(id).join('\n') });
      hint = 'Double-click the header to edit';
    } else return null;
    return { head, sub, rows, secs, md: md || o.description, extra, hint };
  }
  const tipDom = (t) => [
    h('div', { class: 'tth' }, t.head, t.sub ? h('span', { class: 'tsub' }, t.sub) : null),
    t.rows.length ? h('div', { class: 'tkv' }, ...t.rows.flatMap(([k, v]) => [h('span', { class: 'tk' }, k), h('span', { class: 'tv' }, v)])) : null,
    t.md ? h('div', { class: 'tmd' }, ...mdNodes(SMD.parse(t.md))) : null,
    ...t.secs.map((x) => h('div', { class: 'tsec' }, h('div', { class: 'tst' }, icon(x.icon, false, 11), x.title), h('div', { class: 'tkv' }, ...x.rows.flatMap(([k, v]) => [h('span', { class: 'tk' }, k), h('span', { class: 'tv' }, v)])))),
    ...t.extra.map((x) => h('div', { class: 'tsec' }, h('div', { class: 'tst' }, x.title), x.code ? h('pre', null, x.code) : h('div', { class: 'tsl' }, x.text))),
    t.hint ? h('div', { class: 'thint' }, t.hint) : null].filter(Boolean);

  document.addEventListener('mouseover', (e) => {
    if (tip.contains(e.target)) { clearTimeout(hideTimer); return; } // moved onto the tooltip
    const el = e.target.closest && e.target.closest('[data-th],[data-td],[data-tk]');
    if (el === tipEl) { clearTimeout(hideTimer); return; }
    clearTimeout(tipTimer); tipEl = el;
    if (!tip.hidden) schedHide();
    if (el && !tipBlocked) tipTimer = setTimeout(() => {
      clearTimeout(hideTimer);
      const tk = el.getAttribute('data-tk'), st = tk && structuredTip(tk);
      if (st) fill(tip, ...tipDom(st));
      else { const th = el.getAttribute('data-th'), td = el.getAttribute('data-td'); fill(tip, th ? h('div', { class: 'tth' }, th) : null, td ? h('div', { class: 'ttd' }, td) : null); }
      tip.classList.toggle('tk', !!st);
      tip.scrollTop = 0; tip.hidden = false; placeTip();
    }, tip.hidden ? 250 : 120);
  });
  document.addEventListener('mousemove', (e) => { tipX = e.clientX; tipY = e.clientY; });
  document.addEventListener('pointerdown', (e) => { if (tip.contains(e.target)) { tipSel = true; return; } tipBlocked = true; hideTip(); });
  window.addEventListener('pointerup', () => { tipBlocked = false; if (tipSel) { tipSel = false; if (!tipOver) schedHide(); } });
  window.addEventListener('pointercancel', () => { tipBlocked = false; tipSel = false; });
  document.addEventListener('wheel', (e) => { if (!tip.contains(e.target)) hideTip(); }, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

  // ---------- host messages ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'model') {
      if (m.settings) settings = m.settings;
      if (m.dataDir) dataDirName = m.dataDir;
      viewOnly = !!m.readOnly; hostKind = m.host || (m.readOnly ? 'static' : 'vscode');
      vscodeThemeName = m.themeName || ''; hostTheme = m.theme || null;
      applyTheme(); reportVsCodeTheme();
      embedStatus = m.embed || null; embedKeys = m.embedKeys || {}; embedProviders = m.embedProviders || embedProviders; embedFile = m.embedFile || embedFile;
      indexFile = !!m.indexFile; embedParts = m.embedParts || null; // release 2 part 9: the project-index file specifically (see the `indexFile` declaration above)
      // release 2 part 12: every part's own log, parsed once here (SM.parseLog, the same parsing `load()` below already does for a single
      // log) - null when not sent (every OTHER view, including the ad hoc bespoke Project View panel, which never receives `histories`).
      partHists = m.histories ? m.histories.map((p) => ({ name: p.name, model: p.model, domain: p.domain, gov: !!p.gov, hist: SM.parseLog(p.text).history })) : null;
      load(m.text, m.history, m.layoutFile, m.cache);
      if (m.domains) model.domains = m.domains; // release 2 (ADR-0045): the manifest's domains, above the concept in the governance chain (gov.js)
      if (m.crossPart) model.crossPart = m.crossPart; // release 2 part 2: the whole-project name index, so another part's object is not `broken-ref`
      if (m.sharedGovernance) model.sharedGovernance = m.sharedGovernance; // release 2 part 2: governance.json's tags / policies, read-only here
      // the read-only Project View (release 2 part 4, ADR-0045 extended): every part assembled into one model (lib/project.js#assemble), plus
      // which domain each table/concept/entity came from (a name -> domain display name map, drawFrames/cardEl badge it); never round-tripped.
      if (m.domainOf) model.domainOf = m.domainOf; else delete model.domainOf;
      model.projectView = !!m.projectView;
      // an archived (pre-split) file (release 2 part 5, ADR-0045 point 10): a persistent banner names the parts it split into and the
      // project-index file that shows them all together; never round-tripped by media/model.js, like domainOf/projectView above.
      if (m.archived) model.archived = m.archived; else delete model.archived;
      const restored = first && !viewOnly && m.layout && m.layout.canvas && model.project ? restoreLayout(m.layout.canvas) : null;
      render();
      if (first) {
        first = false;
        if (!restored || restored.fit) fit(); else applyView();
        layoutReady = true;
        if (!model.project && !broken && !viewOnly) openProject();
      } else if (autoFit) fit();
    } else if (m.type === 'toast') toast(m.text);
    else if (m.type === 'theme') { if (hostKind === 'vscode') vscodeThemeName = m.name || ''; else hostTheme = { name: m.name, kind: m.kind, vars: m.vars }; applyTheme(); }
    else if (m.type === 'embedKeys') {
      embedKeys = m.keys;
      document.querySelectorAll('[data-embkey]').forEach((el) => { el.textContent = embedKeyText(el.dataset.embkey); });
    } else if (m.type === 'embedResult') {
      if (m.status) embedStatus = m.status;
      if (m.embedParts) embedParts = m.embedParts; // indexFile: fresh per-part status after generating
      if (m.perPart) toast('Embeddings: ' + Object.entries(m.perPart).map(([name, r]) => `${name} ${r.error ? '✗ ' + r.error : '✓'}`).join(' · '));
      else toast(m.error ? 'Embeddings failed: ' + m.error : 'Embeddings: ' + Object.entries(m.results).map(([id, r]) => `${(embedProviders.find((p) => p.id === id) || { label: id }).label} ${r.ok ? `✓ ${r.embedded} new, ${r.reused} reused` : r.skipped ? '– skipped (no key)' : '✗ ' + r.error}`).join(' · '));
      syncToolsPop();
    } else if (m.type === 'data') {
      dataCache.set(m.file, m.text);
      if (mode === 'data') renderData();
    } else if (m.type === 'autoLayout') autoLayout();
    else if (m.type === 'undo') undo();
    else if (m.type === 'redo') redo();
    else if (m.type === 'openSettings') openSettings();
    else if (m.type === 'reveal') revealItem(m.kind || 'table', m.ref, m.column);
    else if (m.type === 'toggleHistory') { historyOpen = !historyOpen; if (historyOpen) impactOn = orderOn = alignOn = false; render(); }
    else if (m.type === 'search') openSearch();
    else if (m.type === 'level') { if (model.project && !broken && ['governance', 'domains', ...SM.LEVELS].includes(m.level)) { if (mode === 'data') setMode('schema'); setLevel(m.level); } }
    else if (m.type === 'togglePanels') togglePanels(m.nav);
    else if (m.type === 'beforeSave') {
      // version-on-save: record pending changes as versions and hand the final text + log back to the host
      const flushed = !broken && !preview && versionOnSave() && flushPending(), conv = !!legacy && !broken && !preview; // conv: the older layout is written now
      if (flushed) render();
      vscode.postMessage({ type: 'saveReady', text: flushed || conv ? modelText() : null, history: flushed || conv ? histText() : null, positions: conv ? posText() : undefined });
      if (conv) { legacy = null; posSent = posText(); render(); }
    }
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
