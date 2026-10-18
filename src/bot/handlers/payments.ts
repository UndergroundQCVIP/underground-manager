/**
 * Underground Manager — Telegram Stars Payment Event Handlers
 */

import { Composer, InlineKeyboard } from "grammy";
import { TelegramStarsProvider } from "../../payments/stars.ts";
import { messages } from "../messages.ts";

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

    // Success! Congratulate member and show channels button
    await ctx.reply(messages.paymentSuccess(result.entitlement.expiresAt), {
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
