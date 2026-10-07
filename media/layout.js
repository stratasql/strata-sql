// Layered (Sugiyama-style) auto layout, no dependencies.
// Parents (referenced tables) go left, children (FK holders) go right.
(function (g) {
  const W = 240, HEAD = 32, ROW = 24, FOOT = 28;
  const CONCEPT_H = 88;
  const height = (t, level) => (level === 'conceptual' ? CONCEPT_H : HEAD + t.columns.length * ROW + FOOT);

  function layered(tables, edges, gx, gy, level, maxCols = Infinity) {
    const T = new Map(tables.map((t) => [t.id, t]));
    const parents = new Map(tables.map((t) => [t.id, []]));
    const children = new Map(tables.map((t) => [t.id, []]));
    for (const [p, c] of edges) if (p !== c) { parents.get(c).push(p); children.get(p).push(c); }

    // 1. layering: longest path from roots (cycle safe)
    const layer = new Map(), state = new Map();
    const visit = (n) => {
      if (state.get(n) === 2) return layer.get(n);
      if (state.get(n) === 1) return 0;
      state.set(n, 1);
      let l = 0;
      for (const p of parents.get(n)) l = Math.max(l, visit(p) + 1);
      state.set(n, 2);
      layer.set(n, l);
      return l;
    };
    const layers = [];
    for (const t of tables) (layers[visit(t.id)] ||= []).push(t.id);
    const cols = layers.filter(Boolean);

    // 2. ordering: barycenter sweeps
    const idx = new Map();
    const reindex = () => cols.forEach((c) => c.forEach((n, i) => idx.set(n, i)));
    reindex();
    for (let it = 0; it < 8; it++) {
      const down = it % 2 === 0;
      const nb = down ? parents : children;
      const seq = down ? cols.slice(1) : cols.slice(0, -1).reverse();
      for (const c of seq) {
        const key = new Map(c.map((n) => {
          const a = nb.get(n);
          return [n, a.length ? a.reduce((s, x) => s + idx.get(x), 0) / a.length : idx.get(n)];
        }));
        c.sort((a, b) => key.get(a) - key.get(b));
        reindex();
      }
    }

    // wrap very tall layers (e.g. many unconnected views) into several columns instead of one endless stack
    const MAXH = 900;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      let acc = 0, cut = -1;
      for (let k = 0; k < c.length; k++) {
        acc += height(T.get(c[k]), level) + gy;
        if (acc > MAXH && k > 0) { cut = k; break; }
      }
      if (cut > 0) cols.splice(i + 1, 0, c.splice(cut));
    }
    reindex();

    // 3. coordinates: stack, then pull toward neighbours without overlapping
    const hOf = (n) => height(T.get(n), level);
    const y = new Map();
    for (const c of cols) { let cur = 0; for (const n of c) { y.set(n, cur); cur += hOf(n) + gy; } }
    const relax = (c, nb) => {
      const want = c.map((n) => {
        const a = nb.get(n);
        return a.length ? a.reduce((s, p) => s + y.get(p) + hOf(p) / 2, 0) / a.length - hOf(n) / 2 : y.get(n);
      });
      let cur = -Infinity;
      c.forEach((n, i) => { const v = Math.max(want[i], cur); y.set(n, v); cur = v + hOf(n) + gy; });
    };
    for (let it = 0; it < 4; it++) {
      cols.slice(1).forEach((c) => relax(c, parents));
      cols.slice(0, -1).reverse().forEach((c) => relax(c, children));
    }
    // fold very wide diagrams into stacked bands of at most maxCols layers
    const pos = new Map();
    const bands = [];
    cols.forEach((c, li) => (bands[Math.floor(li / maxCols)] ||= []).push({ c, li }));
    let off = 0, w = 0;
    for (const band of bands) {
      const mn = Math.min(...band.flatMap((b) => b.c).map((n) => y.get(n)));
      let bh = 0;
      for (const { c, li } of band) {
        const cx = (li % maxCols) * (W + gx);
        for (const n of c) { pos.set(n, { x: cx, y: y.get(n) - mn + off }); bh = Math.max(bh, y.get(n) - mn + hOf(n)); }
        w = Math.max(w, cx + W);
      }
      off += bh + 70;
    }
    return { pos, h: off - 70, w };

  }

  // Lay out every schema as its own block (layered inside), then pack the blocks into rows so the whole
  // diagram roughly matches the viewport aspect ratio. Catalogs stay together (one region each, stacked).
  // Returns {tableId: {x, y}}.
  function compute(m, level, aspect = 1.6) {
    const three = m.project && m.project.threePart;
    const catName = (id) => (m.catalogs.find((c) => c.id === id) || {}).name || '';
    const schemas = [...m.schemas].sort(
      (a, b) => (three ? catName(a.catalogId).localeCompare(catName(b.catalogId)) : 0) || a.name.localeCompare(b.name)
    );
    const GAP = 150;
    const inputs = [];
    for (const s of schemas) {
      const ts = m.tables.filter((t) => t.schemaId === s.id).sort((a, b) => a.name.localeCompare(b.name));
      if (!ts.length) continue;
      const ids = new Set(ts.map((t) => t.id));
      const edges = [];
      for (const t of ts) for (const c of t.columns) {
        if (c.foreignKey && ids.has(c.foreignKey.tableId)) edges.push([c.foreignKey.tableId, t.id]);
      }
      for (const r of m.relations || []) if (ids.has(r.parentId) && ids.has(r.childId)) edges.push([r.parentId, r.childId]);
      inputs.push({ key: three ? s.catalogId || '' : '', ts, edges });
    }
    if (!inputs.length) return {};
    let blocks0 = inputs.map((i) => layered(i.ts, i.edges, 130, 40, level));
    const area = blocks0.reduce((a, b) => a + (b.w + GAP) * (b.h + GAP), 0);
    const targetW = Math.max(2 * W + 130, Math.sqrt(area * Math.max(aspect, 0.4)) * 1.1);
    const maxCols = Math.max(2, Math.floor((targetW + 130) / (W + 130)));
    const groups = new Map(); // catalog id (or '') -> blocks
    inputs.forEach((i, k) => {
      const blk = blocks0[k].w > targetW * 1.25 ? layered(i.ts, i.edges, 130, 40, level, maxCols) : blocks0[k];
      if (!groups.has(i.key)) groups.set(i.key, []);
      groups.get(i.key).push(blk);
    });
    const out = {};
    let gy = 0;
    for (const blocks of groups.values()) {
      blocks.sort((a, b) => b.h - a.h); // tallest first packs shelves much tighter
      let x = 0, y = 0, rowH = 0;
      for (const b of blocks) {
        if (x > 0 && x + b.w > targetW) { x = 0; y += rowH + GAP; rowH = 0; }
        b.pos.forEach((p, id) => (out[id] = { x: p.x + x, y: p.y + y + gy }));
        x += b.w + GAP;
        rowH = Math.max(rowH, b.h);
      }
      gy += y + rowH + GAP + 50;
    }
    return out;
  }

  g.Layout = { compute, W, HEAD, ROW, height };
})(typeof window !== 'undefined' ? window : globalThis);
