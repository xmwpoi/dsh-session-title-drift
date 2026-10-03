# v0.1.1-rc.2 预发布说明

本版本用于用户阅览与试用，GitHub 标记 prerelease=true、Latest=false。用户审核前不转正式最新版。旧 v0.1.1-rc.1 预发布记录及标签保留。

## 变化

- 完整当前标题用于宽松候选筛选，真正改名前经过严格的模型语义确认；同一旅行/项目的子问题保留原标题。
- 背景上下文和近期新主题分开，新标题只归因近期消息。
- 统一 watcher/provider 的模型锁、冷却、尝试预算和失败拒绝。
- 新增严格 JSON 与真实宿主入口集成测试，LF 检出保护覆盖三个运行模块。

## 已验证与限制

两组完整 S4 和补充同主题/二次真换题对照通过；详情见 TESTING.md。其他五案未在此版重新 GUI 验收，不能宣称全六案通过。词面候选、模型非确定性、默认 3 次尝试和重启失忆仍为限制。

本次只分发 GitHub 源码，不发布 npm。MIT，版权人 xmwpoi。

## 发布目录复核

2026-10-03：全新发布目录、空 npm 缓存，从 npm 官方注册表执行 `npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund` 成功，新增 3 包。默认 `npm test` 为 smoke 48 pass、解析 8 项通过、宿主集成明确 SKIP；设置已有宿主 node_modules 解析锚点后再次执行，集成 9 pass、0 fail。此安装只装插件锁定依赖，`--legacy-peer-deps` 不代装宿主；不等于全新机器的 DSH 部署通过。
