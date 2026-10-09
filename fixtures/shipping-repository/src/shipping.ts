export interface ShippingQuote {
  readonly subtotal: number;
  readonly shipping: number;
  readonly total: number;
}

/** Orders at or above the threshold ship free; smaller orders pay the flat rate. */
export function quoteShipping(subtotal: number, freeThreshold: number, flatRate: number): ShippingQuote {
  const shipping = subtotal > freeThreshold ? 0 : flatRate;
  return { subtotal, shipping, total: subtotal + shipping };
}
