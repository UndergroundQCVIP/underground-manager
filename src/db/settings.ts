/**
 * LA CONFRÉRIE — System Settings Repository
 */

import { getKv } from "./kv.ts";
import { SystemSettings } from "../types.ts";
import { getConfig } from "../config.ts";

const SETTINGS_KEY = ["system_settings"];

export const DEFAULT_SETTINGS: SystemSettings = {
  directoryUpdateCron: "0 3 * * *",
  votingPeriodDays: 5,
  votingShortlistSize: 5,
  nominationLimitPerCycle: 1,
  digestEnabled: false,
  turnoutObjectivePct: 20,
  membershipMode: "contribution_only",
  contributionDefaultDays: 30,
  contributionRewardsInStarsMode: false,
};

export async function getSystemSettings(): Promise<SystemSettings> {
  const kv = await getKv();
  const res = await kv.get<SystemSettings>(SETTINGS_KEY);
  const config = getConfig();
  // Environment values override the built-in defaults; admin-saved settings override both.
  const envDefaults: SystemSettings = {
    ...DEFAULT_SETTINGS,
    directoryUpdateCron: config.DIRECTORY_UPDATE_CRON || DEFAULT_SETTINGS.directoryUpdateCron,
    votingPeriodDays:
      config.VOTING_PERIOD_DAYS > 0 ? config.VOTING_PERIOD_DAYS : DEFAULT_SETTINGS.votingPeriodDays,
    votingShortlistSize:
      config.VOTING_SHORTLIST_SIZE > 0
        ? config.VOTING_SHORTLIST_SIZE
        : DEFAULT_SETTINGS.votingShortlistSize,
    digestEnabled: config.DIGEST_ENABLED,
    membershipMode: config.MEMBERSHIP_MODE,
  };
  return { ...envDefaults, ...(res.value ?? {}) };
}

export async function updateSystemSettings(
  partial: Partial<SystemSettings>
): Promise<SystemSettings> {
  const kv = await getKv();
  const current = await getSystemSettings();
  const updated: SystemSettings = { ...current, ...partial };
  await kv.set(SETTINGS_KEY, updated);
  return updated;
}
