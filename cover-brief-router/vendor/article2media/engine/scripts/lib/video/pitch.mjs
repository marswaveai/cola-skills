// Median fundamental frequency of speech (autocorrelation on voiced frames). Used to catch voice drift:
// a cloned chunk whose pitch wanders far from the reference voice is regenerated.

/** data: Float32Array mono, sr: sample rate. Returns median F0 in Hz, or 0 when nothing voiced was found. */
export function medianF0(data, sr) {
  // Downsample to ~16 kHz by averaging.
  const step = Math.max(1, Math.round(sr / 16000));
  const fs = sr / step;
  const n = Math.floor(data.length / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < step; k++) a += data[i * step + k]; x[i] = a / step; }
  const frame = Math.round(fs * 0.04), hop = Math.round(fs * 0.01);
  const minLag = Math.floor(fs / 400), maxLag = Math.ceil(fs / 70);
  const f0s = [];
  for (let start = 0; start + frame + maxLag < n; start += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[start + i] * x[start + i];
    const rms = Math.sqrt(e / frame);
    if (rms < 0.02) continue; // unvoiced or silence
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, e2 = 0;
      for (let i = 0; i < frame; i++) { c += x[start + i] * x[start + i + lag]; e2 += x[start + i + lag] * x[start + i + lag]; }
      const r = c / Math.sqrt(e * e2 + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.55 && bestLag) f0s.push(fs / bestLag);
  }
  if (f0s.length < 5) return 0;
  f0s.sort((a, b) => a - b);
  return Math.round(f0s[Math.floor(f0s.length / 2)]);
}
