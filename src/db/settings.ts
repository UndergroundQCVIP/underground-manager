/**
 * Underground Manager — System Settings Repository
 */

import { getKv } from "./kv.ts";
import { SystemSettings } from "../types.ts";

const SETTINGS_KEY = ["system_settings"];

export const DEFAULT_SETTINGS: SystemSettings = {
  directoryUpdateCron: "0 3 * * *",
  votingPeriodDays: 5,
  votingShortlistSize: 5,
  nominationLimitPerCycle: 1,
  digestEnabled: false,
  turnoutObjectivePct: 20,
};

export async function getSystemSettings(): Promise<SystemSettings> {
  const kv = await getKv();
  const res = await kv.get<SystemSettings>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(res.value ?? {}) };
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
