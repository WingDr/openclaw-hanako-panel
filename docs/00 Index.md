# OpenClaw Panel

更新时间 2026-03-25

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
- 当前 `panel-proxy` 鉴权采用双轨模型：浏览器走 panel 密码登录 + session cookie，脚本调试走 Bearer API token
- 前端当前最推荐的组合是 `React + TypeScript + Vite + React Router + Zustand + TanStack Query + TailwindCSS`
- 如果先做首版，前端和 proxy 都应该明显收缩，只保留分 agent chat、log 监控、agent/channel 状态监控三条主线

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
- ​`08 最小实现架构 首版 2026-03-22`

  - 只保留分 agent chat、log 监控、agent/channel 状态监控的最小实现方案
- ​`09 首版前端页面树与组件结构 2026-03-22`

  - 把 `/chat`、`/logs`、`/status` 三页的页面树、组件拆分、store 边界固定下来
- ​`10 Gateway WS 客户端数据流草案 2026-03-22`

  - 定义 Gateway client 的连接状态、RPC 映射、事件分发和 chat/logs/status 三条数据流
- ​`11 Panel Proxy 最小接口协议 v0.1 2026-03-22`

  - 固定局域网 HTTP 模式下 panel proxy 的最小 HTTP/WS 协议与事件格式
- `12 Chat Session 状态同步与锁设计复盘 2026-03-24`

  - 复盘当前聊天链路的问题，并给出单 session 单 active run 的状态机、同步流程、锁模型与迁移验收标准
- `13 Chat 流处理模块架构 2026-03-24`

  - 把 chat 中栏与 chat 流处理链路独立成可嵌入模块，定义连接层、状态机、锁模型与 host 集成接口
- `14 Proxy Chat 与 Logs 推流同步模块设计 2026-03-24`

  - 拆分 proxy 侧 logs/chat 推流与同步模块，并给出“直接透传 vs 增强透传”的可执行决策
- `15 Proxy 鉴权机制 2026-03-25`

  - 固定当前已实现的浏览器登录、session cookie、Bearer API token 与单独调试方式
- ​`90 对话记录整理 2026-03-21`

  - 本轮 panel 讨论的时间线与关键决策整理

## 阅读顺序建议

如果只想快速看当前最推荐方向，优先读：

1. ​`08 最小实现架构 首版 2026-03-22`
2. ​`09 首版前端页面树与组件结构 2026-03-22`
3. ​`10 Gateway WS 客户端数据流草案 2026-03-22`
4. ​`11 Panel Proxy 最小接口协议 v0.1 2026-03-22`
5. `12 Chat Session 状态同步与锁设计复盘 2026-03-24`
6. `13 Chat 流处理模块架构 2026-03-24`
7. `14 Proxy Chat 与 Logs 推流同步模块设计 2026-03-24`
8. `15 Proxy 鉴权机制 2026-03-25`
9. ​`05 局域网 HTTP 与薄网关方案 2026-03-21`
10. ​`06 Panel Proxy 设计 2026-03-21`
11. ​`07 前端网页实现方案与参考实现 2026-03-22`

如果要追溯思路变化，再回看：

- ​`01 初步开发方案 草稿`
- ​`02 调研结论 已验证 2026-03-21`
- ​`03 Web Control Panel 思路整理 2026-03-21`
- ​`90 对话记录整理 2026-03-21`

## 已补充的可执行设计草案

- 首版前端页面树与组件结构
- Gateway WS 客户端数据流草案
- 局域网 HTTP 模式下 panel proxy 的最小接口协议 v0.1
- Chat session 状态同步与锁设计复盘
- Chat 流处理模块架构（含 Mermaid 状态机与架构图）
- Proxy chat/logs 推流同步模块设计（含透传策略决策）
- Proxy 鉴权机制（含 panel 密码登录与 Bearer API token 双轨模型）

## 后续最适合继续补的内容

- logs 页细化交互与大日志缓冲策略
- manage 区后续扩展的状态模型
- `panel-web/` 与 `panel-proxy/` 的实际目录演进方案
- API / WS schema 的显式类型与校验层

## 结论

这份最小实现架构是为快速落地而设计的。它强调最小闭环、稳定的数据流，以及为后续扩展留出清晰的边界。
