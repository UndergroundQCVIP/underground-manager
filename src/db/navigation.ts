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
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await kv.get<NavigationState>(KEY);
    const next = { ...current.value, ...patch };
    if ((await kv.atomic().check(current).set(KEY, next).commit()).ok) return next;
  }
  throw new Error("Could not save navigation state (write conflict)");
}
