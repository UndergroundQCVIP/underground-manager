# UNDERGROUND MANAGER — Phase UG-01: Foundation & Memberships

A simple, secure, and reliable Telegram-native membership management bot built with TypeScript, [grammY](https://grammy.dev/), Deno 2, Deno KV, and Deno Cron for Deno Deploy.

Underground Manager automatically manages recurring Telegram Stars subscriptions, join request approvals for private spaces, automated member removals upon subscription expiration, and administrator-granted complimentary memberships.

---

## 1. Feature Status Matrix

In strict compliance with the UG-01 Implementation Contract:

| Component / Feature | Status | Notes |
|---|---|---|
| **Core Architecture & Extensible Provider Interface** | ✅ **Completed & Tested** | Domain separation: Member, Entitlement, Payment, Sync, Audit. |
| **Deno KV Persistence & Atomic Transactions** | ✅ **Completed & Tested** | In-memory & Deno Deploy KV with race-safe atomic commits. |
| **Telegram Stars Recurring Payments (XTR)** | 🟡 **Implemented & Automated-Tested** | Validated with full mock suite; requires live BotFather Stars token for production billing. |
| **Payment Idempotency & Charge ID deduplication** | ✅ **Completed & Tested** | Duplicate payments cannot double-credit time or revenue. |
| **Pre-Checkout Verification** | ✅ **Completed & Tested** | Strict validation of payer, currency, price, and anti-duplicate check. |
| **Multi-Entitlement Resolution** | ✅ **Completed & Tested** | Overlapping entitlements coexist; expiring one preserves valid others. |
| **Secure Join-Request Space Access Control** | 🟡 **Implemented & Automated-Tested** | Links require bot approval; requires live Telegram chat admin permissions. |
| **Safe Member Removal (Ban & Immediate Unban)** | 🟡 **Implemented & Automated-Tested** | Expired non-admins removed without permanent blacklist; admins protected. |
| **Complimentary Memberships (7d, 30d, 90d, 365d)** | ✅ **Completed & Tested** | Full admin wizard, customizable reasons & space levels, audit logged. |
| **3-Day Expiry Reminder for Complimentary Members** | ✅ **Completed & Tested** | Automatically scheduled; single-delivery reminder with Stars purchase call-to-action. |
| **Hourly Scheduled Reconciliation (Deno Cron)** | ✅ **Completed & Tested** | Hourly job (`0 * * * *`) reconciles access states and sends reminders. |
| **Member Inline Keyboard UI & Navigation** | ✅ **Completed & Tested** | Join, My Membership, Access Channels, Support (/paysupport). |
| **Administrator Private Menu & Lookup** | ✅ **Completed & Tested** | Protected by numeric user ID whitelist; member lookup, extend, revoke, resync. |
| **Update Idempotency & Webhook Secret Token** | ✅ **Completed & Tested** | Prevents webhook spoofing and duplicate message processing. |
| **Creator Directory & Topic Indexing (UG-02)** | ⛔ **Out of Scope (UG-02)** | Intentionally not implemented in UG-01. |
| **Creator Nominations & Voting (UG-02)** | ⛔ **Out of Scope (UG-02)** | Intentionally not implemented in UG-01. |
| **Treasury & Financial Payouts (UG-03)** | ⛔ **Out of Scope (UG-03)** | Intentionally not implemented in UG-01. |

---

## 2. Protected Telegram Architecture

Underground Manager manages access to three private Telegram spaces:

1. **TOKEBEC VIP COLLECTIONS** (`VIP_COLLECTIONS_CHAT_ID`)
   - **Type:** Telegram Supergroup with **Topics (Forum)** enabled.
   - **Purpose:** Primary creator library.
   - **Note:** Existing topics and creator content are completely preserved and untouched.
2. **Wanted List** (`WANTED_LIST_CHAT_ID`)
   - **Type:** Private Telegram Channel.
   - **Purpose:** Creator requests and community nominations.
3. **Underground General Chat** (`GENERAL_CHAT_ID`)
   - **Type:** Private Telegram Group.
   - **Purpose:** Member community and discussions.

### Access Levels
- **Paid Stars Subscription:** Full access to all 3 spaces (`vip_collections`, `general_chat`, `wanted_list`).
- **Complimentary Access Levels:**
  - `vip_only`: Access to TOKEBEC VIP COLLECTIONS only (default).
  - `vip_and_chat`: Access to TOKEBEC VIP COLLECTIONS + Underground General Chat.
  - `full`: Full access to all 3 spaces.

---

## 3. Technology Stack & Repository Structure

- **Runtime:** [Deno 2](https://deno.com/) + [Deno Deploy](https://deno.com/deploy)
- **Framework:** [grammY v1.35+](https://grammy.dev/)
- **Database:** Deno KV (`Deno.openKv()`)
- **Scheduler:** Deno Cron (`Deno.cron()`)
- **Language:** TypeScript 6 (strict mode)

```
underground-manager/
├── deno.json              # Deno configuration, imports, unstable flags & task runners
├── .env.example           # Environment template without secrets
├── .gitignore             # Git exclusions
├── README.md              # Complete technical documentation & operational manual
├── src/
│   ├── config.ts          # Environment variables, chat mapping, price settings, validation
│   ├── types.ts           # Core domain models (Member, Entitlement, Payment, Space, Audit)
│   ├── main.ts            # Entry point: HTTP Webhook / Polling server + Deno.cron
│   ├── db/
│   │   ├── kv.ts          # Deno KV lifecycle and test injection
│   │   ├── members.ts     # Member persistence and username indexing
│   │   ├── entitlements.ts# Multi-entitlement resolution, expiry calculation, status
│   │   ├── payments.ts    # Transaction logs and atomic charge ID idempotency
│   │   ├── sync.ts        # Space admission/removal state tracking
│   │   ├── links.ts       # Cached join-request invite links
│   │   └── audit.ts       # Immutable audit event log
│   ├── payments/
│   │   ├── provider.ts    # Generic PaymentProvider interface
│   │   └── stars.ts       # Telegram Stars recurring subscription implementation
│   ├── access/
│   │   ├── spaces.ts      # Space metadata and configuration lookups
│   │   ├── links.ts       # Join link generation with creates_join_request=true
│   │   ├── join_requests.ts # Join request verification and approval/decline
│   │   └── sync.ts        # Access synchronization, bot permission checks, safe removals
│   ├── complimentary/
│   │   └── service.ts     # Admin complimentary grants, revokes, and 3-day reminders
│   ├── cron/
│   │   └── reconciliation.ts # Hourly reconciliation job
│   └── bot/
│       ├── bot.ts         # GrammY bot assembly and error handling
│       ├── keyboards.ts   # Inline keyboards for members and administrators
│       ├── messages.ts    # Localization-ready text templates
│       ├── middleware/
│       │   ├── auth.ts    # Admin authorization and member tracking
│       │   └── idempotency.ts # Update ID deduplication
│       └── handlers/
│           ├── start.ts   # /start, /help, /paysupport, home navigation
│           ├── membership.ts # Join info, Stars invoice link, My Membership, channel links
│           ├── payments.ts# pre_checkout_query and message:successful_payment
│           ├── join_req.ts# chat_join_request verification
│           └── admin.ts   # Admin menu, member lookup, complimentary wizard, status, resync
└── tests/
    ├── test_helpers.ts    # In-memory Deno KV and MockTelegramApi
    ├── payments_test.ts   # 9 automated tests for Stars billing & idempotency
    ├── access_test.ts     # 9 automated tests for join requests & removal logic
    ├── complimentary_test.ts # 8 automated tests for complimentary workflow & reminders
    └── security_test.ts   # 6 automated tests for webhook security, auth & concurrency
```

---

## 4. Setup & Configuration Guide

### Step 1: Telegram BotFather Configuration
1. Open [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot` and follow the instructions to create `@UndergroundManagerBot`. Save the resulting `BOT_TOKEN`.
3. Configure Bot Privacy:
   - Send `/setprivacy` -> Select your bot -> Choose **Disable** (required so the bot can receive join requests and admin commands in groups).
4. Configure Bot Commands:
   - Send `/setcommands` -> Select your bot -> Paste:
     ```text
     start - Open Underground Manager main menu
     help - How to use the bot and access channels
     paysupport - Subscription billing help and support
     admin - Open Administrator controls (admins only)
     ```
5. Configure Telegram Stars:
   - In BotFather, navigate to **Bot Settings** > **Payments** > select your bot > enable **Telegram Stars**.
   - Note: Stars payments use `currency: "XTR"` and `provider_token: ""`.

### Step 2: Telegram Space Administrator Rights
Add your bot as an **Administrator** in all 3 spaces:
1. **TOKEBEC VIP COLLECTIONS** (Forum Supergroup):
   - Administrator Permissions Required:
     - `can_invite_users` (required to create invite links and approve join requests)
     - `can_restrict_members` (required to remove expired non-admin members)
     - `can_manage_topics` (for UG-02 compatibility)
2. **Wanted List** (Channel):
   - Administrator Permissions Required:
     - `can_invite_users`
     - `can_manage_chat`
3. **Underground General Chat** (Group):
   - Administrator Permissions Required:
     - `can_invite_users`
     - `can_restrict_members`

> [!IMPORTANT]
> **Administrator Responsibilities:**
> - Ensure all manual invitation links created in Telegram chat settings are set to **Request Admin Approval**, or revoke any open unrestricted links.
> - The bot only approves users whose immutable Telegram numeric ID has an active entitlement.
> - The bot protects Telegram administrators and channel creators from ever being removed.

### Step 3: Determining Telegram Chat IDs
To find the numeric chat ID for each space:
1. Forward a message from each channel/group to [@userinfobot](https://t.me/userinfobot) or use Telegram Web (the URL contains the chat ID prefixed with `-100`).
2. Example IDs:
   - `VIP_COLLECTIONS_CHAT_ID=-1001234567890`
   - `WANTED_LIST_CHAT_ID=-1001234567891`
   - `GENERAL_CHAT_ID=-1001234567892`

---

## 5. Environment Variables Reference

Create a `.env` file for local development or set the following in Deno Deploy:

| Variable | Description | Example | Default |
|---|---|---|---|
| `BOT_TOKEN` | Bot API token from @BotFather | `123456:ABC-DEF1234ghIkl` | *Required* |
| `WEBHOOK_SECRET` | Secret token for webhook verification (`X-Telegram-Bot-Api-Secret-Token`) | `f7a29...` | *Required in Prod* |
| `ADMIN_USER_IDS` | Comma-separated numeric Telegram user IDs of administrators | `12345678,87654321` | *Required* |
| `VIP_COLLECTIONS_CHAT_ID` | Numeric Chat ID for VIP Collections forum | `-1001234567890` | *Required* |
| `WANTED_LIST_CHAT_ID` | Numeric Chat ID for Wanted List channel | `-1001234567891` | *Required* |
| `GENERAL_CHAT_ID` | Numeric Chat ID for General Chat | `-1001234567892` | *Required* |
| `STARS_PRICE_AMOUNT` | Price in Telegram Stars for recurring subscription | `750` | `750` |
| `STARS_SUBSCRIPTION_PERIOD_SECONDS` | Recurring subscription duration in seconds | `2592000` (30 days) | `2592000` |
| `CURRENCY` | Currency code for Stars | `XTR` | `XTR` |
| `BOT_MODE` | Runtime mode: `webhook` (Deploy) or `polling` (Local) | `webhook` | `webhook` |
| `PORT` | HTTP listener port | `8000` | `8000` |
| `DENO_ENV` | Environment: `production`, `development`, or `test` | `production` | `development` |
| `SUPPORT_USERNAME` | Support handle displayed in `/paysupport` | `@UndergroundSupport` | `@UndergroundSupport` |

---

## 6. Deno Deploy Deployment

1. **Push Repository to GitHub:**
   ```bash
   git remote add origin https://github.com/your-org/underground-manager.git
   git push -u origin main
   ```
2. **Create Project in Deno Deploy:**
   - Log into [Deno Deploy Console](https://dash.deno.com/).
   - Click **New Project** and link your GitHub repository.
   - Entry point: `src/main.ts`.
3. **Configure Environment Variables:**
   - In project settings, add all environment variables defined above.
4. **Deno KV & Deno Cron Integration:**
   - Deno KV and Deno Cron are enabled automatically by Deno Deploy.
5. **Set Telegram Webhook:**
   - Once your project is deployed at `https://your-project.deno.dev`, set the Telegram webhook via browser or curl:
   ```bash
   curl -F "url=https://your-project.deno.dev/webhook" \
        -F "secret_token=YOUR_WEBHOOK_SECRET" \
        -F "allowed_updates=[\"message\",\"callback_query\",\"chat_join_request\",\"pre_checkout_query\"]" \
        https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
   ```
6. **Verify Deployment:**
   - Visit `https://your-project.deno.dev/health` -> should return `{"status":"ok","app":"underground-manager"}`.

---

## 7. Local Development & Testing

### Running Tests
The project includes a comprehensive, automated test suite covering 32 test cases across Payments, Access Control, Complimentary Memberships, and Security:

```bash
deno task test
```

### Static Type-Checking
Verify clean compilation across all application modules and test files:
```bash
deno task check
```

### Running Locally with Long Polling
For local development without exposing a public webhook URL:
```bash
BOT_MODE=polling deno task dev
```

---

## 8. Administrator Playbook

Administrators (whose Telegram user ID is listed in `ADMIN_USER_IDS`) have access to `/admin`.

### Granting Complimentary Access
1. Member starts the bot (`/start`) so their Telegram ID is registered.
2. Admin opens `/admin` > **Grant Complimentary Access** (or executes `/grant <userId> [days]`).
3. Admin selects:
   - **Duration:** 7 Days, 30 Days (default), 90 Days, or 365 Days.
   - **Reason:** Content contribution, Partnership, Promotion, or Administrator exception.
   - **Space Access Level:**
     - VIP Collections Only (Default)
     - VIP Collections + General Chat
     - Full Access (VIP + Chat + Wanted List)
4. Admin confirms the grant. The bot activates the entitlement immediately and notifies the member with direct channel access buttons.

### Member Lookup
Send `/lookup <userId>` or `/lookup @username`:
- Displays registered name, registration timestamp, active membership type, expiration date, and full entitlement history.
- Provides quick buttons to extend or revoke access.

### Access Synchronization & Emergency Resync
- Access reconciliation runs automatically every hour via Deno Cron.
- Admins can trigger an immediate manual reconciliation anytime via `/admin` > **System Status** > **Trigger Safe Resync**.
- The bot checks each member against active database entitlements. If expired, it kicks them without permanently banning them, allowing seamless re-entry upon future payment.
