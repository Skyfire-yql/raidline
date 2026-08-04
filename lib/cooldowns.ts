import type { CooldownCategory, CooldownDefinition, CooldownEffect, CooldownScope } from "./types.ts";

export const WOW_CLASS_COLORS: Record<string, string> = {
  DeathKnight: "#c41e3a", DemonHunter: "#a330c9", Druid: "#ff7c0a", Evoker: "#33937f",
  Hunter: "#aad372", Mage: "#3fc7eb", Monk: "#00ff98", Paladin: "#f48cba",
  Priest: "#e7e7e7", Rogue: "#fff468", Shaman: "#0070dd", Warlock: "#8788ee", Warrior: "#c69b6d",
};

export const WOW_CLASS_LABELS: Record<string, string> = {
  DeathKnight: "死亡骑士", DemonHunter: "恶魔猎手", Druid: "德鲁伊", Evoker: "唤魔师",
  Hunter: "猎人", Mage: "法师", Monk: "武僧", Paladin: "圣骑士", Priest: "牧师",
  Rogue: "潜行者", Shaman: "萨满祭司", Warlock: "术士", Warrior: "战士",
};

const CATALOG_VERSION = "retail-structure-2026-08";
const both = ["physical", "magic"] as const;

function reduction(): CooldownEffect[] {
  return [{ type: "damageReduction", percent: null, schools: [...both] }];
}

function immunity(): CooldownEffect[] {
  return [{ type: "immunity", schools: [...both] }];
}

function absorb(): CooldownEffect[] {
  return [{ type: "absorb", amount: null, allocation: "perTarget", schools: [...both] }];
}

function spell(
  spellId: number,
  name: string,
  classSlug: string,
  scope: CooldownScope,
  category: CooldownCategory,
  description: string,
  effects: CooldownEffect[] = [],
): CooldownDefinition {
  return {
    id: `spell-${spellId}`,
    spellId,
    name,
    description,
    classSlug,
    specSlugs: [],
    scope,
    cooldownMs: null,
    castTimeMs: null,
    durationMs: null,
    triggersGcd: null,
    maxTargets: scope === "personal" ? 1 : null,
    effects,
    category,
    color: WOW_CLASS_COLORS[classSlug] ?? "#7b8490",
    catalogVersion: CATALOG_VERSION,
    dataStatus: "unconfigured",
  };
}

// v2 首版只维护稳定的名称、归属与用途，不预填会随版本或天赋变化的正式数值。
export const DEFAULT_COOLDOWNS: CooldownDefinition[] = [
  spell(62618, "真言术：障", "Priest", "team", "团队减伤", "为范围内队友提供团队防护。", reduction()),
  spell(64843, "神圣赞美诗", "Priest", "team", "治疗", "持续引导的团队治疗技能。"),
  spell(33206, "痛苦压制", "Priest", "external", "外部减伤", "为一名队友提供外部减伤。", reduction()),
  spell(19236, "绝望祷言", "Priest", "personal", "个人减伤", "牧师的个人生存技能。", [{ type: "maxHealth", percent: null }]),
  spell(47585, "消散", "Priest", "personal", "个人减伤", "暗影牧师的强力个人防护。", reduction()),

  spell(98008, "灵魂链接图腾", "Shaman", "team", "团队减伤", "为图腾范围内队友提供团队防护。", reduction()),
  spell(108271, "星界转移", "Shaman", "personal", "个人减伤", "萨满祭司的个人减伤。", reduction()),

  spell(740, "宁静", "Druid", "team", "治疗", "持续引导的团队治疗技能。"),
  spell(22812, "树皮术", "Druid", "personal", "个人减伤", "德鲁伊的个人减伤。", reduction()),
  spell(61336, "生存本能", "Druid", "personal", "个人减伤", "守护德鲁伊的强力个人减伤。", reduction()),
  spell(102342, "铁木树皮", "Druid", "external", "外部减伤", "为一名队友提供外部减伤。", reduction()),

  spell(31821, "光环掌握", "Paladin", "team", "团队减伤", "强化当前光环的团队效果。", reduction()),
  spell(642, "圣盾术", "Paladin", "personal", "免疫", "圣骑士的个人免疫技能。", immunity()),
  spell(6940, "牺牲祝福", "Paladin", "external", "外部减伤", "为一名队友承担部分伤害。", reduction()),
  spell(31850, "炽热防御者", "Paladin", "personal", "个人减伤", "防护圣骑士的个人减伤。", reduction()),

  spell(115310, "还魂术", "Monk", "team", "治疗", "瞬发团队治疗与驱散技能。"),
  spell(115203, "壮胆酒", "Monk", "personal", "个人减伤", "武僧的个人防护技能。", reduction()),
  spell(122278, "躯不坏", "Monk", "personal", "个人减伤", "根据伤害强度提供个人减伤。", reduction()),
  spell(116849, "作茧缚命", "Monk", "external", "外部减伤", "为一名队友提供吸收护盾。", absorb()),

  spell(97462, "集结呐喊", "Warrior", "team", "团队减伤", "临时提高附近队友的最大生命。", [{ type: "maxHealth", percent: null }]),
  spell(871, "盾墙", "Warrior", "personal", "个人减伤", "战士的强力个人减伤。", reduction()),
  spell(23920, "法术反射", "Warrior", "personal", "个人减伤", "对部分法术提供个人防护。", [{ type: "damageReduction", percent: null, schools: ["magic"] }]),

  spell(196718, "黑暗", "DemonHunter", "team", "团队减伤", "为范围内队友提供团队防护。", reduction()),
  spell(198589, "疾影", "DemonHunter", "personal", "个人减伤", "恶魔猎手的个人减伤。", reduction()),
  spell(196555, "虚空行走", "DemonHunter", "personal", "免疫", "恶魔猎手的个人免疫技能。", immunity()),

  spell(51052, "反魔法领域", "DeathKnight", "team", "团队减伤", "为范围内队友抵御魔法伤害。", [{ type: "damageReduction", percent: null, schools: ["magic"] }]),
  spell(48792, "冰封之韧", "DeathKnight", "personal", "个人减伤", "死亡骑士的个人减伤。", reduction()),
  spell(48707, "反魔法护罩", "DeathKnight", "personal", "个人减伤", "吸收魔法伤害的个人护罩。", [{ type: "absorb", amount: null, allocation: "perTarget", schools: ["magic"] }]),

  spell(363534, "回溯", "Evoker", "team", "治疗", "恢复队友近期损失的生命。"),
  spell(363916, "黑曜鳞片", "Evoker", "personal", "个人减伤", "唤魔师的个人减伤。", reduction()),
  spell(374227, "微风", "Evoker", "team", "团队减伤", "为队友提供团队防护和移动辅助。", reduction()),
  spell(357170, "时间膨胀", "Evoker", "external", "外部减伤", "延缓一名队友所受的部分伤害。", reduction()),

  spell(186265, "灵龟守护", "Hunter", "personal", "免疫", "猎人的个人防护技能。", immunity()),
  spell(264735, "适者生存", "Hunter", "personal", "个人减伤", "猎人的个人减伤。", reduction()),

  spell(45438, "寒冰屏障", "Mage", "personal", "免疫", "法师的个人免疫技能。", immunity()),
  spell(110959, "强效隐形术", "Mage", "personal", "个人减伤", "隐形并提供短暂个人防护。", reduction()),
  spell(414660, "群体屏障", "Mage", "team", "团队减伤", "为附近队友提供吸收护盾。", absorb()),

  spell(31224, "暗影斗篷", "Rogue", "personal", "免疫", "潜行者对魔法效果的个人防护。", [{ type: "immunity", schools: ["magic"] }]),
  spell(5277, "闪避", "Rogue", "personal", "个人减伤", "潜行者对近战攻击的个人防护。", reduction()),
  spell(1966, "佯攻", "Rogue", "personal", "个人减伤", "潜行者的短时个人减伤。", reduction()),

  spell(104773, "不灭决心", "Warlock", "personal", "个人减伤", "术士的个人减伤。", reduction()),
  spell(108416, "黑暗契约", "Warlock", "personal", "个人减伤", "术士的个人吸收护盾。", absorb()),
];

export const COOLDOWN_BY_SPELL_ID = new Map(
  DEFAULT_COOLDOWNS.filter((item) => item.spellId).map((item) => [item.spellId!, item]),
);
