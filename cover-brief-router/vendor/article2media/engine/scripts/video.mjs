#!/usr/bin/env node
// Article → 9:16 explainer video (1080×1920): director's script (video.json) → narration → animated scenes → MP4.
//
//   node video.mjs doctor                         # what this machine can do (voice, alignment, images, ffmpeg)
//   node video.mjs check  <video.json>            # validate the script (hook length, cues, pacing)
//   node video.mjs voice  <video.json>            # narration + character timestamps → <dir>/voice/
//   node video.mjs images <video.json>            # optional AI art (cover / scenes) → <dir>/illustrations/
//   node video.mjs render <video.json> [--theme 名称]
//   node video.mjs make   <video.json> [--theme 名称] [--no-images]   # all of the above
//   node video.mjs voices                          # 列出公开音色与本机个人音色库
//   node video.mjs voice-import <音频> --id <id> --name <名称> --rights personal|self|authorized --source "来源说明" [--text 逐字稿] [--start 秒 --end 秒]
//   node video.mjs voice-design --id <id> --name <名称> --prompt "声音描述" [--n 6] [--rate 4.5]   # 公开音色候选（只凭文字描述生成）
//   node video.mjs voice-design --id <id> --from <已有音色> --prompt "语速放慢、从容不急"           # 保留音色、改语气/语速
//   node video.mjs probe --voice <id> "GPT" "Claude Code"                         # 试读英文 / 术语
//
// Options: --backend voxcpm|edge|say  --voice <id>  --fresh
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { detectVoice, synthesize, voiceCatalog, PACE } from './lib/video/voice.mjs';
import { importVoice, designVoices, probeTerms, listVoices } from './lib/video/voicelib.mjs';
import { splitStyle } from './lib/video/text.mjs';
import { renderVideo, buildStage, TIMING } from './lib/video/render.mjs';
import { SCENE_TYPES } from './lib/video/scenes.mjs';
import { resolveMedia, checkMedia } from './lib/video/media.mjs';
import { plainText, toSpoken, speechUnits, captionPhrases, capWidth } from './lib/video/text.mjs';
import { detectImageProviders, pickImageProvider, generateImage } from './lib/imagegen.mjs';
import { themeStyle, themePalette } from './lib/illustrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: 'string', short: 't' },
    backend: { type: 'string' },
    voice: { type: 'string' },
    images: { type: 'boolean', default: true },
    'no-images': { type: 'boolean', default: false },
    provider: { type: 'string' },
    fresh: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    id: { type: 'string' }, name: { type: 'string' }, rights: { type: 'string' }, source: { type: 'string' }, text: { type: 'string' },
    start: { type: 'string' }, end: { type: 'string' }, prompt: { type: 'string' }, n: { type: 'string' }, fits: { type: 'string' }, from: { type: 'string' }, rate: { type: 'string' },
    public: { type: 'boolean', default: false }, default: { type: 'boolean', default: false },
  },
});
const [cmd, file] = positionals;
const die = (m, code = 1) => { console.error(m); process.exit(code); };

// ---------- doctor ----------
function doctor() {
  const v = detectVoice({ fresh: true });
  const img = detectImageProviders();
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
  const voiceLine = v.voxcpm ? `✓ 本地 VoxCPM2（${path.basename(v.voxcpm.model)}）：自然、离线，推荐`
    : v.edge ? '✓ edge-tts（微软神经语音，免费，需要联网）' : v.say ? '⚠ 只有 macOS 系统语音：能用，但机械感明显' : '✗ 没有可用的配音方式';
  const report = {
    ffmpeg,
    voice: { best: v.best, voxcpm: !!v.voxcpm, edge: !!v.edge, say: !!v.say },
    alignment: v.whisper ? 'whisper（逐字时间戳）' : v.edge ? 'edge-tts 词边界' : '按字数估算',
    images: { codex: !!img.codex, gemini: !!img.gemini, openai: !!img.openai, pick: pickImageProvider() },
  };
  if (opt.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`配音    ${voiceLine}`);
  console.log(`对齐    ${v.whisper ? '✓ 本地 Whisper，逐字时间戳' : v.edge && v.best === 'edge' ? '✓ edge-tts 词边界' : '⚠ 没有逐字时间戳：画面按字数估算对齐'}`);
  console.log(`插画    ${img.codex ? '✓ Codex CLI（用 ChatGPT 登录出图，不需要 key）' : img.openai ? '✓ OpenAI' : img.gemini ? '⚠ 只有 Gemini key（免费层没有图像额度）' : '— 没有出图能力：封面和镜头只用排版与图表（不影响出片）'}`);
  console.log(`ffmpeg  ${ffmpeg ? '✓' : '✗ 需要安装 ffmpeg'}`);
  if (!v.voxcpm) {
    console.log('\n建议：');
    if (!v.edge) console.log(`  - 免费的 edge-tts 神经语音（不会自动下载，装一次即可）：${v.edgeInstall}`);
    console.log('  - Apple Silicon 上装本地 VoxCPM2（mlx-audio + 模型约 3 GB）可获得最自然的声音，见 references/video-guide.md');
  }
}

// ---------- check ----------
function load(f) {
  if (!f) die('用法：node video.mjs <make|check|voice|images|render> <video.json>', 2);
  const p = path.resolve(f);
  const v = JSON.parse(fs.readFileSync(p, 'utf8'));
  // "(极度愤怒，东北话)正文": the bracket is a voice instruction, not narration — keep it aside for the voice step.
  for (const sc of v.scenes || []) {
    const parts = (sc.lines || []).map(splitStyle);
    sc.styles = parts.map((x) => x.style);
    sc.lines = parts.map((x) => x.text);
    // Local pictures (image scenes, evidence / title images) resolve against video.json's directory.
    for (const o of [sc, sc.image]) {
      if (o && typeof o.src === 'string' && !/^(https?|data|file):/i.test(o.src)) {
        const file = path.resolve(path.dirname(p), o.src);
        if (!fs.existsSync(file)) die(`✗ 镜头 ${sc.id}：找不到图片 ${o.src}（本地图片的路径相对 video.json 所在目录）`, 2);
        o.src = pathToFileURL(file).href;
      }
    }
  }
  // Clips and music are local files too; what is missing is reported by check(), with the other script errors.
  return { v, p, dir: path.dirname(p), media: resolveMedia(v, path.dirname(p)) };
}

function check(v, media) {
  const errs = [], warns = [];
  if (!Array.isArray(v.scenes) || !v.scenes.length) errs.push('scenes 不能为空');
  const ids = new Set();
  let units = 0;
  (v.scenes || []).forEach((s, i) => {
    const W = `scenes[${i}]（${s.id || '?'}）`;
    if (!s.id) errs.push(`${W} 缺少 id`);
    if (ids.has(s.id)) errs.push(`${W} id 重复`);
    ids.add(s.id);
    if (!SCENE_TYPES.includes(s.type)) errs.push(`${W} 未知类型 ${s.type}（可用：${SCENE_TYPES.join('、')}）`);
    if (!(s.lines || []).length) errs.push(`${W} 缺少 lines（口播）`);
    const text = (s.lines || []).map(plainText).join('');
    units += speechUnits(toSpoken(text, v.say || {}).spoken);
    // Every cue must be a substring of this scene's narration, or it will fall back to an estimate.
    const cues = [];
    const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, val] of Object.entries(o)) { if (/cue$/.test(k) && typeof val === 'string') cues.push(val); else if (typeof val === 'object') walk(val); } };
    walk(s);
    for (const c of cues) if (!text.includes(c)) warns.push(`${W} 的 cue「${c}」不在口播里，会按估算时间出现`);
    for (const l of s.lines || []) for (const ph of captionPhrases(l)) if (capWidth(ph.text) > 15) warns.push(`${W} 字幕「${ph.text}」超过一行（13 字），会缩小字号`);
  });
  const first = plainText(v.scenes?.[0]?.lines?.[0] || '');
  const firstUnits = Math.round(speechUnits(toSpoken(first, v.say || {}).spoken));
  // At a calm ~4.5 字/秒, starting at 0.8 s, about 19 characters fit before 5.2 s.
  if (firstUnits > 19) warns.push(`首句 ${firstUnits} 字，超过 19 字：按从容的语速（约 ${PACE.target} 字/秒）黄金 5 秒内说不完，缩短首句，别靠加快语速`);
  units = Math.round(units);
  if (/大家好|今天给大家|哈喽|欢迎来到/.test(first)) warns.push('首句在寒暄，直接给结果、冲突或问题');
  if (units < 120) warns.push(`口播只有 ${units} 字，偏短`);
  if (units > 420) warns.push(`口播 ${units} 字，超过 90 秒，考虑删减`);
  if (!v.cover?.title) warns.push('没有 cover.title：第一帧会没有标题');
  const m = checkMedia(v, media);
  errs.push(...m.errs);
  warns.push(...m.warns);
  // Calibrated on real renders: the voice runs a little under the target pace and every line ends in a short breath.
  const nLines = (v.scenes || []).reduce((a, s) => a + (s.lines || []).length, 0);
  const estSeconds = units / (PACE.target * 0.93) + nLines * 0.3 + (v.scenes || []).length * 0.5 + TIMING.coverHold + TIMING.coverFade + TIMING.tail;
  if (estSeconds > 82) warns.push(`预计成片约 ${Math.round(estSeconds)} 秒，超过 80 秒：删掉一镜或压缩口播（目标 50–80 秒）`);
  return { errs, warns, units, estSeconds };
}

function readTheme(v, contentObj) {
  const theme = opt.theme || v.theme || (typeof contentObj?.theme === 'string' ? contentObj.theme : contentObj?.theme?.cards) || 'editorial';
  const f = path.join(ROOT, 'themes', `${theme}.css`);
  if (!fs.existsSync(f)) die(`没有主题 ${theme}`);
  return { theme, css: fs.readFileSync(f, 'utf8') };
}

function loadContent(v, dir) {
  if (v.content) { try { return JSON.parse(fs.readFileSync(path.resolve(dir, v.content), 'utf8')); } catch { /* fall back to the article */ } }
  // No 改写稿: the source credit comes from the article's front matter (video/ sits inside the work directory).
  for (const d of [dir, path.dirname(dir)]) for (const f of ['article.zh.md', 'article.md']) {
    const p = path.join(d, f);
    if (!fs.existsSync(p)) continue;
    const fm = fs.readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const meta = Object.fromEntries([...fm[1].matchAll(/^(\w+):\s*"?(.*?)"?\s*$/gm)].map((m) => [m[1], m[2]]));
    return { source: { author: meta.author || '', handle: meta.handle || '', title: meta.title || '', platform: meta.platform || '', date: meta.date || '', url: meta.url || '' } };
  }
  return null;
}

// ---------- images ----------
async function images(v, dir, theme) {
  const want = [];
  const cv = v.cover?.illustration;
  if (typeof cv === 'string' && cv.trim()) want.push({ key: 'cover', prompt: cv, aspect: '3:2', kind: 'cover' });
  (v.scenes || []).forEach((s) => { if (typeof s.illustration === 'string' && s.illustration.trim() && !s.clip) want.push({ key: s.id, prompt: s.illustration, aspect: s.illustration_aspect || '3:2', kind: 'figure' }); });
  if (!want.length) return {};
  const provider = pickImageProvider(opt.provider);
  const out = {};
  const idir = path.join(dir, 'illustrations');
  fs.mkdirSync(idir, { recursive: true });
  for (const w of want) {
    const pal = themePalette(theme);
    const prompt = [w.prompt.trim(), `Style: ${themeStyle(theme)}.`, `Color palette: ${[...pal.accents, pal.ink].join(', ')}.`,
      `Background: a flat, plain, solid ${pal.bg} that fills the whole image edge to edge; no border, no frame.`,
      'One clear focal subject, generous margins. Do not draw any text, letters, numbers, logos or watermarks. Do not depict real, identifiable people.'].join('\n');
    const f = path.join(idir, `video-${w.key}-${theme}.png`);
    if (fs.existsSync(f) && !opt.fresh) { out[w.key] = f; continue; }
    if (!provider) { console.log(`  — 没有出图能力，跳过 ${w.key} 插画`); continue; }
    const t0 = Date.now();
    try {
      const r = await generateImage(provider, prompt, w.aspect);
      fs.writeFileSync(f, r.buf);
      out[w.key] = f;
      console.log(`  ✓ ${w.key} 插画（${provider} / ${r.model}，${((Date.now() - t0) / 1000).toFixed(0)}s）`);
    } catch (e) {
      console.log(`  ⚠ ${w.key} 插画失败：${e.message}（不影响出片）`);
    }
  }
  return out;
}

// ---------- review ----------
function review(v, align, rep, outDir) {
  const notes = [];
  const VO = rep.VO;
  const firstLine = align.scenes[0]?.lines?.[0];
  const hookEnd = firstLine?.end != null ? VO + firstLine.end : null;
  const firstEvent = rep.events.filter((e) => e.t > 0.7 && !/^sc\d+(cam)?$/.test(e.id)).sort((a, b) => a.t - b.t)[0];
  notes.push({ check: '首句说完', value: hookEnd != null ? `${hookEnd.toFixed(2)}s` : '—', ok: hookEnd != null && hookEnd <= 5.2 });
  notes.push({ check: '第一个画面信息', value: firstEvent ? `${firstEvent.t.toFixed(2)}s` : '—', ok: !!firstEvent && firstEvent.t <= 2.5 });
  // Longest stretch with no visual change (element entrances; captions excluded).
  // Characters lighting up as they are spoken (quote karaoke) count as visual change too.
  // So does footage: a playing clip changes every frame (a held last frame does not).
  const clipTs = (rep.clips || []).flatMap((c) => Array.from({ length: Math.floor(c.play / 0.5) + 1 }, (_, k) => c.t + Math.min(c.play, k * 0.5)));
  const ts = [...new Set([...rep.events.filter((e) => !/cam$/.test(e.id)).map((e) => e.t), ...(rep.karaoke || []).map((k) => k.t), ...clipTs].map((t) => +t.toFixed(2)))].sort((a, b) => a - b);
  let gap = 0, gapAt = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > gap) { gap = ts[i] - ts[i - 1]; gapAt = ts[i - 1]; }
  if (rep.total - ts[ts.length - 1] > gap) { gap = rep.total - ts[ts.length - 1]; gapAt = ts[ts.length - 1]; }
  notes.push({ check: '最长画面静止', value: `${gap.toFixed(1)}s（从 ${gapAt.toFixed(1)}s 起）`, ok: gap <= 5 });
  const fast = rep.captions.filter((c) => c.until - c.t < 0.55).length;
  notes.push({ check: '字幕停留过短（<0.55s）', value: `${fast} 条`, ok: fast <= 2 });
  // Pace: a rushed narration is the worst failure of an explainer.
  if (align.pace) {
    const slowed = align.checks.filter((c) => c.stretched).length;
    notes.push({ check: '旁白语速', value: `${align.pace} 字/秒（约 ${Math.round(align.pace * 60)} 字/分钟，宜 ≤ ${PACE.max}）${slowed ? `，${slowed} 段放慢过` : ''}`, ok: align.pace <= PACE.max - 0.2 });
  }
  // Captions: no blinking (a gap shorter than 0.6 s between two lines), and lines that stay long enough to read.
  const capGaps = rep.captions.filter((c, k) => { const nx = rep.captions[k + 1]; return nx && nx.t - c.until > 0.01 && nx.t - c.until < 0.6; }).length;
  const capAvg = rep.captions.length ? rep.captions.reduce((a, c) => a + (c.until - c.t), 0) / rep.captions.length : 0;
  notes.push({ check: '字幕闪断（<0.6s 的空档）', value: `${capGaps} 处`, ok: capGaps === 0 });
  // Rendering: a caption missing from single frames of the finished video reads as flicker even when the timeline is right.
  if (rep.capDrops) notes.push({ check: '字幕丢帧（成片里该有字幕却是空的）', value: `${rep.capDrops.frames.length} 帧 / ${rep.capDrops.checked}${rep.capDrops.frames.length ? `（从 ${(rep.capDrops.frames[0] / (rep.fps || 30)).toFixed(2)}s 起）` : ''}`, ok: rep.capDrops.frames.length === 0 });
  notes.push({ check: '字幕平均停留', value: `${capAvg.toFixed(2)}s（${rep.captions.length} 条，${rep.captionStyle || ''}）`, ok: capAvg >= 1.3 });
  const bad = align.checks.filter((c) => c.problems.length);
  notes.push({ check: '配音质检', value: align.asr ? `${align.checks.length} 段，${bad.length} 段有问题` : '没有 ASR，未核对漏读', ok: !bad.length });
  notes.push({ check: '成片响度', value: `${Number(rep.loudness.input_i).toFixed(1)} → -14 LUFS（48 kHz）`, ok: true });
  // Music / clip sound are added under the mastered narration; the narration's level is the line above, unchanged.
  for (const n of rep.bed?.notes || []) notes.push({ check: '配乐与原声', value: n.text, ok: n.ok });
  if (rep.bed?.loudness?.i != null) notes.push({ check: '加配乐后的成片', value: `${rep.bed.loudness.i.toFixed(1)} LUFS，峰值 ${rep.bed.loudness.tp?.toFixed(1)} dBFS（旁白响度不变）`, ok: rep.bed.loudness.tp == null || rep.bed.loudness.tp <= -0.5 });
  if ((rep.clips || []).some((c) => c.place === 'full')) notes.push({ check: '全屏片段', value: '这些镜头的字幕丢帧不做逐帧检查（画面在动，量不出来），看 contact-sheet 确认字幕清楚', ok: true });
  if (align.voiceScope === 'local') notes.push({ check: '音色权利', value: `本机个人音色「${align.voiceName}」（${align.voiceSource || '来源未登记'}）：只用于本人制作，公开发布前确认已获授权`, ok: false });
  const report = { duration: +rep.total.toFixed(2), voice: `${align.backend} · ${align.voiceName}`, checks: notes, issues: rep.issues };
  fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(report, null, 2));
  return report;
}

function postCopy(v, content, align, outDir, rep) {
  const hasMusic = !!rep?.bed?.music, hasClips = !!rep?.clips?.length;
  const src = content?.source || {};
  const x = content?.xhs || {};
  const tags = (x.tags || []).map((t) => `#${t}`).join(' ');
  const txt = `# 发布文案

## 标题
${x.title || plainText(v.cover?.title || '').replace(/\n/g, '')}

## 正文
${x.caption ? x.caption.split('\n\n')[0] : ''}

内容整理自 ${[src.author, src.handle].filter(Boolean).join(' ')} 的${src.platform || ''}《${src.title || ''}》。
本视频配音与画面由 AI 辅助生成。${align.voiceScope === 'local' ? `\n\n> ⚠ 配音克隆自本机个人音色「${align.voiceName}」（${align.voiceSource || '来源未登记'}）。公开发布前确认已取得声音权利人的授权；否则换用公开音色重新生成（--voice news-man 等）。` : ''}

${tags}

## 发布前
- 在平台上勾选「AI 生成内容」声明（《人工智能生成合成内容标识办法》要求）。视频首帧已标注「AI 配音解读」，MP4 元数据也写了 AIGC 标识。
- 封面：cover.png（9:16）；小红书用 cover-3x4.jpg。
- 字幕已烧进画面；captions.srt 可用于平台的字幕功能。
${hasMusic ? `- 配乐是你提供的 ${path.basename(String(v.music?.src || ''))}：发布前确认这段音乐可以用于公开发布（平台曲库之外的音乐可能被静音或限流）。` : '- 视频没有背景音乐：需要的话在平台 App 里选配乐。'}${hasClips ? '\n- 画面里用了原视频的片段：确认有权使用，并在文案里注明出处。' : ''}
`;
  fs.writeFileSync(path.join(outDir, 'post.md'), txt);
}

// ---------- main ----------
if (cmd === 'doctor' || !cmd) { doctor(); process.exit(0); }
if (cmd === 'voices') { listVoices(); process.exit(0); }
if (cmd === 'voice-import') { process.exit(await importVoice(file, opt)); }
if (cmd === 'voice-design') { process.exit(await designVoices(opt)); }
if (cmd === 'probe') { process.exit(await probeTerms(positionals.slice(1), opt)); }

const { v, dir, media } = load(file);
const c = check(v, media);
if (cmd === 'check' || cmd === 'make') {
  for (const e of c.errs) console.log(`✗ ${e}`);
  for (const w of c.warns) console.log(`⚠ ${w}`);
  console.log(`${c.errs.length ? '✗' : '✓'} ${v.scenes?.length || 0} 个镜头，口播约 ${c.units} 字，预计 ${c.estSeconds.toFixed(0)} 秒`);
  if (c.errs.length) process.exit(1);
  if (cmd === 'check') process.exit(0);
}

const content = loadContent(v, dir);
const { theme, css } = readTheme(v, content);
const voiceDir = path.join(dir, 'voice');

const MIN_READ = 1.1; // seconds a scene stays after its last element appears
// render / voice / images skip the check printout, but a broken clip, music or transition must still stop them.
if (cmd !== 'check' && cmd !== 'make') {
  const bad = checkMedia(v, media).errs;
  for (const e of bad) console.log(`✗ ${e}`);
  if (bad.length) process.exit(1);
}

async function doVoice() {
  if (opt.fresh) fs.rmSync(path.join(voiceDir, 'alignment.json'), { force: true });
  const t0 = Date.now();
  const base = { voiceId: opt.voice || v.voice?.id, backend: opt.backend || v.voice?.backend, say: v.say };
  const holds = Object.fromEntries((v.scenes || []).filter((s) => s.hold).map((s) => [s.id, s.hold]));
  let align = await synthesize(v.scenes, voiceDir, { ...base, holds });
  // Director's rule: give viewers time to read. If a scene's last element lands too close to the cut,
  // lengthen the pause after that scene (re-joins cached chunks; no new speech is generated).
  for (let pass = 0; pass < 2; pass++) {
    const { sceneInfo } = buildStage(v, align, css);
    let changed = false;
    sceneInfo.slice(0, -1).forEach((si) => {
      const deficit = si.lastReveal + MIN_READ - (si.out - 0.26);
      if (deficit > 0.05) { holds[si.id] = +((holds[si.id] || 0) + Math.ceil(deficit * 10) / 10).toFixed(1); changed = true; }
    });
    if (!changed) break;
    console.log(`  加长停顿让画面看清：${Object.entries(holds).map(([k, x]) => `${k} +${x}s`).join('、')}`);
    align = await synthesize(v.scenes, voiceDir, { ...base, holds, log: () => {} });
  }
  console.log(`  旁白 ${align.duration.toFixed(1)}s（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  return align;
}

if (cmd === 'voice') { await doVoice(); process.exit(0); }
if (cmd === 'images') { console.log(JSON.stringify(await images(v, dir, theme), null, 1)); process.exit(0); }

if (cmd === 'render' || cmd === 'make') {
  // Narration chunks and their checks are cached, so this only synthesizes lines that changed.
  const align = await doVoice();
  const imgs = opt['no-images'] ? {} : await images(v, dir, theme);
  const outDir = path.join(dir, theme);
  fs.mkdirSync(outDir, { recursive: true });
  const src = content?.source || {};
  const credit = `AI 配音解读 · 内容整理自 ${[src.author, src.handle].filter(Boolean).join(' ') || '原作者'}`;
  const video = v;
  console.log(`渲染：${theme} 主题，1080×1920，${TIMING.fps}fps`);
  const rep = await renderVideo(video, align, {
    dir: outDir, theme, themeCss: css, credit, narration: path.join(voiceDir, 'narration.wav'),
    coverImage: imgs.cover ? pathToFileURL(imgs.cover).href : null,
    sceneImages: Object.fromEntries(Object.entries(imgs).filter(([k]) => k !== 'cover').map(([k, f]) => [k, pathToFileURL(f).href])),
    media,
  });
  // A caption missing from frames of the finished video is a rendering defect, not a judgement call: it fails the run.
  if (rep.capDrops?.frames.length) rep.issues.push({ level: 'error', where: '字幕', msg: `成片有 ${rep.capDrops.frames.length} 帧该有字幕却是空的（从 ${(rep.capDrops.frames[0] / (rep.fps || 30)).toFixed(2)}s 起），重新渲染；仍然出现请报告` });
  const r = review(video, align, rep, outDir);
  postCopy(video, content, align, outDir, rep);
  console.log(`\n成片：${rep.mp4}（${rep.total.toFixed(1)}s）`);
  console.log(`封面：${path.join(outDir, 'cover.png')}、cover-3x4.jpg`);
  console.log(`审片：${path.join(outDir, 'contact-sheet.jpg')}`);
  for (const n of r.checks) console.log(`  ${n.ok ? '✓' : '⚠'} ${n.check}：${n.value}`);
  for (const i of rep.issues) console.log(`  ${i.level === 'error' ? '✗' : '⚠'} ${i.where}：${i.msg}`);
  process.stdout.write('', () => process.exit(rep.issues.some((i) => i.level === 'error') ? 1 : 0));
} else if (!['check', 'voice', 'images'].includes(cmd)) die(`未知命令 ${cmd}`, 2);
