// Self-check for media/themes.js. Run: node tests/themes.check.js
const assert = require('assert');
const T = require('../media/themes.js');

// every palette defines every variable the stylesheet reads, and is readable
let palettes = 0;
for (const [fk, f] of Object.entries(T.FAMILIES)) for (const [vk, v] of Object.entries(f.variants)) {
  if (!v.spec) { assert(fk === 'vscode' && vk === 'current'); continue; }
  palettes++;
  const id = `${fk}/${vk}`, s = v.spec, vars = T.build(s), css = T.css(fk, vk);
  for (const name of T.VARS) assert(vars[name], `${id} lacks ${name}`);
  assert(css.includes(`color-scheme: ${v.kind}`) && css.includes('--vscode-editor-background:') && css.includes('--strata-on:'), id + ' css');
  assert(/^#[0-9a-f]{6}$/.test(s.bg) && ['dark', 'light'].includes(v.kind), id);
  assert(T.contrast(s.fg, s.bg) >= 4.5, `${id} text contrast ${T.contrast(s.fg, s.bg).toFixed(2)}`);
  assert(T.contrast(s.dim, s.bg) >= 3.2, `${id} dim text contrast ${T.contrast(s.dim, s.bg).toFixed(2)}`);
  assert(T.contrast(s.on, s.accent) >= 3, `${id} text on accent ${T.contrast(s.on, s.accent).toFixed(2)}`);
  assert(T.contrast(s.on, s.red) >= 2.4 && T.contrast(s.on, s.green) >= 2.4, `${id} text on red / green`);
  // a "dark" palette really is darker than the text on it, a "light" one lighter
  assert((T.contrast(s.bg, '#000000') < T.contrast(s.fg, '#000000')) === (v.kind === 'dark'), id + ' kind matches the colours');
}
// the flavours that exist
const names = (fam) => Object.keys(T.FAMILIES[fam].variants).filter((k) => k !== 'current');
assert.deepStrictEqual(names('catppuccin'), ['latte', 'frappe', 'macchiato', 'mocha']);
assert.deepStrictEqual(names('tokyonight'), ['night', 'storm', 'moon', 'day']);
assert.deepStrictEqual(names('rosepine'), ['main', 'moon', 'dawn']);
assert.deepStrictEqual(names('nord'), ['nord', 'light']);
assert(names('vscode').length >= 13 && palettes >= 26, 'palettes: ' + palettes);

// family detection from the VS Code theme name
const fam = { 'Catppuccin Mocha': 'catppuccin', 'Catppuccin Latte': 'catppuccin', 'Tokyo Night': 'tokyonight', 'Tokyo Night Storm': 'tokyonight', 'Rosé Pine': 'rosepine', 'Rose Pine Moon': 'rosepine', 'rosepine': 'rosepine', 'Nord': 'nord', 'Nord Light': 'nord', 'Default Dark Modern': 'vscode', 'Solarized Light': 'vscode', 'Northern Lights': 'vscode', '': 'vscode' };
for (const [name, want] of Object.entries(fam)) assert.strictEqual(T.detect(name), want, name);
assert.strictEqual(T.detect(undefined), 'vscode');
// flavour from the name, else the dark / light default
const fl = [['catppuccin', 'Catppuccin Mocha', 'mocha'], ['catppuccin', 'Catppuccin Frappé', 'frappe'], ['catppuccin', 'Catppuccin Macchiato', 'macchiato'], ['catppuccin', 'Catppuccin Latte', 'latte'], ['catppuccin', 'Catppuccin', 'mocha'],
  ['tokyonight', 'Tokyo Night', 'night'], ['tokyonight', 'Tokyo Night Storm', 'storm'], ['tokyonight', 'Tokyo Night Moon', 'moon'], ['tokyonight', 'Tokyo Night Light', 'day'], ['tokyonight', 'Tokyo Night Day', 'day'],
  ['rosepine', 'Rosé Pine', 'main'], ['rosepine', 'Rosé Pine Moon', 'moon'], ['rosepine', 'Rosé Pine Dawn', 'dawn'], ['nord', 'Nord', 'nord'], ['nord', 'Nord Light', 'light'],
  ['vscode', 'Monokai', 'monokai'], ['vscode', 'Solarized Light', 'solarizedlight'], ['vscode', 'Solarized Dark', 'solarizeddark'], ['vscode', 'Default Light Modern', 'lightmodern'], ['vscode', 'Default Dark+', 'darkplus'], ['vscode', 'High Contrast Light', 'hclight'], ['vscode', 'High Contrast', 'hcdark'], ['vscode', 'Tomorrow Night Blue', 'tomorrowblue']];
for (const [f, name, want] of fl) assert.strictEqual(T.flavour(f, name, true), want, `${f}: ${name}`);

// resolve(theme, variant, vsCodeThemeName, hostIsDark)
const R = (...a) => { const r = T.resolve(...a); return r.real ? 'real' : `${r.family}/${r.variant}/${r.kind}`; };
assert.strictEqual(R('auto', 'auto', 'Catppuccin Frappé', true), 'catppuccin/frappe/dark', 'auto matches the flavour');
assert.strictEqual(R('auto', 'mocha', 'Tokyo Night Moon', true), 'tokyonight/moon/dark', 'auto ignores a saved flavour: VS Code decides');
assert.strictEqual(R('auto', 'auto', 'Default Dark Modern', true), 'real', 'auto with another theme = the VS Code colours');
assert.strictEqual(R('catppuccin', 'auto', 'Catppuccin Macchiato', true), 'catppuccin/macchiato/dark', 'auto flavour follows VS Code');
assert.strictEqual(R('catppuccin', 'auto', 'Default Dark Modern', true), 'catppuccin/mocha/dark', 'no match: dark default');
assert.strictEqual(R('catppuccin', 'auto', 'Default Light Modern', false), 'catppuccin/latte/light', 'no match: light default');
assert.strictEqual(R('nord', 'light', 'Default Dark Modern', true), 'nord/light/light', 'a chosen flavour wins, even against the VS Code kind');
assert.strictEqual(R('rosepine', 'nonsense', 'Rosé Pine Dawn', false), 'rosepine/dawn/light', 'unknown flavour falls back to auto');
assert.strictEqual(R('vscode', 'auto', 'Anything', true), 'real');
assert.strictEqual(R('vscode', 'monokai', 'Anything', false), 'vscode/monokai/dark', 'built-in VS Code palette');
assert.strictEqual(R('bogus', 'auto', 'Nord', true), 'nord/nord/dark', 'unknown theme = auto');

// the flavour dropdown
assert.deepStrictEqual(T.variantOptions('catppuccin').map((o) => o[0]), ['auto', 'latte', 'frappe', 'macchiato', 'mocha']);
assert.strictEqual(T.variantOptions('vscode')[0][1], 'Current VS Code theme');
assert.deepStrictEqual(T.variantOptions('auto'), [['auto', 'Chosen by your VS Code theme']]);
// a copied VS Code theme becomes a rule; empty values are skipped
const r = T.cssVars({ 'editor-background': '#123456', foreground: '' }, 'light');
assert(r.includes('--vscode-editor-background: #123456 !important') && !r.includes('--vscode-foreground') && r.includes('color-scheme: light'));
assert.deepStrictEqual(T.OPTIONS.map((o) => o[0]), ['auto', 'vscode', 'catppuccin', 'tokyonight', 'rosepine', 'nord']);
console.log('themes check ok:', palettes, 'palettes');
