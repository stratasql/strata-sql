// Browser stand-in for the VS Code webview host. Used by the live view (talks to lib/live.js over HTTP + server-sent events),
// by the demo (`strata-sql live --demo`: this page is the host, nothing reaches the server) and by the exported interactive HTML
// (static: a read-only viewer with the model embedded). Loaded before canvas.js.
(function () {
  const bootEl = document.getElementById('strata-boot');
  const boot = bootEl ? JSON.parse(bootEl.textContent) : {}; // { mode: 'live' | 'demo' | 'static', token, name, samples (demo), navHtml, data: { model, history } }
  const demo = boot.mode === 'demo', remote = boot.mode === 'live', live = remote || demo, q = live ? '?t=' + encodeURIComponent(boot.token) : '';
  let base = boot.name || 'model';
  const toMain = (msg) => window.dispatchEvent(new MessageEvent('message', { data: msg }));
  let navCss = '', navLayout = { key: null, state: null }, settings = {}, dirty = false, unloading = false, saveTimer = null, curText = boot.data ? boot.data.model : null;

  // ---- small UI helpers: toasts, downloads, title ----
  const toasts = document.getElementById('toasts') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toasts' }));
  function toast(text, ms) {
    const d = Object.assign(document.createElement('div'), { textContent: text });
    toasts.append(d);
    setTimeout(() => d.remove(), ms || 5000);
  }
  function download(name, text, mime) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' })), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const setTitle = () => { document.title = (dirty ? '● ' : '') + base + ' · Strata SQL'; };
  setTitle();

  // ---- demo: this page plays the host. The server only hands out the shipped samples; every change (model, versions, positions, settings, sample data)
  // is kept in sessionStorage, which belongs to this tab and goes when it closes ----
  const DK = 'strata-demo:', samples = boot.samples || [], fetched = {};
  const ss = {
    get: (k) => { try { return JSON.parse(sessionStorage.getItem(DK + k)); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(DK + k, JSON.stringify(v)); } catch { toast('This browser tab has no room left for the demo: reset the sample to go on.', 8000); } },
    del: (k) => { try { sessionStorage.removeItem(DK + k); } catch { /* storage blocked */ } },
    clear: () => { try { Object.keys(sessionStorage).filter((k) => k.startsWith(DK)).forEach((k) => sessionStorage.removeItem(k)); } catch { /* storage blocked */ } },
  };
  let current = null;
  const sampleOf = async (id) => fetched[id] || (fetched[id] = await (await fetch('/demo/sample' + q + '&id=' + encodeURIComponent(id))).json());
  const DEMO_SETTINGS = { name: 'Demo user', email: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, system: 'browser', arrows: 'squared', animate: false, theme: 'auto', themeVariant: 'auto', versionMode: 'auto', recordLayout: false, embed: {} };
  const NO = (what) => [{ type: 'toast', text: what + ' is not available in the demo.' }];
  async function demoHost(m) { // the server's job in the live view: answer the page's messages, from this tab's storage over the shipped sample
    const id = current, S = ss.get('s:' + id) || {}, keep = (patch) => ss.set('s:' + id, Object.assign(S, patch)); // writes come before any await: the page may be unloading
    switch (m.type) {
      case 'ready': {
        const b = await sampleOf(id);
        return [{ type: 'model', host: 'demo', layoutKey: id + '.model.json', layout: S.layout || {}, text: S.text ?? b.model, history: S.history ?? b.history, layoutFile: S.positions ?? b.layout,
          settings: { ...DEMO_SETTINGS, ...S.settings }, dataDir: 'data', theme: null, embed: null, embedKeys: {}, embedProviders: [], embedFile: '' }];
      }
      case 'edit': case 'saveReady': keep({ ...(m.text != null && { text: m.text }), ...(m.history != null && { history: m.history }), ...(m.positions != null && { positions: m.positions }) }); return [];
      case 'positions': keep({ positions: m.text }); return [];
      case 'settings': keep({ settings: m.settings }); return [];
      case 'layout': { const l = { ...S.layout }; if (m.state == null) delete l[m.part]; else l[m.part] = m.state; keep({ layout: l }); return []; }
      case 'data': { // sample data: the shipped CSV files, with this tab's own on top (null = renamed away)
        const name = (f) => String(f).split('/').pop(), get = async (f) => (S.data && name(f) in S.data ? S.data[name(f)] : (await sampleOf(id)).data[name(f)] ?? null);
        if (m.op === 'open') return [{ type: 'toast', text: 'In the demo, sample data stays in this browser tab.' }];
        if (m.op === 'create' && (await get(m.file)) == null) keep({ data: { ...S.data, [name(m.file)]: String(m.text) } });
        if (m.op === 'rename') { const text = await get(m.file); if (text != null && (await get(m.to)) == null) keep({ data: { ...S.data, [name(m.to)]: text, [name(m.file)]: null } }); return []; }
        return m.op === 'read' || m.op === 'create' ? [{ type: 'data', file: m.file, text: await get(m.file) }] : [];
      }
      case 'embed': case 'embedKey': return NO('Vector embeddings');
      case 'newProject': return NO('Creating a project');
      case 'openLive': return [{ type: 'toast', text: 'You are in the live view already: this is the demo.' }];
      default: return [];
    }
  }
  if (demo) {
    // leaving the page marks the data for removal: a reload keeps it (so does switching sample or resetting, which say `stay`); a closed tab that is
    // restored, or a later visit, starts clean
    const nav = performance.getEntriesByType('navigation')[0];
    if (ss.get('leaving') && !ss.get('stay') && !(nav && nav.type === 'reload')) ss.clear();
    ss.del('leaving'); ss.del('stay');
    addEventListener('pagehide', () => ss.set('leaving', true));
    const want = new URLSearchParams(location.search).get('sample');
    current = [want, ss.get('current'), (samples[0] || {}).id].find((id) => samples.some((s) => s.id === id));
    ss.set('current', current); base = current; setTitle();
    const go = (id) => { ss.set('stay', true); ss.set('current', id); location.href = '/' + q; };
    const sel = Object.assign(document.createElement('select'), { title: 'Open another sample model (each keeps its own changes in this tab)', onchange: () => go(sel.value) });
    for (const s of samples) sel.append(Object.assign(document.createElement('option'), { value: s.id, textContent: s.label, title: s.detail, selected: s.id === current }));
    const reset = Object.assign(document.createElement('button'), { textContent: 'Reset', title: 'Throw away this sample\'s changes and versions and start again', onclick: () => { ss.del('s:' + current); go(current); } });
    const bar = Object.assign(document.createElement('div'), { id: 'demobar', title: 'Nothing is saved to disk. Your changes, versions and sample data stay in this browser tab and are discarded when you close it.' });
    bar.append(Object.assign(document.createElement('b'), { textContent: 'Demo' }), sel, reset);
    document.body.append(bar);
  }

  // ---- navigator pane (the nav.js webview, in an iframe) ----
  const navpane = document.getElementById('navpane'), navframe = document.getElementById('navframe');
  // live view: closed, like the plugin's editor (the navigator is VS Code's own side view there); once you open or close it here the
  // choice is kept per model in .strata/layout.json (part 'browser', live view only). The read-only export opens it on wide screens.
  let navOn = !live && innerWidth >= 900, navRestored = false;
  const setNav = (on, remember) => { navOn = on; if (navpane) navpane.hidden = !on; if (remember && live) post({ type: 'layout', part: 'browser', state: { nav: on } }); };
  const navPost = (msg) => { if (navframe && navframe.contentWindow) navframe.contentWindow.postMessage(msg, '*'); };
  if (navframe) { if (boot.navHtml) navframe.srcdoc = boot.navHtml; else if (live) navframe.src = '/nav' + q; }
  setNav(navOn);
  window.addEventListener('message', (e) => {
    if (!navframe || e.source !== navframe.contentWindow || !e.data || !e.data.strataNav) return;
    const m = e.data.strataNav;
    if (m.type === 'ready') { navPost({ type: 'model', text: curText, file: base + '.model.json', layoutKey: navLayout.key, layout: navLayout.state }); if (navCss) navPost({ type: 'theme', css: navCss }); }
    else if (m.type === 'layout') { if (live) post({ type: 'layout', part: 'nav', state: m.state }); }
    else if (m.type === 'reveal') toMain({ type: 'reveal', kind: m.kind, ref: m.ref, column: m.column });
  });

  // ---- host -> webview ----
  function fromHost(msg) {
    if (msg.type === 'toast') return toast(msg.text);
    if (msg.type === 'download') return download(msg.name, msg.text, msg.mime);
    if (msg.type === 'model') {
      curText = msg.text; dirty = false; setTitle();
      if (msg.settings) settings = msg.settings;
      navLayout = { key: msg.layoutKey === undefined ? null : msg.layoutKey, state: (msg.layout || {}).nav || null };
      if (live && !navRestored) { navRestored = true; const b = (msg.layout || {}).browser; if (b) setNav(!!b.nav); }
      navPost({ type: 'model', text: msg.text, file: base + '.model.json', layoutKey: navLayout.key, layout: navLayout.state });
    }
    toMain(msg);
  }

  // ---- transport ----
  async function post(m, beacon) {
    if (demo) { try { (await demoHost(m)).forEach(fromHost); } catch (err) { toast('Demo: ' + err.message, 8000); } return; }
    if (beacon && navigator.sendBeacon) return navigator.sendBeacon('/msg' + q, new Blob([JSON.stringify(m)], { type: 'text/plain' }));
    try {
      const r = await fetch('/msg' + q, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(m) });
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      (await r.json()).forEach(fromHost);
    } catch (err) { toast('Strata SQL server: ' + err.message, 8000); }
  }
  let connected = true;
  if (remote) {
    const es = new EventSource('/events' + q);
    es.onmessage = (e) => { connected = true; fromHost(JSON.parse(e.data)); };
    es.onerror = () => { if (connected) toast('Connection to the Strata SQL server lost. Restart it and reload this page.', 10000); connected = false; };
  }

  // save = the same handshake VS Code does: the canvas flushes pending versions and answers with saveReady
  function save() { if (live) toMain({ type: 'beforeSave' }); }

  // ---- webview -> host ----
  function outbound(m) {
    switch (m.type) {
      case 'panels': return setNav(!!m.nav, true);
      case 'toggleNav': return setNav(!navOn, true);
      case 'layout': if (!live) return; break; // the canvas layout is kept by the server
      case 'themeCss': navCss = m.css || ''; return navPost({ type: 'theme', css: navCss }); // the navigator pane follows the canvas theme
      case 'themeVars': return; // only meaningful inside VS Code
      case 'positions': case 'newProject': if (!live) return; break; // canvas positions and the wizard are the server's
      case 'openBrand': return void window.open(window.StrataBrand.url, '_blank', 'noopener');
      case 'help': return live ? window.open('/help' + q, '_blank') : toast('This is an exported read-only view of ' + base + '. The Strata SQL help is in the extension and at the live view.');
      case 'exportOrder': return download(base + '.load-order.json', m.text, 'application/json');
      case 'saveFile': return download(m.name, m.text, /\.ipynb$/.test(m.name) ? 'application/json' : 'text/x-python');
      case 'exportHtml': {
        if (!live) return;
        if (demo) return toast('Export as HTML is not available in the demo: the page is made from a saved model.');
        const a = Object.assign(document.createElement('a'), { href: '/export.html' + q, download: base + '.html' });
        document.body.append(a); a.click(); return a.remove();
      }
      case 'settings': settings = { ...settings, ...m.settings }; break;
      case 'edit':
        curText = m.text; navPost({ type: 'model', text: m.text, file: base + '.model.json' });
        if (!live) return;
        dirty = true; setTitle();
        post(m);
        clearTimeout(saveTimer);
        if (settings.versionMode !== 'save') saveTimer = setTimeout(save, 900); // "version on save" waits for Cmd/Ctrl+S
        return;
      case 'saveReady': dirty = false; setTitle(); break;
      default:
    }
    if (live) return post(m, unloading && m.type === 'saveReady');
    if (m.type === 'ready') {
      const d = boot.data || {};
      // domainOf / projectView (release 2 part 4, ADR-0045 extended): only ever present when this static page is a Project View screenshot
      // (tests/help-shots/run.sh assembles a real split project through lib/project.js and hands the result to lib/shell.js#mainPage the
      // same way an exported HTML file is built); undefined for every ordinary export, forwarded unchanged otherwise.
      toMain({ type: 'model', text: d.model, history: d.history, layoutFile: d.layoutFile, readOnly: true, theme: boot.theme || null, dataDir: '', embed: null, embedKeys: {}, embedProviders: [], embedFile: '',
        domainOf: d.domainOf, projectView: d.projectView,
        settings: { name: 'Viewer', email: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, system: '', arrows: 'squared', animate: false, versionMode: 'auto', recordLayout: false, theme: boot.themeSetting || 'auto', themeVariant: boot.themeVariant || 'auto', embed: {} } });
    } else if (m.type === 'data' && m.op === 'read') toMain({ type: 'data', file: m.file, text: null });
  }
  window.acquireVsCodeApi = () => ({ postMessage: outbound, getState: () => undefined, setState: () => undefined });

  // ---- the shortcuts VS Code binds to the editor ----
  const LEVEL_KEYS = { KeyG: 'governance', KeyC: 'conceptual', KeyL: 'logical', KeyP: 'physical', KeyS: 'semantic' };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); return outbound({ type: 'help' }); }
    const lv = (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && LEVEL_KEYS[e.code]; // e.code: Alt changes e.key on macOS
    if (lv) { e.preventDefault(); return toMain({ type: 'level', level: lv }); }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase(), inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const cmd = { s: null, 1: { type: 'autoLayout' }, y: { type: 'toggleHistory' }, f: { type: 'search' }, '.': { type: 'togglePanels', nav: navOn } }[k];
    if (k === 's') { e.preventDefault(); save(); if (live) toast('Saved', 1500); }
    else if (k === 'l') { e.preventDefault(); setNav(!navOn, true); }
    else if (k === 'z' && !inField) { e.preventDefault(); toMain({ type: e.shiftKey ? 'redo' : 'undo' }); }
    else if (cmd) { e.preventDefault(); toMain(cmd); }
  });
  window.addEventListener('beforeunload', (e) => { if (live && dirty && settings.versionMode === 'save') { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', () => { unloading = true; save(); });
  if (!live) document.body.append(Object.assign(document.createElement('div'), { id: 'viewerbadge', textContent: 'Read-only export' }));
})();
