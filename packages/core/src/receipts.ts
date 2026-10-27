import { randomBytes } from 'node:crypto';
import type { Receipt, ReceiptOutcome } from './types.js';

export function newReceiptId(): string {
  return `rcpt_${randomBytes(10).toString('hex')}`;
}

/** In memory receipt store. Blocked, failed and settled stay separate. */
export class ReceiptStore {
  private readonly items: Receipt[] = [];

  add(receipt: Receipt): Receipt {
    this.items.push(receipt);
    return receipt;
  }

  list(): Receipt[] {
    return [...this.items];
  }

  byOutcome(outcome: ReceiptOutcome): Receipt[] {
    return this.items.filter((r) => r.outcome === outcome);
  }

  blockedAttempts(): Receipt[] {
    return this.byOutcome('blocked');
  }

  settledTotalCents(): number {
    return this.byOutcome('settled').reduce((sum, r) => sum + r.amountCents, 0);
  }
}
