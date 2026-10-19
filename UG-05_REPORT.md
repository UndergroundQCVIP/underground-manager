# UG-05 Implementation & Verification Report — Community Contributions & Earned Memberships

**Status:** implemented and tested locally. **Not deployed; no live Telegram setting, price, subscription or payment was changed.**

## Verification
| Check | Result |
|---|---|
| `deno task check` | ✅ pass |
| `deno task test` | ✅ **234 passed / 0 failed** (193 pre-existing, unchanged in assertions except where noted below + 41 new) |

## What was built (all on the existing contribution / entitlement / directory code)
* `contribution` entitlement source; one entitlement per scope (Regular/Retro); `max(now, existing) + days`; idempotent per submission (`applyContributionDays`, reward ledger in `src/contributions/rewards.ts`).
* Admin decisions per submission: **Approve & Reward** (explicit Regular/Retro/Both, 7/15/30/60/90/custom days), **Approve Without Reward**, **Reject** (+ optional reason, message references purged). Reward only after a fully successful publication; partial → needs-review, failed → retryable; retry/resolve apply the stored decision once.
* New-creator proposals (name, optional URL, Regular/Retro, duplicate detection, admin correction / duplicate selection / mandatory identity+rights attestation, retry-safe topic creation).
* Eligibility (`canParticipate`) for Wanted List / nominations / voting / quorum now includes contribution-earned members; complimentary still excluded.
* Membership acquisition mode (Contribution Only default / Contributions + Stars / Stars Only) in Settings; no data or billing is touched by switching.
* Public discovery: welcome menu, public lobby info post, directory navigation buttons (kept on every edit), 8 official deep-link pages, admin Settings → Navigation, safe fallback when unconfigured.
* 3-day expiry reminder for earned access; admin menus: Contributions hub (pending, history, rewards, default duration), Settings (mode, navigation).

## Changes to existing tests (no weakening)
* UG-04 contribution tests updated for the new three-button review keyboard and the new "existing / new creator" chooser (the old `cadm:ok` callback still works as an alias).
* Wanted/voting eligibility error strings still contain the original French wording ("Seuls les abonnés payants actifs…") and add the contributor case.

## Needs your action / decisions
1. **Contribution Only is the default** (as specified). On deploy, new Stars checkout disappears from the bot until an admin switches mode in *Paramètres → Mode d'adhésion* (or you set `MEMBERSHIP_MODE=contributions_and_stars`). Existing subscriptions/renewals keep working.
2. **Create the public lobby by hand** ("LA CONFRÉRIE | ACCUEIL"): the Bot API cannot create groups. Add the bot as admin (post/edit/pin), set `TELEGRAM_PUBLIC_LOBBY_CHAT_ID` + `TELEGRAM_PUBLIC_LOBBY_URL` (and optionally `TELEGRAM_PUBLIC_WELCOME_CHAT_ID`, `PUBLIC_DIRECTORY_URL`) in Deno Deploy, then Paramètres → Navigation publique → Synchroniser.
3. No "existing public welcome message" existed in code, so the welcome menu is a new bot-managed post (only published once a welcome channel ID is configured).
4. Creating a new creator's topic needs the bot to be admin with **Manage topics** in the chosen forum (Retro forum still not reachable by the bot, see UG-04 report).

## Untested live Telegram behavior
Everything was verified against a mock transport. Not exercised against real Telegram: real `createForumTopic` / `copyMessages` from a private chat into topics (albums, captions), editing messages in a public channel/group and keeping inline URL buttons, pinning in the lobby, deep-link rendering on mobile vs desktop, and Stars pre-checkout rejection. Run an isolated test forum + test lobby first.

## Known limits
* The Bot API does not say which message of a partially copied batch was skipped, so partial publication is reported as a count and resolved by an administrator, not item-by-item.
* A contribution is published from the contributor's private chat; if they delete the originals before approval the preview/copy fails (reported, never rewarded).
* Profile URLs are shown to the reviewing admin; the creator record itself has no URL field (not added to avoid a directory schema change).
* Reward ledger/entitlement operations are atomic per scope; a reward for "Both" applies scope by scope and is safely resumable if interrupted between scopes.
