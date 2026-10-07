// dbt integration (change 31, ADR-0048): import a dbt project into a Strata model and re-sync it later. Node only, no vscode import, no dependencies:
// the extension (`Strata: Import from dbt...`, `Strata: Re-sync from dbt`, the New Project wizard) and `strata-sql import-dbt` (cli.js) call the same functions.
//
// Source = dbt's JSON artifacts: target/manifest.json (models, sources, seeds, snapshots, columns, descriptions, tags, meta, tests) and, when present,
// target/catalog.json (column types). Deliberately NOT read: dbt_project.yml and the models/**/*.yml files. A YAML reader would not know the schema and
// database a model is built into (they come from the profile and generate_schema_name), so it would guess them and later disagree with the manifest;
// `dbt parse` writes the manifest in seconds without a warehouse, so a project without one is told to run it.
//
// Ownership (what a re-sync may change). dbt owns: a table's kind / description / view definition, a column's type and description, the dbt_* properties,
// the tags that came from dbt (remembered in the object's `dbt.tags`, so a tag the user added is never removed) and the `dbt` key itself (unique_id,
// materialization, path). dbt only ever ADDS: tables, columns, relationships (from `relationships` tests), tag definitions, catalogs / schemas, primary key /
// not null / unique flags, and governance values from meta (owner, steward, classification, criticality, lifecycle; set only when the object has none).
// Strata owns everything else (display names, SLAs, concepts, entities, levels, layout, metrics, the user's tags, columns and tables dbt does not know)
// and it is never deleted or overwritten; a table that left dbt is kept and reported. Objects are matched by dbt's unique_id, stored as `dbt.id` on the
// table (an ordinary unknown key, ADR-0043); a Strata table with no id but the same schema.name is adopted; columns match by name, case-insensitively.
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');
const GV = require('../media/gov.js');
const project = require('./project.js');
const SQL = require('./dbtsql.js');
const K = require('./importkit.js');

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const up = (s) => String(s).trim().toUpperCase();
const str = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
const uniq = (a) => [...new Set(a)];
const same = (a, b) => SM.canon(a) === SM.canon(b);
const posix = (p) => p.split(path.sep).join('/');
const text = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const json = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { throw new Error(`${p} is not readable JSON (${err.message})`); } };
// dbt adapter (metadata.adapter_type) -> a Strata platform; anything unknown falls back to PostgreSQL (2-part naming)
const ADAPTERS = { postgres: 'PostgreSQL', redshift: 'PostgreSQL', snowflake: 'Snowflake', bigquery: 'Google BigQuery', databricks: 'Databricks', spark: 'Databricks', duckdb: 'DuckDB', sqlserver: 'SQL Server', fabric: 'SQL Server', synapse: 'SQL Server', trino: 'Trino/Presto', presto: 'Trino/Presto', athena: 'Trino/Presto', mysql: 'MySQL', oracle: 'Oracle', sqlite: 'SQLite' };
const NUMERIC = /^(?:(?:TINY|SMALL|BIG|MEDIUM)?INT(?:EGER)?\d*|NUMBER|NUMERIC|DECIMAL|DEC|FLOAT\d*|DOUBLE|REAL|MONEY|FIXED)\b/, KEYISH = /(^|_)(id|key|code|sk|fk|hash|uuid|zip|postal|phone|year|month|day|no|num|number)$/i, ADDITIVE = /amount|total|quantity|qty|count|revenue|sales|cost|freight|units|volume|fee|tax|balance/i;
const nice = K.nice;

// ---------- finding the artifacts ----------
// `from` = a dbt project folder (has dbt_project.yml; reads target/manifest.json), a folder holding manifest.json (a target folder) or the manifest.json itself.
// -> {dbtDir (null when unknown), manifest, catalog (null when there is none)}
function locate(from, catalog) {
  if (!from) throw new Error('no dbt project given: --from <dbt project folder | manifest.json>');
  const p = path.resolve(from);
  let st; try { st = fs.statSync(p); } catch { throw new Error(`${from} does not exist`); }
  let manifest, dbtDir = null;
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(p, 'dbt_project.yml'))) { dbtDir = p; manifest = path.join(p, 'target', 'manifest.json'); } else manifest = path.join(p, 'manifest.json');
    if (!fs.existsSync(manifest)) throw new Error(dbtDir
      ? `no target/manifest.json in ${p}. Run "dbt parse" there (it needs no warehouse; "dbt docs generate" also writes catalog.json with the column types) and try again`
      : `no dbt_project.yml and no manifest.json in ${p}; give a dbt project folder or a manifest.json`);
  } else {
    manifest = p;
    const up2 = path.dirname(path.dirname(p));
    if (path.basename(path.dirname(p)) === 'target' && fs.existsSync(path.join(up2, 'dbt_project.yml'))) dbtDir = up2;
  }
  const cat = catalog ? path.resolve(catalog) : path.join(path.dirname(manifest), 'catalog.json');
  if (catalog && !fs.existsSync(cat)) throw new Error(`${catalog} does not exist`);
  return { dbtDir, manifest, catalog: fs.existsSync(cat) ? cat : null };
}

// ---------- what the SQL says (ADR-0049, ADR-0050) ----------
// A cold project (`dbt parse` only) has no catalog.json and no compiled SQL, so most models have no columns in the manifest. The SQL itself says a lot:
// the columns a model selects, the relations it reads (also hard-coded tables that are no dbt source), how they are joined, which items aggregate.
// Every select of a statement counts: the columns of a UNION / INTERSECT / EXCEPT are the first branch's, but the relations, joins and aggregates of every branch are read.
// env: {nodes: [[id, n]] (models, seeds, snapshots, sources of the project), findRef(jinja text) -> id, base(id, n) -> Map(lc name -> {name, type}),
// fixed(id) -> the catalog knows the columns (then the SQL adds none), seed: Map(id -> [column names a semantic model needs]), dialect, code(n) -> {text, compiled} | null}
// -> {cols: Map(id -> [{name, type}]) (models, sources and hard-coded tables), deps: Map(id -> Set(id)), extra: [hard-coded tables], readers: Map(id -> Set(name)),
// joins: [{by, a: {id, col}, b: {id, col}}], aggs: [{node, name, fn, calc, raw, uses}], flags: Map(code -> Set(text)) (what could not be read, for the notes)}
function sqlLineage(env) {
  const state = new Map(), rel = new Map(), extra = new Map(), parsed = [], readers = new Map(), joins = [], aggs = [], flags = new Map(), cache = new Map();
  const flag = (code, who) => (flags.get(code) || flags.set(code, new Set()).get(code)).add(who);
  const flagCols = (code, p) => { if (!env.fixed(p.id)) flag(code, p.n.name); }; // about columns the SQL would have added: moot when the catalog knows them
  const nameOf = (n) => (n.resource_type === 'source' ? n.identifier || n.name : n.alias || n.name);
  // the schema dbt builds into before a custom schema is added (a bare table name in a model resolves there)
  const baseSchema = (n) => { const c = n.config && n.config.schema; return c && lc(n.schema).endsWith('_' + lc(c)) ? n.schema.slice(0, -(c.length + 1)) : n.schema; };
  const dbs = new Map(), schemas = new Map(); // how dbt spells databases and schemas: a table found by its plain name in SQL takes the same spelling
  for (const [id, n] of env.nodes) {
    if (n.database) dbs.set(lc(n.database), n.database);
    schemas.set(lc(n.schema), n.schema);
    const m = env.base(id, n), k = lc(n.schema) + '.' + lc(nameOf(n));
    state.set(id, m);
    rel.set(k, id); if (n.database) rel.set(lc(n.database) + '.' + k, id);
    for (const c of env.seed.get(id) || []) if (!m.has(lc(c))) m.set(lc(c), { name: c });
    const src = n.resource_type !== 'source' && n.resource_type !== 'seed' && env.code(n);
    if (!src) { if (n.language && n.language !== 'sql' && n.resource_type === 'model') flag('python', n.name); continue; }
    const a = SQL.analyse(src.text, { dialect: env.dialect, cache });
    if (a.via === 'skipped') { flag('big', `${n.name} (${a.reason})`); continue; }
    if (a.notSelect) flag('notselect', n.name);
    if (a.large) flag('large', `${n.name} (${Math.round(src.text.length / 1000)} kB)`); else if (a.noParser) flag('noparser', n.name); else if (a.error) flag('parse', `${n.name} (${a.error})`);
    for (const w of a.warn || []) flag(w, n.name);
    if (!src.compiled) { // raw SQL: what jinja hides
      const macros = new Set(a.marks.map((t) => (/^\{\{-?\s*([\w.]+)/.exec(t) || [])[1]).filter((x) => x && !/^(?:ref|source|var|env_var)$/.test(x)));
      if (macros.size) flag('macro', `${n.name} (${[...macros].slice(0, 3).join(', ')})`);
      if (/\{%-?\s*(?:if|for|set|call|macro)\b/.test(src.text)) flag('jinja', n.name);
    }
    parsed.push({ id, n, a, ctes: new Map(a.ctes.filter((c) => c.sel).map((c) => [lc(c.name), c.sel])), memo: new Map(), rels: new Map() });
  }
  const target = (p, r) => { // a relation of model p -> {id} | {sel, p} | null (unreadable)
    if (r.sub) return { sel: r.sub, p };
    const q = r.parts, last = q[q.length - 1], mk = /^__j(\d+)__$/.exec(last);
    if (mk) { const id = q.length === 1 && env.findRef(p.a.marks[+mk[1]]); return id && state.has(id) ? { id } : null; }
    const scope = r.scope || p.ctes;
    if (q.length === 1 && scope.has(lc(last))) return { sel: scope.get(lc(last)), p };
    if (q.length > 3 || /\W/.test(last)) return null;
    const db = q.length === 3 ? q[0] : null, sch = q.length === 1 ? baseSchema(p.n) : q[q.length - 2], key = lc(sch) + '.' + lc(last);
    const id = db ? rel.get(lc(db) + '.' + key) : rel.get(key) || (q.length === 1 && rel.get(lc(p.n.schema) + '.' + lc(last)));
    if (id) return { id };
    if (/^(information_schema|pg_catalog|sys)$/i.test(sch)) return null;
    const xid = 'relation:' + (db ? lc(db) + '.' : '') + key; // a table that is no dbt source or model: physical all the same
    if (!extra.has(xid)) { extra.set(xid, { id: xid, name: last, schema: schemas.get(lc(sch)) || sch, database: (db && dbs.get(lc(db))) || db || p.n.database || null }); state.set(xid, new Map()); }
    return { id: xid };
  };
  const relsOf = (p, sel) => { // memoised: the readable relations of a select, each with the table or select it stands for
    let rs = p.rels.get(sel);
    if (!rs) { rs = sel.from.map((r) => ({ alias: r.alias, tgt: target(p, r), r })).filter((x) => x.tgt); p.rels.set(sel, rs); }
    return rs;
  };
  const AMBIG = {};
  const busy = new Set();
  const colsOf = (t) => (t.id ? [...state.get(t.id).values()] : outCols(t.p, t.sel));
  const find = (p, rs, col) => { // the column an item reads, from the relation it names or from the only one that has it
    const hits = [];
    for (const r of rs) if (!col.rel || lc(r.alias) === lc(col.rel)) { const h = colsOf(r.tgt).find((c) => lc(c.name) === lc(col.name)); if (h) hits.push(h); }
    if (hits.length > 1 && !col.rel) { flagCols('ambiguous', p); return AMBIG; }
    return hits[0] || null;
  };
  function outCols(p, sel) { // the columns a select produces: named items, and `*` expanded from what it reads (memoised per pass; a cycle gives nothing)
    if (p.memo.has(sel)) return p.memo.get(sel);
    if (busy.has(sel)) return [];
    busy.add(sel);
    const rs = relsOf(p, sel), out = [], seen = new Set();
    for (const it of sel.items) {
      if (it.star) {
        for (const r of rs) if (it.star === true || lc(r.alias) === lc(it.star)) for (const c of colsOf(r.tgt)) { if (it.exclude && it.exclude.has(lc(c.name))) continue; if (seen.has(lc(c.name))) { if (it.star === true && rs.length > 1) flagCols('dupstar', p); continue; } seen.add(lc(c.name)); out.push(c); }
      } else if (it.name) {
        const h = it.col && find(p, rs, it.col);
        if (!seen.has(lc(it.name))) { seen.add(lc(it.name)); out.push({ name: it.name, type: it.type || (h && h !== AMBIG ? h.type : undefined) }); }
      } else flagCols('unnamed', p);
    }
    busy.delete(sel);
    p.memo.set(sel, out);
    return out;
  }
  const put = (id, c) => { const m = state.get(id); if (m && !env.fixed(id) && !m.has(lc(c.name))) { m.set(lc(c.name), { name: c.name, type: c.type }); return true; } return false; };
  for (let pass = 0, changed = true; changed && pass < 5; pass++) { // to a fixed point: `select *` from downstream, explicit columns from upstream
    changed = false;
    for (const p of parsed) p.memo.clear();
    for (const p of parsed) {
      if (p.a.main) for (const c of outCols(p, p.a.main)) changed = put(p.id, c) || changed;
      for (const sel of SQL.allSels(p.a)) {
        const rs = relsOf(p, sel), alias = (a) => rs.find((r) => lc(r.alias) === lc(a)), one = !sel.partial && rs.length === 1 && rs[0];
        for (const ref of sel.refs) { // a column a select reads is a column of what it reads it from (a bare name only when there is one relation and it is no alias of the select)
          const r = ref.rel ? alias(ref.rel) : one && !sel.aliases.has(lc(ref.name)) && one;
          if (r && r.tgt.id) changed = put(r.tgt.id, { name: ref.name }) || changed;
        }
        for (const c of SQL.conds(sel)) for (const [a, col] of [c.a, c.b]) { const t = alias(a); if (t && t.tgt.id) changed = put(t.tgt.id, { name: col }) || changed; }
        if (sel === p.a.main && one && one.tgt.id && sel.items.some((it) => it.star === true || (it.star && lc(it.star) === lc(one.alias)))) {
          const own = new Set(sel.items.filter((it) => !it.star && !it.col && it.name).map((it) => lc(it.name))); // `select *, now() as loaded_at from t`: loaded_at is not t's
          for (const [k, c] of state.get(p.id)) if (!own.has(k)) changed = put(one.tgt.id, c) || changed;
        }
      }
    }
  }
  for (const p of parsed) p.memo.clear();
  const cols = new Map(), deps = new Map();
  for (const [id, n] of env.nodes) deps.set(id, new Set(((n.depends_on && n.depends_on.nodes) || []).filter((x) => state.has(x) && x !== id)));
  for (const [id, m] of state) if (!env.fixed(id)) cols.set(id, [...m.values()]);
  for (const p of parsed) {
    if (!env.fixed(p.id) && p.a.main) { // the select list decides the column order
      const m = state.get(p.id), order = [...new Set(outCols(p, p.a.main).map((c) => lc(c.name)))].filter((k) => m.has(k)), first = new Set(order);
      cols.set(p.id, [...order.map((k) => m.get(k)), ...[...m].filter(([k]) => !first.has(k)).map(([, v]) => v)]);
    }
    for (const sel of SQL.allSels(p.a)) {
      const rs = relsOf(p, sel), alias = (a) => rs.find((r) => lc(r.alias) === lc(a));
      for (const r of rs) if (r.tgt.id && r.tgt.id !== p.id) { deps.get(p.id).add(r.tgt.id); (readers.get(r.tgt.id) || readers.set(r.tgt.id, new Set()).get(r.tgt.id)).add(nameOf(p.n)); }
      for (const c of SQL.conds(sel)) {
        const A = alias(c.a[0]), B = alias(c.b[0]);
        if (A && B && A.tgt.id && B.tgt.id && A.tgt.id !== B.tgt.id) joins.push({ by: nameOf(p.n), a: { id: A.tgt.id, col: c.a[1] }, b: { id: B.tgt.id, col: c.b[1] } });
      }
      for (const it of sel.items) { // aggregate items (sum(price * qty) as revenue): a starter metric when every column in it resolves to one relation
        if (!it.agg || !it.name || it.agg.arg === '*') continue;
        const uses = new Set(), has = (r, col) => state.get(r.tgt.id).has(lc(col));
        const calc = it.agg.calc((rl, col) => {
          const hit = rl ? [alias(rl)].filter(Boolean) : rs;
          const ok = hit.filter((r) => r.tgt.id && has(r, col));
          if (ok.length !== 1) return null;
          uses.add(ok[0].tgt.id); return ok[0].tgt.id;
        });
        if (calc) aggs.push({ node: p.id, name: it.name, fn: it.agg.fn === 'count' && it.agg.distinct ? 'count_distinct' : it.agg.fn, calc, raw: it.expr, uses: [...uses] });
      }
    }
  }
  for (const id of extra.keys()) if (!cols.has(id)) cols.set(id, [...state.get(id).values()]);
  return { cols, deps, extra: [...extra.values()], readers, joins, aggs, flags };
}

// ---------- versions of dbt's artifacts (ADR-0050) ----------
// manifest.json changed shape over the years (schema v1 = dbt 0.19 ... v12 = dbt 1.8 and later so far, and dbt Fusion writes its own). The reader is tolerant instead of strict:
// it looks for both spellings of a field (raw_code / raw_sql, compiled_code / compiled_sql, the three metric shapes), ignores what it does not know, treats a missing
// section as empty, and says which schema it read; a schema newer than the newest it knows only adds a warning.
const KNOWN = { manifest: 12, catalog: 1 };
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const schemaOf = (doc, kind) => { const m = new RegExp('/' + kind + '/v(\\d+)').exec(String(obj(doc.metadata).dbt_schema_version || '')); return m ? +m[1] : null; };
const rawOf = (n) => (n.raw_code != null ? n.raw_code : n.raw_sql); // dbt before 1.3 wrote raw_sql / compiled_sql
const compiledOf = (n) => (n.compiled_code != null ? n.compiled_code : n.compiled_sql);
const codeOf = (n) => { if (n.language && n.language !== 'sql') return null; const c = compiledOf(n); if (c) return { text: c, compiled: true }; const r = rawOf(n); return r ? { text: r, compiled: false } : null; };
// dbt 1.0 - 1.2 metrics: {type: 'sum', sql: 'amount', model: "ref('x')"}; dbt 1.3 - 1.5: {calculation_method, expression, model}; dbt 1.6+: {type: 'simple' | ..., type_params}
const AGGKEYS = new Set(['sum', 'count', 'count_distinct', 'average', 'avg', 'min', 'max', 'sum_boolean']);
const metricOf = (m) => (!m.type_params && !m.calculation_method && AGGKEYS.has(m.type) && (m.sql != null || m.expression != null) ? { ...m, calculation_method: m.type, expression: m.expression != null ? m.expression : m.sql, type: undefined } : m);
// Is the manifest older than the files it was made from? (dbt parse again before a re-sync.) Newest source file (models, seeds, snapshots, macros, tests, analyses, dbt_project.yml) vs manifest.json.
function staleFiles(dbtDir, manifest) {
  let at; try { at = fs.statSync(manifest).mtimeMs; } catch { return null; }
  let seen = 0, newest = null;
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (seen > 20000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(target|dbt_packages|dbt_modules|node_modules|logs|\.\w+)$/.test(e.name)) walk(p); }
      else if (/\.(sql|ya?ml|py|csv)$/i.test(e.name)) { seen++; const t = fs.statSync(p).mtimeMs; if (t > at + 1000 && (!newest || t > newest.t)) newest = { t, p }; }
    }
  };
  for (const sub of ['models', 'seeds', 'snapshots', 'macros', 'tests', 'analyses', 'analysis', 'data']) walk(path.join(dbtDir, sub));
  try { const t = fs.statSync(path.join(dbtDir, 'dbt_project.yml')).mtimeMs; if (t > at + 1000 && (!newest || t > newest.t)) newest = { t, p: path.join(dbtDir, 'dbt_project.yml') }; } catch { /* no project file */ }
  return newest && posix(path.relative(dbtDir, newest.p));
}
const listOf = (set) => { const a = [...set].sort(); return a.slice(0, 5).join(', ') + (a.length > 5 ? ` (+${a.length - 5} more)` : ''); };

// ---------- reading the artifacts ----------
// -> {nodes: [imported table], metrics, aggs, info: {project, adapter, version, generatedAt, dbtDir, manifest, catalog, read}, notes: [text], skipped: {kind: count}}
// A node = {id, type: model|source|seed|snapshot|undeclared, mat, name, database, schema, description, tags[], meta{}, path, view, viewType, sql, columns: [{name, type,
// description, tags[], meta{}, pk, notNull, unique}], rels: [{col, to (a node id), field, note?}], deps: [node id], sem?: {entities, dimensions}}
// `undeclared` = a table a model reads by its plain name that dbt does not know (no source() for it). metrics = dbt's own metrics and semantic-model measures as
// candidates {id, name, description, agg, calc, uses, refs}; aggs = aggregate items found in model SQL (turned into starter metrics by merge).
function readDbt(from, opts = {}) {
  const loc = locate(from, opts.catalog), M = json(loc.manifest), C = loc.catalog ? json(loc.catalog) : null;
  if (!M || typeof M !== 'object' || (!M.nodes && !M.sources)) throw new Error(`${loc.manifest} is not a dbt manifest.json (no "nodes")`);
  const md = obj(M.metadata), notes = [], NODES = obj(M.nodes), SOURCES = obj(M.sources), count = (x) => Object.keys(obj(x)).length;
  const skipped = { ephemeral: 0, package: 0, disabled: 0, exposures: count(M.exposures), metrics: count(M.saved_queries), units: count(M.unit_tests) };
  // which schema was read (and a warning, never a failure, when it is newer than this reader)
  const mv = schemaOf(M, 'manifest'), cv = C ? schemaOf(C, 'catalog') : null, fusion = /^2\.|fusion/i.test(String(md.dbt_version || ''));
  const read = `manifest ${mv ? 'v' + mv : 'with no schema version'} (dbt ${md.dbt_version || 'version unknown'}${fusion ? ', Fusion' : ''}${md.adapter_type ? ', ' + md.adapter_type : ''})${C ? ` and catalog ${cv ? 'v' + cv : 'with no schema version'}` : ', no catalog'}`;
  if (mv && mv > KNOWN.manifest) notes.push(`this manifest is schema v${mv}, newer than the newest this reader knows (v${KNOWN.manifest}): what it recognises was read, check the result and report anything missing`);
  else if (!mv) notes.push('the manifest has no metadata.dbt_schema_version: read as the newest layout');
  else if (mv < 4) notes.push(`this manifest is schema v${mv} (dbt before 1.0): tables, columns, tags and SQL were read; tests, metrics and semantic models may be missing`);
  if (fusion) notes.push('dbt Fusion manifest: read like schema v12; Fusion does not write compiled SQL on parse, so views and SQL-derived columns come from the model SQL as written');
  if (C && cv && cv > KNOWN.catalog) notes.push(`catalog.json is schema v${cv}, newer than this reader knows (v${KNOWN.catalog}): read as far as it matches`);
  let root = opts.allPackages ? null : md.project_name || null;
  if (!root && !opts.allPackages && loc.dbtDir) { const m = /^name:\s*['"]?([\w.-]+)/m.exec(text(path.join(loc.dbtDir, 'dbt_project.yml')) || ''); root = m ? m[1] : null; }
  const resource = (n) => obj(n).resource_type;
  if (!root && !opts.allPackages) { // an old manifest without project_name: the package that owns most models is the project
    const c = new Map();
    for (const n of Object.values(NODES)) if (['model', 'seed', 'snapshot'].includes(resource(n))) c.set(n.package_name, (c.get(n.package_name) || 0) + 1);
    const top = [...c].sort((a, b) => b[1] - a[1])[0];
    if (top) { root = top[0]; if (c.size > 1) notes.push(`the manifest does not name its project: "${root}" (the package with the most models) was taken as the project and the other packages skipped`); }
  }
  if (!C) notes.push('no catalog.json next to the manifest: column types come from data_type in the properties files, otherwise STRING (run "dbt docs generate" for the real types)');
  else if (obj(C.metadata).generated_at && md.generated_at && Date.parse(md.generated_at) - Date.parse(C.metadata.generated_at) > 600000) notes.push(`catalog.json (${C.metadata.generated_at}) is older than manifest.json (${md.generated_at}): its column types may be out of date (run "dbt docs generate")`);
  if (loc.dbtDir) { const newer = staleFiles(loc.dbtDir, loc.manifest); if (newer) notes.push(`manifest.json is older than ${newer}: run "dbt parse" again so the import matches the current project`); }

  const enabled = (n) => !(n.config && n.config.enabled === false);
  const models = Object.entries(NODES).filter(([, n]) => ['model', 'seed', 'snapshot'].includes(resource(n)));
  const sources = Object.entries(SOURCES).filter(([, n]) => n && typeof n === 'object').map(([id, n]) => [id, n.resource_type ? n : { ...n, resource_type: 'source' }]);
  const mine = (n) => !root || n.package_name === root;
  const byName = new Map(), bySource = new Map(), groups = new Map();
  for (const e of models) (byName.get(e[1].name) || byName.set(e[1].name, []).get(e[1].name)).push(e);
  for (const [id, n] of sources) bySource.set(n.source_name + '\0' + n.name, id);
  for (const g of Object.values(obj(M.groups))) groups.set(g.name + '\0' + g.package_name, g);
  // `ref('x')`, `ref('pkg', 'x')`, `ref('x', v=2)`, `source('s', 't')` as written in a test's arguments or a model's SQL -> the node id it names (null when unknown)
  const findRef = (s) => {
    s = String(s || '');
    let m = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/.exec(s);
    if (m) return bySource.get(m[1] + '\0' + m[2]) || null;
    m = /ref\(\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?(?:\s*,\s*(?:v|version)\s*=\s*['"]?([\w.]+)['"]?)?/.exec(s);
    if (!m) return null;
    const [pkg, name] = m[2] ? [m[1], m[2]] : [null, m[1]];
    let hit = (byName.get(name) || []).filter(([, n]) => !pkg || n.package_name === pkg);
    if (m[3] != null) hit = hit.filter(([, n]) => String(n.version) === m[3]); // a versioned model: ref('x', v=2), else the latest version
    else if (hit.length > 1) { const l = hit.filter(([, n]) => n.version == null || String(n.version) === String(n.latest_version)); if (l.length) hit = l; }
    return (hit.find(([, n]) => mine(n)) || hit[0] || [])[0] || null;
  };
  // tests -> what they say about the tested node: unique / not_null columns, key combinations, relationships
  const facts = new Map(), of = (id) => facts.get(id) || facts.set(id, { unique: new Set(), notNull: new Set(), combos: [], rels: [] }).get(id);
  for (const n of Object.values(NODES)) {
    const tm = resource(n) === 'test' && obj(n.test_metadata).name && n.test_metadata;
    if (!tm) continue;
    const kw = obj(tm.kwargs), col = n.column_name || kw.column_name, deps = (n.depends_on && n.depends_on.nodes) || [];
    const at = n.attached_node || (deps.length === 1 ? deps[0] : findRef(kw.model));
    if (!at) continue;
    if (tm.name === 'unique' && col) of(at).unique.add(lc(col));
    else if (tm.name === 'not_null' && col) of(at).notNull.add(lc(col));
    else if (tm.name === 'unique_combination_of_columns' && Array.isArray(kw.combination_of_columns)) of(at).combos.push(kw.combination_of_columns);
    else if (tm.name === 'primary_key' && (kw.column_names || col)) of(at).combos.push([].concat(kw.column_names || col)); // dbt_constraints
    else if (/^relationships(_where)?$/.test(tm.name) && col && kw.field) { // relationships, dbt_utils.relationships_where
      const to = findRef(kw.to) || deps.filter((d) => d !== at && (NODES[d] || SOURCES[d]))[0];
      if (to) of(at).rels.push({ col, to, field: kw.field });
    } else if (tm.name === 'foreign_key' && kw.fk_column_name && kw.pk_column_name) { // dbt_constraints
      const to = findRef(kw.pk_table_name);
      if (to) of(at).rels.push({ col: kw.fk_column_name, to, field: kw.pk_column_name });
    }
  }
  const groupOwner = (n) => {
    const g = n.group || (n.config && n.config.group), hit = g && groups.get(g + '\0' + n.package_name);
    return hit && hit.owner && (hit.owner.name || hit.owner.email);
  };
  // columns as the warehouse and the properties files know them (no SQL involved)
  const catNodes = obj(C && C.nodes), catSources = obj(C && C.sources);
  const catOf = (id) => obj(catNodes[id] || catSources[id]).columns || {};
  const baseCols = (id, n, derived) => {
    const cat = catOf(id), cols = new Map();
    if (!Object.keys(cat).length) for (const c of derived || []) cols.set(lc(c.name), { name: c.name, type: c.type }); // no catalog: what the SQL derived, in select order
    for (const c of Object.values(cat).sort((a, b) => (a.index || 0) - (b.index || 0))) cols.set(lc(c.name), { name: c.name, type: c.type });
    for (const c of Object.values(obj(n.columns))) cols.set(lc(c.name), { ...cols.get(lc(c.name)), name: c.name, description: c.description, type: (cols.get(lc(c.name)) || {}).type || c.data_type, tags: c.tags || (c.config && c.config.tags), meta: { ...(c.config && c.config.meta), ...c.meta }, constraints: c.constraints });
    return cols;
  };

  const eph = (n) => n.resource_type === 'model' && n.config && n.config.materialized === 'ephemeral';
  const wanted = [...models.filter(([, n]) => mine(n) && enabled(n) && !eph(n)), ...sources.filter(([, n]) => mine(n) && enabled(n))];
  for (const [, n] of models) if (!mine(n)) skipped.package++; else if (!enabled(n)) skipped.disabled++; else if (eph(n)) skipped.ephemeral++;
  for (const [, n] of sources) if (!mine(n)) skipped.package++; else if (!enabled(n)) skipped.disabled++;
  for (const l of Object.values(obj(M.disabled))) skipped.disabled += [].concat(l).filter((n) => n && ['model', 'seed', 'snapshot', 'source'].includes(n.resource_type) && mine(n)).length;
  // semantic models: their entities, dimensions and measures name columns the tables must have, and entities say how tables join
  const wantedIds = new Set(wanted.map(([id]) => id));
  const smNode = (sm) => ((sm.depends_on && sm.depends_on.nodes) || []).find((x) => wantedIds.has(x)) || [findRef(sm.model)].find((x) => wantedIds.has(x)) || null;
  const sems = Object.entries(obj(M.semantic_models)).map(([id, sm]) => ({ id, sm: obj(sm), node: smNode(obj(sm)) })).filter((x) => x.node);
  const plain = (e) => (typeof e === 'string' && /^[A-Za-z_]\w*$/.test(e.trim()) ? e.trim() : null);
  const seed = new Map();
  for (const { sm, node } of sems) {
    const want = [...(sm.entities || []), ...(sm.dimensions || []), ...(sm.measures || [])].map((x) => plain(x.expr || x.name)).filter(Boolean);
    seed.set(node, [...(seed.get(node) || []), ...want]);
  }
  const lin = sqlLineage({ nodes: wanted, findRef, seed, dialect: SQL.dialectOf(md.adapter_type), code: codeOf, base: (id, n) => baseCols(id, n), fixed: (id) => Object.keys(catOf(id)).length > 0 });
  // what the SQL reader could not do, as notes (one line each: how many models, the first few)
  const fl = (code) => lin.flags.get(code), N = (code, msg) => { const s = fl(code); if (s) notes.push(msg(s.size, listOf(s))); };
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (fl('noparser')) notes.push('the SQL parser (node-sql-parser) is not installed or is switched off (STRATA_SQL_PARSER=off), so all SQL was read with the simplified reader, which understands fewer statements (run "npm install" in the Strata SQL folder)');
  N('parse', (n, l) => `${pl(n, 'model')} could not be parsed as ${SQL.dialectOf(md.adapter_type)} SQL and ${n === 1 ? 'was' : 'were'} read with the simplified reader (fewer columns and joins may be found): ${l}`);
  N('large', (n, l) => `${pl(n, 'model')} ${n === 1 ? 'has' : 'have'} SQL over ${SQL.PARSER_MAX / 1000} kB and ${n === 1 ? 'was' : 'were'} read with the simplified reader (the parser slows down sharply on statements that large): ${l}`);
  N('big', (n, l) => `${pl(n, 'model')} skipped, the SQL is too large to read: ${l}`);
  N('notselect', (n, l) => `${pl(n, 'model')} ${n === 1 ? 'is' : 'are'} not a plain SELECT statement and ${n === 1 ? 'was' : 'were'} not read: ${l}`);
  N('python', (n, l) => `${pl(n, 'Python model')}: no SQL to read, columns come from the properties files and catalog only (${l})`);
  N('macro', (n, l) => `${pl(n, 'model')} call${n === 1 ? 's' : ''} macros other than ref() / source() in SQL that dbt has not compiled: read as written, what the macro produces is missing (run "dbt compile"): ${l}`);
  N('jinja', (n, l) => `${pl(n, 'model')} use${n === 1 ? 's' : ''} jinja control flow ({% if %}, {% for %}, {% set %}) in SQL that dbt has not compiled: read with those blocks removed (run "dbt compile"): ${l}`);
  N('relation', (n, l) => `${pl(n, 'model')} read a table function, UNNEST, VALUES or similar in FROM: it is no table and was skipped, so columns from it are missing: ${l}`);
  N('ambiguous', (n, l) => `${pl(n, 'model')} select${n === 1 ? 's' : ''} a column without a table prefix that two joined tables both have: no type was taken for it: ${l}`);
  N('dupstar', (n, l) => `${pl(n, 'model')} use${n === 1 ? 's' : ''} select * over joined tables that share a column name: the name is kept once: ${l}`);
  N('unnamed', (n, l) => `${pl(n, 'model')} select${n === 1 ? 's' : ''} expressions without an alias: those columns were not imported (give them an alias in dbt): ${l}`);
  // a view's definition: the compiled SQL, else the model's own SQL with ref() / source() and config() replaced (what `dbt compile` would write, minus other macros)
  let rendered = 0;
  const render = (raw) => { rendered++; return String(raw || '').replace(/\{\{-?\s*config\s*\([\s\S]*?\)\s*-?\}\}\s*/g, '').replace(/\{\{-?\s*((?:ref|source)\s*\([^)]*\))\s*-?\}\}/g, (t, call) => { const id = findRef(call), x = id && (NODES[id] || SOURCES[id]); return x ? x.relation_name || `${x.schema}.${x.alias || x.identifier || x.name}` : t; }).trim(); };
  const build = (id, n, type) => {
    const mat = type === 'model' ? (n.config && n.config.materialized) || 'view' : type, view = type === 'model' && (mat === 'view' || mat === 'materialized_view');
    const meta = { ...(n.config && n.config.meta), ...n.meta };
    if (!('owner' in meta) && groupOwner(n)) meta.owner = groupOwner(n);
    const cols = baseCols(id, n, lin.cols.get(id));
    const col = (name) => cols.get(lc(name)) || cols.set(lc(name), { name }).get(lc(name));
    const f = facts.get(id) || { unique: new Set(), notNull: new Set(), combos: [], rels: [] };
    // primary key: an explicit contract constraint, else a unique_combination_of_columns test, else the first column that is both unique and not null
    const explicit = [...cols.values()].filter((c) => (c.constraints || []).some((k) => k.type === 'primary_key')).map((c) => lc(c.name));
    for (const k of n.constraints || []) if (k.type === 'primary_key') explicit.push(...(k.columns || []).map(lc));
    const pk = new Set(explicit.length ? explicit : f.combos.length ? f.combos[0].map(lc) : [...cols.keys()].filter((k) => f.unique.has(k) && f.notNull.has(k)).slice(0, 1));
    for (const k of pk) col(k);
    const rels = [...f.rels]; // contract foreign keys (dbt 1.9+: `to: ref('x')`, `to_columns`) count like a relationships test
    for (const c of cols.values()) for (const k of c.constraints || []) if (k.type === 'foreign_key' && k.to && k.to_columns && k.to_columns[0]) rels.push({ col: c.name, to: findRef(k.to), field: k.to_columns[0] });
    for (const k of n.constraints || []) if (k.type === 'foreign_key' && k.to && k.to_columns && (k.columns || []).length === 1) rels.push({ col: k.columns[0], to: findRef(k.to), field: k.to_columns[0] });
    for (const c of cols.values()) {
      const k = lc(c.name), has = (t) => (c.constraints || []).some((x) => x.type === t);
      if (pk.has(k)) c.pk = true;
      if (!c.pk && (f.notNull.has(k) || has('not_null'))) c.notNull = true;
      if (!c.pk && (f.unique.has(k) || has('unique'))) c.unique = true;
      c.tags = uniq(c.tags || []).sort(); c.meta = c.meta || {};
      delete c.constraints;
    }
    // a relationship names its columns as the tests spelled them: use the spelling of the column itself
    const relsOut = rels.filter((r) => r.to).map((r) => ({ col: col(r.col).name, to: r.to, field: r.field }));
    return { id, type, mat, name: type === 'source' ? n.identifier || n.name : n.alias || n.name, database: n.database || null, schema: n.schema, description: n.description || '', tags: uniq(n.tags || []).sort(), meta,
      path: n.original_file_path || '', view, viewType: mat === 'materialized_view' ? 'materialized' : 'view', sql: view ? compiledOf(n) || render(rawOf(n)) : '', columns: [...cols.values()],
      rels: relsOut, deps: [...(lin.deps.get(id) || [])].sort() };
  };
  const nodes = wanted.map(([id, n]) => build(id, n, n.resource_type));
  for (const x of lin.extra) { // hard-coded tables: read by name in a model's SQL, no source() declared
    const by = [...(lin.readers.get(x.id) || [])].sort();
    nodes.push({ id: x.id, type: 'undeclared', mat: 'table', name: x.name, database: x.database, schema: x.schema, tags: [], meta: {}, path: '', view: false, viewType: 'view', sql: '', rels: [], deps: [],
      description: `Read by ${by.length === 1 ? 'the dbt model' : 'the dbt models'} ${by.join(', ')} by its plain name, but not declared in dbt (no source()). Declare it as a source to bring its documentation and tests here.`,
      columns: (lin.cols.get(x.id) || []).map((c) => ({ name: c.name, type: c.type, tags: [], meta: {} })) });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cn = (n, name) => n.columns.find((c) => lc(c.name) === lc(name));
  if (rendered) notes.push('no compiled SQL in the manifest (run "dbt compile"): view definitions are the model SQL with ref() and source() replaced');
  // semantic models: the entities and dimensions are kept on the table, a foreign entity that meets a primary one in another model is a relationship
  const owners = new Map(); // entity name -> the semantic models where it is primary / unique / natural
  for (const o of sems) for (const p of o.sm.entities || []) if (['primary', 'unique', 'natural'].includes(p.type)) (owners.get(p.name) || owners.set(p.name, []).get(p.name)).push({ o, p });
  for (const { sm, node } of sems) {
    const T = byId.get(node), pick = (l) => (l || []).map((x) => ({ name: x.name, ...(x.type ? { type: x.type } : {}), ...(x.expr && x.expr !== x.name ? { expr: x.expr } : {}) }));
    T.sem = { model: sm.name, entities: pick(sm.entities), dimensions: pick(sm.dimensions) };
    for (const e of sm.entities || []) {
      if (e.type !== 'foreign') continue;
      for (const { o, p } of owners.get(e.name) || []) {
        if (o.node === node) continue;
        const c = plain(e.expr) || plain(e.name), f = plain(p.expr) || plain(p.name);
        if (c && f) T.rels.push({ col: (cn(T, c) || { name: c }).name, to: o.node, field: f, note: `dbt semantic model entity "${e.name}"` });
      }
    }
  }
  // joins in the SQL: `a.k = b.k` says the two tables are related; the side that is a key (else the table named after the column) is the parent
  for (const j of lin.joins) {
    const A = byId.get(j.a.id), B = byId.get(j.b.id), ca = A && cn(A, j.a.col), cb = B && cn(B, j.b.col);
    if (!ca || !cb) continue;
    const pr = K.parentOf(A, ca, B, cb);
    if (!pr) continue;
    const [P, pc, Kt, kc] = pr;
    if (Kt.rels.some((r) => lc(r.col) === lc(kc.name))) continue; // a test or a constraint already said where this column points
    Kt.rels.push({ col: kc.name, to: P.id, field: pc.name, note: `join in the dbt model ${j.by}` });
  }
  // dbt's own metrics and the measures of the semantic models
  const AGG = { sum: 'sum', count: 'count', count_distinct: 'count_distinct', average: 'avg', avg: 'avg', min: 'min', max: 'max', sum_boolean: 'sum' };
  const measures = new Map(), metrics = [], covered = new Set(), dm = Object.values(obj(M.metrics)).filter((m) => m && typeof m === 'object').map(metricOf);
  for (const { id, sm, node } of sems) for (const ms of sm.measures || []) measures.set(ms.name, { ...ms, node, id });
  const mid = new Map(dm.map((m) => [m.name, m.unique_id || 'metric.' + m.name])), nm = (x) => x && (x.name || x);
  const calcOf = (node, expr) => { const T = byId.get(node); return T && expr && SQL.qualify(expr, (rl, col) => (!rl && cn(T, col) ? node : null)); };
  const where = (f) => (!f ? '' : typeof f === 'string' ? f : (f.where_filters || []).map((x) => x.where_sql_template).filter(Boolean).join(' AND '));
  for (const m of dm) {
    const tp = m.type_params || {}, type = m.type || (m.calculation_method === 'derived' ? 'derived' : 'simple'), one = (agg, expr, node, extra) => ({ agg: AGG[agg], calc: calcOf(node, expr), uses: [node], ...extra });
    let c = null;
    if (m.calculation_method && m.calculation_method !== 'derived') c = one(m.calculation_method, m.expression, findRef(m.model) || ((m.depends_on || {}).nodes || [])[0]); // dbt before 1.3
    else if (type === 'simple' || type === 'cumulative') {
      const ms = measures.get(nm(tp.measure)), ag = tp.metric_aggregation_params;
      if (ms) { covered.add(ms.name); c = one(ms.agg, ms.expr || ms.name, ms.node, { d: ms.description }); }
      else if (ag && ag.agg) { const s = sems.find((x) => x.sm.name === ag.semantic_model); c = s && one(ag.agg, tp.expr, s.node); }
      if (c && type === 'cumulative') c.d2 = 'A cumulative metric in dbt: the window is not modelled here.';
    } else if (type === 'ratio' && nm(tp.numerator) && nm(tp.denominator)) c = { agg: 'none', calc: `{@${mid.get(nm(tp.numerator))}} / {@${mid.get(nm(tp.denominator))}}`, uses: [] };
    else if (type === 'derived' && (tp.expr || m.expression)) c = { agg: 'none', calc: (tp.expr || m.expression).replace(/[A-Za-z_]\w*/g, (w) => (mid.has(w) ? `{@${mid.get(w)}}` : w)), uses: [] };
    if (!c || !c.calc || !c.agg || c.uses.some((x) => !x)) { skipped.metrics++; continue; }
    const fl = where(m.filter), d = [m.description || c.d || '', c.d2 || '', fl ? `dbt filter: ${fl}` : ''].filter(Boolean).map((x) => (/[.!?]$/.test(x) ? x : x + '.')).join(' ');
    metrics.push({ id: mid.get(m.name), name: m.label || nice(m.name), description: d, agg: c.agg, calc: c.calc, uses: c.uses.filter(Boolean), tags: uniq(m.tags || (m.config && m.config.tags) || []).sort() });
  }
  for (const ms of measures.values()) { // a measure no metric builds on is still a calculation somebody wrote down
    const calc = !covered.has(ms.name) && AGG[ms.agg] && calcOf(ms.node, ms.expr || ms.name);
    if (calc) metrics.push({ id: `measure.${ms.id}.${ms.name}`, name: ms.label || nice(ms.name), description: ms.description || '', agg: AGG[ms.agg], calc, uses: [ms.node], tags: [] });
    else if (!covered.has(ms.name)) skipped.metrics++;
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) { n.rels = n.rels.filter((r) => ids.has(r.to)); n.deps = n.deps.filter((d) => ids.has(d)); } // a test against something that is not imported (ephemeral, another package) is dropped
  return { nodes, metrics: metrics.filter((m) => m.uses.every((u) => ids.has(u))), aggs: lin.aggs.filter((a) => ids.has(a.node)), notes, skipped, info: { project: root || md.project_name || (loc.dbtDir && path.basename(loc.dbtDir)) || '', adapter: md.adapter_type || '', version: md.dbt_version || '', generatedAt: md.generated_at || '', schema: { manifest: mv, catalog: cv, fusion }, read, dialect: SQL.dialectOf(md.adapter_type), parser: SQL.available(), ...loc } };
}

// ---------- merging into a Strata file object ----------
// F0 = a file object (SM.toFile shape). -> {F (canonical, ready to write), changes: [{op: add|update, kind, ref, text, n?}], notes: [text]}; F0 is not touched.
function merge(F0, imp, opts = {}) {
  const F = SM.clone(F0), changes = [], notes = [...(imp.info && imp.info.read ? [`read: ${imp.info.read}`] : []), ...imp.notes];
  const add = (op, kind, ref, txt, n) => changes.push({ op, kind, ref, text: txt, ...(n ? { n } : {}) });
  const P = F.project || (F.project = {}), three = P.naming === 'catalog.schema.table';
  for (const k of three ? ['catalogs', 'schemas', 'tables', 'relationships'] : ['schemas', 'tables', 'relationships']) if (!Array.isArray(F[k])) F[k] = []; // a 2-part project has no catalogs key
  const defCat = ((F.catalogs || [])[0] && F.catalogs[0].name) || (SM.PLATFORMS[P.technology] || {}).catalog || 'main';
  const used = new Set(), refOf = new Map(), byId = new Map(), byRef = new Map(), tabRef = (T) => T.schema + '.' + T.name;
  for (const T of F.tables) { byRef.set(lc(tabRef(T)), T); if (T.dbt && typeof T.dbt === 'object' && T.dbt.id) byId.set(T.dbt.id, T); }
  let untyped = 0;
  const todo = new Set(), made = new Set();

  // ---- shared per-object rules (tables and columns) ----
  const setTags = (o, tags, out) => {
    const prev = (o.dbt && o.dbt.tags) || [], keep = (o.tags || []).filter((t) => !prev.includes(t)), next = [...keep, ...tags.filter((t) => !keep.includes(t))];
    tags.forEach((t) => used.add(t));
    if (!same(next, o.tags || [])) { if (next.length) o.tags = next; else delete o.tags; out.push('tags'); }
  };
  const setProps = (o, props, out) => { // the dbt_* properties are dbt's: replaced as a set; the user's own properties stay
    const cur = o.properties || {}, next = {};
    for (const k of Object.keys(cur)) if (!k.startsWith('dbt_')) next[k] = cur[k];
    Object.assign(next, props);
    if (!same(cur, next)) { if (Object.keys(next).length) o.properties = next; else delete o.properties; out.push('properties'); }
  };
  const setGov = (o, meta, out) => { // meta: known governance keys -> governance (only when unset); everything else -> dbt_<key> properties
    const gov = { ...(o.governance || {}) }, props = {};
    for (const [k, v] of Object.entries(meta)) {
      const d = GV.COMMON.find((x) => x.key === lc(k)), ok = d && v != null && typeof v !== 'object' && String(v).trim();
      const val = ok && (d.values ? d.values.find((x) => lc(x) === lc(v)) : String(v).trim());
      if (val) { if (!gov[d.key]) gov[d.key] = val; } else props['dbt_' + k] = str(v);
    }
    const tidy = GV.tidy(gov);
    if (!same(tidy, o.governance || {})) { if (Object.keys(tidy).length) o.governance = tidy; out.push('governance'); }
    setProps(o, props, out);
  };
  const setDesc = (o, d, out) => { if (d && o.description !== d) { o.description = d; out.push('description'); } };

  for (const node of imp.nodes) {
    let catName = null;
    if (three) {
      const raw = node.database || defCat, c = F.catalogs.find((x) => lc(x.name) === lc(raw));
      catName = c ? c.name : raw;
      if (!c) { F.catalogs.push({ name: raw }); add('add', 'catalog', raw, `+ catalog ${raw}`); }
    }
    const want = (catName ? catName + '.' : '') + node.schema;
    let s = F.schemas.find((x) => lc((x.catalog ? x.catalog + '.' : '') + x.name) === lc(want));
    if (!s) { s = { name: node.schema, ...(catName ? { catalog: catName } : {}) }; F.schemas.push(s); add('add', 'schema', want, `+ schema ${want}`); }
    const sref = (s.catalog ? s.catalog + '.' : '') + s.name, ref = sref + '.' + node.name;

    let T = byId.get(node.id), created = false;
    if (T) { if (lc(tabRef(T)) !== lc(ref)) notes.push(`${node.id}: dbt now builds ${ref}, Strata SQL keeps it at ${tabRef(T)} (nothing was moved; rename it in Strata SQL to follow)`); }
    else if ((T = byRef.get(lc(ref)))) {
      if (T.dbt && T.dbt.id && T.dbt.id !== node.id && T.dbt.type !== 'undeclared') { notes.push(`${ref} already belongs to dbt node ${T.dbt.id}; ${node.id} was not imported`); continue; }
    } else { T = { name: node.name, schema: sref, columns: [] }; F.tables.push(T); byRef.set(lc(ref), T); created = true; }
    if (created) made.add(node.id);
    byId.set(node.id, T); refOf.set(node.id, tabRef(T));
    if (!Array.isArray(T.columns)) T.columns = [];

    const out = [];
    if (node.view) { if (T.kind !== 'view') { T.kind = 'view'; out.push('kind'); } if (node.viewType !== 'view') T.viewType = node.viewType; else delete T.viewType; if (node.sql && T.definition !== node.sql) { T.definition = node.sql; out.push('definition'); } }
    else if (T.kind === 'view') { delete T.kind; delete T.viewType; delete T.definition; out.push('kind'); }
    setDesc(T, node.description, out);
    setTags(T, node.tags, out);
    setGov(T, node.meta, out);
    if (!(T.dbt && T.dbt.metricsDerived)) todo.add(node.id); // starter metrics are derived once per table
    const rec = { id: node.id, type: node.type, ...(node.type === 'model' ? { materialized: node.mat } : {}), ...(node.path ? { path: node.path } : {}), ...(node.tags.length ? { tags: node.tags } : {}), ...(node.sem ? { semantic: node.sem } : {}), metricsDerived: true };
    const { tags: _t, ...rest } = T.dbt && typeof T.dbt === 'object' ? T.dbt : {}, next = { ...rest, ...rec };
    if (!same(T.dbt, next)) { T.dbt = next; if (!created && !out.length) out.push('dbt metadata'); }

    const cout = [];
    for (const dc of node.columns) {
      let c = T.columns.find((x) => lc(x.name) === lc(dc.name)), fresh = !c;
      const o = [];
      if (fresh) { c = { name: dc.name, type: dc.type ? up(dc.type) : 'STRING' }; T.columns.push(c); if (!dc.type) untyped++; }
      else if (dc.type && up(dc.type) !== up(c.type)) { o.push(`type ${c.type} -> ${up(dc.type)}`); c.type = up(dc.type); }
      setDesc(c, dc.description, o);
      if (dc.pk && !c.pk) { c.pk = true; delete c.notNull; o.push('primary key'); }
      if (dc.notNull && !c.notNull && !c.pk) { c.notNull = true; o.push('not null'); }
      if (dc.unique && !c.unique) { c.unique = true; o.push('unique'); }
      setTags(c, dc.tags, o);
      setGov(c, dc.meta, o);
      const crec = dc.tags.length ? { tags: dc.tags } : null, { tags: _c, ...crest } = c.dbt && typeof c.dbt === 'object' ? c.dbt : {}, cnext = crec ? { ...crest, ...crec } : crest;
      if (Object.keys(cnext).length) c.dbt = cnext; else delete c.dbt;
      if (!fresh && o.length) cout.push(`${dc.name} (${o.join(', ')})`);
      if (fresh && !created) add('add', 'column', `${tabRef(T)}.${dc.name}`, `+ column ${tabRef(T)}.${dc.name}`);
    }
    if (created) add('add', 'table', tabRef(T), `+ ${node.view ? 'view' : 'table'} ${tabRef(T)} (${node.type === 'undeclared' ? 'read by SQL only' : 'dbt ' + node.type}, ${node.columns.length} column${node.columns.length === 1 ? '' : 's'})`, node.columns.length);
    else if (out.length || cout.length) K.reportUpdate(add, tabRef(T), out, cout);
  }

  // relationships from `relationships` tests: only ever added (an existing pair, or a child column that already has a parent, is left alone)
  const colOf = (id, name) => { const T = byId.get(id); let c = T.columns.find((x) => lc(x.name) === lc(name)); if (!c) { c = { name, type: 'STRING' }; T.columns.push(c); untyped++; } return { T, c }; };
  const relSeen = new Set(F.relationships.map((x) => lc(x.child) + '\0' + lc(x.parent))), hasParent = new Set(F.relationships.map((x) => lc(x.child)));
  for (const node of imp.nodes) for (const r of node.rels) {
    if (!byId.get(node.id) || !byId.get(r.to)) continue;
    const ch = colOf(node.id, r.col), pa = colOf(r.to, r.field), child = `${tabRef(ch.T)}.${ch.c.name}`, parent = `${tabRef(pa.T)}.${pa.c.name}`;
    if (relSeen.has(lc(child) + '\0' + lc(parent))) continue;
    if (hasParent.has(lc(child))) { notes.push(`${child} already has a parent in Strata SQL; the dbt relationship to ${parent} was not imported`); continue; }
    const one = ch.c.unique || (ch.c.pk && ch.T.columns.filter((x) => x.pk).length === 1);
    F.relationships.push({ parent, child, cardinality: one ? '1..1' : '1..M', ...(r.note ? { description: `Inferred from ${r.note}.` } : {}) });
    relSeen.add(lc(child) + '\0' + lc(parent)); hasParent.add(lc(child));
    add('add', 'relationship', child, `+ relationship ${parent} -> ${child}${r.note ? ' (inferred: ' + r.note + ')' : ''}`);
  }
  // lineage: what each table is built from, as Strata table refs (dbt's, replaced at every sync)
  for (const node of imp.nodes) {
    const T = byId.get(node.id); if (!T) continue;
    const dep = node.deps.map((d) => refOf.get(d)).filter(Boolean).sort();
    if (same(T.dbt.depends_on || [], dep)) continue;
    if (dep.length) T.dbt.depends_on = dep; else delete T.dbt.depends_on;
    if (!made.has(node.id)) add('update', 'table', tabRef(T), `~ table ${tabRef(T)}: lineage`);
  }
  addMetrics();
  // metrics (semantic stream). dbt's own metrics and measures are added once (matched by dbt id, never changed again). Starter metrics come from the SQL
  // aggregates of a table and from the numeric columns of fact-like tables (a table with a foreign key), once per table (`dbt.metricsDerived`), tagged dbt-derived
  // and marked in the metric's `dbt` key, so a metric the user edited or deleted is never touched or recreated.
  function addMetrics() {
    const SS = F.semantic || (F.semantic = {}), ML = SS.metrics || (SS.metrics = []), tname = (id) => byId.get(id).name;
    const cand = imp.metrics.map((c) => ({ ...c })), seen = new Map();
    for (const a of imp.aggs) {
      if (!todo.has(a.node) || !byId.get(a.node)) continue;
      const id = `derived:${a.fn}(${a.calc})`; // the same calculation in several models is one metric
      if (seen.has(id)) { seen.get(id).alts.push(`${a.name} in ${tname(a.node)}`); continue; }
      const c = { id, name: nice(a.name), sfx: tname(a.node), agg: a.fn, calc: a.calc, uses: a.uses, derived: 'sql', alts: [], text: `the SQL of the dbt model ${tname(a.node)}: ${a.raw} as ${a.name}` };
      seen.set(id, c); cand.push(c);
    }
    const fk = new Set(F.relationships.map((r) => lc(r.child)));
    for (const node of imp.nodes) {
      const T = byId.get(node.id);
      if (!T || !todo.has(node.id) || !T.columns.some((c) => fk.has(lc(`${tabRef(T)}.${c.name}`)))) continue;
      for (const c of T.columns) {
        if (c.pk || fk.has(lc(`${tabRef(T)}.${c.name}`)) || !NUMERIC.test(up(c.type)) || KEYISH.test(c.name)) continue;
        cand.push({ id: `derived:column:${node.id}.${c.name}`, name: nice(c.name), sfx: T.name, agg: ADDITIVE.test(c.name) ? 'sum' : 'avg', calc: `${node.id}.${c.name}`, uses: [node.id], derived: 'column', alts: [],
          text: `the numeric column ${tabRef(T)}.${c.name} of a table with a foreign key (fact-like)` });
      }
    }
    K.pushMetrics(cand, { key: 'dbt', tag: 'dbt-derived', refOf, ML, used, notes, add });
  }
  // tag definitions for the tags dbt uses (an existing definition is never touched)
  if (used.size) {
    const g = F.governance || (F.governance = {}), tags = g.tags || (g.tags = []);
    for (const t of [...used].sort()) if (!tags.some((x) => x.name === t)) { tags.push({ name: t, description: t === 'dbt-derived' ? 'A metric derived automatically from dbt SQL or column types: review it before you rely on it' : 'Imported from dbt', enabled: true }); add('add', 'tag', t, `+ tag ${t}`); }
  }
  const hard = imp.nodes.filter((n) => n.type === 'undeclared').map((n) => `${n.schema}.${n.name}`);
  if (hard.length) notes.push(`${hard.length} table${hard.length === 1 ? ' is' : 's are'} read by plain name in model SQL but not declared in dbt, imported as tables: ${hard.join(', ')}`);
  if (untyped) notes.push(`${untyped} column${untyped === 1 ? '' : 's'} had no type and were set to STRING (dbt docs generate writes catalog.json with the real ones)`);
  const seen = new Set(imp.nodes.map((n) => n.id)), gone = F.tables.filter((T) => T.dbt && T.dbt.id && !seen.has(T.dbt.id)).map(tabRef);
  if (gone.length) notes.push(`no longer in dbt, kept in Strata SQL: ${gone.join(', ')}`);
  const sk = imp.skipped || {}, skip = [[sk.ephemeral, 'ephemeral model', 'ephemeral models'], [sk.package, 'node of an installed package', 'nodes of installed packages'], [sk.disabled, 'disabled node', 'disabled nodes'], [sk.exposures, 'exposure', 'exposures'],
    [sk.units, 'unit test', 'unit tests'], [sk.metrics, 'saved query or metric that could not be turned into a calculation', 'saved queries or metrics that could not be turned into calculations']].filter(([n]) => n);
  if (skip.length) notes.push('not imported: ' + skip.map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(', '));
  return { F: SM.toFile(SM.fromFile(F)), changes, notes };
}

// a new project's file object: name, platform from the adapter, 3-part naming when the platform has catalogs or dbt uses several databases
function fresh(imp, name) {
  const tech = ADAPTERS[lc(imp.info.adapter)] || 'PostgreSQL', dbs = new Set(imp.nodes.map((n) => n.database).filter(Boolean)), three = SM.PLATFORMS[tech].parts === 3 || dbs.size > 1;
  return { strata: 2, project: { name, description: `Imported from the dbt project "${imp.info.project || name}"${imp.info.version ? ` (dbt ${imp.info.version})` : ''}.`, technology: tech, methodology: 'ER - 3NF', naming: three ? 'catalog.schema.table' : 'schema.table' } };
}

const { counts, headline, describe } = K;

// ---------- a new project from dbt ----------
// o: {from, dir, name?, catalog?, allPackages?, git?, ignoreLayout?, user?, dryRun?}
function importNew(o) {
  const imp = readDbt(o.from, o), dir = path.resolve(o.dir || '.'), name = String(o.name || imp.info.project || path.basename(dir)).trim();
  const r = merge(fresh(imp, name), imp);
  if (o.dryRun) return { ...r, ...describe(r), dryRun: true };
  const res = project.create({ dir, name, git: o.git !== false, ignoreLayout: !!o.ignoreLayout, user: o.user, F: r.F, message: `Import from dbt: ${headline(r.changes)}` });
  project.setDbt(dir, dbtBlock(dir, imp.info));
  return { ...r, ...describe(r), model: res.model, files: res.files };
}
function dbtBlock(root, info) {
  const rel = (p) => (p ? posix(path.relative(root, p)) || '.' : null);
  return { project: rel(info.dbtDir), manifest: rel(info.manifest), catalog: rel(info.catalog), lastSync: new Date().toISOString() };
}

// ---------- re-sync into an existing model ----------
// o: {from? (else the manifest's dbt block), catalog?, allPackages?, stop?}. Reads and checks everything, writes nothing.
// -> {file, root, F0, F1, changes, notes, log, baseline, info, ...describe}; changes is empty when the model is up to date.
function plan(modelFile, o = {}) {
  const t = K.target(modelFile, o, 'dbt import'), { file, r, man } = t;
  const stored = (man && man.dbt && typeof man.dbt === 'object' && man.dbt) || {};
  const at = (p) => (p ? path.resolve(r.root, p) : null);
  const from = o.from || at(stored.manifest) || at(stored.project);
  if (!from) throw new Error('no dbt project given, and this project has no "dbt" block in strata.project.json yet');
  const catalog = o.catalog || (!o.from && at(stored.catalog)) || null;
  const imp = readDbt(from, { catalog: catalog && fs.existsSync(catalog) ? catalog : null, allPackages: o.allPackages });
  const { F0, log, baseline } = K.state(t);
  const res = merge(F0, imp);
  return { file, root: r.root, history: r.history, F0, F1: res.F, changes: res.changes, notes: res.notes, log, baseline, info: imp.info, ...describe(res) };
}
// Writes a plan: the log first (one entry per changed stream, all with the same message), then the model, then the manifest's dbt block.
function apply(p, o = {}) { return K.commit(p, o, 'dbt', () => project.setDbt(p.root, dbtBlock(p.root, p.info))); }
const sync = (modelFile, o = {}) => { const p = plan(modelFile, o); return { ...p, ...(o.dryRun ? {} : apply(p, o)) }; };

module.exports = { locate, readDbt, merge, fresh, plan, apply, sync, importNew, describe, headline, counts };
