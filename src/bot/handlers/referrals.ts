/**
 * LA CONFRÉRIE — Referral menu (UG-06)
 */

import { Composer, InlineKeyboard } from "grammy";
import { referralLink, referralStats } from "../../referrals/service.ts";
import { getClubName } from "../../config.ts";

export const referralsComposer = new Composer();

referralsComposer.callbackQuery("ref:menu", async (ctx) => {
  const userId = ctx.from.id;
  const link = await referralLink(userId);
  const stats = await referralStats(userId);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Rejoins ${getClubName()} !`)}`;

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🤝 *PARRAINAGE*\n\n` +
      `Votre lien personnel :\n\`${link}\`\n\n` +
      `• Personnes parrainées : *${stats.referred}*\n` +
      `• Jours gagnés grâce à vos parrainages : *${stats.daysEarned}*\n\n` +
      `*Comment ça fonctionne*\n` +
      `• Quand une personne qui découvre le robot grâce à votre lien est récompensée pour une contribution approuvée, vous recevez *50 % des jours* qu'elle a gagnés (arrondis vers le haut), pour les *mêmes forums*.\n` +
      `• Pour chaque tranche de *100 Étoiles* qu'elle dépense (renouvellements inclus), vous recevez *1 jour*.\n` +
      `• Aucune limite. Seules les personnes qui ouvrent le robot pour la première fois avec votre lien comptent, et le parrain ne peut jamais changer.`,
    {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().url("📤 Partager mon lien", share).row().text("⬅️ Menu principal", "member:home"),
    }
  );
});
