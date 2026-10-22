/** A Telegram album is delivered as separate updates, without a final-item marker. */
import { getContribution } from "../db/contributions.ts";
import { getKv } from "../db/kv.ts";
import { withJobLease } from "../ops/locks.ts";
import type { Contribution } from "../types.ts";
import type { ContributionApiLike } from "./service.ts";

export const ALBUM_QUIET_MS = 1200;

export async function waitForAlbumReceipt(
  id: string,
  deadline = Date.now() + 8000,
): Promise<Contribution | null> {
  while (true) {
    const c = await getContribution(id);
    if (!c) return null;
    if (
      !["collecting", "pending", "failed"].includes(c.status) ||
      !c.items.some((i) => i.mediaGroupId)
    ) return c;
    const remaining = ALBUM_QUIET_MS - (Date.now() - (c.lastMediaAt ?? 0));
    if (remaining <= 0) return c;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(remaining, 100, Math.max(1, deadline - Date.now())),
      )
    );
  }
}

/** One compact, current receipt for a submission, instead of a permanent "received 1" for each album. */
export async function syncContributionReceipt(
  api: ContributionApiLike,
  id: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (true) {
    const lease = await withJobLease(
      `contribution_receipt:${id}`,
      30000,
      async () => {
        const kv = await getKv();
        const key = ["contribution_receipt", id];
        let messageId = (await kv.get<number>(key)).value;
        for (let attempt = 0; attempt < 5; attempt++) {
          const dirty = await kv.get(["contribution_receipt_dirty", id]);
          if (!dirty.versionstamp) return;
          const entry = await kv.get<Contribution>(["contributions", id]);
          const c = entry.value;
          if (!c || !["collecting", "pending"].includes(c.status)) {
            await kv.atomic().check(dirty).check(entry).delete(dirty.key)
              .commit();
            return;
          }
          const collecting = c.status === "collecting";
          const text = collecting
            ? `✔ ${c.items.length} élément(s) reçu(s). Envoyez-en d’autres ou appuyez sur Terminer.`
            : `✅ Contribution envoyée pour examen : ${c.items.length} élément(s) reçus.`;
          const options = {
            reply_markup: {
              inline_keyboard: collecting
                ? [[{ text: "✅ Terminer", callback_data: "contrib:finish" }, {
                  text: "❌ Annuler",
                  callback_data: "contrib:cancel",
                }]]
                : [[{
                  text: "⬅️ Menu principal",
                  callback_data: "member:home",
                }]],
            },
          };
          if (messageId && api.editMessageText) {
            try {
              await api.editMessageText(c.userId, messageId, text, options);
            } catch (error) {
              if (
                !String(error).includes("message is not modified")
              ) throw error;
            }
          } else {
            const sent = await api.sendMessage(c.userId, text, options) as {
              message_id?: number;
            } | undefined;
            messageId = sent?.message_id ?? null;
            if (messageId) {
              await kv.set(key, messageId, { expireIn: 7 * 86400000 });
            }
          }
          if (
            (await kv.atomic().check(dirty).check(entry).delete(dirty.key)
              .commit()).ok
          ) return;
          // A concurrent append keeps its dirty marker; retry from the latest count.
        }
      },
    );
    if (lease.ran || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Retry receipt edits after transient Telegram failures or a busy isolate. */
export async function flushContributionReceipts(
  api: ContributionApiLike,
): Promise<void> {
  const kv = await getKv();
  for await (
    const entry of kv.list({ prefix: ["contribution_receipt_dirty"] })
  ) {
    try {
      await syncContributionReceipt(api, String(entry.key[1]));
    } catch (error) {
      console.error("[Contributions] Receipt update will retry:", error);
    }
  }
}
