// HTML pages for running Strata in a plain browser: the live view (assets served over HTTP) and the exported interactive
// HTML (everything inlined into one self-contained file). Node only, no dependencies.
const fs = require('fs');
const path = require('path');

const MEDIA = path.join(__dirname, '..', 'media');
const SCRIPTS = ['brand.js', 'themes.js', 'model.js', 'legacy.js', 'align.js', 'gov.js', 'impact.js', 'order.js', 'md.js', 'codegen.js', 'layout.js', 'shim.js', 'canvas.js'];
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><polygon points="16,3.5 20.3,11 11.7,11" fill="#3794ff"/><polygon points="10.9,12.6 21.1,12.6 24.5,18.4 7.5,18.4" fill="#b180d7"/><polygon points="6.6,20 25.4,20 28.1,24.4 3.9,24.4" fill="#89d185"/><polygon points="3.2,26 28.8,26 30.5,29 1.5,29" fill="#d18616"/></svg>');
const read = (f) => fs.readFileSync(path.join(MEDIA, f), 'utf8');
const escScript = (s) => s.replace(/<\/script/gi, '<\\/script'); // safe inside <script>...</script>
const LS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const escJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(LS, (c) => '\\u' + c.charCodeAt(0).toString(16)); // safe inside a <script type="application/json">
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// the navigator (media/nav.js) runs in an iframe and talks to the page through postMessage
function navPage({ inline, token }) {
  const q = token ? '?t=' + encodeURIComponent(token) : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${inline ? `<style>${read('theme.css')}\n${read('nav.css')}</style>` : `<link rel="stylesheet" href="/media/theme.css${q}"><link rel="stylesheet" href="/media/nav.css${q}">`}</head>
<body><div id="app"></div><script>window.acquireVsCodeApi = () => ({ postMessage: (m) => parent.postMessage({ strataNav: m }, '*') });</script>
${inline ? `<script>${escScript(read('nav.js'))}</script>` : `<script src="/media/nav.js${q}"></script>`}</body></html>`;
}

// boot: { mode: 'live' | 'static', name, token?, data?: { model, history } }
function mainPage({ inline, boot, title }) {
  const q = boot.token ? '?t=' + encodeURIComponent(boot.token) : '';
  const cfg = { ...boot };
  if (inline) cfg.navHtml = navPage({ inline: true });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title || boot.name || 'Strata SQL')}</title>
<link rel="icon" href="${FAVICON}">
${inline ? `<style>${read('theme.css')}\n${read('canvas.css')}</style>` : `<link rel="stylesheet" href="/media/theme.css${q}"><link rel="stylesheet" href="/media/canvas.css${q}">`}
</head><body>
<div id="shell"><div id="navpane" hidden><iframe id="navframe" title="Model navigator"></iframe></div><div id="appwrap"><div id="app"></div></div></div>
<script type="application/json" id="strata-boot">${escJson(cfg)}</script>
${SCRIPTS.map((f) => (inline ? `<script>${escScript(read(f))}</script>` : `<script src="/media/${f}${q}"></script>`)).join('\n')}
</body></html>`;
}

module.exports = { mainPage, navPage, MEDIA };
