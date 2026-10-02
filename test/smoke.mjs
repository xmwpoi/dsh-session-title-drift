// 离线冒烟测试（默认 npm test 入口）
// - 只用 Node 标准库 + 合成数据；无网络；不读真实会话/profile；不写任何输出文件。
// - 失败退出码非零。
// - 依赖 @deepseek-ai/schemastery 的 schema 回归组：依赖未安装时跳过（明确计数），
//   安装依赖后重跑即全覆盖。
// 覆盖范围与历史离线门的关系：
//   - 漂移门/本地规则/schema 断言复用 p0d-schema-regression.mjs 与 m1_unit_test.mjs
//     的公开断言思路，阈值取当前集成值（driftOlderMin=3 / anchorFrac=0.08 /
//     maxHits=2 等，即 Config 默认值）。
//   - 不覆盖：真实会话回放、宿主内加载、GUI 行为（见 README「已知限制」）。
import { evaluateDrift, normalizeMessages, tokenize } from '../lib/drift-gate.mjs'

let pass = 0
let fail = 0
let skip = 0
function ok(name, cond, detail) {
  if (cond) pass += 1
  else { fail += 1; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`) }
}
function skip1(name, reason) {
  skip += 1
  console.log(`SKIP ${name} (${reason})`)
}

// 当前集成阈值（= lib/index.js Config 的 drift* 默认值；禁用模块默认组合——
// 模块默认 olderMin=2/frac=0.06/maxHits=3 已被历史回放证明不安全 realFP=8）
const INTEGRATION = {
  windowSize: 6, minMessages: 4, tailCount: 3, olderMin: 3, aNewTol: 1,
  anchorFrac: 0.08, maxHits: 2, wCjk: 0.7, wLatin: 0.3, trigger: 0.25,
  minMsgChars: 12, maxCharsPerMsg: 1200,
}

// Drift generation uses the new-topic suffix, not the old-topic background.
{
  const a = '阳台种菜生菜小萝卜的种植时间和浇水安排需要重新梳理'
  const b = '青海湖自驾的路线和住宿安排，请按每天行程列出建议'
  const msgs = [a, a, a, a, b, b].map((text, i) => ({ seq: i + 1, text }))
  const r = evaluateDrift('阳台种菜生菜小萝卜', msgs, INTEGRATION)
  ok('D1 A4+B2 drift', r.drift === true)
  ok('D2 old-topic echo excluded', r.rewriteStart === 4)
  ok('D3 source seqs retained', msgs.slice(r.rewriteStart).map(m => m.seq).join(',') === '5,6')
  const short = [...msgs.slice(0, 5), {seq: 7, text: '继续'}, msgs[5]]
  ok('D4 ignored message preserves original index', evaluateDrift('阳台种菜生菜小萝卜', short, INTEGRATION).rewriteStart === 4)
  const same = evaluateDrift('阳台种菜生菜小萝卜', msgs.map(m => ({...m, text: a})), INTEGRATION)
  ok('D5 same topic has no rewrite input', !same.drift && same.rewriteStart === null)
  const echoLast = [...msgs.slice(0, 3), msgs[4], msgs[5], msgs[3]]
  ok('D6 old topic at end prevents rewrite', evaluateDrift('阳台种菜生菜小萝卜', echoLast, INTEGRATION).rewriteStart === null)
  const long = msgs.map(m => m.text === b ? {...m, text: b + '完整末段'.repeat(1000)} : m)
  const start = evaluateDrift('阳台种菜生菜小萝卜', long, INTEGRATION).rewriteStart
  ok('D7 generation retains untruncated original', start === 4 && long.slice(start)[0].text.endsWith('完整末段') && long[start].text.length > 1200)
  ok('D8 fractional tolerance maps to integer index', evaluateDrift('阳台种菜生菜小萝卜', [a,a,a,b,b,b], {...INTEGRATION,aNewTol:0.5}).rewriteStart === 3)
  ok('D9 anchor cannot widen reserved suffix', evaluateDrift('阳台种菜生菜小萝卜', msgs, {...INTEGRATION,aNewTol:2}).rewriteStart === 5)
  ok('D10 fractional tail maps to actual slice boundary', evaluateDrift('阳台种菜生菜小萝卜', msgs, {...INTEGRATION,tailCount:2.5}).rewriteStart === 4)
}

// ---------------------------------------------------------------------------
// A. 漂移门（零依赖，必跑）
// ---------------------------------------------------------------------------

// A1. 漂移命中：older 三条锚定成簇、tail 三条换话题且零锚定
{
  const title = '山区徒步路线的季节性风险评估'
  const older = [
    '周末想重新评估一下山区徒步路线的风险，把装备清单也过一遍',
    '上次那条山区徒步路线的路线图你再帮我确认一下出发时间',
    '徒步装备里的防水外套和头灯还是要带上，山区天气变化快',
  ]
  const tail = [
    '厨房下水道最近疏通之后还是有一点异味，该怎么彻底处理呢',
    '阳台的绿植叶子发黄了，是不是浇水太频繁导致的',
    '客厅的吊灯想换成更亮的色温，有什么选购建议吗',
  ]
  const r = evaluateDrift(title, [...older, ...tail], INTEGRATION)
  ok('A1 漂移命中 drift=true', r.drift === true, `score=${r.score} ${r.reason}`)
  ok('A1 非 gated', r.gated === false)
  ok('A1 CJK 空间投票', r.voteCjk === 1, `aOld=${r.aOldCjk} aNew=${r.aNewCjk} minHits=${r.minHitsCjk}`)
}

// A2. 同主题不命中：窗口内全部锚定
{
  const title = '山区徒步路线的季节性风险评估'
  const msgs = [
    '这次山区徒步路线的风险主要来自落石和天气突变，要提前评估',
    '徒步路线的海拔爬升数据我再核对一遍，避免路线安排过紧',
    '山区徒步的季节选择很关键，雨季和冬季的风险等级完全不同',
    '把徒步路线的撤退点和补给点也标注进风险清单里',
    '装备按季节分两套：夏季防晒通风，冬季保暖防滑',
    '最后把整条徒步路线的风险评估结论整理成一页备忘',
  ]
  const r = evaluateDrift(title, msgs, INTEGRATION)
  ok('A2 同主题 drift=false', r.drift === false, `score=${r.score} ${r.reason}`)
}

// A3. 消息不足 → gated（不算触发也不算失误）
{
  const r = evaluateDrift('山区徒步路线的季节性风险评估',
    ['第一条实质性消息的内容要超过十二个字才可以', '这条也是超过十二个字门槛的实质性消息内容'],
    INTEGRATION)
  ok('A3 不足 gated=true', r.gated === true && r.drift === false, JSON.stringify(r.reason))
}

// A4. 窗口净化：样板消息与过短消息不计入 nSub
{
  const title = 'Debugging flaky integration tests'
  const msgs = [
    'the flaky integration tests failed again on main, please look into the logs',
    'another flaky test failure appeared in the integration suite this morning',
    'i reran the integration tests locally and the flaky one passed this time',
    'your parent agent id is abc-123', // 委派样板 → ignorePatterns 剔除
    'ok', // 过短 → minMsgChars 剔除
    'the integration suite seems stable now but we keep watching the flaky ones',
  ]
  const r = evaluateDrift(title, msgs, INTEGRATION)
  ok('A4 样板/过短被剔除 nSub=4', r.nSub === 4, `nSub=${r.nSub}`)
}

// A5. 拉丁空间独立投票（锚点无 CJK → CJK 空间跳过并重新归一）
{
  const title = 'Debugging flaky integration tests'
  const older = [
    'the flaky integration test failed again on main, please look into the logs',
    'another flaky integration failure appeared in the suite this morning',
    'i reran the integration tests locally and the flaky one passed this time',
  ]
  const tail = [
    '厨房下水道最近疏通之后还是有一点异味，该怎么彻底处理呢',
    '阳台的绿植叶子发黄了，是不是浇水太频繁导致的',
    '客厅的吊灯想换成更亮的色温，有什么选购建议吗',
  ]
  const r = evaluateDrift(title, [...older, ...tail], INTEGRATION)
  ok('A5 拉丁空间命中 drift=true', r.drift === true && r.voteLatin === 1, `score=${r.score} ${r.reason}`)
}

// A6. tokenize / normalizeMessages 基础行为
{
  const t = tokenize('Configure dsh-approval-center 的 CI 流程')
  ok('A6 拉丁复合词拆分', t.latin.has('dsh') && t.latin.has('approval') && t.latin.has('center'),
    JSON.stringify([...t.latin]))
  ok('A6 CJK 2-gram', t.cjk.has('流程'), JSON.stringify([...t.cjk]))
  const n = normalizeMessages(['纯文本', { text: 'text 字段' }, { content: [{ type: 'text', text: 'content 块' }] }, { message: '' }, 42])
  ok('A6 normalizeMessages 形态归一', n.length === 3 && n[0] === '纯文本' && n[1] === 'text 字段' && n[2] === 'content 块',
    JSON.stringify(n))
}

// ---------------------------------------------------------------------------
// B. lib/index.js 内部函数（动态导入；schemastery 缺失时降级跳过）
// ---------------------------------------------------------------------------

let indexLib = null
try {
  indexLib = await import(new URL('../lib/index.js', import.meta.url).href)
} catch (error) {
  const isMissingDep = error?.code === 'ERR_MODULE_NOT_FOUND' && String(error).includes('@deepseek-ai/schemastery')
  if (!isMissingDep) throw error
}

if (indexLib) {
  const { __internals, __internalsM3, Config } = indexLib
  const { localTitle, truncateDual, pickSeqs, normalizeWhitespace, stripPairedQuotes } = __internals
  const cfg = { localTitleMaxCjk: 10, localTitleMaxWords: 5, maxTitleBytes: 80, minFirstPromptChars: 4 }

  // B1. 本地标题规则（历史 m1 断言的公开子集）
  ok('B1 长首问截断', localTitle('山区徒步路线的季节性风险评估与装备准备方案需要综合考虑多方面因素。第二句不要。', cfg) === '山区徒步路线的季节性')
  ok('B1 前缀剥离', localTitle('请问如何配置 dsh 的会话标题插件呢', cfg) === '配置 dsh 的会话标题插件呢')
  ok('B1 帮我前缀', localTitle('帮我写一份季度总结报告', cfg) === '写一份季度总结报告')
  ok('B1 句末截断', localTitle('先整理这份文档。然后再翻译成英文。', cfg) === '先整理这份文档')
  ok('B1 极短跳过', localTitle('你好', cfg) === undefined)
  ok('B1 纯前缀跳过', localTitle('请问', cfg) === undefined)
  ok('B1 拉丁词上限', localTitle('please help me debug the flaky test suite in CI', cfg) === 'help me debug the flaky')
  ok('B1 字节上限', truncateDual('一二三四五六七八九十', 99, 99, 15) === '一二三四五')
  ok('B1 书名号保留', localTitle('《深入理解计算机系统》读后感整理', cfg) === '《深入理解计算机系统》读')
  ok('B1 pickSeqs 过滤', JSON.stringify(pickSeqs({ messageSeqs: [1, 99] }, [{ seq: 1 }, { seq: 2 }])) === '[1]')
  ok('B1 pickSeqs 退化', JSON.stringify(pickSeqs({ messageSeqs: [99] }, [{ seq: 1 }, { seq: 2 }])) === '[2]')
  ok('B1 空白归一', normalizeWhitespace('  a\n\nb\tc  ') === 'a b c')
  ok('B1 配对剥离', stripPairedQuotes('【重要】') === '重要')

  // B2. M3 字节预算：增量口径 == 整体 stringify；selectWindow 取预算内最长后缀
  {
    const { framedBytes, framedBytesFrom, selectWindow, localTitleCore, llmConfigOf } = __internalsM3
    const msgs = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, text: `第${i + 1}条消息的内容，长度递增`.repeat(i + 1) }))
    ok('B2 增量口径一致', framedBytes(msgs) === framedBytesFrom(msgs, 0))
    const budget = framedBytes(msgs.slice(3))
    ok('B2 selectWindow 最长后缀', JSON.stringify(selectWindow(msgs, budget).map((m) => m.seq)) === '[4,5,6,7,8]',
      JSON.stringify(selectWindow(msgs, budget).map((m) => m.seq)))
    ok('B2 单条超预算 → 空窗', selectWindow(msgs, framedBytes([msgs[7]]) - 1).length === 0)

    // B3. localTitleCore 的 truncated 语义（M3 质量门只对机械截取花 LLM）
    ok('B3 截取 truncated=true', localTitleCore('山区徒步路线的季节性风险评估与装备准备方案需要综合考虑多方面因素。', cfg)?.truncated === true)
    ok('B3 未截取 truncated=false', localTitleCore('先整理这份文档', cfg)?.truncated === false)
    ok('B3 过短 reject', localTitleCore('你好', cfg) === undefined)

    // B4. llmConfigOf：provider/model 必须成对，绝不透传未知键
    const base = { llmTargetWords: 5, llmTargetCjkCharacters: 10, llmMaxInputBytes: 32768, llmMaxOutputTokens: 64, llmTimeoutMs: 20000 }
    const warns = []
    const logger = { warn: (m) => warns.push(m) }
    const paired = llmConfigOf({ ...base, llmProvider: 'p1', llmModel: 'm1' }, logger)
    ok('B4 成对透传', paired.provider === 'p1' && paired.model === 'm1')
    const empty = llmConfigOf({ ...base, llmProvider: '', llmModel: '' }, logger)
    ok('B4 空路由不透传', empty.provider === undefined && empty.model === undefined)
    const half = llmConfigOf({ ...base, llmProvider: 'p1', llmModel: '' }, logger)
    ok('B4 半配置视为未配并告警', half.provider === undefined && half.model === undefined && warns.length === 1)
  }

  // C. schema 回归（同进程已有 Config；依赖已随 index.js 导入成功）
  {
    const validate = (input) => {
      const r = Config['~standard'].validate(input)
      if (!r || typeof r !== 'object' || Array.isArray(r) || !('value' in r && !('then' in r))) {
        throw new Error(`unexpected validate() result shape: ${JSON.stringify(r)?.slice(0, 120)}`)
      }
      if (r.issues) throw new Error(`validation issues: ${JSON.stringify(r.issues).slice(0, 300)}`)
      return r.value
    }
    try {
      // C1. validate({}) → 默认值生效（volatile 类"求值即归零"缺陷的防回归哨兵）
      const fromEmpty = validate({})
      ok('C1 默认值生效', fromEmpty.enabled === true && fromEmpty.cooldownMs === 120000
        && fromEmpty.localTitleMaxCjk === 10 && fromEmpty.mode === 'hybrid'
        && fromEmpty.llmMaxInputBytes === 32768 && fromEmpty.driftTrigger === 0.25
        && fromEmpty.driftOlderMin === 3 && fromEmpty.driftAnchorFrac === 0.08)

      // C2. 显式 config 透传
      const full = validate({ ...fromEmpty, localTitleMaxCjk: 20, mode: 'local', driftEnabled: false })
      ok('C2 显式透传', full.localTitleMaxCjk === 20 && full.mode === 'local' && full.driftEnabled === false)

      // C3. 容器哨兵：任一字段值为 {} 容器（volatile 包裹特征）即失败
      let containerFound = false
      for (const [k, v] of Object.entries(full)) {
        if (v !== null && typeof v === 'object') { containerFound = true; console.log(`FAIL 容器哨兵 ${k}`) }
      }
      ok('C3 无 volatile 容器', !containerFound)

      // C4. 越界/非法值拒绝
      let threw = false
      try { validate({ localTitleMaxCjk: 999 }) } catch { threw = true }
      ok('C4 越界值被拒绝', threw)
      threw = false
      try { validate({ llmMaxInputBytes: 32768.5 }) } catch { threw = true }
      ok('C4 小数被 .step(1) 拒绝', threw)
      threw = false
      try { validate({ mode: 'turbo' }) } catch { threw = true }
      ok('C4 mode 非法值被拒绝', threw)
    } catch (error) {
      ok('C schema 回归可执行', false, String(error).slice(0, 200))
    }
  }
} else {
  skip1('B 本地标题规则/M3/schema 回归', '未安装 @deepseek-ai/schemastery；npm install 后重跑即全覆盖')
}

console.log(`\nsmoke: ${pass} pass, ${fail} fail, ${skip} skipped`)
process.exit(fail > 0 ? 1 : 0)
