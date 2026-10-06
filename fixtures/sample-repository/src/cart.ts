import type { Cents } from './money.ts';

export interface CartItem {
  readonly sku: string;
  readonly unitPrice: Cents;
  readonly quantity: number;
}

export class Cart {
  readonly #items = new Map<string, CartItem>();

  addItem(item: CartItem): void {
    if (item.quantity <= 0) {
      throw new RangeError(`Quantity must be positive for ${item.sku}`);
    }
    const existing = this.#items.get(item.sku);
    const quantity = (existing?.quantity ?? 0) + item.quantity;
    this.#items.set(item.sku, { ...item, quantity });
  }

  removeItem(sku: string): void {
    this.#items.delete(sku);
  }

  get items(): readonly CartItem[] {
    return [...this.#items.values()];
  }

  subtotal(): Cents {
    return this.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }
}
