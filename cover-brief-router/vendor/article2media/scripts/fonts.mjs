#!/usr/bin/env node
// article2media · Local web fonts: download the fonts the themes use into the cache, so rendering needs no network.
// Runs the shared engine (skills/article2media/engine), which lives in this skill.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const engine = process.env.ARTICLE2MEDIA_ENGINE ? pathToFileURL(process.env.ARTICLE2MEDIA_ENGINE.replace(/\/?$/, '/scripts/')) : new URL('../engine/scripts/', import.meta.url);
if (!fs.existsSync(new URL('fonts.mjs', engine))) {
  console.error('✗ 找不到共享引擎 article2media/engine：请重新安装 article2media skill');
  process.exit(2);
}
process.env.A2M_CLI = 'fonts.mjs';
await import(new URL('fonts.mjs', engine));
