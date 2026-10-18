/**
 * Underground Manager — UG-01: Foundation & Memberships
 * Core Domain Types and Data Contracts
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
  | "reconciliation_run";

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
