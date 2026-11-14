/*
 * Scrambilini — MAIN world fingerprint scrambler.
 *
 * Runs at document_start in every frame. Builds one deterministic profile from a
 * per-tab seed and patches the APIs fingerprinting scripts read.
 *
 * The seed is owned by the service worker (one per tab) and handed to the page
 * right after start-up, so the HTTP header rules installed for the tab and the
 * values JS reports describe the same device. Until that hand-off lands we use a
 * provisional seed; every getter reads the live profile, so the swap is cheap.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Feature flags for the noisy surfaces. (Header-bearing fields — UA, client
  // hints, languages, DNT — are always spoofed so they stay in sync.)
  // ---------------------------------------------------------------------------
  const CONFIG = {
    spoofScreen: true,
    spoofHardware: true,
    spoofCanvas: true,
    spoofWebGL: true,
    spoofAudio: true,
    spoofFonts: true,
    spoofPlugins: true,
  };

  const SEED_KEY = '__scrambilini_seed';
  const REAL_UA_KEY = '__scrambilini_real_ua';
  const LOCKS_KEY = '__scrambilini_locks';
  const HEADER_KEY = '__scrambilini_headers';
  const MAX_NOISE_PIXELS = 4_000_000;

  if (window.__scrambiliniLoaded) return;
  Object.defineProperty(window, '__scrambiliniLoaded', { value: true, configurable: true });

  const buildProfile = __scrambiliniBuildProfile;
  try { delete window.__scrambiliniBuildProfile; } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------------------
  // Seed
  // ---------------------------------------------------------------------------
  const isTop = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();

  function randomSeed() {
    const a = new Uint32Array(4);
    crypto.getRandomValues(a);
    return Array.from(a, (n) => n.toString(16).padStart(8, '0')).join('');
  }

  function provisionalSeed() {
    try {
      const existing = sessionStorage.getItem(SEED_KEY);
      if (existing) return existing;
    } catch (e) { /* storage blocked */ }
    try {
      if (!isTop && window.top.__scrambiliniSeed) return window.top.__scrambiliniSeed;
    } catch (e) { /* cross-origin */ }
    return randomSeed();
  }

  const realUA = navigator.userAgent;
  const realDPR = window.devicePixelRatio || 1;
  const realInnerW = window.innerWidth;
  const realInnerH = window.innerHeight;
  const realOuterW = window.outerWidth || realInnerW;
  const realOuterH = window.outerHeight || realInnerH;

  let seed = provisionalSeed();

  /** Fields the user locked in the popup, if any. */
  function readLocks() {
    try {
      const raw = sessionStorage.getItem(LOCKS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  let locks = readLocks();
  const P = buildProfile(seed, realUA, locks);

  // Geometry is the only part that leans on the real device; everything else is
  // pool-derived so the service worker can reproduce it exactly.
  const geoRnd = (() => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  })();

  function applyGeometry() {
    const ri = (min, max) => min + Math.floor(geoRnd() * (max - min + 1));
    P.iw = isTop ? realInnerW + ri(0, 2) : realInnerW;
    P.ih = isTop ? realInnerH + ri(0, 2) : realInnerH;
    P.ow = realOuterW + ri(-2, 2);
    P.oh = realOuterH + ri(-2, 2);
    P.sx = ri(0, 40);
    P.sy = ri(0, 40);
    P.dpr = CONFIG.spoofScreen ? P.dpr : realDPR;
  }
  applyGeometry();

  function persistSeed() {
    try { sessionStorage.setItem(SEED_KEY, seed); } catch (e) { /* ignore */ }
    try { window.__scrambiliniSeed = seed; } catch (e) { /* ignore */ }
    try {
      if (locks && Object.keys(locks).length) {
        sessionStorage.setItem(LOCKS_KEY, JSON.stringify(locks));
      } else {
        sessionStorage.removeItem(LOCKS_KEY);
      }
    } catch (e) { /* ignore */ }
  }
  persistSeed();

  // ---------------------------------------------------------------------------
  // Native-looking wrappers
  // ---------------------------------------------------------------------------
  const nativeToString = Function.prototype.toString;
  const fakeSources = new WeakMap();

  function mark(fn, name) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      fakeSources.set(fn, `function ${name}() { [native code] }`);
    } catch (e) { /* ignore */ }
    return fn;
  }

  Function.prototype.toString = mark(function toString() {
    if (fakeSources.has(this)) return fakeSources.get(this);
    return nativeToString.call(this);
  }, 'toString');

  function defineGetter(target, prop, getter, name) {
    try {
      Object.defineProperty(target, prop, {
        get: mark(getter, `get ${name || prop}`),
        configurable: true,
        enumerable: true,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function defineWindowGetter(prop, getter) {
    if (defineGetter(window, prop, getter)) return;
    try { defineGetter(Object.getPrototypeOf(window), prop, getter); } catch (e) { /* ignore */ }
  }

  function defineMethod(target, prop, fn, name) {
    try {
      Object.defineProperty(target, prop, {
        value: mark(fn, name || prop),
        configurable: true,
        writable: true,
      });
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // navigator
  // ---------------------------------------------------------------------------
  const N = Navigator.prototype;
  const CAPS = P.caps || {};
  defineGetter(N, 'userAgent', () => P.ua);
  defineGetter(N, 'appVersion', () => P.appVersion);
  defineGetter(N, 'appName', () => 'Netscape');
  defineGetter(N, 'appCodeName', () => 'Mozilla');
  defineGetter(N, 'product', () => 'Gecko');
  defineGetter(N, 'productSub', () => P.productSub);
  defineGetter(N, 'vendor', () => P.vendor);
  defineGetter(N, 'vendorSub', () => '');
  defineGetter(N, 'platform', () => P.platform);
  defineGetter(N, 'language', () => P.languages[0]);
  defineGetter(N, 'languages', () => Object.freeze(P.languages.slice()));
  defineGetter(N, 'hardwareConcurrency', () => P.cores);
  defineGetter(N, 'maxTouchPoints', () => 0);
  defineGetter(N, 'cookieEnabled', () => true);
  defineGetter(N, 'onLine', () => true);
  defineGetter(N, 'doNotTrack', () => P.doNotTrack);
  defineGetter(N, 'webdriver', () => false);

  // APIs that only one of the browsers actually has. Defining one the browser
  // lacks would be a louder tell than leaving it alone.
  if (CAPS.deviceMemory) defineGetter(N, 'deviceMemory', () => P.memory);
  if (CAPS.pdfViewer) defineGetter(N, 'pdfViewerEnabled', () => true);
  if (P.oscpu) defineGetter(N, 'oscpu', () => P.oscpu);
  if (P.buildID) defineGetter(N, 'buildID', () => P.buildID);

  defineMethod(N, 'javaEnabled', () => false);

  const uaData = {
    get brands() { return P.brands; },
    mobile: false,
    get platform() { return P.uaPlatform; },
    getHighEntropyValues(hints) {
      const out = { brands: P.brands, mobile: false, platform: P.uaPlatform };
      for (const hint of hints || []) {
        if (hint in P.highEntropy) out[hint] = P.highEntropy[hint];
      }
      return Promise.resolve(out);
    },
    toJSON() {
      return { brands: P.brands, mobile: false, platform: P.uaPlatform };
    },
  };
  if (CAPS.userAgentData) defineGetter(N, 'userAgentData', () => uaData);

  // Plugins / mime types (the standard Chromium PDF viewer set)
  if (CONFIG.spoofPlugins && CAPS.plugins) {
    const PLUGIN_DEFS = [
      ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'],
    ];
    const MIME_DEFS = [
      ['application/pdf', 'Portable Document Format', 'pdf'],
      ['text/pdf', 'Portable Document Format', 'pdf'],
    ];

    const makeMimeArray = () => {
      const arr = MIME_DEFS.map(([type, description, suffixes]) => ({
        type, description, suffixes, enabledPlugin: null,
      }));
      const obj = {
        length: arr.length,
        item: (i) => arr[i] || null,
        namedItem: (n) => arr.find((m) => m.type === n) || null,
      };
      arr.forEach((m, i) => { obj[i] = m; });
      obj[Symbol.iterator] = function* iterate() { for (let i = 0; i < arr.length; i++) yield arr[i]; };
      return obj;
    };

    const plugins = PLUGIN_DEFS.map(([name, filename, description]) => {
      const mimes = makeMimeArray();
      return {
        name, filename, description, length: mimes.length,
        item: (i) => mimes[i] || null,
        namedItem: (n) => mimes.namedItem(n),
      };
    });
    const pluginArray = {
      length: plugins.length,
      item: (i) => plugins[i] || null,
      namedItem: (n) => plugins.find((p) => p.name === n) || null,
      refresh: () => {},
    };
    plugins.forEach((p, i) => { pluginArray[i] = p; });
    pluginArray[Symbol.iterator] = function* iterate() { for (let i = 0; i < plugins.length; i++) yield plugins[i]; };

    defineGetter(N, 'plugins', () => pluginArray);
    defineGetter(N, 'mimeTypes', () => makeMimeArray());
  }

  if (CAPS.connection) defineGetter(N, 'connection', () => P.connection);
  if (CAPS.battery) defineMethod(N, 'getBattery', () => Promise.resolve(P.battery));

  if (window.MediaDevices) {
    defineMethod(MediaDevices.prototype, 'enumerateDevices', function enumerateDevices() {
      return Promise.resolve(P.devices.map((d) => ({ ...d })));
    });
  }

  if (window.StorageManager) {
    defineMethod(StorageManager.prototype, 'estimate', function estimate() {
      return Promise.resolve({ quota: P.quota, usage: P.usage, usageDetails: {} });
    });
  }

  // ---------------------------------------------------------------------------
  // Keyboard layout
  //
  // getLayoutMap() is a quiet high-entropy signal: a laptop's layout follows the
  // user around and links every tab. It is derived from the identity's language.
  // ---------------------------------------------------------------------------
  const QWERTY = {
    Backquote: '`', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
    Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0', Minus: '-',
    Equal: '=', KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y',
    KeyU: 'u', KeyI: 'i', KeyO: 'o', KeyP: 'p', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g',
    KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l', Semicolon: ';', Quote: "'",
    KeyZ: 'z', KeyX: 'x', KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: 'm',
    Comma: ',', Period: '.', Slash: '/', Space: ' ',
  };

  const LAYOUT_OVERRIDES = {
    gb: { Digit2: '"', Digit3: '£' },
    fr: {
      Digit1: '&', Digit2: 'é', Digit3: '"', Digit4: "'", Digit5: '(', Digit6: '-',
      Digit7: 'è', Digit8: '_', Digit9: 'ç', Digit0: 'à', Minus: ')', Equal: '=',
      KeyQ: 'a', KeyW: 'z', KeyA: 'q', KeyZ: 'w', KeyM: ',', Semicolon: 'm',
      Quote: 'ù', Comma: ';', Period: ':', Slash: '!', BracketLeft: '^',
      BracketRight: '$', Backslash: '*', Backquote: '²',
    },
    de: {
      KeyY: 'z', KeyZ: 'y', Semicolon: 'ö', Quote: 'ä', BracketLeft: 'ü',
      BracketRight: '+', Backslash: '#', Minus: 'ß', Equal: '´', Slash: '-',
      Backquote: '^',
    },
    br: { Semicolon: 'ç', Quote: '~', BracketLeft: '´', BracketRight: '[', Slash: ';' },
  };

  if (CAPS.keyboard && window.Keyboard && Keyboard.prototype.getLayoutMap) {
    defineMethod(Keyboard.prototype, 'getLayoutMap', function getLayoutMap() {
      const layout = Object.assign({}, QWERTY, LAYOUT_OVERRIDES[P.keyboard] || {});
      return Promise.resolve(new Map(Object.entries(layout)));
    }, 'getLayoutMap');
  }

  // ---------------------------------------------------------------------------
  // Speech synthesis voices
  //
  // Real installs have different voice sets, and the set is a strong identifier.
  // Each identity gets a seed-chosen subset of its platform's catalog.
  // ---------------------------------------------------------------------------
  if (window.SpeechSynthesis && window.SpeechSynthesis.prototype.getVoices) {
    defineMethod(SpeechSynthesis.prototype, 'getVoices', function getVoices() {
      return (P.voices || []).map((voice) => Object.assign({}, voice));
    }, 'getVoices');
  }

  // ---------------------------------------------------------------------------
  // Screen / window geometry
  // ---------------------------------------------------------------------------
  if (CONFIG.spoofScreen) {
    const S = Screen.prototype;
    defineGetter(S, 'width', () => P.sw);
    defineGetter(S, 'height', () => P.sh);
    defineGetter(S, 'availWidth', () => P.sw);
    defineGetter(S, 'availHeight', () => P.availHeight);
    defineGetter(S, 'availLeft', () => 0);
    defineGetter(S, 'availTop', () => 0);
    defineGetter(S, 'colorDepth', () => P.colorDepth);
    defineGetter(S, 'pixelDepth', () => P.colorDepth);

    defineWindowGetter('devicePixelRatio', () => P.dpr);
    defineWindowGetter('outerWidth', () => P.ow);
    defineWindowGetter('outerHeight', () => P.oh);
    defineWindowGetter('screenX', () => P.sx);
    defineWindowGetter('screenY', () => P.sy);
    defineWindowGetter('screenLeft', () => P.sx);
    defineWindowGetter('screenTop', () => P.sy);
    if (isTop) {
      defineWindowGetter('innerWidth', () => P.iw);
      defineWindowGetter('innerHeight', () => P.ih);
    }
  }

  try {
    const clientW = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    const clientH = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    if (clientW && clientW.get) {
      Object.defineProperty(Element.prototype, 'clientWidth', {
        get: mark(function get() {
          const v = clientW.get.call(this);
          return this === document.documentElement ? v + 1 : v;
        }, 'get clientWidth'),
        configurable: true,
        enumerable: true,
      });
    }
    if (clientH && clientH.get) {
      Object.defineProperty(Element.prototype, 'clientHeight', {
        get: mark(function get() {
          const v = clientH.get.call(this);
          return this === document.documentElement ? v + 1 : v;
        }, 'get clientHeight'),
        configurable: true,
        enumerable: true,
      });
    }
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------------------
  // Canvas noise
  // ---------------------------------------------------------------------------
  function clampByte(n) {
    return n < 0 ? 0 : n > 255 ? 255 : n;
  }

  function addNoise(data, w, h, salt) {
    const total = w * h;
    if (!total || total > MAX_NOISE_PIXELS) return;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        let hsh = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ salt) | 0;
        hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
        data[i] = clampByte(data[i] + ((hsh >>> 24) & 3) - 1);
        data[i + 1] = clampByte(data[i + 1] + ((hsh >>> 16) & 3) - 1);
        data[i + 2] = clampByte(data[i + 2] + ((hsh >>> 8) & 3) - 1);
      }
    }
  }

  if (CONFIG.spoofCanvas && window.CanvasRenderingContext2D) {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    defineMethod(CanvasRenderingContext2D.prototype, 'getImageData', function getImageData() {
      const img = origGetImageData.apply(this, arguments);
      addNoise(img.data, img.width, img.height, P.salt);
      return img;
    }, 'getImageData');

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    defineMethod(HTMLCanvasElement.prototype, 'toDataURL', function toDataURL() {
      try {
        const w = this.width;
        const h = this.height;
        if (w && h && w * h <= MAX_NOISE_PIXELS) {
          const off = document.createElement('canvas');
          off.width = w;
          off.height = h;
          const ctx = off.getContext('2d');
          if (ctx) {
            ctx.drawImage(this, 0, 0);
            const img = origGetImageData.call(ctx, 0, 0, w, h);
            addNoise(img.data, w, h, P.salt);
            ctx.putImageData(img, 0, 0);
            return origToDataURL.apply(off, arguments);
          }
        }
      } catch (e) { /* fall through */ }
      return origToDataURL.apply(this, arguments);
    }, 'toDataURL');

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    defineMethod(HTMLCanvasElement.prototype, 'toBlob', function toBlob() {
      try {
        const w = this.width;
        const h = this.height;
        if (w && h && w * h <= MAX_NOISE_PIXELS) {
          const off = document.createElement('canvas');
          off.width = w;
          off.height = h;
          const ctx = off.getContext('2d');
          if (ctx) {
            ctx.drawImage(this, 0, 0);
            const img = origGetImageData.call(ctx, 0, 0, w, h);
            addNoise(img.data, w, h, P.salt);
            ctx.putImageData(img, 0, 0);
            return origToBlob.apply(off, arguments);
          }
        }
      } catch (e) { /* fall through */ }
      return origToBlob.apply(this, arguments);
    }, 'toBlob');
  }

  // ---------------------------------------------------------------------------
  // WebGL
  // ---------------------------------------------------------------------------
  if (CONFIG.spoofWebGL) {
    const C = {
      VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, SHADING: 0x8b8c,
      UNMASKED_VENDOR: 0x9245, UNMASKED_RENDERER: 0x9246,
      MAX_TEXTURE_SIZE: 0x0d33, MAX_CUBE: 0x851c, MAX_TEX_UNITS: 0x8872,
      MAX_VERTEX_UNIFORMS: 0x8dfb, MAX_VARYING: 0x8dfc, MAX_ATTRIBS: 0x8869,
      MAX_COMBINED: 0x8b4d, MAX_VIEWPORT: 0x0d3a,
    };

    function patchGL(proto) {
      if (!proto) return;
      const origGetParameter = proto.getParameter;
      defineMethod(proto, 'getParameter', function getParameter(p) {
        switch (p) {
          case C.VENDOR:
          case C.UNMASKED_VENDOR: return P.glVendor;
          case C.RENDERER:
          case C.UNMASKED_RENDERER: return P.glRenderer;
          case C.VERSION: return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
          case C.SHADING: return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
          case C.MAX_TEXTURE_SIZE: return P.maxTexSize;
          case C.MAX_CUBE: return P.maxCube;
          case C.MAX_TEX_UNITS: return P.maxTexUnits;
          case C.MAX_VERTEX_UNIFORMS: return P.maxVertexUniforms;
          case C.MAX_VARYING: return P.maxVarying;
          case C.MAX_ATTRIBS: return P.maxVertexAttribs;
          case C.MAX_COMBINED: return P.maxCombined;
          case C.MAX_VIEWPORT: return new Int32Array([P.maxTexSize, P.maxTexSize]);
          default: return origGetParameter.call(this, p);
        }
      }, 'getParameter');

      const origReadPixels = proto.readPixels;
      defineMethod(proto, 'readPixels', function readPixels(x, y, w, h) {
        const out = origReadPixels.apply(this, arguments);
        const pixels = arguments[6];
        if (pixels && pixels.length && w * h <= MAX_NOISE_PIXELS) {
          addNoise(pixels, w, h, P.salt);
        }
        return out;
      }, 'readPixels');
    }

    patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  }

  // ---------------------------------------------------------------------------
  // WebGPU
  //
  // The adapter info is reported straight by the driver, so it has to follow the
  // GPU the identity claims; otherwise a Windows identity still says "apple".
  // ---------------------------------------------------------------------------
  if (window.GPUAdapter && window.GPUAdapter.prototype) {
    defineGetter(GPUAdapter.prototype, 'info', () => Object.assign({}, P.webgpu), 'info');
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------
  if (CONFIG.spoofAudio && window.BaseAudioContext) {
    defineGetter(BaseAudioContext.prototype, 'sampleRate', () => P.sampleRate);

    if (window.AnalyserNode) {
      const origFloat = AnalyserNode.prototype.getFloatFrequencyData;
      defineMethod(AnalyserNode.prototype, 'getFloatFrequencyData', function getFloatFrequencyData(arr) {
        origFloat.call(this, arr);
        if (!arr) return;
        for (let i = 0; i < arr.length; i++) {
          let h = Math.imul(i + 1, 2654435761) ^ P.salt;
          h = Math.imul(h ^ (h >>> 15), 2246822507);
          arr[i] += (((h >>> 16) & 255) / 255 - 0.5) * 0.05;
        }
      }, 'getFloatFrequencyData');

      const origByte = AnalyserNode.prototype.getByteFrequencyData;
      defineMethod(AnalyserNode.prototype, 'getByteFrequencyData', function getByteFrequencyData(arr) {
        origByte.call(this, arr);
        if (!arr) return;
        for (let i = 0; i < arr.length; i++) {
          let h = Math.imul(i + 1, 2654435761) ^ P.salt;
          h = Math.imul(h ^ (h >>> 15), 2246822507);
          arr[i] = clampByte(arr[i] + (((h >>> 16) & 3) - 1));
        }
      }, 'getByteFrequencyData');
    }

    if (window.OfflineAudioContext) {
      const origStart = OfflineAudioContext.prototype.startRendering;
      defineMethod(OfflineAudioContext.prototype, 'startRendering', function startRendering() {
        return origStart.call(this).then((buffer) => new Proxy(buffer, {
          get(target, prop) {
            if (prop === 'getChannelData') {
              return (channel) => {
                const data = target.getChannelData(channel);
                const copy = new Float32Array(data.length);
                copy.set(data);
                for (let i = 0; i < copy.length; i++) {
                  let h = Math.imul(i + 1, 2654435761) ^ P.salt;
                  h = Math.imul(h ^ (h >>> 15), 2246822507);
                  copy[i] += (((h >>> 16) & 255) / 255 - 0.5) * 1e-7;
                }
                return copy;
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }));
      }, 'startRendering');
    }
  }

  // ---------------------------------------------------------------------------
  // Fonts
  //
  // A Windows identity on a Mac would otherwise still enumerate Mac fonts, which
  // is a giveaway. Two surfaces are covered:
  //   - document.fonts.check() answers from the identity's font list;
  //   - canvas measureText() gives a small family-specific width for fonts the
  //     identity claims, and measures with the caller's generic fallback for
  //     system fonts it does not claim. That is exactly how measurement-based
  //     font detection decides "installed / not installed".
  // Web fonts and families outside the known system lists are left untouched,
  // so page code that measures custom text keeps working.
  // ---------------------------------------------------------------------------
  if (CONFIG.spoofFonts) {
    const lower = (s) => String(s || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    const GENERIC = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
      'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji',
      'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
    ]);
    const known = new Set(P.allFonts.map(lower));

    let fontCacheSeed = null;
    let identityFonts = null;
    function identitySet() {
      if (fontCacheSeed !== P.seed) {
        fontCacheSeed = P.seed;
        identityFonts = new Set(P.fonts.map(lower));
      }
      return identityFonts;
    }
    const identityHas = (family) => GENERIC.has(family) || identitySet().has(family);

    function familiesOf(font) {
      // "italic 700 16px/1.4 'Segoe UI', sans-serif" -> ["segoe ui", "sans-serif"]
      const m = /(?:\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%|in|cm|mm))\s*(?:\/\s*\S+\s*)?(.+)$/i.exec(String(font || ''));
      if (!m) return [];
      return m[1].split(',').map(lower).filter(Boolean);
    }

    function familyHash(name) {
      let h = 2166136261;
      for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    }

    if (window.FontFaceSet) {
      const origCheck = FontFaceSet.prototype.check;
      defineMethod(FontFaceSet.prototype, 'check', function check(font) {
        const families = familiesOf(font);
        const primary = families[0];
        if (!primary || !known.has(primary)) return origCheck.apply(this, arguments);
        return identityHas(primary);
      }, 'check');
    }

    if (window.CanvasRenderingContext2D) {
      const origMeasureText = CanvasRenderingContext2D.prototype.measureText;

      // Re-measure with one family swapped, keeping style/size intact.
      function withFamily(ctx, family) {
        const font = String(ctx.font || '');
        const m = /(?:\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%|in|cm|mm))\s*(?:\/\s*\S+\s*)?(.+)$/i.exec(font);
        if (!m) return null;
        ctx.font = font.slice(0, m.index + m[0].length - m[1].length) + family;
        return font;
      }

      defineMethod(CanvasRenderingContext2D.prototype, 'measureText', function measureText(text) {
        const families = familiesOf(this.font);
        const primary = families[0];
        let metrics;
        let delta = 0;
        // The font that was actually measured. For a font the identity does not
        // have this is the generic fallback, so the jitter below matches the
        // jitter of a plain baseline measurement and the two stay equal.
        let measured = this.font;

        if (primary && known.has(primary) && !identityHas(primary)) {
          const fallback = families.find((f) => GENERIC.has(f)) || 'monospace';
          const saved = withFamily(this, fallback);
          measured = this.font;
          try {
            metrics = origMeasureText.apply(this, arguments);
          } finally {
            if (saved) this.font = saved;
          }
        } else {
          metrics = origMeasureText.apply(this, arguments);
          if (primary && identityHas(primary) && !GENERIC.has(primary)) {
            delta = 0.5 + familyHash(primary) * 1.5;
          }
        }

        const key = `${P.seed}|${measured}|${String(text)}`;
        let h = 2166136261;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
        h = Math.imul(h ^ (h >>> 15), 2246822507);
        const jitter = (((h ^ (h >>> 13)) >>> 0) / 4294967296 - 0.5) * 0.8;

        return new Proxy(metrics, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop === 'width' && typeof value === 'number') return value + delta + jitter;
            if (typeof value === 'number' && String(prop).startsWith('actualBoundingBox')) {
              return value + (delta + jitter) * 0.5;
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }, 'measureText');
    }
  }

  // ---------------------------------------------------------------------------
  // Timezone
  // ---------------------------------------------------------------------------
  const RealDate = Date;
  let tzFormatters = null;
  let tzCached = null;
  const offsetCache = new Map();

  function tzState() {
    if (tzCached === P.timezone && tzFormatters) return tzFormatters;
    tzCached = P.timezone;
    offsetCache.clear();
    try {
      tzFormatters = {
        parts: new Intl.DateTimeFormat('en-US', {
          timeZone: P.timezone, hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }),
        name: new Intl.DateTimeFormat('en-US', { timeZone: P.timezone, timeZoneName: 'long' }),
      };
    } catch (e) {
      tzFormatters = null;
    }
    return tzFormatters;
  }

  function offsetMinutes(ts) {
    if (!Number.isFinite(ts)) return 0;
    const bucket = Math.floor(ts / 3600000);
    const cached = offsetCache.get(bucket);
    if (cached !== undefined) return cached;
    const state = tzState();
    let value = 0;
    if (state) {
      try {
        const parts = {};
        for (const p of state.parts.formatToParts(new RealDate(ts))) parts[p.type] = p.value;
        const asUTC = RealDate.UTC(
          Number(parts.year), Number(parts.month) - 1, Number(parts.day),
          Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
        );
        value = (asUTC - Math.floor(ts / 1000) * 1000) / 60000;
      } catch (e) { value = 0; }
    }
    if (offsetCache.size > 5000) offsetCache.clear();
    offsetCache.set(bucket, value);
    return value;
  }

  function shifted(d) {
    const t = d.getTime();
    return new RealDate(t + offsetMinutes(t) * 60000);
  }

  const LOCAL_GETTERS = {
    getHours: 'getUTCHours',
    getMinutes: 'getUTCMinutes',
    getSeconds: 'getUTCSeconds',
    getDate: 'getUTCDate',
    getDay: 'getUTCDay',
    getMonth: 'getUTCMonth',
    getFullYear: 'getUTCFullYear',
  };
  for (const [local, utc] of Object.entries(LOCAL_GETTERS)) {
    defineMethod(RealDate.prototype, local, function () {
      return shifted(this)[utc]();
    }, local);
  }

  defineMethod(RealDate.prototype, 'getTimezoneOffset', function getTimezoneOffset() {
    return -offsetMinutes(this.getTime());
  }, 'getTimezoneOffset');

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  function zoneLabel(ts) {
    const state = tzState();
    if (!state) return P.timezone;
    try {
      const found = state.name.formatToParts(new RealDate(ts)).find((p) => p.type === 'timeZoneName');
      return found ? found.value : P.timezone;
    } catch (e) { return P.timezone; }
  }

  defineMethod(RealDate.prototype, 'toString', function toString() {
    const t = this.getTime();
    if (!Number.isFinite(t)) return 'Invalid Date';
    const off = offsetMinutes(t);
    const d = new RealDate(t + off * 60000);
    const sign = off >= 0 ? '+' : '-';
    const gmt = `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
    return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
      `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
      `${pad(d.getUTCSeconds())} GMT${gmt} (${zoneLabel(t)})`;
  }, 'toString');

  defineMethod(RealDate.prototype, 'toTimeString', function toTimeString() {
    const s = RealDate.prototype.toString.call(this);
    return s === 'Invalid Date' ? s : s.slice(s.indexOf(' ') + 1);
  }, 'toTimeString');

  // ---------------------------------------------------------------------------
  // Intl locale
  //
  // navigator.language is spoofed, so the Intl defaults have to follow, or the
  // page would report one language and format dates and numbers in another.
  // ---------------------------------------------------------------------------
  function patchIntl(ctorName, opts) {
    const usesTimeZone = Boolean(opts && opts.timeZone);
    const Original = Intl[ctorName];
    if (!Original) return;
    const withDefaults = (args) => {
      const [locales, options] = args;
      const nextLocales = locales === undefined ? P.languages : locales;
      const nextOptions = usesTimeZone && (!options || options.timeZone === undefined)
        ? Object.assign({}, options, { timeZone: P.timezone })
        : options;
      return [nextLocales, nextOptions];
    };
    Intl[ctorName] = new Proxy(Original, {
      construct(target, args) {
        return Reflect.construct(target, withDefaults(args));
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target, thisArg, withDefaults(args));
      },
    });
    const origResolved = Original.prototype.resolvedOptions;
    defineMethod(Original.prototype, 'resolvedOptions', function resolvedOptions() {
      const out = origResolved.call(this);
      out.locale = P.locale;
      if (usesTimeZone) out.timeZone = P.timezone;
      return out;
    }, 'resolvedOptions');
  }

  patchIntl('DateTimeFormat', { timeZone: true });
  patchIntl('NumberFormat');
  patchIntl('Collator');
  patchIntl('PluralRules');
  patchIntl('RelativeTimeFormat');
  patchIntl('ListFormat');
  patchIntl('DisplayNames');
  patchIntl('Segmenter');

  const dateLocale = (date, locales, options, defaults) => {
    if (!Number.isFinite(date.getTime())) return 'Invalid Date';
    // dateStyle/timeStyle cannot be combined with individual fields.
    const styled = options && (options.dateStyle || options.timeStyle);
    return new Intl.DateTimeFormat(locales, styled ? options : Object.assign({}, defaults, options)).format(date);
  };
  defineMethod(Date.prototype, 'toLocaleString', function toLocaleString(locales, options) {
    return dateLocale(this, locales, options, {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
  }, 'toLocaleString');
  defineMethod(Date.prototype, 'toLocaleDateString', function toLocaleDateString(locales, options) {
    return dateLocale(this, locales, options, { year: 'numeric', month: 'numeric', day: 'numeric' });
  }, 'toLocaleDateString');
  defineMethod(Date.prototype, 'toLocaleTimeString', function toLocaleTimeString(locales, options) {
    return dateLocale(this, locales, options, { hour: 'numeric', minute: 'numeric', second: 'numeric' });
  }, 'toLocaleTimeString');
  defineMethod(Number.prototype, 'toLocaleString', function toLocaleString(locales, options) {
    return new Intl.NumberFormat(locales, options).format(this);
  }, 'toLocaleString');

  // ---------------------------------------------------------------------------
  // Publish the header set for the service worker
  // ---------------------------------------------------------------------------
  function publish() {
    const payload = {
      seed: P.seed,
      ua: P.ua,
      chUa: P.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
      chUaMobile: '?0',
      chUaPlatform: P.chPlatform,
      acceptLanguage: P.acceptLanguage,
      dnt: P.doNotTrack,
      timezone: P.timezone,
      languages: P.languages,
      platform: P.platform,
      system: P.system,
      screen: `${P.sw}x${P.sh}@${P.dpr}`,
      cores: P.cores,
      memory: P.memory,
      gpu: P.glRenderer,
    };

    try { sessionStorage.setItem(HEADER_KEY, JSON.stringify(payload)); } catch (e) { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent('scrambilini:profile', { detail: payload })); } catch (e) { /* ignore */ }
  }

  publish();

  // Adopt the tab's authoritative seed once the service worker hands it over.
  /** The browser's real UA. Firefox shares `navigator` between documents in a
   *  tab, so the page's own copy may already be spoofed; the worker sends the
   *  real one along with the seed. */
  function realUaForProfile() {
    try {
      return sessionStorage.getItem(REAL_UA_KEY) || realUA;
    } catch (e) {
      return realUA;
    }
  }

  function adoptSeed(nextSeed, nextLocks) {
    if (!nextSeed || typeof nextSeed !== 'string') return;
    const nextKey = JSON.stringify(nextLocks || null);
    if (nextSeed === P.seed && nextKey === JSON.stringify(locks || null)) return;
    seed = nextSeed;
    locks = nextLocks || null;
    Object.assign(P, buildProfile(nextSeed, realUaForProfile(), locks));
    applyGeometry();
    persistSeed();
    publish();
  }

  // The worker answers within a few milliseconds, but the isolated-world bridge
  // and this script are injected in separate tasks, so the hand-off event can
  // fire before the listener below exists. Polling sessionStorage closes that
  // window: whichever happens first, the swap lands within ~5ms of the answer.
  let adoptTimer = null;
  function tryAdopt() {
    let next = null;
    try { next = sessionStorage.getItem(SEED_KEY); } catch (e) { /* storage blocked */ }
    if (!next) return false;
    adoptSeed(next, readLocks());
    if (adoptTimer !== null) {
      clearInterval(adoptTimer);
      adoptTimer = null;
    }
    return true;
  }

  window.addEventListener('scrambilini:seed', tryAdopt);
  if (!tryAdopt()) {
    let ticks = 0;
    adoptTimer = setInterval(() => {
      tryAdopt();
      if (++ticks > 300) {
        clearInterval(adoptTimer);
        adoptTimer = null;
      }
    }, 2);
  }
})();
