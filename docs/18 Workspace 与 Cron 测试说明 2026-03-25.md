# Workspace 与 Cron 测试说明

更新日期 2026-03-25

本文记录本次右侧 `Workspace / Cron` 模块的测试覆盖范围和实际结果。

## 自动化测试

### Proxy API / 单元测试

命令：

```bash
cd panel-proxy
npm test
```

覆盖：

- workspace tree 读取
- workspace file 读取
- workspace save
- 路径越界拒绝
- 二进制文件拒绝
- cron list / create / patch / toggle / run / delete
- cron validate 高级字段
- `chat.inject` ack 与注入转发

结果：

- 2026-03-25 本地通过，`5 passed`

### Web 构建

命令：

```bash
cd panel-web
npm run build
```

结果：

- 2026-03-25 本地通过

### Proxy 构建

命令：

```bash
cd panel-proxy
npm run build
```

结果：

- 2026-03-25 本地通过

### 浏览器 E2E

命令：

```bash
cd panel-web
npm run test:e2e -- e2e/right-rail.spec.ts --reporter=line
```

覆盖：

- 进入 `/chat`
- 打开 workspace 文件
- CodeMirror 编辑并保存
- 重新打开验证内容已更新
- 从弹窗添加到聊天
- 创建 `main` 结构化 cron
- 创建 `isolated` 结构化 cron
- JSON 模式输入错误 JSON 并显示错误
- JSON 模式创建高级 cron
- enable / run / edit / delete cron

结果：

- 2026-03-25 本地通过，`1 passed`

## 独立 API 烟测

本轮另外起了一套独立 mock gateway + fixture proxy，直接用 `curl` 验证 HTTP 接口。

验证项：

- `GET /api/workspace/:agentId/tree`
- `GET /api/workspace/:agentId/file`
- `PUT /api/workspace/:agentId/file`
- workspace 路径越界拒绝
- `POST /api/cron/validate`
- `GET /api/cron`
- `POST /api/cron`
- `POST /api/cron/:jobId/toggle`
- `POST /api/cron/:jobId/run`
- `DELETE /api/cron/:jobId`

结果摘要：

- workspace tree 返回 `config` 和 `README.md`
- workspace file 成功读写
- `../etc/passwd` 被正确拒绝，返回 `workspace_path_invalid`
- cron validate 成功接受 `session:custom-id`、`webhook`、`deleteAfterRun`
- cron create / toggle / run / delete 全部成功

## 本次修复过的测试问题

- 对 proxy API 请求显式加了 `cache: no-store`，避免 workspace 文件重开时读到浏览器缓存
- Playwright 改为读取 CodeMirror 文档状态，而不是依赖 DOM 文本行
- 修正了弹窗内同名按钮的选择器歧义
- proxy CORS 补齐了 `PUT/PATCH/DELETE`，避免浏览器端 `DELETE` 失败为 `Failed to fetch`
