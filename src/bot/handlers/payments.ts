/**
 * LA CONFRÉRIE — Telegram Stars Payment Event Handlers
 */

import { Composer, InlineKeyboard } from "grammy";
import { TelegramStarsProvider } from "../../payments/stars.ts";
import { messages } from "../messages.ts";
import { applyPlanChangeAfterPayment } from "../../plans/changes.ts";

export const paymentsComposer = new Composer();
const starsProvider = new TelegramStarsProvider();

// Handle Pre-Checkout Query (Must answer within 10 seconds)
paymentsComposer.on("pre_checkout_query", async (ctx) => {
  const query = ctx.preCheckoutQuery;

  try {
    const validation = await TelegramStarsProvider.validatePreCheckout({
      id: query.id,
      from: query.from,
      currency: query.currency,
      total_amount: query.total_amount,
      invoice_payload: query.invoice_payload,
    });

    if (validation.ok) {
      await ctx.answerPreCheckoutQuery(true);
    } else {
      await ctx.answerPreCheckoutQuery(false, {
        error_message: validation.errorMessage ?? "Payment validation failed.",
      });
    }
  } catch (err) {
    console.error("Error in pre_checkout_query handler:", err);
    await ctx.answerPreCheckoutQuery(false, {
      error_message: "An internal verification error occurred. Please try again.",
    });
  }
});

// Handle Confirmed Successful Payment
paymentsComposer.on("message:successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  const userId = ctx.from?.id;

  if (!userId || !payment) {
    return;
  }

  try {
    const result = await starsProvider.handleSuccessfulPayment(
      {
        currency: payment.currency,
        total_amount: payment.total_amount,
        invoice_payload: payment.invoice_payload,
        telegram_payment_charge_id: payment.telegram_payment_charge_id,
        provider_payment_charge_id: payment.provider_payment_charge_id,
        subscription_expiration_date: payment.subscription_expiration_date,
        is_recurring: payment.is_recurring,
        is_first_recurring: payment.is_first_recurring,
      },
      userId
    );

    if (result.isDuplicate) {
      // Replayed notification; membership already credited
      await ctx.reply(
        "✅ Payment was already confirmed. Your membership is active!",
        {
          reply_markup: new InlineKeyboard().text("🔓 Access My Channels", "member:channels"),
        }
      );
      return;
    }

    if (!result.success || !result.entitlement) {
      console.error("Payment processing error:", result.error);
      await ctx.reply(
        "⚠️ We encountered an issue finalizing your access. Support has been notified."
      );
      return;
    }

    const planId = result.payment?.planId ?? "regular";

    // Plan upgrade: the new payment is VERIFIED at this point, so it is now safe
    // to stop the old plan's renewal — but only if the user authorized it.
    let upgradeNote = "";
    try {
      const change = await applyPlanChangeAfterPayment(ctx.api, userId, planId);
      if (change?.cancelOutcome === "cancelled") {
        upgradeNote =
          `\n\n🔁 Your Regular subscription will no longer renew; the access you already paid for remains until it ends.`;
      } else if (change?.cancelOutcome === "failed") {
        upgradeNote =
          `\n\n⚠️ We could not cancel your Regular renewal automatically. To avoid a double charge, cancel it in Telegram Settings > Stars.`;
      }
    } catch (err) {
      console.error("Plan change post-processing failed:", err);
    }

    // Success! Congratulate member and show channels button
    await ctx.reply(messages.paymentSuccess(result.entitlement.expiresAt, planId) + upgradeNote, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🔓 Access My Channels", "member:channels")
        .row()
        .text("📋 View Membership", "member:status"),
    });
  } catch (err) {
    console.error("Unhandled error in message:successful_payment handler:", err);
    await ctx.reply(
      "⚠️ Payment confirmation received but encountered an error. Please contact support."
    );
  }
});
