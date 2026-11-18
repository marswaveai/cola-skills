// Narration: detect a voice backend, synthesize sentence-bounded chunks, gate them, build one master track,
// and align character timestamps back onto the written script.
//
// Backends (best first; all optional):
//   voxcpm  local VoxCPM2 (MLX, Apple Silicon) cloning a bundled designed voice — natural, offline
//   edge    Microsoft Edge neural voices via `uvx edge-tts` — free, online, word boundaries
//   say     macOS system voice — always there on a Mac, sounds robotic (last resort)
// Alignment: local mlx-whisper character timestamps when available, else edge word boundaries, else proportional.
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav, trimSpeech, stats, concat } from './wav.mjs';
import { toSpoken, isVoiced, voicedOnly, speechUnits, plainText, intToZh, latinWords } from './text.mjs';
import { medianF0 } from './pitch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..', '..');
const PY = path.join(HERE, 'py');
export const VOICES_DIR = path.join(SKILL, 'assets', 'voices');
const HOME = os.homedir();
const SR = 48000;

// Two voice libraries:
//   public  skills/article2media/assets/voices/  — shipped with the skill: designed voices or explicitly consented ones only
//   local   ~/.local/share/article2media/voices/ — personal references (platform voices, clips from the web, celebrities…);
//           never distributed, never committed. Each entry records its source and rights.
// Local data root. Before 1.5.0 the project was called article2img; keep using that folder if it is the only one present.
const NEW_DATA = path.join(HOME, '.local/share/article2media'), OLD_DATA = path.join(HOME, '.local/share/article2img');
export const DATA_DIR = !fs.existsSync(NEW_DATA) && fs.existsSync(OLD_DATA) ? OLD_DATA : NEW_DATA;
export const LOCAL_VOICES_DIR = process.env.ARTICLE2MEDIA_VOICES || path.join(DATA_DIR, 'voices');
export const PUBLIC_RIGHTS = ['designed', 'self-public', 'authorized-public'];

// Narration pace (voiced characters per second of speech, pauses inside a chunk included).
// A rushed explainer is the worst failure: ~4.5 字/秒 (≈ 270 字/分钟) reads as calm and clear; above 5.2 sounds hurried.
// VoxCPM2 copies the reference's pace, so voices are judged by their reference rate too.
export const PACE = { target: 4.5, max: 5.2, refMax: 5.0, floor: 0.85 };

function readCatalog(dir, scope) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    const voices = (c.voices || []).map((v) => ({
      ...v, scope,
      reference_audio: v.reference_audio && path.resolve(dir, v.reference_audio),
      reference_text: v.reference_text && path.resolve(dir, v.reference_text),
    }));
    return { default: c.default || null, voices };
  } catch { return { default: null, voices: [] }; }
}

export function voiceCatalog() {
  const pub = readCatalog(VOICES_DIR, 'public');
  const loc = readCatalog(LOCAL_VOICES_DIR, 'local');
  // The default is always a public (rights-clean) voice; a personal voice is used only when asked for by id.
  return { default: pub.default || null, voices: [...loc.voices, ...pub.voices] };
}

export function saveLocalVoice(entry, setDefault = false) {
  fs.mkdirSync(LOCAL_VOICES_DIR, { recursive: true });
  const f = path.join(LOCAL_VOICES_DIR, 'catalog.json');
  let c = { _comment: '本机个人音色库：参考音频只用于本人制作，不随 skill 分发、不进仓库。', default: null, voices: [] };
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  c.voices = (c.voices || []).filter((v) => v.id !== entry.id).concat(entry);
  if (setDefault || !c.default) c.default = entry.id;
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}

const ok = (cmd, args, opts = {}) => {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, ...opts }).status === 0; } catch { return false; }
};

/** Find a Python that can import `mod`. */
function findPython(mod, envVars) {
  const cands = [
    ...envVars.map((v) => process.env[v]).filter(Boolean),
    path.join(HOME, '.local/share/voxcpm2-mlx/.venv/bin/python'),
    path.join(DATA_DIR, 'venv/bin/python'),
    path.join(HOME, '.local/share/sweety-handdraw-video/venv/bin/python'),
    path.join(HOME, '.local/share/sweety-3d-video/tts-venv/bin/python'),
  ];
  return cands.find((p) => fs.existsSync(p) && ok(p, ['-c', `import ${mod}`], { timeout: 60000 })) || null;
}

function findVoxcpmModel() {
  const env = process.env.ARTICLE2MEDIA_VOXCPM_MODEL || process.env.HANDDRAW_VOXCPM_MODEL;
  const cands = [env];
  // A model already configured for sweety-handdraw-video on this machine.
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(HOME, '.local/share/sweety-handdraw-video/voices/catalog.json'), 'utf8'));
    for (const v of cat.voices || []) cands.push(v.verified_generation_parameters?.model_path);
  } catch {}
  cands.push(path.join(HOME, '.local/share/voxcpm2-mlx/models/VoxCPM2-8bit'), path.join(DATA_DIR, 'models/VoxCPM2-8bit'));
  return cands.find((p) => p && fs.existsSync(path.join(p, 'config.json'))) || null;
}

function hfCached(repo) {
  const dir = path.join(process.env.HF_HOME || path.join(HOME, '.cache/huggingface'), 'hub', `models--${repo.replace('/', '--')}`);
  return fs.existsSync(dir);
}

// edge-tts runs from uv's cache only; EDGE_INSTALL is the one-time command that puts it there.
const EDGE_RUN = ['run', '--offline', '--no-project', '--quiet', '--with', 'edge-tts', 'python'];
export const EDGE_INSTALL = 'uv run --no-project --with edge-tts python -c "import edge_tts"';

let DETECTED;
/** What this machine can do. Never installs or downloads anything. */
export function detectVoice({ fresh = false } = {}) {
  if (DETECTED && !fresh) return DETECTED;
  const mlxPy = findPython('mlx_audio', ['ARTICLE2MEDIA_MLX_PYTHON', 'HANDDRAW_MLX_PYTHON']);
  const model = mlxPy ? findVoxcpmModel() : null;
  const asrModel = process.env.ARTICLE2MEDIA_ASR_MODEL || 'mlx-community/whisper-large-v3-turbo';
  const whisperPy = (mlxPy && ok(mlxPy, ['-c', 'import mlx_whisper'], { timeout: 60000 }) ? mlxPy : null) || findPython('mlx_whisper', ['ARTICLE2MEDIA_ASR_PYTHON']);
  const uvx = ok('uv', ['--version']);
  // edge-tts counts only when it is already in uv's cache: `--offline` never downloads the package.
  const edgeReady = uvx && ok('uv', [...EDGE_RUN, '-c', 'import edge_tts'], { timeout: 60000 });
  DETECTED = {
    voxcpm: mlxPy && model ? { python: mlxPy, model } : null,
    whisper: whisperPy && hfCached(asrModel) ? { python: whisperPy, model: asrModel } : null,
    edge: edgeReady ? { cmd: 'uv' } : null,
    edgeInstall: edgeReady ? null : uvx ? EDGE_INSTALL : `先装 uv（https://docs.astral.sh/uv/），再运行：${EDGE_INSTALL}`,
    say: process.platform === 'darwin' && ok('say', ['-v', '?']) ? { cmd: 'say' } : null,
  };
  DETECTED.best = DETECTED.voxcpm ? 'voxcpm' : DETECTED.edge ? 'edge' : DETECTED.say ? 'say' : null;
  return DETECTED;
}

// ---------- chunking ----------

/** Lines of all scenes → sentence-bounded chunks (≤ maxLen voiced chars), never crossing a scene. */
export function planChunks(scenes, say, maxLen = 90) {
  const chunks = [];
  for (const sc of scenes) {
    const lines = (sc.lines || []).map(plainText).filter((l) => l.trim());
    // Sentences: split each line at 。！？… keeping the punctuation; lines are joined within a scene.
    const sentences = [];
    lines.forEach((line, li) => {
      let start = 0;
      for (let i = 0; i < line.length; i++) {
        if (/[。！？!?…]/.test(line[i]) && !/[。！？!?…”」]/.test(line[i + 1] || '')) { sentences.push({ li, from: start, to: i + 1 }); start = i + 1; }
      }
      if (line.slice(start).trim()) sentences.push({ li, from: start, to: line.length });
    });
    let cur = null;
    for (const s of sentences) {
      const text = lines[s.li].slice(s.from, s.to);
      const len = Math.ceil(speechUnits(text));
      if (cur && cur.len + len <= maxLen && cur.li === s.li) { cur.to = s.to; cur.len += len; continue; }
      if (cur) chunks.push(cur);
      cur = { scene: sc.id, li: s.li, from: s.from, to: s.to, len };
    }
    if (cur) chunks.push(cur);
    for (const c of chunks.filter((c) => c.scene === sc.id && c.written === undefined)) {
      c.written = lines[c.li].slice(c.from, c.to).trim();
      const lead = lines[c.li].slice(c.from, c.to).length - lines[c.li].slice(c.from, c.to).trimStart().length;
      c.from += lead;
      c.style = (sc.styles || [])[c.li] || sc.style || '';
      const sp = toSpoken(c.written, say);
      c.spoken = sp.spoken;
      c.map = sp.map;
    }
  }
  return chunks;
}

const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);

// ---------- backends ----------

function runVoxcpm(det, voice, items, dir) {
  const ref = voice.reference_audio;
  const transcript = fs.readFileSync(voice.reference_text, 'utf8').trim();
  const job = { model: det.voxcpm.model, reference: ref, transcript, cfg: voice.cfg || 2.0, steps: voice.steps || 16, items };
  const jobFile = path.join(dir, `voxcpm-job-${Date.now()}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const r = spawnSync(det.voxcpm.python, [path.join(PY, 'voxcpm_batch.py'), jobFile], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 << 20 });
  fs.rmSync(jobFile, { force: true });
  if (r.status !== 0) throw new Error(`VoxCPM2 生成失败：${(r.stderr || '').split('\n').filter((l) => !/warn/i.test(l)).slice(-6).join('\n')}`);
}

function toWav48(src, out) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 转换失败：${r.stderr}`);
}

function runEdge(voiceName, rate, items, dir) {
  for (const it of items) {
    if (fs.existsSync(it.out)) continue;
    const mp3 = it.out.replace(/\.wav$/, '.mp3');
    const words = it.out.replace(/\.wav$/, '.words.json');
    // edge-tts ≥ 7.3 needs boundary="WordBoundary" for word timestamps; done through its Python API.
    const code = `
import asyncio, json, sys, edge_tts
async def main():
    c = edge_tts.Communicate(sys.argv[1], sys.argv[2], rate=sys.argv[3], boundary="WordBoundary")
    words = []
    with open(sys.argv[4], "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio": f.write(ch["data"])
            elif ch["type"] == "WordBoundary": words.append([ch["text"], ch["offset"] / 1e7, (ch["offset"] + ch["duration"]) / 1e7])
    json.dump(words, open(sys.argv[5], "w"), ensure_ascii=False)
asyncio.run(main())`;
    const r = spawnSync('uv', [...EDGE_RUN, '-c', code, it.text, voiceName, rate, mp3, words], { encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0) throw new Error(`edge-tts 失败（合成需要联网；音色 ${voiceName}）：${(r.stderr || '').slice(-400)}`);
    toWav48(mp3, it.out);
    fs.rmSync(mp3, { force: true });
  }
}

function runSay(items) {
  for (const it of items) {
    if (fs.existsSync(it.out)) continue;
    const aiff = it.out.replace(/\.wav$/, '.aiff');
    const r = spawnSync('say', ['-v', 'Tingting', '-o', aiff, it.text], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`say 失败：${r.stderr}`);
    toWav48(aiff, it.out);
    fs.rmSync(aiff, { force: true });
  }
}

// ---------- ASR + alignment ----------

function runAsr(det, files) {
  if (!det.whisper || !files.length) return {};
  const out = {};
  const todo = [];
  for (const f of files) {
    const c = `${f}.asr.json`;
    if (fs.existsSync(c)) out[f] = JSON.parse(fs.readFileSync(c, 'utf8')); else todo.push(f);
  }
  if (!todo.length) return out;
  const r = spawnSync(det.whisper.python, [path.join(PY, 'asr_words.py'), det.whisper.model, ...todo], {
    encoding: 'utf8', timeout: 1800000, maxBuffer: 64 << 20, env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  if (r.status !== 0) throw new Error(`Whisper 对齐失败：${(r.stderr || '').slice(-500)}`);
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const j = JSON.parse(line);
    out[j.file] = j;
    fs.writeFileSync(`${j.file}.asr.json`, JSON.stringify(j));
  }
  return out;
}

/** Normalize ASR text for comparison: digits → Chinese reading, keep voiced characters only. */
const normAsr = (s) => voicedOnly(String(s).toLowerCase().replace(/\d[\d,]*(\.\d+)?/g, (m) => {
  const [i, f] = m.replace(/,/g, '').split('.');
  return intToZh(Number(i)) + (f ? '点' + [...f].map((d) => '零一二三四五六七八九'[d]).join('') : '');
}));

function cer(ref, hyp) {
  const a = [...ref], b = [...hyp];
  let d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const p = d; d = [i];
    for (let j = 1; j <= b.length; j++) d[j] = Math.min(p[j] + 1, d[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[b.length] / Math.max(1, a.length);
}

/** ASR words → per-character times on the ASR's own (normalized) text. */
function asrCharTimes(words) {
  const chars = [];
  for (const [w, s, e] of words) {
    const t = normAsr(w);
    const n = [...t].length;
    [...t].forEach((ch, k) => chars.push({ ch, s: s + ((e - s) * k) / n, e: s + ((e - s) * (k + 1)) / n }));
  }
  return chars;
}

/**
 * Align target characters (voiced chars of the spoken text) with timed ASR characters (edit-distance DP);
 * unmatched targets are interpolated. Returns [{s, e}] per target char.
 */
function alignChars(target, timed, dur) {
  const n = target.length, m = timed.length;
  if (!n) return [];
  if (!m) return target.map((_, i) => ({ s: (dur * i) / n, e: (dur * (i + 1)) / n }));
  const W = m + 1;
  const D = new Float32Array((n + 1) * W), P = new Uint8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) { D[i * W] = i; P[i * W] = 1; }
  for (let j = 1; j <= m; j++) { D[j] = j; P[j] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const sub = D[(i - 1) * W + j - 1] + (target[i - 1].toLowerCase() === timed[j - 1].ch ? 0 : 1);
    const del = D[(i - 1) * W + j] + 1, ins = D[i * W + j - 1] + 1;
    const best = Math.min(sub, del, ins);
    D[i * W + j] = best;
    P[i * W + j] = best === sub ? 0 : best === del ? 1 : 2;
  }
  const res = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const p = P[i * W + j];
    if (p === 0) { res[i - 1] = { s: timed[j - 1].s, e: timed[j - 1].e }; i--; j--; } else if (p === 1) i--; else j--;
  }
  // Interpolate gaps.
  for (let k = 0; k < n; k++) {
    if (res[k]) continue;
    let a = k - 1; while (a >= 0 && !res[a]) a--;
    let b = k + 1; while (b < n && !res[b]) b++;
    const t0 = a >= 0 ? res[a].e : 0, t1 = b < n ? res[b].s : dur;
    const span = b - a - 1;
    for (let q = a + 1; q < b; q++) { const f0 = (q - a - 1) / span, f1 = (q - a) / span; res[q] = { s: t0 + (t1 - t0) * f0, e: t0 + (t1 - t0) * f1 }; }
    k = b - 1;
  }
  return res;
}

// ---------- main ----------

/**
 * Synthesize narration for `scenes` into `dir`. Returns the alignment object (also written to dir/alignment.json).
 * opts: { voiceId, backend: 'auto'|'voxcpm'|'edge'|'say', say, log, sceneGap, lineGap, holds: {sceneId: extra seconds after it} }
 */
export async function synthesize(scenes, dir, opts = {}) {
  const log = opts.log || console.log;
  const det = detectVoice();
  const catalog = voiceCatalog();
  const wanted = opts.voiceId || catalog.default;
  let voice = catalog.voices.find((v) => v.id === wanted) || catalog.voices[0] || null;
  if (opts.voiceId && voice?.id !== opts.voiceId) throw new Error(`没有音色 ${opts.voiceId}：用 video.mjs voices 查看，或用 voice-import 导入`);
  let backend = opts.backend && opts.backend !== 'auto' ? opts.backend : det.best;
  if (backend === 'voxcpm' && !voice) {
    if (opts.backend === 'voxcpm') throw new Error('VoxCPM2 需要一个参考音色：先用 video.mjs voice-import 导入，或 voice-design 设计一个');
    backend = det.edge ? 'edge' : det.say ? 'say' : null;
  }
  if (backend === 'edge' && !det.edge) throw new Error(`edge-tts 还没装（不会自动下载）：${det.edgeInstall}`);
  if (!backend || !det[backend]) throw new Error(`没有可用的配音方式${opts.backend ? `（要求 ${opts.backend}）` : ''}：见 video.mjs doctor`);
  voice ||= { id: 'system', name: '系统语音', edge_fallback: 'zh-CN-YunxiNeural' };
  const chunks = planChunks(scenes, opts.say || {});
  const cdir = path.join(dir, 'chunks');
  fs.mkdirSync(cdir, { recursive: true });
  const refSha = backend === 'voxcpm' ? crypto.createHash('sha1').update(fs.readFileSync(voice.reference_audio)).digest('hex').slice(0, 10) : '';
  const ident = { backend, voice: voice.id, ref: refSha, steps: voice.steps || 16, model: backend === 'voxcpm' ? path.basename(det.voxcpm.model) : backend === 'edge' ? voice.edge_fallback || 'zh-CN-YunxiNeural' : 'Tingting', v: 3 };
  log(`配音：${backend === 'voxcpm' ? `本地 VoxCPM2 · ${voice.name}（${voice.scope === 'local' ? '本机音色库' : '公开音色'}）` : backend === 'edge' ? `edge-tts · ${voice.edge_fallback || 'zh-CN-YunxiNeural'}` : 'macOS 系统语音（效果有限）'}，${chunks.length} 段`);

  const fileFor = (c, seed) => path.join(cdir, `${hash({ ...ident, text: c.spoken, style: c.style || '', seed })}.wav`);
  // Lines with English terms get more tries: a voice may need several seeds to pronounce a word recognizably.
  const seeds = backend === 'voxcpm' ? [voice.seed || 1, 101, 202, 303, 404] : [0];
  const maxTries = (c) => (backend !== 'voxcpm' ? 1 : latinWords(c.spoken).length ? 5 : 3);
  const results = new Array(chunks.length).fill(null);
  const takes = chunks.map(() => []);
  const measure = (c, file, a) => {
    const { data, sr } = readWav(file);
    const tr = trimSpeech(data, sr);
    const st = stats(tr.data);
    const dur = tr.data.length / sr;
    // 字 per second: Latin words count by syllables, so a line with "Anthropic" is not read as rushed and stretched.
    const rate = speechUnits(c.spoken) / Math.max(0.1, dur);
    const problems = [];
    if (tr.empty) problems.push('没有声音');
    if (tr.truncated) problems.push('结尾被截断');
    if (st.clipped > 20) problems.push(`削波 ${st.clipped} 处`);
    if (rate < 2.5 || rate > 8.5) problems.push(`语速异常 ${rate.toFixed(1)} 字/秒`);
    // Pace: plain lines faster than PACE.max are retried (styled lines — anger, excitement — may run faster).
    else if (!c.style && rate > PACE.max) problems.push(`语速偏快 ${rate.toFixed(1)} 字/秒`);
    // Voice drift: a chunk whose pitch wanders far from the reference voice is regenerated.
    // Styled lines (anger, crying, dialect…) legitimately move the pitch, so only plain lines are checked.
    let f0 = 0;
    if (backend === 'voxcpm' && voice.ref_f0 && !tr.empty) {
      f0 = medianF0(tr.data, sr);
      const dev = f0 ? Math.abs(f0 - voice.ref_f0) / voice.ref_f0 : 0;
      if (!c.style && dev > 0.22) problems.push(`音色漂移：音高 ${f0} Hz，参考 ${voice.ref_f0} Hz`);
    }
    let c_er = null;
    if (a) {
      const ref = voicedOnly(c.spoken).toLowerCase(), hyp = normAsr(a.text);
      c_er = cer(ref, hyp);
      if (c_er > 0.2) problems.push(`识别错字率 ${(c_er * 100).toFixed(0)}%`);
      const lastRef = ref.slice(-1);
      // A missing ending makes the transcript shorter; a same-length transcript with a different last character is a
      // homophone the recognizer preferred (俯仰 → 抚养, 推镜 → 推进), not a swallowed word.
      if (lastRef && !hyp.slice(-3).includes(lastRef) && c_er > 0.05 && hyp.length < ref.length) problems.push('末字可能没读出');
      // Mixed Chinese/English: every Latin word should show up in the transcript.
      const heard = String(a.text).toLowerCase();
      const missed = latinWords(c.spoken).filter((w) => !heard.includes(w.toLowerCase()));
      if (missed.length) problems.push(`英文词可能没读准：${missed.join('、')}（可在 say 里给中文读法）`);
    }
    return { file, trimmed: tr, sr, asr: a, cer: c_er, rate, f0, problems };
  };
  const onlyPace = (r) => r.problems.every((p) => p.startsWith('语速偏快'));
  for (let attempt = 0; attempt < seeds.length; attempt++) {
    const todo = chunks.map((c, i) => ({ c, i })).filter(({ c, i }) => !results[i] && attempt < maxTries(c));
    if (!todo.length) break;
    // Plain lines use Hi-Fi cloning (closest to the reference); lines with a style instruction use controllable cloning.
    const items = todo.map(({ c }) => ({ text: c.spoken, seed: seeds[attempt], out: fileFor(c, seeds[attempt]), mode: c.style ? 'reference' : 'combined', ...(c.style ? { instruct: c.style } : {}) }));
    const freshSet = new Set(items.filter((it) => !fs.existsSync(it.out)).map((it) => it.out));
    const fresh = freshSet.size;
    if (fresh) log(`  生成 ${fresh} 段（第 ${attempt + 1} 轮）…`);
    else if (attempt === 0) log('  全部段落已缓存，直接复用');
    if (fresh) {
      if (backend === 'voxcpm') runVoxcpm(det, voice, items.filter((it) => !fs.existsSync(it.out)), cdir);
      else if (backend === 'edge') runEdge(voice.edge_fallback || 'zh-CN-YunxiNeural', opts.rate || '+0%', items, cdir);
      else runSay(items);
    }
    const asr = runAsr(det, items.map((it) => it.out));
    todo.forEach(({ c, i }, k) => {
      const r = measure(c, items[k].out, asr[items[k].out]);
      takes[i].push(r);
      const lastTry = attempt >= maxTries(c) - 1;
      // Cached takes were already reported when they were generated.
      if (r.problems.length && !lastTry) { if (freshSet.has(items[k].out)) log(`  ✗ 第 ${i + 1} 段：${r.problems.join('、')}，换种子重试`); return; }
      // Out of tries: keep the best take (fewest problems other than pace, then slowest).
      const best = takes[i].slice().sort((x, y) => (x.problems.filter((p) => !p.startsWith('语速偏快')).length - y.problems.filter((p) => !p.startsWith('语速偏快')).length) || (x.rate - y.rate))[0];
      results[i] = best;
      if (best.problems.length && !onlyPace(best)) log(`  ⚠ 第 ${i + 1} 段：${best.problems.join('、')}（已用尽重试，保留最好的一次）`);
    });
  }
  // Still too fast after all tries (a quick reference voice, edge, say): slow the take down to the target pace.
  // Time-stretching keeps the pitch; it is capped at PACE.floor so the voice doesn't smear.
  const slowed = [];
  const stretch = [];
  results.forEach((r, i) => {
    if (!r || chunks[i].style || r.rate <= PACE.max) return;
    const factor = Math.max(PACE.floor, (PACE.target + 0.3) / r.rate);
    const out = r.file.replace(/\.wav$/, `-t${Math.round(factor * 100)}.wav`);
    if (!fs.existsSync(out)) {
      const st = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', r.file, '-af', `atempo=${factor.toFixed(3)}`, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out], { encoding: 'utf8' });
      if (st.status !== 0) return;
    }
    stretch.push({ i, out, from: r.rate });
  });
  if (stretch.length) {
    const asr2 = runAsr(det, stretch.map((s) => s.out));
    for (const s of stretch) {
      const r = measure(chunks[s.i], s.out, asr2[s.out]);
      r.stretched = +(s.from / Math.max(0.1, r.rate)).toFixed(2);
      results[s.i] = r;
      slowed.push(`第 ${s.i + 1} 段 ${s.from.toFixed(1)}→${r.rate.toFixed(1)}`);
    }
    log(`  放慢语速（保持音高）：${slowed.join('、')} 字/秒`);
  }
  results.forEach((r, i) => { if (r.problems.length && onlyPace(r) && !r.stretched) log(`  ⚠ 第 ${i + 1} 段：${r.problems.join('、')}`); });

  // Master: chunks joined with pauses (longer between scenes).
  const parts = [];
  const timeline = [];
  let t = 0;
  chunks.forEach((c, i) => {
    const r = results[i];
    if (i > 0) {
      const gap = chunks[i - 1].scene !== c.scene ? (opts.sceneGap ?? 0.5) + (opts.holds?.[chunks[i - 1].scene] || 0) : (opts.lineGap ?? 0.34);
      parts.push({ silence: gap });
      t += gap;
    }
    const d = r.trimmed.data.length / r.sr;
    parts.push({ data: r.trimmed.data });
    timeline.push({ start: t, end: t + d, lead: r.trimmed.start });
    t += d;
  });
  parts.push({ silence: 0.3 });
  const master = concat(parts, SR);
  const masterRaw = path.join(dir, 'narration-raw.wav');
  writeWav(masterRaw, master, SR);
  // Loudness: voice to -16 LUFS (music and the final master are leveled later).
  const masterPath = path.join(dir, 'narration.wav');
  const ln = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', masterRaw, '-af', 'highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=9', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', masterPath], { encoding: 'utf8' });
  if (ln.status !== 0) throw new Error(`响度处理失败：${ln.stderr}`);

  // Alignment: per chunk ASR char times (shifted by the trim) → spoken chars → written chars.
  const lines = {};
  chunks.forEach((c, i) => {
    const r = results[i];
    const tl = timeline[i];
    const dur = tl.end - tl.start;
    const spokenVoiced = [];
    [...c.spoken].forEach((ch, k) => { if (isVoiced(ch)) spokenVoiced.push({ ch, k }); });
    let times;
    if (r.asr?.words?.length) {
      const timed = asrCharTimes(r.asr.words).map((x) => ({ ...x, s: x.s - tl.lead, e: x.e - tl.lead }));
      times = alignChars(spokenVoiced.map((x) => x.ch), timed, dur);
    } else {
      const wordsFile = r.file.replace(/\.wav$/, '.words.json');
      const ew = fs.existsSync(wordsFile) ? JSON.parse(fs.readFileSync(wordsFile, 'utf8')) : null;
      times = ew?.length
        ? alignChars(spokenVoiced.map((x) => x.ch), asrCharTimes(ew).map((x) => ({ ...x, s: x.s - tl.lead, e: x.e - tl.lead })), dur)
        : spokenVoiced.map((_, k) => ({ s: (dur * k) / spokenVoiced.length, e: (dur * (k + 1)) / spokenVoiced.length }));
    }
    // Written char index → earliest spoken time.
    const key = `${c.scene}#${c.li}`;
    lines[key] ||= { scene: c.scene, li: c.li, chars: {} };
    spokenVoiced.forEach((x, k) => {
      const w = c.from + c.map[x.k];
      const s = tl.start + Math.max(0, times[k].s), e = tl.start + Math.max(0, times[k].e);
      const cur = lines[key].chars[w];
      if (!cur) lines[key].chars[w] = { s, e };
      else { cur.s = Math.min(cur.s, s); cur.e = Math.max(cur.e, e); }
    });
  });

  const align = { version: 1, holds: opts.holds || {}, backend, voice: voice.id, voiceName: voice.name, duration: master.length / SR, file: 'narration.wav', scenes: [] };
  for (const sc of scenes) {
    const scLines = (sc.lines || []).map(plainText);
    const L = scLines.map((text, li) => {
      const ch = lines[`${sc.id}#${li}`]?.chars || {};
      const idx = Object.keys(ch).map(Number).sort((a, b) => a - b);
      // Fill every written index (punctuation inherits the previous voiced char's end).
      const per = [];
      let last = idx.length ? ch[idx[0]].s : 0;
      for (let k = 0; k < text.length; k++) {
        if (ch[k]) { per.push([+ch[k].s.toFixed(3), +ch[k].e.toFixed(3)]); last = ch[k].e; } else per.push([+last.toFixed(3), +last.toFixed(3)]);
      }
      return { text, start: idx.length ? +ch[idx[0]].s.toFixed(3) : null, end: idx.length ? +Math.max(...idx.map((k) => ch[k].e)).toFixed(3) : null, chars: per };
    });
    const st = L.map((l) => l.start).filter((x) => x != null), en = L.map((l) => l.end).filter((x) => x != null);
    align.scenes.push({ id: sc.id, start: st.length ? Math.min(...st) : null, end: en.length ? Math.max(...en) : null, lines: L });
  }
  align.checks = results.map((r, i) => ({ chunk: i + 1, scene: chunks[i].scene, text: chunks[i].written, style: chunks[i].style || '', cer: r.cer == null ? null : +r.cer.toFixed(3), rate: +r.rate.toFixed(2), ...(r.stretched ? { stretched: r.stretched } : {}), f0: r.f0 || null, problems: r.problems }));
  align.voiceScope = voice.scope || null;
  align.voiceSource = voice.source || null;
  align.voiceRights = voice.rights || null;
  align.refF0 = voice.ref_f0 || null;
  const plain = align.checks.filter((c) => !c.style);
  align.pace = plain.length ? +(plain.reduce((a, c) => a + c.rate, 0) / plain.length).toFixed(2) : null;
  align.asr = !!det.whisper;
  fs.writeFileSync(path.join(dir, 'alignment.json'), JSON.stringify(align, null, 1));
  return align;
}
