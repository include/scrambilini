/*
 * Scrambilini — service worker.
 *
 * Owns the identity for each tab. A seed is minted when the tab is created, so
 * the tab's very first navigation already carries the spoofed headers; the page
 * adopts the same seed a few milliseconds later and derives matching JS values.
 */

// Chrome loads the worker with importScripts; Firefox's event page gets these
// files from background.scripts in the manifest instead.
if (typeof importScripts === 'function') {
  importScripts('shared/browser.js', 'shared/profile.js');
}

const BROWSER = typeof __scrambiliniBrowser !== 'undefined' ? __scrambiliniBrowser : 'chrome';

const RULE_BASE = 900000;
const STORAGE_PREFIX = 'tab:';
const LOCKS_PREFIX = 'locks:';
const GLOBAL_LOCKS_KEY = 'locks:global';
const ALL_TABS_KEY = 'locks:allTabs';

// Content scripts read this tab's seed straight out of session storage, which
// is much quicker than waking the worker up. Session storage is closed to
// content scripts by default, so it has to be opened for them here.
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* older Chrome: the worker round trip still works */ }

/** tabId -> seed, kept warm so we do not hammer storage. */
const seeds = new Map();
/** tabId -> the pending storage write for a freshly minted seed. */
const pendingWrites = new Map();
/** tabIds whose session rule is already installed by this worker instance. */
const applied = new Set();
/** tabId -> tail of the per-tab operation queue. */
const queues = new Map();

function ruleIdFor(tabId) {
  return RULE_BASE + tabId;
}

function randomSeed() {
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => n.toString(16).padStart(8, '0')).join('');
}

/** Serialises every mutation for a tab so rule writes cannot land out of order. */
function enqueue(tabId, task) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(tabId, next.catch(() => {}));
  return next;
}

function buildRule(tabId, profile) {
  const requestHeaders = [
    { header: 'user-agent', operation: 'set', value: profile.ua },
    { header: 'accept-language', operation: 'set', value: profile.acceptLanguage },
  ];
  // Client hints are a Chromium thing; Firefox never sends them, so adding them
  // there would be a mismatch rather than a disguise.
  if (BROWSER === 'chrome') {
    requestHeaders.push(
      { header: 'sec-ch-ua', operation: 'set', value: profile.chUa },
      { header: 'sec-ch-ua-mobile', operation: 'set', value: profile.chUaMobile },
      { header: 'sec-ch-ua-platform', operation: 'set', value: profile.chUaPlatform },
    );
  }

  if (profile.dnt) {
    requestHeaders.push({ header: 'dnt', operation: 'set', value: String(profile.dnt) });
  } else {
    requestHeaders.push({ header: 'dnt', operation: 'remove' });
  }

  return {
    id: ruleIdFor(tabId),
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: {
      tabIds: [tabId],
      resourceTypes: [
        'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
        'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket',
        'other',
      ],
    },
  };
}

/** The full attribute list the popup shows under "All attributes". */
function detailsFor(core) {
  return [
    ['User agent', core.ua],
    ['Platform', `${core.platform} (${core.highEntropy.platformVersion})`],
    ['Client hints', `${core.chPlatform} · ${core.brands.map((b) => `${b.brand} ${b.version}`).join(', ')}`],
    ['Architecture', `${core.highEntropy.architecture}, ${core.highEntropy.bitness}-bit`],
    ['Screen', `${core.sw}x${core.sh} @${core.dpr} · ${core.colorDepth}-bit`],
    ['Available height', `${core.availHeight} px`],
    ['Timezone', `${core.timezone} (${core.locale})`],
    ['Languages', core.languages.join(', ')],
    ['Accept-Language', core.acceptLanguage],
    ['Cores', String(core.cores)],
    ['Memory', `${core.memory} GB`],
    ['WebGL vendor', core.glVendor],
    ['WebGL renderer', core.glRenderer],
    ['WebGPU', `${core.webgpu.vendor} / ${core.webgpu.architecture}`],
    ['WebGL limits', `${core.maxTexSize} tex · ${core.maxVertexUniforms} uniforms`],
    ['System fonts', `${core.fonts.length} fonts`],
    ['Speech voices', `${core.voices.length} voices`],
    ['Keyboard layout', core.keyboard.toUpperCase()],
    ['Canvas / audio salt', core.seedHex],
    ['Audio sample rate', `${core.sampleRate} Hz`],
    ['Storage quota', `${Math.round(core.quota / 1024 ** 3)} GB`],
    ['Media devices', `${core.devices.length}`],
    ['Do Not Track', core.doNotTrack ?? 'not set'],
    ['Battery', `${Math.round(core.battery.level * 100)}%${core.battery.charging ? ' · charging' : ''}`],
    ['Connection', `${core.connection.effectiveType} · ${core.connection.rtt} ms`],
  ];
}

function profileForSeed(seed, locks) {
  // The worker's UA is the same string the page sees, so both sides build the
  // exact same profile.
  const core = __scrambiliniBuildProfile(seed, self.navigator.userAgent, locks);
  return {
    seed,
    ua: core.ua,
    chUa: core.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    chUaMobile: '?0',
    chUaPlatform: core.chPlatform,
    acceptLanguage: core.acceptLanguage,
    dnt: core.doNotTrack,
    timezone: core.timezone,
    languages: core.languages,
    platform: core.platform,
    system: core.system,
    screen: `${core.sw}x${core.sh}@${core.dpr}`,
    cores: core.cores,
    memory: core.memory,
    gpu: core.glRenderer,
    details: detailsFor(core),
  };
}

async function readSeed(tabId) {
  if (seeds.has(tabId)) return seeds.get(tabId);
  try {
    const key = STORAGE_PREFIX + tabId;
    const stored = await chrome.storage.session.get(key);
    if (stored && stored[key]) {
      seeds.set(tabId, stored[key]);
      return stored[key];
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function writeSeed(tabId, seed) {
  seeds.set(tabId, seed);
  try {
    await chrome.storage.session.set({ [STORAGE_PREFIX + tabId]: seed });
  } catch (e) { /* ignore */ }
}

async function readTabLocks(tabId) {
  try {
    const key = LOCKS_PREFIX + tabId;
    const stored = await chrome.storage.session.get(key);
    return (stored && stored[key]) || null;
  } catch (e) {
    return null;
  }
}

async function writeTabLocks(tabId, locks) {
  const key = LOCKS_PREFIX + tabId;
  try {
    if (locks && Object.keys(locks).length) {
      await chrome.storage.session.set({ [key]: locks });
    } else {
      await chrome.storage.session.remove(key);
    }
  } catch (e) { /* ignore */ }
}

/** Locks shared by every tab, kept in local storage so they survive restarts. */
async function readGlobalLocks() {
  try {
    const stored = await chrome.storage.local.get(GLOBAL_LOCKS_KEY);
    return (stored && stored[GLOBAL_LOCKS_KEY]) || {};
  } catch (e) {
    return {};
  }
}

async function writeGlobalLocks(locks) {
  try {
    if (locks && Object.keys(locks).length) {
      await chrome.storage.local.set({ [GLOBAL_LOCKS_KEY]: locks });
    } else {
      await chrome.storage.local.remove(GLOBAL_LOCKS_KEY);
    }
  } catch (e) { /* ignore */ }
}

async function readAllTabsPref() {
  try {
    const stored = await chrome.storage.local.get(ALL_TABS_KEY);
    return Boolean(stored && stored[ALL_TABS_KEY]);
  } catch (e) {
    return false;
  }
}

/** Global locks, overridden by this tab's own locks (null means unlocked here). */
function mergeLocks(globalLocks, tabLocks) {
  const out = Object.assign({}, globalLocks || {});
  for (const [field, value] of Object.entries(tabLocks || {})) {
    if (value === null) delete out[field];
    else out[field] = value;
  }
  return out;
}

async function readLocks(tabId) {
  const [globalLocks, tabLocks] = await Promise.all([readGlobalLocks(), readTabLocks(tabId)]);
  const merged = mergeLocks(globalLocks, tabLocks);
  return Object.keys(merged).length ? merged : null;
}

/** The part of a profile that a lock stands for. */
function lockValue(seed, locks, field) {
  const core = __scrambiliniBuildProfile(seed, self.navigator.userAgent, locks);
  switch (field) {
    case 'ua': return { system: core.system, major: core.major };
    case 'screen': return [core.sw, core.sh, core.dpr];
    case 'timezone': return core.timezone;
    case 'languages': return core.languages.slice();
    case 'hardware': return { cores: core.cores, memory: core.memory };
    case 'gpu': return [core.glVendor, core.glRenderer];
    default: return null;
  }
}

async function applyHeaders(tabId, profile) {
  applied.add(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdFor(tabId)],
      addRules: [buildRule(tabId, profile)],
    });
  } catch (error) {
    console.warn('[scrambilini] could not install header rules for tab', tabId, error);
  }
}

/** Returns the tab seed, minting and installing rules the first time. */
function ensureTabSeed(tabId) {
  return enqueue(tabId, async () => {
    const existing = await readSeed(tabId);
    const locks = await readLocks(tabId);
    if (existing) {
      if (!applied.has(tabId)) await applyHeaders(tabId, profileForSeed(existing, locks));
      return existing;
    }
    const seed = randomSeed();
    seeds.set(tabId, seed);
    // The rule write is the part that has to beat the tab's first navigation,
    // so it must not wait behind the storage write.
    await Promise.all([
      writeSeed(tabId, seed),
      applyHeaders(tabId, profileForSeed(seed, locks)),
    ]);
    return seed;
  });
}

/**
 * Fast path for the page hand-off: a seed that is already minted is answered
 * immediately, without waiting for the queued storage/rule writes. That keeps
 * the round trip at a couple of milliseconds, so the page adopts the tab's real
 * identity before its own scripts get going.
 */
function currentSeed(tabId) {
  const cached = seeds.get(tabId);
  if (cached) {
    // A seed minted a moment ago may still be on its way to storage. Wait for
    // that write, so a worker restart cannot lose the seed the page adopted —
    // but never let a stalled write hold the hand-off hostage.
    const pending = pendingWrites.get(tabId);
    if (pending) {
      const cap = new Promise((resolve) => setTimeout(resolve, 100));
      return Promise.race([pending, cap]).then(() => cached);
    }
    return Promise.resolve(cached);
  }
  return ensureTabSeed(tabId);
}

function dropTab(tabId, opts) {
  const keepLocks = Boolean(opts && opts.keepLocks);
  return enqueue(tabId, async () => {
    seeds.delete(tabId);
    applied.delete(tabId);
    const keys = [STORAGE_PREFIX + tabId];
    if (!keepLocks) keys.push(LOCKS_PREFIX + tabId);
    try {
      await chrome.storage.session.remove(keys);
    } catch (e) { /* ignore */ }
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(tabId)] });
    } catch (e) { /* ignore */ }
    // Only forget the queue once the removal has landed, so a reseed that is
    // queued right behind cannot have its fresh rule deleted by this cleanup.
    queues.delete(tabId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'getSeed') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return;
    (async () => {
      const seed = await currentSeed(tabId);
      sendResponse({ seed, locks: seed ? await readLocks(tabId) : null });
    })().catch(() => sendResponse({ seed: null, locks: null }));
    return true;
  }

  if (message.type === 'profile') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return;
    // The worker owns the seed. A page that has not adopted it yet reports a
    // provisional identity; adopting that would desynchronise the headers, so
    // only refresh the rules from the seed we already minted.
    enqueue(tabId, async () => {
      const seed = await readSeed(tabId);
      if (!seed) {
        if (message.payload && message.payload.seed) {
          await writeSeed(tabId, message.payload.seed);
          await applyHeaders(tabId, message.payload);
        }
        return;
      }
      if (message.payload && message.payload.seed !== seed) return;
      await applyHeaders(tabId, profileForSeed(seed, await readLocks(tabId)));
    });
    return;
  }

  if (message.type === 'getProfile') {
    if (typeof message.tabId !== 'number') return;
    (async () => {
      const seed = await currentSeed(message.tabId);
      const [locks, allTabs] = await Promise.all([readLocks(message.tabId), readAllTabsPref()]);
      sendResponse({
        payload: seed ? profileForSeed(seed, locks) : null,
        locks: locks || {},
        allTabs,
      });
    })().catch(() => sendResponse({ payload: null, locks: {}, allTabs: false }));
    return true;
  }

  if (message.type === 'lock') {
    const tabId = message.tabId;
    if (typeof tabId !== 'number' || !message.field) return;
    (async () => {
      const seed = await ensureTabSeed(tabId);
      const [globalLocks, tabLocksStored] = await Promise.all([readGlobalLocks(), readTabLocks(tabId)]);
      const tabLocks = Object.assign({}, tabLocksStored || {});
      const effective = mergeLocks(globalLocks, tabLocks);
      const allTabs = Boolean(message.allTabs);

      if (message.locked) {
        const value = lockValue(seed, effective, message.field);
        if (value !== null) {
          tabLocks[message.field] = value;
          if (allTabs) globalLocks[message.field] = value;
        }
      } else {
        if (allTabs) delete globalLocks[message.field];
        // With a global lock in place, unlocking here is a per-tab override.
        if (message.field in globalLocks) tabLocks[message.field] = null;
        else delete tabLocks[message.field];
      }

      await Promise.all([writeGlobalLocks(globalLocks), writeTabLocks(tabId, tabLocks)]);
      const locks = mergeLocks(globalLocks, tabLocks);
      // The identity is exactly build(seed, locks), so the page has to rebuild
      // when the lock set changes — otherwise the popup and the page would
      // disagree the moment a lock is removed.
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'reseed', seed, locks });
      } catch (e) { /* tab may not have a content script */ }
      sendResponse({ payload: profileForSeed(seed, locks), locks, allTabs });
    })().catch(() => sendResponse({ payload: null, locks: {}, allTabs: false }));
    return true;
  }

  if (message.type === 'lockScope') {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') return;
    (async () => {
      const allTabs = Boolean(message.allTabs);
      await chrome.storage.local.set({ [ALL_TABS_KEY]: allTabs });
      const seed = await ensureTabSeed(tabId);
      if (allTabs) {
        // Promote what this tab already locks, so ticking the box keeps the
        // pins you already made instead of making you repeat them.
        const effective = (await readLocks(tabId)) || {};
        const globalLocks = Object.assign({}, await readGlobalLocks(), effective);
        await writeGlobalLocks(globalLocks);
      }
      const locks = (await readLocks(tabId)) || {};
      sendResponse({ payload: profileForSeed(seed, locks), locks, allTabs });
    })().catch(() => sendResponse({ payload: null, locks: {}, allTabs: false }));
    return true;
  }

  if (message.type === 'reseed') {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') return;
    (async () => {
      // Locks survive a reseed; that is the point of them.
      await dropTab(tabId, { keepLocks: true });
      const seed = await ensureTabSeed(tabId);
      const locks = await readLocks(tabId);
      const payload = profileForSeed(seed, locks);
      try {
        // The bridge swaps the page identity live; no reload needed.
        await chrome.tabs.sendMessage(tabId, { type: 'reseed', seed, locks });
      } catch (e) { /* tab may not have a content script */ }
      sendResponse({ payload, locks: locks || {} });
    })().catch(() => sendResponse({ payload: null, locks: {} }));
    return true;
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== 'number') return;
  // Mint synchronously so the page's very first getSeed is answered from
  // memory, then let the storage and rule writes settle in the background.
  if (!seeds.has(tab.id)) {
    const seed = randomSeed();
    seeds.set(tab.id, seed);
    const stored = writeSeed(tab.id, seed).finally(() => {
      if (pendingWrites.get(tab.id) === stored) pendingWrites.delete(tab.id);
    });
    pendingWrites.set(tab.id, stored);
    enqueue(tab.id, async () => {
      // Global locks apply to a brand new tab as well, so the very first
      // navigation already carries them.
      const locks = await readLocks(tab.id);
      await Promise.all([stored, applyHeaders(tab.id, profileForSeed(seed, locks))]);
    });
    return;
  }
  ensureTabSeed(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dropTab(tabId);
});

async function seedAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id === 'number') await ensureTabSeed(tab.id);
    }
  } catch (e) { /* ignore */ }
}

chrome.runtime.onStartup.addListener(seedAllTabs);

chrome.runtime.onInstalled.addListener(async () => {
  // Session rules do not survive an extension reload, and the in-memory record
  // of what was applied is gone with the old worker. Re-apply per tab, and drop
  // only rules that belong to tabs which no longer exist — never a live tab's.
  applied.clear();
  let live = new Set();
  try {
    const tabs = await chrome.tabs.query({});
    live = new Set(tabs.map((tab) => tab.id).filter((id) => typeof id === 'number'));
  } catch (e) { /* ignore */ }
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const stale = existing
      .filter((rule) => rule.id >= RULE_BASE && !live.has(rule.id - RULE_BASE))
      .map((rule) => rule.id);
    if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
  } catch (e) { /* ignore */ }
  await seedAllTabs();
});
