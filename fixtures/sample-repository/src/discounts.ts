import type { Cents } from './money.ts';

export interface Discount {
  readonly code: string;
  readonly percentOff: number;
}

export const DISCOUNT_CODES: ReadonlyMap<string, Discount> = new Map([
  ['WELCOME10', { code: 'WELCOME10', percentOff: 10 }],
  ['VIP25', { code: 'VIP25', percentOff: 25 }],
]);

export function applyDiscount(subtotal: Cents, code?: string): Cents {
  if (code === undefined) {
    return subtotal;
  }
  const discount = DISCOUNT_CODES.get(code.toUpperCase());
  if (!discount) {
    throw new Error(`Unknown discount code: ${code}`);
  }
  return Math.round(subtotal * (1 - discount.percentOff / 100));
}
