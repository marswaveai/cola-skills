// Brand info for page furniture (footer brand, @handle, series, editor name).
// Order: --brand file → brand.json next to the input → ./article2media.brand.json → ~/.config/article2media/brand.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function loadBrand({ file, dir } = {}) {
  const candidates = [
    file,
    dir && path.join(dir, 'brand.json'),
    path.join(process.cwd(), 'article2media.brand.json'),
    path.join(os.homedir(), '.config', 'article2media', 'brand.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try { return { ...JSON.parse(fs.readFileSync(p, 'utf8')), _from: p }; } catch { console.log(`⚠ brand 文件无法解析：${p}`); }
  }
  return {};
}

/**
 * Brand kit: turn the raw brand.json into what the layouts draw.
 *   name, handle, series, editor      text furniture (as before)
 *   avatar                            picture next to the name (path relative to the brand file, absolute, or a URL)
 *   tagline                           one line under the name on the last card
 *   follow                            call to action on the last card ("关注 @you，每周一篇")
 *   accent                            brand color: replaces the theme's first accent (cover, last card, first section)
 *   issue                             issue number or label ("12" → 第 12 期); content.json `issue` and --issue override it
 */
export function resolveBrand(brand = {}, { issue } = {}) {
  const out = { ...brand };
  if (brand.avatar && !/^(https?|data|file):/i.test(brand.avatar)) {
    const base = brand._from ? path.dirname(brand._from) : process.cwd();
    const file = path.resolve(base, brand.avatar);
    if (fs.existsSync(file)) out.avatar = pathToFileURL(file).href;
    else { console.log(`⚠ 品牌头像找不到：${file}（路径相对 brand.json 所在目录）`); delete out.avatar; }
  }
  const n = issue ?? brand.issue;
  if (n !== undefined && n !== null && String(n).trim() !== '') out.issueLabel = /^\d+$/.test(String(n).trim()) ? `第 ${String(n).trim()} 期` : String(n).trim();
  if (brand.accent && !/^#[0-9a-fA-F]{3,8}$/.test(brand.accent)) { console.log(`⚠ 品牌色 accent 要写成 #RRGGBB，已忽略：${brand.accent}`); delete out.accent; }
  return out;
}

/** CSS appended after the theme so the brand color takes the first accent slot. */
export const brandCss = (brand = {}) => (brand.accent ? `\n:root { --accent-1: ${brand.accent}; }\n` : '');
