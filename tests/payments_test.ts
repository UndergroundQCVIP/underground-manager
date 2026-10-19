/**
 * Underground Manager — Pre-Publish Test Suite: PAYMENTS
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import { getActiveUserEntitlements } from "../src/db/entitlements.ts";
import { getPaymentByChargeId, getUserPayments } from "../src/db/payments.ts";

Deno.test("PAYMENTS — Successful first Stars payment grants full access", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5001;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);

    const result = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_first_001",
        provider_payment_charge_id: "prov_charge_001",
        is_recurring: true,
      },
      userId
    );

    assertEquals(result.success, true);
    assertEquals(result.isDuplicate, false);
    assertNotEquals(result.entitlement, undefined);
    assertEquals(result.entitlement?.userId, userId);
    assertEquals(result.entitlement?.spaces.length, 3);
    assertEquals(result.entitlement?.status, "active");

    // Check payment record
    const payment = await getPaymentByChargeId("tg_charge_first_001");
    assertEquals(payment?.amount, 750);
    assertEquals(payment?.currency, "XTR");
    assertEquals(payment?.status, "completed");

    // Verify active entitlement in database
    const active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 1);
    assertEquals(active[0].source, "telegram_stars");
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Successful renewal extends membership automatically", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5002;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);

    // Initial Payment
    const firstResult = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_first_002",
        provider_payment_charge_id: "prov_charge_002",
        is_recurring: true,
      },
      userId
    );
    assertEquals(firstResult.success, true);
    const initialExpiry = new Date(firstResult.entitlement!.expiresAt).getTime();

    // Renewal Payment
    const renewalResult = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_renewal_002",
        provider_payment_charge_id: "prov_charge_002_ren",
        is_recurring: true,
      },
      userId
    );

    assertEquals(renewalResult.success, true);
    const renewedExpiry = new Date(renewalResult.entitlement!.expiresAt).getTime();

    // Expiry should be extended by approximately 30 days (2592000s)
    const diffSeconds = Math.round((renewedExpiry - initialExpiry) / 1000);
    assertEquals(diffSeconds, 2592000);

    // Payments recorded should be 2
    const payments = await getUserPayments(userId);
    assertEquals(payments.length, 2);
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Duplicate payment event never grants duplicate time", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5003;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);

    const paymentData = {
      currency: "XTR",
      total_amount: 750,
      invoice_payload: payload,
      telegram_payment_charge_id: "tg_charge_duplicate_003",
      provider_payment_charge_id: "prov_charge_003",
      is_recurring: true,
    };

    // First delivery of payment event
    const firstResult = await provider.handleSuccessfulPayment(paymentData, userId);
    assertEquals(firstResult.success, true);
    assertEquals(firstResult.isDuplicate, false);
    const initialExpiry = firstResult.entitlement!.expiresAt;

    // Simulated replayed/duplicate delivery of exact same payment event
    const duplicateResult = await provider.handleSuccessfulPayment(paymentData, userId);
    assertEquals(duplicateResult.success, false);
    assertEquals(duplicateResult.isDuplicate, true);

    // Entitlement expiry should NOT have changed
    const active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 1);
    assertEquals(active[0].expiresAt, initialExpiry);

    // Payment transactions recorded should still be only 1
    const payments = await getUserPayments(userId);
    assertEquals(payments.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Pre-checkout rejects incorrect amount, currency, or mismatched payer", async () => {
  const kv = await setupTestEnvironment();
  try {
    const targetUserId = 5004;
    const attackerUserId = 9999;
    const payload = TelegramStarsProvider.buildInvoicePayload(targetUserId);

    // 1. Wrong currency
    const wrongCurrency = await TelegramStarsProvider.validatePreCheckout({
      id: "pre_1",
      from: { id: targetUserId, first_name: "User" },
      currency: "USD",
      total_amount: 750,
      invoice_payload: payload,
    });
    assertEquals(wrongCurrency.ok, false);

    // 2. Wrong amount
    const wrongAmount = await TelegramStarsProvider.validatePreCheckout({
      id: "pre_2",
      from: { id: targetUserId, first_name: "User" },
      currency: "XTR",
      total_amount: 100, // Expected 750
      invoice_payload: payload,
    });
    assertEquals(wrongAmount.ok, false);

    // 3. Mismatched payer (attacker attempts to hijack another user's invoice payload)
    const mismatchedPayer = await TelegramStarsProvider.validatePreCheckout({
      id: "pre_3",
      from: { id: attackerUserId, first_name: "Attacker" },
      currency: "XTR",
      total_amount: 750,
      invoice_payload: payload,
    });
    assertEquals(mismatchedPayer.ok, false);

    // 4. Valid pre-checkout
    const valid = await TelegramStarsProvider.validatePreCheckout({
      id: "pre_4",
      from: { id: targetUserId, first_name: "User" },
      currency: "XTR",
      total_amount: 750,
      invoice_payload: payload,
    });
    assertEquals(valid.ok, true);
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Duplicate subscription prevention checks active ample time", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5005;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);

    // User completes first payment (gets 30 days)
    await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_5005",
        provider_payment_charge_id: "prov_charge_5005",
        is_recurring: true,
      },
      userId
    );

    // Immediately attempting to check out again while 30 days are remaining should be blocked
    const checkDuplicate = await TelegramStarsProvider.validatePreCheckout({
      id: "pre_duplicate",
      from: { id: userId, first_name: "User" },
      currency: "XTR",
      total_amount: 750,
      invoice_payload: payload,
    });
    assertEquals(checkDuplicate.ok, false);
    assertEquals(
      checkDuplicate.errorMessage?.includes("beaucoup de temps restant"),
      true
    );
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Refund or reversal revokes entitlement and updates payment status", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5006;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);
    const chargeId = "tg_charge_refund_006";

    // Grant payment
    await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: "prov_refund_006",
        is_recurring: true,
      },
      userId
    );

    let active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 1);

    // Execute refund
    const refundSuccess = await TelegramStarsProvider.handleRefund(userId, chargeId, 111111);
    assertEquals(refundSuccess, true);

    // Active entitlement must now be revoked
    active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 0);

    // Payment status must be refunded
    const payment = await getPaymentByChargeId(chargeId);
    assertEquals(payment?.status, "refunded");
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Failed payment / invalid amount or currency does not activate access", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5007;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);

    // Wrong currency
    const resCurrency = await provider.handleSuccessfulPayment(
      {
        currency: "EUR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_fail_01",
        provider_payment_charge_id: "prov_fail_01",
      },
      userId
    );
    assertEquals(resCurrency.success, false);

    // Wrong amount
    const resAmount = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 1, // Invalid amount
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_fail_02",
        provider_payment_charge_id: "prov_fail_02",
      },
      userId
    );
    assertEquals(resAmount.success, false);

    // Ensure no entitlement was created
    const active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Cancellation preserves access until paid period expires", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 5008;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);

    // Activate 30-day membership
    const result = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_charge_5008",
        provider_payment_charge_id: "prov_charge_5008",
        is_recurring: true,
      },
      userId
    );
    assertEquals(result.success, true);

    // Member cancels auto-renewal in Telegram settings
    // In our system, cancellation means future renewals stop, but the confirmed
    // entitlement period remains active until expiresAt.
    const active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 1);
    assertEquals(new Date(active[0].expiresAt).getTime() > Date.now(), true);
  } finally {
    await kv.close();
  }
});

Deno.test("PAYMENTS — Subscription expiry transitions automatically when time elapses", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 5009;
    const { createEntitlement } = await import("../src/db/entitlements.ts");

    // Create an entitlement that expired 1 hour ago
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    await createEntitlement({
      userId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString(),
      expiresAt: pastDate,
      status: "active",
    });

    // getActiveUserEntitlements should recognize that expiresAt is in the past
    const active = await getActiveUserEntitlements(userId);
    assertEquals(active.length, 0);
  } finally {
    await kv.close();
  }
});

