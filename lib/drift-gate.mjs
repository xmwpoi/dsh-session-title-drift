// P3-2 主题漂移门控（纯 JS，零依赖，不 import 任何宿主包）
// 用法：
//   import { evaluateDrift, shouldEvaluate, defaultOptions } from './p3-2-drift-gate.mjs'
//   const r = evaluateDrift(currentTitle, windowMessages)
//   if (r.drift) await refresh()  // 集成点：命中才改写标题（冷却/上限/熔断护栏由 P4-2 串行加）
//
// 算法 v4（技术路线：n-gram 双指标 + 锚点命中骤降门控）
// ─────────────────────────────────────────────────────────
// 1. 分词：CJK 连续段切 2-gram（双侧均为功能字的 gram 剔除）；拉丁段切小写词
//    （连字符/点/下划线拆分，如 dsh-approval-center → dsh/approval/center；去停用词）。
// 2. 锚点 A = tokenize(currentTitle)。消息 m 对空间 s 的命中数 hits_s(m) = |A_s ∩ m_s|。
//    锚定消息：hits_s(m) >= minHits_s，minHits_s = max(1, ceil(anchorFrac * |A_s|)) ——
//    锚点越丰富，要求复现的词汇越多，压低偶然共现。
// 3. 窗口净化：剔除操作型/委派样板消息（ignorePatterns）与过短消息（minMsgChars），
//    取最近 windowSize 条「实质性消息」；不足 minMessages 条 → 不评估（gated）。
// 4. 窗口二分：tail = 最后 tailCount 条实质性消息（当前话题），older = 其余（近期背景）。
// 5. 每个指标空间 s ∈ {cjk, latin} 独立投票：
//        vote_s = 1  当且仅当  aNew_s <= aNewTol（尾部至多 aNewTol 条锚定消息——容忍正在
//                              滑出窗口的残留回声）
//                           且 aOld_s >= olderMin（较旧部分锚定消息成簇，≥olderMin 条）
//    漂移信号 = 「锚点复现在窗口较旧部分成簇、在尾部骤降（归零/近零）」。
// 6. 双指标合成：score = Σ(w_s·vote_s)/Σ(w_s)（A_s 为空的空间跳过并重新归一化）。
//    drift ⇔ score >= trigger（trigger=0.25 ⇒ 任一空间投票即命中；两空间同时命中 score=1）。
// 7. 为什么同实体换子任务不触发（c6b1eee2 实测）：其锚定消息全程零散——短操作消息被
//    minMsgChars 滤除，余下消息对锚点（首消息）的命中数达不到 minHits（cap=3），aOld 永远
//    < olderMin → 不投票；而真漂移（水杯→保温水壶）在边界前 older 锚定密集、边界后 tail
//    归零，形成骤降。
// 8. 触发即 drift=true。冷却/上限/熔断护栏不在本模块（P4-2 串行加）。
//
// 参数为 p3-2-replay.mjs 离线回放扫描选定，详见 handoff-proposals/p3-2-drift-gate-report.md。

export const defaultOptions = {
  windowSize: 6,        // W：参与评估的实质性消息条数
  minMessages: 4,       // 实质性消息少于该数不评估（且需 older/tail 各有内容）
  tailCount: 3,         // 窗口尾部多少条构成「当前话题」
  olderMin: 2,          // older 中锚定消息须 >= 该数才算「成簇复现」
  aNewTol: 1,           // tail 中允许的锚定消息数上限（容忍滑出中的残留回声）
  anchorFrac: 0.06,     // minHits = clamp(ceil(anchorFrac * |A_s|), 1, maxHits)
  maxHits: 3,           // minHits 上限（长锚点不无限抬高门槛）
  everyK: 4,            // K：按消息计数取模触发评估（count % K === 0）
  wCjk: 0.7,            // CJK 2-gram 指标权重
  wLatin: 0.3,          // 拉丁词指标权重
  trigger: 0.25,        // score 触发阈值（0.25 ⇒ 任一空间投票即命中）
  minMsgChars: 12,      // 短于此的消息视为操作型短消息，剔出窗口
  maxCharsPerMsg: 1200, // 每条消息参与统计的最大字符数（防长文填充淹没统计）
  ignorePatterns: [     // 命中即整条剔除出窗口（委派样板/纯操作短消息）
    /^\s*(继续|继续任务|继续吧|go on|continue)[\s。.!！?？]*$/i,
    /your parent agent id is/i,       // 委派提示词样板（英文结构化，污染 2-gram 统计）
    /^\s*并行子代理进行\s*$/,
    /^\s*(已重启|已手动重启|重新提权|ok|好的|确认结果)[\s。.!！]*$/i,
  ],
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/g
const LATIN_RE = /[a-z0-9][a-z0-9+._-]*/g
const LATIN_STOP = new Set(('the a an and or of to in on for with is are was were be been it its this that these those ' +
  'please you your my me i we our do does did done can could should would will just as at by from into if then than so ' +
  'not no yes ok make made use used using help need want let get got have has had ps c users downloads appdata ' +
  '新的 一个 我们 你们').split(' '))
// 功能字表：双侧均为功能字的 CJK 2-gram 不参与统计（一个/这个/怎么/还是…）
const CJK_FN = new Set(('的了是在我你他她它这那有个也不就都还又和与或但所以说要吗呢吧啊嘛哪么着过很太最再更每另' +
  '把被给让上下里外前后来去想会用能可以已经还是就是不是因为如果现在然后其他问题时候东西怎么这个那个自己我们你们他们').split(''))

/** 文本 → { cjk:Set<2-gram>, latin:Set<word> }；超长截断；CJK gram 需含 ≥1 个非功能字 */
export function tokenize(text, maxLen = defaultOptions.maxCharsPerMsg) {
  const out = { cjk: new Set(), latin: new Set() }
  if (typeof text !== 'string') return out
  const s = text.slice(0, maxLen)
  for (const seg of s.match(CJK_RE) ?? []) {
    if (seg.length === 1) { if (!CJK_FN.has(seg)) out.cjk.add(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2)
      if (CJK_FN.has(g[0]) && CJK_FN.has(g[1])) continue
      out.cjk.add(g)
    }
  }
  for (const raw of s.toLowerCase().match(LATIN_RE) ?? []) {
    // dsh-approval-center → dsh / approval / center（连字符复合词拆分）
    for (const w of raw.split(/[-._+]/)) {
      if (w.length >= 2 && !LATIN_STOP.has(w)) out.latin.add(w)
    }
  }
  return out
}

/** 消息数组 → 归一化为文本数组。元素可为 string / {text} / {content:[{type:'text',text}]} */
export function normalizeMessages(msgs) {
  const out = []
  for (const m of msgs ?? []) {
    let t = ''
    if (typeof m === 'string') t = m
    else if (m && typeof m.text === 'string') t = m.text
    else if (m && Array.isArray(m.content)) t = m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    else if (m && typeof m.message === 'string') t = m.message
    t = (t ?? '').trim()
    if (t) out.push(t)
  }
  return out
}

/**
 * 核心纯函数：评估最近窗口消息是否漂移出了当前标题的主题。
 * @param {string} currentTitle 当前会话标题
 * @param {Array<string|{text}|{content}>} windowMessages 最近消息（旧→新；末尾视为当前话题）
 * @param {object} [options] 见 defaultOptions
 * @returns {{drift:boolean, score:number, voteCjk:number, voteLatin:number,
 *          aOldCjk:number, aNewCjk:number, aOldLatin:number, aNewLatin:number,
 *          minHitsCjk:number, minHitsLatin:number, anchorCjk:number, anchorLatin:number,
 *          nSub:number, windowUsed:number, reason:string, gated:boolean}}
 *   gated=true 表示消息不足等原因未评估（不算触发也不算失误）。
 */
export function evaluateDrift(currentTitle, windowMessages, options = {}) {
  const o = { ...defaultOptions, ...options }
  const base = { drift: false, score: 0, voteCjk: 0, voteLatin: 0, aOldCjk: 0, aNewCjk: 0,
    aOldLatin: 0, aNewLatin: 0, minHitsCjk: 0, minHitsLatin: 0, anchorCjk: 0, anchorLatin: 0,
    nSub: 0, windowUsed: 0, reason: '', gated: false, rewriteStart: null }
  // 净化：剔除样板消息与过短消息
  const entries = (windowMessages ?? [])
    .map((message, index) => ({ text: normalizeMessages([message])[0] ?? '', index }))
    .filter(({ text }) => !o.ignorePatterns.some((p) => p.test(text)))
    .filter(({ text }) => text.length >= o.minMsgChars)
    .slice(-o.windowSize)
  const subs = entries.map(({ text }) => text)
  if (subs.length < o.minMessages) {
    return { ...base, gated: true, reason: `substantive ${subs.length} < minMessages ${o.minMessages}` }
  }
  const cut = Math.max(1, subs.length - o.tailCount)
  const older = subs.slice(0, cut)
  const tail = subs.slice(cut)
  if (!older.length || !tail.length) {
    return { ...base, nSub: subs.length, gated: true, reason: 'older/tail empty' }
  }
  const A = tokenize(currentTitle ?? '', o.maxCharsPerMsg)
  const olderTok = older.map((t) => tokenize(t, o.maxCharsPerMsg))
  const tailTok = tail.map((t) => tokenize(t, o.maxCharsPerMsg))

  const spaces = []
  for (const [key, w, av] of [['cjk', o.wCjk, A.cjk], ['latin', o.wLatin, A.latin]]) {
    if (av.size === 0) continue
    const minHits = Math.min(Math.max(1, Math.ceil(o.anchorFrac * av.size)), Math.max(1, o.maxHits))
    const hits = (toks) => toks.reduce((a, t) => a + ([...av].filter((g) => t[key].has(g)).length >= minHits ? 1 : 0), 0)
    const aOld = hits(olderTok)
    const aNew = hits(tailTok)
    const vote = aNew <= o.aNewTol && aOld >= o.olderMin ? 1 : 0
    spaces.push({ key, w, vote, aOld, aNew, minHits, size: av.size })
  }
  if (!spaces.length) {
    return { ...base, nSub: subs.length, windowUsed: subs.length, gated: true, reason: 'title has no scoreable tokens' }
  }
  const wsum = spaces.reduce((a, s) => a + s.w, 0)
  const score = wsum > 0 ? spaces.reduce((a, s) => a + s.w * s.vote, 0) / wsum : 0
  const byKey = Object.fromEntries(spaces.map((s) => [s.key, s]))
  const drift = score >= o.trigger
  // Only the new-topic suffix of the voting tail is used for a drift rewrite.
  // Keep original request indices: generation needs full text and ordered seqs.
  let rewriteStart = null
  if (drift) {
    // ponytail: reserve the tolerated echo slots; keyword votes cannot identify
    // every old-topic paraphrase. Semantic segmentation needs separate evidence.
    let start = Math.min(Math.floor(o.aNewTol), tail.length)
    for (let i = 0; i < tailTok.length; i++) {
      const anchored = spaces.some(({ key, vote, minHits }) => vote &&
        [...A[key]].filter((g) => tailTok[i][key].has(g)).length >= minHits)
      if (anchored) start = Math.max(start, i + 1)
    }
    if (start < tail.length) rewriteStart = entries[older.length + start].index
  }
  const voters = spaces.filter((s) => s.vote).map((s) => s.key).join('+') || 'none'
  const reason = `score=${score.toFixed(2)} voters=${voters} ` +
    spaces.map((s) => `${s.key}[aOld=${s.aOld}/${older.length} aNew=${s.aNew}/${tail.length} minHits=${s.minHits}]`).join(' ')
  return {
    drift,
    score,
    voteCjk: byKey.cjk?.vote ?? 0,
    voteLatin: byKey.latin?.vote ?? 0,
    aOldCjk: byKey.cjk?.aOld ?? 0,
    aNewCjk: byKey.cjk?.aNew ?? 0,
    aOldLatin: byKey.latin?.aOld ?? 0,
    aNewLatin: byKey.latin?.aNew ?? 0,
    minHitsCjk: byKey.cjk?.minHits ?? 0,
    minHitsLatin: byKey.latin?.minHits ?? 0,
    anchorCjk: byKey.cjk?.size ?? 0,
    anchorLatin: byKey.latin?.size ?? 0,
    nSub: subs.length,
    windowUsed: subs.length,
    reason,
    gated: false,
    rewriteStart,
  }
}

/** 消息计数是否到达评估点（watcher 每收一条消息调用一次） */
export function shouldEvaluate(count, everyK = defaultOptions.everyK) {
  return Number.isFinite(count) && count > 0 && Number.isInteger(everyK) && everyK > 0 && count % everyK === 0
}
