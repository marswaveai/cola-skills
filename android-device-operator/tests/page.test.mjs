import test from 'node:test'
import assert from 'node:assert/strict'
import { checkCond, findElement, normalizeCond, signature } from '../scripts/lib/page.mjs'

const page = {
  url: 'https://x.test/dati/answer',
  title: '答题',
  text: '第 3 题 3/10 下列哪项正确 A. 甲 B. 乙',
  lines: ['第 3 题 3/10', '下列哪项正确', 'A. 甲', 'B. 乙'],
  elements: [
    { ref: 'css:#btn_nexttopic', role: 'a', text: '下一题', value: null, box: { x: 0, y: 0, w: 100, h: 40 } },
    { ref: 'css:label:nth-of-type(1)', role: 'label', text: 'A. 甲', value: null, box: { x: 0, y: 50, w: 100, h: 40 } },
    { ref: 'css:#name', role: 'input', text: '', value: '张三', box: { x: 0, y: 100, w: 100, h: 40 } }
  ]
}

test('signature 只取决于页面形状，与时间/顺序无关的可重复', () => {
  const a = signature(page)
  const b = signature({ ...page })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)

  const changed = signature({ ...page, elements: [page.elements[0], page.elements[2]] })
  assert.notEqual(a, changed, '元素结构变了，指纹必须变')
})

test('findElement 支持 css / text / text~ / 裸串', () => {
  assert.equal(findElement(page, 'css:#btn_nexttopic').text, '下一题')
  assert.equal(findElement(page, 'text:下一题').ref, 'css:#btn_nexttopic')
  assert.equal(findElement(page, 'text~:下一').ref, 'css:#btn_nexttopic')
  assert.equal(findElement(page, '下一题').ref, 'css:#btn_nexttopic')
  assert.equal(findElement(page, 'text:不存在'), null)
})

test('checkCond：文本 / 正则 / URL / 存在 / 不存在 / 值', () => {
  assert.equal(checkCond({ kind: 'text', value: '3/10' }, page), true)
  assert.equal(checkCond({ kind: 'text', value: '4/10' }, page), false)
  assert.equal(checkCond({ kind: 'textMatches', value: '\\d+/10' }, page), true)
  assert.equal(checkCond({ kind: 'urlMatches', value: '/dati/answer' }, page), true)
  assert.equal(checkCond({ kind: 'exists', ref: 'css:#btn_nexttopic' }, page), true)
  assert.equal(checkCond({ kind: 'gone', ref: 'css:#btn_nexttopic' }, page), false)
  assert.equal(checkCond({ kind: 'value', ref: 'css:#name', value: '张三' }, page), true)
  assert.equal(checkCond({ kind: 'value', ref: 'css:#name', value: '李四' }, page), false)
})

test('normalizeCond 把简写补成标准结构', () => {
  assert.deepEqual(normalizeCond('3/10', { timeout: 5 }), {
    text: '3/10',
    kind: 'text',
    value: '3/10',
    timeout: 5
  })
  const byRef = normalizeCond({ ref: 'css:#a' })
  assert.equal(byRef.kind, 'exists')
  // 简写 key 也要能识别，否则 flow 里写 {"textMatches":...} 会直接报错
  assert.equal(normalizeCond({ textMatches: '\\d+/10' }).kind, 'textMatches')
  assert.equal(normalizeCond({ urlMatches: '/done' }).kind, 'urlMatches')
  assert.equal(normalizeCond({ gone: 'css:#loading' }).kind, 'gone')
  assert.equal(normalizeCond({ value: '张三', ref: 'css:#name' }).kind, 'value')
})
