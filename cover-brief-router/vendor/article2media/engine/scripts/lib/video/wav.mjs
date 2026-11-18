// Minimal WAV I/O and speech-edge analysis (mono, 16-bit PCM or 32-bit float in; 16-bit PCM out).
import fs from 'node:fs';

export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`不是 WAV 文件：${file}`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + Math.min(size, b.length - off - 8));
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`WAV 缺少 fmt/data：${file}`);
  const { ch, bits, format } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * ch));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const p = (i * ch + c) * bytes;
      s += format === 3 ? data.readFloatLE(p) : bits === 16 ? data.readInt16LE(p) / 32768 : bits === 24 ? data.readIntLE(p, 3) / 8388608 : data.readInt32LE(p) / 2147483648;
    }
    out[i] = s / ch;
  }
  return { sr: fmt.sr, data: out };
}

export function writeWav(file, data, sr) {
  const b = Buffer.alloc(44 + data.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}

const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

/** RMS level per window (dBFS). */
export function levels(data, sr, win = 0.01) {
  const n = Math.max(1, Math.round(sr * win));
  const out = [];
  for (let i = 0; i < data.length; i += n) {
    let s = 0;
    const end = Math.min(data.length, i + n);
    for (let j = i; j < end; j++) s += data[j] * data[j];
    out.push(db(Math.sqrt(s / (end - i))));
  }
  return out;
}

export function stats(data) {
  let peak = 0, clipped = 0;
  for (const x of data) { const a = Math.abs(x); if (a > peak) peak = a; if (a >= 0.999) clipped++; }
  return { peak: db(peak), clipped };
}

/**
 * Trim to the speech: keep `lead` s before the first window above `thr`, end `tail` s after the last one,
 * with short fades. Reports whether the clip still ends loud (a truncated last word).
 */
export function trimSpeech(data, sr, { thr = -42, lead = 0.06, tail = 0.14, win = 0.01 } = {}) {
  const lv = levels(data, sr, win);
  const first = lv.findIndex((v) => v > thr);
  let last = lv.length - 1;
  while (last >= 0 && lv[last] <= thr) last--;
  if (first < 0) return { data: new Float32Array(0), start: 0, truncated: false, empty: true };
  const n = Math.round(win * sr);
  const s = Math.max(0, first * n - Math.round(lead * sr));
  const e = Math.min(data.length, (last + 1) * n + Math.round(tail * sr));
  const out = data.slice(s, e);
  const fin = Math.min(out.length, Math.round(0.01 * sr)), fout = Math.min(out.length, Math.round(0.06 * sr));
  for (let i = 0; i < fin; i++) out[i] *= i / fin;
  for (let i = 0; i < fout; i++) out[out.length - 1 - i] *= i / fout;
  const endLevel = Math.max(...lv.slice(Math.max(0, lv.length - 5)));
  return { data: out, start: s / sr, truncated: endLevel > -25, empty: false };
}

export function concat(parts, sr) {
  const total = parts.reduce((a, p) => a + (p.data ? p.data.length : Math.round(p.silence * sr)), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    if (p.data) { out.set(p.data, o); o += p.data.length; } else o += Math.round(p.silence * sr);
  }
  return out;
}
