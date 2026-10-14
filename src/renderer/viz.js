// Background liquid visualizer. Idle: slow breathing waves. Playing: waves driven by audio bins.
window.Viz = (() => {
  const canvas = document.getElementById('viz');
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1;
  let t = 0;
  let bins = new Float32Array(64);
  let smooth = new Float32Array(64);
  let energy = 0, energyTarget = 0;
  let surge = 0;               // 0..1 transition burst
  let lift = 0, liftTarget = 0; // waves rise toward center when a track is active
  let palette = [[138, 180, 255], [255, 140, 220], [120, 230, 200]];
  let paletteTarget = palette.map(c => c.slice());
  let analyser = null;
  let freq = null;
  let synth = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(innerWidth * dpr);
    h = canvas.height = Math.floor(innerHeight * dpr);
  }
  addEventListener('resize', resize);
  resize();

  function setAnalyser(a) {
    analyser = a;
    freq = a ? new Uint8Array(a.frequencyBinCount) : null;
  }
  function setSynth(on) { synth = on; }
  function setActive(on) { liftTarget = on ? 1 : 0; if (!on) energyTarget = 0; }
  function burst() { surge = 1; }
  function setPalette(colors) { if (colors && colors.length) paletteTarget = colors; }
  function resetPalette() { paletteTarget = [[138, 180, 255], [255, 140, 220], [120, 230, 200]]; }

  function sample() {
    const n = bins.length;
    if (analyser && freq) {
      analyser.getByteFrequencyData(freq);
      let sum = 0;
      const span = Math.floor(freq.length * 0.6 / n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let j = 0; j < span; j++) v += freq[i * span + j];
        v = v / span / 255;
        bins[i] = v;
        sum += v;
      }
      energyTarget = Math.min(1, (sum / n) * 1.8);
    } else if (synth) {
      for (let i = 0; i < n; i++) {
        const beat = Math.pow(Math.max(0, Math.sin(t * 2.1)), 6);
        bins[i] = 0.25 + 0.35 * Math.abs(Math.sin(t * 1.3 + i * 0.35)) * (1 - i / n) + beat * 0.4 * (1 - i / n);
      }
      energyTarget = 0.45;
    } else {
      for (let i = 0; i < n; i++) bins[i] = 0;
      energyTarget = 0;
    }
    for (let i = 0; i < n; i++) smooth[i] += (bins[i] - smooth[i]) * 0.12;
    energy += (energyTarget - energy) * 0.08;
    lift += (liftTarget - lift) * 0.04;
    surge *= 0.965;
    for (let i = 0; i < palette.length; i++)
      for (let k = 0; k < 3; k++) palette[i][k] += ((paletteTarget[i] || paletteTarget[0])[k] - palette[i][k]) * 0.03;
  }

  function binAt(x) {
    const n = 24; // use the lower, musically dense part of the spectrum, smoothly interpolated
    const f = x * (n - 1);
    const i = Math.floor(f), fr = f - i;
    const k = (1 - Math.cos(fr * Math.PI)) / 2;
    const a = smooth[Math.min(i, n - 1)], b = smooth[Math.min(i + 1, n - 1)];
    return a + (b - a) * k;
  }

  function drawWave(layer, color, alpha) {
    const base = h * (0.82 - lift * 0.22 - layer * 0.06) - surge * h * 0.12;
    const amp = h * (0.035 + layer * 0.012) * (1 + energy * 2.2 + surge * 2.6);
    const speed = 0.35 + layer * 0.17;
    const grad = ctx.createLinearGradient(0, base - amp * 2, 0, h);
    grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha})`);
    grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, h);
    const steps = 140;
    for (let s = 0; s <= steps; s++) {
      const x = s / steps;
      const idle = Math.sin(x * 6.3 + t * speed + layer * 1.7) * 0.5 + Math.sin(x * 3.1 - t * speed * 0.7 + layer) * 0.5;
      const audio = binAt(Math.abs(Math.sin(x * Math.PI))) * 1.6;
      const y = base + idle * amp * 0.7 - audio * amp * (0.6 + 0.6 * Math.sin(x * Math.PI));
      ctx.lineTo(x * w, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }

  function drawBlobs() {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const c = palette[i % palette.length];
      const x = w * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.13 + i * 2.1)));
      const y = h * (0.25 + 0.3 * (0.5 + 0.5 * Math.cos(t * 0.11 + i * 1.3)));
      const r = Math.min(w, h) * (0.28 + 0.1 * Math.sin(t * 0.2 + i)) * (1 + energy * 0.35 + surge * 0.5);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${0.16 + energy * 0.14})`);
      g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  function frame() {
    t += 0.016;
    sample();
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    drawBlobs();
    for (let i = 0; i < 3; i++) drawWave(i, palette[i % palette.length], 0.30 + energy * 0.25 + surge * 0.2);
    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Extract a few dominant-ish colors from an image to tint the scene.
  function paletteFromImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max - min < 30 || max < 60) continue;
          const key = `${r >> 5},${g >> 5},${b >> 5}`;
          const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          e.n++; e.r += r; e.g += g; e.b += b;
          buckets.set(key, e);
        }
        const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 3)
          .map(e => [e.r / e.n, e.g / e.n, e.b / e.n].map(v => Math.min(255, v * 0.6 + 100)));
        resolve(top.length ? top : null);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  return { setAnalyser, setSynth, setActive, burst, setPalette, resetPalette, paletteFromImage };
})();
