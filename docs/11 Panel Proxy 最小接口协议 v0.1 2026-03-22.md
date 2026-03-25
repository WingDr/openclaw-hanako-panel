# OpenClaw Panel Proxy 最小接口协议

更新日期 2026-03-25

这份文档用于把当前仓库里已经实现的 `panel-proxy` HTTP / WebSocket 协议固定下来。

虽然文件名还保留了早期的 `v0.1` 历史标记，
但文档内容已经按当前代码实现修正，
应以本文为准。

目标不是设计一个“大而全后端”，
而是固定当前可用的：

- 浏览器登录与基础鉴权
- 页面初始化 HTTP 接口
- chat / logs 的最小 WebSocket 协议
- 基本错误模型
- 统一 envelope 结构

## 一句话结论

当前实现提供：

- 3 个公开认证 HTTP 接口
- 6 个受保护业务 HTTP 接口
- 1 条浏览器 WebSocket 通道
- 8 个 WebSocket 命令
- 7 个当前实际会推送的 WebSocket 事件
- 1 个已预留但当前未主动推送的事件类型

## 一、设计原则

### 1. Proxy 仍然必须足够薄

它是适配层，不是新的权威控制面。

### 2. HTTP 负责初始化与普通读取

不要把所有数据获取都塞进 WS。

### 3. WS 负责实时能力与同步补偿

chat、logs、连接状态以及必要的 sync 提示走一条统一实时通道。

### 4. 鉴权边界收在 proxy

浏览器不持有长期 machine secret。

### 5. 状态真相仍在 Gateway

proxy 只缓存少量运行期状态、短期 session 和少量同步辅助信息。

## 二、鉴权模型

当前 `panel-proxy` 采用双轨鉴权：

- 浏览器用户：
  - `POST /api/auth/login`
  - 输入 panel 明文密码
  - proxy 用 `PANEL_LOGIN_PASSWORD_HASH` 做 `scrypt` 校验
  - 成功后签发短期 `HttpOnly` session cookie
- 脚本 / curl / 集成测试：
  - `Authorization: Bearer <PANEL_PROXY_API_TOKEN>`

公开接口只有：

- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/logout`

其余所有业务 HTTP 接口和 `/ws` 都必须满足以下之一：

- 带有效 session cookie
- 带有效 Bearer API token

## 三、当前覆盖范围

## HTTP

### 公开认证接口

- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### 受保护业务接口

- `GET /api/bootstrap`
- `GET /api/agents`
- `GET /api/agents/:agentId/sessions`
- `GET /api/chat/:sessionKey/history`
- `GET /api/status`
- `GET /api/logs/snapshot`

## WebSocket 命令

- `chat.send`
- `chat.abort`
- `chat.inject`
- `session.create`
- `session.open`
- `sync.bootstrap`
- `logs.subscribe`
- `logs.unsubscribe`

## WebSocket 事件

### 当前实际会推送

- `gateway.chat`
- `gateway.tool`
- `gateway.session`
- `chat.sync.required`
- `logs.append`
- `logs.reset`
- `system.connection`

### 已在类型中预留，但当前未主动推送

- `status.snapshot`

## 四、HTTP 协议

## 1. `GET /api/auth/me`

### 作用

返回当前浏览器会话的鉴权状态。

### 响应示例

```json
{
  "ok": true,
  "data": {
    "enabled": true,
    "requiresAuth": true,
    "authenticated": false,
    "loginEnabled": true,
    "apiTokenEnabled": true
  }
}
```

已登录时会额外返回：

```json
{
  "expiresAt": "2026-03-25T17:33:45.192Z"
}
```

## 2. `POST /api/auth/login`

### 作用

用 panel 明文密码登录浏览器会话。

### 请求体

```json
{
  "password": "plain-text-password"
}
```

### 成功响应

```json
{
  "ok": true,
  "data": {
    "enabled": true,
    "requiresAuth": true,
    "authenticated": true,
    "loginEnabled": true,
    "apiTokenEnabled": true,
    "expiresAt": "2026-03-25T17:33:45.192Z"
  }
}
```

同时响应头会写入：

- `Set-Cookie: panel_proxy_session=...; HttpOnly; SameSite=Strict; Path=/`

### 失败情况

- panel 密码错误：`401 unauthorized`
- proxy 开启了鉴权但未配置 `PANEL_LOGIN_PASSWORD_HASH`：`503 login_unavailable`

## 3. `POST /api/auth/logout`

### 作用

退出当前浏览器会话并清理 session cookie。

### 成功响应

```json
{
  "ok": true,
  "data": {
    "enabled": true,
    "requiresAuth": true,
    "authenticated": false,
    "loginEnabled": true,
    "apiTokenEnabled": true
  }
}
```

## 4. `GET /api/bootstrap`

### 作用

返回前端启动所需的最小全局信息。

### 响应示例

```json
{
  "ok": true,
  "data": {
    "proxyVersion": "0.1.0",
    "gateway": {
      "connected": true,
      "mode": "proxy"
    },
    "defaultAgentId": "main",
    "features": {
      "chat": true,
      "logs": true,
      "status": true
    }
  }
}
```

## 5. `GET /api/agents`

### 作用

返回 agent 列表。

### 响应示例

```json
{
  "ok": true,
  "data": [
    {
      "agentId": "main",
      "label": "Main",
      "status": "online",
      "capabilities": []
    }
  ]
}
```

## 6. `GET /api/agents/:agentId/sessions`

### 作用

返回某个 agent 下的 session 列表。

### 响应示例

```json
{
  "ok": true,
  "data": [
    {
      "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
      "agentId": "main",
      "updatedAt": "2026-03-22T10:00:00Z",
      "preview": "继续整理 panel 的实现步骤",
      "status": "opened"
    }
  ]
}
```

## 7. `GET /api/chat/:sessionKey/history`

### 作用

返回指定 session 的 transcript 历史。

### 响应示例

```json
{
  "ok": true,
  "data": [
    {
      "messageId": "msg_123",
      "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
      "kind": "assistant",
      "createdAt": "2026-03-22T10:00:00Z",
      "text": "好的，我们继续。",
      "status": "complete"
    }
  ]
}
```

## 8. `GET /api/status`

### 作用

返回状态页快照。

### 响应示例

```json
{
  "ok": true,
  "data": {
    "gateway": {
      "connected": true,
      "lastUpdatedAt": "2026-03-22T10:00:00Z"
    },
    "agents": [
      {
        "agentId": "main",
        "label": "Main",
        "status": "online",
        "capabilities": []
      }
    ],
    "channels": [
      {
        "channelKey": "telegram",
        "status": "connected",
        "summary": "1 bot"
      }
    ],
    "recentSessions": [
      {
        "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
        "agentId": "main",
        "updatedAt": "2026-03-22T10:00:00Z",
        "preview": "Daily review",
        "status": "opened"
      }
    ]
  }
}
```

## 9. `GET /api/logs/snapshot`

### 作用

返回日志页初始快照。

### 当前实现

- 当前固定读取最近 100 行
- 当前没有开放 `limit` / `level` / `search` 查询参数

### 响应示例

```json
{
  "ok": true,
  "data": {
    "cursor": 12345,
    "lines": [
      {
        "ts": "2026-03-22T10:00:00Z",
        "level": "info",
        "text": "gateway connected"
      }
    ]
  }
}
```

## 五、统一 HTTP 响应格式

```ts
type HttpOk<T> = {
  ok: true
  data: T
}

type HttpError = {
  ok: false
  error: {
    code: string
    message: string
  }
}
```

## 六、浏览器 WebSocket 协议

## 统一 envelope

### 浏览器发命令

当前实现使用：

```json
{
  "id": "req_123",
  "type": "cmd",
  "cmd": "chat.send",
  "payload": {
    "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
    "text": "继续整理 panel 方案"
  }
}
```

注意：

- 字段名是 `cmd`
- 参数字段是 `payload`
- 不是旧稿里的 `method` / `params`

### proxy 回 ack

当前实现：

```json
{
  "id": "req_123",
  "type": "ack",
  "ok": true,
  "action": "chat.send",
  "result": {
    "accepted": true,
    "runId": "run_abc"
  }
}
```

### proxy 主动推事件

```json
{
  "type": "event",
  "event": "gateway.chat",
  "kind": "chat",
  "topic": "session:agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "at": "2026-03-25T05:34:20.219Z",
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "runId": "run_abc",
  "payload": {
    "...": "..."
  }
}
```

## 七、WebSocket 命令定义

## 1. `chat.send`

### 参数

```json
{
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "text": "继续整理 panel 方案",
  "idempotencyKey": "optional-idempotency-key"
}
```

兼容参数：

- `message` 可作为 `text` 的别名
- `sessionId` 可作为 `sessionKey` 的别名

### ack 结果

结果由上游 `sendChatMessage()` 返回，当前至少可能包含：

```json
{
  "accepted": true,
  "runId": "run_abc"
}
```

## 2. `chat.abort`

### 参数

```json
{
  "runId": "run_abc"
}
```

也可以：

```json
{
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000"
}
```

兼容参数：

- `sessionId` 可作为 `sessionKey` 的别名

### ack 结果

由上游 `abortChatRun()` 返回，当前协议不额外包一层 `accepted`。

## 3. `chat.inject`

### 当前状态

已保留命令名，但当前未实现。

### ack 错误

```json
{
  "id": "req_123",
  "type": "ack",
  "ok": false,
  "action": "chat.inject",
  "error": {
    "code": "unsupported",
    "message": "chat.inject is not implemented yet"
  }
}
```

## 4. `session.create`

### 作用

为某个 agent 创建一个 panel session。

### 参数

```json
{
  "agentId": "main",
  "title": "Daily Review"
}
```

### proxy 侧规则

- 由 proxy 生成 `sessionKey = agent:<agentId>:hanako-panel:<uuid>`
- `session.create` 只准备一个 panel 本地 session
- 真正上下文创建依赖后续第一次 `chat.send`

### ack 结果

```json
{
  "accepted": true,
  "created": true,
  "session": {
    "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
    "agentId": "main",
    "preview": "New Hanako panel session",
    "updatedAt": "2026-03-23T12:00:00.000Z",
    "status": "pending"
  }
}
```

## 5. `session.open`

### 作用

让 proxy 开始关注某个 session 的流式事件，并建立 session 订阅关系。

### 参数

```json
{
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000"
}
```

兼容参数：

- `sessionId` 可作为 `sessionKey` 的别名

### ack 结果

```json
{
  "accepted": true,
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "subscribed": true
}
```

## 6. `sync.bootstrap`

### 作用

在连接恢复、页面切换或本地状态需要补偿时，批量拉取 catalog 与 transcript 快照。

### 参数

```json
{
  "includeCatalog": true,
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "sessionKeys": [
    "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000"
  ]
}
```

### ack 结果

```json
{
  "accepted": true,
  "at": "2026-03-25T05:34:20.219Z",
  "agents": [],
  "sessions": [],
  "sessionSnapshots": [
    {
      "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
      "transcript": [],
      "lastSeq": 12,
      "watermark": "2026-03-25T05:34:20.219Z"
    }
  ]
}
```

失败时单个 session 也可能返回：

```json
{
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "transcript": [],
  "error": "history fetch failed"
}
```

## 7. `logs.subscribe`

### 参数

当前实现忽略 payload，空对象即可：

```json
{}
```

### ack 结果

```json
{
  "accepted": true,
  "topic": "logs:gateway"
}
```

## 8. `logs.unsubscribe`

### 参数

当前实现忽略 payload，空对象即可：

```json
{}
```

### ack 结果

```json
{
  "accepted": true
}
```

## 八、WebSocket 事件定义

## 1. `gateway.chat`

### 说明

proxy 把 Gateway chat 相关事件归一化后向浏览器转发。

### 当前实现特点

- `payload` 保留上游字段
- proxy 会附加同步辅助字段，例如：
  - `proxySeq`
  - `proxySessionSeq`
  - `proxyWatermark`
  - `proxyNodeId`
  - `proxyNodeKind`
  - `proxyNodeOrder`

### 示例

```json
{
  "type": "event",
  "event": "gateway.chat",
  "kind": "chat",
  "topic": "session:agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "at": "2026-03-25T05:34:20.219Z",
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "runId": "run_abc",
  "payload": {
    "phase": "streaming",
    "proxySeq": 10,
    "proxySessionSeq": 7
  }
}
```

## 2. `gateway.tool`

### 说明

proxy 把 Gateway tool 相关事件归一化后向浏览器转发。

### 示例

```json
{
  "type": "event",
  "event": "gateway.tool",
  "kind": "tool",
  "topic": "session:agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000:tool:call_1",
  "at": "2026-03-25T05:34:20.219Z",
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "runId": "run_abc",
  "payload": {
    "toolName": "bash",
    "status": "running",
    "proxySeq": 11
  }
}
```

## 3. `gateway.session`

### 说明

proxy 把 session 级 Gateway 事件归一化后广播给所有连接。

### 示例

```json
{
  "type": "event",
  "event": "gateway.session",
  "kind": "session",
  "topic": "session:agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "at": "2026-03-25T05:34:20.219Z",
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "state": "updated"
  }
}
```

## 4. `chat.sync.required`

### 说明

当 proxy 发现运行态与上游流存在不一致风险时，通知前端重新做同步补偿。

### 示例

```json
{
  "type": "event",
  "event": "chat.sync.required",
  "kind": "sync",
  "topic": "session:agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "at": "2026-03-25T05:34:20.219Z",
  "sessionKey": "agent:main:hanako-panel:550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "reason": "terminal-run-mismatch",
    "activeRunId": "run_old",
    "receivedRunId": "run_new"
  }
}
```

## 5. `logs.append`

```json
{
  "type": "event",
  "event": "logs.append",
  "kind": "logs",
  "topic": "logs:gateway",
  "payload": {
    "cursor": 12346,
    "lines": [
      {
        "ts": "2026-03-22T10:00:01Z",
        "level": "info",
        "text": "new log line"
      }
    ]
  }
}
```

## 6. `logs.reset`

```json
{
  "type": "event",
  "event": "logs.reset",
  "kind": "logs",
  "topic": "logs:gateway",
  "payload": {
    "reason": "cursor-invalid"
  }
}
```

## 7. `system.connection`

### 说明

当前实现会用于：

- proxy 在 WS 建连成功后主动发一次 gateway 连接快照
- logs 流状态变化时推送 gateway 连接状态
- panel-web 本地连接层也会自行发一份前端侧的 `system.connection`

### proxy 侧示例

```json
{
  "type": "event",
  "event": "system.connection",
  "kind": "system",
  "topic": "gateway",
  "at": "2026-03-25T05:34:20.219Z",
  "payload": {
    "source": "gateway",
    "connected": false,
    "at": "2026-03-25T05:34:20.219Z",
    "message": "Gateway logs client idle"
  }
}
```

## 8. `status.snapshot`

### 当前状态

类型中已保留，但当前 `panel-proxy` 代码没有主动推送这个事件。

状态页当前仍以：

- `GET /api/status`

为主。

## 九、错误协议

## HTTP 错误

当前已经稳定使用：

- `unauthorized`
- `login_unavailable`

示例：

```json
{
  "ok": false,
  "error": {
    "code": "unauthorized",
    "message": "Authentication required"
  }
}
```

## ack 错误

命令执行失败时，proxy 返回：

```json
{
  "id": "req_123",
  "type": "ack",
  "ok": false,
  "action": "chat.send",
  "error": {
    "code": "invalid_params",
    "message": "chat.send requires sessionKey and message"
  }
}
```

## 当前常见错误码

- `invalid_json`
- `invalid_params`
- `unauthorized`
- `unsupported`
- `login_unavailable`
- `gateway_error`
- `session_conflict`
- `internal_error`

## 十、当前协议与早期草案的主要差异

和早期草稿相比，当前实现有这些重要变化：

1. 浏览器 WS 命令 envelope 已从 `method/params` 改为 `cmd/payload`
2. ack 里新增了 `action`
3. HTTP 侧新增并落地了浏览器鉴权接口
4. 受保护 HTTP 接口新增 `GET /api/chat/:sessionKey/history`
5. WS 命令新增 `chat.inject`（保留但未实现）
6. WS 命令新增 `sync.bootstrap`
7. chat 事件已从旧稿里的 `chat.started/chat.delta/chat.done/chat.error` 收敛为：
   - `gateway.chat`
   - `gateway.tool`
   - `gateway.session`
   - `chat.sync.required`
8. `status.snapshot` 目前仍在类型里，但当前实现未主动推送
9. `logs.snapshot` 当前未开放 query 参数

## 十一、完成标准

实现层满足下面这些条件，就说明当前协议足够可用：

1. 前端能靠 `GET /api/auth/me` 判断登录态
2. 浏览器能通过 `POST /api/auth/login` 登录并获得 session cookie
3. 脚本能通过 Bearer token 单独调用受保护 API
4. 前端能靠受保护 HTTP 接口完成页面初始化
5. 前端能靠一条 WS 通道完成 chat / logs 实时能力
6. `session.create`、`session.open`、`sync.bootstrap` 三条同步链路跑通
7. logs 订阅支持多浏览器连接复用
8. Gateway 断连时前端能收到明确连接状态

## 结论

当前 `panel-proxy` 协议的核心不是接口多，
而是：

- 浏览器和脚本的鉴权方式已经明确
- HTTP 和 WS 分工明确
- envelope 已统一到当前实现
- chat / logs / status 三条主线都能闭环
- 不把 proxy 变成第二个 OpenClaw 后端

后续如果继续扩展，应该在保持这套边界的前提下追加能力，而不是重新发明第二套协议。
