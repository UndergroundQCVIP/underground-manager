/**
 * LA CONFRÉRIE — Legacy range import (UG-06)
 *
 * Copies a block of message IDs from an old chat (e.g. the discussion group holding the
 * "comments" of the legacy Tokebec channel) into a creator topic, using only the official
 * Bot API (copyMessages). The administrator gives the FIRST and LAST message of that
 * creator's block as two links, from inside the destination topic.
 *
 * What the Bot API cannot do: read a chat's history or tell which thread a message
 * belongs to. So the range is trusted only after an explicit preview, and the whole import
 * can be undone (the bot deletes exactly the copies it made).
 *
 * Safety: protected content is detected and respected; progress is durable and resumable
 * without re-copying; Telegram rate limits are honoured; overlapping re-imports are refused.
 */

import { logAuditEvent } from "../db/audit.ts";
import { getCreator, patchCreatorFields, recordCreatorMediaUpload } from "../db/creators.ts";
import {
  deleteImportBatchIds,
  getImportJob,
  listImportDestIds,
  listImportJobs,
  saveImportBatchIds,
  saveImportJob,
  updateImportJob,
} from "../db/imports.ts";
import { recordMediaIndex } from "../db/media_index.ts";
import { classifyTelegramError } from "../migration/service.ts";
import { ImportJob } from "../types.ts";

export const MAX_IMPORT_SPAN = 20_000; // message ids in one block
const BATCH = 100; // Telegram's copyMessages maximum
const LEASE_MS = 90_000;
const BUDGET_MS = 20_000;
const SAMPLES = 6;

export interface ImportApiLike {
  getMe(): Promise<{ id: number }>;
  getChat(chatId: number | string): Promise<{ id: number; title?: string; has_protected_content?: boolean }>;
  getChatMember(chatId: number | string, userId: number): Promise<{ status: string }>;
  copyMessages(
    chatId: number | string,
    fromChatId: number | string,
    ids: number[],
    other?: { message_thread_id?: number }
  ): Promise<{ message_id: number }[]>;
  deleteMessages(chatId: number | string, ids: number[]): Promise<boolean>;
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------------------------

export interface ParsedLink {
  chat: number | string;
  messageId: number;
}

/**
 * Accepts message links of the forms
 *   https://t.me/c/<chat>/<message>        https://t.me/c/<chat>/<topic>/<message>
 *   https://t.me/<publicname>/<message>
 * (a trailing ?thread=… is ignored). Channel "?comment=" links name the CHANNEL, not the
 * discussion group that actually holds the comments, so they are refused with guidance.
 */
export function parseSourceLink(raw: string): ParsedLink | { error: string } {
  const link = raw.trim();
  if (/[?&]comment=/.test(link)) {
    return {
      error:
        "Ce lien désigne le canal, pas le groupe de discussion qui contient les commentaires. Dans les commentaires, faites un clic droit sur un message → « Copier le lien du message ».",
    };
  }
  const clean = link.replace(/[?#].*$/, "");
  let m = clean.match(/^(?:https?:\/\/)?t\.me\/c\/(\d+)\/(?:\d+\/)?(\d+)$/i);
  if (m) return { chat: Number(`-100${m[1]}`), messageId: Number(m[2]) };
  m = clean.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z][\w]{3,})\/(\d+)$/);
  if (m && !["c", "s", "joinchat", "addstickers"].includes(m[1].toLowerCase())) {
    return { chat: `@${m[1]}`, messageId: Number(m[2]) };
  }
  return { error: "Lien de message non reconnu (attendu : https://t.me/c/<id>/<message>)." };
}

function sampleIds(from: number, to: number): number[] {
  const span = to - from;
  const ids = new Set<number>([from, to]);
  for (let i = 1; i < SAMPLES - 1; i++) ids.add(from + Math.round((span * i) / (SAMPLES - 1)));
  return [...ids].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------
// Prepare (dry run + preview). Writes nothing to the destination topic.
// ---------------------------------------------------------------------------------------------

export async function prepareImport(
  api: ImportApiLike,
  params: { adminId: number; creatorId: string; link1: string; link2: string; isNewCreator: boolean }
): Promise<{ ok: boolean; job?: ImportJob; error?: string; samplesSent?: number }> {
  const creator = await getCreator(params.creatorId);
  if (!creator) return { ok: false, error: "Créateur introuvable." };

  const a = parseSourceLink(params.link1);
  const b = parseSourceLink(params.link2);
  if ("error" in a) return { ok: false, error: a.error };
  if ("error" in b) return { ok: false, error: b.error };
  if (a.chat !== b.chat) return { ok: false, error: "Les deux liens doivent venir du même groupe." };

  const fromId = Math.min(a.messageId, b.messageId);
  const toId = Math.max(a.messageId, b.messageId);
  if (toId - fromId + 1 > MAX_IMPORT_SPAN) {
    return { ok: false, error: `Bloc trop grand (maximum ${MAX_IMPORT_SPAN} messages par import).` };
  }

  // Never import the same block into the same creator twice (it would duplicate content).
  for (const j of await listImportJobs()) {
    if (
      j.creatorId === creator.id &&
      j.sourceChat === a.chat &&
      ["prepared", "running", "needs_review", "failed", "done"].includes(j.status) &&
      fromId <= j.toId &&
      toId >= j.fromId
    ) {
      return {
        ok: false,
        error: `Ce bloc chevauche un import déjà ${j.status === "done" ? "terminé" : "en cours"} pour ${creator.name} (${j.fromId}–${j.toId}). Annulez-le d'abord si vous voulez le refaire.`,
      };
    }
  }

  const job: ImportJob = {
    id: crypto.randomUUID(),
    adminId: params.adminId,
    creatorId: creator.id,
    creatorName: creator.name,
    sourceChat: a.chat,
    fromId,
    toId,
    destChatId: creator.chatId,
    destTopicId: creator.topicId,
    status: "prepared",
    cursor: fromId,
    batchesDone: 0,
    requested: 0,
    copied: 0,
    skipped: 0,
    isNewCreator: params.isNewCreator,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Preflight (read-only): can Telegram copy from there at all?
  try {
    const me = await api.getMe();
    const chat = await api.getChat(a.chat);
    job.sourceTitle = chat.title;
    if (chat.has_protected_content) {
      job.status = "blocked";
      job.blockedReason = "protected_content";
      job.note =
        "La source a « Restreindre l'enregistrement du contenu » activé : Telegram interdit la copie et le robot ne contourne pas cette protection. Désactivez-la vous-même pour la durée du transfert si vous y êtes autorisé.";
    } else {
      const member = await api.getChatMember(a.chat, me.id);
      if (member.status === "left" || member.status === "kicked") {
        job.status = "blocked";
        job.blockedReason = "bot_not_in_source";
        job.note = "Le robot n'est pas membre du groupe source : ajoutez-le (comme membre ou administrateur) puis relancez /import.";
      }
    }
  } catch (err) {
    job.status = "blocked";
    job.blockedReason = "source_unreachable";
    job.note = `Source inaccessible : ${classifyTelegramError(err).message}`;
  }

  await saveImportJob(job);

  // Preview: a handful of evenly spaced messages go to the ADMIN's private chat (never the topic),
  // so a wrong range (another creator's content) is spotted before anything is published.
  let samplesSent = 0;
  if (job.status === "prepared") {
    try {
      const sent = await api.copyMessages(params.adminId, a.chat, sampleIds(fromId, toId));
      samplesSent = sent.length;
    } catch { /* preview is best effort */ }
  }
  return { ok: true, job, samplesSent };
}

// ---------------------------------------------------------------------------------------------
// Start / run / resume
// ---------------------------------------------------------------------------------------------

export async function startImport(
  api: ImportApiLike,
  jobId: string,
  adminId: number,
  rightsConfirmed: boolean
): Promise<{ ok: boolean; error?: string; job?: ImportJob }> {
  if (!rightsConfirmed) return { ok: false, error: "Confirmez que le club détient les droits de publication et de distribution." };
  const job = await updateImportJob(jobId, ["prepared"], (j) => {
    j.status = "running";
    j.note = undefined;
  });
  if (!job) return { ok: false, error: "Cet import n'est plus en attente de confirmation." };

  await patchCreatorFields(job.creatorId, {
    rightsStatus: "verified",
    rightsVerifiedBy: adminId,
    rightsVerifiedAt: new Date().toISOString(),
  });
  await logAuditEvent("creator_rights_verified", { creatorId: job.creatorId, via: "import", jobId }, adminId);
  await logAuditEvent("import_started", { jobId, creatorId: job.creatorId, from: job.fromId, to: job.toId }, adminId);
  await runImportStep(api, jobId);
  return { ok: true, job: (await getImportJob(jobId)) ?? job };
}

async function acquire(jobId: string): Promise<ImportJob | null> {
  const j = await getImportJob(jobId);
  if (!j || j.status !== "running") return null;
  if (j.lockedUntil && j.lockedUntil > Date.now()) return null;
  return await updateImportJob(jobId, ["running"], (x) => {
    x.lockedUntil = Date.now() + LEASE_MS;
  });
}

export async function runImportStep(api: ImportApiLike, jobId: string): Promise<ImportJob | null> {
  const job = await acquire(jobId);
  if (!job) return await getImportJob(jobId);

  // A batch was in flight when the previous run stopped: its outcome is unknown. Never re-copy blindly.
  if (job.inflight) {
    return await updateImportJob(jobId, ["running"], (x) => {
      x.status = "needs_review";
      x.lockedUntil = undefined;
      x.note = `Un lot (${x.inflight!.from}–${x.inflight!.to}) a été interrompu pendant la copie : vérifiez le sujet. « Reprendre » le recopiera (risque de doublons dans ce lot seulement).`;
    });
  }

  const deadline = Date.now() + BUDGET_MS;
  try {
    while (true) {
      const cur = (await getImportJob(jobId))!;
      if (cur.status !== "running") break;
      if (cur.retryAfter && cur.retryAfter > Date.now()) break;
      if (cur.cursor > cur.toId) break;
      if (Date.now() > deadline) break;

      const first = cur.cursor;
      const last = Math.min(cur.cursor + BATCH - 1, cur.toId);
      const ids = Array.from({ length: last - first + 1 }, (_, i) => first + i);

      await updateImportJob(jobId, ["running"], (x) => { x.inflight = { from: first, to: last }; });
      let copies: { message_id: number }[];
      try {
        copies = await api.copyMessages(cur.destChatId, cur.sourceChat, ids, { message_thread_id: cur.destTopicId });
      } catch (err) {
        const info = classifyTelegramError(err);
        if (info.retryAfter !== undefined) {
          await updateImportJob(jobId, ["running"], (x) => {
            x.inflight = undefined; // nothing was copied by a 429
            x.retryAfter = Date.now() + info.retryAfter! * 1000;
          });
          break;
        }
        await updateImportJob(jobId, ["running"], (x) => {
          x.inflight = undefined;
          if (info.protectedContent) {
            x.status = "blocked";
            x.blockedReason = "protected_content";
            x.note = "Telegram a refusé la copie (contenu protégé). Le robot ne contourne pas cette protection.";
          } else {
            x.status = "failed";
            x.note = `Arrêté sur une erreur (la reprise ne recopie rien de ce qui est déjà fait) : ${info.message}`;
          }
        });
        break;
      }

      await saveImportBatchIds(jobId, cur.batchesDone, copies.map((c) => c.message_id));
      await updateImportJob(jobId, ["running"], (x) => {
        x.cursor = last + 1;
        x.inflight = undefined;
        x.retryAfter = undefined;
        x.batchesDone += 1;
        x.requested += ids.length;
        x.copied += copies.length;
        x.skipped += ids.length - copies.length; // deleted / non-copyable ids: gaps are normal
      });
    }

    const after = (await getImportJob(jobId))!;
    if (after.status === "running" && after.cursor > after.toId) await finishImport(api, jobId);
  } finally {
    await updateImportJob(jobId, null, (x) => { x.lockedUntil = undefined; }).catch(() => {});
  }
  return await getImportJob(jobId);
}

async function finishImport(api: ImportApiLike, jobId: string): Promise<void> {
  const done = await updateImportJob(jobId, ["running"], (x) => {
    x.status = "done";
  });
  if (!done) return;
  const creator = await getCreator(done.creatorId);
  if (creator && done.copied > 0) {
    const destIds = await listImportDestIds(jobId);
    const now = new Date().toISOString();
    for (const id of destIds) {
      await recordMediaIndex({
        creatorId: creator.id,
        chatId: done.destChatId,
        topicId: done.destTopicId,
        messageId: id,
        kind: "unknown",
        hasCaption: false,
        source: "import",
        recordedAt: now,
      });
    }
    await recordCreatorMediaUpload(done.destChatId, done.destTopicId); // directory + last update
    // A new creator whose whole library arrived through the bot has a complete, known inventory.
    if (done.isNewCreator) await patchCreatorFields(creator.id, { inventoryStatus: "complete", inventoryAttestedBy: done.adminId });
  }
  await logAuditEvent("import_finished", { jobId, copied: done.copied, skipped: done.skipped }, done.adminId);
  await api.sendMessage(
    done.adminId,
    `✅ *Import terminé — ${done.creatorName}*\n${done.copied} message(s) copiés, ${done.skipped} identifiant(s) sans contenu copiable (supprimés ou hors média).\n` +
      `Vérifiez le sujet. Si le bloc était incorrect, vous pouvez annuler l'import (le robot supprime seulement ses propres copies).`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "↩️ Annuler cet import…", callback_data: `imp:undo:${jobId}` }]] },
    }
  ).catch(() => {});
}

/** Resume a stopped import (failed / needs_review). Finished batches are never re-copied. */
export async function resumeImport(api: ImportApiLike, jobId: string): Promise<ImportJob | null> {
  const j = await updateImportJob(jobId, ["failed", "needs_review"], (x) => {
    x.status = "running";
    x.inflight = undefined;
    x.note = undefined;
    x.retryAfter = undefined;
  });
  if (!j) return null;
  return await runImportStep(api, jobId);
}

export async function cancelImport(jobId: string, adminId: number): Promise<boolean> {
  // A running import stops at its next batch boundary (the worker re-reads the status every batch).
  const j = await updateImportJob(jobId, ["prepared", "blocked", "failed", "needs_review", "running"], (x) => {
    x.status = "cancelled";
    x.inflight = undefined;
  });
  if (j) await logAuditEvent("import_cancelled", { jobId }, adminId);
  return !!j;
}

/** Remove exactly the copies this import made (the bot owns them). Source content is never touched. */
export async function undoImport(api: ImportApiLike, jobId: string, adminId: number): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const j = await getImportJob(jobId);
  if (!j || !["done", "failed", "needs_review", "running"].includes(j.status)) {
    return { ok: false, deleted: 0, error: "Cet import ne peut pas être annulé." };
  }
  await updateImportJob(jobId, null, (x) => { x.status = "needs_review"; x.cursor = x.toId + 1; }); // stop the worker
  const ids = await listImportDestIds(jobId);
  let deleted = 0;
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      await api.deleteMessages(j.destChatId, chunk);
      deleted += chunk.length;
    }
  } catch (err) {
    return { ok: false, deleted, error: classifyTelegramError(err).message };
  }
  await deleteImportBatchIds(jobId);
  await updateImportJob(jobId, null, (x) => { x.status = "undone"; });
  await logAuditEvent("import_undone", { jobId, deleted }, adminId);
  return { ok: true, deleted };
}

/** Cron entry: continue every running import whose rate-limit wait is over. */
export async function continueAllImports(api: ImportApiLike): Promise<number> {
  let n = 0;
  for (const j of await listImportJobs()) {
    if (j.status !== "running") continue;
    if ((j.retryAfter ?? 0) > Date.now() || (j.lockedUntil ?? 0) > Date.now()) continue;
    await runImportStep(api, j.id);
    n++;
  }
  return n;
}

export function importProgress(j: ImportJob): string {
  const total = j.toId - j.fromId + 1;
  const done = Math.min(total, Math.max(0, j.cursor - j.fromId));
  return `${done}/${total} identifiants traités · ${j.copied} copiés · ${j.skipped} ignorés`;
}

