#!/usr/bin/env node
// article2media · Publishing feedback: record posts and metrics per work directory, report across them.
// Runs the shared engine (skills/article2media/engine), which lives next to this script.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const engine = process.env.ARTICLE2MEDIA_ENGINE ? pathToFileURL(process.env.ARTICLE2MEDIA_ENGINE.replace(/\/?$/, '/scripts/')) : new URL('../engine/scripts/', import.meta.url);
if (!fs.existsSync(new URL('stats.mjs', engine))) {
  console.error('✗ 找不到共享引擎 article2media/engine：article2media 的 engine 目录不完整，重新安装插件');
  process.exit(2);
}
process.env.A2M_CLI = 'stats.mjs';
await import(new URL('stats.mjs', engine));
