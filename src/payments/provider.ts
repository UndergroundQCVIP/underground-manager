/**
 * Underground Manager — Generic Payment Provider Interface
 * Supports V1 Telegram Stars and prepares cleanly for future verified providers.
 */

import { Entitlement, Payment } from "../types.ts";

export interface PaymentVerificationResult {
  valid: boolean;
  paymentData?: Omit<Payment, "id" | "createdAt">;
  error?: string;
}

export interface PaymentProcessResult {
  success: boolean;
  isDuplicate: boolean;
  payment?: Payment;
  entitlement?: Entitlement;
  error?: string;
}

export interface PaymentProvider {
  readonly name: string;

  /**
   * Process a confirmed payment, record payment record and activate/extend entitlement.
   */
  processPayment(
    paymentData: Omit<Payment, "id" | "createdAt">
  ): Promise<PaymentProcessResult>;
}
