// Tiny, safe Markdown subset for descriptions (no DOM, no HTML passthrough): the caller renders the tree with text nodes only.
// Blocks: # headings, paragraphs (a single newline is a line break), - / * / 1. lists, > quotes, ``` code, --- rules.
// Inline: `code`, **bold**, *italic* / _italic_, [text](url) (shown as text, tooltips are not clickable), \ escapes.
(function (g) {
  'use strict';

  function inline(s) {
    const out = [];
    let i = 0, buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', s: buf }); buf = ''; } };
    const ws = (c) => c === undefined || /\s/.test(c);
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!>]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (c === '`') { const j = s.indexOf('`', i + 1); if (j > i + 1) { flush(); out.push({ t: 'code', s: s.slice(i + 1, j) }); i = j + 1; continue; } }
      if (s.startsWith('**', i) || s.startsWith('__', i)) {
        const m = s.slice(i, i + 2), j = s.indexOf(m, i + 2);
        if (j > i + 2 && !ws(s[i + 2]) && !ws(s[j - 1])) { flush(); out.push({ t: 'b', c: inline(s.slice(i + 2, j)) }); i = j + 2; continue; }
      }
      if (c === '*' || (c === '_' && !/\w/.test(s[i - 1] || ' '))) {
        const j = s.indexOf(c, i + 1);
        if (j > i + 1 && !ws(s[i + 1]) && !ws(s[j - 1]) && (c === '*' || !/\w/.test(s[j + 1] || ' '))) { flush(); out.push({ t: 'i', c: inline(s.slice(i + 1, j)) }); i = j + 1; continue; }
      }
      if (c === '[') {
        const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
        if (m) { flush(); out.push({ t: 'a', c: inline(m[1]), href: m[2] }); i += m[0].length; continue; }
      }
      buf += c; i++;
    }
    flush();
    return out;
  }

  function parse(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), blocks = [];
    let i = 0;
    const isBlock = (l) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|(-{3,}|\*{3,})\s*$)/.test(l);
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if (/^\s*```/.test(l)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        blocks.push({ t: 'code', s: code.join('\n') });
      } else if ((m = /^\s*(#{1,6})\s+(.*)$/.exec(l))) { blocks.push({ t: 'h', n: m[1].length, c: inline(m[2].trim()) }); i++; }
      else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { blocks.push({ t: 'hr' }); i++; }
      else if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        blocks.push({ t: 'quote', c: inline(q.join('\n')) });
      } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l), items = [], re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        while (i < lines.length && (m = re.exec(lines[i]))) { items.push(inline(m[1])); i++; }
        blocks.push({ t: ordered ? 'ol' : 'ul', items });
      } else {
        const p = [];
        while (i < lines.length && lines[i].trim() && !(p.length && isBlock(lines[i]))) p.push(lines[i++]);
        blocks.push({ t: 'p', c: inline(p.join('\n')) });
      }
    }
    return blocks;
  }

  const api = { parse, inline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataMd = api;
})(typeof window !== 'undefined' ? window : globalThis);
