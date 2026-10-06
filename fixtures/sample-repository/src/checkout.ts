import type { Cart } from './cart.js';
import { applyDiscount } from './discounts.js';
import type { Cents } from './money.js';
import type { PaymentGateway } from './payment/gateway.js';

export const TAX_RATE = 0.08;

export interface CheckoutOptions {
  readonly orderId: string;
  readonly discountCode?: string;
  readonly currency?: string;
}

export interface CheckoutReceipt {
  readonly orderId: string;
  readonly subtotal: Cents;
  readonly discounted: Cents;
  readonly tax: Cents;
  readonly total: Cents;
  readonly transactionId: string;
}

export async function checkout(
  cart: Cart,
  gateway: PaymentGateway,
  options: CheckoutOptions,
): Promise<CheckoutReceipt> {
  if (cart.items.length === 0) {
    throw new Error('Cannot check out an empty cart');
  }
  const subtotal = cart.subtotal();
  const discounted = applyDiscount(subtotal, options.discountCode);
  const tax = Math.round(discounted * TAX_RATE);
  const total = discounted + tax;

  const result = await gateway.charge({
    orderId: options.orderId,
    amount: total,
    currency: options.currency ?? 'USD',
  });
  if (result.status === 'declined') {
    throw new Error(`Payment declined for ${options.orderId}: ${result.reason}`);
  }
  return { orderId: options.orderId, subtotal, discounted, tax, total, transactionId: result.transactionId };
}
