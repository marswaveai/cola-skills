#!/usr/bin/env node
// article2media · Batch pipeline: fetch a list of links, queue board, next step, publish checklist.
// Runs the shared engine (skills/article2media/engine), which lives next to this script.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const engine = process.env.ARTICLE2MEDIA_ENGINE ? pathToFileURL(process.env.ARTICLE2MEDIA_ENGINE.replace(/\/?$/, '/scripts/')) : new URL('../engine/scripts/', import.meta.url);
if (!fs.existsSync(new URL('batch.mjs', engine))) {
  console.error('✗ 找不到共享引擎 article2media/engine：article2media 的 engine 目录不完整，重新安装插件');
  process.exit(2);
}
process.env.A2M_CLI = 'batch.mjs';
await import(new URL('batch.mjs', engine));
