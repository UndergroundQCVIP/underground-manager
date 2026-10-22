/** Admin-selected informational Accueil destination, persisted across deployments. */
import { getConfig, isAdministrator } from "../config.ts";
import { getKv } from "./kv.ts";
import { logAuditEvent } from "./audit.ts";

const KEY = ["accueil_binding"];
type Binding = { chatId: number; configuredBy: number; configuredAt: string };

export function accueilCollision(chatId: number): boolean {
  const c = getConfig();
  return [c.VIP_COLLECTIONS_CHAT_ID, c.TELEGRAM_RETRO_FORUM_CHAT_ID, c.TELEGRAM_AMATEUR_FORUM_CHAT_ID,
    c.TELEGRAM_AMATEUR_CHAT_ID, c.TELEGRAM_ADMIN_REVIEW_CHAT_ID, c.WANTED_LIST_CHAT_ID,
    c.GENERAL_CHAT_ID, c.PUBLIC_DIRECTORY_CHAT_ID, c.TELEGRAM_LEADERBOARD_CHAT_ID].includes(chatId);
}

export async function refreshAccueilConfiguration(): Promise<void> {
  const binding = (await (await getKv()).get<Binding>(KEY)).value;
  if (!binding) return;
  if (!Number.isSafeInteger(binding.chatId) || binding.chatId >= 0 || accueilCollision(binding.chatId)) {
    throw new Error("Accueil doit rester distinct des espaces privés et du répertoire.");
  }
  getConfig().TELEGRAM_PUBLIC_WELCOME_CHAT_ID = binding.chatId;
}

export async function bindAccueil(chatId: number, adminId: number): Promise<void> {
  if (!isAdministrator(adminId)) throw new Error("Administrateur requis.");
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || accueilCollision(chatId)) {
    throw new Error("Utilisez un canal ou groupe Accueil distinct des espaces privés et du répertoire.");
  }
  const current = await (await getKv()).get<Binding>(KEY);
  const configured = current.value?.chatId || getConfig().TELEGRAM_PUBLIC_WELCOME_CHAT_ID;
  if (configured && configured !== chatId) throw new Error("Un autre Accueil est déjà configuré. Modifiez sa configuration avant de changer de canal.");
  if (!(await (await getKv()).atomic().check(current).set(KEY, {
    chatId, configuredBy: adminId, configuredAt: new Date().toISOString(),
  }).commit()).ok) throw new Error("La configuration a changé. Réessayez.");
  getConfig().TELEGRAM_PUBLIC_WELCOME_CHAT_ID = chatId;
  await logAuditEvent("navigation_synced", { action: "accueil_configured", chatId }, adminId);
}
