// Local web fonts. Themes and some layouts `@import` their fonts from fonts.googleapis.com / cdn.jsdelivr.net.
// `fonts.mjs` (the explicit download command) mirrors each imported stylesheet and every font file it references into
// <cache>/fonts and records them in manifest.json; at render time `localizeFonts` swaps a remote @import for the local
// copy when the manifest has it and leaves it alone otherwise. Rendering itself never downloads anything.
//
//   <cache>/fonts/manifest.json           { version, imports: { <remote css url>: { css, families, files, bytes, … } } }
//   <cache>/fonts/css/<hash>.css          the stylesheet, font urls rewritten to ../files/<hash>.<ext>
//   <cache>/fonts/files/<hash>.<ext>      font files, shared between stylesheets (keyed by their remote url)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CACHE_DIR } from './chrome.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPORT_RE = /@import\s+url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)\s*;?/g;
// Google answers by user agent: a current Chrome gets woff2 with unicode-range slices.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const fontsDir = () => path.join(CACHE_DIR, 'fonts'); // read lazily: chrome.mjs and this module import each other
const manifestPath = () => path.join(fontsDir(), 'manifest.json');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

let cached = null;
export function readManifest({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  let m = null;
  try { m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch {}
  cached = m && m.version === 1 && m.imports ? m : { version: 1, imports: {} };
  return cached;
}
function writeManifest(m) {
  fs.mkdirSync(fontsDir(), { recursive: true });
  m.updated = new Date().toISOString();
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
  cached = m;
}

/** Local stylesheet for a remote @import url, or null (not downloaded, or the file is gone). */
export function localCssFor(url) {
  if (process.env.ARTICLE2MEDIA_FONTS === 'remote') return null;
  const e = readManifest().imports[url];
  if (!e) return null;
  const f = path.join(fontsDir(), e.css);
  return fs.existsSync(f) ? f : null;
}

/** Installed and intact: the stylesheet and every font file it points at are on disk (checked by the fonts command, not per render). */
export function importComplete(url) {
  const f = localCssFor(url);
  if (!f) return false;
  const names = [...fs.readFileSync(f, 'utf8').matchAll(/url\('\.\.\/files\/([^']+)'\)/g)].map((m) => m[1]);
  return names.every((n) => fs.existsSync(path.join(fontsDir(), 'files', n)));
}

/** Swap every remote `@import url(…)` the manifest covers for its local copy; the rest stay remote. */
export function localizeFonts(css) {
  if (!css.includes('@import')) return css;
  return css.replace(IMPORT_RE, (all, _q, url) => {
    const f = localCssFor(url);
    return f ? `@import url('${pathToFileURL(f).href}');` : all;
  });
}

/** The same for a built page on disk (only inside <style> blocks). Returns the number of imports swapped. */
export function localizeHtmlFile(file) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  if (!html.includes('@import')) return 0;
  let n = 0;
  const out = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (all, open, css, close) => {
    const next = localizeFonts(css);
    if (next === css) return all;
    n += (css.match(IMPORT_RE) || []).length - (next.match(IMPORT_RE) || []).length;
    return open + next + close;
  });
  if (n) fs.writeFileSync(file, out);
  return n;
}

/** Remote font imports of the engine's themes and layouts: [{ url, usedBy: ['themes/x', 'layouts/y'] }]. */
export function collectImports({ themes = null } = {}) {
  const map = new Map();
  for (const kind of ['themes', 'layouts']) {
    for (const f of fs.readdirSync(path.join(ENGINE, kind)).filter((x) => x.endsWith('.css')).sort()) {
      const name = f.replace(/\.css$/, '');
      if (kind === 'themes' && themes && !themes.includes(name)) continue;
      for (const m of fs.readFileSync(path.join(ENGINE, kind, f), 'utf8').matchAll(IMPORT_RE)) {
        if (!map.has(m[2])) map.set(m[2], []);
        map.get(m[2]).push(`${kind}/${name}`);
      }
    }
  }
  return [...map].map(([url, usedBy]) => ({ url, usedBy }));
}
export const themeNames = () => fs.readdirSync(path.join(ENGINE, 'themes')).filter((x) => x.endsWith('.css')).map((x) => x.replace(/\.css$/, ''));

/** What is installed: { dir, imports, covered, missing: [{url, usedBy}], families: [...], files, bytes }. */
export function fontsStatus({ themes = null } = {}) {
  const m = readManifest({ fresh: true });
  const wanted = collectImports({ themes });
  const missing = wanted.filter((w) => !importComplete(w.url));
  const entries = Object.values(m.imports);
  const families = [...new Set(entries.flatMap((e) => e.families || []))].sort();
  let files = 0, bytes = 0;
  try {
    for (const sub of ['files', 'css']) for (const f of fs.readdirSync(path.join(fontsDir(), sub))) { files += sub === 'files'; bytes += fs.statSync(path.join(fontsDir(), sub, f)).size; }
  } catch {}
  return { dir: fontsDir(), imports: entries.length, wanted: wanted.length, covered: wanted.length - missing.length, missing, families, files, bytes };
}

// ---------- download (only ever called by the fonts.mjs command) ----------

/** Apply mirrors: { google: host for fonts.googleapis.com, gstatic: host for fonts.gstatic.com, jsdelivr: host for cdn.jsdelivr.net }. */
export function mirrorUrl(url, mirrors = {}) {
  const u = new URL(url);
  const to = { 'fonts.googleapis.com': mirrors.google, 'fonts.gstatic.com': mirrors.gstatic, 'cdn.jsdelivr.net': mirrors.jsdelivr }[u.host];
  if (!to) return url;
  const t = /^https?:\/\//.test(to) ? new URL(to) : new URL(`https://${to}`);
  u.protocol = t.protocol; u.host = t.host;
  return u.href;
}

async function get(url, { type = 'buffer', retries = 3, timeout = 30000 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) {
        last = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429 && res.status !== 408) break; // a 404 will not get better
      } else return type === 'text' ? await res.text() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = new Error(e.cause?.code || e.cause?.message || e.message);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw new Error(`${last.message}（${url.slice(0, 120)}）`);
}

const FONT_SIG = { 'wOF2': 'woff2', 'wOFF': 'woff', 'OTTO': 'otf', '\u0000\u0001\u0000\u0000': 'ttf', 'true': 'ttf', 'ttcf': 'ttc' };

/**
 * Mirror one stylesheet and its font files. Resolves to { ok, families, files, bytes, downloaded, failed: [..] };
 * the manifest gets the entry only when every file is there (a partial set would be a silent partial fallback).
 */
export async function downloadImport(url, { mirrors = {}, concurrency = 8, force = false, onProgress = () => {} } = {}) {
  const dir = fontsDir();
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const cssUrl = mirrorUrl(url, mirrors);
  const css = await get(cssUrl, { type: 'text' });
  if (!/@font-face/i.test(css)) throw new Error(`返回的不是字体样式表（${cssUrl.slice(0, 100)}）`);

  // Every url(...) inside the sheet → absolute remote url → local file name. Keyed by the canonical (unmirrored)
  // url where the mirror keeps Google's paths, so a later run through another mirror reuses the same files.
  const jobs = new Map(); // local name → fetch url
  const local = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, _q, ref) => {
    if (/^data:/i.test(ref)) return all;
    const abs = new URL(ref, cssUrl).href;
    const ext = (new URL(abs).pathname.match(/\.(woff2|woff|ttf|otf|ttc|eot)$/i)?.[1] || 'woff2').toLowerCase();
    const name = `${hash(abs)}.${ext}`;
    jobs.set(name, mirrorUrl(abs, mirrors));
    return `url('../files/${name}')`;
  });
  const families = [...new Set([...css.matchAll(/font-family:\s*(['"]?)([^;'"}]+)\1\s*[;}]/gi)].map((m) => m[2].trim()))];

  const list = [...jobs];
  const failed = [];
  let done = 0, bytes = 0, downloaded = 0, next = 0;
  const worker = async () => {
    while (next < list.length) {
      const [name, src] = list[next++];
      const file = path.join(dir, 'files', name);
      try {
        if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) bytes += fs.statSync(file).size;
        else {
          const buf = await get(src);
          if (!FONT_SIG[buf.subarray(0, 4).toString('latin1')]) throw new Error(`不是字体文件（${src.slice(0, 100)}）`);
          fs.writeFileSync(file + '.part', buf);
          fs.renameSync(file + '.part', file); // never leave a truncated font behind
          bytes += buf.length; downloaded += buf.length;
        }
      } catch (e) { failed.push(e.message); }
      onProgress(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));

  const result = { ok: !failed.length, families, files: list.length, bytes, downloaded, failed };
  if (result.ok) {
    const cssName = `css/${hash(url)}.css`;
    fs.writeFileSync(path.join(dir, cssName), `/* ${url} */\n${local}`);
    const m = readManifest({ fresh: true });
    m.imports[url] = { css: cssName, families, files: list.length, bytes, source: cssUrl === url ? undefined : cssUrl, fetched: new Date().toISOString() };
    writeManifest(m);
  }
  return result;
}

/** Remove the local fonts (everything under <cache>/fonts). Returns the bytes freed. */
export function cleanFonts() {
  const { bytes } = fontsStatus();
  fs.rmSync(fontsDir(), { recursive: true, force: true });
  cached = null;
  return bytes;
}

export const fmtSize = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB`);
