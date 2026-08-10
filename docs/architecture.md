# Raidline 架构说明

本文描述当前 vNext v1 的稳定边界，帮助贡献者在不重新阅读全部历史需求的情况下定位改动。它不承诺尚未实现的真实 WCL、服务器数据库或插件导入能力。

## 系统分层

```text
页面 / 交互层
  app/components/HomeClient.tsx
  app/components/EditorClient.tsx
  app/components/SharedPlanClient.tsx
  app/components/TimelineView.tsx
          │ 只消费 TimelineScene 和页面动作
          ▼
应用规则层
  lib/core.ts       冲突、技能执行区间、撤销相关业务、MRT 阅读版
  lib/catalog.ts    目录 release、预设复制、计划快照和升级差异
  lib/publications.ts 发布/覆盖/删除及内容哈希
          │
          ▼
领域层
  lib/domain/schema.ts      严格 Zod schema + 推导类型
  lib/domain/timeline.ts    锚点解析、目标解析、语义诊断
  lib/domain/view-model.ts  计划到 TimelineScene 的派生转换
          │
          ├── 本地边界：app/components/local-store.ts（IndexedDB）
          ├── HTTP 边界：app/api/**、lib/server.ts
          ├── 对象边界：lib/object-store.ts（可替换 ObjectStore）
          └── WCL 边界：lib/wcl-contract.ts（v1 契约，当前无网络客户端）
```

领域层只处理稳定的业务语义。页面、数据库、对象存储、WCL 和插件格式都必须在边界层转换。这样未来把 Sites/R2 替换为中国大陆服务器上的 SQLite + 内容寻址文件目录时，不需要改计划 schema 或时间轴算法。

## 计划数据流

### 新建和编辑

1. 首页从空白计划或 catalog preset 创建 `RaidPlanDocument`。
2. 编辑器修改计划内定义、roster 和 timeline；技能/机制首次使用时复制完整定义快照。
3. 300ms 防抖写入 IndexedDB 工作副本；定时和破坏性操作前写入 checkpoint。
4. `buildTimelineScene` 解析 anchor、计算范围和轨道，页面不直接解释完整计划。
5. `validatePlanSemantics` 把循环、悬空引用和职业不匹配分成阻断错误或可保留警告。

### 发布和分享

```text
本地工作副本 → 冻结 A → parse + semantic validation → hash → ObjectStore
      ↑                                                    │
      └── 发布后继续编辑 B，不会改变 A ───────────────────────┘
```

发布对象只保存 v1 计划快照、`shareId`、`editId`、版本、时间和哈希。只读 `/s/{shareId}` 不提供编辑动作；编辑链接把服务器版本复制到浏览器后继续本地编辑。覆盖和删除均需显式调用 API。

### WCL 边界（当前阶段）

`lib/wcl-contract.ts` 只接受已经规范化的提供者无关对象，并在保存前检查 fight 难度。GraphQL DTO、报告链接解析、认证、分页、任务队列和真实对比计算属于后续服务端里程碑。它们不能被塞进 `RaidPlanDocument`。

## 核心不变量

- `RaidPlanDocument.schemaVersion === 1`；未知字段、旧版本、重复 ID、非整秒计划时间和超过 1 MB 的计划拒绝保存或发布。
- `CatalogRelease.schemaVersion === 1`；预设不包含成员、策略组、执行者或技能安排。
- 计划时间只持久化 `pull`、`phase` 和 `mechanic` 三类 `TimelineAnchor`。机制的 impact/end 是从定义的施法与持续时间派生。
- 显示范围是所有可解析结束点加 30 秒后向上取整，限制在 2–120 分钟。
- 计划中的技能/机制定义是快照；目录和来源删除不能破坏已存在计划。
- 目标选择器必须能解析为全团、策略组、职责、小队或成员；技能可继承所锚定机制的目标。
- 语义警告可以随本地工作副本保存；阻断错误阻止发布和导出。
- 分享 ID 使用 16 位、编辑 ID 使用 4 位 `[0-9A-Za-z]`。

## 未来替换点

| 当前实现 | 未来实现 | 不应改变的接口 |
| --- | --- | --- |
| Sites/R2 `ObjectStore` | 中国大陆 Linux 服务器持久目录或同网对象存储 | `ObjectStore`、发布哈希和 API 结果 |
| 仅 v1 WCL fixture | 服务端 WCL client + 异步任务 + 快照库 | `CombatLogSnapshot`、`PlanImportDraft`、`ComparisonRun` |
| MRT 阅读版 | MRT/Kaze、NSRT、STT 导出器 | `ExportRequest → ExportResult` |
| 内置 `data/catalog-seed.json` | 管理员发布 catalog release | `CatalogRelease`、计划内快照 |
| IndexedDB | 浏览器本地优先 + 服务器显式发布 | 工作副本/发布语义 |

任何替换都应先添加契约测试，再实现适配器；不要让替换平台的类型渗入领域层。
