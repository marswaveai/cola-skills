// Voice library tools: import a reference (local by default), design public voices from text only, probe terms.
//
// Rights model (copyright and voice rights matter more than convenience):
//   personal / self / authorized   → local library only (~/.local/share/article2media/voices), never shipped
//   designed / self-public / authorized-public → may be added to the public library with --public
// A voice that sounds like a recognizable person or platform voice stays a derivative of it, however it was re-synthesized,
// so cloned voices are always local. Public voices are designed from a text description, never from a reference clip.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectVoice, voiceCatalog, saveLocalVoice, LOCAL_VOICES_DIR, PUBLIC_RIGHTS, VOICES_DIR, PACE, DATA_DIR } from './voice.mjs';
import { readWav, writeWav, levels, stats, trimSpeech } from './wav.mjs';
import { medianF0 } from './pitch.mjs';
import { voicedOnly, latinWords, intToZh } from './text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(HERE, 'py');
const RIGHTS = ['personal', 'self', 'authorized', ...PUBLIC_RIGHTS];
export const PASSAGE = '大家都以为做自媒体要有特长，其实不一定。我就是从零开始，一点一点摸索，慢慢找到了适合自己的方法。';

const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function asr(det, files) {
  if (!det.whisper) return {};
  const r = spawnSync(det.whisper.python, [path.join(PY, 'asr_words.py'), det.whisper.model, ...files], { encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20, env: { ...process.env, HF_HUB_OFFLINE: '1' } });
  const out = {};
  for (const l of (r.stdout || '').split('\n')) if (l.startsWith('{')) { const j = JSON.parse(l); out[j.file] = j; }
  return out;
}

function batch(det, job) {
  const f = path.join(os.tmpdir(), `a2i-vox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  fs.writeFileSync(f, JSON.stringify({ model: det.voxcpm.model, ...job }));
  const r = spawnSync(det.voxcpm.python, [path.join(PY, 'voxcpm_batch.py'), f], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 << 20 });
  fs.rmSync(f, { force: true });
  if (r.status !== 0) throw new Error(`VoxCPM2 失败：${(r.stderr || '').split('\n').filter((l) => l && !/warn/i.test(l)).slice(-4).join(' / ')}`);
}

const normDigits = (s) => String(s).replace(/\d+/g, (m) => intToZh(Number(m)));
function cer(a, b) {
  a = [...voicedOnly(normDigits(a))]; b = [...voicedOnly(normDigits(b))];
  let d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const p = d; d = [i]; for (let j = 1; j <= b.length; j++) d[j] = Math.min(p[j] + 1, d[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); }
  return d[b.length] / Math.max(1, a.length);
}

/** Speech-to-floor ratio (dB): how much quieter the pauses are than the speech. Music beds and hiss make it small. */
function pauseDepth(data, sr) {
  const lv = levels(data, sr, 0.02).filter((x) => x > -90).sort((a, b) => a - b);
  if (lv.length < 10) return 0;
  return Math.round(lv[Math.floor(lv.length * 0.7)] - lv[Math.floor(lv.length * 0.08)]);
}

/** Pick a 6–15 s window that starts and ends at pauses, from Whisper word timings. */
function pickWindow(words, dur) {
  if (dur <= 15.5 || !words?.length) return null;
  let best = null;
  for (let i = 0; i < words.length; i++) {
    if (i > 0 && words[i][1] - words[i - 1][2] < 0.25) continue;
    for (let j = i; j < words.length; j++) {
      const len = words[j][2] - words[i][1];
      if (len > 15) break;
      const after = j + 1 < words.length ? words[j + 1][1] - words[j][2] : 1;
      if (len >= 6 && after >= 0.3 && (!best || len > best.len)) best = { s: Math.max(0, words[i][1] - 0.1), e: Math.min(dur, words[j][2] + 0.35), len };
    }
  }
  return best;
}

export async function importVoice(file, opt) {
  if (!file || !fs.existsSync(file)) { console.error('用法：video.mjs voice-import <音频> --id <id> --name <名称> --rights personal|self|authorized --source "来源"'); return 2; }
  const id = opt.id, rights = opt.rights || 'personal';
  if (!id || !/^[\w-]+$/.test(id)) { console.error('✗ --id 只能用字母、数字、- 和 _'); return 2; }
  if (!RIGHTS.includes(rights)) { console.error(`✗ --rights 只能是 ${RIGHTS.join(' / ')}`); return 2; }
  if (opt.public && !PUBLIC_RIGHTS.includes(rights)) {
    console.error(`✗ 只有 ${PUBLIC_RIGHTS.join(' / ')} 的音色可以公开随 skill 分发；克隆自他人或平台的声音只能进本机音色库`);
    return 2;
  }
  if (!opt.source) { console.error('✗ 请用 --source 写明来源（例如"微软 Azure 云希官方样音"），便于日后核对权利'); return 2; }
  const det = detectVoice();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2i-voice-'));
  try {
    // 1) Probe the source, then convert to 48 kHz mono (VoxCPM2's native rate).
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,bit_rate:format=bit_rate,duration', '-of', 'json', file], { encoding: 'utf8' });
    const info = JSON.parse(pr.stdout || '{}');
    const srcRate = Number(info.streams?.[0]?.sample_rate || 0), srcKbps = Math.round(Number(info.format?.bit_rate || info.streams?.[0]?.bit_rate || 0) / 1000);
    const full = path.join(tmp, 'full.wav');
    if (ff(['-i', file, '-ac', '1', '-ar', '48000', '-af', 'highpass=f=70', '-c:a', 'pcm_s16le', full]).status !== 0) throw new Error('无法解码这个音频');
    let { data, sr } = readWav(full);
    const dur = data.length / sr;
    // 2) Choose the segment: given, or a 6–15 s window between pauses.
    let s0 = opt.start != null ? Number(opt.start) : 0, s1 = opt.end != null ? Number(opt.end) : dur;
    if (opt.start == null && opt.end == null) {
      const w = pickWindow(asr(det, [full])[full]?.words, dur);
      if (w) { s0 = w.s; s1 = w.e; }
    }
    const cut = path.join(tmp, 'cut.wav');
    ff(['-i', full, '-ss', String(s0), '-to', String(s1), '-af', 'loudnorm=I=-20:TP=-3:LRA=11', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', cut]);
    ({ data, sr } = readWav(cut));
    const tr = trimSpeech(data, sr, { tail: 0.5 });
    data = tr.data;
    const len = data.length / sr;
    // 3) Transcript (Hi-Fi cloning needs it word for word).
    const ref = path.join(tmp, 'reference.wav');
    writeWav(ref, data, sr);
    const heard = asr(det, [ref])[ref];
    const transcript = (opt.text || heard?.text || '').trim();
    // 4) Gates.
    const warns = [], errs = [];
    const st = stats(data);
    const depth = pauseDepth(data, sr);
    const f0 = medianF0(data, sr);
    if (len < 4) errs.push(`参考太短（${len.toFixed(1)}s），至少 4 秒，建议 8–15 秒`);
    if (len > 20) warns.push(`参考偏长（${len.toFixed(1)}s），建议 8–15 秒`);
    if (st.clipped > 20) warns.push(`有 ${st.clipped} 处削波，克隆后会带出破音`);
    if (depth < 25) warns.push(`停顿只比说话低 ${depth} dB：可能混有背景音乐或底噪，会被克隆并在长段里放大`);
    if (srcRate && srcRate < 24000) warns.push(`原始采样率只有 ${srcRate} Hz：输出虽是 48 kHz，细节受参考限制`);
    if (srcKbps && srcKbps < 64) warns.push(`原始码率只有 ${srcKbps} kbps（有损压缩），高频细节会打折`);
    if (!transcript) errs.push('没有逐字稿：装好 Whisper 或用 --text 提供');
    else if (!opt.text && heard) warns.push('逐字稿来自 Whisper 识别：打开 transcript.txt 核对一遍，必须与录音逐字一致');
    const rate = transcript ? voicedOnly(transcript).length / Math.max(0.5, len) : 0;
    if (rate && (rate < 2.5 || rate > 8.5)) warns.push(`语速 ${rate.toFixed(1)} 字/秒，逐字稿可能与录音不一致`);
    else if (rate > PACE.refMax) warns.push(`参考语速 ${rate.toFixed(1)} 字/秒偏快：VoxCPM2 会照着这个节奏读，口播会显得急（解说宜 4–5 字/秒）。换一段更从容的录音，或用 voice-design --from ${id} 放慢`);
    for (const e of errs) console.log(`✗ ${e}`);
    if (errs.length) return 1;
    // 5) Save.
    const isPublic = !!opt.public;
    const dir = isPublic ? VOICES_DIR : path.join(LOCAL_VOICES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const audio = path.join(dir, isPublic ? `${id}.wav` : 'reference.wav'), text = path.join(dir, isPublic ? `${id}.txt` : 'transcript.txt');
    fs.copyFileSync(ref, audio);
    fs.writeFileSync(text, transcript + '\n');
    const entry = {
      id, name: opt.name || id, fits: opt.fits || '', rights, source: opt.source,
      reference_audio: isPublic ? `${id}.wav` : path.join(id, 'reference.wav'),
      reference_text: isPublic ? `${id}.txt` : path.join(id, 'transcript.txt'),
      ref_f0: f0 || null, rate: rate ? +rate.toFixed(2) : null, steps: 16, cfg: 2.0, seconds: +len.toFixed(2), sha256: sha(audio),
      original: { file: path.basename(file), sample_rate: srcRate || null, kbps: srcKbps || null, segment: [+s0.toFixed(2), +s1.toFixed(2)] },
      imported: new Date().toISOString().slice(0, 10),
    };
    if (isPublic) {
      const f = path.join(VOICES_DIR, 'catalog.json');
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      // Re-adopting a voice keeps its place in the list and its "fits" line.
      const at = (c.voices || []).findIndex((v) => v.id === id);
      if (at >= 0) { entry.fits ||= c.voices[at].fits || ''; c.voices[at] = entry; } else c.voices = (c.voices || []).concat(entry);
      if (opt.default || !c.default) c.default = id;
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
    } else saveLocalVoice(entry, !!opt.default);
    console.log(`✓ ${entry.name}（${id}）→ ${isPublic ? '公开音色库' : '本机个人音色库'}：${len.toFixed(1)}s，语速 ${rate ? rate.toFixed(1) : '?'} 字/秒，音高 ${f0 || '?'} Hz，停顿深度 ${depth} dB`);
    console.log(`  逐字稿：${transcript}`);
    for (const w of warns) console.log(`  ⚠ ${w}`);
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Voice candidates.
 *   --prompt only         design from a text description (no reference clip) → may become a public voice
 *   --from <id> --prompt  keep an existing voice's timbre and change its delivery (e.g. "语速放慢、从容不急"):
 *                         controllable cloning of that voice; the result inherits its rights (a personal voice stays local)
 * Candidates are ranked by: passes the gates, closeness to the target pace, error rate, pause depth.
 */
export async function designVoices(opt) {
  if (!opt.id || !opt.prompt) { console.error('用法：video.mjs voice-design --id <id> --name <名称> --prompt "声音描述" [--n 6] [--rate 4.5] [--from <已有音色>]'); return 2; }
  if (/云希|晓晓|云扬|云健|云泽|灿灿|周星驰|星爷|石班瑜|孙悟空|猪八戒|林志玲|志玲|像.{0,6}(一样|的声音)/.test(opt.prompt)) {
    console.error('✗ 描述里提到了具体的人、角色或平台音色：公开音色只能描述声音特征（年龄、音色、语速、情绪、口音、用途），不能指向某个人');
    return 2;
  }
  const target = Number(opt.rate) || PACE.target;
  const det = detectVoice();
  let src = null;
  if (opt.from) {
    src = voiceCatalog().voices.find((v) => v.id === opt.from);
    if (!src) { console.error(`✗ 没有音色 ${opt.from}：用 video.mjs voices 查看`); return 2; }
  }
  if (!det.voxcpm) { console.error('✗ 需要本地 VoxCPM2'); return 2; }
  const n = Math.max(1, Math.min(8, Number(opt.n) || 4));
  const dir = path.join(DATA_DIR, 'voice-candidates', opt.id);
  fs.mkdirSync(dir, { recursive: true });
  const seeds = Array.from({ length: n }, (_, k) => 11 + k * 11);
  // The prompt (and the source reference) are part of the file name so a new run never reuses an old candidate.
  const key = opt.prompt + (src ? sha(src.reference_audio) : '');
  const tag = `${src ? `from-${src.id}-` : ''}${crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)}-`;
  const items = seeds.map((sd) => ({
    text: PASSAGE, seed: sd, steps: 20, out: path.join(dir, `${opt.id}-${tag}${sd}.wav`),
    ...(src ? { mode: 'reference', reference: src.reference_audio, instruct: opt.prompt } : { mode: 'design', instruct: opt.prompt }),
  }));
  console.log(src
    ? `改造「${src.name}」：保留音色，按「${opt.prompt}」生成 ${n} 个候选…`
    : `设计「${opt.name || opt.id}」：${n} 个候选（只凭文字描述，不用任何参考音频）…`);
  batch(det, { items, design: opt.prompt, steps: 20 });
  const heard = asr(det, items.map((i) => i.out));
  const prompt = src ? `${src.source || ''} ${opt.prompt}` : opt.prompt;
  const rows = items.map((it) => {
    const { data, sr } = readWav(it.out);
    const tr = trimSpeech(data, sr);
    const st = stats(tr.data);
    const a = heard[it.out];
    const c = a ? cer(PASSAGE, a.text) : null;
    const len = tr.data.length / sr;
    const f0 = medianF0(tr.data, sr);
    const rate = +(voicedOnly(PASSAGE).length / len).toFixed(2);
    // Voice design gives a different "speaker" per seed: flag candidates whose pitch contradicts the requested gender.
    const male = /男/.test(prompt) && !/女/.test(prompt), female = /女/.test(prompt) && !/男/.test(prompt);
    const mismatch = (male && f0 > 230) || (female && f0 && f0 < 150);
    // Re-voicing must keep the timbre: pitch within 12 % of the source voice.
    const drift = !!(src?.ref_f0 && f0 && Math.abs(f0 - src.ref_f0) / src.ref_f0 > 0.12);
    const fast = rate > PACE.refMax, slow = rate < 3.6;
    const ok = (c ?? 0) <= 0.05 && st.clipped < 20 && !mismatch && !drift && !fast && !slow;
    return { file: it.out, seed: it.seed, cer: c == null ? null : +c.toFixed(3), rate, f0, peak: +st.peak.toFixed(1), depth: pauseDepth(tr.data, sr), mismatch, drift, fast, slow, ok };
  });
  rows.sort((a, b) => (b.ok - a.ok) || (Math.round(Math.abs(a.rate - target) / 0.25) - Math.round(Math.abs(b.rate - target) / 0.25)) || (a.cer - b.cer) || (b.depth - a.depth));
  fs.writeFileSync(path.join(dir, `candidates${src ? '-from-' + src.id : ''}.json`), JSON.stringify({ id: opt.id, name: opt.name, from: src?.id || null, prompt: opt.prompt, target, passage: PASSAGE, rows }, null, 2));
  for (const r of rows) {
    const why = [r.mismatch && '音高与描述的性别不符', r.drift && `音高偏离原音色（${src?.ref_f0} Hz）`, r.fast && '语速偏快', r.slow && '语速偏慢'].filter(Boolean);
    console.log(`  ${r.ok ? '✓' : '⚠'} ${path.basename(r.file)}  错字率 ${r.cer}  语速 ${r.rate} 字/秒  音高 ${r.f0} Hz  停顿深度 ${r.depth} dB  峰值 ${r.peak} dBFS${why.length ? '  ← ' + why.join('、') : ''}`);
  }
  console.log(`\n试听：open "${dir}"`);
  const best = rows[0];
  if (src) {
    const pub = src.scope === 'public';
    // The new delivery replaces what the old description said about pace.
    const base = (src.source || '').replace(/"/g, "'").replace(/；.*$/, '');
    const desc = /语速/.test(opt.prompt) ? base.replace(/[，,]\s*语速[^，,。；;]*/g, '') : base;
    console.log(`选中后替换：node video.mjs voice-import "${best.file}" --id ${src.id} --name "${src.name}" --rights ${src.rights}${pub ? ' --public' : ''} --source "${desc}；${opt.prompt}" --text "${PASSAGE}"`);
  } else {
    console.log(`选中后公开：node video.mjs voice-import "${best.file}" --id ${opt.id} --name "${opt.name || opt.id}" --rights designed --public --source "VoxCPM2 文字设计（不对应任何具体的人）：${opt.prompt}" --text "${PASSAGE}"`);
  }
  return 0;
}

/** Say each term in a short sentence with a voice and check that Whisper hears it. */
export async function probeTerms(terms, opt) {
  const det = detectVoice();
  const cat = voiceCatalog();
  const voice = cat.voices.find((v) => v.id === (opt.voice || cat.default));
  if (!det.voxcpm || !voice) { console.error('✗ 需要本地 VoxCPM2 和一个音色（--voice <id>）'); return 2; }
  if (!terms.length) { console.error('用法：video.mjs probe --voice <id> "GPT" "Claude Code"'); return 2; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2i-probe-'));
  const items = [];
  terms.forEach((t, k) => [1, 2].forEach((sd) => items.push({ term: t, text: `这里说的是${t}，你听清了吗？`, seed: sd, mode: 'combined', steps: voice.steps || 16, out: path.join(dir, `t${k}-${sd}.wav`) })));
  batch(det, { reference: voice.reference_audio, transcript: fs.readFileSync(voice.reference_text, 'utf8').trim(), items });
  const heard = asr(det, items.map((i) => i.out));
  for (const t of terms) {
    const got = items.filter((i) => i.term === t).map((i) => String(heard[i.out]?.text || ''));
    const ok = got.filter((g) => latinWords(t).every((w) => g.toLowerCase().includes(w.toLowerCase())) || g.includes(t)).length;
    console.log(`${ok === 2 ? '✓' : ok ? '⚠' : '✗'} ${t}：2 次里 ${ok} 次听得出（${got.map((g) => `「${g.trim()}」`).join(' ')}）${ok < 2 ? ` → 建议在 say 里写读法，例如 "${t}": "${/^[A-Z]{2,5}$/.test(t) ? t.split('').join(' ') : '中文说法'}"` : ''}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return 0;
}

export function listVoices() {
  const c = voiceCatalog();
  if (!c.voices.length) { console.log('还没有音色：用 voice-import 导入本机参考，或 voice-design 设计公开音色'); return; }
  for (const v of c.voices) {
    console.log(`${v.id === c.default ? '★' : ' '} ${v.scope === 'local' ? '[本机]' : '[公开]'} ${v.id.padEnd(16)} ${v.name}  · ${v.rights}  · ${v.ref_f0 || '?'} Hz  · ${v.rate ? `${v.rate} 字/秒${v.rate > PACE.refMax ? '（偏快）' : ''}` : '语速未测'}  · ${v.source || ''}`);
  }
  console.log(`\n★ 默认音色（始终是公开音色）。本机个人音色库：${LOCAL_VOICES_DIR}（只用于本人制作，不随 skill 分发；要用时在 video.json 写 voice.id 或 --voice）`);
}
