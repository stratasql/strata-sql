// What the importers share (change 33, ADR-0051): lib/dbt.js (dbt's manifest) and lib/sqlimport.js (DDL / SQL scripts) both merge into a Strata file object the same
// way, so the parts that do not depend on the source live here: the checks before a re-sync (never rewrite history silently), the write order (the log first, one
// entry per changed stream), the preview text, the parent side of an inferred join, and how derived ("starter") metrics are named, rewritten and added.
// Node only, no vscode import, no dependencies.
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');
const project = require('./project.js');

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const uniq = (a) => [...new Set(a)];
const text = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const nice = (s) => { s = String(s).replace(/_+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

// ---------- inferred relationships ----------
// `a.k = b.k` says two tables are related; the side that is a key (else the table named after the column) is the parent. A, B = {name, columns: [{name, unique, pk}]}.
// -> [parent table, parent column, child table, child column] | null (cannot tell)
const stem = (s) => lc(s).replace(/^(stg|raw|src|base|dim|fct|fact|int|ods)_/, '').replace(/_?(id|key|code|sk|fk)$/, '').replace(/ies$/, 'y').replace(/s$/, '');
const isKey = (n, c) => c && (c.unique || (c.pk && n.columns.filter((x) => x.pk).length === 1));
function parentOf(A, ca, B, cb) {
  let pa = isKey(A, ca), pb = isKey(B, cb);
  if (pa === pb) { pa = stem(A.name) === stem(ca.name); pb = stem(B.name) === stem(cb.name); }
  if (pa === pb) return null;
  return pa ? [A, ca, B, cb] : [B, cb, A, ca];
}

// the change lines of an existing table that was updated: one for its own fields (`out`), one per column (`cout`: "name (what changed)")
function reportUpdate(add, ref, out, cout) {
  if (out.length) add('update', 'table', ref, `~ table ${ref}: ${out.join(', ')}`);
  for (const line of cout) add('update', 'column', `${ref}.${line.split(' ')[0]}`, `~ column ${ref}.${line}`);
}

// ---------- derived metrics ----------
// cand: [{id, name, sfx, agg, calc, uses: [ids], derived?: 'sql' | 'column', alts: [], text, description?, tags?, grain?}] -> pushed onto F.semantic.metrics.
// o: {numbered?: a clashing name gets a number instead of being dropped, key: the object key that marks the source ('dbt' | 'sql'), tag: 'dbt-derived', refOf: Map(id -> table ref), ML: the metrics array, used: Set of tags in use, notes, add(op, kind, ref, text)}.
// Names are unique (a clash is resolved with the table name in brackets, else the metric is reported and skipped); a formula may name another metric as {@id}; a metric that
// was imported before (same `<key>.id`) is never touched or recreated, so one the user edited or deleted stays as it is.
function pushMetrics(cand, o) {
  const { ML, refOf, notes, used, add, key } = o;
  const have = new Map(ML.filter((x) => x[key] && x[key].id).map((x) => [x[key].id, x.name])), names = new Set(ML.map((x) => lc(x.name)));
  const fresh = cand.filter((c) => !have.has(c.id)), dup = {};
  for (const c of fresh) if (c.derived) dup[lc(c.name)] = (dup[lc(c.name)] || 0) + 1;
  const named = [];
  for (const c of fresh) { // names first (a formula may name another metric), then the objects
    const long = `${c.name} (${c.sfx || key})`;
    let pick = [c.derived === 'column' || dup[lc(c.name)] > 1 ? long : c.name, long].find((x) => !names.has(lc(x)));
    if (!pick && o.numbered) for (let n = 2; !pick; n++) if (!names.has(lc(`${long} ${n}`))) pick = `${long} ${n}`; // the SQL import: many queries, the same name and table, different filters
    if (!pick) { notes.push(`metric ${c.name} was not imported: the name is taken`); continue; }
    names.add(lc(pick)); have.set(c.id, pick); named.push([c, pick]);
  }
  for (const [c, name] of named) {
    let bad = c.uses.some((u) => !refOf.has(u));
    const calc = [...c.uses].sort((a, b) => b.length - a.length).reduce((t, id) => (refOf.has(id) ? t.split(id + '.').join(refOf.get(id) + '.') : t), c.calc).replace(/\{@([^}]+)\}/g, (_, id) => (have.has(id) ? `{${have.get(id)}}` : (bad = true, '')));
    if (bad) { notes.push(`metric ${name} was not imported: it reads something that is not in the model`); continue; }
    const tags = c.derived ? [o.tag] : c.tags || [];
    tags.forEach((t) => used.add(t));
    const text = c.derived ? `Starter metric derived from ${c.text}.${c.alts.length ? ` Also computed as ${c.alts.join(', ')}.` : ''} Review it before you rely on it; it is not an authored definition.` : c.description;
    ML.push({ name, ...(text ? { description: text } : {}), calculation: calc, aggregation: c.agg, ...(c.grain && c.grain.length ? { grain: c.grain } : {}), ...(tags.length ? { tags } : {}), [key]: { id: c.id, ...(c.derived ? { derived: c.derived } : {}) } });
    add('add', 'metric', name, `+ metric ${name}${c.derived ? ` (derived from ${c.derived === 'sql' ? 'SQL' : 'a numeric column'})` : ''}`);
  }
}

// ---------- describing a result (the preview and the history message) ----------
const PLURAL = { catalog: 'catalogs', schema: 'schemas', table: 'tables', column: 'columns', relationship: 'relationships', tag: 'tags', metric: 'metrics' };
function counts(changes) {
  const n = { catalogs: 0, schemas: 0, tables: 0, columns: 0, updated: 0, relationships: 0, tags: 0, metrics: 0 };
  for (const c of changes) {
    if (c.op === 'update') n.updated++;
    else if (c.kind === 'table') { n.tables++; n.columns += c.n || 0; } else n[PLURAL[c.kind]]++;
  }
  return n;
}
function headline(changes) {
  const n = counts(changes), parts = [];
  for (const [k, w] of [['tables', 'table'], ['columns', 'column'], ['relationships', 'relationship'], ['tags', 'tag'], ['metrics', 'metric'], ['schemas', 'schema'], ['catalogs', 'catalog']]) if (n[k]) parts.push(`${n[k]} ${w}${n[k] === 1 ? '' : 's'} added`);
  if (n.updated) parts.push(`${n.updated} updated`);
  return parts.join(', ') || 'no changes';
}
const describe = (r) => ({ headline: headline(r.changes), lines: r.changes.map((c) => c.text), notes: r.notes });

// ---------- the model an import may change ----------
// Reads and checks, writes nothing. `what` names the importer in messages ('dbt import', 'SQL import'). -> {file, r (project.resolve), man, F0, log, baseline}
function target(modelFile, o, what) {
  const file = path.resolve(modelFile), r = project.resolve(file, { stop: o.stop });
  if (r.archived) throw new Error('an archived model is read-only; import into a live part');
  if (project.readIndexFile(file)) throw new Error('this is a project-index file, not a model; open one part and import there');
  const man = r.manifest ? project.readManifest(r.root) : null;
  if (man && (man.parts || []).length > 1) throw new Error(`${what} works on a project of one part (this one is split into domains)`);
  return { file, r, man };
}
function state(t) { // the file object and its log: the model must be exactly what its log says, and the log a single line of versions
  const { file, r } = t;
  let F0; try { F0 = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${path.basename(file)} is not readable JSON (${err.message})`); }
  if (!F0 || F0.strata !== 2 || !F0.project) throw new Error(`${path.basename(file)} is not a Strata SQL model (open and save it once in Strata SQL to convert an older file)`);
  const logText = text(r.history);
  let log = null, baseline = false;
  if (logText == null) {
    if (r.historyOld.some((p) => fs.existsSync(p))) throw new Error('this model still has an older version log; open it in Strata SQL and save once to convert it, then import');
    log = SM.newHistory(); baseline = true;
  } else {
    const p = SM.parseLog(logText);
    if (p.error) throw new Error(`the version log ${path.basename(r.history)} is unreadable (${p.error})`);
    log = p.history;
    const bad = SM.verify(log, SM.flatten(F0));
    if (bad.length) throw new Error(`the model differs from its version log (${bad[0]}); open it in Strata SQL and record the change first, then import`);
    if (SM.forks(log).length) throw new Error('the version log has an unresolved fork; open the model in Strata SQL and record the merge first');
  }
  return { F0, log, baseline };
}
// Writes a plan: the log first (one entry per changed stream, all with the same message), then the model, then the manifest's block (`after`).
// p: {file, root, history, F0, F1, log, baseline, changes, headline}; label 'dbt' | 'SQL'
function commit(p, o, label, after) {
  if (!p.changes.length) return { entries: [], written: [] };
  const info = project.infoOf(o.user, `Sync from ${label}: ${p.headline}`), entries = [];
  if (p.baseline) { const flat0 = SM.flatten(p.F0); for (const s of SM.STREAMS) SM.commit(p.log, s, null, flat0[s], { ...info, message: `Baseline before the first ${label} import` }); }
  const flat = SM.flatten(p.F1);
  for (const s of SM.STREAMS) { const e = SM.commit(p.log, s, null, flat[s], info); if (e) entries.push(e); }
  project.write(p.history, SM.logText(p.log));
  project.write(p.file, SM.stringify(p.F1) + '\n');
  project.ensurePart(p.root, p.file, p.F1.project.name);
  after();
  return { entries, written: [p.history, p.file, path.join(p.root, project.MANIFEST)] };
}

module.exports = { lc, uniq, text, nice, stem, isKey, parentOf, reportUpdate, pushMetrics, counts, headline, describe, target, state, commit };
