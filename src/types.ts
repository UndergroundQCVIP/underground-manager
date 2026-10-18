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
  content_contribution: "Content contribution",
  partnership: "Partnership",
  promotion: "Promotion",
  admin_exception: "Administrator exception",
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
  | "runoff_scheduled";

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
  requested: "Requested",
  pricing_review: "Pricing Review",
  eligible_for_voting: "Eligible for Voting",
  voting: "Voting in Progress",
  selected: "Selected",
  acquisition_pending: "Acquisition Pending",
  acquired: "Acquired",
  available: "Available in Collections",
  rejected_unavailable: "Rejected / Unavailable",
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
