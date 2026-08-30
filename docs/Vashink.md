这份文件作为给ai阅读的机制说明，不是结构化文件，需要二次加工。

详细数据可以参考：https://www.wowhead.com/ptr/guide/midnight/raids/venomous-abyss-vashnik-the-malignant-boss-strategy-abilities#vashnik-the-malignant-2882-details-abilities

## 正式服中文名称核对（2026-08-30）

主要证据是 [Warcraft Logs 正式服中文报告 LgdFn8NyAGRqWT3V fight 64](https://cn.warcraftlogs.com/reports/LgdFn8NyAGRqWT3V?fight=64&type=damage-done) 的 `report.masterData`：报告语言为 `cn`，按同一 spell ID 对照 `translate:false` 的日志原始中文与 `translate:true` 的英文。报告未包含的虹吸机制改用 Wowhead 精确 spell ID 页面补证；页面核对时选中“正式服”，并可见 PTR 12.1.0/12.0.7 版本切换。没有可靠 client build 证据，因此不填写 build。

| Spell ID | 英文原名 | 简体中文显示名 | 证据 |
| --- | --- | --- | --- |
| `1284563` | Toxic Vapor | 毒性蒸汽 | WCL masterData |
| `1280934`, `1280935` | Dripping Fangs | 滴毒之牙 | WCL masterData |
| `1281910`, `1281913`, `1281925` | Plague Froth | 瘟疫泡沫 | WCL masterData |
| `1295798` | Plague Wave | 瘟疫浪潮 | WCL masterData |
| `1284663`, `1284670`, `1284671` | Imbibe | 痛饮 | WCL masterData |
| `1282516`, `1282525` | Malignant Catalyst | 恶性催化剂 | WCL masterData |
| `1282602`, `1282616` | Catalytic Bile | 催化胆汁 | WCL masterData |
| `1280189` | Malignant Burst | 恶性爆发 | WCL masterData |
| `1304459` | Malignance | 恶念 | WCL masterData |
| `1295224` | Siphoning Infection | 虹吸感染 | [Wowhead 正式服简中页](https://www.wowhead.com/cn/spell=1295224/siphoning-infection) |
| `1295229` | Siphon Blood | 鲜血虹吸 | [Wowhead 正式服简中页](https://www.wowhead.com/cn/spell=1295229) |

`1282078`、`1284669`、`1286872` 未出现在该 WCL 报告的 masterData，本次也没有足以给这些 ID 单独绑定中英文名的直接页面证据。它们可以继续作为已确认机制内的辅助/验证事件，但不得仅凭所属机制猜译名。

场地机制：场地上有三个喷泉，分别是Fountain of Blood（红），Fountain of Shadow（紫），Fountain of Flame（橙）

恶性爆发（Malignant Burst，`1280189`）- 灭团技，有 Living Venom 进入中央的 Malignant Cavity 时触发

恶念（Malignance，`1304459`）- 由 Malignant Tumor 施放的全团毒波，并附加长时间、可叠加的持续伤害；与恶性爆发是两个不同机制

毒性蒸汽（Toxic Vapor，`1284563`）- 贯穿全场的持续伤害

瘟疫泡沫（Plague Froth）- 召唤带有伤害的分散圈，一段时间后射出十字形瘟疫浪潮（Plague Wave）；需要让海浪命中地上的 Malignant Tumor，以移除其 Hardened Tumor 减伤效果

滴毒之牙（Dripping Fangs）- 坦克技能

痛饮（Imbibe）- 会同时激活两个喷泉。当前五场 WCL 样本中的顺序固定为：第一次橙色（Burning Venom）+紫色（Shrouded Venom），第二次红色（Clotting Venom）+橙色，第三次红色+紫色，第四次回到橙色+紫色，之后继续循环

恶性催化剂（Malignant Catalyst）- 造成全团伤害并召唤分散圈，接圈者会受到催化胆汁（Catalytic Bile）伤害，如果没人接会灭团

虹吸感染（Siphoning Infection，`1295224`）- 通常点名两名玩家，施加持续伤害、治疗吸收，并使其受到的普通治疗量降低 100%。被点玩家会周期性产生鲜血虹吸（Siphon Blood，`1295229`）圈；其他玩家需要进入圈内承受伤害，鲜血虹吸会根据命中的附近玩家治疗被点者，从而清掉治疗吸收。若没有队友进入，治疗者无法用普通治疗清掉吸收，被点者会被持续伤害击杀

## WCL 首版时间轴转换决定

- 当前优先把 WCL 战斗记录转换为网页机制时间轴；复盘可以后置，但失败结果、伤害证据和关系事件的审查标记继续保留。
- 五场样本按单阶段处理。痛饮（Imbibe）不决定阶段；首版只显示 `1284663 begincast → cast` 的约 4 秒读条区间，并用 `1284669/1284670/1284671` 标注喷泉组合。更长区间的终点之后再定。
- 恶性催化剂（Malignant Catalyst）显示为一个复合机制实例：`1282516 begincast` 为开始，`1282516 cast` / 聚类后的 `1282525 damage` 为全团伤害判定，聚类后的 `1282602 damage` 为同一实例内的催化胆汁（Catalytic Bile）接圈判定。`1282616` 只保留为漏接证据。
- 瘟疫泡沫（Plague Froth）使用同一套“一个机制实例、多个阶段”的通用逻辑：聚类后的 `1281913 applydebuff → removedebuff` 是泡沫持续阶段，结束时点同时是同一实例内的即时瘟疫浪潮（Plague Wave）判定；不通过 Wave damage 判断是否生成。
- 滴毒之牙（Dripping Fangs）使用 `1280935 begincast → cast/damage`；同机制的减益、层数和持续伤害不单独建轴。
- 虹吸感染（Siphoning Infection）从 `1295224 applydebuff` 开始，同轮多目标合并；鲜血虹吸（Siphon Blood）暂不稳定追踪。
- 毒性蒸汽（Toxic Vapor）只显示 `1284563` 初始光环和层数变化，不显示 `1284561` Tick。
- 恶念（Malignance）独立保留但不进入首版时间轴；其事件可能与 Tumor 死亡或动态状态相关，后续再审。
- WCL 与导入草稿保留毫秒；写入整秒 plan v1 时向更早方向吸附：`floor(atMs / 1000) * 1000`。
- 其他敌方事件只有在跨样本时间稳定、机制语义明确且要求玩家处理时才进入时间轴；小怪死亡、随机机制、玩家失误或证据不足的事件保持待审。
