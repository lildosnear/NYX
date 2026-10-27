import { randomBytes } from 'node:crypto';
import type { Approval, ApprovalStatus, DecisionCode, PaymentRequest } from './types.js';

export function newApprovalId(): string {
  return `appr_${randomBytes(10).toString('hex')}`;
}

/**
 * Store for payments that fell outside policy and are waiting on the owner.
 * Creating an approval never moves money. Approving runs the payment through
 * the policy engine again with an exception attached (handled by the engine).
 */
export class ApprovalStore {
  private readonly items = new Map<string, Approval>();

  create(input: {
    request: PaymentRequest;
    code: DecisionCode;
    reason: string;
    riskExplanation: string;
    now: Date;
  }): Approval {
    const approval: Approval = {
      approvalId: newApprovalId(),
      request: input.request,
      code: input.code,
      reason: input.reason,
      riskExplanation: input.riskExplanation,
      status: 'pending',
      denyReason: null,
      receiptId: null,
      createdAt: input.now.toISOString(),
      resolvedAt: null,
    };
    this.items.set(approval.approvalId, approval);
    return approval;
  }

  get(approvalId: string): Approval | undefined {
    return this.items.get(approvalId);
  }

  list(status?: ApprovalStatus): Approval[] {
    const all = [...this.items.values()];
    return status ? all.filter((a) => a.status === status) : all;
  }

  pendingForRequest(requestId: string): Approval | undefined {
    return [...this.items.values()].find(
      (a) => a.status === 'pending' && a.request.requestId === requestId,
    );
  }

  resolve(
    approvalId: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    extras: { denyReason?: string; receiptId?: string | null; now: Date },
  ): Approval {
    const approval = this.items.get(approvalId);
    if (!approval) throw new Error(`approval ${approvalId} not found`);
    approval.status = status;
    approval.denyReason = extras.denyReason ?? null;
    approval.receiptId = extras.receiptId ?? approval.receiptId;
    approval.resolvedAt = extras.now.toISOString();
    return approval;
  }
}
