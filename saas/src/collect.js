/*
 * The collector that a customer page includes.
 *
 * Reads a small set of browser values, hashes the expensive ones locally, and
 * posts them. It never blocks the page: everything runs after load.
 */
(async () => {
  const sha = async (input) => {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const FONT_CANDIDATES = [
    'Arial', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Courier New',
    'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Cambria',
    'Consolas', 'Segoe UI', 'Menlo', 'Monaco', 'DejaVu Sans', 'Liberation Sans',
    'Ubuntu', 'Noto Sans', 'Nimbus Sans',
  ];
  const fonts = [];
  for (const name of FONT_CANDIDATES) {
    try {
      if (document.fonts && document.fonts.check(`12px "${name}"`)) fonts.push(name);
    } catch (e) { /* ignore */ }
  }

  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '16px "Arial"';
  ctx.fillStyle = '#f60';
  ctx.fillRect(0, 0, 240, 60);
  ctx.fillStyle = '#069';
  ctx.fillText('Scrambilini fingerprint PoC', 4, 8);
  ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
  ctx.fillText('Scrambilini fingerprint PoC', 6, 22);
  const canvasHash = await sha(canvas.toDataURL());

  let webglVendor = '';
  let webglRenderer = '';
  const gl = canvas.getContext('webgl');
  if (gl) {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    webglVendor = String(debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    webglRenderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  let webgpu = '';
  try {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    if (adapter && adapter.info) webgpu = `${adapter.info.vendor}/${adapter.info.architecture}`;
  } catch (e) { /* ignore */ }

  let audioHash = '';
  try {
    const audio = new OfflineAudioContext(1, 5000, 44100);
    const osc = audio.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = audio.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(audio.destination);
    osc.start(0);
    const rendered = await audio.startRendering();
    const data = rendered.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
    audioHash = await sha(sum.toFixed(8));
  } catch (e) { /* ignore */ }

  const payload = {
    ua: navigator.userAgent,
    platform: navigator.platform,
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screenW: screen.width,
    screenH: screen.height,
    dpr: devicePixelRatio,
    cores: navigator.hardwareConcurrency || 0,
    memory: navigator.deviceMemory || 0,
    plugins: navigator.plugins ? navigator.plugins.length : 0,
    webglVendor,
    webglRenderer,
    canvasHash,
    audioHash,
    fonts,
    webgpu,
  };

  try {
    const response = await fetch('/v1/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    window.dispatchEvent(new CustomEvent('fp:done', { detail: { payload, data } }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent('fp:error', { detail: String(error) }));
  }
})();
