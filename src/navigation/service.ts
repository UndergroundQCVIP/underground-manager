/**
 * LA CONFRÉRIE — Public Discovery & Navigation (UG-05)
 *
 * Bot-managed, informational public messages:
 *  - a welcome menu in the public welcome channel,
 *  - a pinned information message in the public lobby group,
 *  - a navigation keyboard on the public creator directory posts.
 *
 * Welcome/lobby buttons are plain URL buttons to official bot deep links
 * (https://t.me/<bot>?start=<page>), which work on mobile and desktop.
 * Each directory post also has a callback to refresh its own collection.
 * Nothing here ever contains a private invitation link or member data.
 */

import { getClubName, getConfig } from "../config.ts";
import { getMembershipMode } from "../membership/mode.ts";
import { getNavigationState, saveNavigationState } from "../db/navigation.ts";
import { getDirectorySyncState } from "../db/directory.ts";
import { isMessageGone, isMessageNotModified, sha256Hex } from "../wanted/service.ts";
import { CollectionCategory, MembershipMode } from "../types.ts";
import { withJobLease } from "../ops/locks.ts";
import { withDirectoryLock } from "../directory/lock.ts";

export type NavPage = "explore" | "directory" | "directory_regular" | "directory_retro" | "regular" | "retro" | "amateur" | "how" | "contribute" | "join" | "rules" | "leaderboard";
export const NAV_PAGES: readonly NavPage[] = [
  "explore", "directory", "directory_regular", "directory_retro", "regular", "retro", "amateur", "how", "contribute", "join", "rules", "leaderboard",
];

export interface UrlButton {
  text: string;
  url: string;
}
export type UrlKeyboard = { inline_keyboard: UrlButton[][] };
export type DirectoryKeyboard = {
  inline_keyboard: (UrlButton | { text: string; callback_data: string })[][];
};

export function botLink(page: NavPage): string {
  return `https://t.me/${getConfig().BOT_USERNAME}?start=${page}`;
}

/** The public lobby URL if configured, otherwise the bot's "explore" page (safe fallback). */
export function exploreUrl(): string {
  return getConfig().TELEGRAM_PUBLIC_LOBBY_URL || botLink("explore");
}

/** The public directory channel URL if configured, otherwise the bot's directory page. */
export function directoryUrl(): string {
  return getConfig().PUBLIC_DIRECTORY_URL || botLink("directory");
}

export function welcomeKeyboard(): UrlKeyboard {
  return {
    inline_keyboard: [
      [{ text: "➕ Contribuer du contenu", url: botLink("contribute") }],
      [{ text: "📚 Créateurs en activité", url: botLink("directory_regular") }],
      [{ text: "🎞️ Créateurs qui ne sont plus en activité", url: botLink("directory_retro") }],
      [{ text: "📖 Accès en activité", url: botLink("regular") }, { text: "🎞️ Accès Retro", url: botLink("retro") }],
      [{ text: "🔒 Collection Amateur — accès sur autorisation", url: botLink("amateur") }],
      [{ text: "🧭 Explorer le club", url: exploreUrl() }, { text: "📚 Répertoire des créateurs", url: directoryUrl() }],
      [{ text: "❓ Comment ça fonctionne", url: botLink("how") }, { text: "📜 Règles et soutien", url: botLink("rules") }],
      [{ text: "💎 Joindre LA CONFRÉRIE", url: botLink("join") }],
    ],
  };
}

/** Link straight to the maintained public posts as soon as they have been published. */
async function publishedWelcomeKeyboard(): Promise<UrlKeyboard> {
  const keyboard = welcomeKeyboard();
  const state = await getDirectorySyncState();
  const channelId = getConfig().PUBLIC_DIRECTORY_CHAT_ID;
  if (String(channelId).startsWith("-100")) {
    for (const [index, collection] of (["regular", "retro"] as const).entries()) {
      const slot = state.collections?.[collection];
      if (slot?.channelId === channelId && slot.publishedMessageIds[0]) {
        keyboard.inline_keyboard[index + 1][0].url = `https://t.me/c/${String(channelId).slice(4)}/${slot.publishedMessageIds[0]}`;
      }
    }
  }
  return keyboard;
}

/** Navigation keyboard attached to every public directory post. */
export function directoryNavKeyboard(collection?: CollectionCategory, page = 0, pages = 1): DirectoryKeyboard {
  return {
    inline_keyboard: [
      ...(collection && pages > 1 ? [[
        ...(page > 0 ? [{ text: "◀️ Précédent", callback_data: `dir:page:${collection}:${page - 1}` }] : []),
        ...(page + 1 < pages ? [{ text: "Suivant ▶️", callback_data: `dir:page:${collection}:${page + 1}` }] : []),
      ]] : []),
      [{ text: "➕ Contribuer", url: botLink("contribute") }],
      [{ text: "💎 Rejoindre", url: botLink("join") }],
      ...(collection ? [[{ text: `🔄 Actualiser — ${collection === "regular" ? "en activité" : "inactifs"}`, callback_data: `dir:refresh:${collection}` }]] : []),
    ],
  };
}

export function buildWelcomeMessage(mode: MembershipMode): { text: string; reply_markup: UrlKeyboard } {
  const club = getClubName();
  const methods = mode === "contribution_only" ? "➕ Contribuer : un administrateur peut récompenser vos envois approuvés par un accès."
    : mode === "stars_only" ? "💎 Rejoignez le club avec un abonnement en Étoiles."
    : "➕ Contribuer pour gagner un accès, ou rejoindre le club avec un abonnement en Étoiles.";
  return {
    text:
      `✨ *BIENVENUE À ${club}*\n\n` +
      `Consultez les répertoires des créateurs en activité et de ceux qui ne sont plus en activité. Amateur : accès sur autorisation administrative.\n\n` +
      `${methods}\n\n` +
      `Choisissez une option ci-dessous 👇`,
    reply_markup: welcomeKeyboard(),
  };
}

export function buildLobbyMessage(mode: MembershipMode): { text: string; reply_markup: UrlKeyboard } {
  return buildWelcomeMessage(mode);
}

export interface NavApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number | string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  pinChatMessage?(chatId: number | string, messageId: number): Promise<unknown>;
  deleteMessage?(chatId: number | string, messageId: number): Promise<unknown>;
  editMessageReplyMarkup?(chatId: number | string, messageId: number, other?: Record<string, unknown>): Promise<unknown>;
}

export type SyncOutcome = "not_configured" | "unchanged" | "published" | "updated" | "error";

export async function syncSlotMessage(
  api: NavApiLike,
  slot: "welcome" | "lobby" | "leaderboard",
  chatId: number,
  message: { text: string; reply_markup: UrlKeyboard },
  force: boolean
): Promise<{ outcome: SyncOutcome; error?: string }> {
  return await syncOne(api, slot, chatId, message, force);
}

async function syncOne(
  api: NavApiLike,
  slot: "welcome" | "lobby" | "leaderboard",
  chatId: number,
  message: { text: string; reply_markup: UrlKeyboard },
  force: boolean
): Promise<{ outcome: SyncOutcome; error?: string }> {
  if (!chatId) return { outcome: "not_configured" };
  const leased = await withJobLease(`navigation:${slot}`, 60_000, () => syncOneLocked(api, slot, chatId, message, force));
  return leased.result ?? { outcome: "error", error: "Une actualisation est déjà en cours. Réessayez dans un instant." };
}

async function syncOneLocked(
  api: NavApiLike, slot: "welcome" | "lobby" | "leaderboard", chatId: number,
  message: { text: string; reply_markup: UrlKeyboard }, force: boolean,
): Promise<{ outcome: SyncOutcome; error?: string }> {

  const hash = await sha256Hex(JSON.stringify(message));
  const navigation = await getNavigationState();
  const state = navigation[slot] ?? (slot === "welcome" && navigation.lobby?.chatId === chatId ? navigation.lobby : undefined);
  const sharedLobby = slot === "welcome" && navigation.lobby?.chatId === chatId;
  if (!force && !sharedLobby && state && state.chatId === chatId && state.hash === hash) return { outcome: "unchanged" };

  const saveSlot = async (messageId: number) => {
    await saveNavigationState({ [slot]: { chatId, messageId, hash } });
    if (sharedLobby && navigation.lobby) {
      if (navigation.lobby.messageId !== messageId) {
        if (!api.deleteMessage) return;
        try { await api.deleteMessage(chatId, navigation.lobby.messageId); }
        catch (error) {
          if (!isMessageGone(error) && !String(error).toLowerCase().includes("message to delete not found")) {
            if (!/can't be deleted|cannot be deleted/i.test(String(error))) throw error;
            try { await api.editMessageText(chatId, navigation.lobby.messageId, "🧭 Le menu d'accueil a été regroupé. Consultez le message épinglé.", { reply_markup: { inline_keyboard: [] } }); }
            catch (editError) { if (!isMessageGone(editError) && !isMessageNotModified(editError)) throw editError; }
          }
        }
      }
      await saveNavigationState({ lobby: undefined });
    }
  };

  const opts = { parse_mode: "Markdown", reply_markup: message.reply_markup, link_preview_options: { is_disabled: true } };
  try {
    if (state && state.chatId === chatId) {
      try {
        await api.editMessageText(chatId, state.messageId, message.text, opts);
        await saveSlot(state.messageId);
        if (force && api.pinChatMessage) await api.pinChatMessage(chatId, state.messageId).catch(() => {});
        return { outcome: "updated" };
      } catch (err) {
        if (isMessageNotModified(err)) {
          await saveSlot(state.messageId);
          if (force && api.pinChatMessage) await api.pinChatMessage(chatId, state.messageId).catch(() => {});
          return { outcome: "unchanged" };
        }
        if (!isMessageGone(err)) throw err;
        // The old post was deleted: publish a fresh one below.
      }
    }
    const sent = await api.sendMessage(chatId, message.text, opts);
    await saveSlot(sent.message_id);
    if (api.pinChatMessage) await api.pinChatMessage(chatId, sent.message_id).catch(() => {});
    return { outcome: "published" };
  } catch (err) {
    return { outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface NavSyncResult {
  welcome: { outcome: SyncOutcome; error?: string };
  lobby: { outcome: SyncOutcome; error?: string };
  directory: { outcome: SyncOutcome; error?: string };
}

/** Re-apply the navigation keyboard to the existing public directory posts (no republish). */
export async function syncDirectoryButtons(
  api: NavApiLike,
  force = false
): Promise<{ outcome: SyncOutcome; error?: string }> {
  const job = await withDirectoryLock(() => syncDirectoryButtonsLocked(api, force));
  return job.result ?? { outcome: "unchanged" };
}

async function syncDirectoryButtonsLocked(api: NavApiLike, force: boolean): Promise<{ outcome: SyncOutcome; error?: string }> {
  const config = getConfig();
  if (!config.PUBLIC_DIRECTORY_CHAT_ID) return { outcome: "not_configured" };
  const dir = await getDirectorySyncState();
  if (!api.editMessageReplyMarkup || dir.publishedMessageIds.length === 0) return { outcome: "unchanged" };

  const posts = dir.collections
    ? (["regular", "retro"] as const).flatMap((collection) =>
      (dir.collections?.[collection]?.publishedMessageIds ?? []).map((id) => ({ id,
        markup: directoryNavKeyboard(collection, dir.collections?.[collection]?.activePage, dir.collections?.[collection]?.pageCount) })))
    : dir.publishedMessageIds.map((id) => ({ id, markup: directoryNavKeyboard() }));
  const hash = await sha256Hex(JSON.stringify(posts));
  if (!force && (await getNavigationState()).directoryKeyboardHash === hash) return { outcome: "unchanged" };
  try {
    for (const { id, markup } of posts) {
      try {
        await api.editMessageReplyMarkup(config.PUBLIC_DIRECTORY_CHAT_ID, id, { reply_markup: markup });
      } catch (err) {
        if (!isMessageNotModified(err)) throw err;
      }
    }
    await saveNavigationState({ directoryKeyboardHash: hash });
    return { outcome: "updated" };
  } catch (err) {
    return { outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Synchronize every bot-managed information message. Cheap when nothing changed
 * (content-hash compare), so it is safe to run with the daily directory job.
 */
export async function syncNavigationMessages(
  api: NavApiLike,
  options: { force?: boolean; only?: "welcome" | "lobby" | "accueil" | "directory" } = {}
): Promise<NavSyncResult> {
  const config = getConfig();
  const mode = await getMembershipMode();
  const force = options.force ?? false;
  const skip = { outcome: "unchanged" as SyncOutcome };
  const keyboard = await publishedWelcomeKeyboard();
  const welcome = { ...buildWelcomeMessage(mode), reply_markup: keyboard };
  const lobby = { ...buildLobbyMessage(mode), reply_markup: keyboard };
  const sameAccueil = !!config.TELEGRAM_PUBLIC_WELCOME_CHAT_ID &&
    config.TELEGRAM_PUBLIC_WELCOME_CHAT_ID === config.TELEGRAM_PUBLIC_LOBBY_CHAT_ID;
  return {
    welcome:
      options.only && options.only !== "welcome" && options.only !== "accueil"
        ? skip
        : await syncOne(api, "welcome", config.TELEGRAM_PUBLIC_WELCOME_CHAT_ID, welcome, force),
    lobby:
      sameAccueil || (options.only && options.only !== "lobby" && options.only !== "accueil")
        ? skip
        : await syncOne(api, "lobby", config.TELEGRAM_PUBLIC_LOBBY_CHAT_ID, lobby, force),
    directory:
      options.only && options.only !== "directory" ? skip : await syncDirectoryButtons(api, force),
  };
}

export const LOBBY_SETUP_INSTRUCTIONS =
  `*Publier le menu dans Accueil*\n\n` +
  `1. Ajoutez le bot comme administrateur dans votre canal ou groupe Accueil (publier et épingler).\n` +
  `2. En privé au bot, envoyez \`/setup_accueil -100IDENTIFIANT\`. Vous pouvez aussi envoyer \`/setup_accueil\` directement dans le groupe avec votre profil personnel.\n` +
  `3. Le message de bienvenue en français est publié et épinglé immédiatement, avec les boutons des répertoires.\n` +
  `4. Pour le mettre à jour : *Admin → Paramètres → Navigation publique → Mettre à jour le menu d'accueil*.\n\n` +
  `Utilisez un espace d'information distinct des collections, de Wanted et des clavardages privés.`;
