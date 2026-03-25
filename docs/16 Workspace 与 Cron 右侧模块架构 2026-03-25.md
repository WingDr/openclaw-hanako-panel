# Workspace 与 Cron 右侧模块架构

更新日期 2026-03-25

这份文档用于固定 `/chat` 右侧 rail 的当前实现，不再把右侧区域视作保留空间。

## 一句话结论

当前右侧 rail 已固定为：

- 上半区 `Workspace`
- 下半区 `Cron`

并且两块都按 2x2 模块拆分：

- web `WorkspacePanelModule`
- proxy workspace API
- web `CronPanelModule`
- proxy cron API

## 模块拆分

前端当前目录收口到 `panel-web/src/features/`：

- `features/chat-flow`
- `features/workspace`
- `features/cron`
- `features/logs`
- `features/rail`

### Web

- `WorkspacePanelModule`
  - 文件树浏览
  - 搜索
  - 打开文件
  - 添加到聊天
- `WorkspaceEditorDialog`
  - CodeMirror 编辑
  - 保存
  - 选中片段注入
- `CronPanelModule`
  - cron 列表
  - 启停
  - 立即运行
  - 新建入口
- `CronConfigDialog`
  - 结构化模式
  - JSON 模式
  - 保存、删除、切换启停

### Proxy

- workspace service
  - workspace 根路径解析
  - 路径越界校验
  - 树扫描
  - 文件读写
  - 二进制 / 大文件限制
- cron service
  - Gateway cron 适配
  - Zod schema 校验
  - create / patch / run / toggle / delete
- browser ws bridge
  - `chat.inject`

## 数据流

### Workspace

1. web 读取 `GET /api/workspace/:agentId/tree`
2. 选中文件后读取 `GET /api/workspace/:agentId/file`
3. 弹窗中使用 CodeMirror 编辑
4. 保存时调用 `PUT /api/workspace/:agentId/file`
5. 添加到聊天时调用浏览器 WS `chat.inject`
6. 注入成功后刷新当前 session transcript

### Cron

1. web 读取 `GET /api/cron?agentId=<id>`
2. 新建或编辑时打开 `CronConfigDialog`
3. 结构化模式只生成两类主路径：
   - `main -> systemEvent`
   - `isolated -> agentTurn`
4. JSON 模式允许完整 Gateway shape
5. 保存前先走 `POST /api/cron/validate`
6. 再调用 create / patch / toggle / run / delete 对应接口

## UI 选型

- 文件树：`react-complex-tree`
- 编辑器：`@uiw/react-codemirror`

选型原因：

- 文件树需要窄 rail 场景下的可访问树组件，而不是重型文件管理器
- CodeMirror 同时覆盖文件编辑和 cron JSON 编辑两处需求，体量更轻

## Workspace 编辑能力

- 语法高亮按扩展名懒加载
- 首批支持：
  - `json/jsonc`
  - `md`
  - `ts/tsx`
  - `js/jsx`
  - `css`
  - `html`
  - `yaml`
  - `sh`
- 未识别类型回退纯文本
- 二进制文件拒绝编辑
- 大文件拒绝编辑

## Cron 结构化边界

结构化 UI 首版只显式支持：

- `sessionTarget = main | isolated`
- `schedule.kind = at | every | cron`
- `delivery.mode = none | announce`

高级场景通过 JSON 模式支持：

- `sessionTarget = current`
- `sessionTarget = session:<custom-id>`
- `delivery.mode = webhook`
- `deleteAfterRun`
- `staggerMs`
- 以及后续新增字段
