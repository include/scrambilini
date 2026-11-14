const $ = (id) => document.getElementById(id);

const LOCKABLE = ['ua', 'screen', 'timezone', 'languages', 'hardware', 'gpu'];

const state = {
  tabId: null,
  host: '',
  payload: null,
  locks: {},
  allTabs: false,
  enabled: true,
  exceptions: [],
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && !isExtensionPage(tab.url)) return tab;
  // The popup can also be opened as a normal tab (handy for testing). Then the
  // active tab is the popup itself, so act on the last real page instead.
  const tabs = await chrome.tabs.query({});
  const pages = tabs.filter((t) => t.url && !isExtensionPage(t.url));
  return pages[pages.length - 1] || tab;
}

function isExtensionPage(url) {
  return !url || url.startsWith('chrome-extension://') || url.startsWith('devtools://');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function ask(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getProfile', tabId }, (response) => {
      resolve(response || {
        payload: null, locks: {}, allTabs: false, enabled: true, exceptions: [],
      });
    });
  });
}

function sendSettings(patch) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'settings', ...patch }, (response) => {
      resolve(response);
    });
  });
}

function syncHeight() {
  const views = $('views');
  const exceptionsOpen = views.classList.contains('show-exceptions');
  const active = exceptionsOpen ? $('exceptionsView') : views.querySelector('.view');
  if (active) views.style.height = `${active.offsetHeight}px`;
}

function flash() {
  const facts = $('facts');
  facts.classList.remove('flash');
  void facts.offsetWidth;
  facts.classList.add('flash');
}

function renderLocks(locks) {
  for (const field of LOCKABLE) {
    const locked = Boolean(locks && locks[field]);
    const box = document.querySelector(`.lock[data-field="${field}"]`);
    if (box) box.checked = locked;
    document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
      if (el.classList.contains('lock')) return;
      el.classList.toggle('locked', locked);
    });
  }
}

function renderDetails(payload) {
  const list = $('all');
  list.replaceChildren();
  const details = (payload && payload.details) || [];
  for (const [label, value] of details) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dd.title = String(value);
    list.append(dt, dd);
  }
  $('allCount').textContent = String(details.length);
}

function setValue(id, value) {
  const el = $(id);
  el.textContent = value;
  el.title = value;
}

function renderExceptionList() {
  const list = $('exceptionList');
  list.replaceChildren();
  if (!state.exceptions.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No exceptions yet.';
    list.append(li);
    return;
  }
  for (const entry of state.exceptions) {
    const li = document.createElement('li');
    const domain = document.createElement('span');
    domain.className = 'domain';
    domain.textContent = entry;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = `Remove ${entry}`;
    remove.addEventListener('click', () => removeException(entry));
    li.append(domain, remove);
    list.append(li);
  }
}

function render() {
  const { payload, locks, enabled, exceptions } = state;
  const excepted = enabled && __scrambiliniMatcher.matchesHost(state.host, exceptions);

  document.body.classList.toggle('off', !enabled);
  document.body.classList.toggle('excepted', excepted);
  $('enabled').checked = enabled;
  $('offNotice').hidden = enabled;
  $('exceptionNotice').hidden = !excepted;
  $('dot').classList.toggle('off', !enabled || excepted);
  $('reseed').disabled = !enabled || excepted;
  $('exCount').textContent = String(exceptions.length);
  $('scopeHint').hidden = state.allTabs || !locks || Object.keys(locks).length === 0;

  renderExceptionList();
  renderLocks(locks);
  renderDetails(payload);
  $('allTabs').checked = Boolean(state.allTabs);

  if (!payload) {
    $('seed').textContent = 'not active on this page';
    return;
  }
  setValue('seed', payload.seed.slice(0, 24));
  setValue('ua', payload.ua);
  setValue('screen', payload.screen);
  setValue('tz', payload.timezone || 'system default');
  setValue('langs', (payload.languages || []).join(', '));
  setValue('hw', `${payload.cores} cores · ${payload.memory} GB`);
  setValue('gpu', payload.gpu);
  syncHeight();
}

async function applySettings(patch, rerender = true) {
  const response = await sendSettings(patch);
  if (!response) {
    // The worker did not answer; fall back to what it actually stored.
    if (state.tabId !== null) {
      const fresh = await ask(state.tabId);
      state.enabled = fresh.enabled !== false;
      state.exceptions = fresh.exceptions || [];
      render();
    }
    return;
  }
  state.enabled = response.enabled;
  state.exceptions = response.exceptions;
  if (rerender) render();
}

function addException(value) {
  const entry = __scrambiliniMatcher.normalize(value);
  if (!entry) return;
  // Show it right away; the worker confirms afterwards.
  state.exceptions = Array.from(new Set([...state.exceptions, entry])).sort();
  render();
  applySettings({ exceptions: state.exceptions }, false);
}

function removeException(entry) {
  state.exceptions = state.exceptions.filter((item) => item !== entry);
  render();
  applySettings({ exceptions: state.exceptions }, false);
}

(async () => {
  const tab = await activeTab();
  if (!tab) return;
  state.tabId = tab.id;
  state.host = hostOf(tab.url);

  const response = await ask(tab.id);
  state.payload = response.payload;
  state.locks = response.locks || {};
  state.allTabs = Boolean(response.allTabs);
  state.enabled = response.enabled !== false;
  state.exceptions = response.exceptions || [];
  render();

  $('enabled').addEventListener('change', () => applySettings({ enabled: $('enabled').checked }));
  $('openExceptions').addEventListener('click', () => {
    $('views').classList.add('show-exceptions');
    syncHeight();
  });
  $('back').addEventListener('click', () => {
    $('views').classList.remove('show-exceptions');
    syncHeight();
  });
  document.querySelector('details').addEventListener('toggle', syncHeight);

  $('addForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('entry').value;
    $('entry').value = '';
    addException(value);
  });

  const button = $('reseed');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const t = await activeTab();
    if (!t) return;

    button.disabled = true;
    button.textContent = 'Rolling a new identity…';

    chrome.runtime.sendMessage({ type: 'reseed', tabId: t.id }, (reply) => {
      button.disabled = false;
      button.textContent = 'New identity for this tab';

      if (reply && reply.payload) {
        state.payload = reply.payload;
        state.locks = reply.locks || {};
        render();
        flash();
        return;
      }
      ask(t.id).then((next) => {
        state.payload = next.payload;
        state.locks = next.locks || {};
        render();
        flash();
      });
    });
  });

  document.querySelectorAll('.lock').forEach((box) => {
    box.addEventListener('change', async () => {
      const t = await activeTab();
      if (!t) {
        box.checked = !box.checked;
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'lock', tabId: t.id, field: box.dataset.field, locked: box.checked, allTabs: $('allTabs').checked },
        (reply) => {
          if (!reply) return;
          state.payload = reply.payload;
          state.locks = reply.locks || {};
          state.allTabs = Boolean(reply.allTabs);
          render();
        },
      );
    });
  });

  $('allTabs').addEventListener('change', async () => {
    const t = await activeTab();
    if (!t) return;
    chrome.runtime.sendMessage(
      { type: 'lockScope', tabId: t.id, allTabs: $('allTabs').checked },
      (reply) => {
        if (!reply) return;
        state.payload = reply.payload;
        state.locks = reply.locks || {};
        state.allTabs = Boolean(reply.allTabs);
        render();
      },
    );
  });
})();
