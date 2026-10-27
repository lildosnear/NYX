import { randomBytes } from 'node:crypto';
import { assertAmountCents } from './money.js';

export interface ChargeInput {
  amountCents: number;
  vendorId: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  chargeId: string;
}

/**
 * The payment execution seam. The policy engine decides, then a provider
 * executes. A real provider in test mode can implement this interface
 * without the engine changing at all.
 */
export interface PaymentProvider {
  charge(input: ChargeInput): Promise<ChargeResult>;
}

/**
 * Sandbox provider: simulates test mode charges. No real money moves.
 * Charges are idempotent by key, and a test can force the next charge to
 * fail in order to prove that failed executions never consume budget.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  private readonly charges = new Map<string, ChargeResult>();
  private counter = 0;
  private failNext = false;

  forceFailNextCharge(): void {
    this.failNext = true;
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    assertAmountCents(input.amountCents, 'charge amount');
    const prior = this.charges.get(input.idempotencyKey);
    if (prior) return prior;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('sandbox provider declined the charge');
    }
    this.counter += 1;
    const result: ChargeResult = {
      chargeId: `ch_${this.counter}_${randomBytes(6).toString('hex')}`,
    };
    this.charges.set(input.idempotencyKey, result);
    return result;
  }

  chargeCount(): number {
    return this.charges.size;
  }
}
