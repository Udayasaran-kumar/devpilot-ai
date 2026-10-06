export type Cents = number;

export function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}

export function formatCents(cents: Cents, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
