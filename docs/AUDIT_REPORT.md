# Underground Manager — Independent Audit Report (UG-01 + UG-02 + UG-03)

Branch: `claude/underground-manager-audit-aad8b5` (uncommitted working tree; nothing deployed, merged, migrated, or sent to Telegram).

## A. Executive assessment

The original implementation was well-structured, but its tests exercised services in isolation, so several defects that only appear when the real bot pipeline runs, or under concurrency/failure, were invisible. The most serious: **members could not use nominations, voting or support at all** (a blanket admin gate swallowed every non-admin update), the **webhook was unauthenticated unless `DENO_ENV=production`** (forged `successful_payment` = free membership), **payments could be recorded but never credited**, and **the treasury had unreachable acquisition controls and several double-count paths**.

| Phase | Verdict vs. original requirements |
|---|---|
| UG-01 | Core design sound; payment fulfilment, expiry authority, removal retry, access-race and webhook auth were defective → repaired. |
| UG-02 | Member features were non-functional end-to-end; duplicate channel posts, ballot lifecycle gaps → repaired. |
| UG-03 | Ledger/overview inconsistent, retroactive allocations, double-posting paths, missing acquisition UI → repaired. |

**Final verdict: CONDITIONALLY READY** (see §F). All automated verification passes (133/133, stable over 3 runs); live Telegram behaviour has not been exercised.

## B. Audit findings

| Sev | Component | Problem | Root cause | Correction | Verified |
|---|---|---|---|---|---|
| P0 | Bot routing | Non-admins could never `/suggest`, support, vote, or have forum media seen; every group message got "Access Denied" + audit row | `adminComposer.use(adminOnly)` / `treasuryComposer.use(...)` gate *all* updates, and are registered before the member composers | `adminRouteGuard(commands)` applies the check only to admin commands + `admin:*` buttons; no replies outside private chats | Probe failed on original code; E2E E, G pass |
| P0 | Webhook | No secret ⇒ endpoint open to forged updates (incl. `successful_payment`); secret only required when `DENO_ENV=production` (default is `development`) | Optional check | Fail-closed handler (`src/server.ts`), constant-time compare, secret mandatory in webhook mode in all envs, format validated, 1 MB cap, minimal `/health` | `AUDIT SECURITY` tests |
| P0 | Payments | Payment recorded in step 1, entitlement in step 2; crash/outage between ⇒ duplicate-flagged on retry, member paid but never credited | Non-atomic, non-resumable | `applyPaidPeriod`: credit + "fulfilled" marker in one atomic commit; pending-fulfilment index; hourly recovery sweep | E2E G, `unfulfilled payment` |
| P0 | Idempotency | `update_id` marked processed *before* handling ⇒ any failure permanently drops the update | Claim-then-run, no release | Claim lease → release on error / "done" on success, 7-day TTL, stale-lease takeover | `AUDIT IDEMPOTENCY` |
| P0 | Entitlements | Read path wrote `expired` back; a renewal landing between could be overwritten ⇒ paying member loses access. All mutations were blind read-modify-write | No CAS | Reads are pure; every mutation is versionstamp-CAS with retry; separate sweep; reconcile re-checks eligibility right before ban | `reading never writes…`, E2E B race |
| P1 | Payments | Renewal added "+30 days" instead of using Telegram's `subscription_expiration_date` (computed, then ignored) | Dead variable | Telegram date authoritative (sanity-bounded, anomalies audited, lapsed dates grant nothing) | `authoritative`, `implausible` |
| P1 | Payments | Genuine renewals rejected after a price change (amount compared to *current* price) | Wrong reference | Validate against price embedded in the invoice payload; pre-checkout still requires current price | `price change` test |
| P1 | Payments | Concurrent first charges created stacked entitlements | No uniqueness guard | Per-member pointer in the atomic commit | `concurrent charges` |
| P1 | Refunds | `handleRefund` unreachable; matched wrong charge | No wiring | `refunded_payment` handler; revokes only the period the charge funds; star tx marked refunded | E2E B refund |
| P1 | Access | A failed ban left status `error`, which reconciliation never retried ⇒ expired member stays forever; half-done ban/unban left user banned | Only `admitted` was processed | `error` retried hourly, own leftover ban lifted, admin alerts | E2E G |
| P1 | Cron | `Deno.cron` registered after `await` (won't run on Deploy); schedule was UTC while docs claimed 03:00 Toronto | Platform misuse | Registered synchronously at module top; single hourly tick; Toronto-local daily run with catch-up & per-day marker | `AUDIT TIME`, E2E D |
| P1 | Complimentary | Admin extend/revoke worked on *paid* entitlements; extend revived revoked | No source/status check | Restricted to complimentary, revoked is terminal; reminder skipped for converted members | `COMPLIMENTARY` test |
| P1 | Wanted | Simultaneous nominations of one name created duplicates; counts failed under contention; support allowed on already-selected/acquired | Check-then-create; fail-fast CAS | Atomic find-or-create by normalised name, retrying support commit, status guard, merge by unique supporter | `simultaneous`, `merging` |
| P1 | Wanted channel | Message id kept in process memory ⇒ new post every cold start; "not modified" edit error ⇒ duplicate post | In-memory state, catch-all fallback | Persisted id + content hash; only "message gone" re-posts | `edited in place` |
| P1 | Directory | Same duplicate-post bug; names with `_ * [` broke Markdown (sync never succeeds); dirty flag lost on concurrent upload; re-pins every sync; stale chunks left | Several | Fixed each (escaping everywhere, `dirtySeq`, SHA-256 content hash ignoring the date header, pin on change, delete stale) | `AUDIT DIRECTORY` |
| P1 | Creators | Any member able to create/rename topics could publish names; last-update used server time and could regress; lost updates on rename vs upload | No authority check, blind writes | Admin/bot-only topic events, message date with monotonic max, CAS | E2E D, `AUDIT CREATORS` |
| P1 | Voting | Losing candidates stuck in `voting` forever; zero-vote ballots stuck; tie ⇒ possible double runoff on concurrent close; second ballot overwrote active pointer; runoff tie looped | Non-atomic close | Atomic close+runoff commit, statuses released, `needsAdminDecision`, single open ballot, announcement retry | E2E E, `AUDIT VOTING` |
| P1 | Voting | Audit log stored `candidateId` with `userId` while claiming anonymity | — | Log only that a member voted | E2E E |
| P1 | Treasury | Allocation % applied retroactively to all history; `allocation` journal entries never written (fund journal went negative) | Overview recomputed from current %s | Split journaled atomically at settlement; overview reads the journal; journal == overview invariant tested | E2E F, `prospectively` |
| P1 | Treasury | Settlement in any currency summed as CAD; double-submit / concurrent settle double-credited cash | No validation / CAS | Base-currency enforced, validated *before* recording, CAS single settlement, reference-unique withdrawals, identical-entry guard | `AUDIT TREASURY` |
| P1 | Treasury | Totals read with `limit` 200–2000 ⇒ silently wrong past the cap; pending Stars could be marked withdrawn | Display limits reused for sums | Unbounded reads; only withdrawable, oldest-first | 2100-tx test |
| P1 | Treasury | No UI path to approve/pay acquisitions (admins used "Mark Acquired", bypassing budget & ledger); approve was repeatable, accepted unpriced (0 CAD) candidates, ignored actual price, confirm could double-post, race over budget | Missing wiring / no guards | `admin:acq_*` flow, per-candidate commitment key, budget-version CAS, exactly-once confirm with actual amount & payer, cancel/release; manual status set restricted | `AUDIT ACQUISITIONS`, E2E F |
| P1 | Treasury | Reimbursement repeatable (double cash-out); refunds/corrections not modelled; expense confirm draft in process memory & double-tappable; invalid payer/category/currency accepted; unknown currency converted 1:1 | Missing guards | CAS once-only reimbursement net of refunds, linked refund adjustments with reversing entries, KV drafts claimed atomically, strict validation, unknown rate throws, FX rate/date/source stored | `reimbursement`, `refunds`, `currencies` |
| P1 | Stars ledger | `getStarTransactions` offset checkpoint (list is newest-first ⇒ new payments skipped); refunds (same id as original) and Fragment withdrawals treated as revenue/duplicates | API semantics misread | Page from 0 until known; direction by `source`/`receiver`; refunds applied, withdrawals tracked separately and cross-checked | `getStarTransactions` test |
| P2 | Reports | "Monthly" report was a lifetime snapshot; UTC month | — | In-period flows + balances, Toronto months, period validation | `AUDIT REPORTS` |
| P2 | Misc | Host-timezone dates; hard-coded 60/25/15 labels; env `VOTING_*` ignored; floats for money input; `/price` auto-set rights verified | — | Toronto formatting, labels removed, env honoured, exact decimal parser, rights not implied | various |
| P2 | Ops | No admin alerts | — | Rate-limited DM alerts (reconcile errors, payment recovery, permissions, cron crash), job leases | `OPS` test |

Not changed (documented limitations): see §C.

## C. Corrections

**New:** `src/server.ts`, `src/ops/{alerts,locks}.ts`, `src/util/{time,markdown,money}.ts`, `docs/AUDIT_REPORT.md`.
**Rewritten/major:** `src/db/entitlements.ts`, `src/payments/stars.ts`, `src/bot/middleware/{idempotency,auth}.ts`, `src/access/sync.ts`, `src/cron/reconciliation.ts`, `src/main.ts`, `src/treasury/{service,stars_tracking,conversion}.ts`, `src/voting/service.ts`, `src/directory/sync.ts`.
**Targeted:** config, settings, types, db/{payments,treasury,expenses,wanted,creators,directory,voting}, wanted/creators/complimentary services, handlers (admin, treasury, payments, forum, voting, wanted, start), reports, README/.env.example/CI/deno.json (`deno task prepublish`).
**No database migration is required**: all changes use new/additive KV keys and read existing records. Records created by the old code remain readable (old `processed_updates` numbers are understood; legacy allocation history is *not* back-filled, so don't launch on data produced by the old build).

Remaining limitations (accepted, low risk at this scale): members who join by any route other than the bot's join-request links are not tracked (keep all invite links "request to join" and revoke old ones); a rapid double-tap on non-financial buttons is handled by idempotency but not otherwise de-bounced; creator topics are only discovered when created (existing topics need `/register_creator`); `processed_updates`/audit logs grow without pruning (audit has no TTL by design); the Stars 21-day hold is a constant; `recurringCostMinor` is stored but unused; the monthly treasury report is generated on demand (not scheduled/published automatically).

## D. Test report

`deno task check`: clean. `deno task test`: **133 passed / 0 failed** (3 consecutive runs). Original 78 pass unchanged except the payments test's intent kept (amount mismatch still rejected, now against the invoice). **55 added:**
`tests/e2e_scenarios_test.ts` (16, Scenarios A–G through the real bot with a fake Bot API), `audit_membership_test.ts` (14), `audit_treasury_test.ts` (16), `audit_community_test.ts` (9), harness `bot_harness.ts`. Four representative defects (member gate, group spam, removal retry, renewal expiry) were reproduced as failing probes against the untouched original commit before fixing.

All scenarios A–G **executed and passed against mocks**. What they do *not* prove: real Stars charges/renewals, real Telegram membership changes, forum media browsing, real getStarTransactions payloads, real Deno Deploy cron/KV behaviour. "Time passing" is simulated by rewriting stored expiry.

**Manual verification required (live):**
1. Create a 750-Star subscription with a second Telegram account; confirm `subscription_expiration_date` arrives and equals the stored expiry; confirm renewal (use a short test price if possible) and cancellation (Settings → Stars → Subscriptions) leave access until the paid period ends.
2. Join each of the 3 spaces through the bot link; confirm the request is approved only for members; let a test member lapse and confirm removal from all three within the hour, and re-admission after resubscribing.
3. `refundStarPayment` a test charge: confirm the `refunded_payment` update revokes access.
4. In TOKEBEC VIP COLLECTIONS: create a topic as admin, upload several photos/videos, react/chat; confirm only uploads register; **confirm members can browse topic media natively (client feature, not Bot API)**.
5. Run the daily job on a staging channel; confirm one post, then edits; check the 03:00 Toronto trigger across a DST change.
6. `/record_withdrawal` with a real Fragment reference after a real TON conversion; reconcile against `getStarTransactions`.
7. Confirm Deno Deploy runs the registered `Deno.cron` (dashboard) and that KV is the production database with backups taken (see below).

## E. Production readiness checklist

- **BotFather:** create bot; `/setprivacy` can stay enabled; enable Payments → Telegram Stars (no provider token); set commands (`start, help, paysupport, suggest, vote` + admin: `admin, grant, lookup, register_creator, treasury, record_expense, record_withdrawal, price, refund_expense, cancel_expense`); `/paysupport` content required by Telegram.
- **Bot permissions:** administrator in all three private spaces with *Invite users via link* and *Ban users*; in the public directory channel *Post*, *Edit* and *Pin*, *Delete* messages; in the Wanted channel *Post/Edit*. Nothing else (least privilege). Topic events in the forum require the bot to be a member/admin of the forum group.
- **Chat IDs:** `VIP_COLLECTIONS_CHAT_ID`, `WANTED_LIST_CHAT_ID`, `GENERAL_CHAT_ID`, `PUBLIC_DIRECTORY_CHAT_ID` (all `-100…`, three private ones must differ), optional `TREASURY_REPORT_CHANNEL_ID`.
- **Deno env:** `BOT_TOKEN`, `BOT_USERNAME`, `WEBHOOK_SECRET` (16–256 `A-Za-z0-9_-`, mandatory), `ADMIN_USER_IDS` (numeric), `STARS_PRICE_AMOUNT`, `STARS_SUBSCRIPTION_PERIOD_SECONDS=2592000` (enforced), `CURRENCY=XTR`, `DENO_ENV=production`, `BOT_MODE=webhook`, `BASE_CURRENCY=CAD`, `EXCHANGE_RATE_API_URL`, `DIRECTORY_UPDATE_CRON` (hour only).
- **Webhook:** `setWebhook` with `url=https://<app>/webhook`, `secret_token=<WEBHOOK_SECRET>`; allowed updates must include `message, callback_query, pre_checkout_query, chat_join_request`. Run `deno task verify`.
- **Scheduled jobs:** nothing to configure; one `Deno.cron("0 * * * *")` registered at startup (check dashboard).
- **Database/backups:** production Deno KV is used automatically on Deploy; **take and test periodic exports** (e.g. a scheduled `kv` backup via `deno` script or Deploy's tooling) — KV is the only store for payments, ledger, and entitlements. Not verified here.
- **Payment test:** items 1–3 above. **Private access test:** item 2. **Treasury/report test:** item 6 + `/treasury`, monthly report preview.
- **Launch blockers:** (1) live payment/renewal/cancel/refund test passed; (2) live join/removal test passed; (3) webhook secret configured & `verify` green; (4) backup/restore procedure for KV proven; (5) old invite links revoked and only join-request links in use.

## F. Final verdict

**CONDITIONALLY READY.** No unresolved P0/P1 defects remain in the repository as far as testing and review could show. Launch is conditional on the live verifications and backup procedure above, which cannot be performed from this environment. Residual risks: behaviours of real Telegram payloads (e.g. exact `getStarTransactions` shapes, `refunded_payment` delivery), Deno Deploy cron/KV semantics, and the limitations in §C.
