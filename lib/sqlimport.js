// Import from DDL and SQL scripts (change 33, ADR-0051): a cold start from the scripts a team already has. Node only, no vscode import, no dependencies of its own:
// the extension (`Strata: Import from DDL...`, `Strata: Re-sync from SQL scripts`, the New Project wizard) and `strata-sql import-sql` (cli.js) call the same functions.
//
// Reading: lib/sqlscript.js splits the scripts into statements and reads the DDL (tables, views, columns, constraints, indexes, comments, schemas) with a hand-written,
// tolerant reader; every SELECT inside a view, CREATE TABLE AS, INSERT ... SELECT, MERGE, UPDATE ... FROM and plain query goes through lib/dbtsql.js (node-sql-parser with
// the simple reader as fallback, ADR-0050), the same shape the dbt import uses. Which file is "DDL" and which is "DML" is for the user's own organisation: every file is read the same way.
//
// Ownership (what a re-sync may change). The scripts own: a table's kind, a view's definition, a column's type and default, the sql_* properties (clauses, options, indexes,
// identity) and the `sql` key itself (source file, lineage). The scripts only ever ADD: catalogs, schemas, tables, columns, primary key / not null / unique flags,
// descriptions (set only when the object has none), relationships (declared foreign keys; joins found in queries, marked as inferred; many-to-many through a bridge table,
// marked as detected) and starter metrics (tagged sql-derived, made once: one the user edited or deleted is never touched or recreated). Strata owns everything else and it is
// never deleted or overwritten; a table that left the scripts is kept and reported. Objects are matched by catalog.schema.table, case-insensitively.
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');
const GV = require('../media/gov.js');
const project = require('./project.js');
const SQL = require('./dbtsql.js');
const SS = require('./sqlscript.js');
const K = require('./importkit.js');

const { lc } = K;
const nice = (s) => K.nice(String(s).replace(/([a-z0-9])([A-Z])/g, (m, a, b) => a + '_' + b.toLowerCase())); // VisitCount -> Visit count (T-SQL and Oracle names are often camel or upper case)
const up = (s) => String(s).trim().toUpperCase();
const posix = (p) => p.split(path.sep).join('/');
const same = (a, b) => SM.canon(a) === SM.canon(b);
const EXT = /\.(sql|ddl|dml|hql|psql|pgsql|tsql|mysql|bteq)$/i, MAX_FILE = 200e6, MAX_METRICS = 500;
const listOf = (a, n = 5) => a.slice(0, n).join(', ') + (a.length > n ? ` (+${a.length - n} more)` : '');
const unparen = (t) => { for (;;) { t = t.trim(); if (t[0] !== '(') return t; let d = 0, i = 0; for (; i < t.length; i++) { if (t[i] === '(') d++; else if (t[i] === ')' && --d === 0) break; } if (i !== t.length - 1) return t; t = t.slice(1, -1); } };
const pl = (n, w) => `${n} ${n === 1 ? w : w === 'query' ? 'queries' : w + 's'}`;

// ---------- finding and decoding the files ----------
// list: files and folders (a folder is read recursively for .sql / .ddl / .dml / .hql ...); base: what relative paths are relative to. -> [absolute path], each file once, sorted
function collect(list, base = process.cwd()) {
  const out = new Set();
  const walk = (d, depth) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 12 && !/^(node_modules|\.git|\.strata|target|dbt_packages|logs)$/.test(e.name)) walk(p, depth + 1); } else if (EXT.test(e.name)) out.add(p);
    }
  };
  for (const x of [].concat(list || [])) {
    const p = path.resolve(base, x); let st;
    try { st = fs.statSync(p); } catch { throw new Error(`${x} does not exist`); }
    if (st.isDirectory()) { const before = out.size; walk(p, 0); if (out.size === before) throw new Error(`no .sql files in ${x}`); } else out.add(p);
  }
  if (out.size > 20000) throw new Error(`${out.size} files: give fewer, or a folder with the scripts only`);
  return [...out];
}
function decode(buf) { // SSMS and PowerShell like UTF-16; everything else is UTF-8
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  let zeros = 0; for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) zeros++;
  return zeros > 100 ? buf.toString('utf16le') : buf.toString('utf8');
}

// the dialect the files look like (for the dialect question): the start of each file, nothing parsed
function detectFiles(list, base) { return SS.detect(collect(list, base).map((f) => decode(fs.readFileSync(f)).slice(0, 100000)).join('\n')); }

// pg_dump and mysqldump write every join group in parentheses: FROM ((a JOIN b ON ..) JOIN c ON ..), which node-sql-parser does not read. The parentheses around a join group
// (not a sub-select, not a call) are dropped before the query is read; the view definition that is stored keeps them.
const JOINGROUP = /\(\s*\(?\s*[\w"`\[\]\.]+(?:\s+(?:as\s+)?[\w"`\[\]]+)?\s+(?:(?:inner|left|right|full|cross|natural)\s+)?(?:outer\s+)?join\b/i;
// `name`, [name] and "name" around a plain word are no more than that word for the query readers: dropped (the simple reader knows no quotes inside expressions)
const PLAINQ = [/`([A-Za-z_]\w*)`/g, /\[([A-Za-z_]\w*)\]/g, /[`"]([A-Za-z_]\w*)[`"]/g], DQID = new Set(['postgres', 'redshift', 'snowflake', 'trino', 'sqlite', 'duckdb', 'oracle']);
const RESERVED = /^(?:select|from|where|order|group|by|table|user|key|index|primary|case|when|then|else|end|all|and|or|not|null|in|is|as|on|join|left|right|inner|outer|full|cross|union|values|desc|asc|limit|offset|having|check|default|references|foreign|column|constraint|create|drop|alter|insert|update|delete|set|into|view|with|exists|between|like|distinct|top|date|time|timestamp|year|month|day|hour|text|int|current_date|current_time|current_timestamp|current_user|session_user)$/i; // a quoted name that is also a keyword keeps its quotes
function unnest(sql) {
  if (!JOINGROUP.test(sql)) return sql;
  const open = [], drop = new Set();
  let q = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if (ch === '(') open.push(i);
    else if (ch === ')') {
      const a = open.pop();
      if (a === undefined) continue;
      let inner = sql.slice(a + 1, i);
      if (/^\s*(?:select|with)\b/i.test(inner)) continue;
      for (let p; (p = inner.replace(/\([^()]*\)/g, '')) !== inner; inner = p);
      const prev = /([A-Za-z_]\w*)\s*$/.exec(sql.slice(0, a));
      if (/\bjoin\b/i.test(inner) && (!prev || /^(?:from|join|on|and|or|,)$/i.test(prev[1]))) { drop.add(a); drop.add(i); }
    }
  }
  if (!drop.size) return sql;
  let out = '';
  for (let i = 0; i < sql.length; i++) if (!drop.has(i)) out += sql[i];
  return out;
}

// ---------- reading ----------
// o: {ddl, dml (files or folders), dialect? (else detected), sampleRows?, base?}
// -> {S (the statements read: lib/sqlscript.js state), dialect, detected: {dialect, confident} | null, files, notes, dml: [{kind, target, ctx, at, a (the SQL analysis), tab?, cols?}], samples, info}
function readSql(o = {}) {
  const base = o.base || process.cwd(), fl = collect([].concat(o.ddl || [], o.dml || []), base);
  if (!fl.length) throw new Error('no SQL files given: --ddl <files|folders> and / or --dml <files|folders>');
  const texts = [], notes = [];
  for (const f of fl) {
    const size = fs.statSync(f).size;
    if (size > MAX_FILE) { notes.push(`${path.basename(f)} is ${Math.round(size / 1e6)} MB: not read (limit ${MAX_FILE / 1e6} MB)`); continue; }
    texts.push([f, decode(fs.readFileSync(f))]);
  }
  let dialect = o.dialect ? SS.dialectId(o.dialect) : null, detected = null;
  if (o.dialect && !dialect) throw new Error(`unknown dialect "${o.dialect}" (${SS.DIALECTS.join(', ')})`);
  if (!dialect) { detected = SS.detect(texts.map((t) => t[1].slice(0, 100000)).join('\n')); dialect = detected.dialect; }
  const S = SS.state(dialect, { sampleRows: o.sampleRows || 0 });
  for (const [f, t] of texts) SS.read(t, path.basename(f), S);
  SS.settle(S);
  // the SELECTs: one analysis per distinct text (dbtsql caches), none kept longer than needed
  const cache = new Map(), flags = new Map(), flag = (code, who) => (flags.get(code) || flags.set(code, new Set()).get(code)).add(who), dia = dialect === 'databricks' ? 'bigquery' : SQL.dialectOf(dialect); // node-sql-parser has no Databricks: its Hive dialect rejects catalog.schema.table, its BigQuery dialect reads backticks and three-part names
  for (const d of S.dml) {
    const a = SQL.analyse(unnest(d.sql.replace(PLAINQ[dialect === 'sqlserver' ? 1 : DQID.has(dialect) ? 2 : 0], (m, w) => (RESERVED.test(w) ? m : w))), { dialect: dia, cache });
    if (a.via === 'skipped') { flag('big', `${d.at} (${a.reason})`); d.a = null; continue; }
    if (a.notSelect) { flag('notselect', d.at); d.a = null; continue; }
    if (a.large) flag('large', d.at); else if (a.noParser) flag('noparser', d.at); else if (a.error) flag('parse', `${d.at} (${a.error})`);
    for (const w of a.warn || []) flag(w, d.at);
    d.a = a; delete d.sql;
  }
  // notes: what was not read, in the words of the statements
  notes.push(...S.notes.slice(0, 50)); if (S.notes.length > 50) notes.push(`${S.notes.length - 50} more statement problems not shown`);
  notes.push(...S.dup.slice(0, 10));
  if (S.procs.length) notes.push(`${pl(S.procs.length, 'procedural object')} (stored procedures, functions, triggers, packages, anonymous blocks) ${S.procs.length === 1 ? 'is' : 'are'} not read: ${listOf(S.procs.map((p) => `${p.name} at ${p.at}`))}`);
  if (S.skipped.size) { const all = [...S.skipped].sort((a, b) => b[1].n - a[1].n); notes.push(`statements that do not describe tables or queries were not read: ${all.slice(0, 10).map(([k, e]) => `${k} x${e.n} (first at ${e.first})`).join(', ')}${all.length > 10 ? ` (+${all.length - 10} kinds)` : ''}`); }
  if (S.copies) notes.push(`${pl(S.copies, 'COPY ... FROM stdin data block')} skipped: sample data is read from INSERT ... VALUES (pg_dump --inserts)`);
  if (S.temps.length) notes.push(`${pl(S.temps.length, 'temporary table')} skipped: ${listOf(S.temps)}`);
  if (S.drops) notes.push(`${pl(S.drops, 'DROP statement')} applied: a table or view dropped by the scripts is not imported`);
  const fl2 = (code) => flags.get(code), N = (code, msg) => { const s = fl2(code); if (s) notes.push(msg(s.size, listOf([...s]))); };
  if (fl2('noparser')) notes.push('the SQL parser (node-sql-parser) is not installed or is switched off (STRATA_SQL_PARSER=off), so queries were read with the simplified reader, which understands fewer statements (run "npm install" in the Strata SQL folder)');
  N('parse', (n, l) => `${pl(n, 'query')} could not be parsed as ${SS.LABEL[dialect]} SQL and ${n === 1 ? 'was' : 'were'} read with the simplified reader (fewer columns, joins and aggregates may be found): ${l}`);
  N('large', (n, l) => `${pl(n, 'query')} over ${SQL.PARSER_MAX / 1000} kB ${n === 1 ? 'was' : 'were'} read with the simplified reader: ${l}`);
  N('big', (n, l) => `${pl(n, 'query')} skipped, the SQL is too large to read: ${l}`);
  N('notselect', (n, l) => `${pl(n, 'statement')} could not be read as a query (for example a WITH ... INSERT) and ${n === 1 ? 'was' : 'were'} skipped: ${l}`);
  N('relation', (n, l) => `${pl(n, 'query')} read a table function, UNNEST, VALUES or similar in FROM: it is no table and was skipped: ${l}`);
  return { S, dialect, detected, files: fl, notes, samples: S.samples,
    info: { dialect, platform: SS.PLATFORM[dialect], parser: SQL.available(), files: fl, read: `${pl(texts.length, 'file')} as ${SS.LABEL[dialect]}${detected ? (detected.confident ? ' (detected)' : ' (detected, not certain: check it)') : ''}, ${pl(S.tabs.size, 'table and view')}, ${pl(S.dml.length, 'query statement')}` } };
}

// ---------- merging into a Strata file object ----------
// F0 = a file object (SM.toFile shape). -> {F (canonical, ready to write), changes: [{op: add|update, kind, ref, text, n?}], notes: [text], samples: [{ref, cols, rows, more}]}; F0 is not touched.
function merge(F0, imp, opts = {}) {
  const S = imp.S, F = SM.clone(F0), changes = [], notes = [`read: ${imp.info.read}`, ...imp.notes];
  const add = (op, kind, ref, txt, n) => changes.push({ op, kind, ref, text: txt, ...(n ? { n } : {}) });
  const P = F.project || (F.project = {}), three = P.naming === 'catalog.schema.table', plat = SM.PLATFORMS[P.technology] || {};
  for (const k of three ? ['catalogs', 'schemas', 'tables', 'relationships'] : ['schemas', 'tables', 'relationships']) if (!Array.isArray(F[k])) F[k] = [];
  const firstCat = [...S.tabs.values()].map((o) => o.nm.c).find(Boolean);
  const defCat = ((F.catalogs || [])[0] && F.catalogs[0].name) || S.cats[0] || firstCat || plat.catalog || 'main', defSch = plat.schema || 'public';
  const tabRef = (T) => T.schema + '.' + T.name, byRef = new Map(F.tables.map((T) => [lc(tabRef(T)), T]));
  const objT = new Map(), madeAs = new Map(); // script object -> its table in F; tables made by this import -> their change record
  const droppedCat = new Set();
  let untyped = 0;

  const ensureSchema = (nmC, nmS) => {
    let cat = null;
    if (three) {
      const raw = nmC || defCat, c = F.catalogs.find((x) => lc(x.name) === lc(raw));
      cat = c ? c.name : raw;
      if (!c) { F.catalogs.push({ name: raw }); add('add', 'catalog', raw, `+ catalog ${raw}`); }
    } else if (nmC) droppedCat.add(nmC);
    const sn = nmS || defSch, want = (cat ? cat + '.' : '') + sn;
    let s = F.schemas.find((x) => lc((x.catalog ? x.catalog + '.' : '') + x.name) === lc(want));
    if (!s) { s = { name: sn, ...(cat ? { catalog: cat } : {}) }; F.schemas.push(s); add('add', 'schema', want, `+ schema ${want}`); }
    return s;
  };
  const setProps = (o, props, out) => { // the sql_* properties are the scripts': replaced as a set; the user's own properties stay
    const cur = o.properties || {}, next = {};
    for (const k of Object.keys(cur)) if (!k.startsWith('sql_')) next[k] = cur[k];
    Object.assign(next, props);
    if (!same(cur, next)) { if (Object.keys(next).length) o.properties = next; else delete o.properties; out.push('properties'); }
  };
  const setDesc = (o, d, out) => { if (d && !o.description) { o.description = d; out.push('description'); } };
  // schemas that were declared (CREATE SCHEMA ... COMMENT) without a table
  for (const sc of S.schemas.values()) { const s = ensureSchema(sc.c, sc.n); if (sc.description && !s.description) s.description = sc.description; }

  // ---- tables, views, columns ----
  for (const o of S.tabs.values()) {
    const s = ensureSchema(o.nm.c, o.nm.s), sref = (s.catalog ? s.catalog + '.' : '') + s.name, ref = sref + '.' + o.nm.n;
    let T = byRef.get(lc(ref)), created = false;
    if (!T) { T = { name: o.nm.n, schema: sref, columns: [] }; F.tables.push(T); byRef.set(lc(ref), T); created = true; }
    if (!Array.isArray(T.columns)) T.columns = [];
    objT.set(o, T);
    const out = [];
    if (o.kind === 'view') {
      if (T.kind !== 'view') { T.kind = 'view'; out.push('kind'); }
      if (o.viewType !== 'view') T.viewType = o.viewType; else delete T.viewType;
      if (o.definition && T.definition !== o.definition) { T.definition = o.definition; out.push('definition'); }
    } else if (T.kind === 'view') { delete T.kind; delete T.viewType; delete T.definition; out.push('kind'); }
    setDesc(T, o.description, out);
    setProps(T, o.props, out);
    const rec = { file: o.file, ...(T.sql && typeof T.sql === 'object' ? T.sql : {}) }; // the first file a table was read from stays (a renamed script does not touch every table)
    if (!same(T.sql, rec)) { T.sql = rec; if (!created && !out.length) out.push('sql metadata'); }
    const cout = [];
    for (const dc of o.cols) {
      let c = T.columns.find((x) => lc(x.name) === lc(dc.name)), fresh = !c;
      const u = [];
      if (fresh) { c = { name: dc.name, type: dc.type || 'STRING' }; T.columns.push(c); if (!dc.type) untyped++; }
      else if (dc.type && up(dc.type) !== up(c.type)) { u.push(`type ${c.type} -> ${dc.type}`); c.type = dc.type; }
      if (dc.default != null && dc.default !== c.default) { if (!fresh) u.push('default'); c.default = dc.default; }
      setDesc(c, dc.description, u);
      if (dc.pk && !c.pk) { c.pk = true; delete c.notNull; if (!fresh) u.push('primary key'); }
      if (dc.notNull && !c.notNull && !c.pk) { c.notNull = true; if (!fresh) u.push('not null'); }
      if (dc.unique && !c.unique) { c.unique = true; if (!fresh) u.push('unique'); }
      const cp = {}; for (const [k, v] of Object.entries(dc.props || {})) cp[k] = v;
      const before = u.length; setProps(c, cp, u); if (fresh && u.length > before) u.length = before;
      if (!fresh && u.length) cout.push(`${dc.name} (${u.join(', ')})`);
      if (fresh && !created) add('add', 'column', `${tabRef(T)}.${dc.name}`, `+ column ${tabRef(T)}.${dc.name}`);
    }
    if (created) { add('add', 'table', tabRef(T), `+ ${o.kind === 'view' ? 'view' : 'table'} ${tabRef(T)} (${o.cols.length} column${o.cols.length === 1 ? '' : 's'})`, o.cols.length); madeAs.set(T, changes[changes.length - 1]); }
    else if (out.length || cout.length) K.reportUpdate(add, tabRef(T), out, cout);
  }

  // ---- finding a table by the name a statement used ----
  const nameIdx = () => { const m = new Map(); for (const T of F.tables) { const k = lc(T.name); (m.get(k) || m.set(k, []).get(k)).push(T); } return m; };
  let byName = nameIdx();
  const parts = (T) => T.schema.split('.'), schOf = (T) => parts(T).at(-1), catOf = (T) => (three && parts(T).length > 1 ? parts(T)[0] : null);
  const lookup = (nm) => { // {c, s, n} with parts that may be null -> a table of F, or null (unknown or ambiguous)
    let hit = (byName.get(lc(nm.n)) || []).filter((T) => (!nm.s || lc(schOf(T)) === lc(nm.s)) && (!nm.c || !three || lc(catOf(T)) === lc(nm.c)));
    if (hit.length > 1) { const d = hit.filter((T) => lc(schOf(T)) === lc(defSch)); if (d.length === 1) hit = d; }
    return hit.length === 1 ? hit[0] : null;
  };
  const colOf = (T, n) => T.columns.find((x) => lc(x.name) === lc(n));

  // ---- relationships: declared foreign keys (only ever added) ----
  const relSeen = new Set(), hasParent = new Set();
  for (const r of F.relationships) { relSeen.add(lc(r.child) + '\0' + lc(r.parent)); relSeen.add(lc(r.parent) + '\0' + lc(r.child)); hasParent.add(lc(r.child)); }
  const addRel = (child, parent, cardinality, description, label) => {
    if (relSeen.has(lc(child) + '\0' + lc(parent))) return false;
    if (hasParent.has(lc(child))) { notes.push(`${child} already has a parent in Strata SQL; the relationship to ${parent} (${label}) was not imported`); return false; }
    F.relationships.push({ parent, child, cardinality, ...(description ? { description } : {}) });
    relSeen.add(lc(child) + '\0' + lc(parent)); relSeen.add(lc(parent) + '\0' + lc(child)); hasParent.add(lc(child));
    add('add', 'relationship', child, `+ relationship ${parent} -> ${child}${label ? ` (${label})` : ''}`);
    return true;
  };
  const isOne = (T, c) => c.unique || (c.pk && T.columns.filter((x) => x.pk).length === 1);
  const fkLost = [];
  for (const o of S.tabs.values()) for (const fk of o.fks) {
    const T = objT.get(o), po = SS.find(S, fk.parent), PT = (po && objT.get(po)) || lookup(fk.parent);
    if (!PT) { fkLost.push(`${T.name}(${fk.cols.join(', ')}) -> ${SS.fmt(fk.parent)} at ${fk.at}`); continue; }
    const pcols = fk.pcols.length ? fk.pcols : PT.columns.filter((x) => x.pk).map((x) => x.name);
    if (!pcols.length || pcols.length !== fk.cols.length) { notes.push(`${fk.at}: the foreign key ${fk.name || ''} of ${tabRef(T)} to ${tabRef(PT)} names ${fk.cols.length} column(s) and ${pcols.length} parent column(s) (no primary key to default to): not imported`); continue; }
    fk.cols.forEach((cn, i) => {
      const cc = colOf(T, cn), pc = colOf(PT, pcols[i]);
      if (!cc || !pc) { notes.push(`${fk.at}: the foreign key ${fk.name || ''} of ${tabRef(T)} names a column that does not exist (${!cc ? cn : pcols[i]}): not imported`); return; }
      const multi = fk.cols.length > 1, what = [fk.name ? `Foreign key ${fk.name}` : 'Foreign key', fk.action && `(${fk.action.toLowerCase()})`, multi && `column ${i + 1} of ${fk.cols.length} of a composite key`].filter(Boolean).join(' ');
      addRel(`${tabRef(T)}.${cc.name}`, `${tabRef(PT)}.${pc.name}`, !multi && isOne(T, cc) ? '1..1' : '1..M', fk.name || fk.action || multi ? what + '.' : '', 'declared foreign key');
    });
  }
  if (fkLost.length) notes.push(`${pl(fkLost.length, 'foreign key')} to tables that are not in the scripts (nor in the model) were not imported: ${listOf(fkLost)}`);
  // many-to-many: a table whose primary key is exactly two columns that are foreign keys to two different tables, and that nothing references, is a bridge (the Northwind sample models it the same way)
  const isParent = new Set(F.relationships.map((r) => lc(r.parent.split('.').slice(0, -1).join('.'))));
  for (const o of S.tabs.values()) {
    const T = objT.get(o); if (o.kind === 'view' || isParent.has(lc(tabRef(T)))) continue;
    const pk = T.columns.filter((x) => x.pk);
    if (pk.length !== 2) continue; // payload columns are fine: the Northwind sample models order_details (price, quantity, discount) as a bridge too
    const fks = pk.map((c) => F.relationships.find((r) => lc(r.child) === lc(`${tabRef(T)}.${c.name}`) && !r.via && r.cardinality !== 'M..M'));
    if (fks.some((x) => !x)) continue;
    const [a, b] = fks.map((r) => r.parent.split('.').slice(0, -1).join('.'));
    if (lc(a) === lc(b) || !byRef.get(lc(a)) || !byRef.get(lc(b))) continue;
    if (F.relationships.some((r) => r.via && lc(r.via) === lc(tabRef(T)))) continue;
    F.relationships.push({ parent: a, child: b, cardinality: 'M..M', via: tabRef(T), description: `Many-to-many through ${tabRef(T)} (detected from its two foreign keys).` });
    add('add', 'relationship', b, `+ relationship ${a} -> ${b} (many-to-many via ${tabRef(T)}, detected)`);
  }

  // ---- the queries: lineage, view columns, joins, aggregates ----
  const unknown = new Map(), srcOf = (d) => (d.tab ? `${d.tab.kind} ${tabRef(objT.get(d.tab))} (${d.at})` : d.kind === 'select' ? `the query at ${d.at}` : `the ${d.kind} statement at ${d.at}`);
  const deps = new Map(), joins = [], aggs = [], viewDone = new Set();
  const colsOfT = (T) => T.columns.map((c) => ({ name: c.name, type: c.type }));
  for (let pass = 0; pass < 3; pass++) { // views read views: a few passes until the columns settle
    let changed = false;
    const memo = new Map(), busy = new Set();
    for (const d of S.dml) {
      if (!d.a || !d.a.main) continue;
      const a = d.a, ctes = new Map(a.ctes.filter((c) => c.sel).map((c) => [lc(c.name), c.sel]));
      const nmOfRel = (q) => { const n = q.at(-1), sch = q.length > 1 ? q.at(-2) : d.ctx.s, cat = q.length > 2 ? q.at(-3) : d.ctx.c; return { c: cat || null, s: sch || null, n }; };
      const relsOf = (sel) => { // a select's readable relations, each with the table or select it stands for
        let rs = memo.get(sel);
        if (!rs) {
          rs = [];
          for (const r of sel.from) {
            let tgt = null;
            if (r.sub) tgt = { sel: r.sub };
            else if (r.parts) {
              const q = r.parts, scope = r.scope || ctes;
              if (q.length === 1 && scope.has(lc(q[0]))) tgt = { sel: scope.get(lc(q[0])) };
              else if (q.length <= 3 && !q.some((x) => /\W/.test(x))) {
                const T = lookup(nmOfRel(q));
                if (T) tgt = { T }; else if (!/^(information_schema|pg_catalog|sys)$/i.test(q.length > 1 ? q.at(-2) : '')) unknown.set(q.join('.'), (unknown.get(q.join('.')) || 0) + 1);
              }
            }
            if (tgt) rs.push({ alias: r.alias, tgt });
          }
          memo.set(sel, rs);
        }
        return rs;
      };
      const outCols = (sel) => {
        if (busy.has(sel)) return [];
        if (memo.has(sel.items)) return memo.get(sel.items);
        busy.add(sel);
        const rs = relsOf(sel), out = [], seen = new Set();
        const cols = (t) => (t.T ? colsOfT(t.T) : outCols(t.sel));
        for (const it of sel.items) {
          if (it.star) { for (const r of rs) if (it.star === true || lc(r.alias) === lc(it.star)) for (const c of cols(r.tgt)) { if ((it.exclude && it.exclude.has(lc(c.name))) || seen.has(lc(c.name))) continue; seen.add(lc(c.name)); out.push(c); } }
          else if (it.name && !seen.has(lc(it.name))) {
            seen.add(lc(it.name));
            const am = it.agg && it.agg.fn !== 'avg' && it.agg.fn !== 'count' && /^(?:(\w+)\.)?(\w+)$/.exec(it.agg.arg), o = it.col ? origin(sel, it.col.rel, it.col.name, 0) : am ? origin(sel, am[1], am[2], 0) : null;
            out.push({ name: it.name, type: it.type || (it.agg && it.agg.fn === 'count' ? 'BIGINT' : o && colOf(o.T, o.name) && colOf(o.T, o.name).type) || undefined });
          }
        }
        busy.delete(sel); memo.set(sel.items, out);
        return out;
      };
      const origin = (sel, rel, col, depth) => { // the table column a select's column stands for, through CTEs and sub-selects: {T, name, via: [the selects passed through]}
        if (depth > 6) return null;
        const hits = [];
        for (const r of relsOf(sel)) {
          if (rel && lc(r.alias) !== lc(rel)) continue;
          if (r.tgt.T) { const c = colOf(r.tgt.T, col); if (c) hits.push({ T: r.tgt.T, name: c.name, via: [] }); }
          else {
            const it = r.tgt.sel.items.find((x) => x.name && lc(x.name) === lc(col) && !x.star);
            const o = it ? (it.col ? origin(r.tgt.sel, it.col.rel, it.col.name, depth + 1) : null) : r.tgt.sel.items.some((x) => x.star) ? origin(r.tgt.sel, null, col, depth + 1) : null;
            if (o) hits.push({ ...o, via: [r.tgt.sel, ...o.via] });
          }
        }
        return hits.length === 1 ? hits[0] : null;
      };
      const baseOf = (tgt, depth = 0) => { // the one table a relation is made of, through selects that read only that (for count(*)); {T, via}
        if (tgt.T) return { T: tgt.T, via: [] };
        const rs2 = depth < 6 ? relsOf(tgt.sel) : [];
        const o = rs2.length === 1 ? baseOf(rs2[0].tgt, depth + 1) : null;
        return o && { T: o.T, via: [tgt.sel, ...o.via] };
      };
      const target = d.target && (d.tab ? objT.get(d.tab) : lookup({ c: d.target.c || d.ctx.c || null, s: d.target.s || d.ctx.s || null, n: d.target.n }));
      if (d.tab && d.tab.derived && !viewDone.has(d) && target) { // the columns of a view / CREATE TABLE AS that lists none
        const out = outCols(a.main).filter((c) => !colOf(target, c.name));
        if (out.length) {
          for (const c of out) { target.columns.push({ name: c.name, type: c.type ? up(c.type) : 'STRING' }); if (!c.type) untyped++; }
          const mk = madeAs.get(target);
          if (mk) { mk.n = target.columns.length; mk.text = `+ ${target.kind === 'view' ? 'view' : 'table'} ${tabRef(target)} (${mk.n} column${mk.n === 1 ? '' : 's'}, read from its query)`; }
          else for (const c of out) add('add', 'column', `${tabRef(target)}.${c.name}`, `+ column ${tabRef(target)}.${c.name}`);
          changed = true;
        }
        if (pass === 2 || !out.length) viewDone.add(d);
      }
      if (d.tab && !d.tab.derived && target && madeAs.has(target) && pass === 2) { // a view with a column list names its columns, the query gives their types
        const out = outCols(a.main);
        if (out.length === d.tab.cols.length) d.tab.cols.forEach((dc, i) => { const c = colOf(target, dc.name); if (!dc.type && c && c.type === 'STRING' && out[i].type) { c.type = up(out[i].type); untyped--; } });
      }
      if (pass < 2) continue; // joins, lineage and aggregates once, after the columns are known
      for (const sel of SQL.allSels(a)) {
        const rs = relsOf(sel);
        for (const r of rs) if (r.tgt.T && (!target || r.tgt.T !== target)) { const t = deps.get(target) || (target ? deps.set(target, new Set()).get(target) : null); if (t) t.add(tabRef(r.tgt.T)); }
        for (const c of SQL.conds(sel)) {
          const A = origin(sel, c.a[0], c.a[1], 0), B = origin(sel, c.b[0], c.b[1], 0);
          if (A && B && A.T !== B.T && A.T.kind !== 'view' && B.T.kind !== 'view') joins.push({ d, a: A, b: B }); // a view is no end of a relationship
        }
        const lookIn = (x, seen) => (rl, col) => { const o = origin(x, rl, col, 0); if (!o || lc(o.name) !== lc(col)) return null; if (seen) o.via.forEach((v) => seen.add(v)); return tabRef(o.T); };
        const textOf = (x, g) => g && (g.calc(lookIn(x)) || g.expr);
        for (const [idx, it0] of sel.items.entries()) {
          if (!it0.agg) continue;
          const it = it0.name || !(sel === a.main && d.cols && d.cols.length === sel.items.length && !sel.items.some((x) => x.star)) ? it0 : { ...it0, name: d.cols[idx] }; // INSERT (a, b) SELECT ...: the target column names an unnamed item
          const driver = rs[0], via = new Set();
          let calc, uses = new Set(), fn = it.agg.fn === 'count' && it.agg.distinct ? 'count_distinct' : it.agg.fn, base = null;
          if (it.agg.arg === '*') { // count(*): the rows of the first table, counted by its one-column primary key
            base = driver && baseOf(driver.tgt); const pk = base && base.T.columns.filter((x) => x.pk);
            if (!base || pk.length !== 1) continue;
            base.via.forEach((v) => via.add(v));
            calc = `${tabRef(base.T)}.${pk[0].name}`; uses.add(tabRef(base.T)); fn = 'count';
          } else {
            calc = it.agg.calc((rl, col) => { const k = lookIn(sel, via)(rl, col); if (k != null) uses.add(k); return k; });
            if (!calc) continue;
            calc = unparen(calc);
          }
          if ([...via].some((v) => v.group && v.group.length)) continue; // a measure over an aggregated sub-select is not a measure of the rows
          const name = it.name || `${fn} ${it.agg.arg === '*' ? tabRef(base.T).split('.').at(-1) : it.agg.arg.replace(/^.*\./, '')}`;
          if (!/^[\w ]+$/.test(name)) continue;
          const fil = [textOf(sel, sel.filter), ...[...via].map((v) => textOf(v, v.filter))].filter(Boolean).join(' AND '), dims = (sel.group || []).map((g) => textOf(sel, g)); // the filters of the selects it passed through apply too
          const first = base ? tabRef(base.T) : driver && driver.tgt.T && uses.has(tabRef(driver.tgt.T)) ? tabRef(driver.tgt.T) : [...uses][0];
          aggs.push({ fn, calc, raw: it.expr, name, uses: [...uses], filter: fil, dims, grain: first, d });
        }
      }
    }
    if (pass < 2 && !changed) pass = 1; // settled: straight to the last pass
  }
  // lineage (the scripts', replaced at every sync for the tables a statement loads)
  for (const [T, set] of deps) {
    const dep = [...set].sort();
    if (!T.sql) T.sql = {};
    if (same(T.sql.depends_on || [], dep)) continue;
    if (dep.length) T.sql.depends_on = dep; else delete T.sql.depends_on;
    if (![...changes].some((c) => c.ref === tabRef(T) && c.kind === 'table')) add('update', 'table', tabRef(T), `~ table ${tabRef(T)}: lineage`);
  }
  if (unknown.size) notes.push(`${pl(unknown.size, 'table')} read by queries ${unknown.size === 1 ? 'is' : 'are'} not defined in the scripts (nor in the model): joins and metrics on ${unknown.size === 1 ? 'it were' : 'them were'} skipped: ${listOf([...unknown.keys()].sort())}`);
  // joins the queries make where no foreign key says so: only ever added, marked as inferred
  for (const j of joins) {
    const ca = colOf(j.a.T, j.a.name), cb = colOf(j.b.T, j.b.name), pr = K.parentOf(j.a.T, ca, j.b.T, cb);
    if (!pr) continue;
    const [PT, pc, KT, kc] = pr;
    if (hasParent.has(lc(`${tabRef(KT)}.${kc.name}`))) continue;
    addRel(`${tabRef(KT)}.${kc.name}`, `${tabRef(PT)}.${pc.name}`, isOne(KT, kc) ? '1..1' : '1..M', `Inferred from a join in ${srcOf(j.d)}.`, `inferred: join in ${srcOf(j.d)}`);
  }
  // starter metrics from the aggregates: the same calculation and filter in several queries is one metric
  const ML = (F.semantic || (F.semantic = {})).metrics || (F.semantic.metrics = []);
  const seen = new Map(), cand = [];
  for (const a of aggs) {
    const id = `derived:${a.fn}(${a.calc})|${a.filter}`;
    if (seen.has(id)) { seen.get(id).alts.push(`${a.name} in ${srcOf(a.d)}`); continue; }
    const c = { id, name: nice(a.name), sfx: a.grain.split('.').at(-1) + (a.filter ? ', filtered' : ''), agg: a.fn, calc: a.calc, uses: a.uses, derived: 'sql', alts: [], grain: [a.grain],
      text: `${srcOf(a.d)}: ${a.raw} as ${a.name}${a.dims.length ? `. Grouped by ${a.dims.join(', ')}` : ''}${a.filter ? `. Filter: ${a.filter}` : ''}` };
    seen.set(id, c); cand.push(c);
  }
  const gone = new Set(F.semantic.sqlDerived || []), fresh = [];
  for (const c of cand) { const h = SM.hash(c.id); if (!gone.has(h) && !ML.some((x) => x.sql && x.sql.id === c.id)) fresh.push(c); }
  if (fresh.length > MAX_METRICS) notes.push(`${fresh.length - MAX_METRICS} more metric candidates were not imported (limit ${MAX_METRICS} per import; re-sync adds the next ones)`);
  const used = new Set(), refOf = new Map(F.tables.map((T) => [tabRef(T), tabRef(T)])), before = ML.length;
  K.pushMetrics(fresh.slice(0, MAX_METRICS), { numbered: true, key: 'sql', tag: 'sql-derived', refOf, ML, used, notes, add });
  if (ML.length > before) F.semantic.sqlDerived = [...new Set([...gone, ...ML.slice(before).map((x) => SM.hash(x.sql.id))])].sort();
  if (!ML.length) delete F.semantic.metrics;
  if (!Object.keys(F.semantic).length) delete F.semantic;
  if (used.size) {
    const g = F.governance || (F.governance = {}), tags = g.tags || (g.tags = []);
    for (const t of [...used].sort()) if (!tags.some((x) => x.name === t)) { tags.push({ name: t, description: 'A metric derived automatically from the SQL queries of an import: review it before you rely on it', enabled: true }); add('add', 'tag', t, `+ tag ${t}`); }
  }

  if (droppedCat.size) notes.push(`this project names tables schema.table, so the catalog / database part of ${listOf([...droppedCat])} was dropped`);
  if (untyped) notes.push(`${pl(untyped, 'column')} had no type and ${untyped === 1 ? 'was' : 'were'} set to STRING`);
  const seenT = new Set([...objT.values()].map(tabRef).map(lc)), goneT = F.tables.filter((T) => T.sql && T.sql.file && !seenT.has(lc(tabRef(T)))).map(tabRef);
  if (goneT.length) notes.push(`no longer in the scripts, kept in Strata SQL: ${listOf(goneT)}`);
  // INSERT ... VALUES rows -> sample data for the tables they fill
  const samples = [];
  for (const e of S.samples.values()) {
    const T = lookup({ c: e.nm.c, s: e.nm.s, n: e.nm.n });
    if (!T || !e.rows.length) continue;
    const cols = e.cols && e.cols.length ? e.cols.map((n) => (colOf(T, n) || { name: n }).name) : T.columns.map((c) => c.name);
    const rows = e.rows.filter((r) => r.length === cols.length);
    if (rows.length) samples.push({ ref: tabRef(T), cols, rows, more: e.more || rows.length < e.rows.length });
  }
  if (S.valuesSeen.size && !S.sampleRows) notes.push(`${pl(S.valuesSeen.size, 'table')} ${S.valuesSeen.size === 1 ? 'has' : 'have'} INSERT ... VALUES rows in the scripts: sample data was not imported (ask for it: --sample-rows, or Apply with sample data)`);
  return { F: SM.toFile(SM.fromFile(F)), changes, notes, samples, valuesTables: S.valuesSeen.size };
}

// a new project's file object: name, platform from the dialect, 3-part naming when the platform has catalogs or the scripts use database.schema.table
function fresh(imp, name) {
  const tech = SS.PLATFORM[imp.dialect] || 'PostgreSQL', three = SM.PLATFORMS[tech].parts === 3 || imp.S.sawThree;
  return { strata: 2, project: { name, description: `Imported from SQL scripts (${SS.LABEL[imp.dialect]}).`, technology: tech, methodology: 'ER - 3NF', naming: three ? 'catalog.schema.table' : 'schema.table' } };
}

// the preview lines also name the sample data files that would be written
const describe = (r) => { const d = K.describe(r); if (r.samples && r.samples.length) d.lines.push(...r.samples.map((x) => `+ sample data ${x.ref}.csv (${pl(x.rows.length, 'row')}${x.more ? ', the scripts have more' : ''})`)); return d; };

// ---------- sample data ----------
// data/<catalog.schema.table>.csv next to the model; never overwrites a file that is there (it may be the user's). -> [written paths]
function writeSamples(modelFile, samples) {
  if (!samples || !samples.length) return { written: [], kept: [] };
  const r = project.resolve(modelFile), written = [], kept = [];
  for (const s of samples) {
    const p = path.join(r.dataDir, s.ref + '.csv');
    if (fs.existsSync(p)) { kept.push(s.ref); continue; }
    project.write(p, [s.cols, ...s.rows].map((row) => row.map((v) => SM.csvCell(String(v))).join(',')).join('\n') + '\n');
    written.push(p);
  }
  return { written, kept };
}

// ---------- a new project from scripts ----------
// o: {ddl, dml, dialect?, dir, name?, sampleRows?, git?, ignoreLayout?, user?, dryRun?}
function importNew(o) {
  const dir = path.resolve(o.dir || '.'), imp = readSql({ ...o, base: o.base || process.cwd() }), name = String(o.name || path.basename(dir)).trim();
  if (!imp.S.tabs.size) throw new Error(`no CREATE TABLE or CREATE VIEW statement found in ${imp.files.length} file(s) read as ${SS.LABEL[imp.dialect]}` + (imp.notes.length ? ` (${imp.notes[0]})` : ''));
  const r = merge(fresh(imp, name), imp);
  if (o.dryRun) return { ...r, ...describe(r), dryRun: true, dialect: imp.dialect, detected: imp.detected };
  const res = project.create({ dir, name, git: o.git !== false, ignoreLayout: !!o.ignoreLayout, user: o.user, F: r.F, message: `Import from SQL scripts: ${K.headline(r.changes)}` });
  project.setSql(dir, sqlBlock(dir, o, imp));
  const s = writeSamples(res.model, r.samples);
  return { ...r, ...describe(r), model: res.model, files: [...res.files, ...s.written], dialect: imp.dialect, detected: imp.detected };
}
function sqlBlock(root, o, imp) {
  const rel = (list) => (list ? [].concat(list).map((p) => posix(path.relative(root, path.resolve(o.base || process.cwd(), p))) || '.') : undefined);
  return { ddl: rel(o.ddl), dml: rel(o.dml), dialect: imp.dialect, sampleRows: o.sampleRows || undefined, lastSync: new Date().toISOString() };
}

// ---------- re-sync into an existing model ----------
// o: {ddl?, dml?, dialect?, sampleRows? (else the manifest's sql block), stop?}. Reads and checks everything, writes nothing.
// -> {file, root, F0, F1, changes, notes, samples, log, baseline, info, ...describe}; changes is empty when the model is up to date.
function plan(modelFile, o = {}) {
  const t = K.target(modelFile, o, 'SQL import'), { file, r, man } = t;
  const stored = (man && man.sql && typeof man.sql === 'object' && man.sql) || {};
  const given = o.ddl || o.dml, ddl = given ? o.ddl : stored.ddl, dml = given ? o.dml : stored.dml;
  if (!ddl && !dml) throw new Error('no SQL files given, and this project has no "sql" block in strata.project.json yet');
  const base = given ? o.base || process.cwd() : r.root;
  const imp = readSql({ ddl, dml, dialect: o.dialect || stored.dialect, sampleRows: o.sampleRows != null ? o.sampleRows : stored.sampleRows || 0, base });
  const { F0, log, baseline } = K.state(t);
  const res = merge(F0, imp);
  return { file, root: r.root, history: r.history, F0, F1: res.F, changes: res.changes, notes: res.notes, samples: res.samples, valuesTables: res.valuesTables, log, baseline, info: imp.info, imp: { ddl, dml, base, dialect: imp.dialect, sampleRows: o.sampleRows != null ? o.sampleRows : stored.sampleRows || 0 }, ...describe(res) };
}
// Writes a plan: the log first (one entry per changed stream), then the model, then the manifest's sql block and the sample data.
function apply(p, o = {}) {
  const res = K.commit(p, o, 'SQL scripts', () => project.setSql(p.root, sqlBlock(p.root, { ddl: p.imp.ddl, dml: p.imp.dml, base: p.imp.base, sampleRows: p.imp.sampleRows }, { dialect: p.imp.dialect })));
  const s = o.samples === false ? { written: [] } : writeSamples(p.file, p.samples);
  return { ...res, written: [...res.written, ...s.written] };
}
const sync = (modelFile, o = {}) => { const p = plan(modelFile, o); return { ...p, ...(o.dryRun ? {} : apply(p, o)) }; };

module.exports = { collect, detectFiles, readSql, merge, fresh, plan, apply, sync, importNew, describe, headline: K.headline, counts: K.counts, detect: SS.detect, DIALECTS: SS.DIALECTS, LABEL: SS.LABEL, PLATFORM: SS.PLATFORM, dialectId: SS.dialectId };
