# Raidline AI / 自动化开发约定

本文是给 Codex、Copilot、其他代码代理和接手开发者的仓库级约定。它补充而不替代 `README.md`、`CONTRIBUTING.md` 和 `docs/requirements/`；发生冲突时，以用户当前明确要求和最新需求文档为准。

## 先确认上下文

开始任何改动前：

1. 阅读 `README.md`、`CONTRIBUTING.md`、`docs/requirements/INDEX.md` 和当前 vNext 需求文档。
2. 执行 `git status -sb`、`git branch --show-current`，保留用户已有改动，不使用 `git reset --hard` 或 `git checkout --` 清理工作区。
3. 找到相关的 schema、业务函数、页面入口和测试；先用 `rg` 定位引用，不要凭文件名猜测依赖关系。
4. 明确本次任务是否改变固定产品决策、持久化格式、分享规则或部署边界。会改变这些内容时先停止并请求确认。

## 不可违反的边界

- 当前计划、目录、战斗快照和转换规则都是严格 schema v1。禁止为旧 plan/catalog/share 添加猜测式迁移、隐式补字段或 `normalize(any)`。
- `lib/domain/schema.ts` 是运行时结构的权威来源；不要手写另一套互相漂移的接口。
- 领域层不得依赖 React、Next、浏览器 API、IndexedDB、SQLite、Cloudflare、R2、WCL GraphQL 或插件序列化格式。
- 时间轴持久化只保存 `TimelineAnchor`。解析后的全局时间、范围、轨道和标签属于派生视图。
- 计划内技能和机制必须保存完整快照；目录升级必须由用户显式确认，不能打开计划时自动覆盖。
- 编辑计划不产生服务器写请求。发布、覆盖和删除是显式动作；分享 ID 为 16 位，编辑 ID 为 4 位。
- 当前 v1 不连接真实 WCL、数据库、队列或 Sites 生产环境。不要为了让测试“看起来完成”而加入外网调用、凭据或临时数据库。
- WCL 难度判断必须发生在请求边界；非史诗输入不能生成可持久化快照、导入草稿或计划。
- 导出必须通过统一 `ExportRequest → ExportResult` 契约；不能把插件语法写入计划结构，也不能静默丢弃无法表达的锚点。
- 不自动删除成员安排、任务、机制或来源引用来修复异常数据；报告可定位的诊断，让用户决定。
- 不因“以后可能需要”同时维护多套数据库、对象存储或部署平台。

## 依赖方向

```text
lib/domain/schema.ts
        ↓
lib/domain/timeline.ts → lib/domain/view-model.ts
        ↓                         ↓
lib/core.ts / lib/catalog.ts      app/components/TimelineView.tsx
        ↓                         ↓
lib/publications.ts / APIs        EditorClient / SharedPlanClient
```

`lib/wcl-contract.ts`、目录适配器和发布存储只能在边界处转换数据；不要反向让页面组件或计划 schema 依赖供应商 DTO。新增功能优先放在最靠近其不变量的层，避免把业务判断散落到 JSX 事件处理器中。

## 推荐实现顺序

1. 写 schema/行为测试或 fixture，明确输入、输出和拒绝条件。
2. 实现纯领域函数，验证严格解析、语义诊断、锚点和哈希不变量。
3. 接入本地存储或 API 边界，处理错误和并发，不改变领域结构。
4. 适配 `TimelineScene` 和既有组件，保持双栏布局和现有核心入口。
5. 运行单元、类型、lint、构建和必要的浏览器/API 回归。
6. 检查 `git diff --check`、未追踪文件和敏感信息，再提交。

## 交付说明格式

完成任务时，结果应包含：

- 结果摘要和用户可见行为。
- 变更文件或模块，以及 schema/存储/兼容性影响。
- 实际运行的命令和测试结果；不要声称没有运行的测试通过。
- 已知缺口、未做的外部集成和需要用户决定的事项。
- 如果创建了分支、提交或 PR，给出明确名称和提交号；如果没有推送或部署，也明确说明。

## 保护用户数据

不得读取、提交或输出 `.env`、管理员密码、WCL client secret/access token、生产对象内容或用户的本地计划正文。发现疑似凭据时停止扩散，并只报告文件位置和处理建议。删除或覆盖文件前必须确认目标属于当前任务；优先使用可恢复操作。
