/**
 * LA CONFRÉRIE — Core Domain Types and Data Contracts
 * Phase UG-01: Foundation & Memberships
 * Phase UG-02: Creator Directory & Voting
 */

export type SpaceId =
  | "vip_collections"
  | "retro_collections"
  | "wanted_list"
  | "general_chat";

export const SPACE_IDS: readonly SpaceId[] = [
  "vip_collections",
  "retro_collections",
  "wanted_list",
  "general_chat",
] as const;

/** Spaces included in the Regular plan (the original UG-01 paid bundle). */
export const REGULAR_SPACE_IDS: readonly SpaceId[] = [
  "vip_collections",
  "wanted_list",
  "general_chat",
] as const;

/** Spaces included in Retro Plus: everything in Regular plus the Retro vault. */
export const RETRO_PLUS_SPACE_IDS: readonly SpaceId[] = [
  "vip_collections",
  "retro_collections",
  "wanted_list",
  "general_chat",
] as const;

export interface SpaceDefinition {
  id: SpaceId;
  name: string;
  type: "forum_group" | "channel" | "group";
  description: string;
  envVar:
    | "VIP_COLLECTIONS_CHAT_ID"
    | "TELEGRAM_RETRO_FORUM_CHAT_ID"
    | "WANTED_LIST_CHAT_ID"
    | "GENERAL_CHAT_ID";
}

export const SPACE_DEFINITIONS: Record<SpaceId, SpaceDefinition> = {
  vip_collections: {
    id: "vip_collections",
    name: "TOKEBEC VIP COLLECTIONS",
    type: "forum_group",
    description: "Main creator content library with topic support",
    envVar: "VIP_COLLECTIONS_CHAT_ID",
  },
  retro_collections: {
    id: "retro_collections",
    name: "RETRO | LA CONFRÉRIE",
    type: "forum_group",
    description: "Retro creator vault (Retro Plus only)",
    envVar: "TELEGRAM_RETRO_FORUM_CHAT_ID",
  },
  wanted_list: {
    id: "wanted_list",
    name: "Wanted List",
    type: "channel",
    description: "Creator nominations and voting space",
    envVar: "WANTED_LIST_CHAT_ID",
  },
  general_chat: {
    id: "general_chat",
    name: "LA CONFRÉRIE General Chat",
    type: "group",
    description: "VIP member discussions and community",
    envVar: "GENERAL_CHAT_ID",
  },
};

export type ComplimentaryAccessLevel =
  | "vip_only"
  | "vip_and_chat"
  | "full"
  | "full_retro";

export const COMPLIMENTARY_SPACES: Record<ComplimentaryAccessLevel, SpaceId[]> = {
  vip_only: ["vip_collections"],
  vip_and_chat: ["vip_collections", "general_chat"],
  full: ["vip_collections", "wanted_list", "general_chat"],
  full_retro: ["vip_collections", "retro_collections", "wanted_list", "general_chat"],
};

// ==============================================================================
// UG-04 Membership Plans
// ==============================================================================

export type MembershipPlanId = "regular" | "retro_plus";

/** Invoice payload plan identifiers. "vip_monthly" is the legacy Regular id. */
export const PLAN_PAYLOAD_IDS: Record<MembershipPlanId, string> = {
  regular: "vip_monthly",
  retro_plus: "retro_plus_monthly",
};

export type CollectionCategory = "regular" | "retro";

/**
 * UG-05: spaces covered by a contribution-earned entitlement, per creator forum.
 * Any earned forum access also includes the community spaces (Wanted List, General Chat).
 */
export const CONTRIBUTION_SPACES: Record<CollectionCategory, SpaceId[]> = {
  regular: ["vip_collections", "wanted_list", "general_chat"],
  retro: ["retro_collections", "wanted_list", "general_chat"],
};

export type ComplimentaryReason =
  | "content_contribution"
  | "partnership"
  | "promotion"
  | "admin_exception";

export const COMPLIMENTARY_REASONS: Record<ComplimentaryReason, string> = {
  content_contribution: "Contribution de contenu",
  partnership: "Partenariat",
  promotion: "Promotion",
  admin_exception: "Exception administrative",
};

export type EntitlementSource = "telegram_stars" | "complimentary" | "contribution";

export type EntitlementStatus = "active" | "expired" | "revoked";

export interface EntitlementMetadata {
  grantedBy?: number; // Admin user ID (for complimentary)
  reason?: ComplimentaryReason | string;
  chargeId?: string; // Telegram payment charge ID (for stars)
  invoicePayload?: string;
  reminderSent?: boolean; // 3-day expiration reminder sent
  /** UG-05: contribution submissions whose days are already included (idempotency). */
  rewardIds?: string[];
  lastRewardId?: string;
  notes?: string;
}

export interface Entitlement {
  id: string; // UUID
  userId: number; // Telegram numeric user ID
  source: EntitlementSource;
  spaces: SpaceId[];
  /** UG-04: purchased plan. Absent on legacy records (treated as "regular"). */
  plan?: MembershipPlanId;
  /** UG-05: for source "contribution", which creator forum this earned access covers. */
  contributionScope?: CollectionCategory;
  startsAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  status: EntitlementStatus;
  metadata?: EntitlementMetadata;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface Member {
  userId: number; // Immutable Telegram numeric user ID
  username?: string;
  firstName: string;
  lastName?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: "active" | "inactive" | "blocked";
}

export type PaymentStatus = "completed" | "refunded" | "failed";

export interface Payment {
  id: string; // UUID
  userId: number;
  provider: "telegram_stars"; // Extensible for future providers
  chargeId: string; // telegram_payment_charge_id (idempotency key)
  providerChargeId: string; // provider_payment_charge_id
  amount: number; // e.g. 750
  currency: string; // e.g. "XTR"
  invoicePayload: string;
  /** UG-04: purchased plan. Absent on legacy records (treated as "regular"). */
  planId?: MembershipPlanId;
  subscriptionPeriodSeconds: number; // e.g. 2592000
  subscriptionExpirationDate?: string; // Confirmed Telegram expiration timestamp
  isRecurring: boolean;
  status: PaymentStatus;
  createdAt: string;
}

export interface AccessSyncState {
  userId: number;
  spaceId: SpaceId;
  chatId: number;
  status: "admitted" | "rejected" | "removed" | "error";
  lastSyncAt: string;
  error?: string;
}

export type AuditEventType =
  | "wanted_request_created"
  | "wanted_request_updated"
  | "member_registered"
  | "payment_received"
  | "payment_refunded"
  | "payment_anomaly"
  | "alert_sent"
  | "entitlement_granted"
  | "entitlement_extended"
  | "entitlement_revoked"
  | "entitlement_expired"
  | "join_request_approved"
  | "join_request_declined"
  | "member_removed"
  | "complimentary_reminder_sent"
  | "permission_check_failed"
  | "unauthorized_access_attempt"
  | "reconciliation_run"
  // UG-02 Audit Events:
  | "creator_registered"
  | "creator_renamed"
  | "creator_media_updated"
  | "creator_archived"
  | "directory_synced"
  | "wanted_candidate_suggested"
  | "wanted_candidate_supported"
  | "wanted_status_updated"
  | "wanted_list_synced"
  | "ballot_prepared"
  | "ballot_opened"
  | "ballot_closed"
  | "vote_cast"
  | "runoff_scheduled"
  // UG-03 Treasury Audit Events:
  | "star_tx_recorded"
  | "star_reconciliation_run"
  | "withdrawal_recorded"
  | "withdrawal_settled"
  | "exchange_rate_updated"
  | "expense_created"
  | "expense_committed"
  | "expense_paid"
  | "expense_refunded"
  | "expense_reimbursed"
  | "recurring_expense_created"
  | "allocations_updated"
  | "treasury_report_generated"
  | "candidate_priced"
  | "acquisition_approved"
  // UG-04 Audit Events:
  | "plan_change_requested"
  | "plan_renewal_cancelled"
  | "plan_renewal_cancel_failed"
  | "creator_rights_verified"
  | "creator_collection_changed"
  | "media_indexed"
  | "migration_prepared"
  | "migration_started"
  | "migration_paused"
  | "migration_cancelled"
  | "migration_needs_review"
  | "migration_finalized"
  | "migration_source_deletion_requested"
  | "migration_source_deleted"
  | "contribution_submitted"
  | "contribution_approved"
  | "contribution_rejected"
  | "contribution_reward_granted"
  | "contribution_resolved"
  | "membership_mode_changed"
  | "navigation_synced"
  | "referral_attributed"
  | "referral_bonus_granted"
  | "import_started"
  | "import_finished"
  | "import_cancelled"
  | "import_undone"
  | "points_awarded"
  | "points_prize_granted";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  userId?: number;
  actorId?: number; // admin user ID, or 0 for system
  timestamp: string;
  details: Record<string, unknown>;
}

export interface MembershipSummary {
  userId: number;
  isMember: boolean;
  hasPaid: boolean;
  hasComplimentary: boolean;
  primaryType: "Paid" | "Contribution" | "Complimentary" | "None";
  /** UG-05: active entitlement earned through approved contributions. */
  hasContribution: boolean;
  /**
   * Eligible to nominate/support creators and vote: paid OR contribution-earned
   * (other complimentary access stays excluded; legacy content rewards qualify).
   */
  canParticipate: boolean;
  activeEntitlements: Entitlement[];
  accessibleSpaces: SpaceId[];
  /** UG-04: highest purchased/granted tier. */
  plan: MembershipPlanId | "none";
  hasRetroAccess: boolean;
  effectiveExpiry?: string;
  isRecurring: boolean;
  canRejoin: boolean;
}

export interface InvoicePayloadData {
  type: "subscription";
  userId: number;
  planId: string;
  periodSeconds: number;
  amount?: number; // Stars price the invoice was issued at
  timestamp: number;
}

// ==============================================================================
// UG-02 Domain Contracts: Creator Forum, Directory, Wanted List & Voting
// ==============================================================================

export interface Creator {
  id: string; // Stable internal UUID
  name: string; // Display name, e.g. "Aria"
  normalizedName: string; // Lowercase clean name for uniqueness check
  chatId: number; // Forum group chat ID
  topicId: number; // Telegram message_thread_id
  topicCreatedAt: string; // ISO timestamp
  firstContentDetectedAt?: string; // ISO timestamp
  lastContentUpdatedAt?: string; // ISO timestamp (only updated on authorized media)
  hasContent: boolean; // True ONLY if authorized media has been uploaded
  coverFileId?: string; // Optional administrator-approved cover photo
  status: "active" | "archived";
  wantedListId?: string; // Associated Wanted List candidate ID
  /** UG-04: collection category. Absent on legacy records (treated as "regular"). */
  collection?: CollectionCategory;
  retiredAt?: string; // Optional retirement date (ISO)
  /** UG-04: publication/distribution rights verification. Absent = unverified. */
  rightsStatus?: "unverified" | "verified";
  rightsVerifiedBy?: number;
  rightsVerifiedAt?: string;
  /**
   * UG-04: whether the media message inventory is known to be complete.
   * "complete" only for topics tracked from creation, or after admin attestation.
   * Absent = older collection whose media may not be indexed.
   */
  inventoryStatus?: "complete" | "partial";
  inventoryAttestedBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorySyncState {
  lastSyncAt?: string;
  lastContentHash?: string; // Hash to detect actual changes and avoid redundant edits
  publishedMessageIds: number[]; // Channel message IDs for directory sections
  isDirty: boolean; // Flag set whenever creator name/media changes
  lastNewKey?: string; // creators flagged 🆕 at the last sync
  dirtySeq?: number; // Bumped on every change so an in-flight sync cannot clear a newer one
  lastAttemptAt?: string; // Last time a sync tried to reach Telegram
  lastError?: string; // Why the last attempt failed (cleared by the next success)
  /** Independent posts/checkpoints for the compact Regular and Retro directories. */
  collections?: Partial<Record<CollectionCategory, DirectoryCollectionState>>;
}

export interface DirectoryCollectionState {
  renderVersion?: number;
  channelId?: number;
  publishedMessageIds: number[];
  lastContentHash?: string;
  lastNewKey?: string;
  lastSyncAt?: string;
  syncedSeq?: number;
  lastError?: string;
}

export type WantedCandidateStatus =
  | "requested"
  | "pricing_review"
  | "eligible_for_voting"
  | "voting"
  | "selected"
  | "acquisition_pending"
  | "acquired"
  | "available"
  | "rejected_unavailable";

export const WANTED_STATUS_LABELS: Record<WantedCandidateStatus, string> = {
  requested: "Demandé",
  pricing_review: "Évaluation du prix",
  eligible_for_voting: "Admissible au vote",
  voting: "Vote en cours",
  selected: "Sélectionné",
  acquisition_pending: "Acquisition en attente",
  acquired: "Acquis",
  available: "Disponible dans les collections",
  rejected_unavailable: "Refusé / Indisponible",
};

/** Admin-managed content requests, independent of community voting candidates. */
export type WantedRequestClass = "creatrices" | "amateurs";
export const WANTED_REQUEST_CLASSES: Record<WantedRequestClass, string> = {
  creatrices: "Créatrices",
  amateurs: "Amateurs",
};

export interface WantedRequest {
  id: string;
  name: string;
  normalizedName: string;
  profileUrl: string;
  category: WantedRequestClass;
  status: "active" | "archived";
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface WantedCandidate {
  id: string; // UUID
  name: string; // Clean creator name
  normalizedName: string; // Lowercase for deduplication
  profileUrl?: string; // Optional external link provided by user
  status: WantedCandidateStatus;
  suggestedBy: number; // Telegram user ID of nominator
  supportCount: number; // Unique supporter count
  creatorId?: string; // Linked Creator record once acquired/available
  notes?: string;
  expectedPriceMinor?: number; // In currency minor units (e.g. cents)
  priceCurrency?: string; // e.g. "CAD", "USD"
  expectedCadMinor?: number; // Converted CAD minor units
  recurringCostMinor?: number; // Monthly recurring cost in cents if applicable
  pricingVerifiedAt?: string; // ISO timestamp
  rightsVerified?: boolean; // Whether distribution permission verified
  commitmentExpenseId?: string; // Linked commitment expense ID
  createdAt: string;
  updatedAt: string;
}

export interface MemberSupportRecord {
  id: string; // UUID
  cycleId: string; // Monthly cycle, e.g. "2026-10"
  userId: number; // Telegram user ID
  candidateId: string; // WantedCandidate ID
  type: "nomination" | "support";
  createdAt: string;
}

export type BallotStatus = "draft" | "active" | "closed" | "cancelled";

export interface BallotCandidate {
  candidateId: string; // WantedCandidate ID
  creatorName: string;
  profileUrl?: string;
}

export interface Ballot {
  id: string; // UUID
  monthCycle: string; // e.g. "2026-10"
  title: string;
  candidates: BallotCandidate[];
  status: BallotStatus;
  startsAt: string; // ISO
  closesAt: string; // ISO (startsAt + 5 days)
  turnoutObjective: number; // Default 0.20 (20%)
  totalEligibleMembersAtClose?: number;
  totalVotesCount?: number;
  winnerCandidateId?: string;
  isTie?: boolean;
  tiedCandidateIds?: string[];
  isRunoff?: boolean;
  parentBallotId?: string; // If this ballot is a runoff from a tie
  publishedMessageId?: number; // Telegram message ID in Wanted List channel
  resultsAnnouncedAt?: string; // Set once the closing announcement was delivered
  needsAdminDecision?: boolean; // Runoff tied again, or no votes were cast
  createdAt: string;
  updatedAt: string;
}

export interface VoteRecord {
  id: string; // UUID
  ballotId: string;
  userId: number;
  candidateId: string;
  createdAt: string;
}

export interface VoteResultSummary {
  ballotId: string;
  totalVotes: number;
  eligibleTurnoutPct: number;
  winner?: BallotCandidate;
  isTie: boolean;
  tiedCandidates: BallotCandidate[];
  tally: { candidateId: string; name: string; votes: number }[];
}

export interface SystemSettings {
  directoryUpdateCron: string; // default "0 3 * * *" (3:00 AM)
  votingPeriodDays: number; // default 5
  votingShortlistSize: number; // default 5
  nominationLimitPerCycle: number; // default 1
  digestEnabled: boolean; // default false
  turnoutObjectivePct: number; // default 20
  /** UG-05: how members can obtain access. Default for the community launch: contribution_only. */
  membershipMode: MembershipMode;
  /** UG-05: default reward duration offered when approving with a reward. */
  contributionDefaultDays: number;
  /** UG-05: in stars_only mode, allow contribution rewards only if explicitly enabled. */
  contributionRewardsInStarsMode: boolean;
  /** UG-07: automatically give the monthly top contributor bonus access days. */
  leaderboardPrizesEnabled: boolean;
}

export type MembershipMode = "contribution_only" | "contributions_and_stars" | "stars_only";

// ==============================================================================
// UG-03 Domain Contracts: Treasury, Expenses & Financial Automation
// ==============================================================================

export type CurrencyCode = "CAD" | "USD" | "EUR" | "TON" | "XTR" | string;

export interface Money {
  amountMinor: number; // Integer minor units (e.g. cents for CAD/USD/EUR)
  currency: CurrencyCode;
}

export type StarHoldingStatus =
  | "pending" // Received, within 21-day holding period
  | "withdrawable_estimate" // 21 days elapsed, subject to Telegram rules and balance
  | "withdrawn" // Withdrawn via Telegram/Fragment
  | "refunded"; // Refunded or reversed

export interface StarTransactionRecord {
  id: string; // UUID or unique ID
  telegramTxId: string; // Telegram Star transaction ID
  userId?: number; // Member ID when available
  starsAmount: number; // Positive for revenue, negative for refunds/outlays
  txType: "subscription" | "invoice" | "refund" | "adjustment" | "withdrawal";
  txTimestamp: string; // ISO 8601
  associatedPaymentId?: string; // Link to UG-01 Payment record
  holdingPeriodEndsAt: string; // txTimestamp + 21 days
  status: StarHoldingStatus;
  estimatedRewardUsdCents: number; // Based on configured valuation (e.g. 1.3c/Star)
  estimatedRewardCadCents: number; // Converted to CAD reporting currency
  source: "telegram_api" | "webhook_event" | "manual_adjustment";
  /** UG-04: membership tier this revenue belongs to (absent = regular). */
  planId?: MembershipPlanId;
  createdAt: string;
}

export type WithdrawalStatus = "requested" | "completed" | "cancelled";

export interface WithdrawalSettlement {
  settlementDate: string; // ISO 8601
  amountExchangedTonNano: number; // In nanoTON
  currencyReceived: CurrencyCode; // e.g. "CAD"
  netFundsReceivedMinor: number; // In minor units (cents)
  effectiveRate: number; // e.g. CAD per TON
  feeMinor: number; // Exchange fees
  notes?: string;
}

export interface WithdrawalRecord {
  id: string; // UUID
  withdrawalDate: string; // ISO 8601
  starsQuantity: number;
  fragmentReference?: string;
  tonReceivedNano: number; // 1 TON = 1,000,000,000 nanoTON
  networkFeeNano: number;
  status: WithdrawalStatus;
  settlement?: WithdrawalSettlement; // Present once TON is converted to spendable fiat
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeRateRecord {
  baseCurrency: string; // e.g. "USD"
  targetCurrency: string; // e.g. "CAD"
  rate: number; // target per 1 base
  date: string; // YYYY-MM-DD
  source: "open_er_api" | "frankfurter" | "manual" | "fallback";
  isManual: boolean;
  updatedAt: string;
}

export interface TreasuryValuationConfig {
  starsRewardValuationUsd: number; // Default 0.013 ($0.013 USD per Star)
  effectiveDate: string; // ISO date
  updatedBy?: number; // Admin user ID
  notes?: string;
}

export type ExpenseCategory =
  | "creator_subscription"
  | "creator_content_license"
  | "platform_operations"
  | "marketing"
  | "transaction_fees"
  | "other";

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  creator_subscription: "Abonnement à un créateur",
  creator_content_license: "Contenu / licence de créateur",
  platform_operations: "Exploitation de la plateforme",
  marketing: "Marketing",
  transaction_fees: "Frais de transaction",
  other: "Autre",
};

export type ExpenseStatus =
  | "planned" // Expected upcoming cost, not yet incurred
  | "committed" // Budget reserved for approved acquisition
  | "paid" // Incurred and paid
  | "refunded" // Fully or partially refunded
  | "cancelled"; // Cancelled before payment

export type ExpensePayer =
  | "club_funds" // Paid directly from settled club funds
  | "admin_personal"; // Paid by an administrator personally (liability owed)

export interface ExpenseRecord {
  id: string; // UUID
  description: string;
  originalAmountMinor: number; // Integer minor units (e.g. cents)
  originalCurrency: CurrencyCode;
  cadAmountMinor: number; // Base reporting currency in cents
  usdAmountMinor: number; // USD equivalent in cents
  indicativeStarsAmount: number; // Informational estimate based on valuation
  fxRate?: number; // original currency -> CAD rate applied
  fxRateDate?: string; // publication date of the quote used
  fxRateSource?: string; // open_er_api | manual | fallback | identity
  category: ExpenseCategory;
  creatorId?: string; // Optional link to Creator
  candidateId?: string; // Optional link to WantedCandidate
  expenseDate: string; // ISO 8601
  status: ExpenseStatus;
  payer: ExpensePayer;
  paidByAdminId?: number; // Admin user ID if paid personally
  reimbursementStatus?: "pending" | "reimbursed" | "waived";
  reimbursedAt?: string;
  receiptFileId?: string; // Telegram file_id
  receiptMessageRef?: string;
  notes?: string;
  adjustmentOfId?: string; // If an auditable correction of another expense
  createdAt: string;
  updatedAt: string;
}

export interface RecurringExpenseTemplate {
  id: string; // UUID
  description: string;
  expectedAmountMinor: number;
  currency: CurrencyCode;
  category: ExpenseCategory;
  creatorId?: string;
  candidateId?: string;
  frequency: "monthly" | "yearly";
  dayOfMonth: number;
  status: "active" | "paused" | "archived";
  nextDueDate: string; // ISO date
  lastNotifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TreasuryAllocations {
  acquisitionPct: number; // Default 60%
  operationsPct: number; // Default 25%
  reservePct: number; // Default 15%
  effectiveDate: string;
  updatedBy?: number;
}

export type JournalCategory =
  | "settled_cash" // Bank/wallet cash in CAD
  | "acquisition_fund" // Allocated acquisition budget
  | "operations_fund" // Allocated operations budget
  | "reserve_fund" // Protected contingency reserve
  | "admin_liability"; // Amount owed to admins for personal expenses

export type JournalEntryType =
  | "revenue_settled"
  | "expense_paid"
  | "reimbursement"
  | "allocation"
  | "adjustment";

export interface FinancialJournalEntry {
  id: string; // UUID
  entryType: JournalEntryType;
  category: JournalCategory;
  amountMinor: number; // In CAD cents (positive for increase, negative for decrease)
  referenceId: string; // paymentId, withdrawalId, expenseId, etc.
  timestamp: string; // ISO 8601
  notes: string;
}

export interface TreasuryOverview {
  reportingCurrency: "CAD";
  totalStarsReceived: number;
  pendingStars: number; // Within 21-day holding period
  potentiallyWithdrawableStars: number; // >= 21 days, estimated
  withdrawnStars: number;
  estimatedPendingRewardsCadMinor: number;
  estimatedWithdrawableRewardsCadMinor: number;
  settledNetCashCadMinor: number; // Actual cash received through completed settlements
  allocatedAcquisitionsCadMinor: number; // 60% of settled net receipts
  allocatedOperationsCadMinor: number; // 25% of settled net receipts
  allocatedReserveCadMinor: number; // 15% of settled net receipts
  paidAcquisitionsCadMinor: number;
  paidOperationsCadMinor: number;
  paidOtherCadMinor: number;
  totalPaidExpensesCadMinor: number;
  committedAcquisitionsCadMinor: number; // Approved outstanding acquisition commitments
  availableAcquisitionBudgetCadMinor: number; // (allocatedAcquisitions) - (paidAcquisitions) - (committedAcquisitions)
  adminReimbursementsOwedCadMinor: number; // Unreimbursed personal expenses
  cashOnHandCadMinor: number; // settled cash - club-paid expenses - reimbursements
  telegramWithdrawnStars: number; // Stars Telegram reports as withdrawn (getStarTransactions)
  recordedWithdrawalStars: number; // Stars covered by recorded withdrawal records
  refundedStars: number; // Stars of refunded transactions (excluded from received)
}

export interface TreasuryMonthlyReport {
  id: string; // UUID
  period: string; // YYYY-MM
  overview: TreasuryOverview;
  activePaidSubscribersCount: number;
  /** UG-04: Stars revenue and active subscribers per membership tier (one consolidated treasury). */
  revenueByTier?: TierRevenueBreakdown;
  complimentaryMembersCount: number;
  creatorsAcquiredThisMonth: string[];
  newNominationsCount: number;
  /** Activity that happened inside the report period (America/Toronto month). */
  periodActivity?: {
    starsReceived: number;
    settledCashCadMinor: number;
    paidExpensesCadMinor: number;
  };
  generatedAt: string;
  publishedMessageId?: number;
}



// ==============================================================================
// UG-04 Domain Contracts: Media Inventory & Regular → Retro Migration
// ==============================================================================

/** Minimal record of an authorized media message (metadata only; never the media itself). */
export interface MediaIndexEntry {
  creatorId: string;
  chatId: number;
  topicId: number;
  messageId: number;
  kind: "photo" | "video" | "unknown";
  mediaGroupId?: string;
  hasCaption: boolean;
  source: "live" | "manual" | "migration" | "contribution" | "import";
  recordedAt: string;
}

export type MigrationStatus =
  | "prepared" // Job created, preflight + dry-run report produced, nothing copied
  | "blocked" // Preflight failed; see blockedReason
  | "copying" // Authorized to copy; worker may continue it
  | "paused"
  | "needs_review" // Copy ended with discrepancies
  | "ready_to_finalize" // Everything accounted for; awaiting administrator approval
  | "finalized" // Creator record points to Retro; source topic still exists
  | "source_deleted"
  | "cancelled";

export type MigrationBlockReason =
  | "retro_not_configured"
  | "source_mismatch"
  | "protected_content"
  | "missing_permissions"
  | "no_inventory"
  | "incomplete_inventory"
  | "rights_not_confirmed";

export interface MigrationPreflight {
  ok: boolean;
  checkedAt: string;
  blockers: { reason: MigrationBlockReason; detail: string }[];
  warnings: string[];
}

export type MigrationItemStatus =
  | "pending"
  | "copied"
  | "failed"
  | "ambiguous" // Telegram's response could not be attributed; never auto-retried (duplicate risk)
  | "excluded"; // Administrator-accepted as not transferable (e.g. source message deleted)

export interface MigrationItem {
  sourceMessageId: number;
  kind: "photo" | "video" | "unknown";
  mediaGroupId?: string;
  hasCaption: boolean;
  status: MigrationItemStatus;
  destMessageId?: number;
  error?: string;
  attempts: number;
  updatedAt: string;
}

export interface MigrationJob {
  id: string;
  creatorId: string;
  creatorName: string;
  status: MigrationStatus;
  blockedReason?: MigrationBlockReason;
  dryRun: boolean; // true until copying has been explicitly started
  source: { chatId: number; topicId: number };
  destination: { chatId: number; topicId?: number; topicName: string };
  rightsConfirmedBy: number;
  rightsConfirmedAt: string;
  createdBy: number;
  preflight?: MigrationPreflight;
  totals: {
    items: number;
    albums: number;
    copied: number;
    excluded: number;
    failed: number;
    ambiguous: number;
    pending: number;
  };
  notes: string[]; // Human-readable discrepancy / review notes
  lockedUntil?: number; // Epoch ms lease preventing duplicate concurrent execution
  nextRunAfter?: number; // Epoch ms (rate-limit backoff)
  startedBy?: number;
  startedAt?: string;
  finalizedBy?: number;
  finalizedAt?: string;
  // Source deletion workflow (separate destructive confirmation)
  destinationReviewedBy?: number;
  destinationReviewedAt?: string;
  deletionRequestedBy?: number;
  deletionRequestedAt?: string; // Confirmation window starts here
  sourceDeletedBy?: number;
  sourceDeletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TierRevenueLine {
  periodStars: number; // Completed (non-refunded) payments dated in the report period
  lifetimeStars: number;
  periodPayments: number;
  activeSubscribers: number; // Distinct users whose HIGHEST active paid tier is this one
}

export type TierRevenueBreakdown = Record<MembershipPlanId, TierRevenueLine>;

// ==============================================================================
// UG-04 Member Contributions (admin-reviewed)
// ==============================================================================

export type ContributionStatus =
  | "collecting" // Member is still sending content
  | "pending" // Submitted; awaiting administrator review
  | "publishing" // Administrator approved; copy in progress (claim lock)
  | "approved" // Published into the creator topic by the bot
  | "rejected"
  | "failed" // Nothing was published; can be retried
  | "needs_review" // Partially published; do not retry blindly
  | "cancelled";

export interface ContributionItem {
  messageId: number; // Message ID inside the contributor's private chat with the bot
  kind: "photo" | "video";
  mediaGroupId?: string;
}

/** UG-05: proposal for a creator that does not exist yet. Nothing is created until approval. */
export interface NewCreatorProposal {
  name: string;
  profileUrl?: string;
  collection: CollectionCategory;
  /** Existing creators with a similar name, detected at submission. */
  duplicateCandidateIds: string[];
  /** Administrator chose an existing creator instead of creating a new one. */
  useExistingCreatorId?: string;
  /** Administrator explicitly approved the creator identity and publication rights. */
  identityRightsConfirmed?: boolean;
  /** Set once the topic/creator has been created (retry-safe). */
  createdCreatorId?: string;
}

export type ContributionDecision =
  | { type: "reward"; scopes: CollectionCategory[]; days: number }
  | { type: "no_reward" };

export interface Contribution {
  id: string;
  userId: number; // Contributor (private chat id == user id)
  creatorId: string; // "" while a new-creator proposal is not yet approved
  creatorName: string;
  /** Snapshot of the admin-managed request that led to this submission. */
  wantedRequest?: Pick<WantedRequest, "id" | "name" | "profileUrl" | "category">;
  items: ContributionItem[];
  status: ContributionStatus;
  publishedMessageIds?: number[];
  note?: string;
  reviewedBy?: number;
  reviewedAt?: string;
  createdAt: string;
  submittedAt?: string;
  updatedAt: string;
  // --- UG-05 ---
  kind?: "existing" | "new"; // absent = existing (UG-04 records)
  proposal?: NewCreatorProposal;
  /** Conversation step while a new-creator proposal is being collected. */
  step?: "name" | "url" | "collection" | "media";
  /** The administrator's final choice, recorded when approval starts. */
  decision?: ContributionDecision;
  /** Reward bookkeeping: none = approved without reward, granted = days applied. */
  rewardStatus?: "none" | "pending" | "granted";
  rejectionReason?: string;
  itemCount?: number; // kept after rejection purges the message IDs
  /** Publication progress: items already copied (batch-aligned). Lets a retry/resume never re-copy. */
  publishCursor?: number;
  /** Epoch ms lease so the cron and a button press cannot publish the same submission twice. */
  lockedUntil?: number;
  /** Epoch ms before which Telegram asked us to wait (429). */
  retryAfter?: number;
  /** Administrator's in-progress reward configuration (before confirming). */
  draft?: { scopes: CollectionCategory[]; days: number };
}

/** UG-05: one finalized reward per submission (key = contribution id). */
export interface ContributionReward {
  contributionId: string;
  userId: number;
  scopes: CollectionCategory[];
  days: number;
  grantedBy: number;
  status: "applying" | "granted";
  /** New expiry per scope after this reward. */
  expiresAt: Partial<Record<CollectionCategory, string>>;
  createdAt: string;
  grantedAt?: string;
}

/** UG-05: references to bot-managed public information messages. */
export interface NavigationState {
  welcome?: { chatId: number; messageId: number; hash: string };
  lobby?: { chatId: number; messageId: number; hash: string };
  directoryKeyboardHash?: string;
  leaderboard?: { chatId: number; messageId: number; hash: string };
}

// ==============================================================================
// UG-06 Legacy range import (copy a block of message IDs from an old chat into a topic)
// ==============================================================================

export type ImportJobStatus =
  | "prepared" // Preflight done, preview sent; waiting for the administrator's confirmation
  | "blocked" // Protected content / bot not in the source chat
  | "running"
  | "needs_review" // A batch was interrupted mid-copy: outcome unknown, never re-copied blindly
  | "failed" // Stopped on an error; resumable without re-copying finished batches
  | "done"
  | "cancelled"
  | "undone"; // The bot-made copies were removed again by the administrator

export interface ImportJob {
  id: string;
  adminId: number;
  creatorId: string;
  creatorName: string;
  /** Source chat: numeric id (private chats) or "@username" (public). */
  sourceChat: number | string;
  sourceTitle?: string;
  fromId: number;
  toId: number;
  destChatId: number;
  destTopicId: number;
  status: ImportJobStatus;
  cursor: number; // next source message id to request
  inflight?: { from: number; to: number }; // batch being copied (outcome unknown if we crash)
  batchesDone: number;
  requested: number;
  copied: number;
  skipped: number; // ids that no longer exist / cannot be copied (gaps are normal)
  isNewCreator: boolean;
  note?: string;
  blockedReason?: "protected_content" | "bot_not_in_source" | "source_unreachable";
  lockedUntil?: number;
  retryAfter?: number;
  createdAt: string;
  updatedAt: string;
}
