import { ApprovalStore } from './approvals.js';
import { BudgetLedger } from './ledger.js';
import { formatUsd } from './money.js';
import type { PaymentProvider } from './provider.js';
import type { QuoteSigner } from './quotes.js';
import { ReceiptStore, newReceiptId } from './receipts.js';
import { buildRiskExplanation, type RiskInfo } from './risk.js';
import type {
  Agent,
  AgentStatus,
  Approval,
  Decision,
  DecisionCode,
  PaymentRequest,
  Policy,
  Receipt,
  ReceiptOutcome,
} from './types.js';

export interface PolicyEngineOptions {
  /** One signer per vendor id, used to verify that vendor's quotes. */
  signers: Map<string, QuoteSigner>;
  provider: PaymentProvider;
  /** Optional richer risk explanation, sync or async. Defaults to the built in template. */
  explainRisk?: (info: RiskInfo) => string | Promise<string>;
}

export interface SubmitOptions {
  /** Owner exception: waives the vendor list and the per payment cap. The daily budget is never waived. */
  exception?: boolean;
  now?: Date;
}

/** Policy amounts are whole cents, zero or more. Anything else is a mistake, not a setting. */
function assertAmount(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a whole number of cents, zero or more`);
  }
}

/**
 * The policy engine. It decides every payment before any money moves, in a
 * fixed order, and the decision never comes from a model:
 *
 * 1. The agent exists. 2. The agent is active. 3. The caller is authorized
 * for that agent. 4. The quote signature is valid. 5. The quote has not
 * expired. 6. The quote nonce has not been replayed. 7. The vendor is
 * approved. 8. The amount is within the per payment cap. 9. The daily
 * budget has room. Only then is the payment executed and the budget booked.
 *
 * Steps 7 and 8 are owner rules, so a failure there does not silently pass
 * and does not silently fail: it creates a pending approval for the owner.
 * Every other failure is a hard block. Decisions are serialized per agent,
 * so concurrent attempts can never race the budget.
 */
export class PolicyEngine {
  readonly ledger = new BudgetLedger();
  readonly receipts = new ReceiptStore();
  readonly approvals = new ApprovalStore();

  private readonly agents = new Map<string, Agent>();
  private readonly policies = new Map<string, Policy>();
  private readonly idempotency = new Map<string, Decision>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly opts: PolicyEngineOptions) {}

  registerAgent(agent: Agent, policy: Policy): void {
    if (policy.agentId !== agent.id) throw new Error('policy agentId must match the agent id');
    if (this.agents.has(agent.id)) throw new Error(`agent ${agent.id} already exists`);
    assertAmount('the per payment cap', policy.perPaymentCapCents);
    assertAmount('the daily budget', policy.dailyBudgetCents);
    this.agents.set(agent.id, { ...agent, authorizedCallers: [...agent.authorizedCallers] });
    this.policies.set(agent.id, {
      ...policy,
      approvedVendors: [...policy.approvedVendors],
    });
  }

  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): Agent[] {
    return [...this.agents.values()];
  }

  setAgentStatus(agentId: string, status: AgentStatus): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    if (agent.status === 'revoked' && status !== 'revoked') {
      throw new Error(`agent ${agentId} has been revoked, and revoking is final`);
    }
    agent.status = status;
    return agent;
  }

  getPolicy(agentId: string): Policy | undefined {
    return this.policies.get(agentId);
  }

  listPolicies(): Policy[] {
    return [...this.policies.values()];
  }

  updatePolicy(
    agentId: string,
    patch: Partial<Pick<Policy, 'perPaymentCapCents' | 'dailyBudgetCents' | 'approvedVendors'>>,
  ): Policy {
    const policy = this.policies.get(agentId);
    if (!policy) throw new Error(`policy for agent ${agentId} not found`);
    if (patch.perPaymentCapCents !== undefined) assertAmount('the per payment cap', patch.perPaymentCapCents);
    if (patch.dailyBudgetCents !== undefined) assertAmount('the daily budget', patch.dailyBudgetCents);
    if (patch.perPaymentCapCents !== undefined) policy.perPaymentCapCents = patch.perPaymentCapCents;
    if (patch.dailyBudgetCents !== undefined) policy.dailyBudgetCents = patch.dailyBudgetCents;
    if (patch.approvedVendors !== undefined) policy.approvedVendors = [...patch.approvedVendors];
    policy.version += 1;
    return policy;
  }

  spentToday(agentId: string, now: Date = new Date()): number {
    return this.ledger.spentToday(agentId, now.getTime());
  }

  async submitPayment(request: PaymentRequest, opts: SubmitOptions = {}): Promise<Decision> {
    return this.withAgentLock(request.agentId, () => this.submitLocked(request, opts));
  }

  /** Approve a pending approval: the payment runs again with an exception. */
  async approveApproval(approvalId: string, now: Date = new Date()): Promise<Decision> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`approval ${approvalId} not found`);
    if (approval.status !== 'pending') {
      throw new Error(`approval ${approvalId} is already ${approval.status}`);
    }
    const decision = await this.submitPayment(approval.request, { exception: true, now });
    if (decision.outcome === 'settled' || decision.outcome === 'execution_failed') {
      this.approvals.resolve(approvalId, 'approved', { receiptId: decision.receiptId, now });
    }
    return decision;
  }

  /** Deny a pending approval. Records a blocked receipt with the reason. */
  denyApproval(approvalId: string, denyReason: string, now: Date = new Date()): Approval {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`approval ${approvalId} not found`);
    if (approval.status !== 'pending') {
      throw new Error(`approval ${approvalId} is already ${approval.status}`);
    }
    const receipt = this.recordReceipt(
      approval.request,
      'blocked',
      'APPROVAL_DENIED',
      `Owner denied this payment. Reason: ${denyReason}`,
      null,
      now,
    );
    return this.approvals.resolve(approvalId, 'denied', {
      denyReason,
      receiptId: receipt.receiptId,
      now,
    });
  }

  private async submitLocked(request: PaymentRequest, opts: SubmitOptions): Promise<Decision> {
    const now = opts.now ?? new Date();
    const exception = opts.exception === true;
    const quote = request.quote;

    // Safe retry: the same idempotency key returns the original decision and
    // never creates a second charge or a second approval.
    if (!exception) {
      const prior = this.idempotency.get(request.idempotencyKey);
      if (prior) return { ...prior, replayed: true };
    }

    const remember = (decision: Decision): Decision => {
      if (!exception && decision.outcome !== 'approval_required') {
        this.idempotency.set(request.idempotencyKey, decision);
      }
      return decision;
    };

    const blocked = (code: DecisionCode, reason: string): Decision => {
      const receipt = this.recordReceipt(request, 'blocked', code, reason, null, now);
      return remember({
        outcome: 'blocked',
        code,
        reason,
        receiptId: receipt.receiptId,
        approvalId: null,
        replayed: false,
      });
    };

    // 1. The agent exists.
    const agent = this.agents.get(request.agentId);
    if (!agent) {
      return blocked('AGENT_NOT_FOUND', `Agent ${request.agentId} is not registered.`);
    }
    const policy = this.policies.get(request.agentId);
    if (!policy) {
      return blocked('AGENT_NOT_FOUND', `No policy is registered for agent ${request.agentId}.`);
    }

    // 2. The agent is active. Paused blocks everything, revoked ends access.
    if (agent.status !== 'active') {
      return blocked(
        'AGENT_NOT_ACTIVE',
        agent.status === 'paused'
          ? `Agent ${agent.id} is paused by the owner. All payments are blocked.`
          : `Agent ${agent.id} has been revoked by the owner. Its access has ended.`,
      );
    }

    // 3. The caller is authorized for this agent.
    if (!agent.authorizedCallers.includes(request.callerId)) {
      return blocked(
        'CALLER_NOT_AUTHORIZED',
        `Caller ${request.callerId} is not authorized to act for agent ${agent.id}.`,
      );
    }

    // 4. The quote signature is valid.
    const signer = this.opts.signers.get(quote.vendorId);
    if (!signer || !signer.verify(quote)) {
      return blocked(
        'QUOTE_SIGNATURE_INVALID',
        `The quote from vendor ${quote.vendorId} has an invalid signature.`,
      );
    }

    // 5. The quote has not expired.
    if (Number.isNaN(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now.getTime()) {
      return blocked('QUOTE_EXPIRED', `The quote ${quote.quoteId} expired at ${quote.expiresAt}.`);
    }

    // 6. The quote nonce has not been replayed.
    if (this.ledger.hasNonce(quote.vendorId, quote.nonce)) {
      return blocked(
        'QUOTE_REPLAYED',
        `The quote ${quote.quoteId} was already used. A quote can only be paid once.`,
      );
    }

    // 7 and 8. Owner rules. A failure creates a pending approval, unless the
    // owner already attached an exception to this run.
    if (!exception && !policy.approvedVendors.includes(quote.vendorId)) {
      return this.createApproval(request, policy, 'VENDOR_NOT_APPROVED',
        `Vendor ${quote.vendorId} is not on the approved vendor list for agent ${agent.id}.`, now);
    }
    if (!exception && quote.amountCents > policy.perPaymentCapCents) {
      return this.createApproval(request, policy, 'CAP_EXCEEDED',
        `The amount ${formatUsd(quote.amountCents)} is above the per payment cap of ${formatUsd(policy.perPaymentCapCents)} for agent ${agent.id}.`, now);
    }

    // 9. The daily budget has room. This ceiling is never waived, not even
    // by an owner exception. An exception payment still consumes budget.
    const spent = this.ledger.spentToday(agent.id, now.getTime());
    if (spent + quote.amountCents > policy.dailyBudgetCents) {
      return blocked(
        'BUDGET_EXCEEDED',
        `The daily budget of ${formatUsd(policy.dailyBudgetCents)} for agent ${agent.id} has ${formatUsd(policy.dailyBudgetCents - spent)} left, and this payment is ${formatUsd(quote.amountCents)}.`,
      );
    }

    // All checks passed. Claim the nonce, then execute.
    this.ledger.claimNonce(quote.vendorId, quote.nonce);
    let chargeId: string;
    try {
      const charge = await this.opts.provider.charge({
        amountCents: quote.amountCents,
        vendorId: quote.vendorId,
        idempotencyKey: request.idempotencyKey,
      });
      chargeId = charge.chargeId;
    } catch (err) {
      const reason = `Payment execution failed: ${err instanceof Error ? err.message : String(err)}`;
      const receipt = this.recordReceipt(request, 'execution_failed', 'EXECUTION_FAILED', reason, null, now);
      return remember({
        outcome: 'execution_failed',
        code: 'EXECUTION_FAILED',
        reason,
        receiptId: receipt.receiptId,
        approvalId: null,
        replayed: false,
      });
    }

    this.ledger.recordSettled(agent.id, quote.amountCents, now.getTime());
    const receipt = this.recordReceipt(
      request,
      'settled',
      'SETTLED',
      exception
        ? 'Payment settled under an owner approved exception.'
        : 'Payment settled inside the owner rules.',
      chargeId,
      now,
    );
    return remember({
      outcome: 'settled',
      code: 'SETTLED',
      reason: receipt.reason,
      receiptId: receipt.receiptId,
      approvalId: null,
      replayed: false,
    });
  }

  private async createApproval(
    request: PaymentRequest,
    policy: Policy,
    code: DecisionCode,
    reason: string,
    now: Date,
  ): Promise<Decision> {
    const existing = this.approvals.pendingForRequest(request.requestId);
    if (existing) {
      return {
        outcome: 'approval_required',
        code: existing.code,
        reason: existing.reason,
        receiptId: null,
        approvalId: existing.approvalId,
        replayed: false,
      };
    }
    const riskExplanation = this.opts.explainRisk
      ? await this.opts.explainRisk({ code, request, policy })
      : buildRiskExplanation({ code, request, policy });
    const approval = this.approvals.create({ request, code, reason, riskExplanation, now });
    return {
      outcome: 'approval_required',
      code,
      reason,
      receiptId: null,
      approvalId: approval.approvalId,
      replayed: false,
    };
  }

  private recordReceipt(
    request: PaymentRequest,
    outcome: ReceiptOutcome,
    code: DecisionCode,
    reason: string,
    chargeId: string | null,
    now: Date,
  ): Receipt {
    return this.receipts.add({
      receiptId: newReceiptId(),
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      agentId: request.agentId,
      vendorId: request.quote.vendorId,
      resource: request.quote.resource,
      amountCents: request.quote.amountCents,
      outcome,
      code,
      reason,
      chargeId,
      createdAt: now.toISOString(),
    });
  }

  /** Serialize decisions per agent so concurrent attempts cannot race. */
  private async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      agentId,
      prior.then(() => gate),
    );
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
