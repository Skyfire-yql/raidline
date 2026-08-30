# Raidline 架构说明

本文描述当前 vNext v1 的稳定边界，帮助贡献者在不重新阅读全部历史需求的情况下定位改动。网站通过服务端只读 WCL 边界读取公开报告、战斗、官方阶段与精确 encounter profile 所需事件，并把匿名机制候选转换为浏览器本地计划；原始事件和玩家姓名不进入产品响应。快照持久化、服务器数据库、队列和插件导入尚未实现。

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
          └── WCL 边界：wcl-report / wcl-client / wcl-server / wcl-contract
```

领域层只处理稳定的业务语义。页面、数据库、对象存储、WCL 和插件格式都必须在边界层转换。当前服务端文件适配器未来升级为中国大陆服务器上的 SQLite + 内容寻址文件目录时，不需要改计划 schema 或时间轴算法。

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

```text
公开 WCL URL
  → parseWclReportUrl（官方零售域名、report code、fight）
  → 服务端 client credentials（内存 token 缓存）
  → Report / ReportFight / phaseTransitions 严格 DTO
  → WclReportProbeResult（报告、Boss 战斗、开怪后阶段时间）
  → 首页只读预览
```

探针结果不进入 IndexedDB、服务端数据目录、`RaidPlanDocument` 或 `CombatLogSnapshot`。GraphQL DTO 只存在于适配器边界，阶段时间以 `transition.startTime - fight.startTime` 保留毫秒精度；若 WCL 没有返回 0 秒阶段，探针为显示补一个 P1=0 基线。数值 fight 难度在边界映射，只有史诗样本标记为后续可转换。

`lib/wcl-contract.ts` 负责严格读取已确认的 fight 元数据、在加载 profile 前检查史诗难度，并接收提供者无关快照。`lib/wcl-conversion.ts` 实现 profile 精确选择、事件聚类/配对/派生、毫秒导入草稿和整秒计划落地。网站事件分页、不可变快照持久化、任务队列和真实对比计算仍属于后续服务端里程碑，不能被塞进 `RaidPlanDocument`。

### 本地 WCL 研究工具

`scripts/wcl-download.ts`、`scripts/wcl-review.ts` 与 `scripts/wcl-convert.ts` 是开发者本地工具，不是网站 API：

```text
完整分页事件（work/，gzip + hash，可续传）
  → 逐页事件族聚合（lib/wcl-event-review.ts）
  → 敌方/玩家/系统/未知/默认排除审查材料
  → event-decisions.json 人工确认
  → 人工确认的本地 published-profile 数据库记录 fixture
  → fight 元数据 / 史诗检查 / 精确 profile
  → 清洗快照 → PlanImportDraft → RaidPlanDocument
```

完整原始事件、玩家姓名、清洗快照、导入草稿和本地计划产物不会进入 Git 或前端。审查器按事件波次压缩重复 Tick，但保留原始页和每一波的时间、条数、目标数及关联技能；人工决定文件在重新生成时保留。当前兼容测试源只用于无 WCL 凭据期间生成 PTR fixture，正式后端不得依赖第三方代理。当前 Vashnik 本地模拟从 413,842 条 fight 32 事件中保留 7,896 条，生成 53 个机制对象；网页只使用去除 actor 与 event key 的静态 catalog 示例。

### Encounter 作用域的转换规则

正式导入不得扫描一套全局 Boss 技能规则。服务端必须先读取并校验战斗元数据，取得明确的 `encounterID`，再按 `encounterID + gameVersion + profileVersion` 从数据库加载已发布的 `EncounterConversionProfile`：

```text
公开 WCL 链接
  → 报告与 fight 元数据
  → 史诗难度边界检查
  → 确认 encounterID
  → 精确查找已发布 conversion profile
  → 加载适用的全局 PlayerSkillExtractionProfile
  → 使用该 profile 请求/过滤事件
  → 生成待用户确认的 PlanImportDraft
```

没有精确 profile 时返回“尚未配置该遭遇”，不得回退为按技能名、法术 ID 或其他 Boss profile 猜测转换。Boss 机制、阶段信号、敌方事件选择、事件关联与去重只属于 encounter profile。

个人减伤、治疗等玩家技能采用另一条全局规则链：独立、版本化的 `PlayerSkillExtractionProfile` 引用全局玩家技能定义，在 fight 元数据与难度校验后统一应用。玩家规则不复制到每个 encounter，也不能反向推断 Boss 机制。研究阶段的 Markdown、下载缓存和决定 JSON 只是 profile 的制作材料；人工确认并发布到数据库后才成为生产规则。

事件收录时必须把“是否生成时间轴对象”和“是否具有未来复盘价值”作为两个独立维度。当前优先完成 WCL 战斗记录到机制时间轴的转换；用于事件配对、标签、结果校验或未来复盘的事件可以保留标记，但不得因此自动生成时间轴对象。只有跨样本时间稳定、机制语义明确且有玩家处理价值的事件才进入时间轴；其余事件继续待审，不得猜测为 Boss 机制。

一次 Boss 机制可以由多个连续区间和判定点组成。机制定义通过供应商无关的 `timelinePresentation.parts` 描述各阶段的端点、说明与视觉语义，场景层解析为绝对时间；视图不得根据本地化名称或法术 ID 猜测样式。瘟疫泡沫 → 瘟疫浪潮（Plague Froth → Plague Wave）与恶性催化剂 → 催化胆汁（Malignant Catalyst → Catalytic Bile）均使用相同的“一个定义、一个 occurrence、多个阶段”模型。

## 核心不变量

- `RaidPlanDocument.schemaVersion === 1`；未知字段、旧版本、重复 ID、非整秒计划时间和超过 1 MB 的计划拒绝保存或发布。
- `CatalogRelease.schemaVersion === 1`；预设不包含成员、策略组、执行者或技能安排。
- 计划全局时间只持久化 `pull`、`phase` 和 `mechanic` 三类 `TimelineAnchor`。机制的 impact/end 默认从定义的施法与持续时间派生；WCL 导入实例可以保存整秒 `timing` 覆盖，以表达该轮实际判定和结束点。
- 显示范围是所有可解析结束点加 30 秒后向上取整，限制在 2–120 分钟。
- 计划中的技能/机制定义是快照；目录和来源删除不能破坏已存在计划。
- 目标选择器必须能解析为全团、策略组、职责、小队或成员；技能可继承所锚定机制的目标。
- 语义警告可以随本地工作副本保存；阻断错误阻止发布和导出。
- 分享 ID 使用 16 位、编辑 ID 使用 4 位 `[0-9A-Za-z]`。

## 未来替换点

| 当前实现 | 未来实现 | 不应改变的接口 |
| --- | --- | --- |
| `.raidline-data/` 文件 `ObjectStore` 适配器 | 中国大陆 Linux 服务器的 SQLite + 内容寻址持久目录 | `ObjectStore`、发布哈希和 API 结果 |
| 同步只读 WCL 报告/阶段探针 + 本地事件研究工具 | 事件分页 + 异步任务 + 不可变快照库 | `CombatLogSnapshot`、`PlanImportDraft`、`ComparisonRun` |
| MRT 阅读版 | MRT/Kaze、NSRT、STT 导出器 | `ExportRequest → ExportResult` |
| 内置 `data/catalog-seed.json` | 管理员发布 catalog release | `CatalogRelease`、计划内快照 |
| IndexedDB | 浏览器本地优先 + 服务器显式发布 | 工作副本/发布语义 |

任何替换都应先添加契约测试，再实现适配器；不要让替换平台的类型渗入领域层。
