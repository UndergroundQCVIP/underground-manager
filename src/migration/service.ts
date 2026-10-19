/**
 * LA CONFRÉRIE — Regular → Retro Creator Migration Service (UG-04)
 *
 * Moves a creator's collection between private forums using ONLY Telegram's
 * official Bot API (createForumTopic, copyMessages, deleteForumTopic).
 *
 * Safety invariants (each is covered by tests/ug04_migration_test.ts):
 *  - Nothing is copied until an administrator starts the job after a dry-run.
 *  - Protected content is detected and the job stops; no workaround exists here.
 *  - The Bot API cannot list a topic's history: only inventoried (indexed)
 *    messages are copied, and a creator whose inventory is not known to be
 *    complete is BLOCKED rather than silently migrated partially.
 *  - Every source message ends as copied / excluded(by admin) or the job is
 *    needs_review. A migration with unaccounted media can never finalize.
 *  - The source topic is never deleted automatically; deletion needs a
 *    separate, explicit, two-step administrator confirmation.
 *  - The internal creator ID never changes; finalization relocates the
 *    existing record atomically (no duplicate directory entries).
 */

import { getConfig, getSpaceIdForChatId } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import { getCreator, patchCreatorFields, relocateCreator } from "../db/creators.ts";
import { listMediaIndex, recordMediaIndex } from "../db/media_index.ts";
import {
  acquireMigrationLease,
  createMigrationJob,
  getActiveMigrationForCreator,
  getMigrationJob,
  listMigrationItems,
  releaseMigrationLease,
  saveMigrationItem,
  updateMigrationJob,
} from "../db/migrations.ts";
import {
  Creator,
  MigrationBlockReason,
  MigrationItem,
  MigrationJob,
  MigrationPreflight,
} from "../types.ts";

/** Subset of the Telegram Bot API used here (satisfied by grammY's `ctx.api`). */
export interface MigrationApiLike {
  getMe(): Promise<{ id: number }>;
  getChat(chatId: number | string): Promise<{
    id: number;
    is_forum?: boolean;
    has_protected_content?: boolean;
    title?: string;
  }>;
  getChatMember(
    chatId: number | string,
    userId: number
  ): Promise<{
    status: string;
    can_manage_topics?: boolean;
    can_delete_messages?: boolean;
    can_post_messages?: boolean;
  }>;
  createForumTopic(
    chatId: number | string,
    name: string
  ): Promise<{ message_thread_id: number; name?: string }>;
  copyMessages(
    chatId: number | string,
    fromChatId: number | string,
    messageIds: number[],
    other?: { message_thread_id?: number }
  ): Promise<{ message_id: number }[]>;
  deleteForumTopic(chatId: number | string, messageThreadId: number): Promise<boolean>;
  /** Optional: used only as an existence probe for the destination topic. */
  editForumTopic?(
    chatId: number | string,
    messageThreadId: number,
    other?: { name?: string }
  ): Promise<boolean>;
}

const LEASE_MS = 90_000;
const DELETE_CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface ErrInfo {
  message: string;
  retryAfter?: number;
  protectedContent: boolean;
  permission: boolean;
}

export function classifyTelegramError(err: unknown): ErrInfo {
  const e = err as {
    description?: string;
    message?: string;
    parameters?: { retry_after?: number };
    error_code?: number;
  };
  const message = String(e?.description ?? e?.message ?? err);
  const retryAfter =
    e?.parameters?.retry_after ??
    (e?.error_code === 429 ? 5 : undefined) ??
    undefined;
  return {
    message,
    retryAfter,
    protectedContent: /protected|forwards?_restricted|can'?t be (copied|forwarded)|restrict(ed)? saving/i.test(message),
    permission: /not enough rights|chat_write_forbidden|bot was kicked|chat not found|have no rights|CHAT_ADMIN_REQUIRED/i.test(message),
  };
}

export interface CopyUnit {
  messageIds: number[]; // ascending
  isAlbum: boolean;
}

/** Group items into units; album members are never separated. */
export function buildUnits(items: MigrationItem[]): CopyUnit[] {
  const sorted = [...items].sort((a, b) => a.sourceMessageId - b.sourceMessageId);
  const byGroup = new Map<string, MigrationItem[]>();
  for (const it of sorted) {
    if (it.mediaGroupId) {
      const arr = byGroup.get(it.mediaGroupId) ?? [];
      arr.push(it);
      byGroup.set(it.mediaGroupId, arr);
    }
  }
  const units: CopyUnit[] = [];
  const seenGroups = new Set<string>();
  for (const it of sorted) {
    if (it.mediaGroupId) {
      if (seenGroups.has(it.mediaGroupId)) continue;
      seenGroups.add(it.mediaGroupId);
      const members = byGroup.get(it.mediaGroupId)!;
      units.push({ messageIds: members.map((m) => m.sourceMessageId), isAlbum: members.length > 1 });
    } else {
      units.push({ messageIds: [it.sourceMessageId], isAlbum: false });
    }
  }
  // Order units by their first message so overall ordering is preserved.
  return units.sort((a, b) => a.messageIds[0] - b.messageIds[0]);
}

/** Pack whole units into batches of at most `batchSize` message IDs. */
export function buildBatches(units: CopyUnit[], batchSize: number): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  for (const u of units) {
    if (cur.length > 0 && cur.length + u.messageIds.length > batchSize) {
      batches.push(cur);
      cur = [];
    }
    cur = cur.concat(u.messageIds);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function computeTotals(items: MigrationItem[]): MigrationJob["totals"] {
  const t = { items: items.length, albums: 0, copied: 0, excluded: 0, failed: 0, ambiguous: 0, pending: 0 };
  t.albums = buildUnits(items).filter((u) => u.isAlbum).length;
  for (const i of items) t[i.status]++;
  return t;
}

async function refreshTotals(jobId: string): Promise<MigrationItem[]> {
  const items = await listMigrationItems(jobId);
  const totals = computeTotals(items);
  await updateMigrationJob(jobId, (j) => {
    j.totals = totals;
  });
  return items;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// ----------------------------------------------------------------------------
// Preflight + dry-run
// ----------------------------------------------------------------------------

export async function runPreflight(
  api: MigrationApiLike,
  creator: Creator,
  items: MigrationItem[]
): Promise<MigrationPreflight> {
  const config = getConfig();
  const blockers: MigrationPreflight["blockers"] = [];
  const warnings: string[] = [];
  const block = (reason: MigrationBlockReason, detail: string) => blockers.push({ reason, detail });

  const retroChat = config.TELEGRAM_RETRO_FORUM_CHAT_ID;
  if (!retroChat) {
    block("retro_not_configured", "TELEGRAM_RETRO_FORUM_CHAT_ID n'est pas configuré.");
  } else if (getSpaceIdForChatId(retroChat, config) !== "retro_collections") {
    block("retro_not_configured", "Le forum Retro n'est pas enregistré comme espace géré.");
  }

  if ((creator.collection ?? "regular") !== "regular" || creator.chatId !== config.VIP_COLLECTIONS_CHAT_ID) {
    block("source_mismatch", "Le créateur n'est pas actuellement associé à un sujet du forum Regular.");
  }

  if (creator.rightsStatus !== "verified") {
    block("rights_not_confirmed", "Les droits de publication et de distribution n'ont pas été confirmés par un administrateur.");
  }

  if (items.length === 0) {
    block(
      "no_inventory",
      "Aucun message média indexé n'existe pour ce créateur. L'API des robots ne peut pas lister l'historique d'un sujet ; indexez les médias manuellement (voir /index_media) ou republiez-les à partir de fichiers sources autorisés."
    );
  } else if (creator.inventoryStatus !== "complete") {
    block(
      "incomplete_inventory",
      `Seulement ${items.length} message(s) sont indexés et cette ancienne collection peut contenir des médias que Telegram ne permet pas au robot d'énumérer. Indexez le reste avec /index_media, puis attestez que l'inventaire est complet — ou republiez à partir de fichiers sources autorisés.`
    );
  }
  if (items.some((i) => i.kind === "unknown")) {
    warnings.push("Certains messages indexés manuellement ont un type de média inconnu ; les résultats de copie sont tout de même vérifiés message par message.");
  }

  // --- Live Telegram checks (read-only) ---
  try {
    const me = await api.getMe();
    const src = await api.getChat(creator.chatId);
    if (src.has_protected_content) {
      block(
        "protected_content",
        "Le forum Regular a l'option « Restreindre l'enregistrement du contenu » activée : Telegram interdit donc la copie de ses médias. Le robot NE la désactivera PAS et ne la contournera pas. Republiez plutôt à partir de fichiers sources autorisés."
      );
    }
    const srcMember = await api.getChatMember(creator.chatId, me.id);
    if (srcMember.status === "left" || srcMember.status === "kicked") {
      block("missing_permissions", "Le robot n'est pas membre du forum Regular.");
    } else if (srcMember.status === "administrator" && srcMember.can_delete_messages === false) {
      warnings.push("Le robot n'a pas la permission « Supprimer des messages » dans le forum Regular ; l'étape facultative de suppression du sujet source échouerait.");
    }

    if (retroChat) {
      const dst = await api.getChat(retroChat);
      if (dst.is_forum === false) {
        block("missing_permissions", "Le clavardage Retro n'est pas un forum (les sujets ne sont pas activés).");
      }
      if (dst.has_protected_content) {
        warnings.push("Le forum Retro a l'option « Restreindre l'enregistrement du contenu » activée ; la copie VERS ce forum reste permise.");
      }
      const dstMember = await api.getChatMember(retroChat, me.id);
      if (dstMember.status !== "administrator" && dstMember.status !== "creator") {
        block("missing_permissions", "Le robot n'est pas administrateur du forum Retro.");
      } else if (dstMember.can_manage_topics === false) {
        block("missing_permissions", "Le robot n'a pas la permission « Gérer les sujets » dans le forum Retro.");
      }
    }
  } catch (err) {
    block("missing_permissions", `Échec de la vérification Telegram : ${classifyTelegramError(err).message}`);
  }

  return { ok: blockers.length === 0, checkedAt: new Date().toISOString(), blockers, warnings };
}

export interface PrepareParams {
  creatorId: string;
  adminId: number;
  /** Administrator confirmed the club retains publication/distribution rights. */
  rightsConfirmed: boolean;
}

/**
 * Create (or refresh) a migration job and produce a dry-run preflight.
 * Writes NOTHING to Telegram.
 */
export async function prepareMigration(
  api: MigrationApiLike,
  params: PrepareParams
): Promise<{ ok: boolean; job?: MigrationJob; error?: string }> {
  if (!params.rightsConfirmed) {
    return { ok: false, error: "Vous devez confirmer que le club conserve les droits de publication et de distribution." };
  }
  const creator = await getCreator(params.creatorId);
  if (!creator) return { ok: false, error: "Créateur introuvable." };
  if ((creator.collection ?? "regular") !== "regular") {
    return { ok: false, error: `${creator.name} est déjà dans la collection Retro.` };
  }

  const existing = await getActiveMigrationForCreator(creator.id);
  if (existing && !["prepared", "blocked"].includes(existing.status)) {
    return {
      ok: false,
      job: existing,
      error: `Une migration pour ${creator.name} est déjà ${existing.status.replace(/_/g, " ")}. Ouvrez l'état des migrations pour la poursuivre.`,
    };
  }

  const now = new Date().toISOString();
  if (creator.rightsStatus !== "verified") {
    await patchCreatorFields(creator.id, {
      rightsStatus: "verified",
      rightsVerifiedBy: params.adminId,
      rightsVerifiedAt: now,
    });
    await logAuditEvent("creator_rights_verified", { creatorId: creator.id }, params.adminId);
  }
  const fresh = (await getCreator(creator.id))!;

  const config = getConfig();
  let job = existing;
  if (!job) {
    job = {
      id: crypto.randomUUID(),
      creatorId: creator.id,
      creatorName: creator.name,
      status: "prepared",
      dryRun: true,
      source: { chatId: creator.chatId, topicId: creator.topicId },
      destination: { chatId: config.TELEGRAM_RETRO_FORUM_CHAT_ID, topicName: creator.name },
      rightsConfirmedBy: params.adminId,
      rightsConfirmedAt: now,
      createdBy: params.adminId,
      totals: { items: 0, albums: 0, copied: 0, excluded: 0, failed: 0, ambiguous: 0, pending: 0 },
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    await createMigrationJob(job);
    await logAuditEvent(
      "migration_prepared",
      { jobId: job.id, creatorId: creator.id, name: creator.name },
      params.adminId
    );
  }

  // Merge the current inventory into per-message items (never resets progress).
  const existingItems = new Map((await listMigrationItems(job.id)).map((i) => [i.sourceMessageId, i]));
  const inventory = await listMediaIndex(creator.id, { chatId: creator.chatId, topicId: creator.topicId });
  for (const e of inventory) {
    if (existingItems.has(e.messageId)) continue;
    await saveMigrationItem(job.id, {
      sourceMessageId: e.messageId,
      kind: e.kind,
      mediaGroupId: e.mediaGroupId,
      hasCaption: e.hasCaption,
      status: "pending",
      attempts: 0,
      updatedAt: now,
    });
  }
  const items = await refreshTotals(job.id);
  const preflight = await runPreflight(api, fresh, items);

  const updated = await updateMigrationJob(job.id, (j) => {
    j.preflight = preflight;
    j.status = preflight.ok ? "prepared" : "blocked";
    j.blockedReason = preflight.ok ? undefined : preflight.blockers[0].reason;
  });
  return { ok: true, job: updated };
}

export function estimateBatches(items: MigrationItem[], batchSize = getConfig().MIGRATION_BATCH_SIZE): number {
  const pending = items.filter((i) => i.status === "pending");
  return buildBatches(buildUnits(pending), batchSize).length;
}

// ----------------------------------------------------------------------------
// Start / pause / resume / cancel
// ----------------------------------------------------------------------------

export async function startMigration(
  api: MigrationApiLike,
  jobId: string,
  adminId: number
): Promise<{ ok: boolean; job?: MigrationJob; error?: string }> {
  const job = await getMigrationJob(jobId);
  if (!job) return { ok: false, error: "Migration introuvable." };
  if (!["prepared", "paused", "needs_review", "blocked"].includes(job.status)) {
    return { ok: false, job, error: `Impossible de démarrer une migration à l'état ${job.status}.` };
  }

  // Re-prepare to re-run the preflight against current reality.
  const re = await prepareMigration(api, { creatorId: job.creatorId, adminId: job.rightsConfirmedBy, rightsConfirmed: true });
  if (!re.ok || !re.job) {
    // Already copying/paused/etc. is handled below by using the stored job.
    if (!["paused", "needs_review"].includes(job.status)) return { ok: false, job, error: re.error };
  }
  const current = (await getMigrationJob(jobId))!;
  if (["prepared", "blocked"].includes(current.status) && !current.preflight?.ok) {
    return { ok: false, job: current, error: "Les vérifications préalables ont échoué ; voyez les blocages listés." };
  }

  // Create the destination topic once, persist its id BEFORE any copying.
  if (!current.destination.topicId) {
    try {
      const topic = await api.createForumTopic(current.destination.chatId, current.destination.topicName);
      await updateMigrationJob(jobId, (j) => {
        j.destination.topicId = topic.message_thread_id;
      });
    } catch (err) {
      const info = classifyTelegramError(err);
      await updateMigrationJob(jobId, (j) => {
        j.status = "blocked";
        j.blockedReason = "missing_permissions";
        j.notes.push(`Impossible de créer le sujet Retro : ${info.message}`);
      });
      return { ok: false, job: (await getMigrationJob(jobId))!, error: `Impossible de créer le sujet Retro : ${info.message}` };
    }
  }

  // Failed items are retried on resume; ambiguous ones never are.
  for (const it of await listMigrationItems(jobId)) {
    if (it.status === "failed") {
      await saveMigrationItem(jobId, { ...it, status: "pending", error: undefined, updatedAt: new Date().toISOString() });
    }
  }

  const started = await updateMigrationJob(jobId, (j) => {
    j.status = "copying";
    j.blockedReason = undefined;
    j.dryRun = false;
    j.startedBy = j.startedBy ?? adminId;
    j.startedAt = j.startedAt ?? new Date().toISOString();
    j.nextRunAfter = undefined;
  });
  await refreshTotals(jobId);
  await logAuditEvent("migration_started", { jobId, creatorId: job.creatorId }, adminId);
  return { ok: true, job: started };
}

export async function pauseMigration(jobId: string, adminId: number): Promise<MigrationJob | null> {
  const job = await getMigrationJob(jobId);
  if (!job || job.status !== "copying") return job;
  const updated = await updateMigrationJob(jobId, (j) => {
    j.status = "paused";
  });
  await logAuditEvent("migration_paused", { jobId }, adminId);
  return updated;
}

/** Cancel: leaves the source topic and the creator record untouched. */
export async function cancelMigration(jobId: string, adminId: number): Promise<{ ok: boolean; error?: string }> {
  const job = await getMigrationJob(jobId);
  if (!job) return { ok: false, error: "Migration introuvable." };
  if (["finalized", "source_deleted"].includes(job.status)) {
    return { ok: false, error: "Une migration finalisée ne peut pas être annulée." };
  }
  await updateMigrationJob(jobId, (j) => {
    j.status = "cancelled";
    j.notes.push(`Annulée par l'administrateur ${adminId}. Le sujet source et la fiche du créateur n'ont pas été modifiés ; les copies déjà placées dans le sujet Retro doivent être retirées manuellement si elles sont indésirables.`);
  });
  await logAuditEvent("migration_cancelled", { jobId }, adminId);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Copy worker (resumable, rate-limit aware, lease protected)
// ----------------------------------------------------------------------------

export interface RunStepOptions {
  maxBatches?: number;
  timeBudgetMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RunStepResult {
  ran: boolean;
  reason?: "locked" | "not_copying" | "rate_limited" | "blocked";
  batchesRun: number;
  status: MigrationJob["status"];
}

export async function runMigrationStep(
  api: MigrationApiLike,
  jobId: string,
  options: RunStepOptions = {}
): Promise<RunStepResult> {
  const config = getConfig();
  const sleepFn = options.sleepFn ?? sleep;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const deadline = Date.now() + (options.timeBudgetMs ?? 25_000);

  const first = await getMigrationJob(jobId);
  if (!first) return { ran: false, reason: "not_copying", batchesRun: 0, status: "cancelled" };
  if (first.status !== "copying") return { ran: false, reason: "not_copying", batchesRun: 0, status: first.status };

  // Exclusive lease: a duplicate concurrent runner exits without copying.
  if (!(await acquireMigrationLease(jobId, LEASE_MS))) {
    return { ran: false, reason: "locked", batchesRun: 0, status: first.status };
  }

  let batchesRun = 0;
  let consecutiveFailures = 0;
  try {
    while (batchesRun < maxBatches && Date.now() < deadline) {
      const job = (await getMigrationJob(jobId))!;
      if (job.status !== "copying") break; // paused / cancelled mid-run
      if (job.nextRunAfter && job.nextRunAfter > Date.now()) {
        return { ran: batchesRun > 0, reason: "rate_limited", batchesRun, status: job.status };
      }
      if (!job.destination.topicId) break;

      const items = await listMigrationItems(jobId);
      const pending = items.filter((i) => i.status === "pending");
      if (pending.length === 0) break;

      const batch = buildBatches(buildUnits(pending), config.MIGRATION_BATCH_SIZE)[0];
      const now = new Date().toISOString();

      try {
        const copies = await api.copyMessages(job.destination.chatId, job.source.chatId, batch, {
          message_thread_id: job.destination.topicId,
        });
        if (copies.length > 0) consecutiveFailures = 0;

        if (copies.length === 0) {
          // Nothing was created, so retrying cannot duplicate anything.
          for (const id of batch) {
            const it = items.find((x) => x.sourceMessageId === id)!;
            await saveMigrationItem(jobId, {
              ...it,
              status: "failed",
              error: "Telegram n'a copié aucun de ces messages (supprimés ou non copiables)",
              attempts: it.attempts + 1,
              updatedAt: now,
            });
          }
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) break;
        } else if (copies.length === batch.length) {
          // Telegram returns copies in request order: positional mapping is exact.
          for (let i = 0; i < batch.length; i++) {
            const it = items.find((x) => x.sourceMessageId === batch[i])!;
            await saveMigrationItem(jobId, {
              ...it,
              status: "copied",
              destMessageId: copies[i].message_id,
              error: undefined,
              attempts: it.attempts + 1,
              updatedAt: now,
            });
          }
        } else {
          // Some messages were skipped (deleted/uncopyable) and Telegram does not say which.
          // The copies that WERE made cannot be attributed, and retrying would duplicate them.
          for (const id of batch) {
            const it = items.find((x) => x.sourceMessageId === id)!;
            await saveMigrationItem(jobId, {
              ...it,
              status: "ambiguous",
              error: "Nombre de résultats du lot non concordant",
              attempts: it.attempts + 1,
              updatedAt: now,
            });
          }
          await updateMigrationJob(jobId, (j) => {
            j.notes.push(
              `Lot de ${batch.length} message(s) (${batch[0]}–${batch[batch.length - 1]}) : Telegram a retourné ${copies.length} copie(s) (ID de destination ${copies.map((c) => c.message_id).join(", ") || "aucun"}). Certains messages sources ont été ignorés ; les éléments sont marqués AMBIGUS et ne seront pas retentés automatiquement afin d'éviter les doublons. Examinez le sujet Retro.`
            );
          });
        }
      } catch (err) {
        const info = classifyTelegramError(err);

        if (info.protectedContent) {
          await updateMigrationJob(jobId, (j) => {
            j.status = "blocked";
            j.blockedReason = "protected_content";
            j.notes.push(
              "Telegram a refusé la copie : la protection du contenu (« Restreindre l'enregistrement du contenu ») est active. Le robot ne la contourne ni ne la désactive. Utilisez la solution de rechange de republication contrôlée par un administrateur à partir de fichiers sources autorisés."
            );
          });
          await refreshTotals(jobId);
          return { ran: true, reason: "blocked", batchesRun, status: "blocked" };
        }

        if (info.retryAfter !== undefined) {
          await updateMigrationJob(jobId, (j) => {
            j.nextRunAfter = Date.now() + info.retryAfter! * 1000;
          });
          return { ran: batchesRun > 0, reason: "rate_limited", batchesRun, status: "copying" };
        }

        if (info.permission) {
          await updateMigrationJob(jobId, (j) => {
            j.status = "blocked";
            j.blockedReason = "missing_permissions";
            j.notes.push(`Copie arrêtée : ${info.message}`);
          });
          await refreshTotals(jobId);
          return { ran: true, reason: "blocked", batchesRun, status: "blocked" };
        }

        // Other failure: mark this batch failed (retried on resume) and keep going briefly.
        for (const id of batch) {
          const it = items.find((x) => x.sourceMessageId === id)!;
          await saveMigrationItem(jobId, {
            ...it,
            status: "failed",
            error: info.message,
            attempts: it.attempts + 1,
            updatedAt: now,
          });
        }
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) break;
      }

      batchesRun++;
      await refreshTotals(jobId);
      if (config.MIGRATION_BATCH_DELAY_MS > 0) await sleepFn(config.MIGRATION_BATCH_DELAY_MS);
    }

    // Decide the resulting state only when nothing is left pending.
    const items = await refreshTotals(jobId);
    const stillPending = items.some((i) => i.status === "pending");
    const latest = (await getMigrationJob(jobId))!;
    if (!stillPending && latest.status === "copying") {
      const verification = await verifyMigration(api, jobId);
      await updateMigrationJob(jobId, (j) => {
        j.status = verification.ok ? "ready_to_finalize" : "needs_review";
        if (!verification.ok) j.notes.push(...verification.problems.map((p) => `Vérification : ${p}`));
      });
      if (!verification.ok) {
        await logAuditEvent("migration_needs_review", { jobId, problems: verification.problems }, 0);
      }
    } else if (stillPending && consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
      await updateMigrationJob(jobId, (j) => {
        j.status = "needs_review";
        j.notes.push("La copie s'est arrêtée après des échecs répétés de lots. Examinez les éléments échoués, puis reprenez.");
      });
    }
    const final = (await getMigrationJob(jobId))!;
    return { ran: batchesRun > 0, batchesRun, status: final.status };
  } finally {
    await releaseMigrationLease(jobId).catch(() => {});
  }
}

/** Run every job currently in the copying state (cron entry point). */
export async function runAllCopyingMigrations(api: MigrationApiLike): Promise<number> {
  const { listMigrationJobs } = await import("../db/migrations.ts");
  let n = 0;
  for (const job of await listMigrationJobs()) {
    if (job.status === "copying") {
      const r = await runMigrationStep(api, job.id);
      if (r.ran) n++;
    }
  }
  return n;
}

// ----------------------------------------------------------------------------
// Review actions
// ----------------------------------------------------------------------------

/** Admin accepts failed/ambiguous items as non-transferable, with a recorded reason. */
export async function excludeUnresolvedItems(
  jobId: string,
  adminId: number,
  reason: string
): Promise<number> {
  const items = await listMigrationItems(jobId);
  let n = 0;
  for (const it of items) {
    if (it.status === "failed" || it.status === "ambiguous") {
      await saveMigrationItem(jobId, {
        ...it,
        status: "excluded",
        error:
          it.status === "ambiguous"
            ? `Accepté par l'administrateur ${adminId} après examen manuel du sujet Retro (une copie peut exister mais n'est pas attribuable) : ${reason}`
            : `Exclu par l'administrateur ${adminId} : ${reason}`,
        updatedAt: new Date().toISOString(),
      });
      n++;
    }
  }
  await refreshTotals(jobId);
  await updateMigrationJob(jobId, (j) => {
    j.notes.push(`L'administrateur ${adminId} a exclu ${n} élément(s) non résolu(s) : ${reason}`);
  });
  return n;
}

/** Re-evaluate a job after review (e.g., after excluding items). */
export async function reevaluateMigration(
  api: MigrationApiLike,
  jobId: string
): Promise<MigrationJob> {
  const job = (await getMigrationJob(jobId))!;
  if (!["needs_review", "ready_to_finalize"].includes(job.status)) return job;
  const items = await refreshTotals(jobId);
  if (items.some((i) => i.status === "pending")) {
    return updateMigrationJob(jobId, (j) => {
      j.status = "paused";
      j.notes.push("Il reste des éléments en attente ; reprenez la copie.");
    });
  }
  const v = await verifyMigration(api, jobId);
  return updateMigrationJob(jobId, (j) => {
    j.status = v.ok ? "ready_to_finalize" : "needs_review";
  });
}

// ----------------------------------------------------------------------------
// Verification
// ----------------------------------------------------------------------------

export interface VerificationReport {
  ok: boolean;
  expected: number;
  copied: number;
  excluded: number;
  unresolved: number;
  albumsTotal: number;
  albumsPreserved: number;
  destinationTopicOk: boolean | null;
  problems: string[];
  checks: string[];
}

export async function verifyMigration(api: MigrationApiLike, jobId: string): Promise<VerificationReport> {
  const job = (await getMigrationJob(jobId))!;
  const creator = await getCreator(job.creatorId);
  const items = await listMigrationItems(jobId);
  const problems: string[] = [];
  const checks: string[] = [];

  const copied = items.filter((i) => i.status === "copied");
  const excluded = items.filter((i) => i.status === "excluded");
  const unresolved = items.filter((i) => i.status !== "copied" && i.status !== "excluded");

  checks.push(`Inventaire : ${items.length} message(s) indexé(s) ; ${copied.length} copié(s) ; ${excluded.length} exclu(s) par l'administrateur.`);
  if (items.length === 0) problems.push("L'inventaire source est vide.");
  if (unresolved.length > 0) {
    problems.push(`${unresolved.length} élément(s) ne sont pas comptabilisés (en attente/échoués/ambigus).`);
  }
  if (new Set(copied.map((c) => c.destMessageId)).size !== copied.filter((c) => c.destMessageId).length) {
    problems.push("ID de messages de destination en double détectés dans la correspondance.");
  }

  // Albums: all members copied, with destination IDs that stay contiguous.
  const units = buildUnits(items).filter((u) => u.isAlbum);
  let albumsPreserved = 0;
  for (const u of units) {
    const members = u.messageIds.map((id) => items.find((i) => i.sourceMessageId === id)!);
    const dest = members.map((m) => m.destMessageId).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
    const allCopied = members.every((m) => m.status === "copied" && m.destMessageId !== undefined);
    const contiguous = allCopied && dest.every((d, i) => i === 0 || d === dest[i - 1] + 1);
    if (allCopied && contiguous) albumsPreserved++;
    else if (members.some((m) => m.status === "copied")) {
      problems.push(`L'album commençant au message source ${u.messageIds[0]} n'a pas été entièrement ou continuellement préservé.`);
    }
  }
  checks.push(`Albums : ${albumsPreserved}/${units.length} préservés en tant qu'albums.`);
  checks.push("Légendes : copiées via copyMessages sans remove_caption (préservées par Telegram).");

  // Destination identity
  let destinationTopicOk: boolean | null = null;
  const config = getConfig();
  if (!job.destination.topicId) {
    problems.push("Aucun sujet de destination n'a été créé.");
    destinationTopicOk = false;
  } else if (job.destination.chatId === job.source.chatId) {
    problems.push("Le forum de destination est le même que le forum source.");
    destinationTopicOk = false;
  } else if (getSpaceIdForChatId(job.destination.chatId, config) !== "retro_collections") {
    problems.push("Le clavardage de destination n'est pas le forum Retro géré (le contrôle d'accès ne s'appliquerait pas).");
    destinationTopicOk = false;
  } else if (api.editForumTopic) {
    try {
      await api.editForumTopic(job.destination.chatId, job.destination.topicId, { name: job.destination.topicName });
      destinationTopicOk = true;
    } catch (err) {
      const info = classifyTelegramError(err);
      if (/not[ _]modified/i.test(info.message)) destinationTopicOk = true;
      else {
        destinationTopicOk = false;
        problems.push(`Le sujet de destination n'a pas pu être confirmé : ${info.message}`);
      }
    }
  }
  checks.push(
    `Sujet de destination : ${job.destination.topicId ?? "aucun"} dans le forum ${job.destination.chatId} — ${
      destinationTopicOk === null ? "existence non sondée" : destinationTopicOk ? "confirmé" : "NON confirmé"
    }.`
  );

  if (creator?.rightsStatus !== "verified") problems.push("Les droits de publication ne sont pas vérifiés.");
  else checks.push("Droits de publication : vérifiés.");
  checks.push("Accès : l'admission au forum Retro est conditionnée par le droit Retro Plus (approbation des demandes d'adhésion).");

  return {
    ok: problems.length === 0,
    expected: items.length,
    copied: copied.length,
    excluded: excluded.length,
    unresolved: unresolved.length,
    albumsTotal: units.length,
    albumsPreserved,
    destinationTopicOk,
    problems,
    checks,
  };
}

// ----------------------------------------------------------------------------
// Finalization (updates the existing creator record; deletes nothing)
// ----------------------------------------------------------------------------

export async function finalizeMigration(
  api: MigrationApiLike,
  jobId: string,
  adminId: number
): Promise<{ ok: boolean; job?: MigrationJob; error?: string; report?: VerificationReport }> {
  const job = await getMigrationJob(jobId);
  if (!job) return { ok: false, error: "Migration introuvable." };
  if (["finalized", "source_deleted"].includes(job.status)) return { ok: true, job };
  if (job.status !== "ready_to_finalize") {
    return { ok: false, job, error: `La migration est ${job.status.replace(/_/g, " ")} ; elle doit être vérifiée et prête à être finalisée.` };
  }

  // Re-verify at the moment of approval; never trust a stale state.
  const report = await verifyMigration(api, jobId);
  if (!report.ok) {
    await updateMigrationJob(jobId, (j) => {
      j.status = "needs_review";
      j.notes.push(...report.problems.map((p) => `Vérification : ${p}`));
    });
    return { ok: false, job: (await getMigrationJob(jobId))!, report, error: "La vérification a trouvé des écarts ; finalisation refusée." };
  }

  const items = await listMigrationItems(jobId);
  const relocated = await relocateCreator(job.creatorId, {
    chatId: job.destination.chatId,
    topicId: job.destination.topicId!,
    collection: "retro",
  });
  if (!relocated) return { ok: false, job, error: "La fiche du créateur a disparu." };

  // Record the destination inventory so the creator's Retro collection is indexed too.
  for (const it of items) {
    if (it.status === "copied" && it.destMessageId) {
      await recordMediaIndex({
        creatorId: job.creatorId,
        chatId: job.destination.chatId,
        topicId: job.destination.topicId!,
        messageId: it.destMessageId,
        kind: it.kind,
        mediaGroupId: it.mediaGroupId ? `migrated:${it.mediaGroupId}` : undefined,
        hasCaption: it.hasCaption,
        source: "migration",
        recordedAt: new Date().toISOString(),
      });
    }
  }

  const finalized = await updateMigrationJob(jobId, (j) => {
    j.status = "finalized";
    j.finalizedBy = adminId;
    j.finalizedAt = new Date().toISOString();
  });
  await logAuditEvent(
    "creator_collection_changed",
    { creatorId: job.creatorId, from: "regular", to: "retro", jobId },
    adminId
  );
  await logAuditEvent("migration_finalized", { jobId, creatorId: job.creatorId, copied: report.copied, excluded: report.excluded }, adminId);
  return { ok: true, job: finalized, report };
}

// ----------------------------------------------------------------------------
// Source topic deletion: separate, explicit, two-step, never automatic
// ----------------------------------------------------------------------------

export interface SourceDeletionSummary {
  sourceChatId: number;
  sourceTopicId: number;
  creatorName: string;
  copied: number;
  excluded: number;
  destinationChatId: number;
  destinationTopicId?: number;
}

function deletionBlockers(job: MigrationJob, creator: Creator | null, items: MigrationItem[]): string[] {
  const b: string[] = [];
  const config = getConfig();
  if (job.status !== "finalized") b.push("La migration n'est pas finalisée.");
  if (items.some((i) => !["copied", "excluded"].includes(i.status))) {
    b.push("Des écarts de migration non résolus subsistent.");
  }
  if (!creator || creator.chatId !== job.destination.chatId || creator.topicId !== job.destination.topicId) {
    b.push("La fiche du créateur ne pointe pas encore vers la destination Retro.");
  }
  if (job.source.chatId !== config.VIP_COLLECTIONS_CHAT_ID) b.push("La source n'est pas le forum Regular.");
  if (job.source.chatId === job.destination.chatId && job.source.topicId === job.destination.topicId) {
    b.push("La source et la destination sont le même sujet.");
  }
  return b;
}

/** Step 1: administrator states they manually reviewed the destination. Deletes nothing. */
export async function requestSourceDeletion(
  jobId: string,
  adminId: number,
  destinationReviewed: boolean
): Promise<{ ok: boolean; summary?: SourceDeletionSummary; error?: string }> {
  const job = await getMigrationJob(jobId);
  if (!job) return { ok: false, error: "Migration introuvable." };
  if (!destinationReviewed) {
    return { ok: false, error: "Vous devez confirmer que la destination Retro a été examinée manuellement." };
  }
  const creator = await getCreator(job.creatorId);
  const items = await listMigrationItems(jobId);
  const blockers = deletionBlockers(job, creator, items);
  if (blockers.length) return { ok: false, error: blockers.join(" ") };

  await updateMigrationJob(jobId, (j) => {
    j.destinationReviewedBy = adminId;
    j.destinationReviewedAt = new Date().toISOString();
    j.deletionRequestedBy = adminId;
    j.deletionRequestedAt = new Date().toISOString();
  });
  await logAuditEvent("migration_source_deletion_requested", { jobId }, adminId);
  return {
    ok: true,
    summary: {
      sourceChatId: job.source.chatId,
      sourceTopicId: job.source.topicId,
      creatorName: job.creatorName,
      copied: items.filter((i) => i.status === "copied").length,
      excluded: items.filter((i) => i.status === "excluded").length,
      destinationChatId: job.destination.chatId,
      destinationTopicId: job.destination.topicId,
    },
  };
}

/** Step 2: the only code path that ever deletes a source topic. */
export async function confirmSourceDeletion(
  api: MigrationApiLike,
  jobId: string,
  adminId: number
): Promise<{ ok: boolean; error?: string }> {
  const job = await getMigrationJob(jobId);
  if (!job) return { ok: false, error: "Migration introuvable." };
  if (!job.deletionRequestedAt || !job.destinationReviewedAt) {
    return { ok: false, error: "La suppression n'a pas été demandée ni examinée. Commencez d'abord l'examen de suppression." };
  }
  if (Date.now() - new Date(job.deletionRequestedAt).getTime() > DELETE_CONFIRM_WINDOW_MS) {
    return { ok: false, error: "La fenêtre de confirmation de suppression a expiré. Recommencez l'examen." };
  }
  const creator = await getCreator(job.creatorId);
  const items = await listMigrationItems(jobId);
  const blockers = deletionBlockers(job, creator, items);
  if (blockers.length) return { ok: false, error: blockers.join(" ") };

  try {
    await api.deleteForumTopic(job.source.chatId, job.source.topicId);
  } catch (err) {
    return { ok: false, error: `Telegram n'a pas pu supprimer le sujet : ${classifyTelegramError(err).message}` };
  }
  await updateMigrationJob(jobId, (j) => {
    j.status = "source_deleted";
    j.sourceDeletedBy = adminId;
    j.sourceDeletedAt = new Date().toISOString();
  });
  await logAuditEvent(
    "migration_source_deleted",
    { jobId, creatorId: job.creatorId, chatId: job.source.chatId, topicId: job.source.topicId },
    adminId
  );
  return { ok: true };
}
