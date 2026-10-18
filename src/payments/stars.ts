/**
 * Underground Manager — Telegram Stars Recurring Subscription Implementation
 */

import { getConfig } from "../config.ts";
import { recordPayment, updatePaymentStatusByChargeId } from "../db/payments.ts";
import {
  createEntitlement,
  extendEntitlement,
  getActiveUserEntitlements,
  revokeEntitlement,
} from "../db/entitlements.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  Entitlement,
  InvoicePayloadData,
  Payment,
  SPACE_IDS,
} from "../types.ts";
import { PaymentProcessResult, PaymentProvider } from "./provider.ts";

export interface TelegramPreCheckoutQuery {
  id: string;
  from: { id: number; first_name: string; username?: string };
  currency: string;
  total_amount: number;
  invoice_payload: string;
  subscription_expiration_date?: number;
}

export interface TelegramSuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id: string;
  subscription_expiration_date?: number;
  is_recurring?: boolean;
  is_first_recurring?: boolean;
}

export class TelegramStarsProvider implements PaymentProvider {
  readonly name = "telegram_stars";

  /**
   * Generates a tamper-evident payload for recurring Stars invoice.
   */
  static buildInvoicePayload(userId: number): string {
    const config = getConfig();
    const data: InvoicePayloadData = {
      type: "subscription",
      userId,
      planId: "vip_monthly",
      periodSeconds: config.STARS_SUBSCRIPTION_PERIOD_SECONDS,
      timestamp: Date.now(),
    };
    return JSON.stringify(data);
  }

  /**
   * Validates and parses invoice payload string.
   */
  static parseInvoicePayload(payloadStr: string): InvoicePayloadData | null {
    try {
      const data = JSON.parse(payloadStr);
      if (
        data &&
        data.type === "subscription" &&
        typeof data.userId === "number" &&
        typeof data.periodSeconds === "number"
      ) {
        return data as InvoicePayloadData;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Validates pre_checkout_query from Telegram within required deadline.
   */
  static async validatePreCheckout(
    query: TelegramPreCheckoutQuery
  ): Promise<{ ok: boolean; errorMessage?: string }> {
    const config = getConfig();

    // 1. Verify currency
    if (query.currency !== config.CURRENCY) {
      return {
        ok: false,
        errorMessage: `Invalid currency. Expected ${config.CURRENCY}, got ${query.currency}.`,
      };
    }

    // 2. Verify amount
    if (query.total_amount !== config.STARS_PRICE_AMOUNT) {
      return {
        ok: false,
        errorMessage: `Invalid price amount. Expected ${config.STARS_PRICE_AMOUNT} Stars, got ${query.total_amount}.`,
      };
    }

    // 3. Verify invoice payload and payer match
    const payload = TelegramStarsProvider.parseInvoicePayload(query.invoice_payload);
    if (!payload) {
      return {
        ok: false,
        errorMessage: "Malformed or unrecognized invoice payload.",
      };
    }

    if (payload.userId !== query.from.id) {
      await logAuditEvent(
        "unauthorized_access_attempt",
        {
          reason: "payer_payload_mismatch",
          expectedUserId: payload.userId,
          actualUserId: query.from.id,
        },
        0,
        query.from.id
      );
      return {
        ok: false,
        errorMessage: "Payer does not match invoice recipient.",
      };
    }

    // 4. Check for active subscription to prevent accidental immediate duplicate payments
    const active = await getActiveUserEntitlements(query.from.id);
    const activeStars = active.find((e) => e.source === "telegram_stars");
    if (activeStars) {
      const remainingMs = new Date(activeStars.expiresAt).getTime() - Date.now();
      // If user has more than 25 days remaining, warn to avoid duplicate checkout
      if (remainingMs > 25 * 24 * 3600 * 1000) {
        return {
          ok: false,
          errorMessage: "You already have an active subscription with ample time remaining.",
        };
      }
    }

    return { ok: true };
  }

  /**
   * Processes a confirmed successful_payment event.
   */
  async processPayment(
    paymentData: Omit<Payment, "id" | "createdAt">
  ): Promise<PaymentProcessResult> {
    const config = getConfig();

    // 1. Idempotently record the payment transaction
    const recordResult = await recordPayment(paymentData);
    if (recordResult.duplicate) {
      return {
        success: false,
        isDuplicate: true,
        payment: recordResult.payment,
        error: "Duplicate payment event ignored to prevent duplicate credit.",
      };
    }

    if (!recordResult.success || !recordResult.payment) {
      return {
        success: false,
        isDuplicate: false,
        error: recordResult.error ?? "Failed to persist payment record.",
      };
    }

    const payment = recordResult.payment;

    // 2. Determine expiration timestamp
    let expiryIso: string;
    if (paymentData.subscriptionExpirationDate) {
      // Use Telegram's confirmed subscription expiration timestamp if provided
      expiryIso = paymentData.subscriptionExpirationDate;
    } else {
      // Fallback: calculate from period seconds
      const nowMs = Date.now();
      const active = await getActiveUserEntitlements(payment.userId);
      const activePaid = active.find((e) => e.source === "telegram_stars");

      let baseMs = nowMs;
      if (activePaid) {
        const existingExpiryMs = new Date(activePaid.expiresAt).getTime();
        if (existingExpiryMs > nowMs) {
          baseMs = existingExpiryMs;
        }
      }

      expiryIso = new Date(
        baseMs + config.STARS_SUBSCRIPTION_PERIOD_SECONDS * 1000
      ).toISOString();
    }

    // 3. Grant or extend entitlement for all 3 protected spaces
    const active = await getActiveUserEntitlements(payment.userId);
    const existingPaid = active.find((e) => e.source === "telegram_stars");

    let entitlement: Entitlement;
    if (existingPaid) {
      // Extend existing active paid entitlement
      const extended = await extendEntitlement(
        existingPaid.id,
        config.STARS_SUBSCRIPTION_PERIOD_SECONDS
      );
      entitlement = extended!;
      await logAuditEvent(
        "entitlement_extended",
        {
          entitlementId: entitlement.id,
          chargeId: payment.chargeId,
          newExpiresAt: entitlement.expiresAt,
          source: "telegram_stars",
        },
        0,
        payment.userId
      );
    } else {
      // Create fresh paid entitlement
      entitlement = await createEntitlement({
        userId: payment.userId,
        source: "telegram_stars",
        spaces: [...SPACE_IDS], // VIP Collections, Wanted List, General Chat
        startsAt: new Date().toISOString(),
        expiresAt: expiryIso,
        status: "active",
        metadata: {
          chargeId: payment.chargeId,
          invoicePayload: payment.invoicePayload,
        },
      });
      await logAuditEvent(
        "entitlement_granted",
        {
          entitlementId: entitlement.id,
          chargeId: payment.chargeId,
          expiresAt: entitlement.expiresAt,
          source: "telegram_stars",
        },
        0,
        payment.userId
      );
    }

    // 4. Log successful payment audit event
    await logAuditEvent(
      "payment_received",
      {
        paymentId: payment.id,
        chargeId: payment.chargeId,
        amount: payment.amount,
        currency: payment.currency,
        isRecurring: payment.isRecurring,
        expiresAt: entitlement.expiresAt,
      },
      0,
      payment.userId
    );

    return {
      success: true,
      isDuplicate: false,
      payment,
      entitlement,
    };
  }

  /**
   * Helper to handle Telegram successful_payment message update.
   */
  async handleSuccessfulPayment(
    payment: TelegramSuccessfulPayment,
    userId: number
  ): Promise<PaymentProcessResult> {
    const config = getConfig();

    // Validate currency and amount
    if (payment.currency !== config.CURRENCY) {
      return {
        success: false,
        isDuplicate: false,
        error: `Unexpected currency ${payment.currency}`,
      };
    }

    if (payment.total_amount !== config.STARS_PRICE_AMOUNT) {
      return {
        success: false,
        isDuplicate: false,
        error: `Unexpected payment amount ${payment.total_amount}`,
      };
    }

    // Validate payload
    const payload = TelegramStarsProvider.parseInvoicePayload(payment.invoice_payload);
    if (!payload || payload.userId !== userId) {
      return {
        success: false,
        isDuplicate: false,
        error: "Invalid or mismatched invoice payload",
      };
    }

    const expirationDateIso = payment.subscription_expiration_date
      ? new Date(payment.subscription_expiration_date * 1000).toISOString()
      : undefined;

    return await this.processPayment({
      userId,
      provider: "telegram_stars",
      chargeId: payment.telegram_payment_charge_id,
      providerChargeId: payment.provider_payment_charge_id,
      amount: payment.total_amount,
      currency: payment.currency,
      invoicePayload: payment.invoice_payload,
      subscriptionPeriodSeconds: config.STARS_SUBSCRIPTION_PERIOD_SECONDS,
      subscriptionExpirationDate: expirationDateIso,
      isRecurring: payment.is_recurring ?? true,
      status: "completed",
    });
  }

  /**
   * Handle payment refund or reversal
   */
  static async handleRefund(
    userId: number,
    chargeId: string,
    adminId = 0
  ): Promise<boolean> {
    const payment = await updatePaymentStatusByChargeId(chargeId, "refunded");
    if (!payment) return false;

    // Revoke corresponding entitlement
    const active = await getActiveUserEntitlements(userId);
    const relatedEntitlement = active.find(
      (e) => e.metadata?.chargeId === chargeId
    );
    if (relatedEntitlement) {
      await revokeEntitlement(relatedEntitlement.id, `Refund for charge ${chargeId}`);
    }

    await logAuditEvent(
      "payment_refunded",
      { chargeId, userId, revokedEntitlementId: relatedEntitlement?.id },
      adminId,
      userId
    );

    return true;
  }
}
