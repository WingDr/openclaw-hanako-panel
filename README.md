# openclaw-hanako-panel

参考 `liliMozi/openhanako` 的工作台气质，为 OpenClaw 设计一个 **web-only** 的监控 / 控制面板，并保留面向 agent 的独立 chat 工作区。

当前仓库仍处在 **文档先行、方案收束** 阶段，核心目标已经比较明确：

- 做成 OpenClaw 原生工作台，而不是另一个重型运维后台
- 让 `chat` 和 `manage` 在统一主题下明确分区
- 优先复用 OpenClaw Gateway 的原生能力
- 把 agent 级独立 session 做成核心卖点之一

## 项目定位

这个项目不是在复刻 ClawPanel，也不是在把 openhanako 直接移植到 OpenClaw。

更准确地说，它是三条思路的组合：

- **视觉与工作台体验** 参考 `openhanako`
- **管理维度** 参考 `ClawPanel` 与 `openclaw-dashboard`
- **控制链路** 优先遵循 OpenClaw 官方 `Gateway WebSocket`
- **agent 级独立 session** 是核心能力之一

目标产物是一个更适合长期与 agent 协作的 panel：既能聊天工作，也能查看状态与日志，并逐步扩展到更完整的管理视图。

## 当前稳定方向

根据 `docs/` 中已经整理过的结论，目前可以把下面这些视为稳定前提：

1. **首版只做 web-only，不做 Electron。**
2. **产品结构以 chat / manage 分路由为主。**
3. **Gateway 是唯一权威控制面。**
4. **标准模式下优先直连 OpenClaw Gateway WebSocket。**
5. **局域网 HTTP 模式下增加一个很薄的 panel proxy。**
6. **实时日志第一版复用 `logs.tail`。**
7. **独立 session 使用 agent 级稳定 session key。**

推荐的 session key 形式：

- `agent:<agentId>:panel:<slug>`
- `agent:<agentId>:task:<slug>`
- `agent:<agentId>:workspace:<slug>`

## 首版功能准备

当前文档已经把首版范围明显收缩到最小可行架构。首版先只保留三条主线：

### 1. 分 agent 的 chat

- 选择 agent
- 查看该 agent 下的 session 列表
- 新建独立 session
- 进入指定 session 聊天
- 查看流式回复与基础 tool stream

### 2. 实时 log 监控

- 查看 Gateway 日志
- 自动跟随
- 暂停滚动
- 简单搜索
- 简单 level 过滤

### 3. agent / channel / gateway 状态监控

- Gateway 连接状态
- agent 状态
- channel 状态
- 最近 session 活动概览

## 当前明确暂缓的功能

为了避免项目过早变重，下面这些功能不作为首版前提：

- config 编辑
- cron 管理
- skills 管理
- models 管理
- 文件管理
- 多用户权限
- session pin / tag / archive
- 命令面板
- split screen
- 复杂右侧上下文侧栏
- 完整 design token 系统
- 大量宿主机运维接管

这些内容会在首版跑通后，再按优先级逐步补进来。

## 推荐技术路线

### 前端

- React
- TypeScript
- Vite
- React Router
- Zustand
- TailwindCSS

完整版本如有需要，再补：

- TanStack Query
- Radix UI / shadcn 风格组件
- `@melloware/react-logviewer`

### 中间层

局域网 HTTP 模式下，推荐增加一个很薄的 `panel proxy`：

- Node.js
- Fastify
- `@fastify/websocket`
- Zod
- Pino

### 后端权威来源

- OpenClaw Gateway WebSocket

## 推荐架构模式

### 标准模式

适合本机访问，或已有 HTTPS / secure context 的环境：

- Browser 直连 OpenClaw Gateway WS
- 链路更短
- 更贴近 OpenClaw 官方 Control UI

### 局域网 HTTP 模式

适合多设备在局域网里访问普通网页：

- Browser 连接 panel proxy
- panel proxy 再连接 OpenClaw Gateway WS
- 普通数据走 HTTP
- 所有实时能力走一条浏览器 WebSocket
- logs 由 proxy 通过 `logs.tail` 增量拉取后转推

## 建议页面结构

完整方向建议保持：

```text
/chat
/manage/overview
/manage/agents
/manage/sessions
/manage/logs
/manage/config
/manage/cron
/manage/skills
/manage/channels
/manage/models
```

如果先严格按 首版 收缩，最小版本可以先落成：

```text
/chat
/logs
/status
```

## 推荐开发顺序

1. 先搭前端静态骨架和基础布局
2. 再接 `agents` / `status` 这类基础数据
3. 然后打通 chat WebSocket 与 session 流程
4. 再接 logs snapshot + subscribe
5. 最后补搜索、过滤、重连、错误提示等细节

## 文档导览

如果要快速理解当前方向，建议先读：

1. `docs/00 Index.md`
2. `docs/08 最小实现架构 首版 2026-03-22.md`
3. `docs/09 首版前端页面树与组件结构 2026-03-22.md`
4. `docs/10 Gateway WS 客户端数据流草案 2026-03-22.md`
5. `docs/11 Panel Proxy 最小接口协议 v0.1 2026-03-22.md`
6. `docs/05 局域网 HTTP 与薄网关方案 2026-03-21.md`
7. `docs/06 Panel Proxy 设计 2026-03-21.md`
8. `docs/07 前端网页实现方案与参考实现 2026-03-22.md`

如果要追溯完整决策过程，再看：

- `docs/02 调研结论 已验证 2026-03-21.md`
- `docs/03 Web Control Panel 思路整理 2026-03-21.md`
- `docs/04 第二轮调研 实现路线与日志 2026-03-21.md`
- `docs/90 对话记录整理 2026-03-21.md`

## 已落地的可执行设计草案

- `docs/09 首版前端页面树与组件结构 2026-03-22.md`
- `docs/10 Gateway WS 客户端数据流草案 2026-03-22.md`
- `docs/11 Panel Proxy 最小接口协议 v0.1 2026-03-22.md`

这三份文档已经把首版前端骨架、Gateway 实时数据流和 panel proxy 最小协议整理成了可以直接进入编码阶段的草案。
