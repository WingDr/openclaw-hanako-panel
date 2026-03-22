# OpenClaw Web Control Panel 思路整理

更新日期 2026-03-21

这份文档是当前阶段的收束版。  
目标不是继续堆参考项目，而是把方向定下来，方便后续直接进入设计或开发。

## 一句话结论

做一个 web 版的 OpenClaw 控制面板。  
不用 Electron。  
把 chat 和 manage 明确拆开，用路由切换，主题统一，数据链路分层清楚。

它不该是另一个大而全运维后台。  
它应该是一个以 agent 工作流为中心的轻量控制台。

## 这次参考了什么

### 核心参考

- OpenClaw 官方 Gateway 协议
- OpenClaw 官方 Control UI
- OpenClaw session 文档
- OpenClaw ACP 文档
- ClawPanel
- openhanako

### 补充参考

- ​`vvlang/openclaw-agent-monitor`
- ​`miaoxworld/openclaw-manager`
- ​`tugcantopaloglu/openclaw-dashboard`

## 最终产品定位

定位成一个 OpenClaw 原生工作台。  
不是安装器。  
不是大杂烩系统管家。  
不是桌面壳优先的本机管理器。

核心目标只有三个。

- 更顺手地和 agent 工作
- 更结构化地管理 OpenClaw
- 支持 agent 级独立 session

## 为什么不用 Electron

当前阶段没必要。

第一，真正的核心价值不在桌面壳，而在信息架构和交互结构。  
第二，OpenClaw 本身已经有 Gateway 和 Web 控制面能力，做 web 版最贴近原生链路。  
第三，Electron 会提前把打包、更新、权限、本机桥接这些复杂度全部拉进来。

如果未来要桌面壳，可以后加。  
但第一版应该先把 web 产品做对。

## 从参考项目里各拿什么

## openhanako

借它的不是底层实现。  
借的是气质和工作台感。

适合借鉴。

- 页面氛围
- agent 工作台感
- chat 区的情绪和沉浸感
- onboarding 的温和感
- 整体视觉统一性

不建议直接照搬。

- 内部数据模型
- session 管理逻辑
- memory 与 desk 的底层结构
- app 级 manager 设计

## ClawPanel

借它的不是整套后端。  
借的是管理维度和可视化覆盖面。

适合借鉴。

- agent 管理视角
- channels skills cron config 这些管理页维度
- 结构化表单和面板布局
- 将运行态和配置态分开展示

不建议直接复刻。

- 太重的宿主机接管
- 安装器思路
- 大量 OpenClaw 之外的外围生态管理

## openclaw-agent-monitor

借它的轻量感。

适合借鉴。

- overview 页
- 状态总览卡片
- 最近会话和活动概览
- 小成本快速起一个监控页

不适合作为主体方案。  
因为它更像旁路观测，不是原生控制面。

## openclaw-manager

借它的结构规整感。

适合借鉴。

- 配置页分区
- 管理区信息架构
- 前后端职责切分

但它偏本机服务管理器，不是 agent 工作台。

## openclaw-dashboard

借它的产品化页面结构。

适合借鉴。

- 路由切分
- overview 和 detail 的层级
- live feed logs files costs 这些区域的组织方式

但不要把整个产品做成运维后台。  
不然 chat 会沦为附属页。

## 产品核心原则

## 1. chat 和 manage 必须分开

这是最重要的结论。

​`chat`​ 是工作区。  
​`manage` 是管理区。

两者主题统一。  
但任务不同。  
不要把它们塞进一个混乱首页里。

## 2. session 是一等公民

不是频道先行。  
不是 Telegram 或 QQ 先行。  
而是 session 先行。

用户应该能主动创建一个只属于某个 agent 的工作线程。  
然后围绕这个线程聊天、看工具流、挂文件、挂任务。

## 3. 原生能力优先

能直接走 OpenClaw Gateway 的地方，就不要额外包一层自己的抽象。  
尤其是。

- chat
- session
- tool stream
- presence
- 基础状态

## 4. 管理功能薄后端化

需要宿主机能力的部分，再交给一个很薄的 sidecar。  
不要让整个产品都依赖一个大而全自建后端。

## 推荐产品结构

## 一级路由

推荐就两个一级入口。

- ​`/chat`
- ​`/manage`

如果要更完整一点，可以再加一个轻首页。

- ​`/overview`
- ​`/chat`
- ​`/manage`

但我更倾向于直接把 `/manage/overview` 作为系统总览页，不必再单独造一个首页。

## `/chat` 路由职责

这里是 agent 工作台。

### 应该包含

- agent 切换
- session 列表
- 新建独立 session
- chat 主界面
- tool call 时间线
- 当前 session 元信息
- 关联文件或任务挂件

### 应该强调

- 流式输出
- 当前上下文归属感
- 和 agent 持续协作
- 比消息软件更适合长期工作

### 不该塞太多

- 大量配置表单
- 低频系统设置
- 安装和部署动作
- 宿主机诊断大杂烩

## `/manage` 路由职责

这里是结构化管理区。

### 建议子路由

- ​`/manage/overview`
- ​`/manage/agents`
- ​`/manage/sessions`
- ​`/manage/channels`
- ​`/manage/models`
- ​`/manage/skills`
- ​`/manage/cron`
- ​`/manage/logs`
- ​`/manage/config`

### 每页目标

#### `/manage/overview`

看系统是否健康。  
看 agent 是否在线。  
看最近有没有异常。  
看是否存在需要处理的配置或运行问题。

#### `/manage/agents`

管理 agent 本身。  
看 identity、workspace、模型、工具、权限、默认状态。

#### `/manage/sessions`

这里不是聊天。  
这里是检索和管理。

适合放。

- session 搜索
- 按 agent 筛选
- 最近活动
- token 和上下文占用
- 重命名归档标记
- 问题会话诊断

#### `/manage/channels`

看不同平台接入状态。  
主要是配置和健康状态。

#### `/manage/models`

管理 provider、模型、默认选择、价格和限制。

#### `/manage/skills`

查看技能来源、启用状态、配置、依赖。

#### `/manage/cron`

查看和编辑 cron jobs。  
做启停和手动触发。

#### `/manage/logs`

系统日志、Gateway 日志、关键事件流。

#### `/manage/config`

更底层的配置区。  
可以有结构化表单和高级 JSON 双模式。

## 统一主题但双区差异化

chat 和 manage 虽然分开，但不能做成两个产品。

要统一这些东西。

- 色板
- 字体
- 圆角和阴影语言
- 顶栏和侧栏骨架
- 卡片风格
- 图标体系
- 暗色模式规则

但也要允许局部气质不同。

### chat 区

更像 openhanako。  
更温和。  
更有陪伴感。  
更强调上下文和 agent 存在感。

### manage 区

更清楚。  
更理性。  
更结构化。  
更强调信息密度和可操作性。

## 数据架构建议

## 1. chat 直连 Gateway WebSocket

这是最合理的主链路。

chat 区直接使用 OpenClaw Gateway WebSocket。

主要原因。

- OpenClaw 原生就是这么工作的
- 实时流最自然
- session 和 run 的状态最完整
- 少一层转发，复杂度更低

chat 区应优先消费这类能力。

- ​`chat.send`
- ​`chat.history`
- ​`chat.abort`
- ​`chat.inject`
- ​`sessions.list`
- ​`sessions.patch`
- ​`system-presence`
- 工具流和相关事件

## 2. manage 尽量复用 Gateway 能力

manage 区并不是必须走 REST。  
很多读操作可以直接复用 Gateway。

只有这些情况再引入 sidecar。

- 宿主机文件系统操作
- 本地服务重启
- 进程级诊断
- 额外日志聚合
- 面板自己的本地偏好缓存

## 3. 只做一个薄 sidecar

这个 sidecar 应该是边缘组件，不是主系统。

职责建议限制在。

- 本地文件访问代理
- 白名单系统动作
- 非 Gateway 的额外状态采集
- 可选的本地缓存和导入导出

不要让 sidecar 变成第二个 ClawPanel 后端。

## 独立 session 设计

## 核心判断

独立 session 完全值得做。  
而且应该是这个 panel 的主卖点之一。

因为 OpenClaw 的 session 本来就不只服务于聊天平台。  
本质是 session key 到 sessionId 的映射。  
只要 key 设计合理，panel 自己就能成为一个新的会话入口。

## 推荐 session key 形式

推荐沿用 OpenClaw 既有风格。

- ​`agent:<agentId>:panel:<slug>`
- ​`agent:<agentId>:workspace:<slug>`
- ​`agent:<agentId>:task:<slug>`

例如。

- ​`agent:main:panel:daily-review`
- ​`agent:main:task:control-panel-design`
- ​`agent:research:workspace:paper-notes`

## panel 里应该怎么呈现

在 `/chat` 里把 session 当作工作线程。

用户动作应该很简单。

1. 选 agent
2. 点新建 session
3. 填名称和说明
4. 自动生成稳定 session key
5. 进入这个线程持续工作

## 这个能力适合的场景

- 长期项目线程
- 方案设计线程
- 调研线程
- 不想污染主对话的实验线程
- 某个 agent 私有上下文

## 设计注意点

- 一线程一 key
- 不把浏览器 tab 当 session
- 会话元数据可以由 panel 保存
- transcript 和 token 统计仍以 Gateway 为准

panel 可以自己补充这些展示元数据。

- title
- pinned
- tags
- icon
- archived
- lastOpenedAt

## 信息架构建议

## 顶层布局

推荐一套很稳定的骨架。

- 左侧导航
- 顶栏 agent 切换和全局状态
- 中间主工作区
- 右侧可选详情侧栏

## 左侧导航建议

### 全局区

- Chat
- Manage

### Chat 内部

- 当前 agent
- pinned sessions
- recent sessions
- create session

### Manage 内部

- Overview
- Agents
- Sessions
- Channels
- Models
- Skills
- Cron
- Logs
- Config

## 右侧详情栏建议

在 chat 区里可以做成上下文侧栏。

放这些内容。

- 当前 session 信息
- 最近 tool call
- 关联文件
- token 和 context 占用
- tags 和说明

在 manage 区里则可以做成属性面板。

## 首版范围

第一版只做最有辨识度的部分。

## 必做

- 统一主题骨架
- ​`/chat`
- ​`/manage/overview`
- ​`/manage/agents`
- ​`/manage/sessions`
- 新建独立 session
- 指定 session 聊天
- tool stream
- 基础状态展示

## 可以延后

- channels 深度配置
- skills 安装和市场
- cron 编辑器完整版
- config 高级 JSON 模式
- 系统服务管理
- 本地导入导出

## 不做或后做

- Electron
- 大量宿主机接管
- 安装器
- 第三方桥接大一统平台
- 过重的成本和运维报表

## 推荐技术选型

## 前端

- React
- TypeScript
- Vite
- TailwindCSS
- 一个轻量状态管理库，例如 Zustand

## 传输

- Gateway WebSocket 作为主链路
- sidecar REST 或本地 WS 只做补充

## UI 风格

- 整体质感参考 openhanako
- 管理页组织方式参考 openclaw-dashboard 和 openclaw-manager
- overview 的轻量聚合参考 openclaw-agent-monitor

## 开发顺序建议

## 第一阶段

先把 chat 跑通。

- Gateway 连接
- session 列表
- 新建独立 session
- chat send 和 stream
- tool stream

## 第二阶段

补 manage 基础页。

- overview
- agents
- sessions

## 第三阶段

再补高频管理能力。

- channels
- models
- skills
- cron
- logs

## 第四阶段

最后才考虑 sidecar 扩展。

- 本地文件代理
- 白名单系统动作
- 更强日志和诊断

## 最终判断

如果要做一个尽量轻量但结构化的 OpenClaw 管理页面，最正确的方向就是。

做 web。  
把 chat 和 manage 拆开。  
统一主题。  
原生能力优先。  
独立 session 做成核心能力。  
管理功能保持克制。

这样它会像一个真正的 OpenClaw 工作台。  
而不是一个越做越重的后台面板。

## 下一步最适合继续产出的文档

如果往下推进，我建议直接接这两份。

- 前端路由与页面树
- session 数据模型与 Gateway 对接草案
