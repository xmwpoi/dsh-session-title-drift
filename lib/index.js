// dsh-session-title-drift —— host 侧会话标题插件
// 当前阶段：M1（provider + 本地首标题）+ M2（watcher 补标题）+ M3（LLM 改写：质量兜底 + G3 管道）
// + M4（完整标题的候选门 + 单次语义确认，见 lib/semantic-drift.mjs）。
//
// 运行时约束（全部来自本机源码核实）：
// - 宿主 @deepseek-ai/* 包在 profile 下只能 import type；本文件唯一的运行时外部导入是
//   @deepseek-ai/schemastery（经本包自带 node_modules junction 解析，approval-center 同款模式）。
// - SessionTitleProviderId 是恒等函数，直接用字符串 'drift' 即可。
// - 服务只允许注册一个 provider；启用本插件前必须禁用内置 session-title-llm。
import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve as pathResolve } from 'node:path'
import { evaluateDrift } from './drift-gate.mjs'
import { evaluateDriftCandidate, confirmDrift } from './semantic-drift.mjs'

export const name = 'dsh-session-title-drift'
// M3：generateSessionTitleWithLlm 内部调 ctx.llm.stream（dsh-session-title-llm/lib/index.js:226），
// 官方先例 first-prompt-llm 的 inject 同样含 'llm'（其 lib/index.js:6-10）。
export const inject = ['sessionTitle', 'llm']

export const Config = z.object({
  // 总开关（false 时 watcher 不动作；provider 仍在注册位上，自动首标题仍走本地规则）
  // P0c 修复（2026-09-27）：不得使用 .volatile()——fork schemastery 的
  // ~standard.validate 会把 volatile 字段包成 createVolatile 容器（序列化为 {}），
  // cordis resolveConfig 据此下发，导致 apply 永远收到全 {} config（78B 标题根因）。
  enabled: z.boolean().default(true),
  // D3：是否给委派（subagent）会话补标题，默认开
  delegatedTitles: z.boolean().default(true),
  // D4：同一会话两次主动 refresh() 的最小间隔
  cooldownMs: z.number().min(0).default(120_000),
  // 本地首标题的双上限：CJK 字符数 / 拉丁词数 / UTF-8 字节数（与服务 maxTitleBytes=80 对齐）
  localTitleMaxCjk: z.number().min(2).max(40).default(10),
  localTitleMaxWords: z.number().min(1).max(20).default(5),
  maxTitleBytes: z.number().min(16).max(240).default(80),
  // 首问规范化后短于该字符数时不产出本地标题（保留服务的回退标题）
  minFirstPromptChars: z.number().min(0).max(50).default(4),
  // ---- M3：LLM 改写（质量兜底 / G3 漂移）。mode='local' 时全部 LLM 路径停用 ----
  // P0c 铁律：任何字段不得链 .volatile()（理由见 §7，此处不赘）
  mode: z.union([z.const('local'), z.const('hybrid')]).default('hybrid'),
  // 已废弃（Phase 2）：K 节拍被证明结构性踩空（真实触发点 i=7 质数，B2 审计 W5）——
  // 运行路径不再读取本字段，保留仅为 p0d 既有断言兼容（只加不删）。
  driftCheckEvery: z.number().min(1).max(100).default(6),
  maxLlmUpdatesPerSession: z.number().min(0).max(20).default(3),
  llmMaxConsecutiveFailures: z.number().min(1).max(10).default(3),
  llmTargetWords: z.number().step(1).min(1).default(5),
  llmTargetCjkCharacters: z.number().step(1).min(1).default(10),
  llmMaxInputBytes: z.number().step(1).min(1024).max(1_048_576).default(32768),
  llmMaxOutputTokens: z.number().step(1).min(1).max(4096).default(64),
  llmTimeoutMs: z.number().step(1).min(1).max(2147483647).default(20_000),
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  cliNodeModules: z.string().default(''),
  // ---- M4（Phase 2）：漂移门阈值组（p3-2 报告 §5 推荐值；显式传入 evaluateDrift，
  // 禁 defaultOptions/everyK 路径——模块默认 olderMin=2/frac=0.06/maxHits=3 已被
  // 回放证明不安全 realFP=8）。全部普通字段，禁 .volatile() ----
  driftEnabled: z.boolean().default(true),
  driftCooldownMessages: z.number().min(1).max(50).default(4),
  driftWindowSize: z.number().min(3).max(50).default(6),
  driftMinMessages: z.number().min(2).max(50).default(4),
  driftTailCount: z.number().min(1).max(20).default(3),
  driftOlderMin: z.number().min(1).max(20).default(3),
  driftANewTol: z.number().min(0).max(20).default(1),
  driftAnchorFrac: z.number().min(0.01).max(1).default(0.08),
  driftMaxHits: z.number().min(1).max(20).default(2),
  driftWCjk: z.number().min(0).max(1).default(0.7),
  driftWLatin: z.number().min(0).max(1).default(0.3),
  driftTrigger: z.number().min(0).max(1).default(0.25),
  driftMinMsgChars: z.number().min(0).max(1000).default(12),
  driftMaxCharsPerMsg: z.number().min(100).max(100000).default(1200),
})

// ---------------------------------------------------------------------------
// M3：官方共享 LLM 标题生成（质量兜底 / G3 漂移改写）
// 设计依据：p2-1-llm-resolution.md（方案 A）+ p2-2-probe-anchor.mjs 实测。
// 运行时解析：宿主 @deepseek-ai/* 包在 profile 下只能 import type；
// 这里用「动态 import + 三级锚点链」在运行时拿到官方共享标题 LLM。
// 仅依赖 node: 内置模块，零新增依赖。
// ---------------------------------------------------------------------------

const TITLE_LLM_SPEC = '@deepseek-ai/dsh-session-title-llm'
const NODE_MODULES_SEG = '/node_modules/'

/** 由宿主入口切出其 node_modules 根；入口不可用时返回 undefined。 */
function nodeModulesFromEntry(entry) {
  const normalized = String(entry ?? '').replace(/\\/g, '/')
  const at = normalized.indexOf(NODE_MODULES_SEG)
  if (at < 0) return undefined
  return normalized.slice(0, at) + NODE_MODULES_SEG.slice(0, NODE_MODULES_SEG.length - 1)
}

/** 去重后的解析锚点候选（锚点文件无需真实存在——探针 ③ 已证）。 */
function resolutionAnchors(cliNodeModules) {
  const anchors = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return
    seen.add(value)
    anchors.push(value)
  }
  // ② 宿主入口本身：直接继承宿主解析位置（installation-first，探针 ②b 实测成功）。
  // Phase 2 加固（17- §2.2）：先 path.resolve——相对启动方式下相对锚点会让
  // createRequire 抛 ERR_INVALID_ARG_VALUE、锚点③ 推导失效（M3-① 诊断事实 4）。
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) push(pathResolve(process.argv[1]))
  // ④ 显式配置覆盖（排障 / 非常规启动方式，探针 ③ 实测成功）
  if (typeof cliNodeModules === 'string' && cliNodeModules.length > 0) {
    push(join(cliNodeModules, '__dsh_anchor__.cjs'))
  }
  // ③ 由宿主入口推导的 node_modules（② 的冗余保险）
  const derived = nodeModulesFromEntry(process.argv[1])
  if (derived !== undefined) push(join(derived, '__dsh_anchor__.cjs'))
  return anchors
}

/**
 * 使用同一解析锚点加载宿主既有模块（共享首标题 LLM、流组装器及超时）。
 * 每级失败只记 debug；全部失败抛错，由调用方 fail-open 到本地规则。
 * 不用 require() 加载（Node < 22.12 会 ERR_REQUIRE_ESM）；不用
 * import.meta.resolve 两参形式（Node 24 实测不可用，探针"附"）。
 */
async function loadHostModule(specifier, options = {}) {
  const { logger, cliNodeModules } = options
  // ① 裸 specifier：命中即插件自带 junction 生效（部署期优化，非先决条件）
  try {
    return await import(specifier)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    logger?.debug?.(`[title-drift] bare import miss: ${String(error)}`)
  }
  for (const anchor of resolutionAnchors(cliNodeModules)) {
    try {
      const entry = createRequire(anchor).resolve(specifier)
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      logger?.debug?.(`[title-drift] anchor ${anchor} miss: ${String(error)}`)
    }
  }
  throw new Error(`title-drift: cannot resolve ${specifier}`)
}

// 与宿主 dsh-session-title-llm/lib/index.js:158 完全一致的前缀
//（p2-2-probe-framed.mjs 从宿主源码提取后逐字节比对验证）
const FRAME_PREFIX = 'Generate the session title from this JSON array of human messages:\n'
const FRAME_PREFIX_BYTES = Buffer.byteLength(FRAME_PREFIX + '[', 'utf8')
const FRAME_BRACKET_BYTES = Buffer.byteLength(']', 'utf8')

/** 与官方 frameMessages + 字节预算（宿主 :193-195）同口径：对 {seq,text} 数组整体计字节。 */
function framedBytes(messages) {
  return Buffer.byteLength(FRAME_PREFIX + JSON.stringify(messages), 'utf8')
}

// 增量口径：framed = PREFIX + '[' + 元素 JSON.join(',') + ']'
//（p2-2-probe-framed 断言：增量口径 == 对整组直接 stringify，全样本 PASS）
function framedBytesFrom(messages, start) {
  let total = FRAME_PREFIX_BYTES + FRAME_BRACKET_BYTES
  for (let i = start; i < messages.length; i++) {
    total += Buffer.byteLength(JSON.stringify(messages[i]), 'utf8')
    if (i > start) total += 1 // 逗号
  }
  return total
}

/**
 * 取最长的、framed 字节 ≤ maxInputBytes 的连续消息后缀（seq 升序保持，
 * 满足服务对 messageSeqs"升序唯一非空子序列"的校验，宿主 dsh-session-title:489-499）。
 * 官方超预算是抛错不截断（:195），因此必须在调用前把输入压进预算；
 * 连末条单独都超限时返回 []，调用方放弃本次 LLM、保留当前标题（fail-open）。
 * 增量法避免长会话 O(n²) 整体 stringify（数千条消息时差 3 个数量级）。
 */
function selectWindow(messages, maxInputBytes) {
  let start = 0
  while (start < messages.length && framedBytesFrom(messages, start) > maxInputBytes) start += 1
  return messages.slice(start)
}

/**
 * 构造官方白名单配置。resolveSessionTitleLlmConfig 对未知键抛错（:107）且
 * provider/model 必须成对（:114-116）⇒ 绝不透传插件 cfg，只显式造五字段；
 * 半配 provider/model 视为未配并告警（路由继承会话主请求，探针 S4d 零配置成立）。
 */
function llmConfigOf(cfg, logger) {
  const conf = {
    targetWords: cfg.llmTargetWords,
    targetCjkCharacters: cfg.llmTargetCjkCharacters,
    maxInputBytes: cfg.llmMaxInputBytes,
    maxOutputTokens: cfg.llmMaxOutputTokens,
    timeoutMs: cfg.llmTimeoutMs,
  }
  const hasProvider = cfg.llmProvider !== ''
  const hasModel = cfg.llmModel !== ''
  if (hasProvider && hasModel) {
    conf.provider = cfg.llmProvider
    conf.model = cfg.llmModel
  } else if (hasProvider !== hasModel && logger) {
    logger.warn('[title-drift] llmProvider/llmModel 必须成对配置，已忽略该覆盖（继承会话路由）')
  }
  return conf
}

// ---------------------------------------------------------------------------
// 本地标题规则（技术方案 §7.5）
// ---------------------------------------------------------------------------

// 前缀助词：连续剥掉一轮（"请问帮我…" 这类叠加也能剥）
const PREFIX_RE =
  /^(?:\s*(?:请问|请帮我|请|帮我|麻烦你?|能不能|可不可以|可以的话|我想知道|我想|我要|我需要|如何|怎么|怎样|你好|您好|hi|hello|hey|please|pls)[，,、。!！?？\s]*)+/i

const SENTENCE_END_RE = /[。！？!?；;\n]/

const PAIRED = [
  ['《', '》'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
]

function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function stripPairedQuotes(s) {
  let changed = true
  while (changed && s.length >= 2) {
    changed = false
    for (const [l, r] of PAIRED) {
      if (s.startsWith(l) && s.endsWith(r)) {
        s = s.slice(l.length, s.length - r.length).trim()
        changed = true
      }
    }
  }
  return s
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/
const WORD_RE = /[a-z0-9_]/i

// 码点级双上限裁剪：CJK 计 1 字、拉丁连续段计 1 词、UTF-8 字节硬顶；任一超限即停
function truncateDual(text, maxCjk, maxWords, maxBytes) {
  let bytes = 0
  let cjk = 0
  let words = 0
  let inWord = false
  let out = ''
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8')
    const isCjk = CJK_RE.test(ch)
    const isWord = WORD_RE.test(ch)
    if (isCjk && cjk + 1 > maxCjk) break
    if (isWord && !inWord && words + 1 > maxWords) break
    if (bytes + b > maxBytes) break
    out += ch
    bytes += b
    if (isCjk) cjk += 1
    if (isWord) {
      if (!inWord) {
        words += 1
        inWord = true
      }
    } else {
      inWord = false
    }
  }
  return out.trimEnd()
}

// 返回 undefined 表示"本地规则放弃"（reject：规范化后不足 minFirstPromptChars）；
// 返回 { title, truncated }：truncated=true 表示触达 CJK/词数/字节任一上限（机械截取）。
// M3 质量门用 truncated 区分两类"质量不足"：只有机械截取才值得花 LLM（T2：短首问零 API）。
function localTitleCore(text, cfg) {
  let s = normalizeWhitespace(text)
  s = s.replace(PREFIX_RE, '').trim()
  if (s.length === 0) return undefined
  const m = SENTENCE_END_RE.exec(s)
  if (m && m.index > 0) s = s.slice(0, m.index)
  s = stripPairedQuotes(s.trim())
  const pre = s
  const title = truncateDual(s, cfg.localTitleMaxCjk, cfg.localTitleMaxWords, cfg.maxTitleBytes)
  if ([...title].length < cfg.minFirstPromptChars) return undefined
  return { title, truncated: title.length < pre.length }
}

// M1 原签名保留（m1_unit_test.mjs 的 __internals.localTitle 契约不变）
function localTitle(text, cfg) {
  return localTitleCore(text, cfg)?.title
}

// messageSeqs 必须是 request.messages 的升序唯一非空子序列；
// 继承来的 current.messageSeqs 可能不在其中（fork/继承场景），过滤后为空则退化为末条消息
function pickSeqs(current, messages) {
  const available = new Set(messages.map((m) => m.seq))
  const seqs = (current?.messageSeqs ?? []).filter((s) => available.has(s))
  if (seqs.length > 0) return seqs
  return [messages[messages.length - 1].seq]
}

// 复刻服务的合格消息判定（dsh-session-title/lib/index.js:90-98）
function isEligibleUserMessage(event) {
  if (event?.type !== 'user/message') return false
  if (event.data?.source?.kind !== 'user') return false
  const text = (event.data.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return normalizeWhitespace(text).length > 0
}

// G3 漂移谓词由 M4 的 evaluateDrift 接管（lib/drift-gate.mjs，Phase 2 合入）——
// 原 shouldRewrite 占位已作废（17- §1.1）。

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = config
  // 每会话状态：bootstrapped 只补一次、inFlight 串行、lastAt 冷却；
  // llmCount 计模型尝试（含否决/失败），不是成功改名数；llmBusy 串行保护所有入口。
  // M4 新增：window（合格消息滚动窗口，旧→新，末尾=当前话题）、driftSkip（命中后冷却 C 条）
  // U10 定案（p4-2 设计 §5）：state map 为进程内存态，实例重启即整体清零——接受，理由：
  // ① 标题是日志事件（session/title 已持久化于会话日志），清零不丢任何已产出标题；
  // ② 速率上界在重启后自然闭合（冷却/上限/熔断均从零起算，无放大风险）；
  // ③ 与「不做会话投影缓存」的先例一致。
  // 规模软顶：每会话状态 ~1KB 级（window ≤ windowSize+8 条文本），万级会话 ~10MB——
  // 不做 LRU/TTL；session/disposed 清理 + 重启清零已覆盖回收路径。
  const state = new Map()
  const stateFor = (id) => {
    let st = state.get(id)
    if (st === undefined) {
      st = { bootstrapped: false, inFlight: false, lastAt: 0, msgCount: 0, llmCount: 0, llmFailures: 0,
        window: [], driftSkip: 0, llmBusy: false }
      state.set(id, st)
    }
    return st
  }

  // Phase 2（17- §2.1）可观测性升级：cordis ctx.logger.warn 在 web 模式不落 stdout
  //（M3-① 诊断的核心盲区）——关键告警双写：console.error（→ dsh-web-run.err.log）+ logger。
  const warnDual = (msg) => {
    try { console.error('[title-drift] ' + msg) } catch {}
    ctx.logger.warn(msg)
  }

  // M4：evaluateDrift 显式阈值（禁 defaultOptions 路径——模块默认 olderMin=2/frac=0.06/
  // maxHits=3 已被回放证明不安全 realFP=8）。来源 = Config 阈值组（p3-2 报告 §5 推荐值）。
  const driftOptions = () => ({
    windowSize: cfg.driftWindowSize,
    minMessages: cfg.driftMinMessages,
    tailCount: cfg.driftTailCount,
    olderMin: cfg.driftOlderMin,
    aNewTol: cfg.driftANewTol,
    anchorFrac: cfg.driftAnchorFrac,
    maxHits: cfg.driftMaxHits,
    wCjk: cfg.driftWCjk,
    wLatin: cfg.driftWLatin,
    trigger: cfg.driftTrigger,
    minMsgChars: cfg.driftMinMsgChars,
    maxCharsPerMsg: cfg.driftMaxCharsPerMsg,
  })

  // v2.4（F5）：缓存与失败记账移入 apply 闭包——ESM 模块缓存会让模块级状态
  // 跨插件 reload 存活，配置热更后旧 LLM config 一直用到宿主重启。闭包随 fiber 重建。
  // 只缓存成功结果（{ module, config }）：加载/校验失败不永久记忆，
  // 带 60s 退避——宿主升级/重启后可自愈，又不至于每次 generate 都刷 warn。
  let llmCache
  let llmLastFailureAt = 0

  async function llmOrUndefined(ctx_, cfg_) {
    if (cfg_.mode !== 'hybrid') return null
    if (llmCache !== undefined) return llmCache
    if (Date.now() - llmLastFailureAt < 60_000) return null
    try {
      const module = await loadHostModule(TITLE_LLM_SPEC, { logger: ctx_.logger, cliNodeModules: cfg_.cliNodeModules })
      // 加载期主动校验（等价官方 registerSessionTitleLlmProvider:128 的注册期校验时机）：
      // 键白名单/正整数/成对约束的错误在这里暴露，而不是静默到某次 generate。
      const llmConfig = module.resolveSessionTitleLlmConfig(llmConfigOf(cfg_, ctx_.logger))
      llmCache = { module, config: llmConfig }
      ctx_.logger.info('[title-drift] shared title LLM resolved (M3)')
    } catch (error) {
      llmLastFailureAt = Date.now()
      warnDual(`LLM 不可用，降级为本地规则: ${String(error)}`)
      return null
    }
    return llmCache
  }

  // 熔断（st.llmFailures）清零的三个时机（p4-2 §4 定案）：
  // ① 成功即清零——callTitleLlm 内 `st.llmFailures = 0`（任一次成功都重置计数）；
  // ② 会话 dispose——session/disposed 处理器删除 state 项，llmFailures 随之清除；
  // ③ 实例重启——U10：state map 进程内存态，整体清零。
  // 连续失败 ≥ cfg.llmMaxConsecutiveFailures ⇒ 本会话降级本地（warnDual 可见），
  // 直到 ①/②/③ 任一发生；不设跨会话熔断（M5 若需再议）。
  // 首标题走官方共享函数；漂移走单次结构化语义确认。undefined 保留原标题。
  // 调用方落回 M1/M2 行为——generate() 永不因 LLM 问题抛错（服务抛错=记 warning 不重试，
  // dsh-session-title/lib/index.js:439-442，故降级必须自己记账）。
  let semanticTools
  async function callTitleLlm(req, messages, st, current) {
    if (st.llmBusy || st.llmCount >= cfg.maxLlmUpdatesPerSession ||
        Date.now() - st.lastAt < cfg.cooldownMs || st.llmFailures >= cfg.llmMaxConsecutiveFailures) return undefined
    st.llmBusy = true
    try {
      const llm = await llmOrUndefined(ctx, cfg)
      if (llm === null) return undefined
      const selected = selectWindow(messages, llm.config.maxInputBytes)
      if (selected.length === 0) {
        warnDual('单条消息超出 llmMaxInputBytes，放弃本次 LLM 改写（保留当前标题）')
        return undefined
      }
      if (current && !semanticTools) {
        const options = {logger:ctx.logger, cliNodeModules:cfg.cliNodeModules}
        const [stream, time] = await Promise.all([loadHostModule('@deepseek-ai/dsh-llm', options), loadHostModule('@deepseek-ai/dsh-timeout', options)])
        semanticTools = {BlockAssembler:stream.BlockAssembler, createUserMessage:stream.createUserMessage, deadline:time.deadline}
      }
      // Count attempts including semantic vetoes and failures, not only rewrites.
      // This same budget/lock/cooldown protects watcher and direct provider calls.
      st.llmCount += 1
      st.lastAt = Date.now()
      if (current) {
        const newSeqs = new Set(selected.map(m=>m.seq))
        const backgroundSeqs = new Set([...(current.messageSeqs ?? []), ...req.messages.slice(-cfg.driftWindowSize).map(m=>m.seq)])
        const background = req.messages.filter(m=>backgroundSeqs.has(m.seq) && !newSeqs.has(m.seq))
        const decision = await confirmDrift(ctx, llm.config, req, current, selected, background, semanticTools, cfg.maxTitleBytes)
        if (!decision) return undefined
        st.llmFailures = 0
        ctx.logger.info(`[title-drift] semantic decision changed=${decision.topicChanged} session=${req.session.id}`)
        if (!decision.topicChanged) return undefined
        return {title:decision.title, messageSeqs:decision.messageSeqs, model:decision.model}
      }
      // titleProvider 直接传 'drift'：SessionTitleProviderId 是恒等函数（P2-1 探针 A8）
      const result = await llm.module.generateSessionTitleWithLlm(ctx, llm.config, req, selected, 'drift')
      st.llmFailures = 0
      return result // { title, messageSeqs, model }——messageSeqs 是 req.messages 的连续切片，必过服务校验
    } catch (error) {
      st.llmFailures += 1
      warnDual(`LLM 改写失败（连续第 ${st.llmFailures} 次），保留当前标题: ${String(error)}`)
      return undefined
    } finally {
      st.llmBusy = false
      if (st.lastAt > 0) st.lastAt = Date.now()
    }
  }

  // ① 注册唯一 provider（要求内置 session-title-llm 已被 disabled）
  try {
    ctx.sessionTitle.register({
      id: 'drift',
      automatic: 'first-prompt',
      async generate(req) {
        const messages = req.messages
        const current = ctx.sessionTitle.get(req.session)

        // 首标题：当前无标题，或仍是服务的机械截取（fallback）→ 本地规则，零 API
        // M3 起：截取时 hybrid 下走 LLM 兜底（'零 API'不再无条件成立）
        if (current === undefined || current.source.kind === 'fallback') {
          if (messages.length === 0) {
            // 出参契约无法满足（messageSeqs 必须非空且取自 request.messages）；
            // 抛错由服务记 warning 并保留原标题，这是唯一合法表达
            throw new Error('title-drift: no eligible messages to title from')
          }
          const core = localTitleCore(messages[0].text, cfg)
          if (core !== undefined && !core.truncated) {
            return { title: core.title, messageSeqs: [messages[0].seq] }
          }
          // M3 质量兜底：仅"机械截取"（truncated，超长首问）⇒ hybrid 下走官方 LLM 改写
          //（T1 语义：产出 session/title-llm-request，标题为改写非截取）。
          // "过短 reject"（如"你好"）不调 LLM（T2 语义：title-llm-request 计数=0）。
          if (core !== undefined && cfg.mode === 'hybrid') {
            const st = stateFor(req.session.id)
            if (st.llmCount < cfg.maxLlmUpdatesPerSession) {
              const rewritten = await callTitleLlm(req, messages, st)
              if (rewritten !== undefined) return rewritten
            }
          }
          // reject（core===undefined）→ 保留服务回退；truncated 但 LLM 不可用/失败/关停
          // → 保留本地截取标题（= M1 行为，T3/T4 fail-open 契约）
          if (core !== undefined) {
            return { title: core.title, messageSeqs: [messages[0].seq] }
          }
          if (current !== undefined) {
            return { title: current.title, messageSeqs: pickSeqs(current, messages) }
          }
          // current 也缺失（理论上服务总会先写 fallback；兜底防抛错）
          const emergency = truncateDual(normalizeWhitespace(messages[0].text), 10, 5, cfg.maxTitleBytes)
          return { title: emergency.length > 0 ? emergency : '会话', messageSeqs: [messages[0].seq] }
        }

        // 被显式钉住（pinned）的标题永不覆盖（T4：与 watcher 侧同口径；钉住来源
        // 共 5 类路径均经 rename() 写 kind:'user'，p4-1 §4.1）
        if (current.source.kind === 'user') {
          return { title: current.title, messageSeqs: pickSeqs(current, messages) }
        }
        // watcher 仅安排候选检查；provider 对最新消息同口径复查，语义确认才允许改名。
        if (cfg.enabled && cfg.mode === 'hybrid' && cfg.driftEnabled === true &&
            !req.session.header?.isSeeded && req.session.header?.parentSession === undefined) {
          const st = stateFor(req.session.id)
          const verdict = evaluateDriftCandidate(current.title, messages, driftOptions())
          if (verdict.drift && verdict.rewriteStart !== null && st.llmCount < cfg.maxLlmUpdatesPerSession) {
            const rewritten = await callTitleLlm(req, messages.slice(verdict.rewriteStart), st, current)
            if (rewritten !== undefined) return rewritten
          }
        }
        // 无漂移 ⇒ 原样返回（幂等，不换词、不调 API）
        return { title: current.title, messageSeqs: pickSeqs(current, messages),
          ...(current.source.model ? {model:current.source.model}: {}) }
      },
    })
  } catch (error) {
    ctx.logger.error(
      `[title-drift] register 失败（内置 session-title-llm 是否已禁用？）: ${String(error)}`,
    )
    throw error
  }

  // ② watcher：标题缺失或仍是 fallback 的会话，主动补一次 refresh()
  //    覆盖 G1（委派会话被服务的 parentSession 条件结构性排除）与
  //    G2 残余（root 首问静默失败只剩 fallback）。每会话只补一次 + G3 漂移评估（M4）。
  ctx.on('session/event', (session, event) => {
    if (!cfg.enabled) return
    if (!isEligibleUserMessage(event)) return
    if (session.header?.isSeeded === true) return // fork：继承父会话标题，按官方语义不插手

    const st = stateFor(session.id)
    if (st.inFlight) return
    st.msgCount += 1 // 与 titleInput 投影同口径自数（不做跨进程持久化，U10）

    const isDelegated = session.header?.parentSession !== undefined
    // F3（get() 下推）：仅 bootstrap 未完成、或到达漂移评估点时才付出 O(n) 快照 fold 成本
    const needBootstrap = !st.bootstrapped
    // M4（Phase 2）：每条实质性消息评估 + 命中冷却 C=4（17- §1.2：废弃 K 节拍——
    // 真实触发点 i=7 质数，固定 K 结构性踩空）。委派会话不做 G3（P3-1 结论 3）。
    // 滚动窗口：driftGateOn 会话的每条合格消息都入窗（含冷却期——冷却只停评估，不停采样）。
    const driftGateOn = cfg.mode === 'hybrid' && cfg.driftEnabled === true && !isDelegated
    if (driftGateOn) {
      const msgText = (event.data?.content ?? [])
        .filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      st.window.push(msgText)
      if (st.window.length > cfg.driftWindowSize + 8) {
        st.window.splice(0, st.window.length - (cfg.driftWindowSize + 8))
      }
      if (st.driftSkip > 0) st.driftSkip -= 1
    }
    const needDriftEval = driftGateOn && st.driftSkip <= 0
    if (!needBootstrap && !needDriftEval) return

    const current = ctx.sessionTitle.get(session)
    // 最高优先级护栏：被显式钉住（pinned）的标题永不覆盖（覆盖 bootstrap 与 G3 两分支）。
    // T4/U8：钉住来源共 5 类路径（GUI/RPC 重命名、看板钉标题、webhook 建会话、fork 派生）
    // 全部经 SessionTitleService.rename() 写 kind:'user'（p4-1 §4.1）——命中即退出监护。
    if (current?.source?.kind === 'user') {
      state.delete(session.id)
      return
    }

    // G1/G2 bootstrap：标题缺失或仍是 fallback，只补一次（原 M2 逻辑，守卫移入本分支）
    if (current === undefined || current.source.kind === 'fallback') {
      if (st.bootstrapped) return
      if (isDelegated && !cfg.delegatedTitles) return
      if (Date.now() - st.lastAt < cfg.cooldownMs) return
      st.bootstrapped = true // 只补一次，失败也不纠缠
      st.inFlight = true
      void ctx.sessionTitle
        .refresh(session)
        .then(() => {
          st.lastAt = Date.now()
          ctx.logger.info(`[title-drift] bootstrap title (${isDelegated ? 'delegated' : 'fallback-repair'}) session=${session.id}`)
        })
        .catch((error) => {
          ctx.logger.warn(`[title-drift] bootstrap refresh failed session=${session.id}: ${String(error)}`)
        })
        .finally(() => {
          st.inFlight = false
        })
      return
    }

    // G3 候选评估：完整标题 + 单命中候选门；不把关键词命中当作语义换题。
    // 节流三重：命中冷却 C=4（条数级，命中即置 st.driftSkip）+ llmCount 上限 + 时间级 cooldownMs。
    const verdict = evaluateDriftCandidate(current.title, st.window, driftOptions())
    if (verdict.gated || !verdict.drift) return
    // 限频顺序（固化，p4-2 §4）：llmCount 硬顶先于 cooldownMs 时间级——硬顶优先拦截，
    // 避免「时间窗刚好放行但预算已尽」的无效评估；两道独立、先到先拦。
    if (st.llmCount >= cfg.maxLlmUpdatesPerSession) return
    if (Date.now() - st.lastAt < cfg.cooldownMs) return
    st.driftSkip = cfg.driftCooldownMessages // 命中冷却：4 条实质性消息内不重触发
    st.inFlight = true
    void ctx.sessionTitle
      .refresh(session)
      .then(() => {
        st.lastAt = Date.now()
        ctx.logger.info(`[title-drift] drift rewrite (G3) session=${session.id}: ${verdict.reason}`)
      })
      .catch((error) => {
        ctx.logger.warn(`[title-drift] drift refresh failed session=${session.id}: ${String(error)}`)
      })
      .finally(() => {
        st.inFlight = false
      })
  })

  ctx.on('session/disposed', (session) => {
    state.delete(session.id)
  })
}

// 供离线单测使用（不构成运行时依赖）
export const __internals = { localTitle, truncateDual, pickSeqs, normalizeWhitespace, stripPairedQuotes }
export const __internalsM3 = { localTitleCore, framedBytes, framedBytesFrom, selectWindow, evaluateDrift, llmConfigOf }
