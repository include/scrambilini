/*
 * Domain matching for the exceptions list, shared by the worker, the popup and
 * the content scripts.
 *
 *   *.gmail.com   matches gmail.com and every subdomain
 *   www.sapo.pt   matches only that host
 */
var __scrambiliniMatcher = (function () {
  'use strict';

  function normalize(entry) {
    let value = String(entry || '').trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    value = value.split('/')[0].split('?')[0].split('#')[0];
    value = value.replace(/:\d+$/, '');
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(value)) return '';
    return value;
  }

  function matchesHost(host, entries) {
    const target = String(host || '').toLowerCase();
    if (!target) return false;
    for (const entry of entries || []) {
      const pattern = normalize(entry);
      if (!pattern) continue;
      if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        if (target === base || target.endsWith(`.${base}`)) return true;
      } else if (target === pattern) {
        return true;
      }
    }
    return false;
  }

  /** Match patterns for scripting.registerContentScripts(excludeMatches). */
  function toMatchPatterns(entries) {
    const out = [];
    for (const entry of entries || []) {
      const pattern = normalize(entry);
      if (!pattern) continue;
      if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        out.push(`*://${base}/*`, `*://*.${base}/*`);
      } else {
        out.push(`*://${pattern}/*`);
      }
    }
    return out;
  }

  /** Domains for declarativeNetRequest excludedRequest/InitiatorDomains. */
  function toDnrDomains(entries) {
    const out = new Set();
    for (const entry of entries || []) {
      const pattern = normalize(entry);
      if (!pattern) continue;
      out.add(pattern.startsWith('*.') ? pattern.slice(2) : pattern);
    }
    return [...out];
  }

  return { normalize, matchesHost, toMatchPatterns, toDnrDomains };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __scrambiliniMatcher;
}
