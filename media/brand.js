// Brand constants shared by the extension host, the live view and the webview.
(function (g) {
  'use strict';
  const api = { name: 'Strata SQL', url: 'https://stratasql.com' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataBrand = api;
})(typeof window !== 'undefined' ? window : globalThis);
