import type { ChargeRequest, ChargeResult, PaymentGateway } from './gateway.js';

export class FakePaymentGateway implements PaymentGateway {
  readonly charges: ChargeRequest[] = [];
  readonly #declineAbove: number;
  #nextId = 1;

  constructor(declineAbove = Number.POSITIVE_INFINITY) {
    this.#declineAbove = declineAbove;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(request);
    if (request.amount > this.#declineAbove) {
      return { status: 'declined', reason: 'amount exceeds limit' };
    }
    return { status: 'approved', transactionId: `txn_${this.#nextId++}` };
  }
}
