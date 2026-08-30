# 正式服 Vashnik（encounter 3455）

本文只记录当前正式服、史诗难度的 Vashnik 证据和唯一已发布 profile v3。PTR、历史 encounter、旧 profile revision 与旧时间轴 preset 均不作为当前输入，也不在运行时注册。

## 样本

2026-08-30 通过官方 WCL v2 API 只读复核 9 场公开击杀，覆盖当时速度榜快、中、慢区间及既有回归样本。所有战斗均满足 `encounterID=3455`、`difficulty=5`、`kill=true`、`gameVersion=1`、`logVersion=17`；表中不含玩家或公会名称。

| 区间 | 公开报告 | Fight | 时长 | Report revision | 官方阶段 |
| --- | --- | ---: | ---: | ---: | --- |
| 快 | [YpcQJA9jCaXfq6bt](https://cn.warcraftlogs.com/reports/YpcQJA9jCaXfq6bt?fight=12) | 12 | 6:24.229 | 54 | 无 |
| 快 | [PcGQ7mxz6BVD1Jgk](https://cn.warcraftlogs.com/reports/PcGQ7mxz6BVD1Jgk?fight=46) | 46 | 6:51.096 | 48 | 无 |
| 快中 | [DMh3wKYNpkQ4FLda](https://cn.warcraftlogs.com/reports/DMh3wKYNpkQ4FLda?fight=37) | 37 | 6:59.248 | 52 | 无 |
| 中 | [BtJyv29VZCAraPWN](https://cn.warcraftlogs.com/reports/BtJyv29VZCAraPWN?fight=34) | 34 | 7:02.251 | 47 | 无 |
| 中 | [fhBFw4RybzqLC19H](https://cn.warcraftlogs.com/reports/fhBFw4RybzqLC19H?fight=32) | 32 | 7:08.025 | 86 | 无 |
| 中慢 | [grN1chnHWBVDFJK6](https://cn.warcraftlogs.com/reports/grN1chnHWBVDFJK6?fight=56) | 56 | 7:12.943 | 49 | 无 |
| 慢 | [g4jYdTD1qHFZyNc6](https://cn.warcraftlogs.com/reports/g4jYdTD1qHFZyNc6?fight=29) | 29 | 7:17.478 | 48 | 无 |
| 慢 | [YyW1GgZzxatMjFhq](https://cn.warcraftlogs.com/reports/YyW1GgZzxatMjFhq?fight=58) | 58 | 7:28.991 | 47 | 无 |
| 回归 | [LgdFn8NyAGRqWT3V](https://cn.warcraftlogs.com/reports/LgdFn8NyAGRqWT3V?fight=64) | 64 | 7:25.448 | 45 | 无 |

同一批报告另复核 102 次史诗灭团 Pull，用于确认失败路径。9 场击杀的 `phaseTransitions` 均为空，因此转换稳定生成单一 `P1@0`，不把痛饮或喷泉循环伪装为官方阶段。

## 正式服事件矩阵

| Spell ID | 中英文名 | WCL 事件 | 来源 | 目标与样本结论 | Profile 用途 |
| --- | --- | --- | --- | --- | --- |
| `1284563` | 毒性蒸汽 / Toxic Vapor | Debuffs：`applydebuff`、`applydebuffstack` | Boss `259181` | 9/9；每场 5–6 次层数变化，首次约 24 秒，后续约 84 秒 | 时间轴显示初始层与层数变化；`1284561 damage` 仅校验 |
| `1280935` | 滴毒之牙 / Dripping Fangs | Casts：`begincast`、`cast`；Damage：`damage` | Boss `259181` | 9/9；每场 14–16 次；读条约 2 秒，目标为坦克 | `begincast` 为开始，`cast/damage` 聚为命中 |
| `1281913` | 瘟疫泡沫 / Plague Froth | Debuffs：`applydebuff`、`removedebuff` | Boss `259181` | 9/9；每场 9–11 波，每波 5 名玩家 | 应用聚为一波；规范结束固定为开始后 6 秒，移除只校验；`1281910/1281925/1295798` 不另建轴 |
| `1284663` | 痛饮 / Imbibe | Casts：`begincast`、`cast` | Boss `259181` | 9/9；每场 5–6 次；4 秒读条，约 84 秒循环 | 一个读条区间；`1284670/1284671` 为火泉/影泉关系事件 |
| `1282516`, `1282525`, `1282602` | 恶性催化剂、催化胆汁 / Malignant Catalyst, Catalytic Bile | Casts + Damage | Boss `259181` | 9/9；每场 9–10 次；开始至全团伤害约 5 秒，再约 7 秒接圈 | 单一复合 occurrence；`1282616 damage` 为漏接失败校验，不另建轴 |
| `1294994` | 冥河感染 / Stygian Infection | Debuffs：`applydebuff` | Boss `259181` | 9/9；每场 9–11 波，正常每波 4 名玩家，原始事件可展开近 2 秒 | 2.5 秒窗口合并；`1302489` 冥河爆发仅作关系证据 |
| `1295173` | 爆炸感染 / Exploding Infection | Debuffs：`applydebuff` | Boss `259181` | 9/9；每场 9–10 波，正常每波 4 名玩家，原始事件可展开近 2 秒 | 2.5 秒窗口合并；`1295209` 腐蚀爆炸仅作关系证据 |
| `1304459` | 恶念 / Malignance | Casts：`begincast` | 恶念图腾 `269430` | 9/9；每场 5–6 波，每波有多个图腾密集事件 | 3 秒窗口聚为一个机制；不是 Damage 事件 |
| `1295224`, `1295229` | 虹吸感染、鲜血虹吸 / Siphoning Infection, Siphon Blood | 预期 Debuffs / Damage | Boss `259181` | 9 场击杀与 102 次灭团均未观察；当前打法统一选择火泉+影泉 | 用户明确批准沿用既有 `1295224 applydebuff` 转换；同轮 1.5 秒合并，`1295229` 不另建轴 |
| `1280189` | 恶性爆发 / Malignant Burst | Casts：`begincast`、`cast`；Damage：`damage` | Shrouded Venom `260895`、Burning Venom `260905` | 31 次灭团出现；击杀为 0 | 失败校验，不生成正常时间轴机制 |

`1282616` 在 39 次灭团和 2 场击杀出现，确认它是可能发生的催化胆汁失败伤害；`1286872` 在全部 111 个 Pull 中为 0，当前 profile 不收录。

## 唯一转换规则

- 运行时只能在 fight 元数据确认史诗难度且 `encounterID=3455` 后，按 `retail-12.1 + profileVersion=3 + published` 精确加载本 profile；没有 fallback。
- Profile 含 9 个机制定义、10 条采集规则和 13 条转换规则。Boss profile 不包含玩家个人减伤或治疗技能；它们只属于全局 `PlayerSkillExtractionProfile`。
- WCL 快照和导入草稿保留毫秒；转为当前 plan v1 时沿用既有规则向前吸附到整秒。
- 失败伤害、周期 Tick、派生爆发、死亡和辅助光环可以用于关系或复盘校验，但不会因此额外生成 Boss 时间轴 occurrence。

## 证据边界

WCL 可以证明日志中实际出现的事件类型、来源、目标、次数和相对时间，但不能单独证明未写入日志的内部状态、设计意图、喷泉选择算法或某个未采用分支永远不会出现。虹吸感染/鲜血虹吸是当前唯一经用户明确批准的未观察例外；正式中文名分别由 [Wowhead spell 1295224](https://www.wowhead.com/cn/spell=1295224/siphoning-infection) 与 [Wowhead spell 1295229](https://www.wowhead.com/cn/spell=1295229) 补证。其余 profile 结论均来自上述正式服日志。
