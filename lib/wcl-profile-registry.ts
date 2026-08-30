import ptrVashnikProfileValue from "../data/fixtures/vashnik-encounter-conversion-profile-v1.json";
import localizedVashnikProfileValue from "../data/fixtures/vashnik-encounter-conversion-profile-v2.json";
import playerSkillProfileValue from "../data/fixtures/player-skill-extraction-profile-v1.json";
import {
  parseConversionProfile,
  parsePlayerSkillExtractionProfile,
  type EncounterConversionProfile,
  type PlayerSkillExtractionProfile,
} from "./types";

const LIVE_REPORT_CODE = "LgdFn8NyAGRqWT3V";
const LIVE_REVIEWED_AT = Date.UTC(2026, 7, 30);
const LIVE_ENCOUNTER_ID = 3455;
const LIVE_PROFILE_V1_ID = "20000000-0000-4000-8000-000000000002";
const LIVE_PROFILE_V2_ID = "20000000-0000-4000-8000-000000000009";
const RULES_NOT_OBSERVED_IN_LIVE_REPORT = new Set([
  "20000000-0000-4000-8000-00000000030c",
]);

const ptrVashnikProfile = parseConversionProfile(ptrVashnikProfileValue);
const localizedVashnikProfile = parseConversionProfile(localizedVashnikProfileValue);

function createLiveVashnikProfile(source: EncounterConversionProfile, id: string) {
  return parseConversionProfile({
    ...structuredClone(source),
    id,
    encounterId: LIVE_ENCOUNTER_ID,
    conversionRules: source.conversionRules.map((rule) => ({
      ...structuredClone(rule),
      verification: RULES_NOT_OBSERVED_IN_LIVE_REPORT.has(rule.id)
        ? structuredClone(rule.verification)
        : {
            reviewedAt: LIVE_REVIEWED_AT,
            sourceReportCodes: [LIVE_REPORT_CODE],
          },
    })),
    notes: `正式服 encounter ${LIVE_ENCOUNTER_ID} 的独立试用 profile；规则从同一 Boss 的测试服 encounter 3134 对应 revision 复制。fight 64 已出现的主时间轴事件用正式服报告 ${LIVE_REPORT_CODE} 重新核对；虹吸感染规则未在该战斗出现，保留原 revision 的规则证据，中文名另由 Wowhead 正式服 spell ID 页面核对。`,
  });
}

export const liveVashnikProfileV1 = createLiveVashnikProfile(ptrVashnikProfile, LIVE_PROFILE_V1_ID);
export const liveVashnikProfile = createLiveVashnikProfile(localizedVashnikProfile, LIVE_PROFILE_V2_ID);

export const encounterConversionProfiles: EncounterConversionProfile[] = [
  ptrVashnikProfile,
  localizedVashnikProfile,
  liveVashnikProfileV1,
  liveVashnikProfile,
];

export const playerSkillExtractionProfiles: PlayerSkillExtractionProfile[] = [
  parsePlayerSkillExtractionProfile(playerSkillProfileValue),
];
