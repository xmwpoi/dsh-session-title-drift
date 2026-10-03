# dsh-session-title-drift

**当前最新版：`0.1.1-rc.2`（GitHub Latest）。** 本版增加主题漂移的模型语义确认，已完成两组完整 S4 样本及补充对照。其他五案未在本版重新进行 GUI 验收，不能宣称六案全通过。详见 [TESTING.md](TESTING.md) 和 [RELEASE-NOTES.md](RELEASE-NOTES.md)。

DSH（DeepSeek Harness，Cordis 宿主）的 host 侧会话标题插件。它注册一个自定义标题
provider 并附带 watcher，补上内置标题服务的三个缺口：

| 缺口 | 问题 | 本插件的处理 |
|---|---|---|
| G1 | 委派（subagent）会话没有标题 | watcher 主动补一次标题（`delegatedTitles` 开关，默认开） |
| G2 | 长首问超出输入预算时标题生成静默失败，只剩机械截取 | 本地规则 provider 接管；`mode: 'hybrid'`（默认）下对被机械截取的长首问调官方共享标题 LLM 做语义改写 |
| G3 | 会话主题漂移后标题不更新 | 完整标题的词面门筛候选，再通过模型语义确认；同项目子问题保持原题，确认换题才改写；共用互斥、冷却和尝试预算 |

本地首标题零 API 调用；`hybrid` 模式仅在「首问被机械截取」或「漂移命中」时各可能发
一次 LLM 请求（每次 `generate()` 至多一次），初标题 LLM 不可用时回退本地规则；漂移确认失败、超时或非法输出时保留原题。

## 版本与验证状态

- **目标宿主版本：DSH `0.1.7-rc.2`。** 本插件的源码、离线依据与宿主 API 事实均
  按该版本核实。
- 当前版本为 **`0.1.1-rc.2`，已按用户确认设为 GitHub Latest**。验证范围、行为结果和剩余限制见
  [TESTING.md](TESTING.md)。Latest 标记不代表新增测试或所有场景均已验证。
- 0.2.0-rc.*、Node 22 和全新机器环境未经验证，不要假定兼容。

## 环境要求

- DSH `0.1.7-rc.2`（宿主提供 `sessionTitle` 服务与 `@deepseek-ai/dsh-session-title-llm`
  共享库）
- Node.js：**推荐 ≥ 22**；**实测环境为 Node v24.20.0**（ESM，无构建步骤）。下限
  22 是推荐值，本轮未在 Node 22 上实测。
- 插件以 ESM 加载，无构建步骤

## 安装与加载

DSH 插件通过 profile 内 `node_modules` 链接 + bundle patch 加载。**本插件在模块加载期
静态导入 `@deepseek-ai/schemastery`（`lib/index.js:10`），因此仅克隆源码、不做下面
第 2 步，插件一定无法加载**（会直接 `ERR_MODULE_NOT_FOUND`，不是运行期才失败）。
第 2 步二选一，都必须做。

### 示例变量约定

下面的示例统一使用这几个变量。**请先按你的实际路径填写**——示例里给的是占位值，
不是真实路径，原样复制不会生效：

```powershell
# 本仓库被克隆到的目录（你填）
$DshSourceRoot  = 'C:\src\dsh-session-title-drift'

# DSH 数据根：优先 $env:DSH_HOME，否则 ~/.dsh（与宿主 resolveDshHome 的顺序一致）
$DshHome        = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }

# 要装入的 profile 目录（须是已存在的 profile）
$DshProfileDir  = Join-Path $DshHome 'profiles\web'

# 仅方案 B 需要：DSH 宿主安装树根目录，即包含 node_modules 的那一层（你填）
$DshInstallRoot = 'C:\path\to\dsh-install'
```

⚠️ **不要用 `$HOST` / `$Host` 作变量名。** `$Host` 是 PowerShell 的只读自动变量
（`Constant, AllScope`），变量名大小写不敏感，因此 `$HOST` 与 `$Host` 是同一个变量；
实测对它赋值会抛 `SessionStateUnauthorizedAccessException: Cannot overwrite variable Host
because it is read-only or constant`。上表刻意避开了所有 PowerShell 自动变量
（`$Host`、`$HOME`、`$PROFILE`、`$PWD`、`$Error` 等）。

手动步骤：

1. 把本仓库克隆到 `$DshSourceRoot`。

2. **提供 `@deepseek-ai/schemastery`（必需，二选一）：**

   **方案 A — 联网安装依赖（推荐）**，在 `$DshSourceRoot` 下执行：

   ```powershell
   Set-Location $DshSourceRoot
   npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
   ```

   `package.json` 已声明 `dependencies["@deepseek-ai/schemastery"]: "~3.18.4"`，会装出
   `$DshSourceRoot\node_modules\@deepseek-ai\schemastery`。已在新的插件目录用普通依赖
   实测安装；锁文件固定解析到 3.18.4。`--legacy-peer-deps` 避免另装一份 DSH；宿主
   仍须独立安装并提供 peer 服务，因此单独在插件目录运行 `npm ls` 会报告缺失 DSH peer。

   **方案 B — 复用宿主已有的副本（离线，与宿主共用同一份）**：在插件目录建链接指向
   宿主安装树里的同名包：

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$DshSourceRoot\node_modules\@deepseek-ai\schemastery" `
     -Target "$DshInstallRoot\node_modules\@deepseek-ai\schemastery"
   ```

   开发期沙箱用的就是这个方案（junction → 宿主安装树 3.18.4，已核对该 junction
   存在且目标为宿主树同名包）。**风险与未证事项**：两个方案的区别是**装出第二份
   `@deepseek-ai/schemastery` 实例**（方案 A）还是**与宿主共用一份**（方案 B）。
   共用一份与早期开发环境一致；本轮普通依赖方案的实际宿主测试结果见 TESTING.md。
   不把一次环境成功推广为任意安装布局都成功。

   ⚠️ 只把依赖写进 `package.json` **不会**让一个没有 `node_modules` 的源码克隆自动
   可加载；上面两个方案必须实际执行一个。上面两条 `New-Item` 会自动创建缺失的中间
   目录（已实测），但仍请先确认 `$DshInstallRoot` 指向真实存在的宿主安装树。

3. 在 profile 的 `node_modules` 下建立指向本仓库的链接（Windows Junction）：

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$DshProfileDir\node_modules\dsh-session-title-drift" `
     -Target $DshSourceRoot
   ```

4. 在 profile 的 `package.json`（即 `$DshProfileDir\package.json`）中：`dependencies` 加
   `"dsh-session-title-drift": "link:<$DshSourceRoot 的正斜杠绝对路径>"`，并在
   `dsh.profile.bundles` 数组加入 `"dsh-session-title-drift"`。
5. 把本仓库的 `cordis.patch.yml` 内容合并进 bundle patch 生效路径（或确认
   `package.json` 的 `dsh.bundle.patch` 指向本文件的加载机制可用）。
6. **必须先禁用内置标题 provider**：本插件的 provider id 为 `drift`，而宿主的
   `sessionTitle` 服务只允许注册一个 provider。在 profile 的 `cordis.patch.yml`
   追加：

   ```yaml
   - id: session-title-llm
     name: "@deepseek-ai/dsh-session-title-first-prompt-llm"
     disabled: true
   ```

   不禁用会导致本插件 `register()` 抛 `already registered`、加载失败。启用前请
   核对当前宿主/profile 中内置 provider 的实际 id 与注册状态，避免重复注册。
7. 重启宿主实例使改动生效；改配置后的验收也一律以明确重启为基准。

### 版本门：peerDependencies 与 dsh.engines 不是一回事

- **`peerDependencies["@deepseek-ai/dsh"]: ">=0.1.7-rc.2"` 是宿主实际会校验的门。**
  实测宿主 `dsh-app-boot` 的 `evaluatePluginCompatibility()`
  （`dsh-app-boot\lib\index.js:286-313`，在 `:929` 的 `loadProfileDirectory` 里对每个
  bundle 调用）只读 `peerDependencies`，不满足就**跳过该 bundle 并打印 warning**。
  用运行时版本 `0.1.7-rc.2` 对该声明实测，结果为 `undefined`（= 兼容，无告警）。
- **`dsh.engines` 在所审宿主中不被消费**，只是 metadata。实测证据：全量搜索宿主
  `@deepseek-ai\**\lib\*.js`，无任何代码读取 `dsh.engines`；把 `dsh.engines.dsh`
  设为 `>=99.0.0` 传给 `evaluatePluginCompatibility()` 仍返回 `undefined`。因此
  `dsh.engines` **不能当作版本校验门**，也不应用它推断对其它宿主版本的兼容性。
- **`dsh.bundle.patch` 是加载机制，不是版本门**：宿主按
  `dsh-app-boot\lib\index.js:495-509` 的 `bundlePatchPaths()` 读取本仓库的
  `cordis.patch.yml` 并合入 profile。声明缺失会使 bundle 被跳过（`:928` 抛
  `declares no dsh.bundle`）。

### 安装验证范围

已验证新插件目录的联网依赖安装与完整离线测试；宿主仍使用已有的 DSH 安装和测试
配置，不是“全新机器从零部署”。实际 profile 加载与 GUI 记录见 TESTING.md。

## 配置

全部字段以 `lib/index.js` 的 `Config` 为准（schema 默认值自动生效，config 块可省
略）。常用字段：

| 字段 | 语义 | 默认值 |
|---|---|---|
| `enabled` | 总开关（false 时 watcher 不动作；自动首标题仍走本地规则） | `true` |
| `delegatedTitles` | 是否给委派（subagent）会话补标题 | `true` |
| `mode` | `local` = 停用全部 LLM 路径（一级回滚开关）；`hybrid` = 截取/漂移走 LLM | `hybrid` |
| `driftEnabled` | 漂移门开关（仅 `hybrid` 下评估） | `true` |
| `llmProvider` / `llmModel` | 显式 LLM 路由，**必须成对配置**才生效；留空 = 继承会话主请求路由 | 空 |
| `cliNodeModules` | 共享标题 LLM 解析锚点的显式覆盖；仅非常规启动方式（相对路径 argv[1]）下可能需要 | 空 |
| `llmMaxInputBytes` | 送给 LLM 的输入字节预算；漂移背景与近期正文在此预算内裁剪 | `32768` |
| `maxLlmUpdatesPerSession` | 每会话 LLM 尝试上限，包含确认否决与失败，不是成功改题次数 | `3` |
| `cooldownMs` | 同一会话两次主动 `refresh()` 的最小时间间隔 | `120000` |
| `driftCooldownMessages` | 漂移命中后的条数级冷却 | `4` |
| `driftTrigger` | 漂移评分触发阈值 | `0.25` |

字节预算口径（不要混用）：**本插件**的 LLM 输入预算是 `llmMaxInputBytes`（默认
32768 字节）；**内置 provider**（若未禁用）的出厂 `maxInputBytes` 是 4096 字节，
那是内置服务的字段，与本插件无关。

路由配置说明：`llmProvider`/`llmModel` 留空时继承会话主请求的路由；全新首问会话
在自动首标题时机可能尚无可继承路由，此时 LLM 改写会失败并 fail-open 回退本地截取
标题（有 warn 日志，不影响标题产出）。空路由下插件**能加载**不等于 hybrid 改写
**已工作**——后者需要路由可用且实际产生 `title-llm-request` 事件。`driftCheckEvery`
字段已废弃：schema 中保留但运行路径不读取。

## 开发与测试

安装第 2 步的普通依赖后：

```bash
node --check lib/index.js
node --check lib/drift-gate.mjs
node --check lib/semantic-drift.mjs
npm test
```

默认测试包含 smoke 和严格语义协议解析。未设置宿主解析锚点时，9 组宿主入口集成明确 SKIP，不算通过；安装依赖后默认 smoke 为 48 项、解析为 8 项。若普通依赖也未安装，semantic 测试的静态 import 会失败，不能将裸 clone 视为可测试安装。

真实宿主 SDK 的合成流集成测试需将环境变量 `DSH_TEST_CLI_NODE_MODULES` 设置为已安装 DSH 的 node_modules 绝对路径，再执行 `npm test`。测试仅替换模型流，覆盖否决、真换题、共享预算与冷却、并发互斥、非法输出、用户/seeded/委派边界及超预算输入。合成验证不等于真实模型准确率。

历史开发探针 p0d 的 56/56、m1 的 13/13，与 smoke 48 项、解析 8 项和集成 9 组是不同断言集；不可相互替代。11/11 是已失效的旧计数。真实 GUI S4 结果见 TESTING.md。

## 已知限制（如实披露）

- **漂移门的算法局限**：离线回放历史中，真实会话漏检 1/2（两段真实漂移只命中一
  段），合成数据误报 2 例。阈值组是回放扫描的折中选值，不是零漏检/零误报的保证。
- **行为验证的适用范围**：见 TESTING.md 的当前 revision 实测结果。
  离线测试通过（`npm test`）不等于宿主行为已验收。
- **漂移输入与语义确认**：earlierMessages 提供项目背景、recentMessages 提供当前候选主题；生成的新标题只归因近期消息。严格协议要求显式确认换题，非法/超时/非正常结束均保留原题。词面候选仍有措辞敏感性，模型判断仍可能出错，不能保证零漏检或零误报。
- **源码注释保留内部设计标签**：`lib/` 三个运行模块为已验证发布件（逐字节校验），其注释
  中保留了开发期的内部条目代号（如 `p3-2`、`P0c`、`p2-1`、`p2-2`）及一处内部报告
  路径名。这些是历史注释文本，不含凭据、会话内容或机器路径；如需清理须改动冻结
  文件，不在本版本范围内。
  注释中的旧探针、报告名和 schema junction 示例是开发期说明，不是本仓库可执行入口；
  请使用上方安装步骤和 `npm test`。
- **0.2.0 未验证**：`peerDependencies` 声明 `@deepseek-ai/dsh: >=0.1.7-rc.2`，在
  0.1.7-rc.2 上实测通过宿主 peer 门；但本插件**未在 0.2.0 上做过任何验证**，该
  范围只是声明，不构成对 0.2.0 的兼容承诺。`dsh.engines` 字段在所审宿主中不被
  消费（见「版本门」一节），**不要**用它推断兼容性。
- **纯图片首问**：无文字内容的会话无法产出本地标题（本地规则基于文本），维持服
  务回退标题。
- **钉住语义**：普通自动更新路径中，被用户显式重命名/钉住的标题（`source.kind === 'user'`）不会覆盖；官方 refresh 存在显式解钉路径，不能表述为永久不可逆；
  seeded fork 不插手；宿主可为继承标题添加 `(1)` 等编号，这不是插件改写。
- **状态不持久化**：每会话状态（窗口/计数/冷却）为进程内存态，实例重启即清零。
  已产出标题是持久化日志事件，不受影响。
- **本仓库不含**：历史会话标题回填（backfill）、0.2.0 适配、纯图片首问自动标题。

## 许可证

MIT（见 [LICENSE](LICENSE)）。Copyright (c) 2026
[xmwpoi](https://github.com/xmwpoi/dsh-session-title-drift)。

`package.json` 保留 `"private": true`：本仓库通过 GitHub 分发源码，不发布 npm，仅作源码分发，该字
段不影响 GitHub 上传。
