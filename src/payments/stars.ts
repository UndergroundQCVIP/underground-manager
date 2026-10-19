/**
 * LA CONFRÉRIE — Telegram Stars Recurring Subscription Implementation
 */

import { getConfig } from "../config.ts";
import { recordPayment, updatePaymentStatusByChargeId } from "../db/payments.ts";
import {
  createEntitlement,
  extendEntitlement,
  getActivePaidEntitlements,
  getActiveUserEntitlements,
  revokeEntitlement,
} from "../db/entitlements.ts";
import { getPlan, planFromPayloadId } from "../plans/plans.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  Entitlement,
  InvoicePayloadData,
  MembershipPlanId,
  Payment,
} from "../types.ts";
import { PaymentProcessResult, PaymentProvider } from "./provider.ts";
import { trackSuccessfulPaymentStarsTx } from "../treasury/stars_tracking.ts";

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
  static buildInvoicePayload(userId: number, planId: MembershipPlanId = "regular"): string {
    const config = getConfig();
    const data: InvoicePayloadData = {
      type: "subscription",
      userId,
      planId: getPlan(planId).payloadId, // "vip_monthly" (Regular, legacy id) or "retro_plus_monthly"
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

    // 2. Identify the purchased plan from the tamper-evident payload
    const payload = TelegramStarsProvider.parseInvoicePayload(query.invoice_payload);
    if (!payload) {
      return {
        ok: false,
        errorMessage: "Malformed or unrecognized invoice payload.",
      };
    }

    const planId = planFromPayloadId(payload.planId);
    if (!planId) {
      return { ok: false, errorMessage: "Unrecognized membership plan." };
    }
    const plan = getPlan(planId);

    if (!plan.enabled) {
      return {
        ok: false,
        errorMessage: `${plan.label} billing is not available yet.`,
      };
    }

    // 3. Verify amount against the plan's own configured price
    if (query.total_amount !== plan.priceStars) {
      return {
        ok: false,
        errorMessage: `Invalid price amount. Expected ${plan.priceStars} Stars, got ${query.total_amount}.`,
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

    // 4. Prevent accidental duplicate / overlapping recurring charges
    const activePaid = await getActivePaidEntitlements(query.from.id);
    const samePlan = activePaid.find((e) => (e.plan ?? "regular") === planId);
    if (samePlan) {
      const remainingMs = new Date(samePlan.expiresAt).getTime() - Date.now();
      // If user has more than 25 days remaining, warn to avoid duplicate checkout
      if (remainingMs > 25 * 24 * 3600 * 1000) {
        return {
          ok: false,
          errorMessage: "You already have an active subscription with ample time remaining.",
        };
      }
    }
    if (planId === "regular" && activePaid.some((e) => e.plan === "retro_plus")) {
      return {
        ok: false,
        errorMessage:
          "You currently hold Retro Plus, which already includes Regular access. Use Membership Plans to downgrade without double billing.",
      };
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
    const planId: MembershipPlanId = payment.planId ?? "regular";
    const plan = getPlan(planId);

    // 2. Determine expiration timestamp
    let expiryIso: string;
    if (paymentData.subscriptionExpirationDate) {
      // Use Telegram's confirmed subscription expiration timestamp if provided
      expiryIso = paymentData.subscriptionExpirationDate;
    } else {
      // Fallback: calculate from period seconds
      const nowMs = Date.now();
      const activePaid = (await getActivePaidEntitlements(payment.userId, planId))[0];

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

    // 3. Grant or extend the entitlement for THIS plan only (a Regular
    //    renewal never extends Retro Plus and vice versa).
    const existingPaid = (await getActivePaidEntitlements(payment.userId, planId))[0];

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
          plan: planId,
        },
        0,
        payment.userId
      );
    } else {
      // Create fresh paid entitlement
      entitlement = await createEntitlement({
        userId: payment.userId,
        source: "telegram_stars",
        spaces: [...plan.spaces],
        plan: planId,
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
          plan: planId,
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
        plan: planId,
        expiresAt: entitlement.expiresAt,
      },
      0,
      payment.userId
    );

    // 5. Track Telegram Stars revenue for treasury (21-day holding period)
    try {
      await trackSuccessfulPaymentStarsTx(payment, payment.amount);
    } catch (err) {
      console.error("[Treasury Warning] Failed to track Star transaction:", err);
    }

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

    // Validate currency
    if (payment.currency !== config.CURRENCY) {
      return {
        success: false,
        isDuplicate: false,
        error: `Unexpected currency ${payment.currency}`,
      };
    }

    // Validate payload, payer and the plan it names
    const payload = TelegramStarsProvider.parseInvoicePayload(payment.invoice_payload);
    if (!payload || payload.userId !== userId) {
      return {
        success: false,
        isDuplicate: false,
        error: "Invalid or mismatched invoice payload",
      };
    }
    const planId = planFromPayloadId(payload.planId);
    if (!planId) {
      return { success: false, isDuplicate: false, error: "Unrecognized membership plan" };
    }

    // Validate amount against the plan's own price
    if (payment.total_amount !== getPlan(planId).priceStars) {
      return {
        success: false,
        isDuplicate: false,
        error: `Unexpected payment amount ${payment.total_amount}`,
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
      planId,
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
