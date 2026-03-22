# AGENT.md

## 项目定位

`openclaw-hanako-panel` 目前还是一个**文档先行**的仓库。
目标不是复刻另一个重型运维后台，而是做一个更接近 **OpenClaw 原生工作台** 的 Web Panel：

- 视觉与工作台气质参考 `openhanako`
- 管理维度参考 `ClawPanel` / `openclaw-dashboard`
- 数据链路优先遵循 OpenClaw 官方 `Gateway WebSocket`
- `agent` 级独立 session 是核心能力之一

## 当前稳定结论

根据 `docs/` 现有文档，下面这些已经可以视为稳定前提：

1. **先做 web-only，不做 Electron 首版。**
2. **产品结构要把 chat 与 manage 分开。**
3. **OpenClaw Gateway 是唯一权威控制面。**
4. **标准模式下，前端优先直连 Gateway WebSocket。**
5. **局域网 HTTP 模式下，增加一个很薄的 panel proxy。**
6. **日志第一版复用 `logs.tail`，不要额外发明新的日志协议。**
7. **session 是一等公民，独立 session 要沿用 OpenClaw 风格的 key。**

推荐 session key 形式：

- `agent:<agentId>:panel:<slug>`
- `agent:<agentId>:task:<slug>`
- `agent:<agentId>:workspace:<slug>`

MVP 阶段优先只做：

- 分 agent chat
- 实时 log 监控
- agent / channel / gateway 状态监控

## 先读哪些文档

如果你是第一次接手这个仓库，建议按这个顺序阅读：

1. `docs/00 Index.md`
2. `docs/08 最小可行架构 MVP 2026-03-22.md`
3. `docs/05 局域网 HTTP 与薄网关方案 2026-03-21.md`
4. `docs/06 Panel Proxy 设计 2026-03-21.md`
5. `docs/07 前端网页实现方案与参考实现 2026-03-22.md`
6. `docs/04 第二轮调研 实现路线与日志 2026-03-21.md`

如果你需要追溯判断过程，再看：

- `docs/02 调研结论 已验证 2026-03-21.md`
- `docs/03 Web Control Panel 思路整理 2026-03-21.md`
- `docs/90 对话记录整理 2026-03-21.md`

## 面向后续实现的工作约束

### 1. 不要把项目做重

避免一开始就引入这些内容作为首版前提：

- Electron
- 完整自建业务后端
- 大而全宿主机管理
- 配置、安装器、系统服务、Docker、外围生态一口气接管

如果确实需要中间层，保持为**薄 proxy / sidecar**。

### 2. 认清权威状态边界

- **Gateway**：chat、session、tool stream、presence、日志、配置等权威来源
- **panel proxy**：浏览器友好的适配层、连接复用、日志转推、少量 UI 元数据
- **panel 自己的元数据**：title、pinned、tags、archived、lastOpenedAt 这类展示补充信息

不要在 panel 或 proxy 里重新发明 transcript 真相或 session 存储真相。

### 3. 前端优先保证信息架构正确

第一优先级不是“把所有页面都做出来”，而是先把骨架做对：

- `/chat`：工作区
- `/manage`：管理区

如果按 MVP 收缩，也可以先落成：

- `/chat`
- `/logs`
- `/status`

### 4. 技术选型以稳定和可扩展为先

当前文档最推荐的组合是：

- 前端：`React + TypeScript + Vite + React Router + Zustand + TailwindCSS`
- 完整版数据层可再补：`TanStack Query`
- proxy：`Node.js + Fastify + @fastify/websocket + Zod + Pino`

不要为了“更新”而偏离文档已经验证过的稳定路线。

### 5. 参考项目只借层，不整套照搬

推荐借鉴方式：

- `openhanako`：视觉语言、工作台氛围、chat 区气质
- `ClawPanel`：管理维度与面板覆盖面
- `openclaw-dashboard`：manage 路由组织方式
- OpenClaw 官方 Control UI：真实能力边界与协议现实

不直接搬它们的内部 runtime、manager、状态模型。

## 建议的实现顺序

文档已经基本收束为下面这个顺序：

### 第一阶段

- 前端静态骨架
- 路由与布局
- 假数据页面

### 第二阶段

- agent 列表
- session 列表
- 独立 session 创建
- chat send / stream

### 第三阶段

- logs 页
- status 页
- Gateway / proxy 连接状态展示

### 第四阶段

- manage 基础页扩展
- 需要时补薄 proxy / sidecar 能力

## 文档维护约定

当你修改方向、边界或阶段目标时：

1. 优先更新 `docs/00 Index.md` 的稳定结论与阅读顺序。
2. 如果是架构变化，补到对应专题文档。
3. 如果是仓库入口认知变化，同步更新 `README.md`。
4. 保持 `AGENT.md` 只总结稳定共识，不堆过程性讨论。

## 一句话提醒

这个仓库最重要的不是“功能堆满”，而是：

**先把 OpenClaw Panel 的最小闭环做对，再扩功能。**
