// AI illustrations: shared by render.mjs (lookup) and illustrate.mjs (generation).
//
// content.json can ask for pictures in two places:
//   - a figure  { "type": "illustration", "prompt": "…", "caption": "…" }
//   - the cover "cover": { "illustration": { "prompt": "…" } }   (or just a string)
// Images are cached per content directory in illustrations/<key>.<ext>. The key depends on the prompt,
// the theme's picture style and the aspect ratio, so every theme can have its own version.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const THEMES_DIR = path.join(ROOT, 'themes');
let STYLES;
export function themeStyle(theme) {
  STYLES ??= JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'illustration-styles.json'), 'utf8'));
  return STYLES[theme] || STYLES.editorial;
}

/** Background + accent colors from the theme CSS (first declaration of each variable). */
export function themePalette(theme) {
  const css = fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), 'utf8');
  const v = (name) => css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`))?.[1];
  const accents = [...css.matchAll(/--accent-\d+\s*:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1]);
  return { bg: v('bg') || '#ffffff', figBg: v('fig-bg') || v('bg') || '#ffffff', ink: v('ink') || '#222222', accents: [...new Set(accents)].slice(0, 5) };
}

export const EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
const promptOf = (x) => (typeof x === 'string' ? x : x?.prompt || '');

/** Every illustration the content asks for, with where it goes. */
export function collectIllustrations(content) {
  const out = [];
  const cv = content.cover?.illustration;
  if (promptOf(cv)) out.push({ kind: 'cover', where: 'cover.illustration', prompt: promptOf(cv), aspect: cv.aspect || '4:3', ref: cv });
  (content.pages || []).forEach((pg, pi) => (pg.sections || []).forEach((s, si) => (s.figures || []).forEach((f, fi) => {
    if (f?.type === 'illustration') out.push({ kind: 'figure', where: `pages[${pi}].sections[${si}].figures[${fi}]`, prompt: f.prompt || '', aspect: f.aspect || '4:3', ref: f });
  })));
  return out;
}

/** Style text for a theme, honoring content.illustration.style. */
export function styleFor(content, theme) {
  return content.illustration?.style || themeStyle(theme);
}

export function keyFor(item, style) {
  return crypto.createHash('sha1').update(`${item.prompt}\n${style}\n${item.aspect}\n${item.kind}`).digest('hex').slice(0, 12);
}

export function buildPrompt(item, theme, content) {
  const style = styleFor(content, theme);
  const pal = themePalette(theme);
  const bg = item.kind === 'cover' ? pal.bg : pal.figBg;
  const comp = item.kind === 'cover'
    ? 'One clear focal subject with generous empty margins on every side, so it can sit next to a headline.'
    : 'One clear subject or visual metaphor, centered, with generous empty margins on every side.';
  return [
    item.prompt.trim(),
    `Style: ${style}.`,
    `Color palette: ${[...pal.accents, pal.ink].join(', ')}.`,
    `Background: a flat, plain, solid ${bg} that fills the whole image edge to edge; no border, no frame, no vignette, no paper edge.`,
    comp,
    'Do not draw any text, letters, numbers, captions, labels, logos, signatures or watermarks. Do not depict real, identifiable people.',
  ].join('\n');
}

const indexPath = (dir) => path.join(dir, 'illustrations', 'index.json');
export function readIndex(dir) {
  try { return JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); } catch { return {}; }
}
export function writeIndex(dir, idx) {
  fs.mkdirSync(path.dirname(indexPath(dir)), { recursive: true });
  fs.writeFileSync(indexPath(dir), JSON.stringify(idx, null, 2));
}

export function fileForKey(dir, key) {
  for (const e of EXTS) {
    const f = path.join(dir, 'illustrations', `${key}.${e}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/**
 * Point every illustration at a cached image for this theme (or, failing that, any theme's version
 * of the same prompt). Sets ref._src (file URL) and returns the list of prompts still missing.
 */
export function resolveIllustrations(content, theme, dir) {
  const items = collectIllustrations(content);
  if (!items.length) return { items, missing: [], borrowed: [] };
  const idx = readIndex(dir);
  const style = styleFor(content, theme);
  const missing = [], borrowed = [];
  for (const it of items) {
    let file = fileForKey(dir, keyFor(it, style));
    if (!file) {
      const other = Object.entries(idx).find(([k, m]) => m.prompt === it.prompt && m.kind === it.kind && fileForKey(dir, k));
      if (other) { file = fileForKey(dir, other[0]); borrowed.push({ ...it, from: other[1].theme }); }
    }
    const src = file ? pathToFileURL(file).href : '';
    if (typeof it.ref === 'object' && it.ref) it.ref._src = src;
    else if (it.kind === 'cover') content.cover._illustrationSrc = src; // cover given as a plain string
    if (!file) missing.push(it);
  }
  return { items, missing, borrowed };
}

/**
 * `image` figures may point at a local file (relative to content.json, absolute, or file:). Rewrite those to
 * file URLs so every layout can load them; returns the ones whose file does not exist.
 */
export function resolveImageFigures(content, dir) {
  const missing = [];
  (content.pages || []).forEach((pg, pi) => (pg.sections || []).forEach((sec, si) => (sec.figures || []).forEach((f, fi) => {
    if (f?.type !== 'image' || typeof f.src !== 'string' || /^(https?|data):/i.test(f.src)) return;
    const file = f.src.startsWith('file:') ? fileURLToPath(f.src) : path.resolve(dir, f.src);
    if (!fs.existsSync(file)) { missing.push({ where: `第 ${pi + 1} 页第 ${si + 1} 节图 ${fi + 1}`, src: f.src }); return; }
    f.src = pathToFileURL(file).href;
  })));
  return missing;
}

export const coverIllustrationSrc = (c) => {
  const cv = c.cover?.illustration;
  if (!cv) return '';
  return typeof cv === 'string' ? c.cover._illustrationSrc || '' : cv._src || '';
};

/** CSS aspect-ratio of the cover illustration ("4 / 3"), so the <img> box matches the picture and its edges fade. */
export const coverIllustrationAspect = (c) => {
  const a = (typeof c.cover?.illustration === 'object' && c.cover.illustration.aspect) || '4:3';
  return a.replace(':', ' / ');
};
