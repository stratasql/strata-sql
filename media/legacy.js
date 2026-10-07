// Older file layouts (ADR-0042): a version log in one JSON document (`<name>.model.version.json`, format history/1) with per-stream ids
// (m1, g1, s1), cyrb53 hashes and pointers inside the model file (`version`), and canvas positions inside the model file (`layout`). They keep
// loading: this file reads them and converts them, deterministically and without losing an id, time, user or message, to the current log
// (media/model.js). Nothing is written until the user saves. Loaded by the webview and by node tests.
(function (g) {
  'use strict';
  const SM = g.StrataModel || (typeof require === 'function' ? require('./model.js') : null);
  const { STREAMS, PREFIX, canon, hash, clone, diffFlat } = SM;
  const SNAP_EVERY = 20;

  const newHistory = () => ({ strata: 'history/1', entries: [] });
  const entriesOf = (h, s) => h.entries.filter((e) => e.stream === s);
  const caches = new WeakMap();
  const cacheOf = (h) => { if (!caches.has(h)) caches.set(h, new Map()); return caches.get(h); };

  function stateAt(h, id) {
    const c = cacheOf(h);
    if (c.has(id)) return c.get(id);
    const e = h.entries.find((x) => x.id === id);
    if (!e) return null;
    let st;
    if (e.kind === 'snapshot') st = clone(e.snapshot);
    else {
      const list = entriesOf(h, e.stream), i = list.indexOf(e);
      st = { ...stateAt(h, list[i - 1].id) };
      for (const k of e.patch.del) delete st[k];
      Object.assign(st, clone(e.patch.set));
    }
    c.set(id, st);
    return st;
  }

  const chainLength = (h, id) => {
    const list = entriesOf(h, h.entries.find((e) => e.id === id).stream);
    let i = list.findIndex((e) => e.id === id), n = 0;
    while (i >= 0 && list[i].kind !== 'snapshot') { n++; i--; }
    return n;
  };
  const tsOf = (e) => Date.parse(e.ts) || 0;
  const newTs = (h) => { const now = new Date().toISOString(), last = h.entries.reduce((a, e) => (tsOf(e) > tsOf(a) ? e : a), { ts: '' }); return tsOf(last) > Date.parse(now) ? last.ts : now; };

  // the old commit (truncating the redo branch): used to build old-format logs in tests
  function commit(h, stream, baseId, newFlat, info, extra = {}) {
    const base = baseId && h.entries.find((e) => e.id === baseId && e.stream === stream) ? baseId : null;
    const prev = base ? stateAt(h, base) : null, d = prev && diffFlat(prev, newFlat);
    if (prev && !Object.keys(d.set).length && !d.del.length && !extra.force) return null;
    if (!prev && !Object.keys(newFlat).length && !entriesOf(h, stream).length && !extra.force) return null;
    if (base) {
      const list = entriesOf(h, stream), i = list.findIndex((e) => e.id === base);
      const gone = new Set(list.slice(i + 1).map((e) => e.id));
      h.entries = h.entries.filter((e) => !gone.has(e.id));
      gone.forEach((x) => cacheOf(h).delete(x));
    }
    const list = entriesOf(h, stream);
    const n = list.reduce((a, e) => Math.max(a, parseInt(e.id.slice(1), 10) || 0), 0) + 1;
    const e = {
      id: PREFIX[stream] + n, seq: h.entries.reduce((a, x) => Math.max(a, x.seq), 0) + 1, stream,
      ts: newTs(h), user: info.user || 'unknown', email: info.email || '', ...(info.system ? { system: info.system } : {}), message: info.message, hash: hash(canon(newFlat)),
    };
    if (!prev || chainLength(h, base) >= SNAP_EVERY) { e.kind = 'snapshot'; e.snapshot = clone(newFlat); }
    else { e.kind = 'delta'; e.patch = d; }
    if (extra.layout) e.layout = extra.layout;
    h.entries.push(e);
    return e;
  }

  // Text of an old log -> {history, error?}. A log with Git conflict markers is read as its two sides (ours / theirs) and their entries united.
  function parseHistory(text) {
    const empty = { history: newHistory() };
    if (!text || !text.trim()) return empty;
    const read = (t) => { const o = JSON.parse(t); return o && Array.isArray(o.entries) ? o : null; };
    try { return read(text) ? { history: read(text) } : empty; } catch (err) {
      if (!/^<{7}/m.test(text)) return { history: newHistory(), error: err.message };
    }
    const side = (theirs) => { // 0 common, 1 ours, 2 diff3 base, 3 theirs
      let mode = 0;
      return text.split('\n').filter((line) => {
        if (/^<{7}/.test(line)) { mode = 1; return false; }
        if (mode === 1 && /^\|{7}/.test(line)) { mode = 2; return false; }
        if (mode && /^={7}\r?$/.test(line)) { mode = 3; return false; }
        if (mode && /^>{7}/.test(line)) { mode = 0; return false; }
        return mode === 0 || mode === (theirs ? 3 : 1);
      }).join('\n');
    };
    try {
      const a = read(side(false)), b = read(side(true));
      if (!a || !b) throw new Error('not a version log');
      return { history: { ...a, entries: [...a.entries, ...b.entries] } };
    } catch (err) { return { history: newHistory(), error: 'Git conflict markers that could not be resolved (' + err.message + ')' }; }
  }

  // Put a log merged by Git in time order and replay it (ADR-0040): every entry's own change (its patch against its parent: the nearest earlier
  // entry with the previous number) is applied in timestamp order, so the newer edit of an entity wins; ids, patches, snapshots and hashes are
  // rebuilt, `seq` follows the order, a renumbered entry keeps its old id in `was`. A log already in order is returned as it is.
  // -> {history, changed, streams: [re-chained streams], renumbered, problems}
  function replay(h) {
    const seen = new Set(), all = [];
    h.entries.forEach((e, i) => { const k = e.id + '|' + e.ts + '|' + e.hash; if (!seen.has(k)) { seen.add(k); all.push({ e, i, seq: e.seq }); } });
    const inStream = (s, list = all) => list.filter((x) => x.e.stream === s);
    const num = (e) => parseInt(e.id.slice(1), 10);
    const bad = STREAMS.filter((s) => inStream(s).some((x, i, l) => x.e.id !== PREFIX[s] + (i + 1) || (i && tsOf(x.e) < tsOf(l[i - 1].e))));
    const inOrder = all.every((x, i) => !i || (tsOf(x.e) >= tsOf(all[i - 1].e) && x.e.seq > all[i - 1].e.seq));
    if (all.length === h.entries.length && !bad.length && inOrder) return { history: h, changed: false, streams: [], renumbered: 0, problems: [] };
    const problems = [], byOrder = (a, b) => tsOf(a.e) - tsOf(b.e) || a.seq - b.seq || a.i - b.i;
    let out = [], renumbered = 0;
    const rechained = [];
    for (const s of STREAMS) {
      const l = inStream(s);
      if (!bad.includes(s)) { out.push(...l); continue; }
      const state = new Map(), eff = new Map();
      let ok = true;
      l.forEach((x, i) => {
        if (!ok) return;
        const n = num(x.e), p = n > 1 ? l.slice(0, i).reverse().find((y) => num(y.e) === n - 1) : null;
        if (n > 1 && !p) { ok = false; problems.push(`${s}: ${x.e.id} has no ${PREFIX[s]}${n - 1} before it`); return; }
        const before = p ? state.get(p) : {}, st = x.e.kind === 'snapshot' ? clone(x.e.snapshot) : { ...before };
        if (x.e.kind !== 'snapshot') { for (const k of x.e.patch.del) delete st[k]; Object.assign(st, clone(x.e.patch.set)); }
        state.set(x, st); eff.set(x, diffFlat(before, st));
      });
      if (!ok) { out.push(...l); continue; }
      let cur = {}, deltas = 0;
      [...l].sort(byOrder).forEach((x, i) => {
        const before = cur, d = eff.get(x), id = PREFIX[s] + (i + 1), { hash: _h, kind: _k, snapshot: _s, patch: _p, layout, was: w, id: _i, ...rest } = x.e;
        cur = { ...before }; for (const k of d.del) delete cur[k]; Object.assign(cur, d.set);
        const snap = !i || deltas >= SNAP_EVERY, was = _i !== id ? w || _i : w;
        if (_i !== id) renumbered++;
        deltas = snap ? 0 : deltas + 1;
        out.push({ ...x, e: { id, ...rest, ...(was ? { was } : {}), hash: hash(canon(cur)), kind: snap ? 'snapshot' : 'delta', ...(snap ? { snapshot: clone(cur) } : { patch: diffFlat(before, cur) }), ...(layout ? { layout } : {}) } });
      });
      rechained.push(s);
    }
    out = out.sort(byOrder).map((x, i) => ({ ...x.e, seq: i + 1 }));
    return { history: { ...h, entries: out }, changed: true, streams: rechained, renumbered, problems };
  }

  // the pointers of a re-chained log: each stream at the entry that holds the model's content (else the newest, so verify reports the difference)
  function repoint(h, streams, pointers, flats) {
    const out = { ...pointers };
    for (const s of streams) {
      const l = entriesOf(h, s), want = hash(canon(flats[s]));
      const cur = l.find((e) => e.id === pointers[s]);
      if (cur && cur.hash === want) continue;
      const e = [...l].reverse().find((x) => x.hash === want) || l[l.length - 1];
      if (e) out[s] = e.id;
    }
    return out;
  }

  // does the model agree with the pointers it carries (cyrb53 hashes)?
  function verify(h, pointers, flats) {
    const problems = [];
    for (const s of STREAMS) {
      const id = pointers[s], flat = flats[s], empty = !Object.keys(flat).length;
      const e = id && h.entries.find((x) => x.id === id && x.stream === s);
      if (!id) { if (!empty || entriesOf(h, s).length) problems.push(`${s}: model has no version pointer`); }
      else if (!e) problems.push(`${s}: version ${id} is not in the history file`);
      else if (e.hash !== hash(canon(flat))) problems.push(`${s}: content differs from version ${id}`);
    }
    return problems;
  }

  // Convert an old log (already in order: parseHistory + replay) to the current one. Every entry keeps its id, time, user, system, message and layout
  // payload (and any other key); snapshots in the middle become deltas; hashes, the clock, `prev` and the chain are computed. The same input always gives
  // the same log. hlc: the entry's own time, never before the previous entry's (a counter separates equal times); node: from the author.
  function convert(lh, truth = {}) {
    const out = SM.newHistory(), last = {};
    let wall = 0, counter = 0;
    for (const e of [...lh.entries].sort((a, b) => a.seq - b.seq)) {
      let state = stateAt(lh, e.id);
      // an old log could carry patches that do not reproduce the hash they were recorded with (the generator changed a cached state in place): when
      // the model's own content is the one that hash stands for, the entry gets that content, so the model and its log agree after the conversion
      const t = truth[e.stream];
      if (t && t.id === e.id && hash(canon(state)) !== e.hash && hash(canon(t.flat)) === e.hash) state = clone(t.flat);
      const w = Math.max(Date.parse(e.ts) || 0, wall), par = last[e.stream];
      counter = w === wall ? counter + 1 : 0; wall = w;
      const { seq, hash: _h, kind: _k, snapshot: _s, patch: _p, layout, ...rest } = e;
      const n = { id: e.id, stream: e.stream, ts: e.ts, hlc: SM.hlcOf(wall, counter, SM.sha256(`${e.email || ''}|${e.system || ''}|${e.user || ''}`).slice(0, 6)) };
      for (const k of ['user', 'email', 'system', 'message']) if (k in rest) n[k] = rest[k];
      if (!par) { n.kind = 'snapshot'; n.snapshot = clone(state); } else { n.kind = 'delta'; n.patch = diffFlat(SM.stateAt(out, par), state); }
      for (const k of Object.keys(rest)) if (!(k in n) && k !== 'id' && k !== 'ts') n[k] = rest[k];
      if (layout) n.layout = layout;
      n.hash = SM.stateHash(state); n.prev = par || '';
      SM.seal(n); out.entries.push(n); last[e.stream] = n.chain;
    }
    return out;
  }

  // text of an old log -> {history (current format), error?, replayed?: the replay result when Git had merged it}; truth = {stream: {id, flat}}: the
  // entry each pointer names and the model's content (see convert)
  function load(text, truth) {
    const ph = parseHistory(text);
    if (ph.error) return { history: SM.newHistory(), error: ph.error };
    try { const rp = replay(ph.history); return { history: convert(rp.history, truth), replayed: rp.changed ? rp : null }; }
    catch (err) { return { history: SM.newHistory(), error: 'the old log cannot be converted (' + err.message + ')' }; }
  }

  const api = { newHistory, entriesOf, stateAt, commit, parseHistory, replay, verify, convert, load };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataLegacy = api;
})(typeof window !== 'undefined' ? window : globalThis);
