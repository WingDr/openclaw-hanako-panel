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

## Agent 状态说明

当前 `chat` / `status` 页里的 agent 状态不是 OpenClaw Gateway 直接返回的原生 runtime state。

原因是当前可稳定使用的 Gateway RPC 里：

- `agents.list` 适合拿 agent 名单与显示名
- `status` 适合拿 heartbeat 配置、session 统计和最近活动
- `system-presence` 返回的是 Gateway / client 节点 presence，不是 agent presence

因此，`panel-proxy` 目前使用一层**启发式状态**：

- 最近约 2 分钟内有 session 活动：显示为 `online`
- 有历史活动或启用了 heartbeat，但最近没有新活动：显示为 `idle`
- 既没有最近活动，也没有 heartbeat 线索：显示为 `offline`

这层判断是 panel 侧的展示逻辑，不会写回 OpenClaw，也不代表上游已经提供了精确的 agent runtime state API。

这部分实现参考了 `vvlang/openclaw-agent-monitor` 的思路，尤其是“根据最近活动时间判断工作中 / 空闲”的做法：

- 项目地址：<https://github.com/vvlang/openclaw-agent-monitor>
- 参考文件：<https://github.com/vvlang/openclaw-agent-monitor/blob/main/agent-status-writer.js>

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

## 本地启动

当前推荐的本地开发方式已经统一到仓库根目录。

### 1. 首次安装依赖

在仓库根目录依次执行：

```bash
npm install
npm install --prefix panel-web
npm install --prefix panel-proxy
```

### 2. 准备根目录 `.env`

先复制一份示例配置：

```bash
cp .env.example .env
```

默认示例内容如下：

```dotenv
PANEL_WEB_PORT=5173
PANEL_PROXY_PORT=22846
# 留空时，panel-web 会默认连接到“当前页面主机名 + PANEL_PROXY_PORT”
VITE_PANEL_API_BASE_URL=
VITE_PANEL_WS_URL=

# panel-proxy 通过 OpenClaw Gateway `logs.tail` 拉日志
OPENCLAW_GATEWAY_WS_URL=wss://127.0.0.1:22838
OPENCLAW_GATEWAY_AUTH_TOKEN=
OPENCLAW_LOGS_POLL_MS=1000
OPENCLAW_LOGS_LIMIT=200
OPENCLAW_LOGS_MAX_BYTES=250000
```

如果你是从另一台设备通过局域网地址访问，例如 `http://192.168.1.20:5173`，推荐先保持 `VITE_PANEL_API_BASE_URL` 和 `VITE_PANEL_WS_URL` 为空，让前端自动连到 `192.168.1.20:22846`。

只有当 `panel-web` 和 `panel-proxy` 不在同一台机器上时，才需要显式填写这两个变量。

`/logs` 页的数据来源是 OpenClaw Gateway 的 `logs.tail`，不是 `panel-proxy` 自己的控制台输出。
如果 `OPENCLAW_GATEWAY_*` 没有显式填写，`panel-proxy` 会优先尝试从同机的 `~/.openclaw/openclaw.json` 推导本地 Gateway 地址和 token。

### 3. 一条命令同时启动

在仓库根目录执行：

```bash
npm run dev
```

这会同时启动：

- `panel-web` 的 Vite 开发服务器
- `panel-proxy` 的 HTTP / WebSocket 服务

## 环境变量说明

### `PANEL_WEB_PORT`

- 用途：控制 `panel-web` 的开发端口和 preview 端口
- 默认值：`5173`
- 示例：`PANEL_WEB_PORT=4173`

### `PANEL_PROXY_PORT`

- 用途：控制 `panel-proxy` 的 HTTP / WebSocket 监听端口
- 默认值：`22846`
- 示例：`PANEL_PROXY_PORT=3001`
- 兼容性：如果没有设置这个变量，`panel-proxy` 仍会兼容旧的 `PORT`

### `VITE_PANEL_API_BASE_URL`

- 用途：前端请求 proxy HTTP API 的基地址
- 默认行为：留空时自动使用 `当前页面协议 + 当前页面主机名 + PANEL_PROXY_PORT`
- 本机访问示例：`http://localhost:22846`
- 示例：`VITE_PANEL_API_BASE_URL=http://192.168.1.20:22846`

### `VITE_PANEL_WS_URL`

- 用途：前端连接 proxy WebSocket 的地址
- 默认行为：留空时自动使用 `当前页面协议对应的 ws/wss + 当前页面主机名 + PANEL_PROXY_PORT + /ws`
- 本机访问示例：`ws://localhost:22846/ws`
- 示例：`VITE_PANEL_WS_URL=ws://192.168.1.20:22846/ws`

### `OPENCLAW_GATEWAY_WS_URL`

- 用途：`panel-proxy` 连接 OpenClaw Gateway 的 WebSocket 地址
- 推荐值：`wss://127.0.0.1:22838`
- 留空行为：会尝试从 `~/.openclaw/openclaw.json` 推导本机 Gateway 地址

### `OPENCLAW_GATEWAY_AUTH_TOKEN`

- 用途：`panel-proxy` 调用 Gateway RPC 时使用的 token
- 推荐值：填写你当前 OpenClaw Gateway 的 token
- 留空行为：如果本机 `~/.openclaw/openclaw.json` 里是 token 模式，会自动读取

### `OPENCLAW_LOGS_POLL_MS`

- 用途：`panel-proxy` 轮询 `logs.tail` 的间隔
- 默认值：`1000`
- 示例：`OPENCLAW_LOGS_POLL_MS=1500`

### `OPENCLAW_LOGS_LIMIT`

- 用途：每轮 `logs.tail` 请求的最大行数
- 默认值：`200`
- 示例：`OPENCLAW_LOGS_LIMIT=500`

### `OPENCLAW_LOGS_MAX_BYTES`

- 用途：每轮 `logs.tail` 请求的最大字节数
- 默认值：`250000`
- 示例：`OPENCLAW_LOGS_MAX_BYTES=500000`

## 单独启动子项目

如果只想单独调试某一个子项目，也可以分别启动。

### 只启动 `panel-web`

```bash
cd panel-web
npm run dev
```

`panel-web` 会从根目录读取 `.env`，因此仍然建议先准备好仓库根的 `.env`。

### 只启动 `panel-proxy`

```bash
cd panel-proxy
npm run dev
```

`panel-proxy` 的 `dev` 和 `start` 脚本会读取仓库根目录的 `.env`。

## 构建

如果要从仓库根目录统一构建：

```bash
npm run build
```

这个命令会先构建 `panel-proxy`，再构建 `panel-web`。

## 说明

当前这套统一启动方案优先服务本地开发体验，不等同于完整的生产部署方案。  
如果后面需要做局域网长期运行、反向代理、systemd、Docker 或容器化部署，建议再单独补一层部署编排。
