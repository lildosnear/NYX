/**
 * Nyx core types.
 *
 * Money rule: amounts are always integer cents. Never use floating point
 * for money anywhere in this repo.
 */

export type AgentStatus = 'active' | 'paused' | 'revoked';

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  /** Caller identities allowed to submit payments for this agent. */
  authorizedCallers: string[];
}

/** Owner set spending rules for one agent. Only the owner can widen them. */
export interface Policy {
  agentId: string;
  /** Maximum amount for a single payment, in cents. */
  perPaymentCapCents: number;
  /** Maximum settled total per UTC day, in cents. Absolute ceiling. */
  dailyBudgetCents: number;
  /** Vendor ids the agent is allowed to pay without owner approval. */
  approvedVendors: string[];
  version: number;
}

/** A vendor signed price quote for one resource. Single use, expiring. */
export interface Quote {
  quoteId: string;
  vendorId: string;
  resource: string;
  amountCents: number;
  currency: 'USD';
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

/** One payment attempt, submitted by a caller acting for an agent. */
export interface PaymentRequest {
  requestId: string;
  agentId: string;
  callerId: string;
  quote: Quote;
  idempotencyKey: string;
  purpose: string;
}

export type DecisionOutcome = 'settled' | 'blocked' | 'approval_required' | 'execution_failed';

export type DecisionCode =
  | 'SETTLED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_NOT_ACTIVE'
  | 'CALLER_NOT_AUTHORIZED'
  | 'QUOTE_SIGNATURE_INVALID'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_REPLAYED'
  | 'VENDOR_NOT_APPROVED'
  | 'CAP_EXCEEDED'
  | 'BUDGET_EXCEEDED'
  | 'APPROVAL_DENIED'
  | 'EXECUTION_FAILED';

export interface Decision {
  outcome: DecisionOutcome;
  code: DecisionCode;
  reason: string;
  receiptId: string | null;
  approvalId: string | null;
  /** True when this decision is the original result of a safe retry. */
  replayed: boolean;
}

export type ReceiptOutcome = 'settled' | 'blocked' | 'execution_failed';

/**
 * A receipt records one finished attempt. The three outcomes are kept
 * separate on purpose: blocked by policy means never attempted, execution
 * failed means attempted and no budget was consumed, settled means the
 * budget was consumed. The owner must always be able to tell which happened.
 */
export interface Receipt {
  receiptId: string;
  requestId: string;
  idempotencyKey: string;
  agentId: string;
  vendorId: string;
  resource: string;
  amountCents: number;
  outcome: ReceiptOutcome;
  code: DecisionCode;
  reason: string;
  chargeId: string | null;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

/** An out of policy payment waiting for the owner. No money has moved. */
export interface Approval {
  approvalId: string;
  request: PaymentRequest;
  code: DecisionCode;
  reason: string;
  riskExplanation: string;
  status: ApprovalStatus;
  denyReason: string | null;
  receiptId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
