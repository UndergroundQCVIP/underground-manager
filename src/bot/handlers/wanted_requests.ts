/** Separate admin-managed wanted list, with direct links into contribution review. */
import { Composer, Context, InlineKeyboard } from "grammy";
import { isAdministrator } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { AdminInputRequest, peekAdminInput, requestAdminInput, takeAdminInput } from "../../db/admin_input.ts";
import { cleanRequestName, cleanRequestUrl, getWantedRequest, listWantedRequests, saveWantedRequest } from "../../db/wanted_requests.ts";
import { WANTED_REQUEST_CLASSES, WantedRequest, WantedRequestClass } from "../../types.ts";
import { escapeMd, escapeMdUrl } from "../../util/markdown.ts";
import { isMessageNotModified } from "../../wanted/service.ts";
import { startWantedRequestContribution, wantedRequestLink } from "../../wanted/requests.ts";

export const wantedRequestsComposer = new Composer();
const PAGE_SIZE = 8;
type Filter = "all" | WantedRequestClass;
type RequestInput = Extract<AdminInputRequest, { type: "wanted_request" }>;

async function show(ctx: Context, text: string, kb: InlineKeyboard) {
  const opts = { parse_mode: "Markdown" as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
  if (!ctx.callbackQuery) { await ctx.reply(text, opts); return; }
  try { await ctx.editMessageText(text, opts); }
  catch (err) { if (!isMessageNotModified(err)) throw err; }
}

export async function showWantedRequestList(ctx: Context, filter: Filter = "all", requestedPage = 0, admin = false, archived = false): Promise<void> {
  const entries = await listWantedRequests({ category: filter === "all" ? undefined : filter, status: archived ? "archived" : "active" });
  const row = (entry: WantedRequest) => `• [${escapeMd(entry.name)}](${escapeMdUrl(entry.profileUrl)}) · [📤 Envoyer](${wantedRequestLink(entry.id)})\n`;
  const pages: WantedRequest[][] = [[]];
  let length = 0;
  for (const entry of entries) {
    const rowLength = row(entry).length;
    if (pages.at(-1)!.length >= PAGE_SIZE || length + rowLength > 3000) {
      pages.push([]);
      length = 0;
    }
    pages.at(-1)!.push(entry);
    length += rowLength;
  }
  const page = Math.min(requestedPage, pages.length - 1);
  const visible = pages[page];
  let text = `🔎 *LISTE RECHERCHÉE${archived ? " — PERSONNES RETIRÉES" : ""}*\n` +
    `Liste mise à jour par les administrateurs. Vous avez du contenu ? Utilisez le lien « Envoyer » de la personne concernée.\n\n`;
  for (const category of ["creatrices", "amateurs"] as const) {
    const group = visible.filter((e) => e.category === category);
    if (!group.length) continue;
    text += `*${WANTED_REQUEST_CLASSES[category]}*\n`;
    for (const entry of group) {
      text += row(entry);
    }
    text += "\n";
  }
  if (!entries.length) text += "Aucune personne dans cette liste pour le moment.\n";
  text += `Page ${page + 1}/${pages.length} · ${entries.length} personne(s)`;
  const kb = new InlineKeyboard();
  if (admin) {
    for (const entry of visible) kb.text(`✏️ ${entry.name}`, `wreq:admin:view:${entry.id}`).row();
    const base = archived ? "wreq:admin:archived" : "wreq:admin:list";
    if (page > 0) kb.text("◀️ Préc.", `${base}:${page - 1}`);
    if (page + 1 < pages.length) kb.text("Suiv. ▶️", `${base}:${page + 1}`);
    kb.row().text("🔄 Actualiser", `${base}:${page}`).text("➕ Ajouter", "wreq:admin:add").row();
    kb.text(archived ? "Voir la liste active" : "Voir les personnes retirées", archived ? "wreq:admin:list:0" : "wreq:admin:archived:0").row();
    kb.text("⬅️ Administration", "admin:menu");
  } else {
    for (const value of ["all", "creatrices", "amateurs"] as const) {
      kb.text(`${value === filter ? "• " : ""}${value === "all" ? "Tous" : WANTED_REQUEST_CLASSES[value]}`, `wreq:list:${value}:0`);
    }
    kb.row();
    if (page > 0) kb.text("◀️ Préc.", `wreq:list:${filter}:${page - 1}`);
    if (page + 1 < pages.length) kb.text("Suiv. ▶️", `wreq:list:${filter}:${page + 1}`);
    kb.row().text("🔄 Voir la liste à jour", `wreq:list:${filter}:${page}`).row();
    kb.text("🗳️ Suggestions et votes", "wanted:menu").text("⬅️ Menu principal", "member:home");
  }
  await show(ctx, text, kb);
}

export async function showWantedRequestSubmission(ctx: Context, id: string): Promise<void> {
  if (ctx.chat?.type !== "private" || !ctx.from) return;
  const result = await startWantedRequestContribution(ctx.from.id, id);
  if (!result.ok || !result.contribution) {
    await ctx.reply(`⚠️ ${result.error}`, { reply_markup: new InlineKeyboard().text("🔄 Liste à jour", "wreq:menu") });
    return;
  }
  const source = result.contribution.wantedRequest!;
  await ctx.reply(
    `📤 *Contenu recherché : ${escapeMd(source.name)}*\n` +
    `*Classe :* ${WANTED_REQUEST_CLASSES[source.category]} · [Profil social](${escapeMdUrl(source.profileUrl)})\n\n` +
    `Envoyez vos photos et vidéos ici (albums acceptés), puis appuyez sur *Terminer*.\n` +
    `Un administrateur décidera de la publication et d'une éventuelle récompense.`,
    { parse_mode: "Markdown", link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().text("✅ Terminer", "contrib:finish").text("❌ Annuler", "contrib:cancel") }
  );
}

wantedRequestsComposer.command("recherches", async (ctx) => {
  if (ctx.chat.type === "private") await showWantedRequestList(ctx);
});
wantedRequestsComposer.callbackQuery("wreq:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showWantedRequestList(ctx);
});
wantedRequestsComposer.callbackQuery(/^wreq:list:(all|creatrices|amateurs):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showWantedRequestList(ctx, ctx.match[1] as Filter, Number(ctx.match[2]));
});

// Admin text prompts are private and belong to this feature only. Other prompt types pass through.
wantedRequestsComposer.on("message:text", async (ctx, next) => {
  if (ctx.chat.type !== "private" || !isAdministrator(ctx.from.id) || ctx.message.text.startsWith("/")) return next();
  const input = await peekAdminInput(ctx.from.id);
  if (input?.type !== "wanted_request") return next();
  await takeAdminInput(ctx.from.id);
  try {
    if (input.field === "category") {
      await requestAdminInput(ctx.from.id, input);
      await ctx.reply("Choisissez Créatrices ou Amateurs avec les boutons ci-dessous.", { reply_markup: categoryKeyboard(input) });
      return;
    }
    const value = input.field === "name" ? cleanRequestName(ctx.message.text) : cleanRequestUrl(ctx.message.text);
    if (input.entryId) {
      await saveWantedRequest(ctx.from.id, input.field === "name" ? { name: value } : { profileUrl: value }, input.entryId);
      await showAdminEntry(ctx, input.entryId);
    } else if (input.field === "name") {
      await requestAdminInput(ctx.from.id, { ...input, name: value, field: "url" });
      await ctx.reply("🔗 Envoyez le lien du profil social de cette personne.", { reply_markup: cancelKeyboard() });
    } else {
      const nextInput: RequestInput = { ...input, profileUrl: value, field: "category" };
      await requestAdminInput(ctx.from.id, nextInput);
      await ctx.reply("Choisissez la classe :", { reply_markup: categoryKeyboard(nextInput) });
    }
  } catch (err) {
    await requestAdminInput(ctx.from.id, input);
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`, { reply_markup: cancelKeyboard() });
  }
});

wantedRequestsComposer.use(adminRouteGuard({ callbackPrefixes: ["wreq:admin:"], commands: [] }));
wantedRequestsComposer.use(async (ctx, next) => {
  if (ctx.callbackQuery?.data?.startsWith("wreq:admin:") && ctx.chat?.type !== "private") {
    await ctx.answerCallbackQuery({ text: "Gérez la liste dans votre conversation privée avec le robot.", show_alert: true });
    return;
  }
  await next();
});

const cancelKeyboard = () => new InlineKeyboard().text("❌ Annuler", "wreq:admin:cancel");
function categoryKeyboard(input: RequestInput): InlineKeyboard {
  return new InlineKeyboard().text("Créatrices", `wreq:admin:class:${input.nonce}:creatrices`)
    .text("Amateurs", `wreq:admin:class:${input.nonce}:amateurs`).row().text("❌ Annuler", "wreq:admin:cancel");
}

async function showAdminEntry(ctx: Context, id: string) {
  const entry = await getWantedRequest(id);
  if (!entry) { await ctx.reply("Personne recherchée introuvable."); return; }
  await show(ctx,
    `🔎 *${escapeMd(entry.name)}*\n*Classe :* ${WANTED_REQUEST_CLASSES[entry.category]}\n` +
    `[Profil social](${escapeMdUrl(entry.profileUrl)})\n*Statut :* ${entry.status === "active" ? "recherché" : "retiré de la liste"}\n\n` +
    `Lien pour envoyer du contenu :\n${wantedRequestLink(entry.id)}`,
    new InlineKeyboard().text("✏️ Nom", `wreq:admin:edit:${id}:name`).text("🔗 Profil", `wreq:admin:edit:${id}:url`).row()
      .text("🏷 Classe", `wreq:admin:edit:${id}:category`).row()
      .text(entry.status === "active" ? "Retirer de la liste" : "Remettre dans la liste", `wreq:admin:status:${id}:${entry.status === "active" ? "archived" : "active"}`).row()
      .text("⬅️ Liste recherchée", "wreq:admin:list:0")
  );
}

wantedRequestsComposer.callbackQuery(/^wreq:admin:(list|archived):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showWantedRequestList(ctx, "all", Number(ctx.match[2]), true, ctx.match[1] === "archived");
});
wantedRequestsComposer.callbackQuery(/^wreq:admin:view:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAdminEntry(ctx, ctx.match[1]);
});
wantedRequestsComposer.callbackQuery("wreq:admin:add", async (ctx) => {
  await requestAdminInput(ctx.from.id, { type: "wanted_request", nonce: crypto.randomUUID(), field: "name" });
  await ctx.answerCallbackQuery();
  await ctx.reply("✏️ Quel est le nom de la personne recherchée ?", { reply_markup: cancelKeyboard() });
});
wantedRequestsComposer.callbackQuery(/^wreq:admin:edit:([\w-]+):(name|url|category)$/, async (ctx) => {
  const input: RequestInput = { type: "wanted_request", nonce: crypto.randomUUID(), entryId: ctx.match[1], field: ctx.match[2] as RequestInput["field"] };
  await requestAdminInput(ctx.from.id, input);
  await ctx.answerCallbackQuery();
  await ctx.reply(input.field === "category" ? "Choisissez la classe :" : input.field === "name" ? "Envoyez le nouveau nom :" : "Envoyez le nouveau lien de profil social :", {
    reply_markup: input.field === "category" ? categoryKeyboard(input) : cancelKeyboard(),
  });
});
wantedRequestsComposer.callbackQuery(/^wreq:admin:class:([\w-]+):(creatrices|amateurs)$/, async (ctx) => {
  const input = await peekAdminInput(ctx.from.id);
  await ctx.answerCallbackQuery();
  if (input?.type !== "wanted_request" || input.field !== "category" || input.nonce !== ctx.match[1]) {
    await ctx.reply("Ce choix a expiré. Rouvrez la liste recherchée.");
    return;
  }
  try {
    const entry = await saveWantedRequest(ctx.from.id, { ...(input.entryId ? {} : { name: input.name, profileUrl: input.profileUrl }), category: ctx.match[2] as WantedRequestClass }, input.entryId);
    await takeAdminInput(ctx.from.id);
    await showAdminEntry(ctx, entry.id);
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`, { reply_markup: cancelKeyboard() });
  }
});
wantedRequestsComposer.callbackQuery(/^wreq:admin:status:([\w-]+):(active|archived)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const entry = await getWantedRequest(ctx.match[1]);
  if (!entry) { await ctx.reply("Personne recherchée introuvable."); return; }
  await saveWantedRequest(ctx.from.id, { status: ctx.match[2] as "active" | "archived" }, entry.id);
  await showAdminEntry(ctx, entry.id);
});
wantedRequestsComposer.callbackQuery("wreq:admin:cancel", async (ctx) => {
  if ((await peekAdminInput(ctx.from.id))?.type === "wanted_request") await takeAdminInput(ctx.from.id);
  await ctx.answerCallbackQuery();
  await showWantedRequestList(ctx, "all", 0, true);
});
