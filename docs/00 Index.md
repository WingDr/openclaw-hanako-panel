# OpenClaw Panel

更新时间 2026-03-22

这里是 OpenClaw Panel 的集中档案。  
用于汇总目前关于 panel 的方向讨论、阶段性文档、架构判断和对话记录，方便后续继续修改、比对和推进。

## 当前稳定结论

- 方向以 web-only 为主，不做 Electron
- 产品形态采用 chat 和 manage 分路由
- UI 主题统一，但 chat 和 manage 的交互目标明确分开
- 核心控制链路优先直连 OpenClaw Gateway WebSocket
- agent 级独立 session 是核心能力之一
- 实时日志第一版优先复用 OpenClaw 现有 `logs.tail`
- 如果要支持局域网 HTTP 访问，推荐加一个薄网关 panel proxy
- 前端当前最推荐的组合是 `React + TypeScript + Vite + React Router + Zustand + TanStack Query + TailwindCSS`
- 如果先做 MVP，前端和 proxy 都应该明显收缩，只保留分 agent chat、log 监控、agent/channel 状态监控三条主线

## 文档目录

- ​`01 初步开发方案 草稿`

  - 最早期整理稿，保留作对照，不作为最终结论
- ​`02 调研结论 已验证 2026-03-21`

  - 第一轮核实后的结论稿
- ​`03 Web Control Panel 思路整理 2026-03-21`

  - 收束到 web-only、chat/manage 分路由后的产品思路
- ​`04 第二轮调研 实现路线与日志 2026-03-21`

  - 扩展参考项目池、框架成熟度、实时日志方案后的正式研究报告
- ​`05 局域网 HTTP 与薄网关方案 2026-03-21`

  - 针对局域网 HTTP 访问场景补充的实现建议
- ​`06 Panel Proxy 设计 2026-03-21`

  - panel proxy 的定位、能力边界、HTTP/WS 双向接口与日志流设计
- ​`07 前端网页实现方案与参考实现 2026-03-22`

  - 前端框架选择、产品/工程要求、实现方法和参考项目链接汇总
- ​`08 最小可行架构 MVP 2026-03-22`

  - 只保留分 agent chat、log 监控、agent/channel 状态监控的最小实现方案
- ​`90 对话记录整理 2026-03-21`

  - 本轮 panel 讨论的时间线与关键决策整理

## 阅读顺序建议

如果只想快速看当前最推荐方向，优先读：

1. ​`08 最小可行架构 MVP 2026-03-22`
2. ​`05 局域网 HTTP 与薄网关方案 2026-03-21`
3. ​`06 Panel Proxy 设计 2026-03-21`
4. ​`07 前端网页实现方案与参考实现 2026-03-22`
5. ​`04 第二轮调研 实现路线与日志 2026-03-21`

如果要追溯思路变化，再回看：

- ​`01 初步开发方案 草稿`
- ​`02 调研结论 已验证 2026-03-21`
- ​`03 Web Control Panel 思路整理 2026-03-21`
- ​`90 对话记录整理 2026-03-21`

## 后续最适合继续补的内容

- MVP 前端页面树
- MVP 接口协议 v0.1
- Gateway WS 客户端数据流草案
- 日志页和 chat/tool stream 的前端事件模型
- 局域网 HTTP 模式下 panel proxy 的最小接口协议
