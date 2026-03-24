# Chat Session 状态同步与锁设计复盘

更新日期 2026-03-24

这份文档不是对现有实现的逐段解释，而是面向下一轮重构的设计复盘。

目标是把当前 `panel-web + panel-proxy` 已经跑通的“新建 session -> 发送消息 -> 接收流式回复”链路重新拆开，明确：

- 哪些状态属于 `Gateway` 权威真相
- 哪些状态只是 panel 的短暂投影
- 单 session 单 active run 的状态机应该怎么定义
- session/chat/tool 的同步流程应该怎样收敛
- 浏览器与 proxy 两层分别应该持有哪些锁
- 哪些现有实现应该视为过渡方案，后续应直接替换

本文默认服务于当前仓库的首版重构，不覆盖完整的 browser 直连 Gateway 终局方案，但设计会尽量保持可迁移。

## 一句话结论

当前聊天链路已经证明“最小闭环能跑起来”，但状态真相仍然被拆散在：

- HTTP 轮询得到的 session/history 快照
- WebSocket 推来的 chat/tool 增量事件
- 前端本地的 pending/live/tool 临时状态
- proxy 对 Gateway 事件的宽松归一化广播

这套做法足以验证产品方向，但不适合继续叠功能。

下一轮应该显式收敛到一个更稳定的模型：

- `Gateway` 继续作为 transcript 和 session 的唯一权威来源
- `panel-proxy` 增加轻量运行态注册表，负责 run 级协调和补偿入口
- `panel-web` 把 catalog state、runtime state、sync state、composer state 拆开
- 并发模型固定为 `单 session 同时只允许一个 active run`
- 连接层集中管理 chat 流和锁，默认采用“首次快照 + 持续推流”，只在完整性失败时回到快照回补

## 1. 问题定义与边界

### 1.1 权威状态边界

在当前产品方向里，状态边界必须保持清楚：

- `Gateway`
  - 权威 transcript 真相
  - 权威 session 真相
  - 权威 run / tool / system 事件来源
- `panel-proxy`
  - 浏览器友好的协议适配层
  - Gateway 连接复用层
  - 少量运行期协调者
  - 不应成为新的 transcript 数据库
- `panel-web`
  - 视图层状态
  - optimistic composer 态
  - 未落地完成前的短暂 runtime 投影
  - 不应重新定义 session/history 的长期真相

这个边界和仓库既有认知一致：

- [AGENT.md](../AGENT.md)
- [README.md](../README.md)
- [docs/10 Gateway WS 客户端数据流草案 2026-03-22.md](./10%20Gateway%20WS%20%E5%AE%A2%E6%88%B7%E7%AB%AF%E6%95%B0%E6%8D%AE%E6%B5%81%E8%8D%89%E6%A1%88%202026-03-22.md)
- [docs/11 Panel Proxy 最小接口协议 v0.1 2026-03-22.md](./11%20Panel%20Proxy%20%E6%9C%80%E5%B0%8F%E6%8E%A5%E5%8F%A3%E5%8D%8F%E8%AE%AE%20v0.1%202026-03-22.md)

### 1.2 当前链路的结构性问题

现有实现已经能新建 session 并发消息，但从状态同步角度看，有 5 个核心问题。

#### 问题 1：`session.create` 只是本地 draft，不是上游确认

当前 `panel-proxy/src/gatewayClient.ts` 里的 `createPanelSession()` 只是生成：

- `agent:<agentId>:hanako-panel:<uuid>`

然后把它作为 `pending` session 返回给前端，并没有真正向 Gateway 建立 session。

这本身不是错，但它目前仍然是一个“隐式过渡设计”，不是文档化的正式模型。后续如果不把它定义成明确的 `draft session -> first send 落地` 流程，就会持续混淆：

- 哪个 session 已经被 Gateway 认领
- 哪个 session 只是 panel 自己的本地壳
- 何时允许进入 history 回拉
- 何时允许被轮询结果覆盖或清理

#### 问题 2：前端同时依赖三套真相

当前聊天页同时依赖：

- `fetchSessions()` / `fetchChatHistory()` 的 HTTP 快照
- `panelRealtime` 推来的 `gateway.chat` / `gateway.tool` / `gateway.session`
- Zustand 里的 `pendingComposerBySession` / `liveChatBySession` / `toolStreamBySession`

这意味着当前 UI 实际上是在同时拼接：

- catalog state
- runtime stream state
- optimistic composer state

一旦发生断线、晚到事件、final 丢失、session 切换或列表轮询刷新，就容易出现真相分裂。

同时，当前“agent 列表 / session 列表 / session 详情（对话内容）”的获取职责还没有完全拆开，导致列表拉取与会话内容同步容易互相干扰。

#### 问题 3：没有显式 run / session 状态机

当前实现主要依靠这些状态片段判断界面：

- `sendPending`
- `createPending`
- `currentLiveChat`
- `hasAcceptedPending`
- `currentSession?.status`

这些值足够驱动 UI，但不足以表达真正的业务状态。

例如现在没有显式区分：

- 已发送但还没收到首个 stream
- 正在 streaming
- 用户已发起 abort 但未确认完成
- 终态已收到，但还在 reconcile history
- 因断线进入 stale / gap_detected

缺少这层状态机，后面就只能继续用布尔值和分支堆逻辑。

#### 问题 4：没有 event gap 检测与断线补偿

当前 `panel-web/src/realtime/ws.ts` 在连接关闭时会 fail pending command，并发一个 `system.connection` 事件，这是必要的第一步；但它还没有：

- 自动重连
- 重连后重订阅
- 事件序号跟踪
- gap 检测
- reconnect 后 session 级 runtime 清理
- reconnect 后基于序号/游标的完整性补偿与会话重同步

这意味着当前链路默认假设：

- 事件不会丢
- 不会乱序
- 断线时总能收到合适终态

这个前提对真实使用是不成立的。

#### 问题 5：没有真正的并发 / 锁模型

当前 UI 已经用 `currentBusy`、按钮禁用和 `canAbort` 限制了最常见的重复操作，但这只能算“交互层护栏”，还不算并发模型。

它覆盖不了的场景包括：

- 快速双击发送
- 多标签页同时打开同一 session
- send ack 成功但 stream 一直没开始
- 旧 run 的 late event 落到当前 session
- final 先到、tool 后到
- reconnect 后旧事件再返回
- session 列表轮询把 draft/pending session 顶掉

因此下一轮必须把“单 session 单 active run”从 UI 约束升级为系统约束。

## 2. 现状代码复盘

### 2.1 当前实现的主要参与者

当前聊天链路主要分布在下面几个文件：

- `panel-web/src/store/index.ts`
- `panel-web/src/pages/ChatPage.tsx`
- `panel-web/src/realtime/chatEventBridge.ts`
- `panel-web/src/realtime/ws.ts`
- `panel-web/src/components/Shell.tsx`
- `panel-proxy/src/gatewayClient.ts`
- `panel-proxy/src/index.ts`

### 2.2 当前状态实际上已经分成 4 类

虽然代码里没有正式命名，但现在的状态已经可以拆成 4 类。

#### A. catalog state

来源：

- `fetchAgents()`
- `fetchSessions()`
- `fetchChatHistory()`（当前仍在使用，目标是收缩为“WS 建连前/重连后的连接层预同步”）

落点：

- `agents`
- `sessionsByAgent`
- `historyBySession`

特点：

- 面向稳定展示
- 由 HTTP 快照更新
- 理论上更接近“权威回放结果”

问题：

- session 列表每 10 秒轮询一次，但没有和 runtime lock 做统一协调
- 会话详情的获取方式尚未正式定义为“连接周期预同步 + 后续纯推流”

#### B. runtime stream state

来源：

- `gateway.chat`
- `gateway.tool`

落点：

- `liveChatBySession`
- `toolStreamBySession`

特点：

- 纯增量
- 只代表尚未被 catalog 吸收的运行态

问题：

- 当前它被直接渲染进消息流，但没有明确“何时必须回收到 catalog”
- 对于重复 done、tool 晚到、disconnect 后 orphaned run 都没有统一处理模型

#### C. composer state

来源：

- 本地用户输入
- `chat.send` ack / error

落点：

- `pendingComposerBySession`

特点：

- 典型 optimistic state
- 负责在 Gateway 还没回放 transcript 之前先给用户看到自己发出去的消息

问题：

- `consumePendingComposerMessages()` 把“收到 final”当成唯一提交点
- 如果 final 丢失或 reconnect，中间态会变得难以清理
- 没有 submit token / owner run 绑定，导致 pending 消息与真正 run 的耦合偏弱

#### D. connection state

来源：

- browser -> panel-proxy WebSocket
- proxy -> Gateway WebSocket

落点：

- `panelRealtime` 内部 pending map
- `logsService` / `gatewayLogsClient` 的连接快照
- `system.connection` 事件

特点：

- 已经有最小 request/response 失败传播

问题：

- 浏览器层没有自动 reconnect / resubscribe
- 聊天层没有 disconnect 后的 orphaned run 收敛
- proxy 连接恢复后也没有主动触发 session/chat 域的对账

### 2.3 当前几个关键实现的具体缺陷

#### `historyBySession` 与 `liveChatBySession` 的合并时机仍然是启发式

`panel-web/src/store/index.ts` 里的 `commitLiveChat()` 与 `failLiveChat()` 会：

- 消耗 pending composer message
- 把 live 文本写入 transcript
- 清空 tool live state

这让页面能工作，但它实际上是在做“本地 transcript 拼装”。

问题是这个拼装不是基于上游明确的“session 已完成 reconcile”信号，而是基于：

- 某个 final/error/aborted 事件来了

只要 final 丢失、重复、晚到，或 stream 中断，这个合并就可能和权威 transcript 偏离。

#### `markSessionOpened()` 把任意 chat/tool 事件都投影成 session opened

当前 `handleChatRealtimeEvent()` 在收到 chat/tool 事件时直接调用 `markSessionOpened()`。

这会导致：

- session status 被过早更新
- session 更新时间直接跟随任何 event
- 没有 run ownership 校验

如果旧 run 的事件晚到，或者错绑到另一个可见 session，列表时间和排序都会被污染。

#### `consumePendingComposerMessages()` 没有处理 final 丢失和重复 done

现在的 optimistic user message 主要依赖：

- send 成功后标记 `accepted`
- final 到达后再把 pending 用户消息并入 transcript

这条路最适合“事件完整且顺序稳定”的情况。

但当前没有定义：

- final 超时后的 fallback
- 重复 done 的去重
- done 先到、tool 后到的 reconcile
- 断线重连后 accepted pending 的恢复策略

#### proxy 只是事件 normalizer，不是 runtime coordinator

`panel-proxy/src/gatewayClient.ts` 目前做得最多的是：

- `chat.send` / `chat.abort` / `chat.history` / `sessions.list`
- Gateway event 归一化
- `browserWsHub.broadcast()` 广播给所有浏览器

这已经足够作为最小 proxy，但它还没有：

- per-session runtime registry
- active run ownership
- submit token 对应关系
- 事件去重 / 终态收尾
- reconnect 后 orphaned run 标记

因此当前 proxy 只是“薄转发器”，还不是聊天运行态的协调层。

#### 浏览器 `RealtimeClient` 没有聊天域的恢复流程

`panel-web/src/realtime/ws.ts` 现在已经具备：

- pending request map
- close 时统一 reject

这和 OpenClaw Control UI 的 `GatewayBrowserClient` 是同方向的，但缺口仍然明显：

- 没有 reconnect loop
- 没有 gap callback
- 没有恢复后 catalog refresh
- 没有把“socket close”提升为 session runtime stale/disconnected

这会导致当前页面在真实故障场景下很容易卡在：

- `awaiting stream`
- `streaming`
- `accepted pending`

而没有可靠的自动收束路径。

## 3. 参考实现结论

本节只提炼对本仓库有直接帮助的结构，不照搬整套实现。

### 3.1 OpenClaw Control UI 值得借鉴的机制

对照 OpenClaw Control UI 的 `GatewayBrowserClient` 与上层 gateway app 流程，可以提炼出 4 个非常关键的点。

#### 机制 1：pending request map 是基础设施，不是附加逻辑

OpenClaw Control UI 的 `GatewayBrowserClient` 持有独立的 pending request map，并在连接关闭时统一 fail 掉挂起请求。

参考：

- `ui/src/ui/gateway.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/gateway.ts>

这说明“连接关闭时 reject 所有 pending request”应该被视为网关客户端职责，而不是页面自己兜底。

当前我们的 `panel-web/src/realtime/ws.ts` 已经部分具备这一点，这是应保留并继续扩展的方向。

#### 机制 2：显式事件序号与 gap 检测

Control UI 的 gateway client 维护 `lastSeq`，当收到的事件序号跳跃时，触发 `onGap` 回调，而不是继续假设本地流正确。

参考：

- `ui/src/ui/gateway.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/gateway.ts>

这对于聊天场景非常重要，因为一旦 gap 存在：

- 本地 live transcript 不能再被信任
- 必须进入 `gap_detected`
- 必须触发 history / sessions 回拉

当前 panel 实现还没有这层机制。

#### 机制 3：重连后主动清理断线遗留运行态

从 Control UI 的 `app-gateway.ts` 可以看到，它在 reconnect 后会主动清空断线前遗留的 chat run / stream / tool stream 状态。对我们来说，这在效果上等价于“把断线窗口里失去终态的 run 视为 orphaned，然后重新收敛”。

参考：

- `ui/src/ui/app-gateway.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/app-gateway.ts>

这正好对应我们当前最缺的一块：不能把 reconnect 只当成“重新连上了”，还要把断线窗口里失去终态的 run 收敛到 `orphaned` 或 `stale` 语义，然后靠 reconcile 收回来。

#### 机制 4：catalog reload 是一等公民

Control UI 会把 `sessions.changed`、session subscribe 等放进一套更明确的 catalog reload 流程，并且通过事件序号保证流的一致性。

参考：

- `ui/src/ui/controllers/sessions.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/controllers/sessions.ts>
- `ui/src/ui/app-gateway.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/app-gateway.ts>

这意味着：

- 本地拼装的 runtime 只能是短暂态
- 正常链路下应尽量依赖推流持续推进状态
- 只有发生完整性失败（gap、断流、游标不连续）时才回到 `sessions.list` / `chat.history` 快照回补

这和当前 panel 里“先本地 commit transcript，再等下次轮询刷新”的思路不同，后者太依赖好运气。

### 3.2 OpenHanako 值得借鉴的层次

OpenHanako 对这个项目最有价值的不是 Gateway 协议层，而是“工作台气质和运行域分层”的意识。

参考：

- `liliMozi/openhanako`
  - <https://github.com/liliMozi/openhanako>
- README
  - <https://github.com/liliMozi/openhanako/blob/main/README.md>

它提醒我们：

- 工作台 UI 可以很轻，但运行态管理不应该塞回单个页面组件
- 多 agent、多会话、主动流程和当前聊天视图不应该写成一团
- 可以保留柔和工作台体验，同时把 runtime manager 独立出来

对本仓库来说，这意味着：

- 不要继续把 session runtime 逻辑堆进 `ChatPage.tsx`
- 不要把“视图状态”和“聊天运行域状态”继续混在一个 store 里增长

### 3.3 本轮明确不照搬的部分

下面这些不建议直接照搬。

#### 不照搬 Control UI 的整套 host 对象与全局 app runtime

原因：

- 当前仓库是 `panel-web + panel-proxy` 双层结构
- 首版目标更小
- 我们不需要把所有管理页状态全部并入一个巨大 host object

#### 不照搬 OpenHanako 的整套 runtime / desktop / manager 家族

原因：

- 本项目首版仍然是薄 panel，不做完整宿主机工作台
- OpenHanako 更适合作为界面氛围和运行层次参考，不适合作为协议真相模型

#### 不把当前 panel 代码当成必须继承的框架

当前代码已经证明方向成立，但下一轮重构时，下面这些应被视为“可以替换”的过渡结构：

- scattered pending/live/tool store
- 轮询与流式事件的松散并置
- `session.create` 的隐式 draft 语义
- 仅靠按钮禁用实现的并发保护

## 4. 目标状态模型

下一轮建议先统一领域模型，再谈页面结构。

### 4.1 推荐的核心类型

下面这些类型不要求一开始就 100% 完整落地，但它们应该成为后续实现的目标骨架。

```ts
type SessionCatalogEntry = {
  sessionKey: string
  agentId: string
  preview: string
  updatedAt: string
  catalogStatus: "draft" | "pending" | "opened" | "closed"
}

type SessionRuntimePhase =
  | "idle"
  | "sending"
  | "awaiting_stream"
  | "streaming"
  | "reconciling"
  | "aborting"
  | "failed"

type RunState = {
  runId: string
  ownerClientId: string
  startedAt: string
  lastEventAt: string
  phase: "awaiting_stream" | "streaming" | "aborting" | "completed" | "aborted" | "errored" | "orphaned"
  hasToolActivity: boolean
}

type SessionSyncState =
  | "clean"
  | "stale"
  | "reloading"
  | "gap_detected"
  | "disconnected"

type ComposerState = {
  draft: string
  submitToken?: string
  optimisticUserMessageId?: string
  error?: string
}
```

### 4.2 catalog 与 runtime 必须分离

后续实现最重要的变化，不是多写一个 store 字段，而是把“长期展示真相”和“运行期投影”分开。

#### catalog state 只接受确定性快照写入

也就是只来自：

- `sessions.list`
- `chat.history` / `sync.bootstrap` 返回的一次性 session 快照
- 未来若上游提供明确 snapshot / subscribe 结果，也可以写入

它不应该由：

- live delta
- 单条 tool 事件
- UI 本地布尔值

直接修改真相内容。

#### runtime state 只承载短暂运行态

例如：

- 当前 run 的 live assistant text
- 当前 run 的 tool stream card
- 当前 run 的 aborting / awaiting_stream
- 当前 session 的 send lock / sync lock 状态

一旦 run 终态出现、连接断开或检测到 gap，就应该尽快通过 reconcile 回到 catalog。

### 4.3 `draft session` 需要被正式命名

由于当前上游并没有稳定提供“空 session create 并立刻持久化”的能力，因此建议保留：

- `session.create` 只创建 panel draft session

但必须把它写成正式模型。

推荐定义：

- `draft`
  - panel 本地可见
  - 可以被选择
  - 没有权威 history
  - 首条消息成功 ack 后进入 `pending/opening`
- `opened`
  - 已被 Gateway 认领
  - 可以回拉 history
  - 可以接收稳定 sessions.list 刷新

这样一来，后续列表合并、轮询保留、本地清理条件都会更清楚。

### 4.4 获取职责分离与连接层统一模型

下一轮建议把数据获取明确拆成三条线：

- `AgentCatalog`
  - 只负责 `agents.list` 及其状态投影
- `SessionCatalog`
  - 只负责 `sessions.list(agentId)` 及其状态投影
- `SessionDetailStream`
  - WS 建连前同步一次当前活跃 session 快照
  - WS 重连后再次同步一次，更新基线
  - 同步完成后只通过 socket 推流更新

推荐引入统一连接层 `ChatFlowConnectionLayer`（可部署在 proxy 或 web，部署位置可配置，职责不变）：

- 统一处理 `session.open`、`chat.send`、`chat.abort`、流式事件应用
- 统一管理 send/sync/refresh 锁
- 统一管理 event seq / cursor / watermark
- 统一处理 gap 检测与断流补偿

这层建立后，页面层不再主动抓取对话记录；连接层在每个连接周期（首次连接、每次重连）执行预同步，其余时间只接受推流，只有完整性失败才触发 session 级快照重抓。

## 5. 同步流程与锁设计

### 5.1 单 session 单 active run 的完整流程

本项目下一轮建议明确采用：

- 同一个 `sessionKey`
- 任一时刻只允许一个 active run

完整流程建议如下。

#### 步骤 1：创建 draft session

`session.create`

行为：

- proxy 只返回一个本地 draft session key
- browser 把它写入 session catalog，状态标记为 `draft/pending`
- 此时不拉 history

#### 步骤 1.5：WS 建连前/重连后预同步（普通 session 与渠道 session一致）

`sync.bootstrap`（连接层内部动作，可通过 proxy 或 web 端 transport 实现）

行为：

- 在 WS 首次连接前，先同步一次：
  - agent 列表快照
  - session 列表快照
  - 已活跃 session 的详情快照（transcript + 最新 seq/cursor/watermark）
- 在 WS 每次重连后重复同样预同步，覆盖本地基线
- 预同步完成后，统一建立或恢复流式订阅，从基线 watermark 开始接收增量

约束：

- 普通 agent session 与渠道 session 都走同一条预同步流程，不做两套实现
- 页面层不直接发起 chat history 拉取

#### 步骤 1.6：打开 session 的订阅语义

`session.open`

行为：

- 只负责声明“将该 session 纳入活跃订阅集合”
- 不直接触发页面层拉历史
- 如果该 session 不在当前连接周期预同步基线内，由连接层加入下一轮同步批次后再接推流

#### 步骤 2：发起 `chat.send`

browser 先尝试获取该 session 的 `send lock`。

如果锁不可用：

- 直接拒绝第二次发送
- UI 提示当前 session 已有进行中的 run

如果锁可用：

- 生成 `submitToken`
- 记录 optimistic user message
- runtime phase 进入 `sending`

#### 步骤 3：收到 send ack

条件：

- `chat.send` ack 成功

行为：

- session runtime 进入 `awaiting_stream`
- 将 `submitToken` 与 `runId` 绑定
- 如果该 session 原本是 draft，则标记为“等待 Gateway 认领”

注意：

- send ack 不是最终成功
- 它只代表 Gateway 已接受这次提交

#### 步骤 4：收到首个 chat/tool 事件

行为：

- 校验是否属于当前 active run
- runtime phase 进入 `streaming`
- 建立当前 run 的 `lastEventAt`
- tool 事件只更新 runtime tool stream，不直接写 catalog transcript

#### 步骤 5：收到 final / error / aborted

行为：

- runtime phase 不直接回 `idle`
- 先进入 `reconciling`
- 在推流完整的情况下，直接以流事件完成 run 收束
- 只在完整性检查失败时触发 `session snapshot reload`
- 收束成功后再：
  - 清理 live text
  - 清理 tool runtime
  - 清理 optimistic pending
  - 释放 send lock
  - 回到 `idle`

这一步的关键点是：终态默认由推流闭环完成，不把“每次 final 都回拉 history”作为常态；回拉是补偿路径，不是主路径。

### 5.2 三类锁的建议结构

#### A. send lock

粒度：

- `sessionKey`

目的：

- 防止同一 session 重复发送
- 防止同一 session 同时存在多个 active run

持有期：

- 从 `chat.send` 发出开始
- 直到 final reconcile 完成才释放

建议持有位置：

- browser 持有 UX 级 send lock
- proxy 持有连接级 active run registry

两层都要有，只是职责不同：

- browser 负责防抖、禁用按钮、保持当前标签页逻辑一致
- proxy 负责在多标签页或重复 command 情况下给出系统级保护

#### B. sync lock

粒度：

- `sessionKey`

目的：

- 串行化连接周期预同步与 stream 应用
- 串行化完整性失败后的重同步
- 避免“快照写入”和“增量事件应用”并发交错

规则：

- 同一 session 任一时刻只允许一个 reconcile 过程
- 如果期间又收到 `sessions.changed`、新的终态信号或 gap 信号，只合并成同一轮重同步，不重复开多次

#### C. catalog refresh coalescing lock

粒度：

- 全局或 `agentId`

目的：

- 避免下面这些动作互相打架：
  - 轮询或事件触发的 sessions 刷新
  - `sessions.changed`
  - session 打开/关闭导致的目录刷新
  - 用户切换 agent/session 时的即时 refresh

推荐做法：

- 把 session refresh 做成 coalesced task
- 维护一个“已有 refresh 在进行中”的标记
- 新触发只记脏，不重复并行请求

### 5.3 锁放在哪里

#### browser 层

持有：

- send lock
- sync lock
- 当前 session 的 runtime phase
- 当前页面的 optimistic composer state

职责：

- 交互防重
- 页面内一致性
- 把非确定性运行态限制在 view/domain 层

#### proxy 层

持有：

- `SessionRuntimeRegistry`
- 当前连接下已知的 active run 记录
- 事件归属与去重辅助信息
- reconnect 后 orphaned run 标记入口

职责：

- command 到 Gateway 的连接级协调
- 多浏览器客户端共享的最小 run 级守门
- 晚到 event 的基础归属判断
- 对外提供“这条 session 目前是否已有 active run”的系统级信息

#### Gateway 层

不由 panel 主动加锁。

职责：

- 权威事件源
- 权威 transcript / session 真相

panel 只能围绕它做本地协调，不能试图替代它。

### 5.4 必须显式处理的竞争条件

下一轮设计至少要把下面这些情况视为正常情况，而不是边缘异常。

#### send ack 成功但 stream 未开始

处理：

- session 保持 `awaiting_stream`
- 启动超时计时器
- 超时后进入可恢复错误或 `stale`
- 触发 session 级重同步（快照重抓 + 从新 watermark 恢复推流）

#### stream 已开始但 final 丢失

处理：

- 通过 `lastEventAt` 超时 + reconnect/gap/sessions.changed 信号触发重同步
- 不让 session 永久停在 `streaming`

#### final 先到、tool 后到

处理：

- final 到达后进入 `reconciling`
- 晚到 tool 不再直接写 catalog
- 若 tool 事件属于已终态 run，则只作为补充信号促发同一轮完整性检查，不直接重新展开 live view

#### reconnect 后 late event 落到旧 run

处理：

- 依赖 `runId + owner + active registry` 判断
- 如果该 run 已被标记 orphaned/completed，则忽略 live merge，仅触发必要的重同步

#### 切换 session 时旧 session 仍有流返回

处理：

- runtime state 必须按 `sessionKey` 隔离
- 当前页面只渲染当前 session
- 旧 session 的 late event 只能更新它自己的 runtime，不得污染当前 composer/live view

#### 同一 session 重复点击发送/停止

处理：

- send lock 阻止第二次 send
- abort 只有在 active run 存在且未进入终态时才允许
- 重复 abort 视为幂等请求，不重复制造状态抖动

#### session 列表轮询冲掉本地 draft/pending

处理：

- draft session 必须有正式的本地状态位
- 轮询 merge 时保留未落地的 draft
- 一旦被 Gateway 认领，再切回权威 session entry

#### 推流中断或序号不连续

处理：

- 连接层维护每个 session 的 `lastSeq` / `watermark`
- 发现不连续、重复窗口异常或断流恢复后游标不匹配时，标记 `gap_detected`
- 触发一次 session 级快照重抓，并以新 watermark 继续推流

#### WS 重连后的恢复顺序

处理：

- 先执行连接周期预同步，再恢复流订阅
- 预同步期间临时冻结 session runtime 的终态提交
- 预同步完成后按新基线继续消费推流，避免旧基线上的重复提交

## 6. 建议重构落点

### 6.1 不要继续扩当前 page/store 结构

当前 `ChatPage.tsx + store/index.ts + chatEventBridge.ts` 这套结构已经足以支撑验证版，但不适合继续吸收：

- reconnect
- gap detection
- active run registry
- session reconcile
- 多来源 refresh 合并

建议把实现拆成 4 个职责层。

### 6.2 推荐的 4 层结构

#### 1. gateway transport

职责：

- 浏览器或 proxy 到上游的连接状态
- request / response 映射
- reconnect
- pending request fail-fast
- event sequence / gap 检测

browser 侧对应：

- 当前 `panel-web/src/realtime/ws.ts` 的升级版

proxy 侧对应：

- 当前 `panel-proxy/src/gatewayClient.ts` 的连接层拆分

#### 2. event normalizer

职责：

- 把原始 Gateway event 统一成 panel 内部事件模型
- 明确区分：
  - `chat.lifecycle`
  - `chat.delta`
  - `tool.lifecycle`
  - `sessions.changed`
  - `connection.changed`

这样可以避免页面继续消费松散的 `gateway.chat` / `gateway.tool` 语义拼盘。

#### 3. chat session runtime domain

职责：

- 持有 `SessionRuntimeRegistry`
- 管理 send lock / sync lock
- 管理 active run
- 处理终态进入 reconcile
- 处理 disconnect / gap / timeout
- 统一执行“连接周期预同步 + 持续推流 + 完整性失败重同步”

这是本轮最应该新增的层。

#### 4. view store

职责：

- 只保存页面需要渲染的稳定投影
- 从 runtime domain 订阅“已经整理好的状态”
- 不自己再做 run ownership 决策

### 6.3 推荐的 public interface 变化

#### `chat.send` ack 结果建议固定

建议统一包含：

```ts
type ChatSendAck = {
  accepted: boolean
  sessionKey: string
  runId: string
  submitToken?: string
}
```

其中 `submitToken` 可以先由 browser 侧生成并原样回传，也可以由 proxy 二次生成，但最终必须有一个稳定键把：

- optimistic composer message
- 本次 send
- 当前 active run

绑定在一起。

#### `session.open` 结果建议固定

建议让 `session.open` 保持订阅语义，不承载详情快照：

```ts
type SessionOpenResult = {
  accepted: boolean
  sessionKey: string
  subscribed: boolean
  fromWatermark?: string
}
```

#### 连接周期预同步结果建议固定

```ts
type SyncBootstrapResult = {
  at: string
  agents: Array<unknown>
  sessions: Array<unknown>
  sessionSnapshots: Array<{
    sessionKey: string
    transcript: Array<unknown>
    lastSeq?: number
    watermark?: string
  }>
}
```

推流事件 envelope 建议补充：

```ts
type StreamEventEnvelope = {
  sessionKey: string
  event: string
  seq?: number
  watermark?: string
  at: string
  payload: unknown
}
```

连接层据此做完整性检查、重连恢复和重同步决策。

#### proxy 内部新增 `SessionRuntimeRegistry`

推荐至少记录：

```ts
type SessionRuntimeRegistryEntry = {
  sessionKey: string
  activeRunId?: string
  activeSubmitToken?: string
  ownerClientIds: Set<string>
  phase: "idle" | "awaiting_stream" | "streaming" | "aborting" | "reconciling"
  lastEventAt?: string
}
```

它不需要成为数据库，也不需要长期持久化，但必须成为运行期协调点。

#### browser store 新增两个显式分区

推荐新增：

- `sessionRuntimeByKey`
- `sessionSyncByKey`

当前的：

- `liveChatBySession`
- `toolStreamBySession`
- `pendingComposerBySession`

后续应逐步降级为 runtime domain 的输出，而不是直接的业务真相。

### 6.4 建议的工程落地顺序

#### Phase 1：先把状态机和锁补出来

不改外部协议外观，只补内部结构：

- 显式 session runtime phase
- browser send lock
- browser sync lock
- proxy `SessionRuntimeRegistry`
- `draft session` 的正式状态位

#### Phase 2：补 gap / disconnect / reconcile

重点补：

- 浏览器 reconnect
- proxy reconnect 后 orphaned run 标记
- 连接周期预同步（首次连/重连）
- event gap 检测
- stream 完整性检查（seq/cursor/watermark）
- 完整性失败后的 session 快照重同步
- `sessions.changed` 或等价 catalog refresh 流程

#### Phase 3：裁掉旧的启发式拼装逻辑

最后再去掉：

- 过度依赖 `commitLiveChat()` 的本地 transcript 合并
- 多处 scattered pending/live/tool 直接互相写入
- 轮询和终态刷新之间的重复逻辑

## 7. 迁移与验收

### 7.1 三阶段迁移计划

#### Phase 1：稳定 active run 与本地状态边界

交付目标：

- 同一 session 无法并发发起第二个 active run
- draft session 语义明确
- 页面不再仅靠按钮禁用表示忙碌

完成标志：

- store 中出现显式 runtime phase
- proxy 中出现最小 `SessionRuntimeRegistry`
- send / abort 基于 active run 状态判断

#### Phase 2：稳定同步流程

交付目标：

- disconnect / reconnect 后不会长期悬挂
- final / gap / timeout 都能收敛到可验证的一致状态

完成标志：

- 有“连接周期预同步 + 持续推流”主路径
- 有完整性失败时的 session 重同步策略
- 有 sessions refresh 合并策略
- 有 orphaned run 清理策略

#### Phase 3：稳定长期结构

交付目标：

- catalog state 与 runtime state 职责边界清晰
- 页面只消费整理后的 domain 输出
- 现有 scattered 临时状态不再彼此直接耦合

完成标志：

- `ChatPage` 明显瘦身
- event bridge 从“直接写 store”转成“驱动 runtime domain”
- 本地 transcript 拼装被缩减到只承担过渡职责

### 7.2 验收标准

最终验收至少应满足下面 5 条。

#### 1. 同一 session 无法并发发起第二个 active run

无论是重复点击、键盘快速提交，还是多标签页重复发起，都应被约束到单 active run。

#### 2. 断线 / 重连后不会留下永久 streaming 态

所有 orphaned run 都必须进入：

- `stale`
- `reconciling`
- 或明确失败态

不能无限停在 `awaiting_stream` 或 `streaming`。

#### 3. tool stream 与 assistant final 不会重复或错挂

不能出现：

- tool card 属于旧 run 却挂到新 run
- final message 重复入 transcript
- session 排序被旧 run 的 late event 污染

#### 4. session 列表、history、runtime 临时态边界清晰

表现为：

- catalog 只接受列表快照写入
- runtime 只保存未收敛的运行态
- session 详情采用“连接周期预同步 + 后续推流”
- composer 只负责 optimistic 体验

#### 5. draft session 的生命周期可解释、可恢复、可清理

必须能明确回答：

- 什么时候算 draft
- 什么时候被 Gateway 认领
- 什么时候允许被轮询保留
- 什么时候可以安全清理

## 测试场景

后续重构至少需要覆盖下面这些场景。

### 1. 新建 draft session 后立即发送首条消息

预期：

- draft session 可见
- send ack 成功
- stream 开始
- final 到达后由推流闭环收束
- runtime 清空并回到 `idle`

### 2. 首条消息 ack 成功，但 10 秒内无 stream

预期：

- session 从 `awaiting_stream` 进入可恢复错误或 `stale`
- 触发 reconcile
- 不永久卡死

### 3. streaming 中收到 tool 事件，再收到 final

预期：

- tool 先只显示为 runtime card
- final 后进入 reconcile
- 在流完整情况下不触发回拉，直接收束为一致状态

### 4. streaming 中断线

预期：

- 当前 run 被标记 orphaned 或 stale
- reconnect 后触发 reconcile
- 页面不永久显示 streaming

### 5. final 事件丢失，但后续 `sessions.changed` 到达

预期：

- 系统能识别 catalog 已变化
- 触发 session 快照重同步
- runtime 清空

### 6. 打开渠道 session 后的同步模式

预期：

- 打开时只声明订阅，不直接拉详情
- 在当前连接周期预同步已包含该 session 的情况下直接接推流
- 若不在当前预同步基线内，进入连接层同步批次后再接推流
- 后续仅接收推流
- 不主动轮询该 session 的 chat history
- 若推流断开或序号异常，触发一次重同步再继续推流

### 7. 同一 session 快速双击发送

预期：

- 第二次发送被 session send lock 拒绝
- 不会出现两个 active run

### 8. 切换到另一个 session 时旧 session 的 late event 返回

预期：

- 旧 event 只作用于旧 session runtime
- 当前页面不被污染

### 9. abort 已发出但 final 未回

预期：

- session 进入 `aborting`
- 最终由 aborted final 或 reconcile 收束

### 10. session 列表轮询刷新时存在本地 draft / pending session

预期：

- draft session 不会被误删
- 真正落地后会被权威 session 数据接管

### 11. 推流序号不连续

预期：

- 连接层识别 gap
- session 标记 `gap_detected`
- 自动触发一次快照重同步
- 恢复后继续推流，不重复渲染已处理事件

### 12. proxy 或 browser WS 关闭时存在 pending request

预期：

- 所有 pending request 都会 reject
- 不留下悬挂 promise

## 明确假设

- 本文默认服务于当前 `panel-proxy + panel-web` 首版重构。
- 并发模型固定为 `单 session 单 active run`。
- `session.create` 在上游能力不足时仍允许保留“本地 draft + 首次 send 落地”模式。
- `ClawPanel` / `openclaw-dashboard` 在当前工作环境里没有确认到可稳定引用的公开源码，因此本轮不作为核心代码依据。
- OpenClaw Control UI 与 OpenHanako 只作为结构参考，不作为需要整套复制的运行时。

## 参考来源

### 当前仓库

- `panel-web/src/store/index.ts`
- `panel-web/src/pages/ChatPage.tsx`
- `panel-web/src/realtime/chatEventBridge.ts`
- `panel-web/src/realtime/ws.ts`
- `panel-web/src/components/Shell.tsx`
- `panel-proxy/src/gatewayClient.ts`
- `panel-proxy/src/index.ts`
- `docs/10 Gateway WS 客户端数据流草案 2026-03-22.md`
- `docs/11 Panel Proxy 最小接口协议 v0.1 2026-03-22.md`
- `AGENT.md`
- `README.md`

### 外部参考

- OpenClaw Control UI `gateway.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/gateway.ts>
- OpenClaw Control UI `app-gateway.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/app-gateway.ts>
- OpenClaw Control UI `controllers/sessions.ts`
  - <https://github.com/openclaw/openclaw/blob/main/ui/src/ui/controllers/sessions.ts>
- OpenHanako 仓库
  - <https://github.com/liliMozi/openhanako>
- OpenHanako README
  - <https://github.com/liliMozi/openhanako/blob/main/README.md>
