import type { CooldownDefinition } from "./types.ts";

export const WOW_CLASS_COLORS: Record<string, string> = {
  DeathKnight: "#c41e3a",
  DemonHunter: "#a330c9",
  Druid: "#ff7c0a",
  Evoker: "#33937f",
  Hunter: "#aad372",
  Mage: "#3fc7eb",
  Monk: "#00ff98",
  Paladin: "#f48cba",
  Priest: "#f5f5f5",
  Rogue: "#fff468",
  Shaman: "#0070dd",
  Warlock: "#8788ee",
  Warrior: "#c69b6d",
};

export const WOW_CLASS_LABELS: Record<string, string> = {
  DeathKnight: "死亡骑士",
  DemonHunter: "恶魔猎手",
  Druid: "德鲁伊",
  Evoker: "唤魔师",
  Hunter: "猎人",
  Mage: "法师",
  Monk: "武僧",
  Paladin: "圣骑士",
  Priest: "牧师",
  Rogue: "潜行者",
  Shaman: "萨满祭司",
  Warlock: "术士",
  Warrior: "战士",
};

export const DEFAULT_COOLDOWNS: CooldownDefinition[] = [
  { id: "spell-62618", spellId: 62618, name: "真言术：障", classSlug: "Priest", cooldownMs: 180000, durationMs: 10000, category: "减伤", color: "#e8edf3" },
  { id: "spell-64843", spellId: 64843, name: "神圣赞美诗", classSlug: "Priest", cooldownMs: 180000, durationMs: 8000, category: "治疗", color: "#f5f5f5" },
  { id: "spell-98008", spellId: 98008, name: "灵魂链接图腾", classSlug: "Shaman", cooldownMs: 180000, durationMs: 6000, category: "减伤", color: "#2688ff" },
  { id: "spell-740", spellId: 740, name: "宁静", classSlug: "Druid", cooldownMs: 180000, durationMs: 8000, category: "治疗", color: "#ff8e2b" },
  { id: "spell-31821", spellId: 31821, name: "光环掌握", classSlug: "Paladin", cooldownMs: 180000, durationMs: 8000, category: "减伤", color: "#f59bc5" },
  { id: "spell-115310", spellId: 115310, name: "还魂术", classSlug: "Monk", cooldownMs: 180000, durationMs: 0, category: "治疗", color: "#18d89a" },
  { id: "spell-97462", spellId: 97462, name: "集结呐喊", classSlug: "Warrior", cooldownMs: 180000, durationMs: 10000, category: "减伤", color: "#d2ad81" },
  { id: "spell-196718", spellId: 196718, name: "黑暗", classSlug: "DemonHunter", cooldownMs: 300000, durationMs: 8000, category: "减伤", color: "#b45bd1" },
  { id: "spell-51052", spellId: 51052, name: "反魔法领域", classSlug: "DeathKnight", cooldownMs: 120000, durationMs: 10000, category: "减伤", color: "#d5445c" },
  { id: "spell-363534", spellId: 363534, name: "回溯", classSlug: "Evoker", cooldownMs: 180000, durationMs: 5000, category: "治疗", color: "#52aa96" },
];

export const COOLDOWN_BY_SPELL_ID = new Map(
  DEFAULT_COOLDOWNS.filter((item) => item.spellId).map((item) => [item.spellId!, item]),
);
