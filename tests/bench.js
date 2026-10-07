// Times the hot paths on FpML and on a synthetic model (~500 tables, 5,000 columns, 1,000 FKs). Not part of the suites.
//   node tests/bench.js [fpml|synth|all] [--json]      (FPML=<file> to time another model in place of fpml.model.json)
'use strict';
const fs = require('fs'), path = require('path'), R = path.join(__dirname, '..', 'sample_data_models') + '/';
const SM = require('../media/model.js'), SA = require('../media/align.js'), GV = require('../media/gov.js');
const IM = require('../media/impact.js'), OR = require('../media/order.js'), E = require('../media/embed.js');
require('../media/layout.js'); const L = globalThis.Layout;
const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all', asJson = process.argv.includes('--json');

// median of repeated runs, at least 3 runs and about 300 ms of work (one run when a single call takes longer than 3 s)
function time(fn) {
  const t0 = performance.now(); fn(); const first = performance.now() - t0;
  if (first > 3000) return first;
  const ts = [first];
  for (let spent = first; ts.length < 3 || (spent < 300 && ts.length < 200);) { const a = performance.now(); fn(); const d = performance.now() - a; ts.push(d); spent += d; }
  return ts.sort((a, b) => a - b)[ts.length >> 1];
}

// ---------- synthetic model: built as a file object, then filled with layers by SA.generate ----------
function synth(T = 500) {
  const S = 20, sch = (i) => `cat${i % S % 2}.s${i % S}`, tn = (i) => `t_${i}`, tref = (i) => `${sch(i)}.${tn(i)}`, isView = (i) => i % 10 === 9;
  const P = Array.from({ length: 30 }, (_, i) => ({ name: 'P' + i, parents: i ? [...new Set(['P' + Math.floor(i / 3), ...(i % 5 === 0 ? ['P' + Math.floor(i / 7)] : [])])].filter((n) => n !== 'P' + i) : [], type: ['regulatory', 'protection', 'retention', 'security'][i % 4], owner: 'Owner ' + (i % 6) }));
  const tags = Array.from({ length: 20 }, (_, i) => ({ name: 'tag' + i, ...(i % 2 ? {} : { policies: ['P' + (i + 5)] }), enabled: true }));
  const tables = [], rels = [];
  for (let i = 0; i < T; i++) {
    const cols = [{ name: 'id', type: 'BIGINT', pk: true }, ...Array.from({ length: 9 }, (_, k) => ({ name: 'c' + (k + 1), type: k < 2 ? 'BIGINT' : 'STRING', ...(k % 3 === 2 && (i + k) % 7 === 0 ? { tags: ['tag' + ((i + k) % 20)] } : {}), ...((i + k) % 11 === 0 ? { governance: { classification: 'Restricted' } } : {}) }))];
    const t = { name: tn(i), schema: sch(i), ...(i % 4 === 0 ? { governance: { owner: 'Team ' + (i % 9), criticality: 'High' } } : {}), ...(i % 25 === 3 ? { governance: { policies: ['P' + (i % 30)] } } : {}), columns: cols };
    if (isView(i)) Object.assign(t, { kind: 'view', definition: `SELECT a.id, a.c3, b.c4, c.* FROM ${tref(i - 1)} a JOIN ${tref(i - 2)} b ON a.id = b.c1 JOIN ${tn(i - 3)} c ON c.c2 = a.id -- ${i}` });
    else { if (i >= 1 && !isView(Math.floor(i / 2))) rels.push({ parent: tref(Math.floor(i / 2)) + '.id', child: tref(i) + '.c1', cardinality: '1..M' }); if (i >= 2 && !isView(i - 2)) rels.push({ parent: tref(i - 2) + '.id', child: tref(i) + '.c2', cardinality: '1..M' }); if (i >= 5 && i % 3 === 0 && !isView(i - 5)) rels.push({ parent: tref(i - 5) + '.id', child: tref(i) + '.c9', cardinality: '1..M' }); }
    tables.push(t);
  }
  for (let i = 0; i + 1 < T; i += 50) rels.push({ parent: tref(i), child: tref(i + 1), cardinality: 'M..M' });
  const schemas = Array.from({ length: S }, (_, i) => ({ name: 's' + i, catalog: 'cat' + (i % 2), ...(i % 5 === 0 ? { governance: { policies: ['P' + (i + 1)], owner: 'Schema team ' + i } } : {}) }));
  schemas[3].governance = { off: ['P2'] };
  const concepts = Array.from({ length: 25 }, (_, i) => ({ name: 'Concept ' + i, ...(i % 3 ? {} : { tags: ['tag' + (i % 20)], governance: { owner: 'Business ' + i } }) }));
  const entities = Array.from({ length: 150 }, (_, i) => ({ name: 'Entity ' + i, concept: 'Concept ' + (i % 25) }));
  tables.forEach((t, i) => { if (!isView(i)) t.entity = 'Entity ' + (i % 150); });
  const metrics = Array.from({ length: 50 }, (_, i) => ({ name: 'Metric ' + i, calculation: `${sch(i * 3)}.${tn(i * 3)}.c3 * ${tn(i * 3 + 1)}.c4${i ? ` + {Metric ${i - 1}}` : ''}`, aggregation: 'sum', grain: ['Entity ' + (i % 150)], ...(i % 4 ? {} : { governance: { owner: 'Finance' } }) }));
  const F = { strata: 2, project: { name: 'Bench', technology: 'Databricks', methodology: 'ER - 3NF', naming: 'catalog.schema.table', governance: { policies: ['P0'], physical: { owner: 'Platform' }, conceptual: { owner: 'CDO' } } },
    governance: { tags, policies: P }, conceptual: { concepts }, logical: { entities }, catalogs: [{ name: 'cat0' }, { name: 'cat1' }], schemas, tables, relationships: rels, semantic: { metrics } };
  const m = SM.fromFile(F, 'physical');
  SA.generate(m); // logical and conceptual relationships from the physical ones
  return SM.toFile(m);
}

// a version log with n entries per stream on top of F (modelling: a description, governance: an owner, semantic: a calculation)
function history(F, n) {
  const h = SM.newHistory(), ptr = {}, m = SM.fromFile(F, 'physical'), info = { user: 'bench', message: 'x' };
  const rec = () => { const fl = SM.flatten(SM.toFile(m)); for (const s of SM.STREAMS) { const e = SM.commit(h, s, ptr[s], fl[s], info); if (e) ptr[s] = e.chain; } };
  rec();
  for (let i = 1; i < n; i++) {
    const t = m.tables[i % m.tables.length]; t.description = 'v' + i;
    const c = m.tables[(i * 7) % m.tables.length].columns[1]; c.gov = { ...c.gov, owner: 'o' + i };
    if (m.metrics.length) m.metrics[i % m.metrics.length].calculation += ' + 0';
    rec();
  }
  return { h, ptr, m };
}

function bench(name, F) {
  const text = SM.stringify(F), o = JSON.parse(text);
  const m = SM.fromFile(o, 'physical'), out = {};
  const run = (k, fn) => { out[k] = +time(fn).toFixed(2); if (!asJson) console.log(`  ${k.padEnd(28)} ${String(out[k]).padStart(9)} ms`); };
  if (!asJson) console.log(`${name}: ${m.tables.length} tables, ${m.tables.reduce((a, t) => a + t.columns.length, 0)} columns, ${(o.relationships || []).length} relationships, ${m.concepts.length} concepts, ${m.entities.length} entities, ${m.governance.policies.length} policies, ${m.metrics.length} metrics`);
  run('fromFile', () => SM.fromFile(o, 'physical'));
  run('toFile', () => SM.toFile(m));
  run('stringify', () => SM.stringify(SM.toFile(m)));
  const flats = SM.flatten(SM.toFile(m));
  run('flatten', () => SM.flatten(SM.toFile(m)));
  const { h, ptr, m: hm } = history(F, 60);
  const flats2 = SM.flatten(SM.toFile(hm));
  run('diff (diffFlat)', () => SM.diffFlat(flats.modelling, flats2.modelling));
  run('verify', () => SM.verify(h, flats2));
  const hText = SM.logText(h);
  run('history replay (3 streams)', () => { const x = SM.parseLog(hText).history; for (const s of SM.STREAMS) SM.stateAt(x, ptr[s]); });
  run('history changesOf (all)', () => { const x = SM.parseLog(hText).history; for (const e of x.entries) SM.changesOf(x, e); });
  run('commit (one edit)', () => { const x = SM.parseLog(hText).history, p = { ...ptr }; SM.commit(x, 'modelling', p.modelling, flats2.modelling, { user: 'b', message: 'y' }, { force: true }); });
  run('log parse (JSON Lines)', () => SM.parseLog(hText));
  run('log verifyLog (hash chain)', () => SM.verifyLog(h));
  run('log locate (find the version)', () => SM.locate(h, flats2));
  run('sha256 of the model content', () => SM.stateHash(flats2.modelling));
  run('Layout.compute physical', () => L.compute(m, 'physical', 1.6));
  run('Layout.compute logical', () => L.compute(SA.view(m, 'logical') || m, 'logical', 1.6));
  run('Layout.compute semantic', () => L.compute(SA.view(m, 'semantic'), 'semantic', 1.6));
  const views = m.tables.filter((t) => t.kind === 'view'), base = m.tables.find((t) => t.kind !== 'view' && t.columns.some((c) => c.foreignKey));
  run('impact graph', () => IM.graph(m));
  run('impact analyse (table)', () => IM.analyse(m, [IM.key('table', base.id)], 'delete'));
  run('impact analyse (schema)', () => IM.analyse(m, [IM.key('schema', m.schemas[0].id)], 'delete'));
  run('impact unusedColumns', () => IM.unusedColumns(m, false));
  run('impact logical rollup', () => SA.impact(m, 'logical', m.entities.slice(0, 3).map((e) => 'entity:' + e.id), 'delete'));
  run('order analyse', () => OR.analyse(m));
  run('order logical rollup', () => SA.order(m, 'logical'));
  run('align+gov check (SA.check)', () => SA.check(m));
  run('gov check', () => GV.check(m));
  run('gov reach+effective (all)', () => { const memo = new Map(); for (const x of GV.objects(m)) { GV.reach(m, x.o, memo); GV.effective(m, x.o, memo); } });
  run('gov coverage (every policy)', () => { const memo = new Map(), objs = GV.objects(m, memo); for (const p of m.governance.policies) GV.coverage(m, p.name, objs, memo); });
  run('semantic view', () => GV.semView(m));
  run('metric refs (all)', () => { const X = SM.metricIndex && SM.metricIndex(m); m.metrics.forEach((x) => SM.metricRefs(m, x, X)); });
  run('nodesOf semantic', () => SM.nodesOf(m, 'semantic'));
  const chunks = E.buildChunks(o);
  run('embeddings chunking', () => E.buildChunks(o));
  run('search (lexical)', () => E.lexical(chunks, 'customer trade notional owner policy', 8));
  if (!asJson) console.log(`  (${views.length} views, ${chunks.length} chunks, ${h.entries.length} history entries)`);
  return out;
}

const res = {};
if (which === 'fpml' || which === 'all') res.fpml = bench('fpml', JSON.parse(fs.readFileSync(process.env.FPML || R + 'fpml.model.json', 'utf8')));
if (which === 'synth' || which === 'all') { const t0 = performance.now(), F = synth(); if (!asJson) console.log(`(synthetic model built in ${Math.round(performance.now() - t0)} ms)`); res.synth = bench('synthetic', F); }
if (asJson) console.log(JSON.stringify(res));
