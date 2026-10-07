// Self-check for the version history (ADR-0042): the append-only log, SHA-256 and the hash chain, hybrid clock and causal order, JSON Lines and
// Git's merge=union, forks and conflicts, edits after an undo, the snapshot cache, unknown keys and unresolved references, and the older
// layouts (media/legacy.js). Run: node tests/history.check.js
const assert = require('assert');
const fs = require('fs');
const cp = require('child_process'), os = require('os'), path = require('path');
const M = require('../media/model.js');
const LG = require('../media/legacy.js');
const SA = require('../media/align.js');
const ROOT = path.join(__dirname, '..'), SAMPLES = path.join(ROOT, 'sample_data_models');

const info = { user: 'ada', email: 'ada@x.io', system: 'laptop' }, bob = { user: 'bob', email: 'bob@x.io', system: 'desk' };
let clock = Date.UTC(2026, 8, 26, 8, 0);
const put = (h, stream, base, flat, message, who = info, at = (clock += 60000)) => M.commit(h, stream, base, M.clone(flat), { ...who, message, at });

// ---- SHA-256 is the real thing (sync, no dependency) ----
const crypto = require('crypto');
for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✓ 日本語', JSON.stringify({ a: 1 }).repeat(400)]) assert.strictEqual(M.sha256js(t), crypto.createHash('sha256').update(t).digest('hex'), 'sha256 of ' + t.length + ' chars');
for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'héllo wörld ✓ 日本語 😀', '\ud800 lone surrogate']) assert.strictEqual(M.sha256(t), M.sha256js(t), 'the native digest (Node) equals the pure-JS one the webview runs');

// ---- changesOf: added / updated / deleted with before and after ----
const h = M.newHistory();
const s1 = { project: { name: 'P' }, 'table:s.orders': { name: 'orders', schema: 's', columns: ['id', 'total'] }, 'column:s.orders.id': { name: 'id', type: 'INT', pk: true }, 'column:s.orders.total': { name: 'total', type: 'DECIMAL(18,2)' }, 'table:s.old': { name: 'old', schema: 's', columns: [] } };
const e1 = put(h, 'modelling', null, s1, 'init');
const s2 = M.clone(s1);
s2['column:s.orders.total'].type = 'DECIMAL(20,4)'; s2['column:s.orders.total'].description = 'Order total';
delete s2['table:s.old'];
s2['table:s.orders'].columns = ['id', 'total', 'note']; s2['column:s.orders.note'] = { name: 'note', type: 'STRING' };
const e2 = put(h, 'modelling', e1.chain, s2, 'change');
const c1 = M.changesOf(h, e1);
assert(c1.initial && c1.items.length === Object.keys(s1).length && c1.items.every((x) => x.op === '+'));
const c2 = M.changesOf(h, e2), by = (k) => c2.items.find((x) => x.k === k);
assert(!c2.initial);
assert.strictEqual(by('column:s.orders.note').op, '+'); assert.deepStrictEqual(by('column:s.orders.note').after, { name: 'note', type: 'STRING' });
assert.strictEqual(by('table:s.old').op, '−'); assert.strictEqual(by('table:s.old').before.name, 'old');
const t = by('column:s.orders.total');
assert.strictEqual(t.op, '~');
assert.deepStrictEqual(t.fields.map((f) => [f.f, f.before, f.after]).sort(), [['description', undefined, 'Order total'], ['type', 'DECIMAL(18,2)', 'DECIMAL(20,4)']]);
assert.deepStrictEqual(by('table:s.orders').fields.map((f) => [f.f, f.before, f.after]), [['columns', ['id', 'total'], ['id', 'total', 'note']]]);
assert.strictEqual(c2.items.length, 4);

// ---- the entry: delta-only in the file, a hash chain, a clock ----
assert.strictEqual(e1.kind, 'snapshot'); assert.strictEqual(e2.kind, 'delta'); assert.ok(!('seq' in e1), 'no global sequence number any more');
assert.strictEqual(e1.prev, ''); assert.strictEqual(e2.prev, e1.chain, 'prev names the entry it was made from');
assert.strictEqual(e2.hash, M.stateHash(s2), 'hash = SHA-256 of the stream state after the entry');
assert.strictEqual(e2.chain, M.sha256(e2.prev + M.canon((({ chain, ...r }) => r)(e2))), 'chain = SHA-256(prev + canonical(entry without chain))');
assert.ok(/^\d{13}\.\d{4}\.[0-9a-f]{6}$/.test(e2.hlc) && e2.hlc > e1.hlc, 'hybrid logical clock: wall ms . counter . node, sorts as a string');
assert.strictEqual(e2.ts, new Date(Number(e2.hlc.slice(0, 13))).toISOString());
assert.deepStrictEqual(M.verify(h, { modelling: s2, governance: {}, semantic: {} }), []);
assert.deepStrictEqual(M.locate(h, { modelling: s1, governance: {}, semantic: {} }).pointers, { modelling: e1.chain }, 'the version is found by content hash, not by a pointer in the model');

// ---- the chain detects every kind of edit ----
const text = M.logText(h), edit = (fn) => { const c = M.parseLog(text).history; fn(c.entries); return c; };
assert.deepStrictEqual(M.verifyLog(M.parseLog(text).history), [], 'untouched log');
for (const [what, fn] of [['user', (es) => { es[1].user = 'mallory'; }], ['message', (es) => { es[1].message = 'nothing to see'; }], ['ts', (es) => { es[1].ts = '2020-01-01T00:00:00.000Z'; }], ['hlc', (es) => { es[1].hlc = '0000000000001.0000.aaaaaa'; }],
  ['patch', (es) => { es[1].patch.set['column:s.orders.total'].type = 'TEXT'; }], ['hash', (es) => { es[1].hash = 'f'.repeat(64); }], ['first entry', (es) => { es[0].snapshot.project.name = 'Evil'; }]]) {
  const c = edit(fn), problems = M.verify(c, { modelling: s2, governance: {}, semantic: {} });
  assert.ok(problems.some((p) => /was changed after it was recorded/.test(p)), 'an edited ' + what + ' is detected: ' + problems.join(' | '));
}
assert.ok(M.verifyLog(edit((es) => es.splice(0, 1))).some((p) => /not in the log/.test(p)), 'a removed entry: its successor has no parent');
assert.ok(M.verifyLog(edit((es) => { es[1].extra = 1; })).length, 'an added key is an edit too');

// ---- three streams (ADR-0039) ----
const H3 = M.newHistory(), ptr = {}, base = { modelling: { project: { name: 'P' } }, governance: {}, semantic: {} };
const rec = (st, flat, msg) => { const e = put(H3, st, ptr[st], flat, msg); if (e) ptr[st] = e.chain; return e; };
rec('modelling', base.modelling, 'init');
for (let i = 1; i <= 42; i++) { base.semantic['metric:M' + i] = { name: 'M' + i, calculation: 't.c * ' + i }; rec('semantic', base.semantic, 'metric ' + i); if (i % 10 === 0) { base.governance['assign:metric:M' + i] = { tags: ['certified'] }; rec('governance', base.governance, 'certify ' + i); } }
const sem = M.entriesOf(H3, 'semantic');
assert.deepStrictEqual([sem[0].id, sem[41].id], ['s1', 's42'], 'semantic ids');
assert.deepStrictEqual(sem.filter((e) => e.kind === 'snapshot').map((e) => e.id), ['s1'], 'only the first entry of a stream is a full state: every later one is a delta');
assert.deepStrictEqual(M.entriesOf(H3, 'governance').map((e) => e.id), ['g1', 'g2', 'g3', 'g4']);
assert.deepStrictEqual(M.stateAt(H3, sem[20].chain), (() => { const x = {}; for (let i = 1; i <= 21; i++) x['metric:M' + i] = { name: 'M' + i, calculation: 't.c * ' + i }; return x; })(), 'state rebuilt through deltas');
assert.deepStrictEqual(M.verify(H3, base), [], 'the three streams verify');
assert.ok(M.verify(H3, { ...base, semantic: { ...base.semantic, 'metric:M1': { name: 'M1', calculation: 'x' } } }).some((p) => /^semantic: the content matches none/.test(p)), 'drift is reported per stream');
assert.deepStrictEqual(M.locate(H3, base).pointers, ptr);
// toolbar undo / redo across streams: the newest change (by clock) first
const back = { ...ptr, semantic: sem[40].chain };
assert.strictEqual(M.undoTarget(H3, ptr).stream, 'semantic', 'the newest change (by clock) is metric M42');
assert.strictEqual(M.undoTarget(H3, { ...ptr, semantic: sem[39].chain }).stream, 'governance', 'with the metrics back at M40, the governance change made after it (certify 40) comes next');
assert.strictEqual(M.undoTarget(H3, { ...ptr, governance: M.entriesOf(H3, 'governance')[0].chain }).stream, 'semantic');
assert.strictEqual(M.redoTarget(H3, back).key, sem[41].chain);
// native Cmd/Ctrl+Z: the text goes back to an older content, which hashes to an older version; no pointer is stored anywhere
const older = M.stateAt(H3, sem[10].chain);
assert.strictEqual(M.locate(H3, { ...base, semantic: older }).pointers.semantic, sem[10].chain, 'older content = older version');
assert.strictEqual(M.entry(H3, M.undoTarget(H3, { semantic: sem[10].chain }).key).id, 's10');
assert.strictEqual(M.entry(H3, M.redoTarget(H3, { semantic: sem[10].chain }).key).id, 's12');

// ---- undo, then edit: the log only grows (ADR-0042), the undone versions are left behind ----
const U = M.newHistory(), ua = put(U, 'modelling', null, { a: {} }, 'a'), ub = put(U, 'modelling', ua.chain, { a: {}, b: {} }, 'b'), uc = put(U, 'modelling', ub.chain, { a: {}, b: {}, c: {} }, 'c');
const before = M.logText(U), ud = put(U, 'modelling', ub.chain, { a: {}, b: {}, d: {} }, 'd, after undoing c');
assert.strictEqual(ud.prev, ub.chain); assert.deepStrictEqual(ud.abandon, [uc.chain], 'the new entry says which head it left behind');
assert.ok(M.logText(U).startsWith(before), 'earlier lines are untouched: the new line is appended');
assert.strictEqual(M.entriesOf(U, 'modelling').length, 4, 'c is still in the file');
assert.deepStrictEqual(M.headsOf(U, 'modelling').map((e) => e.id), ['m4'], 'one live head: c is off the current history');
assert.ok(!M.liveKeys(U, 'modelling').has(uc.chain) && M.liveKeys(U, 'modelling').has(ud.chain));
assert.deepStrictEqual(M.forks(U), [], 'an undo is not a fork');
assert.strictEqual(M.redoTarget(U, { modelling: ub.chain }).key, ud.chain, 'redo from b goes to d, not to the undone c');
assert.strictEqual(M.redoTarget(U, { modelling: ud.chain }), null);
assert.strictEqual(M.undoTarget(U, { modelling: ud.chain }).key, ub.chain);
assert.strictEqual(M.locate(U, { modelling: { a: {}, b: {}, c: {} }, governance: {}, semantic: {} }).pointers.modelling, uc.chain, 'content of an undone version still finds it (it is recorded)');
assert.deepStrictEqual(M.verifyLog(U), []);
// undo, without editing, then redo: nothing is written at all
assert.strictEqual(M.commit(U, 'modelling', ud.chain, { a: {}, b: {}, d: {} }, { ...info, message: 'same' }), null);
// between(): the layout payloads crossed by a toolbar undo / redo
assert.deepStrictEqual(M.between(U, uc.chain, ub.chain), { back: true, list: [uc] }); assert.deepStrictEqual(M.between(U, ub.chain, uc.chain), { back: false, list: [uc] });

// ---- hybrid clock and causal order ----
const K = M.newHistory(), k1 = M.commit(K, 'modelling', null, { a: {} }, { ...info, message: '1', at: 5000 }), k2 = M.commit(K, 'modelling', k1.chain, { a: {}, b: {} }, { ...info, message: '2', at: 5000 }), k3 = M.commit(K, 'modelling', k2.chain, { a: {}, b: {}, c: {} }, { ...info, message: '3', at: 4000 });
assert.deepStrictEqual([k1, k2, k3].map((e) => e.hlc.slice(0, 18)), ['0000000005000.0000', '0000000005000.0001', '0000000005000.0002'], 'equal or older wall times: the counter separates them, time never goes back');
assert.ok(k1.hlc < k2.hlc && k2.hlc < k3.hlc); assert.strictEqual(k3.ts, new Date(5000).toISOString(), 'ts never goes before the newest entry');
assert.notStrictEqual(M.commit(K, 'governance', null, { 'tag:x': {} }, { ...bob, message: 'g', at: 4000 }).hlc.slice(-6), k1.hlc.slice(-6), 'the node part tells writers apart');

// ---- flatten routes metrics to semantic and accepted warnings by kind; unflatten rebuilds one file ----
const F3 = { strata: 2, project: { name: 'P', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' }, schemas: [{ name: 's' }], tables: [{ name: 't', schema: 's', columns: [{ name: 'c', type: 'INT' }] }],
  semantic: { metrics: [{ name: 'Sum C', calculation: 't.c', aggregation: 'sum', tags: ['certified'], governance: { owner: 'BI' } }] }, alignment: { acknowledged: ['gov-owner:t', 'metric-ref:Sum C:x', 'unmapped:s.t'] } };
const fl = M.flatten(F3);
assert.deepStrictEqual(Object.keys(fl.semantic), ['metric:Sum C', 'acknowledged']);
assert.deepStrictEqual(fl.governance['assign:metric:Sum C'], { tags: ['certified'], governance: { owner: 'BI' } }, 'metric tags and owners are governance');
assert.deepStrictEqual(M.canon(M.unflatten(fl.modelling, fl.governance, fl.semantic)), M.canon(F3), 'unflatten(flatten) is the file');
const toF = M.toFile(M.fromFile(F3, 'physical'));
assert.ok(!('layout' in toF) && !('version' in toF), 'the model file has neither layout nor version pointers');

// ---- unknown keys and unresolved references survive (ADR-0042) ----
const X = { strata: 2, project: { name: 'P', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table', domain_lead: 'ada' }, 'x-exposes': [{ name: 'dashboard', uses: ['s.orders'] }],
  governance: { tags: [{ name: 'pii', region: 'eu' }], policies: [{ name: 'GDPR', legal_ref: 'Art. 6' }], review_cycle: 'yearly' },
  schemas: [{ name: 's', owner_team: 'sales' }],
  tables: [{ name: 'orders', schema: 's', partition_by: 'day', columns: [{ name: 'id', type: 'INT', pk: true, check: 'id > 0' }, { name: 'customer_id', type: 'INT', masking: { style: 'hash' } }] }, { name: 'customers', schema: 's', columns: [{ name: 'id', type: 'INT', pk: true }] }],
  relationships: [{ parent: 'other_team.sales.orders.id', child: 's.orders.customer_id', cardinality: '1..M', note: 'lives in the sales repo' }, { parent: 's.customers.id', child: 's.orders.customer_id', cardinality: '1..M', fk_name: 'fk_cust' }],
  semantic: { metrics: [{ name: 'Orders', calculation: 'orders.id', aggregation: 'count', unit: 'orders' }], catalog_version: 3 } };
const mx = M.fromFile(X, 'physical'), Fx = M.toFile(mx);
assert.strictEqual(Fx.tables[1].columns[0].check, 'id > 0', 'a column check key is kept');
assert.strictEqual(Fx.tables[1].partition_by, 'day'); assert.deepStrictEqual(Fx.tables[1].columns[1].masking, { style: 'hash' });
assert.strictEqual(Fx.project.domain_lead, 'ada'); assert.strictEqual(Fx.schemas[0].owner_team, 'sales'); assert.strictEqual(Fx.governance.review_cycle, 'yearly'); assert.strictEqual(Fx.governance.tags[0].region, 'eu'); assert.strictEqual(Fx.governance.policies[0].legal_ref, 'Art. 6');
assert.deepStrictEqual(Fx['x-exposes'], X['x-exposes']); assert.strictEqual(Fx.semantic.catalog_version, 3); assert.strictEqual(Fx.semantic.metrics[0].unit, 'orders');
assert.strictEqual(Fx.relationships.length, 2); assert.ok(Fx.relationships.some((r) => r.parent === 'other_team.sales.orders.id' && r.note === 'lives in the sales repo'), 'a relationship to another team\'s table is kept as written');
assert.ok(Fx.relationships.some((r) => r.fk_name === 'fk_cust'));
assert.strictEqual(M.stringify(M.toFile(M.fromFile(Fx, 'physical'))), M.stringify(Fx), 'round trip is stable');
const fx = M.flatten(Fx);
assert.deepStrictEqual(fx.modelling['column:s.orders.id'], { name: 'id', type: 'INT', pk: true, check: 'id > 0' }, 'unknown keys are part of the versioned entity: history, diff and drift see them');
assert.ok(fx.modelling['extra:x-exposes'] && fx.modelling['extra:semantic'] && fx.modelling['extra:governance'] && fx.modelling['rel:other_team.sales.orders.id>s.orders.customer_id'], 'top-level, section and relationship extras are entities too');
assert.strictEqual(M.canon(M.unflatten(fx.modelling, fx.governance, fx.semantic)), M.canon(Fx), 'unflatten(flatten) keeps them');
const XH = M.newHistory(); for (const s of M.STREAMS) M.commit(XH, s, null, fx[s], { ...info, message: 'x' });
assert.deepStrictEqual(M.verify(XH, fx), []);
const fx2 = M.clone(Fx); fx2.tables[1].columns[0].check = 'id >= 0'; assert.ok(M.verify(XH, M.flatten(fx2)).length, 'editing an unknown key is drift like any other edit');
const warn = SA.check(mx).all.filter((w) => w.kind === 'broken-ref');
assert.strictEqual(warn.length, 1); assert.ok(/other_team\.sales\.orders\.id.*not in this model/.test(warn[0].text)); assert.strictEqual(warn[0].go.kind, 'table', 'it points at the card that exists');
// validate (the skill script) reports the same thing from the file
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-hist-')), vf = path.join(scratch, 'x.model.json'); fs.writeFileSync(vf, M.stringify(Fx) + '\n');
const vr = cp.spawnSync('node', [path.join(ROOT, '.claude/skills/strata-model/scripts/strata.js'), 'validate', vf], { encoding: 'utf8' });
assert.ok(vr.status === 1 && /other_team\.sales\.orders\.id.*unknown reference/.test(vr.stdout), 'validate reports it: ' + vr.stdout.slice(0, 200));

// ---- JSON Lines: one entry per line, round trip ----
const lines = text.trim().split('\n');
assert.strictEqual(lines.length, 2); assert.ok(lines.every((l) => JSON.parse(l).chain), 'every line is an entry of its own');
assert.ok(lines[0].startsWith('{"id":"m1","stream":"modelling","ts":') && lines[0].endsWith('"}') && !/\n/.test(lines[0]));
assert.strictEqual(M.logText(M.parseLog(text).history), text, 'text -> log -> text is identical');
assert.ok(M.parseLog('{ not json\n').error && !M.parseLog('{ not json\n').history.entries.length, 'unreadable log: an error, never a silent new history');
assert.ok(M.parseLog('{"id":"m1"}\n').error, 'a line that is not an entry is an error');
assert.deepStrictEqual(M.parseLog('').history.entries, [], 'no log yet: empty');
assert.strictEqual(M.parseLog(lines[0] + '\n' + lines[0] + '\n' + lines[1] + '\n').history.entries.length, 2, 'a union merge may repeat a line: it counts once');
assert.strictEqual(M.parseLog('<<<<<<< HEAD\n' + lines[0] + '\n=======\n' + lines[1] + '\n>>>>>>> x\n').history.entries.length, 2, 'stray conflict markers are skipped: every line is an entry');
assert.ok(!M.isLegacyLog(text) && M.isLegacyLog('{\n  "strata": "history/1",\n  "entries": []\n}\n') && M.isLegacyLog('<<<<<<< HEAD\n{\n'), 'the older single-document log is told apart by its first line');

// ---- a real Git merge with merge=union (ADR-0042) ----
const seed = M.newHistory(); put(seed, 'modelling', null, { project: { name: 'P' }, 'table:s.t': { name: 't', columns: [] } }, 'init', info, Date.UTC(2026, 8, 26, 9));
const seedKey = seed.entries[0].chain, ss = M.stateAt(seed, seedKey);
const branch = (who, entries) => { const b = M.parseLog(M.logText(seed)).history; let base = seedKey, st = ss; for (const [k, v, msg, at] of entries) { st = { ...st, [k]: v }; base = put(b, 'modelling', base, st, msg, who, Date.UTC(2026, 8, 26, 10, at)).chain; } return b; };
const A = branch(info, [['table:s.a', { name: 'a' }, 'A adds a', 1], ['table:s.t', { name: 't', columns: ['x'] }, 'A edits t', 5]]), B = branch(bob, [['table:s.b', { name: 'b' }, 'B adds b', 2], ['table:s.t', { name: 't', columns: ['y'] }, 'B edits t', 6]]);
let gitOk = true;
const git = (cwd, ...a) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.io', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
let merged;
try {
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'history/*.jsonl merge=union\n'); // the wizard's line: one log per part in the top-level history/ folder
  const hp = path.join(repo, 'history', 'p.history.jsonl'); fs.mkdirSync(path.dirname(hp));
  fs.writeFileSync(hp, M.logText(seed)); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'switch', '-q', '-c', 'a'); fs.writeFileSync(hp, M.logText(A)); git(repo, 'commit', '-qam', 'A');
  git(repo, 'switch', '-q', 'main'); git(repo, 'switch', '-q', '-c', 'b'); fs.writeFileSync(hp, M.logText(B)); git(repo, 'commit', '-qam', 'B');
  git(repo, 'merge', '-q', '--no-edit', 'a'); // no conflict: Git keeps both sides' lines
  merged = fs.readFileSync(hp, 'utf8');
  assert.ok(!/^(<{7}|={7}|>{7})/m.test(merged), 'merge=union writes no conflict markers');
  assert.strictEqual(merged.trim().split('\n').length, 5, 'both branches\' lines are all there');
} catch (err) { if (err.code === 'ENOENT' || /not a git|command not found/.test(String(err.stderr))) { gitOk = false; console.log('  (git not available: real merge check skipped)'); merged = M.logText({ entries: [...A.entries, ...B.entries.slice(1)] }); } else throw err; }
const mh = M.parseLog(merged).history;
assert.deepStrictEqual(M.verifyLog(mh), [], 'every entry is intact after the merge');
assert.strictEqual(M.entriesOf(mh, 'modelling').length, 5); assert.deepStrictEqual(M.entriesOf(mh, 'modelling').map((e) => e.id).sort(), ['m1', 'm2', 'm2', 'm3', 'm3'], 'ids are labels: two branches each made an m2 and an m3');
assert.strictEqual(M.headsOf(mh, 'modelling').length, 2, 'two live heads: the branches');
const modelAB = { ...ss, 'table:s.a': { name: 'a' }, 'table:s.b': { name: 'b' }, 'table:s.t': { name: 't', columns: ['y'] } }; // what a text merge could give: A's table, B's table, and B's edit of t
const fk = M.forks(mh, { modelling: modelAB, governance: {}, semantic: {} });
assert.strictEqual(fk.length, 1); assert.deepStrictEqual(fk[0].conflicts.map((c) => c.key), ['table:s.t'], 'both changed t differently: reported. a and b were changed on one side each: no conflict');
assert.deepStrictEqual(fk[0].conflicts[0].sides.map((s) => [s.entry.user, s.has]).sort(), [['ada', false], ['bob', true]], 'and which side the model on screen has');
assert.deepStrictEqual(M.forks(mh, null)[0].conflicts[0].sides.map((s) => s.has), [null, null]);
assert.ok(M.locate(mh, { modelling: modelAB, governance: {}, semantic: {} }).problems.length, 'a model that is neither branch is drift until the merge is recorded');
assert.deepStrictEqual(M.locate(mh, { modelling: M.stateAt(mh, M.headsOf(mh, 'modelling')[1].chain), governance: {}, semantic: {} }).problems, [], 'a model equal to one branch matches it');
// recording the merge: one entry with the model's content joins the branches
const before2 = M.logText(mh), me = M.commit(mh, 'modelling', undefined, M.clone(modelAB), { ...info, message: 'Merged version histories', at: Date.UTC(2026, 8, 26, 12) });
assert.strictEqual(me.merge.length, 1); assert.strictEqual(M.headsOf(mh, 'modelling').length, 1, 'one head again'); assert.deepStrictEqual(M.forks(mh), []); assert.ok(M.logText(mh).startsWith(before2), 'only appended');
assert.deepStrictEqual(M.verify(mh, { modelling: modelAB, governance: {}, semantic: {} }), []); assert.deepStrictEqual(M.entriesOf(mh, 'modelling').filter((e) => e.abandon), [], 'a merge is not an undo');
// any edit made while the log is forked also joins the branches
const mh2 = M.parseLog(merged).history, ed = M.commit(mh2, 'modelling', M.headsOf(mh2, 'modelling')[0].chain, { ...M.stateAt(mh2, M.headsOf(mh2, 'modelling')[0].chain), 'table:s.c': { name: 'c' } }, { ...info, message: 'edit', at: Date.UTC(2026, 8, 26, 12) });
assert.ok(ed.merge && M.headsOf(mh2, 'modelling').length === 1);
// the other order of the lines gives the same conclusions
const mh3 = M.parseLog(M.logText({ entries: [...B.entries, ...A.entries.slice(1)] })).history;
assert.deepStrictEqual(M.forks(mh3)[0].conflicts.map((c) => c.key), ['table:s.t']);
// nothing changed on both sides: no conflicts (but still two branches to join)
const A2 = branch(info, [['table:s.a', { name: 'a' }, 'A adds a', 1]]), B2 = branch(bob, [['table:s.b', { name: 'b' }, 'B adds b', 2]]), mh4 = { entries: [...A2.entries, ...B2.entries.slice(1)] };
assert.deepStrictEqual(M.forks(mh4)[0].conflicts, [], 'different objects: nothing to decide'); assert.strictEqual(M.forks(mh4).length, 1);
// the same value written on both sides is not a conflict
const A3 = branch(info, [['table:s.t', { name: 't', columns: ['same'] }, 'A edits t', 1]]), B3 = branch(bob, [['table:s.t', { name: 't', columns: ['same'] }, 'B edits t', 2]]);
assert.deepStrictEqual(M.forks({ entries: [...A3.entries, ...B3.entries.slice(1)] })[0].conflicts, []);
// a linear log is never a fork
assert.deepStrictEqual(M.forks(h), []); assert.deepStrictEqual(M.forks(H3), []);

// ---- delta-only file, and the snapshot cache is only ever a cache ----
const big = M.parseLog(M.logText(H3)).history;
assert.strictEqual(M.logText(big).trim().split('\n').filter((l) => JSON.parse(l).kind === 'snapshot').length, 3, 'one full state per stream (three streams), everything else is a delta');
const snaps = M.snapshots(big);
assert.ok(Object.keys(snaps).length >= 3, 'the cache holds the heads and every 20th entry');
const fresh1 = M.parseLog(M.logText(H3)).history; M.useSnapshots(fresh1, snaps);
const head = M.headsOf(fresh1, 'semantic')[0].chain;
assert.deepStrictEqual(M.stateAt(fresh1, head), M.stateAt(M.parseLog(M.logText(H3)).history, head), 'with the cache: the same state');
const damaged = M.clone(snaps); damaged[head]['metric:M1'] = { name: 'tampered' };
const fresh2 = M.parseLog(M.logText(H3)).history; M.useSnapshots(fresh2, damaged);
assert.deepStrictEqual(M.stateAt(fresh2, head), base.semantic, 'a damaged cache entry is ignored (its hash no longer holds): loading and verifying still work');
const fresh3 = M.parseLog(M.logText(H3)).history; M.useSnapshots(fresh3, 'nonsense'); M.useSnapshots(fresh3, null);
assert.deepStrictEqual(M.verify(fresh3, base), [], 'no cache, or rubbish instead of one: nothing breaks');
// a long chain rebuilds without recursion trouble
const long = M.newHistory(); let st = {}, bk = null; for (let i = 0; i < 1500; i++) { st = { ...st, ['k' + (i % 50)]: { n: i } }; bk = M.commit(long, 'modelling', bk, st, { ...info, message: 'x', at: 1e12 + i }).chain; }
assert.strictEqual(M.stateAt(M.parseLog(M.logText(long)).history, bk)['k49'].n, 1499); assert.deepStrictEqual(M.verifyLog(long), []);

// ---- older layouts (ADR-0042): loaded unchanged, converted deterministically ----
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures/legacy', f), 'utf8');
const oldModel = JSON.parse(fixture('example.model.json')), oldText = fixture('example.model.version.json');
assert.ok(oldModel.version && oldModel.layout, 'the fixture is an old file: version pointers and layout inside the model');
const oldLog = LG.parseHistory(oldText).history, mOld = M.fromFile(oldModel, 'physical');
assert.ok(Object.keys(mOld.tables[0].pos).length, 'an inline layout still loads');
const flOld = M.flatten(M.toFile(mOld)), truth = Object.fromEntries(M.STREAMS.filter((s) => oldModel.version[s]).map((s) => [s, { id: oldModel.version[s], flat: flOld[s] }]));
const cv = LG.load(oldText, truth), cvAgain = LG.load(oldText, truth);
assert.ok(!cv.error && cv.history.entries.length === oldLog.entries.length);
assert.strictEqual(M.logText(cv.history), M.logText(cvAgain.history), 'the conversion is deterministic');
for (const o of oldLog.entries) {
  const n = cv.history.entries.find((x) => x.id === o.id && x.stream === o.stream);
  assert.ok(n, o.id + ' is there'); assert.deepStrictEqual([n.ts, n.user, n.email, n.system, n.message, n.layout], [o.ts, o.user, o.email, o.system, o.message, o.layout], o.id + ': time, user and message kept, not re-stamped');
  if (M.hash(M.canon(LG.stateAt(oldLog, o.id))) === o.hash) assert.deepStrictEqual(M.stateAt(cv.history, n.chain), LG.stateAt(oldLog, o.id), o.id + ': the content is what the old log said');
  assert.notStrictEqual(n.hash, o.hash, 'hashes are recomputed (SHA-256)'); assert.strictEqual(n.hash.length, 64);
}
assert.deepStrictEqual(M.verifyLog(cv.history), []); assert.deepStrictEqual(M.verify(cv.history, flOld), [], 'the model and its converted log agree: no drift');
const newFile = M.toFile(mOld), pos = M.layoutOf(mOld, 'physical');
assert.ok(!('layout' in newFile) && !('version' in newFile), 'a converted model has no layout and no version keys');
assert.strictEqual(M.canon(pos), M.canon(oldModel.layout), 'the positions are the old inline layout, unchanged');
assert.strictEqual(M.canon(M.layoutOf(M.fromFile(newFile, 'physical', null, pos), 'physical')), M.canon(oldModel.layout), 'and they come back from the layout file');
assert.strictEqual(M.canon(M.layoutRead(M.stringify(M.layoutFile(mOld, 'physical')))), M.canon(pos));
assert.ok(cv.history.entries.every((e, i, all) => !i || M.entriesOf(cv.history, e.stream).indexOf(e) === 0 || e.hlc >= all[i - 1].hlc || e.stream !== all[i - 1].stream), 'the clock follows the old order');
// without the model's own content an inconsistent old entry stays as the old patches gave it (the model then shows drift, and can record itself)
assert.ok(M.verify(LG.load(oldText).history, flOld).length, 'no truth given: an old log whose patches did not match its hashes is drift, as before it was a mismatch of pointers');
// an old log merged by Git (conflict markers, both sides): replayed as before (ADR-0040), then converted
const lgrow = (log, stream, add, at, msg) => { const st = M.clone(LG.stateAt(log, LG.entriesOf(log, stream).at(-1).id)); Object.assign(st, add); const e = LG.commit(log, stream, LG.entriesOf(log, stream).at(-1).id, st, { ...info, message: msg }); e.ts = new Date(Date.UTC(2026, 8, 26, at)).toISOString(); return e; };
const lseed = LG.newHistory(); LG.commit(lseed, 'modelling', null, { project: { name: 'P' } }, { ...info, message: 'init' }); lseed.entries.forEach((e) => { e.ts = new Date(Date.UTC(2026, 8, 26, 8)).toISOString(); });
const LA = M.clone(lseed), LB = M.clone(lseed); lgrow(LA, 'modelling', { 'table:s.a1': { name: 'a1' } }, 10, 'A adds a1'); lgrow(LB, 'modelling', { 'table:s.b1': { name: 'b1' } }, 11, 'B adds b1');
const lf = (n, o) => { const p = path.join(scratch, n); fs.writeFileSync(p, M.stringify(o) + '\n'); return p; };
const lm = cp.spawnSync('git', ['merge-file', '-p', lf('lo.json', LB), lf('lb.json', lseed), lf('lt.json', LA)], { encoding: 'utf8' });
if (lm.error) console.log('  (git not available: old conflict-marker check skipped)');
else {
  assert.ok(/^<{7}/m.test(lm.stdout), 'git leaves conflict markers in an old log');
  const lc = LG.load(lm.stdout);
  assert.ok(!lc.error && lc.replayed && lc.replayed.changed, 'replayed');
  assert.deepStrictEqual(M.entriesOf(lc.history, 'modelling').map((e) => e.message), ['init', 'A adds a1', 'B adds b1']); assert.deepStrictEqual(M.entriesOf(lc.history, 'modelling').filter((e) => e.was).map((e) => [e.id, e.was]), [['m3', 'm2']], 'the old number is kept as `was`');
  assert.deepStrictEqual(M.stateAt(lc.history, M.headsOf(lc.history, 'modelling')[0].chain), { project: { name: 'P' }, 'table:s.a1': { name: 'a1' }, 'table:s.b1': { name: 'b1' } }, 'both sides are in the result'); assert.deepStrictEqual(M.verifyLog(lc.history), []);
}
assert.ok(LG.load('{ not json').error, 'an unreadable old log is an error, not a new history');

// ---- the shipped samples: current layout, intact chain, no drift ----
for (const f of ['example', 'northwind', 'fpml', 'star']) {
  const F = JSON.parse(fs.readFileSync(path.join(SAMPLES, f + '.model.json'), 'utf8')), lg = M.parseLog(fs.readFileSync(path.join(SAMPLES, f + '.model.history.jsonl'), 'utf8')).history;
  assert.ok(!('layout' in F) && !('version' in F), f + ': model file without layout and version'); assert.deepStrictEqual(M.verify(lg, M.flatten(F)), [], f + ': verifies');
  assert.strictEqual(M.headsOf(lg, 'modelling').length, 1, f + ': one head'); assert.deepStrictEqual(M.forks(lg), []);
  assert.ok(lg.entries.every((e, i) => !i || e.hlc >= lg.entries[i - 1].hlc), f + ': the shipped log is in clock order');
  const lines2 = fs.readFileSync(path.join(SAMPLES, f + '.model.history.jsonl'), 'utf8'); assert.strictEqual(M.logText(lg), lines2, f + ': the log is written exactly as the engine writes it');
  for (const s of M.STREAMS) M.entriesOf(lg, s).forEach((e, i) => assert.strictEqual(e.kind, i ? 'delta' : 'snapshot', f + ': delta-only apart from the first entry'));
  for (const e of lg.entries) assert.strictEqual(e.hash, M.stateHash(M.stateAt(lg, e.chain)), f + ' ' + e.id + ': every entry\'s hash is the hash of its state');
}

// change 30: an M..M whose bridge table is not in this file (another part of a split project) keeps its `via`, and a bridge created later wins
{
  const F = { strata: 2, project: { name: 'p' }, schemas: [{ name: 's' }], tables: [
    { name: 'a', schema: 's', columns: [{ name: 'id', type: 'INTEGER', pk: true }] }, { name: 'b', schema: 's', columns: [{ name: 'id', type: 'INTEGER', pk: true }] }],
    relationships: [{ parent: 's.a', child: 's.b', cardinality: 'M..M', via: 's.a_b' }] };
  const m = M.fromFile(F), back = M.toFile(m);
  assert.deepStrictEqual(back.relationships, F.relationships, 'an unresolved via survives fromFile -> toFile');
  assert.strictEqual(M.stateHash(M.flatten(M.toFile(M.fromFile(back))).modelling), M.stateHash(M.flatten(back).modelling), 'and the content hash does not change (no false "history does not match")');
  const t = { id: 'x1', name: 'a_b', kind: 'table', schemaId: m.schemas[0].id, columns: [], pos: {} }; m.tables.push(t);
  m.relations[0].viaId = t.id; delete m.relations[0].ext.via; // what createBridge does
  assert.strictEqual(M.toFile(m).relationships[0].via, 's.a_b', 'a bridge that exists is written from the link');
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log('history check ok' + (gitOk ? '' : ' (without git)'));
