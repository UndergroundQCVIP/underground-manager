/**
 * LA CONFRÉRIE — Telegram Stars Payment Event Handlers
 */

import { Composer } from "grammy";
import { TelegramStarsProvider } from "../../payments/stars.ts";
import { messages } from "../messages.ts";
import { applyPlanChangeAfterPayment } from "../../plans/changes.ts";
import { starsCheckoutEnabled } from "../../membership/mode.ts";
import { accessJoinKeyboard } from "../../access/onboarding.ts";

export const paymentsComposer = new Composer();
const starsProvider = new TelegramStarsProvider();

// Handle Pre-Checkout Query (Must answer within 10 seconds)
paymentsComposer.on("pre_checkout_query", async (ctx) => {
  const query = ctx.preCheckoutQuery;

  try {
    // UG-05 Contribution Only: no NEW Stars checkout. (Recurring renewals of existing
    // subscriptions never pass through pre-checkout, so they are unaffected.)
    if (!(await starsCheckoutEnabled())) {
      await ctx.answerPreCheckoutQuery(false, {
        error_message: "Les abonnements par Étoiles ne sont pas offerts pour le moment. Vous pouvez gagner l'accès en contribuant.",
      });
      return;
    }

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
        error_message: validation.errorMessage ?? "La validation du paiement a échoué.",
      });
    }
  } catch (err) {
    console.error("Error in pre_checkout_query handler:", err);
    await ctx.answerPreCheckoutQuery(false, {
      error_message: "Une erreur interne de vérification s'est produite. Veuillez réessayer.",
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
        "✅ Le paiement a déjà été confirmé. Votre abonnement est actif !",
        {
          reply_markup: await accessJoinKeyboard(ctx.api, userId),
        }
      );
      return;
    }

    if (!result.success || !result.entitlement) {
      console.error("Payment processing error:", result.error);
      await ctx.reply(
        "⚠️ Un problème est survenu lors de la finalisation de votre accès. Le soutien a été avisé."
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

    if (result.referralBonus && result.referralBonus.days > 0) {
      await ctx.api
        .sendMessage(
          result.referralBonus.referrerId,
          `🤝 *Parrainage* — une personne que vous avez parrainée a payé un abonnement. Vous recevez *${result.referralBonus.days} jour${result.referralBonus.days > 1 ? "s" : ""}* d'accès.`,
          { parse_mode: "Markdown" }
        )
        .catch(() => {});
    }

    // Membership is committed; put the authorized join buttons directly in the receipt.
    await ctx.reply(messages.paymentSuccess(result.entitlement.expiresAt, planId) + upgradeNote, {
      parse_mode: "Markdown",
      reply_markup: (await accessJoinKeyboard(ctx.api, userId))
        .row()
        .text("📋 Voir mon abonnement", "member:status"),
    });
  } catch (err) {
    console.error("Unhandled error in message:successful_payment handler:", err);
    await ctx.reply(
      "⚠️ Confirmation de paiement reçue, mais une erreur s'est produite. Veuillez communiquer avec le soutien."
    );
  }
});

// Handle refunds issued through the Bot API (refundStarPayment): withdraw the access
// that the refunded charge paid for and take its Stars out of the revenue figures.
paymentsComposer.on("message:refunded_payment", async (ctx) => {
  const refund = ctx.message.refunded_payment;
  const userId = ctx.from?.id;
  if (!userId || !refund) return;

  const handled = await TelegramStarsProvider.handleRefund(
    userId,
    refund.telegram_payment_charge_id
  );
  if (!handled) {
    console.warn(`[Payments] Refund for unknown charge ${refund.telegram_payment_charge_id}`);
  }
});
