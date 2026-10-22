import { Composer } from "grammy";
import { isAdministrator } from "../../config.ts";
import { accueilCollision, bindAccueil } from "../../db/accueil.ts";
import { getNavigationState } from "../../db/navigation.ts";
import { syncNavigationMessages } from "../../navigation/service.ts";
import { adminRouteGuard } from "../middleware/auth.ts";

export const accueilComposer = new Composer();
accueilComposer.use(adminRouteGuard({ callbackPrefixes: [], commands: ["setup_accueil"] }));

accueilComposer.command("setup_accueil", async ctx => {
  if (!ctx.from || !isAdministrator(ctx.from.id)) return;
  const argument = ctx.match.trim();
  const target = argument ? Number(argument) : ctx.chat.type === "private" ? 0 : ctx.chat.id;
  if (!Number.isSafeInteger(target) || target >= 0) {
    await ctx.reply("Ajoutez le bot comme administrateur dans Accueil, puis envoyez en privé : /setup_accueil -100IDENTIFIANT\nDans un groupe, vous pouvez envoyer /setup_accueil directement avec votre profil personnel.");
    return;
  }
  try {
    if (accueilCollision(target)) throw new Error("Accueil doit être distinct des espaces privés et du canal du répertoire.");
    const chat = await ctx.api.getChat(target);
    if (!["channel", "supergroup", "group"].includes(chat.type)) throw new Error("Choisissez un canal ou groupe Accueil.");
    const member = await ctx.api.getChatMember(target, ctx.me.id);
    if (member.status !== "administrator" && member.status !== "creator") throw new Error("Ajoutez d'abord le bot comme administrateur dans Accueil.");
    if (chat.type === "channel" && member.status === "administrator" && !member.can_post_messages) {
      throw new Error("Autorisez le bot à publier des messages dans Accueil.");
    }
    await bindAccueil(target, ctx.from.id);
    const result = await syncNavigationMessages(ctx.api, { force: true, only: "welcome" });
    if (result.welcome.outcome === "error") throw new Error(result.welcome.error);
    const state = (await getNavigationState()).welcome;
    const link = state && String(target).startsWith("-100")
      ? `\nhttps://t.me/c/${String(target).slice(4)}/${state.messageId}` : "";
    await ctx.reply(`✅ Accueil configuré. Le menu de bienvenue en français est publié et son épinglage a été demandé.${link}\nPour l'actualiser : Admin → Paramètres → Navigation publique → Mettre à jour le menu d'accueil.`, {
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    // Never include Telegram request payloads or credentials in a user-visible exception.
    const detail = error instanceof Error ? error.message : "Erreur de publication";
    await ctx.reply(`⚠️ ${detail}\nVérifiez l'identifiant d'Accueil et les droits du bot, puis réessayez /setup_accueil.`);
  }
});
