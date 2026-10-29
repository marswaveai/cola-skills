import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli.mjs')

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('--help 输出用法并返回 0', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /用法/)
})

test('未知命令返回 3 且输出合法 JSON', () => {
  const r = run(['nope'])
  assert.equal(r.code, 3)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'BadCommand')
})

test('act 缺 --op 时是参数错误，不是崩溃', () => {
  const r = run(['act', '--ref', 'css:#a'])
  assert.equal(r.code, 3)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.error.code, 'BadArgs')
  assert.ok(payload.error.hint === undefined || typeof payload.error.hint === 'string')
})

test('open 缺 --to 时给出可执行的提示', () => {
  const r = run(['open'])
  assert.equal(r.code, 3)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.error.code, 'BadArgs')
  assert.match(payload.error.hint ?? '', /--to/)
})

test('run 缺 --flow 时报 BadArgs', () => {
  const r = run(['run'])
  assert.equal(r.code, 3)
  assert.equal(JSON.parse(r.stdout).error.code, 'BadArgs')
})

test('preflight 在没有设备时退出码是 2（需要人），且 JSON 可解析', () => {
  const r = run(['preflight'])
  const payload = JSON.parse(r.stdout)
  assert.equal(typeof payload.ok, 'boolean')
  assert.ok(Array.isArray(payload.checks))
  if (!payload.ok) {
    assert.equal(r.code, 2, '环境类问题必须映射成「需要人」而不是「重试」')
    assert.ok(payload.next.length > 0, '失败时必须给出下一步')
  }
})
