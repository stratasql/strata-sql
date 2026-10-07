// Renders help.md as a standalone HTML page for the live view (headings, paragraphs, nested lists, tables, images, code, links).
// All text is HTML-escaped first; there is no raw HTML passthrough.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (t) => t.toLowerCase().replace(/[`*_]/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '@@C' + (codes.length - 1) + '@@'; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${/^(https?:|\/)/.test(src) ? src : '/' + src}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/@@C(\d+)@@/g, (_, i) => `<code>${codes[+i]}</code>`);
}

function render(md, title) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n'), out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l), isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length} id="${slug(m[2])}">${inline(m[2])}</h${m[1].length}>`); i++; }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; }
    else if (isRow(l) && isSep(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      let rows = '';
      for (i += 2; i < lines.length && isRow(lines[i]); i++) rows += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`);
    } else if (item.test(l)) {
      // nested lists by indentation; indented lines under an item (paragraphs, images) belong to that item
      const stack = []; // { indent, tag }
      let html = '';
      const close = (to) => { while (stack.length && stack[stack.length - 1].indent >= to) html += `</li></${stack.pop().tag}>`; };
      while (i < lines.length) {
        const ln = lines[i], im = item.exec(ln);
        if (im) {
          const indent = im[1].length, tag = /\d/.test(im[2]) ? 'ol' : 'ul';
          if (stack.length && stack[stack.length - 1].indent === indent) html += '</li>';
          else { close(indent + 1); if (!stack.length || stack[stack.length - 1].indent < indent) { html += `<${tag}>`; stack.push({ indent, tag }); } else html += '</li>'; }
          html += `<li>${inline(im[3])}`;
          i++;
        } else if (!ln.trim()) { if (/^\s+\S/.test(lines[i + 1] || '') || item.test(lines[i + 1] || '')) i++; else break; }
        else if (/^\s+\S/.test(ln)) { html += `<div class="cont">${inline(ln.trim())}</div>`; i++; }
        else break;
      }
      close(0);
      out.push(html);
    } else if (/^>/.test(l)) { const q = []; for (; i < lines.length && /^>/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, '')); out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`); }
    else { const p = []; for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*([-*]|\d+\.)\s|\|)/.test(lines[i]); i++) p.push(lines[i]); out.push(`<p>${inline(p.join(' '))}</p>`); if (!p.length) i++; }
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title || 'Strata SQL help')}</title>
<link rel="stylesheet" href="/media/theme.css"><style>
body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font: 15px/1.6 var(--vscode-font-family); }
main { max-width: 900px; margin: 0 auto; padding: 24px 28px 80px; }
h1, h2, h3 { line-height: 1.25; } h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 2em; }
img { max-width: 100%; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 8px 0; }
table { border-collapse: collapse; margin: 10px 0; } th, td { border: 1px solid var(--vscode-panel-border); padding: 5px 10px; text-align: left; vertical-align: top; }
th { background: var(--vscode-sideBar-background); }
code { font-family: var(--vscode-editor-font-family); font-size: 13px; background: rgba(127,127,127,.2); padding: 1px 5px; border-radius: 4px; }
pre { background: rgba(127,127,127,.15); padding: 10px 12px; border-radius: 6px; overflow: auto; } pre code { background: none; padding: 0; }
a { color: var(--vscode-charts-blue); } blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--vscode-panel-border); opacity: .9; }
.cont { margin: 4px 0; }
</style></head><body><main>${out.join('\n')}</main></body></html>`;
}

module.exports = { render, inline };
