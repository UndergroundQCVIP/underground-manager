import { InlineKeyboard } from "grammy";
import { getMembershipSummary } from "../db/entitlements.ts";
import { getOrCreateJoinLink, InviteApiLike } from "./links.ts";
import { getChatId, getSpaceTitle } from "./spaces.ts";

export const JOIN_INSTRUCTIONS =
  "Touchez « Joindre » pour chaque espace. Votre demande sera approuvée automatiquement si votre accès est toujours actif.";

/** A grant cannot add a Telegram member; put authorized join links in its receipt instead. */
export async function accessJoinKeyboard(api: Partial<InviteApiLike>, userId: number): Promise<InlineKeyboard> {
  const kb = new InlineKeyboard();
  try {
    const { accessibleSpaces } = await getMembershipSummary(userId);
    if (api.createChatInviteLink) {
      const inviteApi: InviteApiLike = {
        createChatInviteLink: (chatId, options) => api.createChatInviteLink!(chatId, options),
      };
      for (const spaceId of accessibleSpaces) {
        if (!getChatId(spaceId)) continue;
        try {
          const link = await getOrCreateJoinLink(inviteApi, spaceId);
          kb.url(`👉 Joindre ${getSpaceTitle(spaceId)}`, link).row();
        } catch (error) {
          // A link failure must not undo a grant or prevent its confirmation.
          console.error(`[Access onboarding] Link unavailable for ${spaceId}:`, error);
        }
      }
    }
  } catch (error) {
    console.error("[Access onboarding] Could not load current access:", error);
  }
  // Also works when links failed, and rechecks access if an old receipt is opened later.
  return kb.text("🔄 Vérifier mes accès et renouveler les liens", "member:channels:refresh");
}
