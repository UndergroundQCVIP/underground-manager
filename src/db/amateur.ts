/** Optional Amateur forum binding, saved by an admin after the forum is created. */
import { getConfig, isAdministrator } from "../config.ts";
import { getKv } from "./kv.ts";
import { logAuditEvent } from "./audit.ts";

const KEY = ["amateur_forum_config"];
type Binding = { chatId: number; configuredBy: number; configuredAt: string };

export function amateurChatCollision(chatId: number): boolean {
  const c = getConfig();
  return [c.VIP_COLLECTIONS_CHAT_ID, c.TELEGRAM_RETRO_FORUM_CHAT_ID, c.PUBLIC_DIRECTORY_CHAT_ID,
    c.WANTED_LIST_CHAT_ID, c.GENERAL_CHAT_ID, c.TELEGRAM_PUBLIC_LOBBY_CHAT_ID, c.TELEGRAM_PUBLIC_WELCOME_CHAT_ID].includes(chatId);
}

export async function refreshAmateurConfiguration(): Promise<void> {
  const binding = (await (await getKv()).get<Binding>(KEY)).value;
  if (binding) {
    if (!Number.isSafeInteger(binding.chatId) || binding.chatId >= 0 || amateurChatCollision(binding.chatId)) {
      throw new Error("Configuration Amateur invalide : le forum doit être privé et distinct.");
    }
    getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID = binding.chatId;
  }
}

export async function bindAmateurForum(chatId: number, adminId: number): Promise<void> {
  if (!isAdministrator(adminId)) throw new Error("Administrateur requis.");
  if (!Number.isSafeInteger(chatId) || !String(chatId).startsWith("-100") || amateurChatCollision(chatId)) {
    throw new Error("Le forum Amateur doit être distinct des collections et des canaux publics existants.");
  }
  const previous = getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID;
  // Replacing a forum is a migration, not a setup action; never silently repoint private content.
  if (previous && previous !== chatId) throw new Error("Un autre forum Amateur est déjà configuré.");
  const kv = await getKv();
  const current = await kv.get<Binding>(KEY);
  if (current.value && current.value.chatId !== chatId) throw new Error("Un autre forum Amateur est déjà configuré.");
  const saved = await kv.atomic().check(current).set(KEY, { chatId, configuredBy: adminId, configuredAt: new Date().toISOString() }).commit();
  if (!saved.ok) throw new Error("La configuration a changé. Réessayez.");
  getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID = chatId;
  await logAuditEvent("amateur_forum_configured", { chatId }, adminId);
}
