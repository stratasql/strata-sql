// File-side helpers shared by the VS Code extension and the browser live view (Node only, no vscode API):
// settings, reading the version log, embeddings / positions paths, sample-data files and atomic writes.
const cp = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const gitMemo = new Map(); // `getSettings` runs on every reload of a model; two `git config` processes each time is wasteful, 30 s old is fine
const git = (key, cwd) => {
  const k = key + '\0' + cwd, hit = gitMemo.get(k);
  if (hit && Date.now() - hit.at < 30000) return hit.p;
  const p = new Promise((resolve) => cp.execFile('git', ['config', '--get', key], { cwd, timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim())));
  gitMemo.set(k, { at: Date.now(), p });
  return p;
};

const readText = (p) => fs.promises.readFile(p, 'utf8').catch(() => null);
let tmpN = 0;
async function writeAtomic(p, text) {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${tmpN++}.tmp`; // unique: two writes to one file must not share a temp file
  try { await fs.promises.writeFile(tmp, text); await fs.promises.rename(tmp, p); }
  catch (err) { await fs.promises.rm(tmp, { force: true }); throw err; }
}

// Where the files of a model are is decided by lib/project.js `resolve(modelFile)` (the one resolver); r = its result. Positions and embeddings sit beside the model.
const stem = (file) => file.replace(/\.model\.json$/, '');
const layoutFilePathOf = (file) => stem(file) + '.model.layout.json'; // canvas positions (not versioned, may be committed)
const embedPathOf = (file) => stem(file) + '.model.embeddings.json';
const dataFile = (r, f) => path.join(r.dataDir, path.basename(String(f))); // sample data: <part folder>/data/<catalog.schema.table>.csv

// the version log of a model: the standard place, else an older one (the webview tells the formats apart)
async function readHistory(r) {
  for (const p of [r.history, ...r.historyOld]) { const t = await readText(p); if (t != null) return t; }
  return null;
}

// Rebuildable local cache of history snapshots, <root>/.strata/cache/<model path>.snapshots.json (git-ignored). Losing it costs speed, nothing else.
const cachePathOf = (root, file) => path.join(root, '.strata', 'cache', path.relative(root, file).split(path.sep).join('__') + '.snapshots.json');
async function readCache(root, file) {
  try { const o = JSON.parse(await readText(cachePathOf(root, file))); return o && o.snapshots && typeof o.snapshots === 'object' ? o.snapshots : null; } catch { return null; }
}
// write the cache when the log has grown by a snapshot interval since it was written: returns the entry count it covers
async function writeCache(root, file, historyText, covered) {
  const SM = require('../media/model.js'), { history } = SM.parseLog(historyText);
  if (history.entries.length < covered + 20 && covered) return covered;
  if (history.entries.length < 20) return covered;
  await writeAtomic(cachePathOf(root, file), JSON.stringify({ strata: 'cache/1', snapshots: SM.snapshots(history) }) + '\n');
  return history.entries.length;
}

// Workspace-level settings live in <root>/.strata/settings.json
const settingsPath = (root) => path.join(root, '.strata', 'settings.json');

async function getSettings(root) {
  let s = {};
  try { s = JSON.parse((await readText(settingsPath(root))) || '{}'); } catch { /* corrupt file -> defaults */ }
  return {
    name: s.user?.name ?? (await git('user.name', root)),
    email: s.user?.email ?? (await git('user.email', root)),
    timezone: s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    system: s.system ?? os.hostname(),
    arrows: s.visualization?.arrows ?? 'squared',
    animate: s.visualization?.animate ?? false,
    theme: s.visualization?.theme ?? 'auto',
    themeVariant: s.visualization?.themeVariant ?? 'auto',
    versionMode: s.versioning?.mode ?? 'auto',
    recordLayout: s.versioning?.recordLayout ?? false,
    embed: Object.fromEntries(require('../media/embed.js').PROVIDER_IDS.map((id) => [id, s.embeddings?.providers?.[id] ?? true])), // which models get embeddings; all on by default
  };
}

const userOf = async (root) => { const st = await getSettings(root); return { name: st.name, email: st.email, system: st.system }; }; // who a version entry is recorded as

async function saveSettings(root, v) {
  const out = {
    user: { name: v.name, email: v.email }, timezone: v.timezone, system: v.system,
    visualization: { arrows: v.arrows, animate: !!v.animate, theme: v.theme || 'auto', themeVariant: v.themeVariant || 'auto' }, versioning: { mode: v.versionMode, recordLayout: !!v.recordLayout },
    embeddings: { providers: v.embed },
  };
  await writeAtomic(settingsPath(root), JSON.stringify(out, null, 2) + '\n');
}

// The last window layout per model (canvas view / scope / panels, navigator state), kept in <root>/.strata/layout.json:
// { strata: 'layout/1', models: { '<model path relative to root>': { canvas: {...}, nav: {...} } } }
const layoutPath = (root) => path.join(root, '.strata', 'layout.json');
const layoutKey = (root, file) => path.relative(root, file).split(path.sep).join('/');
async function readLayout(root, key) {
  try { return (JSON.parse((await readText(layoutPath(root))) || '{}').models || {})[key] || {}; } catch { return {}; } // corrupt file -> nothing saved
}
const layoutChains = new Map(); // one write at a time per file (read-modify-write)
function saveLayout(root, key, part, state) { // state null = forget that part
  const p = layoutPath(root);
  const run = (layoutChains.get(p) || Promise.resolve()).catch(() => {}).then(async () => {
    let d = {};
    try { d = JSON.parse((await readText(p)) || '{}'); } catch { d = {}; }
    d.strata = 'layout/1'; d.models = d.models || {};
    const one = d.models[key] || {};
    if (state == null) delete one[part]; else one[part] = state;
    if (Object.keys(one).length) d.models[key] = one; else delete d.models[key];
    await writeAtomic(p, JSON.stringify(d, null, 2) + '\n');
  });
  layoutChains.set(p, run);
  return run;
}

// header of an existing embeddings file (vectors are not sent to the webview)
async function readEmbedStatus(file) {
  try {
    const f = JSON.parse(await fs.promises.readFile(embedPathOf(file), 'utf8'));
    return { file: path.basename(embedPathOf(file)), generatedAt: f.generatedAt, version: f.version, contentHash: f.contentHash, providers: Object.fromEntries(Object.entries(f.providers || {}).map(([id, p]) => [id, { model: p.model, items: p.items.length }])) };
  } catch { return null; }
}
const embedProviderInfo = () => { const embed = require('../media/embed.js'); return embed.PROVIDER_IDS.map((id) => ({ id, label: embed.PROVIDERS[id].label, model: embed.PROVIDERS[id].model, needsKey: !!embed.PROVIDERS[id].env, local: !!embed.PROVIDERS[id].local, download: embed.PROVIDERS[id].download })); };
const envKey = (id) => { const embed = require('../media/embed.js'); return (embed.PROVIDERS[id].env || []).map((n) => process.env[n]).find(Boolean) || ''; };

// Generate (incrementally) and write the embeddings of one model file; `keyOf(id)` gives a provider's API key (sync or async). -> the per-provider results
async function embedModel(modelFile, modelText, settings, keyOf, hooks) {
  const embed = require('../media/embed.js'), enabled = embed.PROVIDER_IDS.filter((id) => settings.embed[id]);
  const keys = Object.fromEntries(await Promise.all(enabled.map(async (id) => [id, await keyOf(id)])));
  let previous = null;
  try { previous = JSON.parse(await fs.promises.readFile(embedPathOf(modelFile), 'utf8')); } catch { /* first run */ }
  const { file, results } = await embed.generate({ modelText, modelName: path.basename(modelFile), previous, enabled, keys, ...hooks });
  if (!file.chunks.length) throw new Error('the model has no project yet');
  if (Object.keys(file.providers).length) await writeAtomic(embedPathOf(modelFile), embed.serialize(file));
  return results;
}

// sample-data operations of one model; `getR` gives the resolved paths (asked each time), `post` delivers a message to the webview
function dataOps(getR, post) {
  const readAny = async (r, f) => { for (const d of [r.dataDir, ...r.dataOld]) { const t = await readText(path.join(d, path.basename(String(f)))); if (t != null) return t; } return null; };
  const ops = {
    read: async (m) => post({ type: 'data', file: m.file, text: await readAny(getR(), m.file) }),
    create: async (m) => {
      const p = dataFile(getR(), m.file);
      if ((await readText(p)) == null) await writeAtomic(p, m.text);
      await ops.read(m);
    },
    rename: async (m) => {
      const r = getR(), from = dataFile(r, m.file), to = dataFile(r, m.to);
      if (from !== to && (await readText(from)) != null && (await readText(to)) == null) await fs.promises.rename(from, to);
    },
  };
  return ops;
}

module.exports = { layoutKey, readLayout, saveLayout, git, readText, writeAtomic, stem, layoutFilePathOf, readHistory, readCache, writeCache, embedPathOf, dataFile, getSettings, saveSettings, userOf, readEmbedStatus, embedProviderInfo, envKey, embedModel, dataOps };
