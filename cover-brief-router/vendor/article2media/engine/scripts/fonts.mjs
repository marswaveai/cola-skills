#!/usr/bin/env node
// Local web fonts: download the fonts the themes and layouts import (Google Fonts, jsDelivr) into the cache directory,
// so that rendering does not depend on the network. Running this command is the consent to download; rendering never
// downloads — it uses the local copy when there is one and the remote @import otherwise.
//
//   node fonts.mjs                      # 下载全部主题和版式用到的字体
//   node fonts.mjs --theme dopamine,brutal
//   node fonts.mjs --mirror <host>      # fonts.googleapis.com 的镜像（样式表）；字体文件按镜像返回的地址下载
//   node fonts.mjs --list               # 已安装 / 缺少的字体
//   node fonts.mjs --clean              # 删除本地字体
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { cleanFonts, collectImports, downloadImport, fmtSize, fontsStatus, importComplete, readManifest, themeNames } from './lib/fonts.mjs';

const CLI = process.env.A2M_CLI || 'fonts.mjs';
let opt;
try {
  ({ values: opt } = parseArgs({ options: {
    theme: { type: 'string', short: 't' },
    mirror: { type: 'string' },
    'mirror-files': { type: 'string' },
    'mirror-jsdelivr': { type: 'string' },
    concurrency: { type: 'string', default: '8' },
    force: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    clean: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } }));
} catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

if (opt.help) {
  console.log([
    `用法：node ${CLI} [--theme 名称|a,b] [--mirror 主机] [--list] [--clean]`,
    '  把主题和版式用到的网络字体下载到本地缓存，之后出图不再依赖网络（出图本身从不下载）。',
    '  --theme a,b              只下载这些主题用到的字体（版式自带的字体总会下载）',
    '  --mirror 主机            fonts.googleapis.com 的镜像（与它接口兼容的样式表地址）',
    '  --mirror-files 主机      fonts.gstatic.com 的镜像（镜像的样式表仍指向 gstatic 时用）',
    '  --mirror-jsdelivr 主机   cdn.jsdelivr.net 的镜像',
    '  --concurrency 8          同时下载的文件数',
    '  --force                  已有的文件也重新下载',
    '  --list                   列出已安装和缺少的字体',
    '  --clean                  删除本地字体',
    '  环境变量：ARTICLE2MEDIA_CACHE 缓存目录；ARTICLE2MEDIA_FONT_MIRROR 同 --mirror；ARTICLE2MEDIA_FONTS=remote 出图时不用本地字体',
  ].join('\n'));
  process.exit(0);
}

const themes = opt.theme && opt.theme !== 'all' ? opt.theme.split(',').map((s) => s.trim()).filter(Boolean) : null;
if (themes) {
  const bad = themes.filter((t) => !themeNames().includes(t));
  if (bad.length) { console.error(`✗ 没有主题：${bad.join('、')}`); process.exit(2); }
}

if (opt.clean) {
  const dir = fontsStatus().dir;
  console.log(`✓ 已删除本地字体（${fmtSize(cleanFonts())}）：${dir}`);
  process.exit(0);
}

const short = (url) => {
  const u = new URL(url);
  if (u.host === 'fonts.googleapis.com') return u.searchParams.getAll('family').map((f) => f.split(':')[0]).join(' + ');
  return decodeURIComponent(u.pathname.replace(/^\/npm\//, '')).split('/').filter((s) => !/^(dist|index\.css|result\.css)$/.test(s)).join(' / ');
};

if (opt.list) {
  const st = fontsStatus({ themes });
  const m = readManifest();
  console.log(`本地字体目录：${st.dir}`);
  for (const w of collectImports({ themes })) {
    const e = importComplete(w.url) && m.imports[w.url];
    console.log(`${e ? '✓' : '—'} ${short(w.url)}${e ? `（${e.files} 个文件，${fmtSize(e.bytes)}）` : '（未安装）'}  ← ${w.usedBy.map((x) => x.split('/')[1]).join(', ')}`);
  }
  console.log(`\n本地字体：${st.covered} / ${st.wanted} 组已安装，${st.families.length} 个字体家族，${st.files} 个文件，${fmtSize(st.bytes)}。` +
    (st.missing.length ? `缺少的会在出图时联网加载；运行 node ${CLI} 下载。` : ''));
  process.exit(0);
}

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set (Node 22.21+): restart once with it.
const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const [maj, min] = process.versions.node.split('.').map(Number);
if (proxied && !process.env.NODE_USE_ENV_PROXY && (maj > 22 || (maj === 22 && min >= 21))) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(r.status ?? 1);
}

const mirrors = { google: opt.mirror || process.env.ARTICLE2MEDIA_FONT_MIRROR, gstatic: opt['mirror-files'], jsdelivr: opt['mirror-jsdelivr'] };
const wanted = collectImports({ themes });
const todo = opt.force ? wanted : wanted.filter((w) => !importComplete(w.url));
console.log(`字体：${wanted.length} 组样式表${themes ? `（主题 ${themes.join(', ')} + 版式）` : '（全部主题和版式）'}，需要下载 ${todo.length} 组 → ${fontsStatus().dir}` +
  (mirrors.google ? `；Google Fonts 镜像 ${mirrors.google}` : ''));

const t0 = Date.now();
let nErr = 0, got = 0;
const tty = process.stdout.isTTY;
for (const w of todo) {
  const label = short(w.url);
  const t1 = Date.now();
  try {
    const r = await downloadImport(w.url, {
      mirrors, force: opt.force, concurrency: Math.max(1, Math.min(16, Number(opt.concurrency) || 8)),
      onProgress: (d, n) => { if (tty) process.stdout.write(`\r  … ${label}：${d} / ${n}`); },
    });
    if (tty) process.stdout.write('\r\x1b[K');
    got += r.downloaded;
    if (r.ok) console.log(`✓ ${label}：${r.families.join('、')}，${r.files} 个文件，${fmtSize(r.bytes)}${r.downloaded < r.bytes ? `（新下载 ${fmtSize(r.downloaded)}）` : ''}，${((Date.now() - t1) / 1000).toFixed(1)}s`);
    else {
      nErr++;
      console.log(`✗ ${label}：${r.failed.length} / ${r.files} 个文件没下载下来（${r.failed[0]}）；已下载的会保留，重新运行可续传`);
    }
  } catch (e) {
    if (tty) process.stdout.write('\r\x1b[K');
    nErr++;
    console.log(`✗ ${label}：${e.message}`);
  }
}

const st = fontsStatus({ themes });
console.log(`\n本地字体：${st.covered} / ${st.wanted} 组已安装，${st.families.length} 个字体家族，${st.files} 个文件，共 ${fmtSize(st.bytes)}；本次下载 ${fmtSize(got)}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s。`);
if (nErr) {
  console.log(`字体检查：${nErr} 个错误。没装上的字体出图时仍会联网加载；网络不通时可以换镜像：node ${CLI} --mirror <与 fonts.googleapis.com 兼容的主机>` +
    (proxied ? '' : '，或设置 HTTPS_PROXY 后重试'));
}
process.exit(nErr ? 1 : 0);
