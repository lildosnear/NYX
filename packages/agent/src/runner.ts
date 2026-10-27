import { randomUUID } from 'node:crypto';
import type { Decision, PaymentRequest, PolicyEngine } from '@nyx_meta/core';
import type { Merchant } from '@nyx_meta/merchants';
import type { ModelAdapter } from './model.js';

export interface PurchaseAttempt {
  vendorId: string;
  resource: string;
  amountCents: number;
  decision: Decision;
}

export interface TaskResult {
  task: string;
  attempts: PurchaseAttempt[];
  settledTotalCents: number;
  summary: string;
}

/**
 * Runs one agent task: ask the model what to buy, get a signed quote for
 * each purchase, and submit every payment through Nyx. The runner never
 * holds payment credentials and never pays a vendor directly.
 */
export class AgentRunner {
  constructor(
    private readonly engine: PolicyEngine,
    private readonly merchants: Map<string, Merchant>,
    private readonly model: ModelAdapter,
    private readonly agentId: string,
    private readonly callerId: string,
  ) {}

  async runTask(task: string, now: Date = new Date()): Promise<TaskResult> {
    const plan = await this.model.planTask(task);
    const attempts: PurchaseAttempt[] = [];
    for (const planned of plan) {
      const merchant = this.merchants.get(planned.vendorId);
      if (!merchant) continue;
      const quote = merchant.getQuote(planned.resource, { now });
      const request: PaymentRequest = {
        requestId: `req_${randomUUID()}`,
        agentId: this.agentId,
        callerId: this.callerId,
        quote,
        idempotencyKey: `idem_${randomUUID()}`,
        purpose: planned.reason,
      };
      const decision = await this.engine.submitPayment(request, { now });
      attempts.push({
        vendorId: planned.vendorId,
        resource: planned.resource,
        amountCents: quote.amountCents,
        decision,
      });
    }
    const settled = attempts.filter((a) => a.decision.outcome === 'settled');
    const settledTotalCents = settled.reduce((sum, a) => sum + a.amountCents, 0);
    return {
      task,
      attempts,
      settledTotalCents,
      summary: `${settled.length} of ${attempts.length} purchases settled. The rest were held or blocked by policy, and no money moved for them.`,
    };
  }
}
