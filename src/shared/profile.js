/*
 * Scrambilini — shared identity builder.
 *
 * Pure function of (seed, realUserAgent) so the service worker and the page
 * derive byte-identical profiles. That is what lets the HTTP header rules and
 * the JS-visible values agree even though they are produced in different
 * processes.
 *
 * Loaded by:
 *   - src/background.js      via importScripts()
 *   - src/content/scramble.js via the content_scripts js list
 */
var __scrambiliniBuildProfile = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Operating systems
  //
  // Each system carries everything that has to agree about the platform: the
  // UA template, navigator.platform, the client-hint platform string, the
  // architecture hints, and plausible screens / GPUs / fonts for that system.
  // ---------------------------------------------------------------------------

  const MAC_FONTS = [
    'Helvetica', 'Helvetica Neue', 'Arial', 'Times New Roman', 'Courier New',
    'Verdana', 'Georgia', 'Trebuchet MS', 'Tahoma', 'Lucida Grande', 'Menlo',
    'Monaco', 'Optima', 'Futura', 'Baskerville', 'Avenir', 'Avenir Next',
    'Chalkboard', 'Copperplate', 'Didot', 'Gill Sans', 'Hoefler Text',
    'Marker Felt', 'Papyrus', 'SF Pro Text', 'PingFang SC', 'Hiragino Sans',
  ];

  const WINDOWS_FONTS = [
    'Arial', 'Arial Black', 'Times New Roman', 'Courier New', 'Verdana',
    'Georgia', 'Trebuchet MS', 'Tahoma', 'Segoe UI', 'Segoe UI Light',
    'Segoe UI Semibold', 'Calibri', 'Cambria', 'Candara', 'Consolas',
    'Constantia', 'Corbel', 'Franklin Gothic Medium', 'Gabriola',
    'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif',
    'Palatino Linotype', 'Sylfaen', 'MS Gothic', 'SimSun', 'Microsoft YaHei',
  ];

  const LINUX_FONTS = [
    'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans',
    'Liberation Serif', 'Liberation Mono', 'Ubuntu', 'Ubuntu Mono', 'Cantarell',
    'Noto Sans', 'Noto Serif', 'Noto Sans Mono', 'FreeSans', 'FreeSerif',
    'FreeMono', 'Nimbus Sans', 'Nimbus Roman', 'Nimbus Mono PS', 'Arial',
    'Times New Roman', 'Courier New',
  ];

  const SYSTEMS = [
    {
      id: 'macos',
      weight: 4,
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      uaPlatform: 'macOS',
      chPlatform: '"macOS"',
      architecture: 'arm',
      bitness: '64',
      platformVersions: ['10.15.7', '12.7.6', '13.6.7', '14.5.0', '15.1.0'],
      screens: [
        [1512, 982, 2], [1728, 1117, 2], [1440, 900, 2], [1680, 1050, 2],
        [1920, 1200, 2], [2560, 1440, 2], [2560, 1600, 2], [3840, 2160, 2],
        [1280, 800, 2], [1800, 1169, 2], [1920, 1080, 1], [2560, 1080, 1],
        [3440, 1440, 1],
      ],
      gpus: [
        ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'],
        ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'],
        ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
        ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)'],
        ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)'],
        ['Apple', 'Apple M1'],
        ['Apple', 'Apple M2'],
        ['Apple', 'Apple GPU'],
      ],
      fonts: MAC_FONTS,
    },
    {
      id: 'windows',
      weight: 4,
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36',
      platform: 'Win32',
      uaPlatform: 'Windows',
      chPlatform: '"Windows"',
      architecture: 'x86',
      bitness: '64',
      platformVersions: ['10.0.0', '15.0.0'],
      screens: [
        [1920, 1080, 1], [1536, 864, 1.25], [1366, 768, 1], [1600, 900, 1],
        [2560, 1440, 1], [2560, 1440, 1.25], [1280, 720, 1.25], [1280, 720, 1],
        [1920, 1200, 1], [2560, 1080, 1], [1440, 900, 1],
      ],
      gpus: [
        ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ],
      fonts: WINDOWS_FONTS,
    },
    {
      id: 'linux',
      weight: 2,
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      uaPlatform: 'Linux',
      chPlatform: '"Linux"',
      architecture: 'x86',
      bitness: '64',
      platformVersions: ['5.15.0', '6.1.0', '6.5.0', '6.8.0'],
      screens: [
        [1920, 1080, 1], [1366, 768, 1], [2560, 1440, 1], [1280, 800, 1],
        [1600, 900, 1], [3840, 2160, 1], [1280, 720, 1],
      ],
      gpus: [
        ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'],
        ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)'],
        ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 (POLARIS10, DRM 3.42.0, 5.15.0-91-generic, LLVM 15.0.7), OpenGL 4.6)'],
        ['Google Inc. (Mesa)', 'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)'],
      ],
      fonts: LINUX_FONTS,
    },
  ];

  const ALL_FONTS = Array.from(new Set(
    SYSTEMS.reduce((acc, system) => acc.concat(system.fonts), []),
  ));

  const CORES = [4, 6, 8, 10, 12, 16];
  const MEMORY = [4, 8, 16];

  const TIMEZONES = [
    'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Amsterdam', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Warsaw',
    'Europe/Dublin', 'Europe/London', 'America/New_York', 'America/Chicago',
    'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
    'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Kolkata', 'Australia/Sydney',
    'Pacific/Auckland', 'Africa/Johannesburg', 'America/Mexico_City',
  ];

  const LANGUAGE_SETS = [
    ['en-US', 'en'], ['en-US', 'en'], ['en-GB', 'en'], ['en-CA', 'en', 'fr-CA'],
    ['en-AU', 'en'], ['en-US', 'en', 'es'], ['en-US', 'en', 'fr'],
    ['de-DE', 'de', 'en-US', 'en'], ['fr-FR', 'fr', 'en-US', 'en'],
    ['es-ES', 'es', 'en'], ['it-IT', 'it', 'en'], ['nl-NL', 'nl', 'en'],
    ['sv-SE', 'sv', 'en'], ['pl-PL', 'pl', 'en'], ['pt-BR', 'pt', 'en'],
    ['ja-JP', 'ja', 'en'], ['ko-KR', 'ko', 'en'],
  ];

  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function mulberry32(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hex(rnd, length) {
    let out = '';
    for (let i = 0; i < length; i++) out += Math.floor(rnd() * 16).toString(16);
    return out;
  }

  function sameScreen(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  }

  /** Which platform a locked screen or GPU belongs to, so the rest of the
   *  identity can stay consistent with it. */
  function systemWithScreen(screen) {
    const found = SYSTEMS.find((s) => s.screens.some((x) => sameScreen(x, screen)));
    return found ? found.id : null;
  }

  function systemWithGpu(gpu) {
    const found = SYSTEMS.find((s) => s.gpus.some((x) => x[0] === gpu[0] && x[1] === gpu[1]));
    return found ? found.id : null;
  }

  return function build(seed, realUA, overrides) {
    // Locked fields are applied as-is; everything else still comes from the
    // seed. Both the worker and the page pass the same locks, so the two sides
    // keep producing the same profile.
    const locks = overrides && typeof overrides === 'object' ? overrides : {};
    const rnd = mulberry32(hashSeed(seed)());
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const ri = (min, max) => min + Math.floor(rnd() * (max - min + 1));

    const versionMatch = /Chrome\/(\d+)/.exec(realUA || '');
    const realMajor = versionMatch ? Number(versionMatch[1]) : 130;
    const majorRan = Math.max(100, realMajor - ri(0, 4));
    const major = locks.ua && locks.ua.major ? Number(locks.ua.major) : majorRan;

    // A locked UA, screen or GPU pins the platform, so the rest of the values
    // are drawn from a pool that can actually contain them.
    let pinned = locks.ua && locks.ua.system ? locks.ua.system : null;
    if (!pinned && locks.screen) pinned = systemWithScreen(locks.screen);
    if (!pinned && locks.gpu) pinned = systemWithGpu(locks.gpu);

    // Weighted system pick, so the mix stays plausible without every tab
    // claiming the same platform.
    let system = SYSTEMS[0];
    let roll = rnd() * SYSTEMS.reduce((sum, s) => sum + s.weight, 0);
    for (const candidate of SYSTEMS) {
      roll -= candidate.weight;
      if (roll < 0) { system = candidate; break; }
    }
    if (pinned) {
      system = SYSTEMS.find((s) => s.id === pinned) || system;
    }

    const ua = system.ua.replace('{v}', String(major));
    const platformVersion = pick(system.platformVersions);

    const brands = [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
      { brand: 'Not?A_Brand', version: '24' },
    ];

    // Every pick is still drawn, even for a locked field, so locking a value
    // does not disturb the rest of the identity.
    const screenRan = pick(system.screens);
    const languagesRan = pick(LANGUAGE_SETS);
    const gpuRan = pick(system.gpus);
    const [sw, sh, dpr] = locks.screen || screenRan;
    const languages = locks.languages && locks.languages.length
      ? locks.languages.slice()
      : languagesRan;
    const [glVendor, glRenderer] = locks.gpu || gpuRan;

    const acceptLanguage = languages
      .map((lang, i) => {
        if (i === 0) return lang;
        if (i === 1) return `${lang};q=0.9`;
        return `${lang};q=${(0.9 - (i - 1) * 0.1).toFixed(1)}`;
      })
      .join(',');

    const mics = ri(1, 2);
    const cams = ri(0, 2);
    const outs = ri(1, 2);
    const devices = [];
    const pushDevice = (kind) => devices.push({
      deviceId: hex(rnd, 32),
      groupId: hex(rnd, 32),
      kind,
      label: '',
    });
    for (let i = 0; i < mics; i++) pushDevice('audioinput');
    for (let i = 0; i < cams; i++) pushDevice('videoinput');
    for (let i = 0; i < outs; i++) pushDevice('audiooutput');

    const connection = {
      effectiveType: pick(['4g', '4g', '3g']),
      rtt: pick([50, 100, 150, 200, 250]),
      downlink: pick([10, 9.5, 7.5, 5.6, 3.4]),
      saveData: false,
      type: 'wifi',
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
    };

    const battery = {
      charging: pick([true, false]),
      chargingTime: pick([0, Infinity]),
      dischargingTime: pick([Infinity, 7200, 10800]),
      level: pick([1, 0.98, 0.87, 0.76, 0.64, 0.52]),
      onchargingchange: null,
      onlevelchange: null,
      addEventListener() {},
      removeEventListener() {},
    };

    const highEntropy = {
      architecture: system.architecture,
      bitness: system.bitness,
      model: '',
      platformVersion,
      uaFullVersion: `${major}.0.0.0`,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: `${b.version}.0.0.0` })),
      wow64: false,
      formFactors: ['Desktop'],
    };

    // The remaining picks are drawn in the same order even when a field is
    // locked, so locking one value leaves the others untouched.
    const timezoneRan = pick(TIMEZONES);
    const dntRan = pick(['1', null]);
    const availRan = ri(25, 90);
    const colorRan = pick([24, 30]);
    const coresRan = pick(CORES);
    const memoryRan = pick(MEMORY);

    return {
      seed,
      ua,
      major,
      brands,
      system: system.id,
      platform: system.platform,
      uaPlatform: system.uaPlatform,
      chPlatform: system.chPlatform,
      mobile: false,
      acceptLanguage,
      languages,
      timezone: locks.timezone || timezoneRan,
      doNotTrack: dntRan,
      sw,
      sh,
      dpr,
      availHeight: sh - availRan,
      colorDepth: colorRan,
      cores: locks.hardware && locks.hardware.cores ? Number(locks.hardware.cores) : coresRan,
      memory: locks.hardware && locks.hardware.memory ? Number(locks.hardware.memory) : memoryRan,
      glVendor,
      glRenderer,
      fonts: system.fonts,
      allFonts: ALL_FONTS,
      sampleRate: pick([44100, 48000]),
      salt: hashSeed(`${seed}:noise`)(),
      maxTexSize: pick([8192, 16384]),
      maxTexUnits: pick([16, 32]),
      maxCube: pick([8192, 16384]),
      maxVertexUniforms: pick([1024, 2048, 4096]),
      maxVarying: pick([30, 31]),
      maxVertexAttribs: 16,
      maxCombined: pick([32, 64, 80]),
      quota: ri(120, 480) * 1024 * 1024 * 1024,
      usage: ri(1, 90) * 1024 * 1024,
      devices,
      connection,
      battery,
      highEntropy,
      seedHex: hex(rnd, 8),
    };
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __scrambiliniBuildProfile;
}
