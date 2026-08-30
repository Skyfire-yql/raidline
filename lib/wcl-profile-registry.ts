import vashnikProfileValue from "../data/fixtures/vashnik-encounter-conversion-profile.json";
import playerSkillProfileValue from "../data/fixtures/player-skill-extraction-profile-v1.json";
import {
  parseConversionProfile,
  parsePlayerSkillExtractionProfile,
  type PlayerSkillExtractionProfile,
} from "./types";

export const liveVashnikProfile = parseConversionProfile(vashnikProfileValue);

export const encounterConversionProfiles = [
  liveVashnikProfile,
];

export const playerSkillExtractionProfiles: PlayerSkillExtractionProfile[] = [
  parsePlayerSkillExtractionProfile(playerSkillProfileValue),
];
