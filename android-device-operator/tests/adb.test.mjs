import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUiNodes, resolveAdb } from '../scripts/lib/adb.mjs'

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.tencent.mm" content-desc="" clickable="false" bounds="[0,0][1080,2340]">
    <node index="0" text="下一题" resource-id="btn_nexttopic" class="android.widget.Button" package="com.tencent.mm" content-desc="" clickable="true" bounds="[540,2100][1020,2260]" />
    <node index="1" text="A. 甲" resource-id="" class="android.view.View" package="com.tencent.mm" content-desc="" clickable="true" bounds="[40,600][1040,700]" />
    <node index="2" text="" resource-id="" class="android.view.View" package="com.tencent.mm" content-desc="图标按钮" clickable="true" bounds="[900,80][1020,200]" />
    <node index="3" text="" resource-id="" class="android.view.View" package="com.tencent.mm" content-desc="" clickable="false" bounds="[0,0][10,10]" />
    <node index="4" text="Tom &amp; Jerry &lt;3" resource-id="" class="android.widget.TextView" package="com.tencent.mm" content-desc="" clickable="false" bounds="[0,300][500,360]" />
  </node>
</hierarchy>`

test('parseUiNodes：抽出文本 / 可点元素 / 边界，跳过空节点', () => {
  const nodes = parseUiNodes(XML)
  const texts = nodes.map((n) => n.text)
  assert.ok(texts.includes('下一题'))
  assert.ok(texts.includes('A. 甲'))
  assert.ok(texts.includes('图标按钮'), 'content-desc 要当文本用')
  assert.ok(!nodes.some((n) => n.text === '' && !n.clickable), '既没文本又不可点的节点应被丢弃')
})

test('parseUiNodes：bounds 转成 box，用于算点击中心', () => {
  const nodes = parseUiNodes(XML)
  const btn = nodes.find((n) => n.text === '下一题')
  assert.deepEqual(btn.box, { x: 540, y: 2100, w: 480, h: 160 })
  assert.equal(btn.ref, 'ax:1')
})

test('parseUiNodes：XML 实体要还原，否则拿去做 text: 匹配会失败', () => {
  const nodes = parseUiNodes(XML)
  assert.ok(nodes.some((n) => n.text === 'Tom & Jerry <3'))
})

test('resolveAdb 在本机应能定位到可用的 adb（没有则返回 null 而不是抛错）', () => {
  const bin = resolveAdb()
  assert.ok(bin === null || typeof bin === 'string')
  if (bin) assert.match(bin, /adb(\.exe)?$/)
})
