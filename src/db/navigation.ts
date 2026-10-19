/**
 * LA CONFRÉRIE — Public Navigation Message References (UG-05)
 */

import { getKv } from "./kv.ts";
import { NavigationState } from "../types.ts";

const KEY = ["navigation_state"];

export async function getNavigationState(): Promise<NavigationState> {
  const kv = await getKv();
  return (await kv.get<NavigationState>(KEY)).value ?? {};
}

export async function saveNavigationState(patch: Partial<NavigationState>): Promise<NavigationState> {
  const kv = await getKv();
  const next = { ...(await getNavigationState()), ...patch };
  await kv.set(KEY, next);
  return next;
}
