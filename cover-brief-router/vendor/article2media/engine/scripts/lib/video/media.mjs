// Optional media for the explainer video, all supplied by the user as local files (nothing is downloaded or generated):
//   scene.clip   — a cut from a source video, shown in the illustration slots (top / bottom) or behind the scene (full)
//   video.music  — a background track: looped / trimmed to the video, faded, ducked under the narration
//   transition   — how a scene replaces the previous one
// Clips become JPEG frames at the video fps (ffmpeg), which the stage swaps per captured frame; an HTML <video>
// cannot be seeked frame-accurately while the page is being screenshotted.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLIP_PLACES = ['top', 'bottom', 'full'];
/** 'rise' is what the video has always done (old scene lifts out, new one rises in); it stays the default. */
export const TRANSITIONS = ['rise', 'cut', 'fade', 'slide', 'push'];
/** Frame size per slot, device px (the stage is 540×960 CSS px at 2×). */
export const CLIP_SIZE = { top: [876, 500], bottom: [1080, 420], full: [1080, 1920] };
export const MUSIC_DEFAULT = { volume: 0.15, duck: 0.5 };
export const CLIP_AUDIO_VOLUME = 0.2;
const REF_LUFS = -14; // the master target: "volume" is relative to the narration's loudness
const SR = 48000;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
  if (r.error) return { error: '需要 ffprobe（随 ffmpeg 安装）' };
  if (r.status !== 0) return { error: '不是能读取的音视频文件' };
  try {
    const j = JSON.parse(r.stdout);
    const types = (j.streams || []).map((s) => s.codec_type);
    return { dur: Number(j.format?.duration) || 0, hasVideo: types.includes('video'), hasAudio: types.includes('audio') };
  } catch { return { error: '不是能读取的音视频文件' }; }
}

/**
 * Where a src points. Local paths resolve against video.json's directory. A network address is accepted only when the
 * work directory's meta.json lists it in videos[] AND the file is already on disk; otherwise the error carries the
 * command to download it (this script never downloads).
 */
function locate(src, dir, what) {
  if (typeof src !== 'string' || !src.trim()) return { error: `${what} 缺少 src（本地文件路径）` };
  if (/^https?:/i.test(src)) {
    let name = 'clip.mp4';
    try { name = path.basename(new URL(src).pathname) || name; } catch {}
    let listed = null;
    for (const d of [dir, path.dirname(dir)]) {
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')); } catch { continue; }
      const hit = (meta.videos || []).find((x) => (typeof x === 'string' ? x : x?.url) === src);
      if (!hit) continue;
      listed = { d, page: meta.url };
      const cands = [hit.file, hit.local, hit.path].filter((x) => typeof x === 'string').map((x) => path.resolve(d, x));
      cands.push(path.join(d, 'videos', name), path.join(d, name), path.join(dir, name));
      const found = cands.find((f) => fs.existsSync(f));
      if (found) return { file: found };
      break;
    }
    const dest = path.join(listed ? listed.d : path.dirname(dir), 'videos', name);
    const cmd = `    curl -L --create-dirs -o ${sh(dest)} ${sh(src)}` + (listed?.page ? `\n    （或 yt-dlp -o ${sh(dest)} ${sh(listed.page)}）` : '');
    return { error: listed
      ? `${what} 的视频还没有下载到本地（不会自动下载）。先运行：\n${cmd}`
      : `${what} 的 src 是网络地址，且不在 meta.json 的 videos[] 里：只接受本地文件。先下载，再把 src 写成本地路径：\n${cmd}` };
  }
  const file = path.resolve(dir, src);
  if (!fs.existsSync(file)) return { error: `${what} 找不到文件 ${src}（路径相对 video.json 所在目录，或写绝对路径）` };
  return { file };
}

/** Resolve and probe every clip and the music track. Returns { clips: { sceneId: {file, dur, hasVideo, hasAudio} | {error} }, music }. */
export function resolveMedia(video, dir) {
  const out = { clips: {}, music: null };
  for (const sc of video.scenes || []) {
    if (!sc.clip || typeof sc.clip !== 'object') continue;
    const loc = locate(sc.clip.src, dir, 'clip');
    out.clips[sc.id] = loc.error ? loc : { ...loc, ...probe(loc.file) };
  }
  if (video.music && typeof video.music === 'object') {
    const loc = locate(video.music.src, dir, 'music');
    out.music = loc.error ? loc : { ...loc, ...probe(loc.file) };
  }
  return out;
}

/** Validation of clip / music / transition fields (part of `video.mjs check`). */
export function checkMedia(video, media) {
  const errs = [], warns = [];
  const tr = (x, W) => { if (x != null && !TRANSITIONS.includes(x)) errs.push(`${W}transition 未知值 ${JSON.stringify(x)}（可用：${TRANSITIONS.join('、')}）`); };
  tr(video.transition, '');
  (video.scenes || []).forEach((s, i) => {
    const W = `scenes[${i}]（${s.id || '?'}）`;
    tr(s.transition, `${W} 的 `);
    const c = s.clip;
    if (c == null) return;
    if (typeof c !== 'object' || Array.isArray(c)) { errs.push(`${W} 的 clip 要写成对象：{"src": "片段.mp4", "start": 0, "end": 6, "place": "top"}`); return; }
    if (c.place != null && !CLIP_PLACES.includes(c.place)) errs.push(`${W} 的 clip.place 未知值 ${JSON.stringify(c.place)}（可用：${CLIP_PLACES.join('、')}）`);
    if (c.start != null && !(isNum(c.start) && c.start >= 0)) errs.push(`${W} 的 clip.start 要是不小于 0 的秒数`);
    if (c.end != null && !isNum(c.end)) errs.push(`${W} 的 clip.end 要是秒数`);
    const st = isNum(c.start) ? c.start : 0;
    if (isNum(c.end) && c.end <= st) errs.push(`${W} 的 clip.end（${c.end}）必须大于 clip.start（${st}）`);
    if (c.audio != null && typeof c.audio !== 'boolean') errs.push(`${W} 的 clip.audio 只能是 true 或 false`);
    if (c.volume != null && !(isNum(c.volume) && c.volume > 0 && c.volume <= 1)) errs.push(`${W} 的 clip.volume 要在 0–1 之间`);
    if (c.scrim != null && !(isNum(c.scrim) && c.scrim >= 0 && c.scrim <= 0.95)) errs.push(`${W} 的 clip.scrim 要在 0–0.95 之间`);
    const m = media?.clips?.[s.id];
    if (!m) return;
    if (m.error) { errs.push(`${W}：${m.error}`); return; }
    if (!m.hasVideo) { errs.push(`${W} 的 clip：${c.src} 里没有视频画面`); return; }
    if (m.dur && st >= m.dur) errs.push(`${W} 的 clip.start（${st}）超出了片段时长（${m.dur.toFixed(1)}s）`);
    else if (m.dur && isNum(c.end) && c.end > m.dur + 0.05) warns.push(`${W} 的 clip.end（${c.end}）超出片段时长（${m.dur.toFixed(1)}s），放完后停在最后一帧`);
    if (c.audio === true && !m.hasAudio) warns.push(`${W} 的 clip.audio 为 true，但片段没有声音`);
    if (typeof s.illustration === 'string' && s.illustration.trim()) warns.push(`${W} 同时写了 clip 和 illustration：这一镜只用片段，不生成插画`);
  });
  const mu = video.music;
  if (mu != null) {
    if (typeof mu !== 'object' || Array.isArray(mu)) errs.push('music 要写成对象：{"src": "配乐.mp3", "volume": 0.15, "duck": true}');
    else {
      if (mu.volume != null && !(isNum(mu.volume) && mu.volume > 0 && mu.volume <= 1)) errs.push('music.volume 要在 0–1 之间（相对旁白响度，默认 0.15）');
      if (mu.duck != null && typeof mu.duck !== 'boolean' && !(isNum(mu.duck) && mu.duck > 0 && mu.duck <= 1)) errs.push('music.duck 只能是 true、false，或 0–1 之间的压低比例');
      const m = media?.music;
      if (m?.error) errs.push(m.error);
      else if (m && !m.hasAudio) errs.push(`music：${mu.src} 里没有声音`);
    }
  }
  return { errs, warns };
}

/**
 * Cut each scene's clip into frames. windows: [{ in, out }] per scene (seconds on the final video).
 * Returns { sceneId: { place, base, n, t, play, scrim, short } }; frames are cached under <dir>/clips/ by their inputs.
 */
export function prepareClips(video, media, windows, { dir, fps, log = () => {} }) {
  const out = {};
  (video.scenes || []).forEach((sc, i) => {
    const m = media?.clips?.[sc.id];
    if (!sc.clip || !m?.file) return;
    const place = CLIP_PLACES.includes(sc.clip.place) ? sc.clip.place : 'top';
    const [w, h] = CLIP_SIZE[place];
    const start = isNum(sc.clip.start) ? sc.clip.start : 0;
    const sceneDur = windows[i].out - windows[i].in;
    const avail = Math.min(isNum(sc.clip.end) ? sc.clip.end : Infinity, m.dur || Infinity) - start;
    const want = +Math.min(avail, sceneDur + 0.5).toFixed(3);
    const st = fs.statSync(m.file);
    const key = crypto.createHash('sha1').update(JSON.stringify([m.file, st.size, st.mtimeMs, start, want, w, h, fps])).digest('hex').slice(0, 10);
    const rel = `clips/sc${i}-${key}`;
    const fdir = path.join(dir, rel);
    const count = () => (fs.existsSync(fdir) ? fs.readdirSync(fdir).filter((f) => /^\d{5}\.jpg$/.test(f)).length : 0);
    let n = fs.existsSync(path.join(fdir, 'done')) ? count() : 0;
    if (!n) {
      fs.rmSync(fdir, { recursive: true, force: true });
      fs.mkdirSync(fdir, { recursive: true });
      const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-ss', String(start), '-i', m.file, '-t', String(want), '-an',
        '-vf', `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`, '-q:v', '3', '-start_number', '0', path.join(fdir, '%05d.jpg')], { encoding: 'utf8' });
      n = count();
      if (r.status !== 0 || !n) throw new Error(`镜头 ${sc.id}：片段取帧失败（${sc.clip.src}）${(r.stderr || '').slice(-300)}`);
      fs.writeFileSync(path.join(fdir, 'done'), '');
      log(`  ✓ 片段 ${sc.id}：${n} 帧（${place}，${start}s 起 ${(n / fps).toFixed(1)}s）`);
    }
    // Drop frames cut for earlier versions of this scene's clip.
    for (const d of fs.readdirSync(path.join(dir, 'clips'))) if (d.startsWith(`sc${i}-`) && d !== path.basename(rel)) fs.rmSync(path.join(dir, 'clips', d), { recursive: true, force: true });
    const play = n / fps;
    out[sc.id] = { place, base: `${rel}/`, n, t: windows[i].in, play: Math.min(play, sceneDur), scrim: isNum(sc.clip.scrim) ? sc.clip.scrim : null,
      short: play < sceneDur - 0.4 ? +(sceneDur - play).toFixed(1) : 0, sceneDur,
      audio: sc.clip.audio === true && m.hasAudio ? { file: m.file, start, dur: Math.min(play, sceneDur), volume: isNum(sc.clip.volume) ? sc.clip.volume : CLIP_AUDIO_VOLUME } : null };
  });
  return out;
}

// ---------- audio bed: music + clip sound, added after the narration has been mastered ----------

function decode(file, ss, t) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...(ss ? ['-ss', String(ss)] : []), '-t', String(t), '-i', file, '-vn', '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: Math.ceil((t + 2) * SR * 8) + (1 << 20) });
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`读不出声音：${file} ${(r.stderr || '').toString().slice(-200)}`);
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 8) * 2).slice();
}

/** Integrated loudness (LUFS) of a stretch of a file; falls back to RMS for stretches too short to gate. null = silent. */
function loudness(file, ss, t, pcm) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...(ss ? ['-ss', String(ss)] : []), '-t', String(t), '-i', file, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const m = [...(r.stderr || '').matchAll(/\bI:\s+(-?[\d.]+) LUFS/g)].pop();
  let I = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(I) || I < -60) {
    let s = 0;
    for (let k = 0; k < pcm.length; k++) s += pcm[k] * pcm[k];
    I = pcm.length ? 10 * Math.log10(s / pcm.length + 1e-12) : -Infinity;
  }
  return I < -60 ? null : I;
}

const smooth = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));

/**
 * Build the bed (interleaved stereo float, 48 kHz) for a video of `total` seconds.
 *   music: { file, src, volume, duck }   speech: [[start, end]] narration on the video clock
 *   clipAudio: [{ file, start, dur, t, volume, id }]
 * Returns { pcm, notes: [{ ok, text }], music: {…levels} } or null when there is nothing to add.
 */
export function buildBed({ music, clipAudio = [], speech = [], total }) {
  const N = Math.ceil(total * SR);
  const bed = new Float32Array(N * 2);
  const notes = [];
  let used = false, info = null;
  if (music?.file) {
    const src = decode(music.file, 0, total);
    const I = loudness(music.file, 0, total, src);
    if (I == null) notes.push({ ok: false, text: `配乐 ${path.basename(music.file)} 是静音，没有加入` });
    else {
      const L = src.length / 2;
      const volume = isNum(music.volume) ? music.volume : MUSIC_DEFAULT.volume;
      const duck = music.duck === false ? 1 : isNum(music.duck) ? music.duck : MUSIC_DEFAULT.duck;
      const g0 = 10 ** ((REF_LUFS - I) / 20) * volume;
      // Loop with a short crossfade at each join (no click); a longer track is simply cut at the end of the video.
      const X = Math.min(Math.floor(SR * 0.08), Math.floor(L / 4)), P = Math.max(1, L - X);
      const loops = L >= N ? 1 : Math.ceil((N - X) / P);
      // Narration stretches closer than the ramps are one stretch: the music stays down through short pauses (no pumping).
      const A = 0.35, HOLD = 0.15, R = 0.6;
      const segs = [];
      for (const [s, e] of [...speech].sort((a, b) => a[0] - b[0])) {
        const last = segs[segs.length - 1];
        if (last && s - last[1] < A + HOLD + R + 0.3) last[1] = Math.max(last[1], e); else segs.push([s, e]);
      }
      // The music is up under the cover and comes back up after the last word, then fades out with the video.
      const FI = 0.3, FO = Math.min(0.8, total / 3);
      let si = 0;
      for (let n = 0; n < N; n++) {
        const t = n / SR;
        while (si < segs.length - 1 && t > segs[si][1] + HOLD + R) si++;
        let d = 1;
        const sg = segs[si];
        if (sg && duck < 1) {
          const x = t < sg[0] ? smooth((t - (sg[0] - A)) / A) : t <= sg[1] + HOLD ? 1 : 1 - smooth((t - sg[1] - HOLD) / R);
          d = 1 - (1 - duck) * x;
        }
        const g = g0 * d * smooth(t / FI) * smooth((total - t) / FO);
        const k = L >= N ? n : n % P, rep = L >= N ? 0 : Math.floor(n / P);
        for (let c = 0; c < 2; c++) {
          let v = src[k * 2 + c] || 0;
          if (rep > 0 && k < X) { const w = k / X; v = v * w + (src[(P + k) * 2 + c] || 0) * (1 - w); }
          bed[n * 2 + c] += v * g;
        }
      }
      used = true;
      const db = (x) => (REF_LUFS + 20 * Math.log10(x)).toFixed(0);
      info = { lufs: I, volume, duck, loops, cut: L >= N && (music.dur || 0) > total + 0.5 };
      notes.push({ ok: true, text: `配乐 ${path.basename(music.file)}（${loops > 1 ? `循环 ${loops} 遍` : info.cut ? `截到 ${total.toFixed(1)}s` : '一遍'}，淡入淡出）：空档约 ${db(volume)} LUFS${duck < 1 ? `，旁白下压到约 ${db(volume * duck)} LUFS` : '，不压低'}` });
    }
  }
  for (const c of clipAudio) {
    const src = decode(c.file, c.start, c.dur);
    const I = loudness(c.file, c.start, c.dur, src);
    if (I == null) { notes.push({ ok: false, text: `镜头 ${c.id} 的片段这一段没有声音` }); continue; }
    const g0 = 10 ** ((REF_LUFS - I) / 20) * c.volume;
    const L = src.length / 2, off = Math.round(c.t * SR), F = Math.min(0.25 * SR, L / 3);
    for (let k = 0; k < L && off + k < N; k++) {
      const g = g0 * smooth(k / F) * smooth((L - k) / F);
      bed[(off + k) * 2] += src[k * 2] * g;
      bed[(off + k) * 2 + 1] += src[k * 2 + 1] * g;
    }
    used = true;
    notes.push({ ok: true, text: `镜头 ${c.id} 片段原声：约 ${(REF_LUFS + 20 * Math.log10(c.volume)).toFixed(0)} LUFS，垫在旁白下` });
  }
  return used ? { pcm: bed, notes, music: info } : (notes.length ? { pcm: null, notes, music: null } : null);
}
