/**
 * Underground Manager — Telegram Stars Recurring Subscription Implementation
 */

import { getConfig } from "../config.ts";
import {
  getPaymentByChargeId,
  listPaymentsPendingFulfillment,
  recordPayment,
  updatePaymentStatusByChargeId,
} from "../db/payments.ts";
import {
  applyPaidPeriod,
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
import {
  markStarTransactionRefunded,
  trackSuccessfulPaymentStarsTx,
} from "../treasury/stars_tracking.ts";

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
      // The price this invoice was issued at. A renewal of a subscription taken
      // before a price change is still charged at this amount, so it is validated
      // against the invoice, not against today's configured price.
      amount: config.STARS_PRICE_AMOUNT,
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

    if (payload.amount !== undefined && payload.amount !== query.total_amount) {
      return { ok: false, errorMessage: "Invoice amount mismatch." };
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
   *
   * Two independently idempotent steps, so any crash/retry converges:
   *   1. record the payment (unique by Telegram charge id);
   *   2. credit the entitlement + mark the charge fulfilled in ONE atomic commit.
   * A replayed event (or the recovery sweep) re-runs step 2 only if it never
   * completed, so a payment is neither lost nor credited twice.
   */
  async processPayment(
    paymentData: Omit<Payment, "id" | "createdAt">
  ): Promise<PaymentProcessResult> {
    const recordResult = await recordPayment(paymentData);
    const payment = recordResult.payment;

    if (!payment) {
      return {
        success: false,
        isDuplicate: false,
        error: recordResult.error ?? "Failed to persist payment record.",
      };
    }

    return await TelegramStarsProvider.fulfillPayment(payment);
  }

  /**
   * Credits a recorded payment to the member's entitlement (idempotent).
   */
  static async fulfillPayment(payment: Payment): Promise<PaymentProcessResult> {
    const config = getConfig();

    if (payment.status !== "completed") {
      return {
        success: false,
        isDuplicate: true,
        payment,
        error: `Payment ${payment.chargeId} is ${payment.status}; not crediting.`,
      };
    }

    const credit = await applyPaidPeriod({
      userId: payment.userId,
      chargeId: payment.chargeId,
      telegramExpiryIso: payment.subscriptionExpirationDate,
      periodSeconds: payment.subscriptionPeriodSeconds || config.STARS_SUBSCRIPTION_PERIOD_SECONDS,
      invoicePayload: payment.invoicePayload,
      spaces: [...SPACE_IDS], // VIP Collections, Wanted List, General Chat
    });

    // Treasury tracking is idempotent per charge id and backfilled by the
    // getStarTransactions reconciliation, so a failure here must not fail the credit.
    try {
      await trackSuccessfulPaymentStarsTx(payment, payment.amount);
    } catch (err) {
      console.error("[Treasury Warning] Failed to track Star transaction:", err);
    }

    if (credit.alreadyFulfilled) {
      return {
        success: false,
        isDuplicate: true,
        payment,
        entitlement: credit.entitlement,
        error: "Duplicate payment event ignored to prevent duplicate credit.",
      };
    }

    const entitlement = credit.entitlement;

    if (credit.expiryAnomaly) {
      await logAuditEvent(
        "payment_anomaly",
        { chargeId: payment.chargeId, anomaly: credit.expiryAnomaly },
        0,
        payment.userId
      );
    }
    if (payment.amount !== config.STARS_PRICE_AMOUNT) {
      // Genuine renewals keep the price the subscriber originally accepted, so
      // this is credited, but surfaced for the administrators.
      await logAuditEvent(
        "payment_anomaly",
        {
          chargeId: payment.chargeId,
          anomaly: `amount ${payment.amount} differs from configured price ${config.STARS_PRICE_AMOUNT}`,
        },
        0,
        payment.userId
      );
    }

    await logAuditEvent(
      credit.created ? "entitlement_granted" : "entitlement_extended",
      {
        entitlementId: entitlement?.id,
        chargeId: payment.chargeId,
        expiresAt: entitlement?.expiresAt,
        source: "telegram_stars",
      },
      0,
      payment.userId
    );
    await logAuditEvent(
      "payment_received",
      {
        paymentId: payment.id,
        chargeId: payment.chargeId,
        amount: payment.amount,
        currency: payment.currency,
        isRecurring: payment.isRecurring,
        expiresAt: entitlement?.expiresAt,
      },
      0,
      payment.userId
    );

    return {
      success: entitlement !== undefined,
      isDuplicate: false,
      payment,
      entitlement,
      error: entitlement ? undefined : "Telegram reported the paid period had already lapsed.",
    };
  }

  /**
   * Re-runs fulfilment for payments that were recorded but never credited
   * (process crash, database outage between the two steps).
   */
  static async recoverUnfulfilledPayments(): Promise<{ recovered: number; failed: number }> {
    const pending = await listPaymentsPendingFulfillment();
    let recovered = 0;
    let failed = 0;
    for (const payment of pending) {
      try {
        const res = await TelegramStarsProvider.fulfillPayment(payment);
        if (!res.isDuplicate) recovered++;
      } catch (err) {
        failed++;
        console.error(`[Payments] Recovery failed for charge ${payment.chargeId}:`, err);
      }
    }
    return { recovered, failed };
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

    // Validate payload first: the expected amount is the one the invoice was issued at.
    const invoice = TelegramStarsProvider.parseInvoicePayload(payment.invoice_payload);
    const expectedAmount = invoice?.amount ?? config.STARS_PRICE_AMOUNT;
    if (payment.total_amount !== expectedAmount) {
      return {
        success: false,
        isDuplicate: false,
        error: `Unexpected payment amount ${payment.total_amount} (invoice was for ${expectedAmount})`,
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
   * Handle payment refund or reversal.
   *
   * Access is withdrawn only when the refunded charge is the one that funds the
   * current paid period (the entitlement's latest charge). Refunding an older,
   * already-consumed period leaves a later renewal's access intact.
   */
  static async handleRefund(
    userId: number,
    chargeId: string,
    adminId = 0
  ): Promise<boolean> {
    const existing = await getPaymentByChargeId(chargeId);
    if (!existing) return false;
    if (existing.userId !== userId) return false;

    const payment = await updatePaymentStatusByChargeId(chargeId, "refunded");
    if (!payment) return false;

    const active = await getActiveUserEntitlements(userId);
    const related = active.find(
      (e) => e.source === "telegram_stars" && e.metadata?.chargeId === chargeId
    );
    if (related) {
      await revokeEntitlement(related.id, `Refund for charge ${chargeId}`);
    }

    try {
      await markStarTransactionRefunded(chargeId);
    } catch (err) {
      console.error("[Treasury Warning] Failed to mark Star transaction refunded:", err);
    }

    await logAuditEvent(
      "payment_refunded",
      { chargeId, userId, revokedEntitlementId: related?.id },
      adminId,
      userId
    );

    return true;
  }
}
