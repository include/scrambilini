<p align="center">
  <img src="images/scrambilini.png" width="200" alt="Scrambilini">
</p>

# Scrambilini

Two browser extensions, one core: **Scrambilini for Chrome** and **Scrambilini
for Firefox**. Both give every tab its own browser fingerprint. The same tab
keeps one coherent identity across reloads and navigations, and a new tab gets a
new one — so fingerprinting services see a different, internally consistent
device each time you open a tab.

| | Chrome | Firefox |
| --- | --- | --- |
| Folder | [`chrome/`](chrome) | [`firefox/`](firefox) |
| Identity | Chrome UAs + `sec-ch-ua*` client hints | Firefox UAs, `buildID`, `oscpu`, no client hints |
| Background | service worker | event page (`background.scripts`) |
| Load | `chrome://extensions` → Load unpacked | `about:debugging` → Load Temporary Add-on |

Both sides of the fingerprint are scrambled and kept in agreement:

- **JavaScript surface** — `navigator`, screen, timezone, languages, canvas,
  WebGL, WebGPU adapter info, audio, fonts, plugins, battery, connection, media
  devices, storage quota, speech voices, keyboard layout, `Intl` locale.
- **HTTP surface** — `User-Agent`, `Accept-Language`, `DNT` (plus `sec-ch-ua*`
  on Chrome), sent through `declarativeNetRequest` header rules.

A tab can come out as macOS, Windows or Linux, and everything that gives the
platform away moves together: the UA string, `navigator.platform`, the platform
hints, the GPU strings, the plausible screen sizes and the set of system fonts
the page can enumerate. Each build only defines the APIs its browser really has:
the Chrome build exposes `userAgentData`, `deviceMemory`, `connection`,
`navigator.keyboard` and plugins, and the Firefox build exposes `buildID`,
`oscpu` and `productSub: 20100101` instead — claiming the other browser's API
surface would be a louder tell than the value being wrong.

The two are derived from the same seed with the same pure function
(`shared/src/shared/profile.js`), so the headers a server sees and the values a
page reads describe the same machine.

<p align="center">
  <img src="images/scrambilini-rand.png" width="250" alt="A fresh identity in the popup">
  <img src="images/scrambilini-attributes.png" width="250" alt="The full attribute list">
  <img src="images/scrambilini-lang-lock.png" width="250" alt="The language pinned for all tabs">
</p>

<p align="center"><sub>a fresh identity · the full attribute list · a language pinned for all tabs</sub></p>

## How it works

```
tabs.onCreated ──► service worker mints a seed ──► DNR session rule (per tab)
                        │                                  │
                        │                                  └─► first request already spoofed
                        ▼
             content script asks for the seed
                        │
                        ▼
      MAIN-world script builds the profile from that seed
      and patches the APIs a fingerprinter reads
```

- **`shared/src/background.js`** owns identities. It mints a seed the moment a
  tab is created (so even the tab's first navigation carries the spoofed
  headers), stores it in session storage under `tab:<tabId>`, and installs a
  per-tab `declarativeNetRequest` session rule (`id = 900000 + tabId`). All
  mutations for a tab are serialised through a per-tab promise queue. The same
  file runs as a Chrome service worker and as a Firefox event page.
- **`shared/src/content/bridge.js`** (isolated world, `document_start`) gets the
  tab's seed and hands it to the page. It reads the seed straight out of session
  storage where that is allowed (Chrome) and asks the worker in parallel; the
  worker's answer wins if the two ever disagree. Firefox does not expose session
  storage to content scripts, so there the hand-off is the message round trip.
- **`shared/src/content/scramble.js`** (MAIN world, `document_start`) builds the
  profile and replaces the getters/methods fingerprinters use. Until the worker
  answers it uses a provisional seed, then swaps the profile in place; every
  getter reads the live profile object, so the swap is cheap. Patched functions
  report `[native code]` through a patched `Function.prototype.toString`.
- **`shared/src/shared/profile.js`** is the deterministic
  `(seed, realUserAgent) → profile` builder shared by the worker and the page.
  It knows which browser it was built for and only emits values that browser
  really has.
- **`shared/src/popup.html` / `popup.js`** show the current tab's identity and
  can roll a new one. Each row has a tick box that locks that value, so a
  scramble keeps it. The page swaps the identity in place, so the popup stays
  open and shows the new values immediately.

`shared/src` is the source of truth. `make sync` copies it into `chrome/src`
and `firefox/src` and writes each build's `browser.js`; the copies are committed
so both folders load without a build step.

## Install

There is **no build step**: `chrome/` and `firefox/` are complete extensions and
the browser loads them directly. Nothing has to be installed to use them.

The test harnesses and the icon tool are TypeScript and run on
[Bun](https://bun.sh):

```bash
bun install      # only for the tests and the icon tool
```

`make build` packages both zips, `make release` adds their SHA-256, `make icons`
rebuilds `shared/icons/` from the artwork. `make` on its own prints the targets.
None of that is needed to load either extension.

### Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `chrome/` folder — the one that contains `manifest.json`.

Chrome will **not** install a `.zip` by dragging it. `make release` writes
`dist/scrambilini-chrome-<version>.zip`; a built copy is also on the
[releases page](https://github.com/include/scrambilini/releases).

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Pick `firefox/manifest.json`.

Temporary add-ons last until Firefox restarts. For a permanent install, the
build has to be signed (`web-ext sign`) or loaded from Developer Edition /
Nightly with signing disabled; `dist/scrambilini-firefox-<version>.zip` is the
same files zipped.

Every new tab gets a new identity automatically. Reloading a tab keeps the
identity it already has. Use the toolbar popup to see it or to roll a new one.

## Locking a value

The popup has a small tick box on the right of every row. Tick one and that
value is kept the next time you scramble; everything else is drawn again.

The rows are the headline values. **All attributes (25)** at the bottom expands
the full list the tab reports: platform version, client hints, architecture,
WebGL limits, fonts, voices, keyboard, storage, battery and the rest. Long
values are clamped in the headline rows and shown in full there.

For example: scramble until the languages look right, tick **Languages**, then
press **New identity for this tab** again. The languages stay put while the user
agent, screen, timezone, hardware and GPU come from the new seed, and the
canvas/audio noise changes as usual.

- Ticking a row does not change the current identity. It stores the value the
  tab already has.
- Unticking lets the seed decide that value again, so it can change at that
  moment. The popup and the page stay in step either way.
- **Lock for all tabs** is on by default: a pin is shared by every tab and kept
  after a restart. Untick it to keep new pins to the current tab only; untick a
  row in a single tab to opt that tab out of a shared pin without touching the
  others.
- With the switch off, locks belong to the tab: a new tab starts unlocked, and
  the locks are forgotten when the tab closes.
- A locked screen or GPU also pins the platform that owns it (macOS, Windows or
  Linux), so you do not end up with a Mac screen on a Windows user agent.
- Shared locks live in `chrome.storage.local` under `locks:global`; per-tab
  locks and per-tab opt-outs live in `chrome.storage.session` under
  `locks:<tabId>`. Both are applied by the same profile builder, so the headers
  follow the locks too.

## Turning it off, and exceptions

The switch in the header turns scrambling off for every tab. Headers go back to
the real ones, the APIs are left alone, and the popup says so. Turning it back
on restores the same per-tab identity the tab had before.

**Exceptions** (the link at the bottom of the popup) is the per-site version.
Add `www.sapo.pt` and that host keeps its real identity; add `*.gmail.com` and
gmail.com plus every subdomain do. The list is global and survives restarts;
removing an entry puts the site back under scrambling.

An exception is applied in two places: the per-tab header rule excludes those
domains, so no spoofed headers are sent to or from them, and the page script is
registered with `excludeMatches`, so the APIs are never patched there. The
bridge still runs on those sites, only to remove any seed a previous visit left
in `sessionStorage`.

## How the values are chosen

There are two separate steps, and the split is the whole design.

**Step 1 — one real random seed per tab.** The service worker calls
`crypto.getRandomValues` and gets 128 bits (`randomSeed` in
`shared/src/background.js`). This happens in `tabs.onCreated`, before the tab navigates,
so the very first request already carries the spoofed headers.

**Step 2 — everything else is deterministic from that seed.** The profile builder
turns the seed into a number and runs a small PRNG over it (`build` in
`shared/src/shared/profile.js`):

```js
const rnd = mulberry32(hashSeed(seed)());
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const ri = (min, max) => min + Math.floor(rnd() * (max - min + 1));
```

Each `pick`/`ri` call takes the next number from that sequence. The result:

- **Same seed, same identity, always.** That is why the worker (which writes the
  headers) and the page (which reads `navigator.*`) agree without ever sending
  the profile to each other.
- **Reload keeps the identity**, because the seed is reused from storage.
- **Reseed makes a new identity**, because it makes a new random seed.
- There is no `Math.random()` anywhere in the profile.

## Static lists or made up on the spot?

A mix of all three:

| Kind | Examples | Where |
| --- | --- | --- |
| **Static catalog** (hand-written) | 3 operating systems, 31 screen sizes, 18 GPU strings with matching WebGPU adapters, 65 system font names, 44 macOS / 12 Windows / 12 Linux speech voices, 5 keyboard layouts, 6 core counts, 3 RAM sizes, 24 timezones, 17 language sets | `SYSTEMS`, `VOICES`, `WEBGPU_INFO` in `profile.js` |
| **Picked from the catalog** | OS, screen, GPU, fonts, voices, keyboard layout, cores, memory, timezone, languages, color depth, sample rate, DNT, platform version | `build()` |
| **Derived on the spot** | Chrome version = `realMajor - 0..4`, Firefox version = `realMajor - 0..3`; `Accept-Language` built with `q=0.9/0.8/0.7`; `availHeight = height - 25..90`; the UA string for the chosen OS; Firefox `buildID`; media device ids as random 32-char hex; storage quota and usage; the canvas/audio noise salt | `build()` |
| **Kept real on purpose** | the UA format of the browser the build runs in, the client hint order, the `Chrome/xxx.0.0.0` shape | design choice |

Two honest notes:

- **The platform is scrambled, but only at the level a page can see.** The UA,
  `navigator.platform`, client hints, GPU strings and font list all move together,
  so a Windows identity does not leak Mac fonts through `document.fonts.check` or
  canvas text measurement. What cannot move is the real TLS/JA3 fingerprint and
  the real rendering engine, so a Windows UA still renders with Mac glyph shapes.
  That gap is invisible to the usual JS/HTTP fingerprinters, but it is not zero.
- **The visible entropy is finite.** The catalogs multiply to roughly 220 million
  combinations. What actually keeps two tabs apart is the canvas/audio noise salt,
  which is 32 bits derived from the seed (`build()`, `salt`).

## Verify

The `test/` folder drives a real browser with the extension loaded. It is
TypeScript on Bun: Playwright for Chrome, Selenium + geckodriver for Firefox.

```bash
bun install     # once
bun run test/firefox.ts       # Firefox: temporary add-on, Firefox identities

# one at a time
bun run test/navtiming.ts     # headers at various delays after tab creation
bun run test/coherence.ts     # UA, platform hints, fonts and headers agree
bun run test/attributes.ts    # locale, speech voices and keyboard follow the identity
bun run test/reseed.ts        # reload keeps the identity, reseed changes it
bun run test/popup.ts         # the popup rolls and stays open
bun run test/locks.ts         # tick boxes survive a scramble and a reload
bun run test/persistence.ts   # "Lock for all tabs" survives new tabs and restarts
bun run test/toggle.ts        # the on/off switch
bun run test/exceptions.ts    # excepted sites keep their real identity
bun run test/amiunique.ts 3   # three tabs on amiunique.org

# or everything in order
make test
```

`bun run test/probe.ts [url ...]` prints what the page sees for any URL, and
`bun run test/debug.ts` dumps the tab seed, the stored seed and the installed
header rules.

`amiunique.ts` prints each tab's UA, language, cores, memory, screen and GPU
plus whether the HTTP headers and the JavaScript values agree, then reports how
many distinct identities it saw.

`coherence.ts` checks the things that have to agree with each other: the UA and
`navigator.platform` and `navigator.userAgentData.platform`, the
`sec-ch-ua-platform` header, and the font list (`document.fonts.check` and
canvas text measurement) against the platform the identity claims.

`firefox.ts` loads `firefox/` as a temporary add-on and checks that the identity
is a Firefox one: a `Firefox/` UA, `productSub: 20100101`, `buildID` and
`oscpu` present, and no `userAgentData`, `deviceMemory`, `connection`,
`getBattery` or client hints.

## Limitations

- **The first few milliseconds of a document** use a provisional identity: the
  page can only learn the tab seed asynchronously, so a script that runs before
  the hand-off lands (an inline `<script>` at the top of the document) sees a
  different — still internally consistent — identity than the request headers.
  The hand-off lands roughly 3–5 ms after the document starts, so anything that
  fingerprints on `DOMContentLoaded`/`load`, which is what real libraries do,
  gets the adopted identity.
- **A navigation started within a few milliseconds of a tab being created** can
  beat the header rule into place. In practice a tab is created long before a
  user navigates; the window only shows up in synthetic tests.
- **Only what a page can see is spoofed.** TLS/JA3, TCP/IP, and anything the
  browser exposes outside the patched APIs (e.g. `chrome.*`, permissions that
  are denied rather than faked) are untouched. The Firefox build has Firefox's
  TLS fingerprint, which is why it claims to be Firefox.
- **Firefox has no `storage.session` access from content scripts** (no
  `setAccessLevel`), so the seed hand-off there is the message round trip rather
  than the storage fast path: a few milliseconds slower, same result.
- **Firefox needs a signed build to install permanently.** `about:debugging`
  loads it temporarily; for a normal install the zip has to be signed with
  `web-ext sign` or loaded on Developer Edition / Nightly.
- **Canvas/WebGL/audio noise is deterministic per tab**, not per read, so the
  same tab keeps returning the same values.
- **Only the font list is faked, not the glyphs.** `document.fonts.check` and
  canvas text measurement follow the identity's platform. The text a page
  actually draws still uses the real system fonts of the machine.
- **A few attributes are deliberately left real.** `canPlayType`, media
  capabilities and permission states are identical on every Chrome build of the
  same version, so spoofing them would add risk (broken playback, odd prompts)
  for no entropy. They do not tell your tabs apart. The same goes for the WebGL
  extension list, shader precision, `performance.memory` and
  `screen.orientation`: measured on this Chrome, they are constants, so faking
  them would only add a way to get them wrong.
- **WebGPU reports the identity's adapter.** `navigator.gpu.requestAdapter()
  .info` follows the GPU the tab claims: `apple`/`metal-3` for a Mac identity,
  `nvidia`/`ampere`, `intel`/`gen-12lp` or `amd`/`rdna-2` for the others.
- **Speech voices, the `Intl` locale and the keyboard layout are per tab.** The
  voice set is a seed-chosen subset of the platform catalog, dates and numbers
  format in the identity's language, and `navigator.keyboard` reports the layout
  that goes with it (AZERTY for French, QWERTZ for German, otherwise QWERTY).

## Layout

```
shared/src/              the source of truth for both builds
  background.js          seeds, DNR rules, locks, reseed
  shared/profile.js      deterministic profile builder (worker + page)
  content/bridge.js      isolated-world seed hand-off
  content/scramble.js    MAIN-world API patching
  shared/matcher.js      exceptions: *.gmail.com / exact host matching
  popup.html/.js         identity inspector, locks, reseed
shared/icons/            icon16/32/48/128.png, generated by tools/icons.ts
chrome/                  Chrome extension: manifest.json + generated src/ icons/
firefox/                 Firefox extension: manifest.json + generated src/ icons/
tools/sync.ts            copies shared/ into chrome/ and firefox/
tools/icons.ts           crops and resizes images/scrambilini.png into icons/
tools/check.ts           manifests, sync, syntax and profile-builder checks
images/                  the artwork and the screenshots in this README
test/                    Bun harnesses; the Chrome ones use Playwright and the
                         Firefox one uses Selenium + geckodriver
dist/                    the two zips — ignored, built by make release
```
