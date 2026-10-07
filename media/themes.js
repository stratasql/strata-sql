// Colour themes for the canvas: every flavour of Catppuccin, Tokyo Night, Rosé Pine and Nord, plus VS Code's own built-in themes (or the
// current VS Code theme as it is). Each palette is expressed as the --vscode-* variables the stylesheet already uses, so a theme is just
// a set of overrides. No DOM: loaded by the webview, the browser pages and Node tests. Palettes are close approximations of the
// official colours.
(function (g) {
  'use strict';

  // compact palette: bg / side (sidebar, widgets) / input / hover / border / fg / dim (secondary text) / accent + on (text on it) / semantic colours
  const P = (kind, label, match, bg, side, input, hover, border, fg, dim, accent, on, red, blue, yellow, orange, green, purple) =>
    ({ kind, label, match, spec: { bg, side, input, hover, border, fg, dim, accent, on, red, blue, yellow, orange, green, purple } });

  const FAMILIES = {
    catppuccin: { label: 'Catppuccin', dark: 'mocha', light: 'latte', variants: {
      latte: P('light', 'Latte', /latte/i, '#eff1f5', '#e6e9ef', '#dce0e8', '#e2e5ec', '#bcc0cc', '#4c4f69', '#6c6f85', '#1e66f5', '#ffffff', '#d20f39', '#1e66f5', '#df8e1d', '#fe640b', '#40a02b', '#8839ef'),
      frappe: P('dark', 'Frappé', /frapp/i, '#303446', '#292c3c', '#414559', '#383c50', '#51576d', '#c6d0f5', '#a5adce', '#8caaee', '#232634', '#e78284', '#8caaee', '#e5c890', '#ef9f76', '#a6d189', '#ca9ee6'),
      macchiato: P('dark', 'Macchiato', /macchiato/i, '#24273a', '#1e2030', '#363a4f', '#2d3146', '#494d64', '#cad3f5', '#a5adcb', '#8aadf4', '#181926', '#ed8796', '#8aadf4', '#eed49f', '#f5a97f', '#a6da95', '#c6a0f6'),
      mocha: P('dark', 'Mocha', /mocha/i, '#1e1e2e', '#181825', '#313244', '#2a2b3c', '#45475a', '#cdd6f4', '#a6adc8', '#89b4fa', '#1e1e2e', '#f38ba8', '#89b4fa', '#f9e2af', '#fab387', '#a6e3a1', '#cba6f7') } },
    tokyonight: { label: 'Tokyo Night', dark: 'night', light: 'day', variants: {
      night: P('dark', 'Night', /night(?!\s*(storm|moon|day|light))/i, '#1a1b26', '#16161e', '#292e42', '#1f2335', '#3b4261', '#c0caf5', '#a9b1d6', '#7aa2f7', '#1a1b26', '#f7768e', '#7aa2f7', '#e0af68', '#ff9e64', '#9ece6a', '#bb9af7'),
      storm: P('dark', 'Storm', /storm/i, '#24283b', '#1f2335', '#2f3549', '#292e42', '#3b4261', '#c0caf5', '#a9b1d6', '#7aa2f7', '#1f2335', '#f7768e', '#7aa2f7', '#e0af68', '#ff9e64', '#9ece6a', '#bb9af7'),
      moon: P('dark', 'Moon', /moon/i, '#222436', '#1e2030', '#2f334d', '#292d45', '#444a73', '#c8d3f5', '#828bb8', '#82aaff', '#1e2030', '#ff757f', '#82aaff', '#ffc777', '#ff966c', '#c3e88d', '#c099ff'),
      day: P('light', 'Day', /day|light/i, '#e1e2e7', '#d5d6db', '#c4c8da', '#d0d5e3', '#a8aecb', '#3760bf', '#6172b0', '#2e7de9', '#ffffff', '#f52a65', '#2e7de9', '#8c6c3e', '#b15c00', '#587539', '#9854f1') } },
    rosepine: { label: 'Rosé Pine', dark: 'main', light: 'dawn', variants: {
      main: P('dark', 'Rosé Pine', /ros[eé]\s*-?\s*pine(?!\s*(moon|dawn|light))/i, '#191724', '#1f1d2e', '#26233a', '#21202e', '#403d52', '#e0def4', '#908caa', '#c4a7e7', '#191724', '#eb6f92', '#569fba', '#f6c177', '#ea9a97', '#9ccfd8', '#c4a7e7'),
      moon: P('dark', 'Moon', /moon/i, '#232136', '#2a273f', '#393552', '#2f2c47', '#44415a', '#e0def4', '#908caa', '#c4a7e7', '#232136', '#eb6f92', '#3e8fb0', '#f6c177', '#ea9a97', '#9ccfd8', '#c4a7e7'),
      dawn: P('light', 'Dawn', /dawn|light/i, '#faf4ed', '#f2e9e1', '#fffaf3', '#f2e9e1', '#d9d1cb', '#575279', '#797593', '#907aa9', '#fffaf3', '#b4637a', '#286983', '#c07a1c', '#d7827e', '#56949f', '#907aa9') } },
    nord: { label: 'Nord', dark: 'nord', light: 'light', variants: {
      nord: P('dark', 'Nord (Polar Night)', /nord(?!\s*light)/i, '#2e3440', '#292e39', '#3b4252', '#353c4a', '#4c566a', '#d8dee9', '#a5b0c2', '#88c0d0', '#2e3440', '#bf616a', '#81a1c1', '#ebcb8b', '#d08770', '#a3be8c', '#b48ead'),
      light: P('light', 'Nord Light (Snow Storm)', /light/i, '#eceff4', '#e5e9f0', '#d8dee9', '#dfe4ec', '#c2cad8', '#2e3440', '#4c566a', '#5e81ac', '#eceff4', '#bf616a', '#5e81ac', '#a97f1e', '#c0663f', '#5f8a4a', '#9a6f96') } },
    // VS Code's own colours: 'current' is the running theme as it is (not a palette); the rest are its built-in themes
    vscode: { label: 'VS Code', dark: 'current', light: 'current', variants: {
      current: { kind: null, label: 'Current VS Code theme', match: null, spec: null },
      darkmodern: P('dark', 'Dark Modern', /dark modern/i, '#1f1f1f', '#181818', '#313131', '#2a2d2e', '#2b2b2b', '#cccccc', '#9d9d9d', '#0078d4', '#ffffff', '#f14c4c', '#3794ff', '#cca700', '#d18616', '#3fa34d', '#b180d7'),
      lightmodern: P('light', 'Light Modern', /light modern/i, '#ffffff', '#f8f8f8', '#ffffff', '#f2f2f2', '#e5e5e5', '#3b3b3b', '#616161', '#005fb8', '#ffffff', '#e51400', '#1a85ff', '#bf8803', '#d18616', '#388a34', '#652d90'),
      darkplus: P('dark', 'Dark+', /dark\+/i, '#1e1e1e', '#252526', '#3c3c3c', '#2a2d2e', '#3c3c3c', '#d4d4d4', '#9d9d9d', '#0e639c', '#ffffff', '#f14c4c', '#3794ff', '#cca700', '#d18616', '#3fa34d', '#b180d7'),
      lightplus: P('light', 'Light+', /light\+/i, '#ffffff', '#f3f3f3', '#ffffff', '#e8e8e8', '#d4d4d4', '#333333', '#616161', '#007acc', '#ffffff', '#e51400', '#1a85ff', '#bf8803', '#d18616', '#388a34', '#652d90'),
      monokai: P('dark', 'Monokai', /monokai/i, '#272822', '#1e1f1c', '#3c3d37', '#3e3d32', '#414339', '#f8f8f2', '#a3a08a', '#75715e', '#272822', '#f92672', '#66d9ef', '#e6db74', '#fd971f', '#a6e22e', '#ae81ff'),
      solarizeddark: P('dark', 'Solarized Dark', /solari[sz]ed dark/i, '#002b36', '#00212b', '#003847', '#073642', '#0a4a58', '#93a1a1', '#839496', '#2aa198', '#002b36', '#dc322f', '#268bd2', '#b58900', '#cb4b16', '#859900', '#6c71c4'),
      solarizedlight: P('light', 'Solarized Light', /solari[sz]ed light/i, '#fdf6e3', '#eee8d5', '#f5efdc', '#eee8d5', '#d3cbb7', '#586e75', '#657b83', '#1f8a83', '#fdf6e3', '#dc322f', '#268bd2', '#b58900', '#cb4b16', '#859900', '#6c71c4'),
      abyss: P('dark', 'Abyss', /abyss/i, '#000c18', '#060621', '#181f2f', '#082050', '#2b2b4a', '#6688cc', '#5b73a8', '#4a5cb0', '#ffffff', '#ef5350', '#4f8bff', '#ddbb88', '#f2a05a', '#22aa44', '#9966b8'),
      kimbie: P('dark', 'Kimbie Dark', /kimbie/i, '#221a0f', '#131510', '#2f2312', '#362712', '#5e452b', '#d3af86', '#a57a4c', '#6e9cbe', '#221a0f', '#dc3958', '#6e9cbe', '#f79a32', '#f06431', '#889b4a', '#98676a'),
      quietlight: P('light', 'Quiet Light', /quiet light/i, '#f5f5f5', '#f2f2f2', '#ffffff', '#e4e6f1', '#c4b7d7', '#333333', '#666666', '#705697', '#ffffff', '#aa3731', '#4b83cd', '#bf8803', '#cc6633', '#448c27', '#7a3e9d'),
      red: P('dark', 'Red', /^red$|\bred\b/i, '#390000', '#330000', '#580000', '#4a0000', '#800000', '#f8f8f8', '#d9a0a0', '#cc3333', '#ffffff', '#ff5555', '#6f9fd6', '#ffd166', '#ff9955', '#3aa64a', '#c792ea'),
      tomorrowblue: P('dark', 'Tomorrow Night Blue', /tomorrow night blue/i, '#002451', '#001c40', '#001733', '#003166', '#00346e', '#ffffff', '#99b5d9', '#3a79d6', '#002451', '#ff9da4', '#bbdaff', '#ffeead', '#ffc58f', '#d1f1a9', '#ebbbff'),
      hcdark: P('dark', 'High Contrast Dark', /high contrast(?!\s*light)/i, '#000000', '#000000', '#000000', '#1a1a1a', '#6fc3df', '#ffffff', '#d0d0d0', '#f38518', '#000000', '#ff6b6b', '#4dabf7', '#ffe066', '#ffa94d', '#69db7c', '#da77f2'),
      hclight: P('light', 'High Contrast Light', /high contrast light/i, '#ffffff', '#ffffff', '#ffffff', '#e8f0fa', '#0f4a85', '#292929', '#404040', '#0f4a85', '#ffffff', '#a31515', '#0f4a85', '#795e26', '#b5470a', '#0d6b0d', '#6f2c91') } },
  };
  const OPTIONS = [['auto', 'Auto (match the VS Code theme)'], ['vscode', 'VS Code'], ['catppuccin', 'Catppuccin'], ['tokyonight', 'Tokyo Night'], ['rosepine', 'Rosé Pine'], ['nord', 'Nord']];

  // options for the flavour dropdown of a theme
  const variantOptions = (theme) => {
    if (!FAMILIES[theme]) return [['auto', 'Chosen by your VS Code theme']];
    return [['auto', theme === 'vscode' ? 'Current VS Code theme' : 'Auto (match VS Code)'], ...Object.entries(FAMILIES[theme].variants).filter(([k]) => k !== 'current').map(([k, v]) => [k, `${v.label} · ${v.kind}`])];
  };

  // the variables the stylesheet reads; also what the VS Code webview reports so the browser can copy the user's theme
  const VARS = ['foreground', 'editor-foreground', 'editor-background', 'sideBar-background', 'editorGroupHeader-tabsBackground', 'panel-border', 'focusBorder', 'errorForeground', 'editorWarning-foreground',
    'button-background', 'button-foreground', 'button-hoverBackground', 'button-secondaryBackground', 'button-secondaryForeground', 'button-secondaryHoverBackground',
    'input-background', 'input-foreground', 'input-border', 'dropdown-background', 'dropdown-foreground', 'dropdown-border', 'inputValidation-errorBackground',
    'list-hoverBackground', 'list-activeSelectionBackground', 'list-activeSelectionForeground', 'badge-background', 'badge-foreground',
    'editorWidget-background', 'editorWidget-border', 'editorHoverWidget-background', 'editorHoverWidget-foreground', 'editorHoverWidget-border',
    'notifications-background', 'notifications-foreground', 'notifications-border', 'editor-findMatchHighlightBackground',
    'charts-red', 'charts-blue', 'charts-yellow', 'charts-orange', 'charts-green', 'charts-purple'];

  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v * (1 - t) + y[i] * t)); }; // t = share of b
  const alpha = (h, t) => `rgba(${rgb(h).join(', ')}, ${t})`;
  const lum = (h) => { const c = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  function build(s) {
    return {
      foreground: s.fg, 'editor-foreground': s.fg, 'editor-background': s.bg, 'sideBar-background': s.side, 'editorGroupHeader-tabsBackground': s.side, 'panel-border': s.border,
      focusBorder: s.accent, errorForeground: s.red, 'editorWarning-foreground': s.yellow,
      'button-background': s.accent, 'button-foreground': s.on, 'button-hoverBackground': mix(s.accent, s.fg, 0.15),
      'button-secondaryBackground': s.input, 'button-secondaryForeground': s.fg, 'button-secondaryHoverBackground': mix(s.input, s.fg, 0.1),
      'input-background': s.input, 'input-foreground': s.fg, 'input-border': s.border, 'dropdown-background': s.input, 'dropdown-foreground': s.fg, 'dropdown-border': s.border,
      'inputValidation-errorBackground': mix(s.bg, s.red, 0.25),
      'list-hoverBackground': s.hover, 'list-activeSelectionBackground': s.accent, 'list-activeSelectionForeground': s.on, 'badge-background': s.border, 'badge-foreground': s.fg,
      'editorWidget-background': s.side, 'editorWidget-border': s.border, 'editorHoverWidget-background': s.side, 'editorHoverWidget-foreground': s.fg, 'editorHoverWidget-border': s.border,
      'notifications-background': s.side, 'notifications-foreground': s.fg, 'notifications-border': s.border, 'editor-findMatchHighlightBackground': alpha(s.accent, 0.3),
      'charts-red': s.red, 'charts-blue': s.blue, 'charts-yellow': s.yellow, 'charts-orange': s.orange, 'charts-green': s.green, 'charts-purple': s.purple,
    };
  }

  // theme family for a VS Code theme name, or 'vscode' when it is not one of the four
  function detect(name) {
    const n = String(name || '');
    return /catppuccin/i.test(n) ? 'catppuccin' : /tokyo\s*night/i.test(n) ? 'tokyonight' : /ros[eé]\s*-?\s*pine/i.test(n) ? 'rosepine' : /\bnord\b/i.test(n) ? 'nord' : 'vscode';
  }
  // flavour of a family named by a VS Code theme name, else the family's dark / light default
  function flavour(family, name, dark) {
    const f = FAMILIES[family], n = String(name || '');
    for (const [k, v] of Object.entries(f.variants)) if (v.match && v.match.test(n)) return k;
    return dark ? f.dark : f.light;
  }

  // What to apply for the two settings (theme, themeVariant), the VS Code theme name and whether the host is dark:
  // { family, variant, kind, real } where real = "use the running VS Code theme's own colours".
  function resolve(theme, variant, name, dark) {
    let family = FAMILIES[theme] ? theme : 'auto';
    if (family === 'auto') { family = detect(name); if (family === 'vscode') return { family: 'vscode', variant: 'current', kind: null, real: true }; variant = 'auto'; }
    const f = FAMILIES[family];
    let key = variant && variant !== 'auto' && f.variants[variant] ? variant : family === 'vscode' ? 'current' : detect(name) === family ? flavour(family, name, dark) : dark ? f.dark : f.light;
    if (family === 'vscode' && key === 'current') return { family, variant: 'current', kind: null, real: true };
    return { family, variant: key, kind: f.variants[key].kind, real: false };
  }

  // an :root rule that wins over the values VS Code (or the page) sets inline; --strata-on is the text colour on coloured chips
  const rule = (vars, kind, on) => `:root { color-scheme: ${kind}; ${Object.entries(vars).filter(([, v]) => v).map(([k, v]) => `--vscode-${k}: ${v} !important;`).join(' ')}${on ? ` --strata-on: ${on} !important;` : ''} }`;
  const css = (family, variant) => { const v = FAMILIES[family] && FAMILIES[family].variants[variant]; return v && v.spec ? rule(build(v.spec), v.kind, v.spec.on) : ''; };
  const cssVars = (vars, kind) => rule(vars || {}, kind === 'light' ? 'light' : 'dark', '');

  const api = { FAMILIES, OPTIONS, VARS, variantOptions, build, detect, flavour, resolve, css, cssVars, contrast };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataThemes = api;
})(typeof window !== 'undefined' ? window : globalThis);
