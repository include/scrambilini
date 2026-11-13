const $ = (id) => document.getElementById(id);

const LOCKABLE = ['ua', 'screen', 'timezone', 'languages', 'hardware', 'gpu'];

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

function ask(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getProfile', tabId }, (response) => {
      resolve(response || { payload: null, locks: {}, allTabs: false });
    });
  });
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

function setValue(id, value) {
  const el = $(id);
  el.textContent = value;
  el.title = value;
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

function render(payload, locks, allTabs) {
  renderLocks(locks);
  renderDetails(payload);
  $('allTabs').checked = Boolean(allTabs);
  const dot = $('dot');
  if (!payload) {
    dot.classList.add('off');
    $('seed').textContent = 'not active on this page';
    return;
  }
  dot.classList.remove('off');
  setValue('seed', payload.seed.slice(0, 24));
  setValue('ua', payload.ua);
  setValue('screen', payload.screen);
  setValue('tz', payload.timezone || 'system default');
  setValue('langs', (payload.languages || []).join(', '));
  setValue('hw', `${payload.cores} cores · ${payload.memory} GB`);
  setValue('gpu', payload.gpu);
}

(async () => {
  const tab = await activeTab();
  if (!tab) return render(null, null, false);
  const state = await ask(tab.id);
  render(state.payload, state.locks, state.allTabs);

  const button = $('reseed');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const t = await activeTab();
    if (!t) return;

    button.disabled = true;
    button.textContent = 'Rolling a new identity…';

    chrome.runtime.sendMessage({ type: 'reseed', tabId: t.id }, (response) => {
      button.disabled = false;
      button.textContent = 'New identity for this tab';

      if (response && response.payload) {
        render(response.payload, response.locks, response.allTabs);
        flash();
        return;
      }
      ask(t.id).then((state) => {
        render(state.payload, state.locks, state.allTabs);
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
        (response) => {
          if (!response) return;
          render(response.payload, response.locks, response.allTabs);
        },
      );
    });
  });

  $('allTabs').addEventListener('change', async () => {
    const t = await activeTab();
    if (!t) return;
    chrome.runtime.sendMessage(
      { type: 'lockScope', tabId: t.id, allTabs: $('allTabs').checked },
      (response) => {
        if (!response) return;
        render(response.payload, response.locks, response.allTabs);
      },
    );
  });
})();
