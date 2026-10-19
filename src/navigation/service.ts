/**
 * LA CONFRÉRIE — Public Discovery & Navigation (UG-05)
 *
 * Bot-managed, informational public messages:
 *  - a welcome menu in the public welcome channel,
 *  - a pinned information message in the public lobby group,
 *  - a navigation keyboard on the public creator directory posts.
 *
 * All buttons are plain URL buttons to official bot deep links
 * (https://t.me/<bot>?start=<page>), which work on mobile and desktop.
 * Nothing here ever contains a private invitation link or member data.
 */

import { getClubName, getConfig } from "../config.ts";
import { getMembershipMode } from "../membership/mode.ts";
import { membershipMethods } from "../bot/messages.ts";
import { getNavigationState, saveNavigationState } from "../db/navigation.ts";
import { getDirectorySyncState } from "../db/directory.ts";
import { isMessageGone, isMessageNotModified, sha256Hex } from "../wanted/service.ts";
import { MembershipMode } from "../types.ts";

export type NavPage = "explore" | "directory" | "regular" | "retro" | "how" | "contribute" | "join" | "rules";
export const NAV_PAGES: readonly NavPage[] = [
  "explore", "directory", "regular", "retro", "how", "contribute", "join", "rules",
];

export interface UrlButton {
  text: string;
  url: string;
}
export type UrlKeyboard = { inline_keyboard: UrlButton[][] };

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
      [{ text: "🧭 Explorer le club", url: exploreUrl() }, { text: "📚 Répertoire des créateurs", url: directoryUrl() }],
      [{ text: "📖 Collection Regular", url: botLink("regular") }, { text: "🎞️ Collection Retro", url: botLink("retro") }],
      [{ text: "❓ Comment ça fonctionne", url: botLink("how") }, { text: "➕ Contribuer du contenu", url: botLink("contribute") }],
      [{ text: "💎 Joindre LA CONFRÉRIE", url: botLink("join") }, { text: "📜 Règles et soutien", url: botLink("rules") }],
    ],
  };
}

/** Navigation keyboard attached to every public directory post. */
export function directoryNavKeyboard(): UrlKeyboard {
  return {
    inline_keyboard: [
      [{ text: "🧭 Explorer LA CONFRÉRIE", url: exploreUrl() }, { text: "❓ Comment adhérer", url: botLink("how") }],
      [{ text: "➕ Contribuer du contenu", url: botLink("contribute") }, { text: "💎 Options d'adhésion", url: botLink("join") }],
    ],
  };
}

export function buildWelcomeMessage(mode: MembershipMode): { text: string; reply_markup: UrlKeyboard } {
  const club = getClubName();
  return {
    text:
      `✨ *BIENVENUE À ${club}*\n\n` +
      `Une collection de créateurs propulsée par la communauté.\n\n` +
      `${membershipMethods(mode)}\n\n` +
      `Choisissez une option ci-dessous 👇`,
    reply_markup: welcomeKeyboard(),
  };
}

export function buildLobbyMessage(mode: MembershipMode): { text: string; reply_markup: UrlKeyboard } {
  const club = getClubName();
  return {
    text:
      `🧭 *${club}*\n\n` +
      `Bienvenue dans notre collection de créateurs propulsée par la communauté.\n\n` +
      `*À explorer :*\n` +
      `• Collection *Regular* — forum privé de créateurs\n` +
      `• Collection *Retro* — forum privé distinct\n` +
      `• Répertoire public des créateurs\n` +
      `• Liste de souhaits et votes (réservés aux membres)\n` +
      `• Comment fonctionnent les contributions\n` +
      `• Options d'adhésion, règles et soutien\n\n` +
      `*À savoir :*\n` +
      `• Regular et Retro sont deux forums privés séparés.\n` +
      `• Les membres peuvent gagner un accès temporaire grâce à des contributions approuvées.\n` +
      `• Les administrateurs choisissent la durée de la récompense et le ou les forums accessibles.\n` +
      `• Tous les envois acceptés ne donnent pas nécessairement droit à une récompense.\n` +
      `• Seul du contenu approuvé et autorisé est publié.\n` +
      `• L'accès prend fin lorsque le membre n'a plus aucun droit valide.\n\n` +
      `*Options d'adhésion actuelles :*\n${membershipMethods(mode)}`,
    reply_markup: welcomeKeyboard(),
  };
}

export interface NavApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number | string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  pinChatMessage?(chatId: number | string, messageId: number): Promise<unknown>;
  editMessageReplyMarkup?(chatId: number | string, messageId: number, other?: Record<string, unknown>): Promise<unknown>;
}

export type SyncOutcome = "not_configured" | "unchanged" | "published" | "updated" | "error";

async function syncOne(
  api: NavApiLike,
  slot: "welcome" | "lobby",
  chatId: number,
  message: { text: string; reply_markup: UrlKeyboard },
  force: boolean
): Promise<{ outcome: SyncOutcome; error?: string }> {
  if (!chatId) return { outcome: "not_configured" };

  const hash = await sha256Hex(JSON.stringify(message));
  const state = (await getNavigationState())[slot];
  if (!force && state && state.chatId === chatId && state.hash === hash) return { outcome: "unchanged" };

  const opts = { parse_mode: "Markdown", reply_markup: message.reply_markup, link_preview_options: { is_disabled: true } };
  try {
    if (state && state.chatId === chatId) {
      try {
        await api.editMessageText(chatId, state.messageId, message.text, opts);
        await saveNavigationState({ [slot]: { chatId, messageId: state.messageId, hash } });
        return { outcome: "updated" };
      } catch (err) {
        if (isMessageNotModified(err)) {
          await saveNavigationState({ [slot]: { chatId, messageId: state.messageId, hash } });
          return { outcome: "unchanged" };
        }
        if (!isMessageGone(err)) throw err;
        // The old post was deleted: publish a fresh one below.
      }
    }
    const sent = await api.sendMessage(chatId, message.text, opts);
    if (api.pinChatMessage) await api.pinChatMessage(chatId, sent.message_id).catch(() => {});
    await saveNavigationState({ [slot]: { chatId, messageId: sent.message_id, hash } });
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
  const config = getConfig();
  if (!config.PUBLIC_DIRECTORY_CHAT_ID) return { outcome: "not_configured" };
  const dir = await getDirectorySyncState();
  if (!api.editMessageReplyMarkup || dir.publishedMessageIds.length === 0) return { outcome: "unchanged" };

  const markup = directoryNavKeyboard();
  const hash = await sha256Hex(JSON.stringify([markup, dir.publishedMessageIds]));
  if (!force && (await getNavigationState()).directoryKeyboardHash === hash) return { outcome: "unchanged" };
  try {
    for (const id of dir.publishedMessageIds) {
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
  options: { force?: boolean; only?: "welcome" | "lobby" | "directory" } = {}
): Promise<NavSyncResult> {
  const config = getConfig();
  const mode = await getMembershipMode();
  const force = options.force ?? false;
  const skip = { outcome: "unchanged" as SyncOutcome };
  return {
    welcome:
      options.only && options.only !== "welcome"
        ? skip
        : await syncOne(api, "welcome", config.TELEGRAM_PUBLIC_WELCOME_CHAT_ID, buildWelcomeMessage(mode), force),
    lobby:
      options.only && options.only !== "lobby"
        ? skip
        : await syncOne(api, "lobby", config.TELEGRAM_PUBLIC_LOBBY_CHAT_ID, buildLobbyMessage(mode), force),
    directory:
      options.only && options.only !== "directory" ? skip : await syncDirectoryButtons(api, force),
  };
}

export const LOBBY_SETUP_INSTRUCTIONS =
  `*Configurer le groupe public d'accueil*\n` +
  `1. Dans Telegram, créez un groupe (ou un canal) nommé \`${"LA CONFRÉRIE | ACCUEIL"}\` et rendez-le public (lien t.me).\n` +
  `2. Ajoutez le robot comme administrateur avec les droits *Publier des messages*, *Modifier les messages* et *Épingler des messages*.\n` +
  `3. Obtenez l'identifiant numérique du groupe (commençant par -100) et définissez \`TELEGRAM_PUBLIC_LOBBY_CHAT_ID\`.\n` +
  `4. Définissez \`TELEGRAM_PUBLIC_LOBBY_URL\` avec le lien public (ex. https://t.me/votre_groupe).\n` +
  `5. Optionnel : \`TELEGRAM_PUBLIC_WELCOME_CHAT_ID\` (canal d'accueil) et \`PUBLIC_DIRECTORY_URL\` (lien du canal du répertoire).\n` +
  `6. Redéployez, puis utilisez *Paramètres → Navigation publique → Synchroniser*.\n\n` +
  `⚠️ Ne réutilisez jamais le clavardage général privé : il reste réservé aux membres.`;
