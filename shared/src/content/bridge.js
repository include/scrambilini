/*
 * Scrambilini — isolated-world bridge.
 *
 * 1. Gets the tab's authoritative seed and hands it to the page as soon as it
 *    arrives. The page starts with a provisional identity and swaps it in place,
 *    so the window where the two differ is the hand-off, not the whole page life.
 *    The seed is read straight out of session storage first: that does not need
 *    the service worker to wake up, which keeps the window a couple of
 *    milliseconds wide even when the worker has been asleep for a while. The
 *    worker is asked in parallel and wins if the two ever disagree.
 * 2. Nudges the worker to (re)install the header rules whenever the page
 *    publishes a profile, which also covers a worker that restarted mid-tab.
 * 3. On an excepted site (or when scrambling is off) it does nothing except
 *    remove any seed left behind by a previous visit to that origin.
 */
(() => {
  'use strict';

  const SEED_KEY = '__scrambilini_seed';
  const LOCKS_KEY = '__scrambilini_locks';
  const HEADER_KEY = '__scrambilini_headers';
  const STORAGE_PREFIX = 'tab:';
  const LOCKS_PREFIX = 'locks:';
  const GLOBAL_LOCKS_KEY = 'locks:global';
  const SETTINGS_KEY = 'settings';
  const REAL_UA_KEY = '__scrambilini_real_ua';
  let lastSent = null;
  let started = false;
  let authoritative = null;

  function report() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(HEADER_KEY);
    } catch (e) { /* storage blocked */ }
    if (!raw || raw === lastSent) return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) { return; }

    lastSent = raw;
    try {
      chrome.runtime.sendMessage({ type: 'profile', payload });
    } catch (e) {
      // Extension context went away (update/reload); nothing to do.
    }
  }

  function start() {
    if (started) return;
    started = true;
    report();
    window.addEventListener('scrambilini:profile', report);
    // A frame that starts before the payload exists still needs to catch up.
    let tries = 0;
    const timer = setInterval(() => {
      report();
      if (++tries > 20) clearInterval(timer);
    }, 50);
  }

  /** Hand a seed and its locked fields to the page. sessionStorage is the only
   *  channel both worlds share synchronously. */
  function publishSeed(seed, locks, realUa) {
    if (!seed) return;
    try {
      sessionStorage.setItem(SEED_KEY, seed);
      // Firefox shares `navigator` between documents in a tab, so the page's
      // own copy can already be spoofed by a previous document. The worker's
      // is always the real one.
      if (realUa) sessionStorage.setItem(REAL_UA_KEY, realUa);
      if (locks && Object.keys(locks).length) {
        sessionStorage.setItem(LOCKS_KEY, JSON.stringify(locks));
      } else {
        sessionStorage.removeItem(LOCKS_KEY);
      }
      window.dispatchEvent(new Event('scrambilini:seed'));
    } catch (e) { /* ignore */ }
  }

  /** The seed and effective locks for this tab, read without waking the worker. */
  async function stateFromStorage() {
    try {
      // All three calls go to the browser process, so they run at the same
      // time instead of one after the other.
      const [tab, session, local] = await Promise.all([
        chrome.tabs.getCurrent(),
        chrome.storage.session.get(null),
        chrome.storage.local.get(GLOBAL_LOCKS_KEY),
      ]);
      if (!tab || typeof tab.id !== 'number' || !session) return null;
      const seed = session[STORAGE_PREFIX + tab.id];
      if (!seed) return null;
      const tabLocks = session[LOCKS_PREFIX + tab.id] || {};
      const globalLocks = (local && local[GLOBAL_LOCKS_KEY]) || {};
      const locks = Object.assign({}, globalLocks);
      for (const [field, value] of Object.entries(tabLocks)) {
        if (value === null) delete locks[field];
        else locks[field] = value;
      }
      return { seed, locks: Object.keys(locks).length ? locks : null };
    } catch (e) {
      return null;
    }
  }

  /** Excepted sites, and the whole extension when it is switched off. */
  async function isExcepted() {
    let settings = null;
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      settings = stored && stored[SETTINGS_KEY];
    } catch (e) { /* ignore */ }
    if (settings && settings.enabled === false) return true;
    const exceptions = (settings && settings.exceptions) || [];
    if (!exceptions.length) return false;
    try {
      return __scrambiliniMatcher.matchesHost(location.hostname, exceptions);
    } catch (e) {
      return false;
    }
  }

  function startBridge() {
    try {
      // Fast path: the worker already stored this tab's seed when the tab was
      // created, and session storage is much quicker to read than the worker is
      // to wake up.
      stateFromStorage().then((state) => {
        if (state && !authoritative) publishSeed(state.seed, state.locks, null);
      });

      // Authoritative answer, in parallel.
      chrome.runtime.sendMessage({ type: 'getSeed' }, (response) => {
        try {
          sessionStorage.setItem('__scrambilini_diag', JSON.stringify({
            at: Date.now(),
            seed: response && response.seed,
            swUa: response && response.dbgUa,
            pageUa: navigator.userAgent,
            error: chrome.runtime.lastError && chrome.runtime.lastError.message,
          }));
        } catch (e) { /* ignore */ }
        if (!chrome.runtime.lastError && response && response.seed) {
          authoritative = response.seed;
          publishSeed(response.seed, response.locks, response.realUa);
        }
        start();
      });
      // Safety net if the worker never answers.
      setTimeout(start, 1500);
    } catch (e) {
      start();
    }
  }

  isExcepted()
    .then((excepted) => {
      if (!excepted) {
        startBridge();
        return;
      }
      // Leave no trace of a previous identity on this origin.
      try {
        sessionStorage.removeItem(SEED_KEY);
        sessionStorage.removeItem(LOCKS_KEY);
        sessionStorage.removeItem(HEADER_KEY);
      } catch (e) { /* ignore */ }
    })
    .catch(() => startBridge());

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'reseed') return;
    try {
      if (window.top !== window) return;
    } catch (e) { return; }
    // Hand the fresh seed to the page in place: it swaps the identity live, so
    // the tab does not reload and the popup can show the new values.
    if (!message.seed) return;
    authoritative = message.seed;
    publishSeed(message.seed, message.locks, message.realUa);
  });
})();
