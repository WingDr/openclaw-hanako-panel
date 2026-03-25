# Workspace 与 Cron 接口说明

更新日期 2026-03-25

本文聚焦当前新增的 workspace / cron / chat.inject 三条链路。

## Workspace HTTP

### `GET /api/workspace/:agentId/tree`

查询参数：

- `path` 可选，默认根目录

返回字段：

- `agentId`
- `rootPath`
- `path`
- `nodes`
- `truncated`

错误：

- `workspace_not_found`
- `workspace_path_invalid`
- `workspace_path_missing`
- `workspace_not_directory`

### `GET /api/workspace/:agentId/file`

查询参数：

- `path` 必填

返回字段：

- `agentId`
- `rootPath`
- `path`
- `content`
- `size`
- `updatedAt`

错误：

- `workspace_file_missing`
- `workspace_path_invalid`
- `workspace_not_file`
- `workspace_file_binary`
- `workspace_file_too_large`

### `PUT /api/workspace/:agentId/file`

请求体：

```json
{
  "path": "README.md",
  "content": "# title\n"
}
```

返回：

- 新的文件快照

## Chat Injection WebSocket

### `chat.inject`

请求 envelope：

```json
{
  "id": "req-1",
  "cmd": "chat.inject",
  "payload": {
    "sessionKey": "agent:mon3tr:hanako-panel:test-session",
    "message": "File: README.md\n\ncontent",
    "source": {
      "kind": "workspace-file",
      "agentId": "mon3tr",
      "path": "README.md"
    }
  }
}
```

当前前端行为：

- 整文件注入时自动加 `File: <path>`
- 选中文本注入时仍保留相同来源标识

## Cron HTTP

### `POST /api/cron/validate`

请求体二选一：

```json
{
  "job": {}
}
```

```json
{
  "patch": {}
}
```

当前校验支持：

- `schedule.kind = at | every | cron`
- `sessionTarget = main | isolated | current | session:<id>`
- `payload.kind = systemEvent | agentTurn`
- `delivery.mode = none | announce | webhook`

### `GET /api/cron`

查询参数：

- `agentId` 可选

返回：

- `jobs`

### `POST /api/cron`

请求体：

```json
{
  "job": {
    "name": "Main heartbeat",
    "agentId": "mon3tr",
    "enabled": true,
    "schedule": {
      "kind": "every",
      "everyMs": 3600000
    },
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": {
      "kind": "systemEvent",
      "text": "hello"
    },
    "delivery": {
      "mode": "none"
    }
  }
}
```

### `PATCH /api/cron/:jobId`

请求体：

```json
{
  "patch": {
    "enabled": false
  }
}
```

### `POST /api/cron/:jobId/toggle`

请求体：

```json
{
  "enabled": false
}
```

### `POST /api/cron/:jobId/run`

无请求体。

### `DELETE /api/cron/:jobId`

无请求体。

## 结构化表单到 Gateway shape 的映射

### `main`

结构化表单会生成：

```json
{
  "sessionTarget": "main",
  "payload": {
    "kind": "systemEvent",
    "text": "..."
  }
}
```

### `isolated`

结构化表单会生成：

```json
{
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "...",
    "model": "optional",
    "thinking": "optional",
    "timeoutSeconds": 30,
    "lightContext": true
  }
}
```
