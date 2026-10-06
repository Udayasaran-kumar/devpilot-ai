import type { Cents } from '../money.js';

export interface ChargeRequest {
  readonly orderId: string;
  readonly amount: Cents;
  readonly currency: string;
}

export type ChargeResult =
  | { readonly status: 'approved'; readonly transactionId: string }
  | { readonly status: 'declined'; readonly reason: string };

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
