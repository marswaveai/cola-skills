// Soft transition whooshes at scene changes, rendered offline by WebAudio inside the headless Chrome we already drive.
// (Background music is not part of this release.)
import fs from 'node:fs';

const SFX = String.raw`
async (opts) => {
  const SR = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * opts.seconds), SR);
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const noise = ctx.createBuffer(1, SR, SR); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; }
  for (const t of opts.whooshes) {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(350, t - .12); f.frequency.exponentialRampToValueAtTime(2600, t + .12); f.frequency.exponentialRampToValueAtTime(900, t + .3);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t - .12); g.gain.exponentialRampToValueAtTime(.18, t + .06); g.gain.exponentialRampToValueAtTime(0.0001, t + .34);
    const p = ctx.createStereoPanner(); p.pan.setValueAtTime(-.5, t - .12); p.pan.linearRampToValueAtTime(.5, t + .3);
    s.connect(f); f.connect(g); g.connect(p); p.connect(ctx.destination);
    s.start(Math.max(0, t - .12), rnd() * .4); s.stop(t + .4);
  }
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
  const bytes = new Uint8Array(44 + n * 4), dv = new DataView(bytes.buffer);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) bytes[o + i] = str.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, L[i] * 32767, true); dv.setInt16(46 + i * 4, R[i] * 32767, true); }
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin) };
}`;

export async function renderSfx(page, { seconds, whooshes, out }) {
  const r = await page.evaluate(`(${SFX})(${JSON.stringify({ seconds, whooshes })})`);
  fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
}

