/**
 * Underground Manager — Core Domain Types and Data Contracts
 * Phase UG-01: Foundation & Memberships
 * Phase UG-02: Creator Directory & Voting
 */

export type SpaceId = "vip_collections" | "wanted_list" | "general_chat";

export const SPACE_IDS: readonly SpaceId[] = [
  "vip_collections",
  "wanted_list",
  "general_chat",
] as const;

export interface SpaceDefinition {
  id: SpaceId;
  name: string;
  type: "forum_group" | "channel" | "group";
  description: string;
  envVar: "VIP_COLLECTIONS_CHAT_ID" | "WANTED_LIST_CHAT_ID" | "GENERAL_CHAT_ID";
}

export const SPACE_DEFINITIONS: Record<SpaceId, SpaceDefinition> = {
  vip_collections: {
    id: "vip_collections",
    name: "TOKEBEC VIP COLLECTIONS",
    type: "forum_group",
    description: "Main creator content library with topic support",
    envVar: "VIP_COLLECTIONS_CHAT_ID",
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
    name: "Underground General Chat",
    type: "group",
    description: "VIP member discussions and community",
    envVar: "GENERAL_CHAT_ID",
  },
};

export type ComplimentaryAccessLevel = "vip_only" | "vip_and_chat" | "full";

export const COMPLIMENTARY_SPACES: Record<ComplimentaryAccessLevel, SpaceId[]> = {
  vip_only: ["vip_collections"],
  vip_and_chat: ["vip_collections", "general_chat"],
  full: ["vip_collections", "wanted_list", "general_chat"],
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

export type EntitlementSource = "telegram_stars" | "complimentary";

export type EntitlementStatus = "active" | "expired" | "revoked";

export interface EntitlementMetadata {
  grantedBy?: number; // Admin user ID (for complimentary)
  reason?: ComplimentaryReason | string;
  chargeId?: string; // Telegram payment charge ID (for stars)
  invoicePayload?: string;
  reminderSent?: boolean; // 3-day expiration reminder sent
  notes?: string;
}

export interface Entitlement {
  id: string; // UUID
  userId: number; // Telegram numeric user ID
  source: EntitlementSource;
  spaces: SpaceId[];
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
  | "acquisition_approved";

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
  primaryType: "Paid" | "Complimentary" | "None";
  activeEntitlements: Entitlement[];
  accessibleSpaces: SpaceId[];
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
}

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

