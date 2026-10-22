/** Persistent setup for the private Amateur chat and team review group. */
import { getConfig, isAdministrator } from "../config.ts";
import { getKv } from "./kv.ts";
import { logAuditEvent } from "./audit.ts";

export type ChatRole = "amateur_chat" | "admin_review";
const fields = {
  amateur_chat: "TELEGRAM_AMATEUR_CHAT_ID",
  admin_review: "TELEGRAM_ADMIN_REVIEW_CHAT_ID",
} as const;
type Binding = { chatId: number; configuredBy: number; configuredAt: string };

export function chatBindingCollision(chatId: number, role: ChatRole): boolean {
  const c = getConfig();
  const other = role === "amateur_chat"
    ? c.TELEGRAM_ADMIN_REVIEW_CHAT_ID
    : c.TELEGRAM_AMATEUR_CHAT_ID;
  return [
    c.VIP_COLLECTIONS_CHAT_ID,
    c.TELEGRAM_RETRO_FORUM_CHAT_ID,
    c.TELEGRAM_AMATEUR_FORUM_CHAT_ID,
    c.PUBLIC_DIRECTORY_CHAT_ID,
    c.WANTED_LIST_CHAT_ID,
    c.GENERAL_CHAT_ID,
    c.TELEGRAM_PUBLIC_LOBBY_CHAT_ID,
    c.TELEGRAM_PUBLIC_WELCOME_CHAT_ID,
    other,
  ].includes(chatId);
}
export async function refreshChatBindings(): Promise<void> {
  const kv = await getKv();
  for (const role of ["amateur_chat", "admin_review"] as const) {
    const binding =
      (await kv.get<Binding>(["private_chat_binding", role])).value;
    if (!binding) continue;
    if (
      !Number.isSafeInteger(binding.chatId) || binding.chatId >= 0 ||
      chatBindingCollision(binding.chatId, role)
    ) {
      throw new Error(`Configuration de groupe invalide : ${role}`);
    }
    getConfig()[fields[role]] = binding.chatId;
  }
}
export async function bindPrivateChat(
  role: ChatRole,
  chatId: number,
  adminId: number,
): Promise<void> {
  if (!isAdministrator(adminId)) throw new Error("Administrateur requis.");
  if (
    !Number.isSafeInteger(chatId) || chatId >= 0 ||
    chatBindingCollision(chatId, role)
  ) {
    throw new Error(
      "Utilisez un groupe privé distinct des espaces existants.",
    );
  }
  const currentId = getConfig()[fields[role]];
  if (currentId && currentId !== chatId) {
    throw new Error("Un autre groupe est déjà configuré pour ce rôle.");
  }
  const kv = await getKv();
  const current = await kv.get<Binding>(["private_chat_binding", role]);
  if (current.value && current.value.chatId !== chatId) {
    throw new Error("Un autre groupe est déjà configuré pour ce rôle.");
  }
  if (
    !(await kv.atomic().check(current).set(current.key, {
      chatId,
      configuredBy: adminId,
      configuredAt: new Date().toISOString(),
    }).commit()).ok
  ) {
    throw new Error("La configuration a changé. Réessayez.");
  }
  getConfig()[fields[role]] = chatId;
  await logAuditEvent("private_chat_configured", { role, chatId }, adminId);
}

/** Telegram changes the ID when a basic group becomes a supergroup. */
export async function migratePrivateChatBinding(
  oldChatId: number,
  newChatId: number,
): Promise<void> {
  if (!Number.isSafeInteger(newChatId) || newChatId >= 0) {
    throw new Error("Nouvel identifiant de groupe invalide.");
  }
  const kv = await getKv();
  for (const role of ["amateur_chat", "admin_review"] as const) {
    if (getConfig()[fields[role]] !== oldChatId) continue;
    if (chatBindingCollision(newChatId, role)) {
      throw new Error("Le nouveau groupe utilise déjà un autre rôle.");
    }
    const current = await kv.get<Binding>(["private_chat_binding", role]);
    if (current.value && current.value.chatId !== oldChatId) {
      if (current.value.chatId === newChatId) {
        getConfig()[fields[role]] = newChatId;
        continue;
      }
      throw new Error("La configuration du groupe a changé. Réessayez.");
    }
    if (
      !(await kv.atomic().check(current).set(current.key, {
        ...current.value,
        chatId: newChatId,
        configuredBy: current.value?.configuredBy ?? 0,
        configuredAt: current.value?.configuredAt ?? new Date().toISOString(),
        migratedFrom: oldChatId,
      }).commit()).ok
    ) throw new Error("La configuration du groupe a changé. Réessayez.");
    getConfig()[fields[role]] = newChatId;
    await logAuditEvent("private_chat_configured", {
      role,
      chatId: newChatId,
      migratedFrom: oldChatId,
    }, 0);
  }
}
