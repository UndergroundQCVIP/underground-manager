# UG-04 Completion & Verification Report — LA CONFRÉRIE

**Status:** implemented and tested locally. **Not deployed, no live Telegram settings changed, no prices activated, no real creator migrated.**

## Verification
| Check | Result |
|---|---|
| `deno task check` (strict type-check) | ✅ pass |
| `deno task test` | ✅ **193 passed / 0 failed** (after merging the audit branch) |
| `deno task verify` (read-only live Telegram check) | ⚠️ see "Open items" |

## Delivered
1. **Rebrand** – `CLUB_DISPLAY_NAME` (default `LA CONFRÉRIE`) drives menus, plans, invoices, directory, Wanted List, voting, treasury, reminders, invite-link names, docs. Internal IDs/keys/cron names/bot username untouched.
2. **Retro forum** – `TELEGRAM_RETRO_FORUM_CHAT_ID=-1003975562920` in `.env` (git-ignored), `.env.example`, README; validated; registered as space `retro_collections`; Regular ID preserved.
3. **Two plans** – Regular (unchanged price/behaviour) and Retro Plus (`RETRO_PLUS_STARS_PRICE_AMOUNT`, **unset ⇒ billing disabled**). Plan recorded on payment + entitlement; renewals extend only their own plan; legacy records = Regular.
4. **Access** – matrix enforced via entitlement `spaces`; join-request links only; hourly reconciliation covers Retro; Retro expiry removes Retro only.
5. **Upgrade/downgrade** – confirmed, transparent cancel-and-resubscribe; renewal cancel via `editUserStarSubscription` only after verified payment and only with user consent.
6. **Unified directory** – `collection` field, labels, A–Z across tiers, All/Regular/Retro filter, retirement date, repair tool, tier-gated deep links, no duplicates.
7. **Admin tools** – View/Register/Edit creator, Move to Retro, Migration Status, Repair Directory, plans overview; commands `/index_media /attest_inventory /retire_creator /move_to_retro /relink_creator`.
8. **Migration service** – dry-run → start → resumable album-safe `copyMessages` batches → verify → approve → finalize (same creator ID) → optional two-step, audited source-topic deletion. Protected-content stop + republishing fallback; ambiguity-safe (no duplicate copies); lease against duplicate runs; 429 backoff; cron worker.
9. **Treasury** – revenue by tier, de-duplicated, refunds/complimentary excluded, one consolidated treasury.
10. **Tests** – `tests/ug04_*` (membership, directory, migration, bot routing).

## Pre-existing bug found and fixed
`adminComposer` and `treasuryComposer` applied the admin-only check to **every** update, so non-admin members' Wanted List / Voting / `/suggest` / `/vote` interactions were rejected with "Access Denied" before reaching their handlers. Replaced with a route-scoped guard (`adminRouteGuard`); covered by `ug04_bot_routing_test.ts`.

## Open items (need your action — nothing was changed live)
1. **Retro forum not reachable by the bot.** `getChat(-1003975562920)` → *chat not found*. Add `@UndergroundXVIP_bot` to RETRO | LA CONFRÉRIE as administrator with *Invite users via link, Ban users, Manage topics, Post messages* (+ *Delete messages* for later cleanup), enable **Topics**, then re-run `deno task verify`. (If it still says not found, re-check the ID — supergroup IDs start with `-100`.)
2. **Regular forum has Restrict Saving Content ON.** Telegram will refuse `copyMessages` from it, so automated migration is **blocked** for the Regular forum as configured. Options: (a) you turn the setting off yourself for the migration window (the bot never will), or (b) use the republishing fallback + `/relink_creator`.
3. **Older collections need an inventory.** Pre-UG-04 creators are flagged *inventory not confirmed complete* (Bot API can't list history). Index via `/index_media` + `/attest_inventory`, or republish.
4. **Retro Plus price** – set `RETRO_PLUS_STARS_PRICE_AMOUNT` (and the same env vars) in Deno Deploy when approved. I had no Deno Deploy access, so deployment config was not touched.
5. **BotFather display name** – optional `/setname` → `LA CONFRÉRIE` (instructions in README §14.6). Don't change the username without updating `BOT_USERNAME`.
6. **Webhook health** – `getWebhookInfo` reports a past delivery error *500* on the currently deployed (pre-UG-04) build; not investigated (no deployment logs access).
7. **No database migration is required** – Deno KV is schemaless and all new fields are optional; legacy records read as Regular.

## Known limitations
* Real Telegram behaviour (actual `copyMessages` with albums/captions, protection errors, 429s) is verified only against a mock; do the isolated test-forum dry run in README §14 before touching a real collection.
* A skipped message inside a `copyMessages` batch makes that whole batch *ambiguous* (Telegram doesn't say which was skipped); reduce `MIGRATION_BATCH_SIZE` to shrink the blast radius.
* Members who joined Retro by means other than the bot can't be enumerated by the Bot API; reconciliation covers members the bot admitted.
