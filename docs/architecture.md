# Raidline 架构说明

本文描述当前 vNext v1 的稳定边界，帮助贡献者在不重新阅读全部历史需求的情况下定位改动。网站通过服务端只读 WCL 边界读取公开报告、战斗、官方阶段，以及精确 encounter profile 和独立全局玩家 profile 所需事件。匿名机制、职业 A/B 槽位、关键技能和团队增益经用户选择后创建浏览器本地计划；角色名不请求或读取，原始事件和 actors 不进入响应。玩家提取仍有待核验规则，详见 [实施记录](player-skill-extraction-v1.md)。快照持久化、服务器数据库、队列、对比和实际计时插件导出尚未实现。

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
  lib/catalog.ts    目录 release、预设和机制快照复制
  lib/player-skill-library.ts 全局内置技能库入口
  lib/publications.ts 发布/覆盖/删除及内容哈希
  lib/player-skill-extraction.ts 匿名成员、技能与团队增益的纯转换
  lib/plan-presentation.ts 技能效果说明
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
          └── WCL 边界：wcl-report / wcl-client / wcl-server / wcl-contract / wcl-import-server
```

领域层只处理稳定的业务语义。页面、数据库、对象存储、WCL 和插件格式都必须在边界层转换。当前服务端文件适配器未来升级为中国大陆服务器上的 SQLite + 内容寻址文件目录时，不需要改计划 schema 或时间轴算法。

## 计划数据流

### 新建和编辑

1. 首页从空白计划或 catalog preset 创建 `RaidPlanDocument`。
2. 编辑器修改计划内机制快照、roster 和 timeline；玩家技能只引用全局库 ID，不保存定义、天赋或变体。
3. 300ms 防抖写入 IndexedDB 工作副本；定时和破坏性操作前写入 checkpoint。
4. `buildTimelineScene` 解析 anchor、计算范围和轨道，页面不直接解释完整计划。
5. `validatePlanSemantics` 把悬空引用和职业不匹配分成阻断错误或可保留警告，并提供所属对象类型以打开对应编辑器。

### 发布和分享

```text
本地工作副本 → 冻结 A → parse + semantic validation → hash → ObjectStore
      ↑                                                    │
      └── 发布后继续编辑 B，不会改变 A ───────────────────────┘
```

发布对象只保存 v1 计划快照、`shareId`、`editId`、版本、时间和哈希。只读 `/s/{shareId}` 不提供编辑动作；编辑链接把服务器版本复制到浏览器后继续本地编辑。覆盖和删除均需显式调用 API。

编辑器、分享页、WCL 预览和发布校验在应用边界读取当前目录，并把全局技能库传给纯业务函数。离线使用已缓存目录，无缓存时回退到 `PLAYER_SKILLS`。技能库不进入计划哈希；目录更新会改变既有计划和分享的技能显示、默认时长及冷却判断。机制快照和 WCL 单次观测时长保持计划事实。当前 IndexedDB 为新的 `raidline` 命名空间，不接入旧测试数据库。

### WCL 边界（当前阶段）

```text
公开 WCL URL
  → parseWclReportUrl（官方零售域名、report code、fight）
  → 服务端 client credentials（内存 token 缓存）
  → Report / ReportFight / phaseTransitions 严格 DTO
  → WclReportProbeResult（报告、Boss 战斗、开怪后阶段时间）
  → 首页选择 fight
  → 史诗检查 + 精确 encounter profile + 独立全局玩家 profile
  → 过滤分页事件（每页核验 report revision）
  → 内存匿名快照 → 机制 / 人员 / 技能 / 背景候选 + 严格 plan 预览
  → 用户逐项选择 → 浏览器本地新计划
```

探针本身不持久化。GraphQL DTO 只存在于适配器边界，阶段时间以 `transition.startTime - fight.startTime` 保留毫秒精度；若 WCL 没有返回 0 秒阶段，探针为显示补一个 P1=0 基线。数值 fight 难度在边界映射，非史诗战斗在事件采集前停止。导入中间快照和草稿只存在于服务端内存；响应经过独立白名单结构校验，不返回快照、原始事件、actors 或报告内部身份。用户确认前不保存计划，确认后也不产生服务器写入。

`lib/wcl-contract.ts` 负责严格读取已确认的 fight 元数据、在加载 profile 前检查史诗难度，并接收提供者无关快照。`lib/wcl-import-server.ts` 编排无姓名元数据、过滤分页和匿名响应。`lib/wcl-conversion.ts` 实现 profile 精确选择、机制聚类/配对/派生、毫秒导入草稿和整秒计划落地；`lib/player-skill-extraction.ts` 独立处理玩家生效证据、生命周期、去重和团队增益。不可变快照持久化、任务队列和真实对比计算仍属于后续服务端里程碑，不能被塞进 `RaidPlanDocument`。

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

完整原始事件、玩家姓名、清洗快照、导入草稿和本地计划产物不会进入 Git 或前端。审查器按事件波次压缩重复 Tick，但保留原始页和每一波的时间、条数、目标数及关联技能；人工决定文件在重新生成时保留。正式调研优先使用官方 WCL v2 API，兼容研究源不得成为正式后端依赖。当前 Vashnik 只注册正式服 encounter `3455` 的 profile v3；其证据来自 9 场公开史诗击杀和同报告 102 次灭团 Pull。仓库不保留该 Boss 的历史 profile 或单场日志预设，只维护独立核准、可离线使用的多样本目录骨架。

### Encounter 作用域的转换规则

正式导入不得扫描一套全局 Boss 技能规则。服务端必须先读取并校验战斗元数据，取得明确的 `encounterID`，再按 `encounterID + gameVersion + profileVersion` 精确加载已发布的 `EncounterConversionProfile`。当前注册表 `lib/wcl-profile-registry.ts` 读取仓库内不可变 JSON 修订，未来才替换为数据库，不能把当前导入描述为已接入数据库：

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

个人减伤、治疗等玩家技能采用另一条全局规则链：独立、版本化的 `PlayerSkillExtractionProfile` 引用全局玩家技能定义，在 fight 元数据与难度校验后统一应用。当前仅保留全局 v2 修订；反魔法领域使用用户确认的成功施法例外，其余规则仍需生效佐证。读条技能还必须找到成功施法对应的开始记录。玩家规则不复制到每个 encounter，也不能反向推断 Boss 机制。研究阶段的 Markdown、下载缓存和决定 JSON 只是制作材料；只有人工核准并纳入已发布 profile 的启用规则参与自动转换。

事件收录时必须把“是否生成时间轴对象”和“是否具有未来复盘价值”作为两个独立维度。当前优先完成 WCL 战斗记录到机制时间轴的转换；用于事件配对、标签、结果校验或未来复盘的事件可以保留标记，但不得因此自动生成时间轴对象。只有跨样本时间稳定、机制语义明确且有玩家处理价值的事件才进入时间轴；其余事件继续待审，不得猜测为 Boss 机制。

一次 Boss 机制可以由多个连续区间和判定点组成。机制定义通过供应商无关的 `timelinePresentation.parts` 描述各阶段的端点、说明与视觉语义，场景层解析为绝对时间；视图不得根据本地化名称或法术 ID 猜测样式。瘟疫泡沫 → 瘟疫浪潮（Plague Froth → Plague Wave）与恶性催化剂 → 催化胆汁（Malignant Catalyst → Catalytic Bile）均使用相同的“一个定义、一个 occurrence、多个阶段”模型。

## 核心不变量

- `RaidPlanDocument.schemaVersion === 1`；未知字段、旧版本、重复 ID、非整秒计划时间和超过 1 MB 的计划拒绝保存或发布。
- `CatalogRelease.schemaVersion === 1`；预设不包含成员、策略组、执行者或技能安排。
- 计划全局时间只持久化 `pull`、`phase` 两类 `TimelineAnchor`。机制的 impact/end 默认从定义的施法与持续时间派生；WCL 导入机制可以保存整秒 `timing` 覆盖。玩家安排只显示成功施法起点开始的单一区间，可保留 `observedDurationMs`，不推算 GCD 或覆盖。
- 显示范围是所有可解析结束点加 30 秒后向上取整，限制在 2–120 分钟。
- 计划中的机制定义是快照；玩家技能属于全局库。删除全局技能可能产生可修复的缺失技能诊断，不自动替换或删除安排。
- 目标选择器只保留全团与指定成员。技能界面仅允许全团／自己；分组、天赋、机制绑定和提前提醒字段均被严格拒绝。删除成员级联删除其技能安排，保留并诊断执行者变空的任务。
- 语义警告可以随本地工作副本保存；阻断错误阻止发布和导出。
- 分享 ID 使用 16 位、编辑 ID 使用 4 位 `[0-9A-Za-z]`。

## 未来替换点

| 当前实现 | 未来实现 | 不应改变的接口 |
| --- | --- | --- |
| `.raidline-data/` 文件 `ObjectStore` 适配器 | 中国大陆 Linux 服务器的 SQLite + 内容寻址持久目录 | `ObjectStore`、发布哈希和 API 结果 |
| 同步只读 WCL 探针、过滤分页与匿名导入 + 本地研究工具 | 异步任务 + 不可变快照库 + 对比计算 | `CombatLogSnapshot`、`PlanImportDraft`、`ComparisonRun` |
| MRT 阅读版 | MRT/Kaze、NSRT、STT 导出器 | `ExportRequest → ExportResult` |
| 内置组合目录 | 管理员发布 catalog release | `CatalogRelease`、全局技能 ID、计划内机制快照 |
| IndexedDB | 浏览器本地优先 + 服务器显式发布 | 工作副本/发布语义 |

任何替换都应先添加契约测试，再实现适配器；不要让替换平台的类型渗入领域层。
