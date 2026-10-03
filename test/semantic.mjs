// Real plugin/provider integration; only external model streaming is synthetic.
// Set DSH_TEST_CLI_NODE_MODULES to a host node_modules directory to run this group.
import assert from 'node:assert/strict'
import { Config, apply } from '../lib/index.js'
import { parseDecision } from '../lib/semantic-drift.mjs'

assert.deepEqual(parseDecision('{"topicChanged":false,"title":""}',80),{topicChanged:false})
assert.deepEqual(parseDecision('{"topicChanged":true,"title":"青海湖自驾路线"}',80),{topicChanged:true,title:'青海湖自驾路线'})
for(const raw of ['null','[]','{"topicChanged":"false","title":""}','{"topicChanged":true,"title":""}','{"topicChanged":true,"title":"\\u200b"}','{"topicChanged":false,"title":"非空"}']) {
  assert.throws(()=>parseDecision(raw,80))
}
console.log('semantic decision validation: 8 assertions passed')

const anchor = process.env.DSH_TEST_CLI_NODE_MODULES
if (!anchor) { console.log('semantic integration: SKIP (set DSH_TEST_CLI_NODE_MODULES; not a pass)'); process.exit(0) }
let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`) }
}
const a = '阳台种菜需要什么土壤和合适花盆？'
const b = '十一月青海湖自驾需要准备哪些衣物？'
const echo = '这次不考虑阳台种菜了，想安排青海湖自驾路线。'
const numbered = texts => texts.map((text, i) => ({ seq: i + 1, text }))
function harness(title = '阳台种菜指南', overrides = {}, output = '{"topicChanged":true,"title":"青海湖自驾路线"}') {
  let provider, current = { title, source: { kind: 'provider', provider: 'drift', model: {provider:'prior', model:'prior'} }, messageSeqs: [1,2,3] }
  const handlers = new Map(), calls = [], events = [], texts = []
  const session = { id: 'synthetic-semantic-check', header: {}, append: (type, data) => events.push({type,data}) }
  let responder = async () => output
  const ctx = {
    logger: {info(){},debug(){},warn(){},error(){}},
    on: (n, fn) => handlers.set(n,fn),
    llm: { async *stream(options) {
      calls.push(options)
      const response = await responder(options)
      yield {type:'text-delta', index:0, text:response}
      yield {type:'finish', reason:{kind:'stop'}}
    } },
    sessionTitle: {get:()=>current, register:p=>provider=p, refresh:async()=> {
      const next = await provider.generate(request())
      current = {...next, source:{kind:'provider',provider:'drift', ...(next.model ? {model:next.model}: {})}}
    }}
  }
  const config = Config['~standard'].validate({cliNodeModules:anchor, cooldownMs:0, maxLlmUpdatesPerSession:20, ...overrides})
  assert(!config.issues)
  apply(ctx, config.value)
  function request(messages = numbered(texts)) {return {session,messages,route:{provider:'synthetic',model:'synthetic'},signal:new AbortController().signal}}
  return {
    ctx, session, calls, events, get current(){return current}, set current(v){current=v},
    get provider(){return provider}, request,
    respond:fn=>responder=fn,
    generate:messages=>provider.generate(request(messages)),
    async send(text) {
      texts.push(text)
      handlers.get('session/event')(session,{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}})
      for(let i=0;i<10;i++) await new Promise(r=>setImmediate(r))
    }
  }
}

await test('semantic veto preserves title and previous model attribution', async()=> {
  const h = harness('青海湖十一月穿衣与租车费用', {}, '{"topicChanged":false,"title":""}')
  const old = '青海湖十一月穿衣与租车费用需要进一步说明'
  const later = '环湖公路是否需要换SUV，请分析车辆条件和路况'
  const r = await h.generate(numbered([old,old,old,later,later,later]))
  assert.equal(r.title,'青海湖十一月穿衣与租车费用')
  assert.deepEqual(r.model,{provider:'prior',model:'prior'})
  assert.equal(h.calls.length,1)
})
await test('true change uses one decision call and attributes only new suffix', async()=> {
  const h=harness(), r=await h.generate(numbered([a,a,a,a,b,b]))
  assert.equal(r.title,'青海湖自驾路线')
  assert.deepEqual(r.messageSeqs,[5,6])
  assert.equal(h.calls.length,1)
  const input=JSON.parse(h.events[0].data.messages[0].content[0].text)
  assert.equal(input.currentTitle,'阳台种菜指南')
  assert.deepEqual(input.recentMessages,numbered([a,a,a,a,b,b]).slice(4))
  assert.equal(h.events[0].data.system,h.calls[0].system)
  assert.deepEqual(h.events[0].data.messages,h.calls[0].messages)
  assert.deepEqual(h.events[0].data.messageSeqs,[1,2,3,4,5,6])
})
await test('long title is preserved and single-anchor candidate reaches semantic check',async()=> {
  const h=harness('请帮我详细分析一下青海湖旅行路线',{},'{"topicChanged":true,"title":"Rust类型推断与借用检查"}')
  const old='青海湖旅行路线该怎么安排，应该选择什么住宿？'
  const next='Rust 编译器类型推断和借用检查规则如何理解？'
  const r=await h.generate(numbered([old,old,old,old,next,next]))
  assert.equal(r.title,'Rust类型推断与借用检查')
  assert.equal(JSON.parse(h.calls[0].messages[0].content[0].text).currentTitle,'请帮我详细分析一下青海湖旅行路线')
})
await test('first and later true change with middle echo survive actual watcher', async()=> {
  const h=harness('咖啡烘焙指南')
  h.respond(async()=>h.calls.length===1 ? '{"topicChanged":true,"title":"阳台种菜指南"}' : '{"topicChanged":true,"title":"青海湖自驾路线"}')
  const z='咖啡烘焙需要注意火候和咖啡豆的保存。'
  for(const text of [z,z,z,z,a,a,a,a,a,a,b,echo,b]) await h.send(text)
  assert.equal(h.current.title,'青海湖自驾路线')
  assert.equal(h.calls.length,2)
})
await test('malformed/nonboolean/control/oversize output fails closed',async()=> {
  for(const raw of ['not JSON','{"topicChanged":"false","title":"改名"}','{"topicChanged":true,"title":""}','{"topicChanged":true,"title":"坏\\n标题"}',JSON.stringify({topicChanged:true,title:'\u200b'}),JSON.stringify({topicChanged:true,title:'长'.repeat(100)})]) {
    const h=harness('阳台种菜指南',{},raw), r=await h.generate(numbered([a,a,a,a,b,b]))
    assert.equal(r.title,'阳台种菜指南',raw)
  }
})
await test('semantic veto consumes budget and direct provider cooldown',async()=> {
  const h=harness('阳台种菜指南',{maxLlmUpdatesPerSession:2},'{"topicChanged":false,"title":""}')
  const msgs=numbered([a,a,a,a,b,b])
  for(let i=0;i<4;i++) await h.generate(msgs)
  assert.equal(h.calls.length,2)
  const c=harness('阳台种菜指南',{cooldownMs:120000},'{"topicChanged":false,"title":""}')
  await c.generate(msgs); await c.generate(msgs)
  assert.equal(c.calls.length,1)
})
await test('concurrent direct provider calls do not duplicate model requests',async()=> {
  const h=harness(); let release
  const barrier=new Promise(resolve=>release=resolve)
  h.respond(()=>barrier)
  const first=h.generate(numbered([a,a,a,a,b,b]))
  for(let i=0;i<50 && !h.calls.length;i++) await new Promise(r=>setImmediate(r))
  assert(h.calls.length)
  const second=h.generate(numbered([a,a,a,a,b,b]))
  await new Promise(r=>setImmediate(r))
  release('{"topicChanged":true,"title":"青海湖自驾路线"}')
  const [,other]=await Promise.all([first,second])
  assert.equal(other.title,'阳台种菜指南')
  assert.equal(h.calls.length,1)
})
await test('pinned/seeded/delegated titles bypass semantic changes',async()=> {
  for(const kind of ['pinned','seeded','delegated']) {
    const h=harness()
    if(kind==='pinned')h.current={...h.current,source:{kind:'user'}}
    if(kind==='seeded')h.session.header.isSeeded=true
    if(kind==='delegated')h.session.header.parentSession='synthetic-parent'
    const r=await h.generate(numbered([a,a,a,a,b,b]))
    assert.equal(r.title,'阳台种菜指南'); assert.equal(h.calls.length,0)
  }
})
await test('oversize recent message preserves title without model call',async()=> {
  const h=harness('阳台种菜指南',{llmMaxInputBytes:1024})
  const r=await h.generate(numbered([a,a,a,a,b.repeat(1000),b.repeat(1000)]))
  assert.equal(r.title,'阳台种菜指南'); assert.equal(h.calls.length,0)
})
console.log(`semantic integration: ${passed} pass, ${failed} fail, 0 skipped`)
process.exitCode=failed ? 1 : 0
