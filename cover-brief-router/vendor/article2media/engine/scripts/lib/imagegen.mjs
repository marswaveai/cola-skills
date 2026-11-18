// Image generation providers shared by illustrate.mjs (article illustrations), comic.mjs (panels) and video.mjs
// (cover / scene art).
//   codex   Codex CLI's built-in image tool (uses the user's ChatGPT login; no API key)
//   openai  OPENAI_API_KEY (images/generations; images/edits when reference images are passed)
//   gemini  GEMINI_API_KEY / GOOGLE_API_KEY (image models need a paid tier)
//
// Models and the provider are configuration, not code. Precedence: CLI flag → environment → config file → default.
//   ARTICLE2MEDIA_IMAGE_PROVIDER=codex|openai|gemini          force one provider (no fallback to another)
//   ARTICLE2MEDIA_IMAGE_MODEL_CODEX | _OPENAI | _GEMINI       model per provider
//   ~/.config/article2media/config.json                       {"image": {"provider": "…", "models": {"openai": "…"}, "quality": "medium"}}
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The one place the defaults live. Order = preference when nothing is forced: codex is free with a ChatGPT login. */
export const IMAGE_DEFAULTS = {
  order: ['codex', 'openai', 'gemini'],
  models: { codex: 'gpt-6-astra', openai: 'gpt-image-1', gemini: 'gemini-3.1-flash-image' },
  quality: 'medium', // OpenAI gpt-image models only
};
const LABEL = { codex: 'Codex CLI', openai: 'OpenAI', gemini: 'Gemini' };

export const configPath = () =>
  process.env.ARTICLE2MEDIA_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'article2media', 'config.json');

let warnedConfig = false;
function readConfigFile() {
  const file = configPath();
  if (!fs.existsSync(file)) return { file, found: false, image: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, found: true, image: (j && typeof j.image === 'object' && j.image) || {} };
  } catch (e) {
    if (!warnedConfig) { warnedConfig = true; console.error(`⚠ 配置文件读不了，已忽略：${file}（${e.message}）`); }
    return { file, found: true, broken: true, image: {} };
  }
}

/** Effective image settings: { provider (forced, or null), models, quality, file, found, from: { provider, models } }. */
export function imageConfig() {
  const cfg = readConfigFile();
  const env = process.env;
  const models = {}, from = { models: {} };
  for (const p of IMAGE_DEFAULTS.order) {
    const e = env[`ARTICLE2MEDIA_IMAGE_MODEL_${p.toUpperCase()}`] || (p === 'codex' && env.ARTICLE2MEDIA_CODEX_IMAGE_MODEL); // the second is the pre-2.1 name
    const f = cfg.image.models?.[p];
    models[p] = e || f || IMAGE_DEFAULTS.models[p];
    from.models[p] = e ? '环境变量' : f ? '配置文件' : '默认';
  }
  const provider = env.ARTICLE2MEDIA_IMAGE_PROVIDER || cfg.image.provider || null;
  from.provider = env.ARTICLE2MEDIA_IMAGE_PROVIDER ? '环境变量' : cfg.image.provider ? '配置文件' : '自动';
  if (provider && !IMAGE_DEFAULTS.order.includes(provider)) {
    throw new Error(`图像服务设置无效：${provider}（${from.provider}）。可用：${IMAGE_DEFAULTS.order.join('、')}`);
  }
  return { provider, models, quality: env.ARTICLE2MEDIA_IMAGE_QUALITY || cfg.image.quality || IMAGE_DEFAULTS.quality, file: cfg.file, found: cfg.found, from };
}

// ---------- detection ----------
const run = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 }); } catch { return { status: 1, stdout: '', stderr: '' }; } };
const codexBin = () => process.env.CODEX_BIN || 'codex';

let codexState = null;
/** 'ready' | 'logged-out' | 'missing'. An installed but logged-out Codex must not shadow a valid API key. */
export function codexStatus() {
  if (codexState) return codexState;
  const bin = codexBin();
  if (run(bin, ['--version']).status !== 0) return (codexState = 'missing');
  const r = run(bin, ['login', 'status']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  let ok = r.status === 0;
  // A Codex CLI without `login status`: fall back to the credentials file.
  if (!ok && /unrecognized|unexpected argument|unknown (sub)?command|invalid (sub)?command/i.test(out)) {
    ok = fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'));
  }
  return (codexState = ok ? 'ready' : 'logged-out');
}

export function detectImageProviders() {
  return {
    codex: codexStatus() === 'ready' ? { bin: codexBin() } : null,
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? {} : null,
    openai: process.env.OPENAI_API_KEY ? {} : null,
  };
}
const available = () => { const d = detectImageProviders(); return IMAGE_DEFAULTS.order.filter((p) => d[p]); };

let explicitPick = false; // the last pick was a flag / forced setting: generateImage then does not switch provider
/** `requested` (a --provider flag) → forced by env / config → the first available one. */
export function pickImageProvider(requested) {
  const forced = requested || imageConfig().provider;
  explicitPick = !!forced;
  return forced || available()[0] || null;
}

/** One line for doctor / --dry-run: what would be used and why. */
export function describeImageSetup() {
  const cfg = imageConfig();
  const have = available();
  const provider = cfg.provider || have[0] || null;
  const fallback = cfg.provider ? [] : have.slice(1);
  return {
    provider, model: provider ? cfg.models[provider] : null, forced: !!cfg.provider, from: cfg.from, models: cfg.models,
    available: have, fallback, codex: codexStatus(), config: cfg.found ? cfg.file : null, configPath: cfg.file,
    text: provider
      ? `${provider} / ${cfg.models[provider]}（服务 ${cfg.from.provider}，模型 ${cfg.from.models[provider]}）` +
        (fallback.length ? `；失败时依次改用 ${fallback.map((p) => `${p} / ${cfg.models[p]}`).join('、')}` : cfg.provider ? '；已指定服务，不自动换' : '')
      : '没有可用的图像服务',
  };
}

// ---------- sizes ----------
// What each provider can draw. An aspect the provider does not have gets the size that loses the least when the
// layout crops it (object-fit: cover), and the prompt says so, so the subject stays inside the kept area.
const PIXEL_SIZES = [['1024x1024', 1, 1], ['1536x1024', 3, 2], ['1024x1536', 2, 3]];
const SIZES = {
  codex: PIXEL_SIZES,
  openai: PIXEL_SIZES,
  'openai:dall-e-3': [['1024x1024', 1, 1], ['1792x1024', 7, 4], ['1024x1792', 4, 7]],
  gemini: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].map((r) => [r, ...r.split(':').map(Number)]),
};
const parseAspect = (aspect) => {
  const [w, h] = String(aspect || '4:3').split(/[:x×/]/).map(Number);
  return w > 0 && h > 0 ? [w, h] : [4, 3];
};

/** Closest supported size: { size, ratio, want, crop (fraction trimmed, 0–1), side, note }. */
export function sizeFor(provider, aspect, model = '') {
  const [w, h] = parseAspect(aspect);
  const want = w / h;
  const table = (provider === 'openai' && /^dall-e-3/.test(model) && SIZES['openai:dall-e-3']) || SIZES[provider] || PIXEL_SIZES;
  let best = null;
  for (const [size, sw, sh] of table) {
    const got = sw / sh;
    const crop = got > want ? 1 - want / got : 1 - got / want;
    if (!best || crop < best.crop - 1e-9) best = { size, ratio: `${sw}:${sh}`, crop, side: got > want ? 'width' : 'height' };
  }
  const pct = Math.round(best.crop * 100);
  return {
    ...best, want: `${w}:${h}`, crop: pct ? best.crop : 0,
    note: pct ? `${provider} 没有 ${w}:${h}，按 ${best.ratio} 出图，版面居中裁掉约 ${pct}% 的${best.side === 'width' ? '宽' : '高'}` : '',
  };
}
const cropHint = (sz) => (sz.crop >= 0.03
  ? `Composition: this ${sz.ratio} picture will be center-cropped to ${sz.want} (about ${Math.round(sz.crop * 100)}% trimmed from the ${sz.side === 'width' ? 'left and right' : 'top and bottom'}), so keep every important element inside that central area.`
  : '');

/** Kept for callers that only need the orientation. */
export const shapeFor = (aspect = '4:3') => {
  const [w, h] = parseAspect(aspect);
  return w > h ? 'landscape' : w < h ? 'portrait' : 'square';
};

// ---------- errors ----------
// kind decides what happens next:
//   auth / quota / unavailable   this provider cannot serve now → try the next available one
//   refused                      the content was declined → report it; another provider is not asked behind the user's back
//   request / other              our request or an unknown failure → report it
export class ImageError extends Error {
  constructor(kind, message, { provider, status, transient = false } = {}) {
    super(message);
    this.name = 'ImageError';
    Object.assign(this, { kind, provider, status, transient });
  }
}
const FALLBACK_KINDS = new Set(['auth', 'quota', 'unavailable']);
const REFUSED_RE = /content[_ ]policy|safety|moderation|violat|not allowed|prohibited|blocked|refus|can(?:'|no)t (?:help|assist|create|generate)|sexual|harmful/i;

/** Classify free text (Codex output, API messages without a usable status). */
export function classifyMessage(msg = '') {
  if (REFUSED_RE.test(msg)) return 'refused';
  if (/\b401\b|\b403\b|unauthori[sz]ed|not logged in|log ?in|api[_ ]key|authenticat|credential|permission/i.test(msg)) return 'auth';
  if (/\b429\b|quota|rate.?limit|usage limit|billing|insufficient|exceeded|too many requests/i.test(msg)) return 'quota';
  if (/\b404\b|\b50[0-4]\b|model.*(not found|does not exist|not supported|unsupported|not available)|unavailable|overloaded|timed? ?out|ENOTFOUND|ECONNRE|ETIMEDOUT|fetch failed|network/i.test(msg)) return 'unavailable';
  return 'other';
}

function httpError(provider, status, msg, code = '') {
  const text = `${LABEL[provider]} ${status}：${String(msg).split('\n')[0].slice(0, 300)}`;
  if (/moderation|content_policy|safety/i.test(code) || (status === 400 && REFUSED_RE.test(msg))) return new ImageError('refused', `${text}（内容被拒绝）`, { provider, status });
  if (status === 401 || status === 403 || /API_KEY_INVALID|invalid_api_key|API key not valid/i.test(`${code} ${msg}`)) return new ImageError('auth', text, { provider, status });
  if (status === 429) return new ImageError('quota', text, { provider, status });
  if (status === 404 || /model_not_found/.test(code)) return new ImageError('unavailable', text, { provider, status });
  if (status >= 500) return new ImageError('unavailable', text, { provider, status, transient: true });
  return new ImageError('request', text, { provider, status });
}
async function post(provider, url, init) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(300000) }); } catch (e) {
    throw new ImageError('unavailable', `${LABEL[provider]} 连不上：${e.cause?.code || e.cause?.message || e.message}`, { provider, transient: true });
  }
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] || 'image/png';
// Reference images keep a recurring character / style consistent across a series (comic panels).
const refNote = (refs, how) => (refs.length
  ? 'Attached reference image(s), in order: ' + refs.map((r, k) => `image ${k + 1} = ${r.note || 'character and style reference'}`).join('; ') +
    `. ${how} so the character design (face, hair, glasses, clothing, proportions) and the line / tone style stay identical. `
  : '');

// The canvas line alone is not always honoured (a portrait request has come back landscape): say the orientation
// in plain words and name the size parameter.
const orientationRule = (sz) => {
  const [w, h] = sz.size.split('x').map(Number);
  if (w === h) return `Set the tool's size to ${sz.size}.`;
  return `The image must be ${h > w ? 'PORTRAIT: taller than it is wide' : 'LANDSCAPE: wider than it is tall'} (${w} pixels wide, ${h} pixels tall). Set the tool's size parameter to exactly "${sz.size}"; do not use the default size.`;
};

// The image tool tends to pick its own frame from the prompt text, so the frame is also the prompt's first line.
const framing = (sz) => {
  const [w, h] = sz.size.split('x').map(Number);
  return w === h ? 'Square 1:1 composition.\n' : h > w ? 'Vertical portrait composition, 2:3 aspect ratio, taller than wide (a phone-screen / book-cover shape).\n' : 'Horizontal landscape composition, 3:2 aspect ratio, wider than tall.\n';
};

// ---------- providers: (prompt, aspect, { model, refs }) → { buf, ext, model, size, crop } ----------
async function codex(prompt, aspect, { model, refs = [] } = {}) {
  const m = model || imageConfig().models.codex;
  const sz = sizeFor('codex', aspect, m);
  const bin = codexBin();
  const hint = cropHint(sz);
  const instruction = 'Task: call your built-in image generation tool exactly once to create one new image. ' +
    `Canvas: ${sz.size} ${shapeFor(sz.ratio)} (${sz.ratio}). ${orientationRule(sz)} ${refNote(refs, 'Pass them to the image generation tool as reference images')}${hint ? hint + ' ' : ''}` +
    'Use the text between <prompt> tags as the image prompt, verbatim, without adding style words. ' +
    'Do not draw with code, do not edit or post-process, do not generate variants. When the tool returns, reply with the single word DONE.\n\n' +
    `<prompt>\n${framing(sz)}${prompt}\n</prompt>`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'a2i-codex-'));
  // The prompt must come before -i (which takes several values and would swallow it).
  const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd, '-m', m, '-c', 'model_reasoning_effort="low"', instruction, ...refs.flatMap((r) => ['-i', r.path])];
  const r = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ status: -1, stdout, stderr: e.message }); }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 900000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: e.message }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  const events = (r.stdout || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const thread = events.map((j) => j.thread_id || j.thread?.id).filter(Boolean).pop();
  const dir = thread ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images', thread) : null;
  const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : [];
  if (!files.length) throw codexError(r, events, m);
  const buf = fs.readFileSync(files[files.length - 1]);
  // The canvas is only an instruction to the model: check what came back (PNG IHDR), a landscape picture in a
  // portrait slot would be cropped to a sliver. Callers retry or report.
  const got = buf.length > 24 && buf.readUInt32BE(12) === 0x49484452 ? `${buf.readUInt32BE(16)}:${buf.readUInt32BE(20)}` : sz.ratio;
  if (shapeFor(got) !== shapeFor(sz.ratio)) {
    throw new ImageError('other', `Codex 出的图方向不对：要 ${sz.size}（${sz.ratio}），得到 ${got.replace(':', 'x')}。重试一次通常就好`, { provider: 'codex' });
  }
  return { buf, ext: 'png', model: m, size: sz.size, crop: sz.note };
}
function codexError(r, events, m) {
  const err = events.filter((j) => /error|failed/.test(j.type || '')).map((j) => j.message || j.error?.message).filter(Boolean).pop();
  const said = events.map((j) => (j.item?.type === 'agent_message' ? j.item.text : null)).filter(Boolean).pop(); // what the model answered instead of drawing
  let reason = String(err || said || (r.stderr || '').trim().split('\n').pop() || '');
  try { reason = JSON.parse(reason).error?.message || reason; } catch {} // the API error arrives as a JSON string
  reason = reason.slice(0, 300);
  let kind = classifyMessage(reason);
  // The CLI itself failed (not installed, crashed, logged out) with nothing we can read: the provider is unavailable.
  // A clean exit without a picture is the model declining or not calling the tool: report it, do not switch silently.
  if (kind === 'other' && r.status !== 0 && !said) kind = 'unavailable';
  const tip = kind === 'refused' ? '内容被拒绝，改写这张图的 prompt'
    : kind === 'auth' ? '运行 codex login'
    : `确认已 codex login，或用 ARTICLE2MEDIA_IMAGE_MODEL_CODEX 换一个支持出图的模型（当前 ${m}）`;
  return new ImageError(kind, `Codex 没有生成图片${reason ? `：${reason}` : `（退出码 ${r.status}）`}。${tip}`, { provider: 'codex' });
}

/** Gemini request, separate from the call so it can be checked without the network. */
export function geminiRequest(prompt, aspect, { model, refs = [], key } = {}) {
  const m = model || imageConfig().models.gemini;
  const sz = sizeFor('gemini', aspect, m);
  const text = [refNote(refs, 'Use them as reference images').trim(), prompt, cropHint(sz)].filter(Boolean).join('\n\n');
  const parts = [{ text }, ...refs.map((r) => ({ inlineData: { mimeType: mimeOf(r.path), data: fs.readFileSync(r.path).toString('base64') } }))];
  const base = (process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return {
    url: `${base}/v1beta/models/${m}:generateContent`,
    init: {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key ?? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: sz.size } } }),
    },
    model: m, sz,
  };
}
async function gemini(prompt, aspect, opts = {}) {
  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) throw new ImageError('auth', '没有设置 GEMINI_API_KEY / GOOGLE_API_KEY', { provider: 'gemini' });
  const { url, init, model: m, sz } = geminiRequest(prompt, aspect, opts);
  const res = await post('gemini', url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || res.statusText;
    if (res.status === 429 && /free_tier|limit: 0/.test(msg)) throw new ImageError('quota', 'Gemini 返回 429：这个 key 在免费层，图像模型额度为 0，需要在 Google AI Studio 开通付费。', { provider: 'gemini', status: 429 });
    throw httpError('gemini', res.status, msg, `${j.error?.status || ''} ${JSON.stringify(j.error?.details || '')}`);
  }
  const cand = j.candidates?.[0];
  const part = (cand?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
  if (!part) {
    const why = j.promptFeedback?.blockReason || cand?.finishReason || '';
    const refused = /SAFETY|PROHIBITED|BLOCK|RECITATION|SPII|IMAGE_OTHER/i.test(why);
    throw new ImageError(refused ? 'refused' : 'other', `Gemini 没有返回图片（${why || '未知原因'}）${refused ? '：内容被拒绝，改写这张图的 prompt' : ''}`, { provider: 'gemini' });
  }
  const data = part.inlineData || part.inline_data;
  return { buf: Buffer.from(data.data, 'base64'), ext: (data.mimeType || data.mime_type || 'image/png').split('/')[1].replace('jpeg', 'jpg'), model: m, size: sz.size, crop: sz.note };
}

/**
 * OpenAI request. Without references: JSON to images/generations. With references: multipart to images/edits, the
 * reference file(s) as `image[]` (gpt-image models take several; older models take one `image`).
 */
export function openaiRequest(prompt, aspect, { model, refs = [], key, quality } = {}) {
  const cfg = imageConfig();
  const m = model || cfg.models.openai;
  const sz = sizeFor('openai', aspect, m);
  const gptImage = /^gpt-image|^chatgpt-image/.test(m);
  const text = [refNote(refs, 'Use them as reference images').trim(), prompt, cropHint(sz)].filter(Boolean).join('\n\n');
  // gpt-image models always answer with base64 and take a quality; the DALL·E models need response_format instead.
  const fields = { model: m, prompt: text, size: sz.size, n: 1, ...(gptImage ? { quality: quality || cfg.quality } : { response_format: 'b64_json' }) };
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const authorization = `Bearer ${key ?? process.env.OPENAI_API_KEY}`;
  if (!refs.length) return { url: `${base}/images/generations`, init: { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(fields) }, model: m, sz };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  for (const r of gptImage ? refs : refs.slice(0, 1)) {
    form.append(gptImage ? 'image[]' : 'image', new Blob([fs.readFileSync(r.path)], { type: mimeOf(r.path) }), path.basename(r.path));
  }
  return { url: `${base}/images/edits`, init: { method: 'POST', headers: { authorization }, body: form }, model: m, sz }; // fetch sets the multipart boundary
}
async function openai(prompt, aspect, opts = {}) {
  if (!process.env.OPENAI_API_KEY) throw new ImageError('auth', '没有设置 OPENAI_API_KEY', { provider: 'openai' });
  const { url, init, model: m, sz } = openaiRequest(prompt, aspect, opts);
  const res = await post('openai', url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('openai', res.status, j.error?.message || res.statusText, `${j.error?.code || ''} ${j.error?.type || ''}`);
  const d = j.data?.[0];
  if (d?.b64_json) return { buf: Buffer.from(d.b64_json, 'base64'), ext: 'png', model: m, size: sz.size, crop: sz.note };
  if (d?.url) {
    const img = await post('openai', d.url, {});
    if (img.ok) return { buf: Buffer.from(await img.arrayBuffer()), ext: 'png', model: m, size: sz.size, crop: sz.note };
  }
  throw new ImageError('other', 'OpenAI 没有返回图片', { provider: 'openai' });
}

export const IMAGE_PROVIDERS = { codex, gemini, openai };

const down = new Map(); // provider → ImageError that will not go away within this run (auth, quota, missing model)
/** Test hook: forget detection and failures. */
export function resetImageState() { down.clear(); codexState = null; explicitPick = false; }

/**
 * Generate one image. opts: { model (for `provider` only), refs: [{ path, note }], fallback, log }.
 * fallback (default: on unless the provider was asked for by flag / env / config): when `provider` fails for an
 * auth / quota / availability reason, the next available provider is tried with its configured model and a ⚠ line
 * says which one was used. A refusal of the content is never retried elsewhere.
 * Resolves to { buf, ext, provider, model, size, crop (note, '' when the aspect is native), fallbackFrom }.
 */
export async function generateImage(provider, prompt, aspect, opts = {}) {
  if (!IMAGE_PROVIDERS[provider]) throw new Error(`未知图像服务 ${provider}，可用：${IMAGE_DEFAULTS.order.join('、')}`);
  const log = opts.log || ((s) => console.log(s));
  const fallback = opts.fallback ?? !explicitPick;
  const chain = [provider, ...(fallback ? available().filter((p) => p !== provider) : [])];
  const cfg = imageConfig();
  let first = null;
  const tried = [];
  for (let k = 0; k < chain.length; k++) {
    const p = chain[k];
    const model = p === provider && opts.model ? opts.model : cfg.models[p];
    try {
      if (down.has(p)) throw down.get(p);
      const r = await IMAGE_PROVIDERS[p](prompt, aspect, { model, refs: opts.refs || [] });
      return { ...r, provider: p, fallbackFrom: p === provider ? null : provider };
    } catch (e) {
      const err = e instanceof ImageError ? e : new ImageError(classifyMessage(e.message), e.message, { provider: p });
      const known = down.has(p);
      if (FALLBACK_KINDS.has(err.kind) && !err.transient) down.set(p, err);
      first ||= err;
      tried.push(`${p}：${err.message}`);
      const next = chain.slice(k + 1).find((x) => !down.has(x));
      if (!FALLBACK_KINDS.has(err.kind) || !next) {
        if (tried.length === 1) throw err;
        throw new ImageError(first.kind, tried.join('；备用 '), { provider });
      }
      // Announce a switch once per provider; later images go straight to the one that works.
      if (!known) log(`⚠ 图像服务 ${p} 用不了（${{ auth: '登录 / 密钥', quota: '额度', unavailable: '服务或模型不可用' }[err.kind]}：${err.message.slice(0, 160)}），改用 ${next} / ${cfg.models[next]}`);
    }
  }
  throw first;
}
