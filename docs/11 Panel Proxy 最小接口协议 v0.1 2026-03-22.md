# OpenClaw Panel Proxy 最小接口协议 v0.1

更新日期 2026-03-22

这份文档把局域网 HTTP 模式下的 panel proxy 最小接口协议固定成一个可以直接编码的 v0.1 草案。

目标不是设计一个“大而全后端”，
而是给 MVP 提供：

- 页面初始化 HTTP 接口
- chat / logs / status 的最小 WebSocket 协议
- 基本错误模型
- 统一 envelope 结构

## 一句话结论

panel proxy v0.1 只需要提供：

- 5 个 HTTP 接口
- 1 条浏览器 WebSocket 通道
- 6 个 WebSocket 命令
- 8 个 WebSocket 事件

只覆盖 chat、logs、status 三条主线。

## 一、设计原则

### 1. Proxy 必须足够薄

它是适配层，不是新的权威控制面。

### 2. HTTP 负责初始化与普通读取

不要把所有东西都塞进 WS。

### 3. WS 负责所有实时能力

chat、logs、连接状态走一条统一实时通道。

### 4. 状态真相仍在 Gateway

proxy 只缓存少量运行期状态和 panel 自己的轻元数据。

## 二、MVP 覆盖范围

## HTTP

- `GET /api/bootstrap`
- `GET /api/agents`
- `GET /api/agents/:agentId/sessions`
- `GET /api/status`
- `GET /api/logs/snapshot`

## WebSocket 命令

- `chat.send`
- `chat.abort`
- `session.create`
- `session.open`
- `logs.subscribe`
- `logs.unsubscribe`

## WebSocket 事件

- `chat.started`
- `chat.delta`
- `chat.done`
- `chat.error`
- `logs.append`
- `logs.reset`
- `system.connection`
- `status.snapshot`

## 三、HTTP 协议

## 1. `GET /api/bootstrap`

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

## 2. `GET /api/agents`

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
      "status": "online"
    },
    {
      "agentId": "research",
      "label": "Research",
      "status": "idle"
    }
  ]
}
```

## 3. `GET /api/agents/:agentId/sessions`

### 作用

返回某个 agent 下的 session 列表。

### 响应示例

```json
{
  "ok": true,
  "data": [
    {
      "sessionKey": "agent:main:panel:daily-review",
      "agentId": "main",
      "updatedAt": "2026-03-22T10:00:00Z",
      "preview": "继续整理 panel 的实现步骤"
    }
  ]
}
```

## 4. `GET /api/status`

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
        "status": "online",
        "lastSeenAt": "2026-03-22T09:59:59Z"
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
        "sessionKey": "agent:main:panel:daily-review",
        "agentId": "main",
        "updatedAt": "2026-03-22T10:00:00Z"
      }
    ]
  }
}
```

## 5. `GET /api/logs/snapshot`

### 作用

返回日志页初始快照。

### 查询参数建议

- `limit`，默认 `200`
- `level`，可选
- `search`，可选

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

## 四、统一 HTTP 响应格式

建议所有 HTTP 响应都统一成：

```ts
type HttpOk<T> = {
  ok: true;
  data: T;
};

type HttpError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
```

这样前端接起来最简单。

## 五、浏览器 WebSocket 协议

## 统一 envelope

### 浏览器发命令

```json
{
  "id": "req_123",
  "type": "cmd",
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:panel:daily-review",
    "text": "继续整理 panel 方案"
  }
}
```

### proxy 回 ack

```json
{
  "id": "req_123",
  "type": "ack",
  "ok": true,
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
  "event": "chat.delta",
  "topic": "session:agent:main:panel:daily-review",
  "payload": {
    "runId": "run_abc",
    "delta": "好的，我们先从页面树开始。"
  }
}
```

## 六、WebSocket 命令定义

## 1. `chat.send`

### 参数

```json
{
  "sessionKey": "agent:main:panel:daily-review",
  "text": "继续整理 panel 方案"
}
```

### ack 结果

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

### ack 结果

```json
{
  "accepted": true
}
```

## 3. `session.create`

### 作用

为某个 agent 创建一个 panel session。

### 参数

```json
{
  "agentId": "main",
  "slug": "daily-review",
  "title": "Daily Review"
}
```

### proxy 侧规则

- `kind` 默认固定为 `panel`
- 生成 `sessionKey = agent:<agentId>:panel:<slug>`
- 若 session 已存在，返回同一个 key，但要显式说明是否复用

### ack 结果

```json
{
  "accepted": true,
  "sessionKey": "agent:main:panel:daily-review",
  "created": true
}
```

## 4. `session.open`

### 作用

让 proxy 开始关注某个 session 的流式事件，必要时补充历史。

### 参数

```json
{
  "sessionKey": "agent:main:panel:daily-review"
}
```

### ack 结果

```json
{
  "accepted": true,
  "sessionKey": "agent:main:panel:daily-review"
}
```

## 5. `logs.subscribe`

### 参数

```json
{
  "source": "gateway",
  "follow": true,
  "levels": ["info", "warn", "error"]
}
```

### proxy 侧规则

- 第一个订阅者进入时启动 poller
- 后续订阅者复用同一个 poller

### ack 结果

```json
{
  "accepted": true,
  "topic": "logs:gateway"
}
```

## 6. `logs.unsubscribe`

### 参数

```json
{
  "source": "gateway"
}
```

### ack 结果

```json
{
  "accepted": true
}
```

## 七、WebSocket 事件定义

## 1. `chat.started`

```json
{
  "type": "event",
  "event": "chat.started",
  "topic": "session:agent:main:panel:daily-review",
  "payload": {
    "runId": "run_abc",
    "sessionKey": "agent:main:panel:daily-review"
  }
}
```

## 2. `chat.delta`

```json
{
  "type": "event",
  "event": "chat.delta",
  "topic": "session:agent:main:panel:daily-review",
  "payload": {
    "runId": "run_abc",
    "delta": "好的，我们先从页面树开始。"
  }
}
```

## 3. `chat.done`

```json
{
  "type": "event",
  "event": "chat.done",
  "topic": "session:agent:main:panel:daily-review",
  "payload": {
    "runId": "run_abc",
    "messageId": "msg_123"
  }
}
```

## 4. `chat.error`

```json
{
  "type": "event",
  "event": "chat.error",
  "topic": "session:agent:main:panel:daily-review",
  "payload": {
    "runId": "run_abc",
    "error": {
      "code": "gateway_error",
      "message": "upstream request failed"
    }
  }
}
```

## 5. `logs.append`

```json
{
  "type": "event",
  "event": "logs.append",
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
  "topic": "logs:gateway",
  "payload": {
    "reason": "cursor-invalid"
  }
}
```

## 7. `system.connection`

```json
{
  "type": "event",
  "event": "system.connection",
  "topic": "system",
  "payload": {
    "connected": true,
    "state": "connected",
    "updatedAt": "2026-03-22T10:00:00Z"
  }
}
```

## 8. `status.snapshot`

```json
{
  "type": "event",
  "event": "status.snapshot",
  "topic": "status",
  "payload": {
    "gateway": {
      "connected": true
    },
    "agents": [],
    "channels": [],
    "recentSessions": []
  }
}
```

## 八、错误协议

## ack 错误

命令执行失败时，proxy 返回：

```json
{
  "id": "req_123",
  "type": "ack",
  "ok": false,
  "error": {
    "code": "invalid_params",
    "message": "sessionKey is required"
  }
}
```

## 全局错误事件

如果是异步过程中的非命令型错误，可以推送：

```json
{
  "type": "event",
  "event": "chat.error",
  "topic": "session:agent:main:panel:daily-review",
  "payload": {
    "error": {
      "code": "upstream_disconnected",
      "message": "gateway disconnected during streaming"
    }
  }
}
```

## 推荐错误码

- `invalid_params`
- `unauthorized`
- `gateway_disconnected`
- `gateway_timeout`
- `gateway_error`
- `session_conflict`
- `internal_error`

## 九、Proxy 内部模块映射

这个协议对应到 proxy 内部，最少需要 4 个模块。

## 1. `gatewayClient`

- 连接 Gateway
- 发 RPC
- 收 event

## 2. `browserWsHub`

- 维护浏览器 WS 连接
- 解析 cmd
- 回 ack
- 广播 event

## 3. `logsService`

- 维护 `logs.subscribe` 订阅关系
- 轮询 `logs.tail`
- 推 `logs.append` / `logs.reset`

## 4. `statusService`

- 定时拉 `status`
- 推 `status.snapshot`

## 十、请求到上游的映射建议

## `chat.send`

- proxy -> Gateway `chat.send`

## `chat.abort`

- proxy -> Gateway `chat.abort`

## `session.create`

- proxy 本地生成 session key
- 若需要则调用 sessions 相关能力打开上下文

## `session.open`

- proxy 拉一次 history 或建立关注关系

## `logs.subscribe`

- proxy 不立即向上游建立订阅协议
- 而是通过内部 poller 周期调用 `logs.tail`

## `status` 系列

- proxy 通过周期性读取 Gateway 状态生成快照

## 十一、完成标准

实现层满足下面这些条件，就说明 v0.1 协议足够可用：

1. 前端能只靠这 5 个 HTTP 接口完成页面初始化
2. 前端能只靠这 1 条 WS 通道完成 chat、logs、status 实时能力
3. session 创建与打开链路跑通
4. logs 订阅支持多浏览器连接复用
5. Gateway 断连时前端能收到明确连接状态
6. 不需要额外引入第二套 SSE 协议

## 十二、下一版扩展点

v0.1 跑通后，再考虑进入 v0.2：

- `GET /api/chat/:sessionKey/history`
- `GET /api/sessions/:sessionKey/meta`
- `PUT /api/sessions/:sessionKey/meta`
- `tool.updated` 事件
- `session.updated` 事件
- channels / models / skills / cron / config 接口

## 结论

panel proxy v0.1 的核心不是接口多，
而是：

- HTTP 和 WS 分工明确
- envelope 统一
- chat / logs / status 三条主线都能闭环
- 不把 proxy 变成第二个 OpenClaw 后端

只要先把这版协议做对，后面扩功能会非常顺。
