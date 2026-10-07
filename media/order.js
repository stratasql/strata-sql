// Load order over the working model (no DOM): which tables and views can load together and which must wait.
// Loaded by the webview, by node tests and by the skill script.
//
// "A needs B" = B must be loaded before A: an FK column needs the table it references; a view needs every table it reads
// (media/impact.js scans the SQL). Table-level relationships carry no FK column, so they add no dependency (an M..M is
// realised by a bridge table whose own FKs do). Self references are not a dependency (reported as selfRefs); tables that
// reference each other in a cycle load together in one stage (reported as cycles: load without constraints, add FKs after).
//
// SLA (optional per table: table.sla = {frequency, time?} or {exclude:true}): the clock time (24H) by which a table's data is
// available. "Ready" (cumulative) = the later of the table's own SLA time and the ready time of everything it needs. Only
// sources that refresh at least as often as the table delay it (a monthly source does not hold up a daily table), and tables
// marked exclude (static / reference data) are ignored. A table whose own SLA is earlier than its inputs can be ready is
// flagged atRisk. realtime / minute / hourly have no clock time; the times are one cycle's time of day (weekday and day of
// month are not modelled).
(function (g) {
  'use strict';
  const IM = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./impact.js') : g.StrataImpact;
  const SM = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./model.js') : g.StrataModel;

  const FREQ = ['realtime', 'minute', 'hourly', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
  const CLOCK = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']); // frequencies that carry a time of day
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const hhmm = (n) => (n == null ? null : String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'));
  // null when fine, else what is wrong with the SLA
  const slaProblem = (a) => (!a || a.exclude ? null : !FREQ.includes(a.frequency) ? 'Unknown frequency ' + a.frequency : CLOCK.has(a.frequency) && !TIME_RE.test(a.time || '') ? 'A time in 24-hour HH:MM is required for ' + a.frequency : null);

  function analyse(m) {
    const R = SM.refs(m), ref = (id) => R.tab.get(id);
    const ids = m.tables.map((t) => t.id);
    const deps = new Map(ids.map((id) => [id, new Map()])); // table -> (table it needs -> 'fk' | 'view')
    const selfRefs = new Set();
    for (const t of m.tables) for (const c of t.columns) {
      const f = c.foreignKey;
      if (!f || !deps.has(f.tableId)) continue;
      if (f.tableId === t.id) selfRefs.add(t.id); else deps.get(t.id).set(f.tableId, 'fk');
    }
    IM.graph(m).reads.forEach((r, vid) => r.tables.forEach((tid) => { if (!deps.get(vid).has(tid)) deps.get(vid).set(tid, 'view'); }));
    const G = graph(ids, deps, ref), { stages, comp, reach, needMap } = G;

    // cumulative availability, in stage order (a table's prerequisites are always in earlier stages, cycle members ignore each other)
    const byId = new Map(m.tables.map((t) => [t.id, t]));
    const rank = (id) => { const a = byId.get(id).sla; return a && a.frequency ? FREQ.indexOf(a.frequency) : a && a.exclude ? -1 : 99; };
    const avail = new Map();
    for (const st of stages) for (const id of st.ids) {
      const sla = byId.get(id).sla;
      if (sla && sla.exclude) { avail.set(id, { excluded: true }); continue; }
      let up = null, via = null;
      for (const d of deps.get(id).keys()) {
        const a = avail.get(d);
        if (comp.get(d) === comp.get(id) || !a || a.excluded || a.ready == null) continue;
        if (a.freq && FREQ.indexOf(a.freq) > rank(id)) continue; // a slower source does not delay a faster table
        if (up == null || a.ready > up) { up = a.ready; via = d; }
      }
      const own = sla && CLOCK.has(sla.frequency) && TIME_RE.test(sla.time || '') ? mins(sla.time) : null;
      const ready = own != null ? Math.max(own, up == null ? -1 : up) : up;
      avail.set(id, { freq: sla && sla.frequency || null, own, up, ready, derived: own == null && ready != null, atRisk: own != null && up != null && up > own, via: up != null ? via : null, continuous: !!sla && !CLOCK.has(sla.frequency) });
    }
    return finish(G, deps, avail, selfRefs, (id) => ref(id));
  }

  // critical path, begin / ready / duration and the result object shared by analyse() and rollup()
  function finish(G, deps, avail, selfRefs, name) {
    const { stages, reach, needMap } = G, byRef = (a, b) => name(a).localeCompare(name(b));
    let end = null;
    avail.forEach((a, id) => { if (a.ready != null && (end == null || a.ready > avail.get(end).ready)) end = id; });
    const critical = [];
    for (let v = end; v; v = avail.get(v).via) critical.unshift(v);
    // when the first data feeding the last table is available, when the last is, and the time between
    let begin = null;
    if (end != null) [end, ...reach(needMap, end)].forEach((id) => { const a = avail.get(id); if (a.ready != null && (begin == null || a.ready < begin)) begin = a.ready; });
    const atRisk = [...avail].filter(([, a]) => a.atRisk).map(([id]) => id).sort(byRef);
    return {
      stages, stage: G.stage, deps, name, users: G.users, parent: G.parent, children: G.children, roots: G.roots, cycles: G.cycles, selfRefs, longest: G.longest, avail, readyBy: end == null ? null : avail.get(end).ready, beginsAt: begin, duration: end == null ? null : avail.get(end).ready - begin, critical, atRisk,
      widest: stages.reduce((a, s) => Math.max(a, s.ids.length), 0),
      upstream: (id) => reach(needMap, id), // everything that must load before it
      downstream: (id) => reach(G.users, id), // everything that must wait for it
    };
  }

  // Stages, cycles, spanning tree and reachability of a "needs" graph: ids, deps = id -> Map(needed id -> kind), name(id) orders ties.
  function graph(ids, deps, name) {
    const byRef = (a, b) => name(a).localeCompare(name(b));
    // strongly connected components (Tarjan): a component of two or more tables is a cycle
    const idx = new Map(), low = new Map(), on = new Set(), stack = [], comp = new Map(), comps = [];
    let n = 0;
    const connect = (v) => {
      idx.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
      for (const w of deps.get(v).keys()) {
        if (!idx.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (low.get(v) === idx.get(v)) {
        const c = [];
        let w;
        do { w = stack.pop(); on.delete(w); comp.set(w, comps.length); c.push(w); } while (w !== v);
        comps.push(c.sort(byRef));
      }
    };
    ids.forEach((v) => { if (!idx.has(v)) connect(v); });

    // stage = 1 + the latest stage among what the component needs outside itself (1 = needs nothing)
    const stageOfComp = new Map();
    const stageC = (ci) => {
      if (stageOfComp.has(ci)) return stageOfComp.get(ci);
      let s = 0;
      for (const v of comps[ci]) for (const w of deps.get(v).keys()) if (comp.get(w) !== ci) s = Math.max(s, stageC(comp.get(w)));
      stageOfComp.set(ci, s + 1);
      return s + 1;
    };
    const stage = new Map(ids.map((id) => [id, stageC(comp.get(id))]));
    const stages = [];
    ids.slice().sort(byRef).forEach((id) => { const s = stage.get(id); (stages[s - 1] = stages[s - 1] || { n: s, ids: [] }).ids.push(id); });

    // who needs me (direct), and a spanning tree: each table hangs under the prerequisite that loads last
    const users = new Map(ids.map((id) => [id, []]));
    deps.forEach((m2, id) => m2.forEach((_, d) => users.get(d).push(id)));
    users.forEach((l) => l.sort(byRef));
    const parent = new Map(), children = new Map(ids.map((id) => [id, []]));
    for (const id of ids.slice().sort(byRef)) {
      const ext = [...deps.get(id).keys()].filter((d) => comp.get(d) !== comp.get(id)).sort((a, b) => stage.get(b) - stage.get(a) || byRef(a, b));
      if (ext.length) { parent.set(id, ext[0]); children.get(ext[0]).push(id); }
    }
    const roots = ids.filter((id) => !parent.has(id)).sort(byRef);

    // the longest chain of "must wait for" (sets the minimum number of sequential steps)
    const last = stages.length ? stages[stages.length - 1].ids[0] : null, longest = [];
    for (let v = last; v; v = parent.get(v)) longest.unshift(v);

    const reach = (map, id) => { const out = new Set(), q = [id]; while (q.length) for (const x of (map.get(q.pop()) || [])) { if (!out.has(x)) { out.add(x); q.push(x); } } return out; };
    const needMap = new Map([...deps].map(([id, mm]) => [id, [...mm.keys()]]));
    return { stages, stage, comp, users, parent, children, roots, longest, cycles: comps.filter((c) => c.length > 1), reach, needMap };
  }

  // Load order of groups of tables (entities or concepts, ADR-0033), derived from a table analysis o:
  // A needs B when a table of A needs a table of B, looking through tables in no group (bridges); needs inside a group are ignored;
  // empty groups are left out. A group is ready when all its tables are (the latest ready time), out of SLA when all its tables
  // are, at risk when one of them is. groups: Map(group id -> table ids); name(id) for sorting and texts.
  function rollup(o, groups, name, tableName) {
    const of = new Map();
    groups.forEach((ts, gid) => ts.forEach((t) => { if (!of.has(t)) of.set(t, []); of.get(t).push(gid); }));
    const ids = [...groups.keys()].filter((gid) => groups.get(gid).length);
    const deps = new Map(ids.map((gid) => [gid, new Map()]));
    for (const gid of ids) for (const t of groups.get(gid)) {
      const seen = new Set([t]), q = [...o.deps.get(t)];
      while (q.length) {
        const [d, kind] = q.pop();
        if (seen.has(d)) continue;
        seen.add(d);
        const gs = of.get(d);
        if (gs) gs.forEach((x) => { if (x !== gid && !deps.get(gid).has(x)) deps.get(gid).set(x, kind); });
        else q.push(...o.deps.get(d)); // a table in no group: look through it
      }
    }
    const G = graph(ids, deps, name), avail = new Map();
    for (const st of G.stages) for (const gid of st.ids) {
      const as = groups.get(gid).map((t) => [t, o.avail.get(t)]).filter(([, a]) => a && !a.excluded);
      if (!as.length) { avail.set(gid, { excluded: true }); continue; }
      const known = as.filter(([, a]) => a.ready != null);
      if (!known.length) { avail.set(gid, { ready: null }); continue; }
      const [lt, la] = known.reduce((x, y) => (y[1].ready > x[1].ready ? y : x));
      let v = la.via;
      for (let i = 0; v && (of.get(v) || []).includes(gid) && i < 1000; i++) v = o.avail.get(v) && o.avail.get(v).via; // what it waits for inside the group
      const viaG = v && (of.get(v) || []).find((x) => deps.get(gid).has(x) && G.comp.get(x) !== G.comp.get(gid)); // never inside a cycle
      avail.set(gid, { ready: la.ready, last: lt, up: viaG ? avail.get(viaG) && avail.get(viaG).ready : null, via: viaG || null, derived: true, atRisk: as.some(([, a]) => a.atRisk), tables: groups.get(gid).length });
    }
    // stage order guarantees a prerequisite group is filled before the groups that need it
    const r = finish(G, deps, avail, new Set(), name);
    r.groups = groups;
    r.explain = (gid) => {
      const a = avail.get(gid), n = groups.get(gid).length, needs = deps.get(gid).size, waits = r.downstream(gid).size, lines = [];
      if (a.excluded) lines.push(`Out of SLA: all its ${n === 1 ? 'table is' : n + ' tables are'} static / reference data.`);
      else if (a.ready != null) lines.push(`Ready when all its ${n === 1 ? 'table is' : n + ' tables are'}: ${hhmm(a.ready)} (last: ${tableName(a.last)}).`);
      else lines.push('No estimate: none of its tables has a clock-time SLA.');
      if (a.atRisk) lines.push('⚠ One of its tables promises data earlier than its inputs can be ready.');
      lines.push(`Load stage ${r.stage.get(gid)} of ${r.stages.length} · needs ${needs} directly · ${waits} wait for it.`);
      return lines;
    };
    return r;
  }

  // "3h 05m" / "45m"
  const dur = (n) => (n == null ? null : (n >= 60 ? Math.floor(n / 60) + 'h ' + String(n % 60).padStart(2, '0') + 'm' : n + 'm'));

  // plain-language estimate of when a table's data can be expected, from its SLA and its dependencies (lines of text)
  function explain(m, o, id) {
    const nm = o.name, t = m.tables.find((x) => x.id === id), a = o.avail.get(id), sla = t.sla, lines = [];
    const needs = o.deps.get(id).size, waits = o.downstream(id).size;
    if (a.excluded) lines.push('Out of SLA: static / reference data, not part of the SLA calculation.');
    else {
      if (sla && sla.frequency) lines.push(`SLA: ${sla.frequency}${sla.time ? ', data available by ' + sla.time : ''}`);
      if (a.up != null) lines.push(`Inputs are ready at ${hhmm(a.up)} (last to arrive: ${nm(a.via)} at ${hhmm(o.avail.get(a.via).ready)}), so loading can start after that.`);
      else if (needs) lines.push('None of its inputs has a clock-time SLA.');
      else lines.push('Needs nothing: it can load first.');
      if (a.continuous) lines.push('Refreshes continuously (' + sla.frequency + '): no clock time.');
      else if (a.ready != null) lines.push(`Expected data available: ${hhmm(a.ready)}${a.derived ? ' (no SLA of its own; derived from its inputs)' : ''}.`);
      else lines.push('No estimate: neither this table nor its inputs have a clock-time SLA.');
      if (a.atRisk) lines.push(`⚠ Its SLA (${sla.time}) is earlier than its inputs allow: expect ${hhmm(a.ready)} instead.`);
    }
    lines.push(`Load stage ${o.stage.get(id)} of ${o.stages.length} · needs ${needs} ${needs === 1 ? 'table' : 'tables'} directly · ${waits} ${waits === 1 ? 'table waits' : 'tables wait'} for it.`);
    return lines;
  }

  // the load sequence as a plain JSON document (stages, prerequisites, SLA and cumulative availability)
  function toJSON(m, o, now) {
    const R = SM.refs(m), ref = (id) => R.tab.get(id), byId = new Map(m.tables.map((t) => [t.id, t]));
    const table = (id) => {
      const t = byId.get(id), a = o.avail.get(id) || {}, sla = t.sla && (t.sla.exclude || t.sla.frequency) ? (t.sla.exclude ? { exclude: true } : { frequency: t.sla.frequency, ...(t.sla.time ? { time: t.sla.time } : {}) }) : null;
      return {
        ref: ref(id), kind: t.kind === 'view' ? 'view' : 'table', needs: [...o.deps.get(id).keys()].map(ref).sort(), sla,
        ...(a.ready != null ? { ...(a.up != null ? { startsAfter: hhmm(a.up) } : {}), availableBy: hhmm(a.ready), ...(a.derived ? { availabilityDerived: true } : {}), ...(a.via ? { waitsFor: ref(a.via) } : {}) } : {}),
        ...(a.atRisk ? { slaAtRisk: true } : {}), ...(o.cycles.some((c) => c.includes(id)) ? { inCycle: true } : {}), ...(o.selfRefs.has(id) ? { selfReference: true } : {}),
      };
    };
    return {
      format: 'strata-load-order/1', model: m.project ? m.project.name : '', ...(now ? { generatedAt: now } : {}),
      summary: { tables: m.tables.length, stages: o.stages.length, maxParallel: o.widest, longestChain: o.longest.map(ref), pipelineBeginsAt: hhmm(o.beginsAt), pipelineReadyBy: hhmm(o.readyBy), pipelineDurationMinutes: o.duration, criticalPath: o.critical.map(ref), slaAtRisk: o.atRisk.map(ref), cycles: o.cycles.map((c) => c.map(ref)) },
      stages: o.stages.map((s) => ({ stage: s.n, parallel: s.ids.length > 1, ...(s.ids.some((id) => o.avail.get(id).ready != null) ? { readyBy: hhmm(Math.max(...s.ids.map((id) => o.avail.get(id).ready ?? -1))) } : {}), tables: s.ids.map(table) })),
    };
  }

  const api = { analyse, rollup, graph, toJSON, explain, FREQ, CLOCK, hhmm, dur, slaProblem };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataOrder = api;
})(typeof window !== 'undefined' ? window : globalThis);
