// Export a model as one self-contained interactive HTML file: the Strata canvas (pan, zoom, levels, view scope, search,
// hover details, impact analysis, load order, version history preview) with the model embedded. Read-only; sample data,
// embeddings and the settings file are not included.
const { mainPage } = require('./shell.js');

// theme: the VS Code session's colours { name, kind, vars } (optional); themeSetting: the Strata theme choice ('auto', 'nord', ...)
function exportHtml({ name, modelText, historyText, layoutText, theme, themeSetting, themeVariant }) {
  return mainPage({ inline: true, title: name + ' · Strata SQL', boot: { mode: 'static', name, theme: theme || null, themeSetting: themeSetting || 'auto', themeVariant: themeVariant || 'auto', data: { model: modelText, history: historyText || null, layoutFile: layoutText || null } } });
}

module.exports = { exportHtml };
