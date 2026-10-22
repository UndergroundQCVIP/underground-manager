import { Composer, Context } from "grammy";
import { isAdministrator } from "../../config.ts";
import { accueilCollision, bindAccueil } from "../../db/accueil.ts";
import { getNavigationState } from "../../db/navigation.ts";
import { syncNavigationMessages } from "../../navigation/service.ts";
import { adminOnlyMiddleware } from "../middleware/auth.ts";

export const accueilComposer = new Composer();

// Mobile keyboards capitalize commands, and copied channel IDs often omit -100.
// Use one guarded route for all variants, even if Telegram provides no command entity.
accueilComposer.on("message:text").hears(/^\/?setup_accueil(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i, async (ctx, next) => {
  const mentionedBot = ctx.match[1];
  if (mentionedBot && mentionedBot.toLowerCase() !== ctx.me.username.toLowerCase()) return await next();
  if (ctx.message.sender_chat && !isAdministrator(ctx.from?.id ?? 0)) {
    await ctx.reply("Envoyez /setup_accueil avec votre profil personnel, ou en privé au bot avec l'identifiant du canal Accueil.");
    return;
  }
  const argument = (ctx.match[2] ?? "").trim();
  await adminOnlyMiddleware(ctx, () => setupAccueil(ctx, argument));
});

async function setupAccueil(ctx: Context, argument: string): Promise<void> {
  if (!ctx.from || !ctx.chat || !isAdministrator(ctx.from.id)) return;
  let target = ctx.chat.type === "private" ? 0 : ctx.chat.id;
  if (argument) {
    if (/^-[1-9]\d*$/.test(argument)) target = Number(argument);
    else if (/^[1-9]\d*$/.test(argument)) {
      // https://core.telegram.org/api/bots/ids — short channel IDs use this offset.
      const id = Number(argument);
      target = id > 1_000_000_000_000 ? -id : -(1_000_000_000_000 + id);
    } else target = NaN;
  }
  if (!Number.isSafeInteger(target) || target >= 0) {
    await ctx.reply("Ajoutez le bot comme administrateur dans Accueil, puis envoyez en privé : /setup_accueil -100IDENTIFIANT\nVous pouvez aussi coller l'identifiant sans -100.\nDans un groupe, envoyez /setup_accueil directement avec votre profil personnel.");
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
    await ctx.reply(`✅ Accueil configuré (${target}). Le menu de bienvenue en français est publié et son épinglage a été demandé.${link}\nPour l'actualiser : Admin → Paramètres → Navigation publique → Mettre à jour le menu d'accueil.`, {
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    // Never include Telegram request payloads or credentials in a user-visible exception.
    const detail = error instanceof Error ? error.message : "Erreur de publication";
    await ctx.reply(`⚠️ ${detail}\nVérifiez l'identifiant d'Accueil et les droits du bot, puis réessayez /setup_accueil.`);
  }
}
