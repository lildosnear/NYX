import { describe, expect, it } from 'vitest';
import { createTestSystem, getQuote, makeRequest, AGENT_ID } from './helpers.js';

describe('approvals', () => {
  it('settles an over cap payment after the owner approves the exception', async () => {
    const sys = createTestSystem();
    const held = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_research_api', 'deep_report')),
    );
    expect(held.outcome).toBe('approval_required');
    const decision = await sys.engine.approveApproval(held.approvalId as string);
    expect(decision.outcome).toBe('settled');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(900);
    const approval = sys.engine.approvals.get(held.approvalId as string);
    expect(approval?.status).toBe('approved');
    expect(approval?.receiptId).toBe(decision.receiptId);
  });

  it('records the deny reason and a blocked receipt when the owner denies', async () => {
    const sys = createTestSystem();
    const held = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_research_api', 'deep_report')),
    );
    const denied = sys.engine.denyApproval(held.approvalId as string, 'Too expensive this week.');
    expect(denied.status).toBe('denied');
    expect(denied.denyReason).toBe('Too expensive this week.');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(0);
    expect(sys.provider.chargeCount()).toBe(0);
    const blocked = sys.engine.receipts.blockedAttempts();
    expect(blocked.some((r) => r.code === 'APPROVAL_DENIED')).toBe(true);
  });

  it('keeps the daily budget as a hard ceiling even for an approved exception', async () => {
    const sys = createTestSystem({ dailyBudgetCents: 600 });
    const held = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_research_api', 'deep_report')),
    );
    const decision = await sys.engine.approveApproval(held.approvalId as string);
    expect(decision.outcome).toBe('blocked');
    expect(decision.code).toBe('BUDGET_EXCEEDED');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(0);
    const approval = sys.engine.approvals.get(held.approvalId as string);
    expect(approval?.status).toBe('pending');
  });

  it('refuses to approve the same approval twice', async () => {
    const sys = createTestSystem();
    const held = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_research_api', 'deep_report')),
    );
    await sys.engine.approveApproval(held.approvalId as string);
    await expect(sys.engine.approveApproval(held.approvalId as string)).rejects.toThrow(
      'already approved',
    );
  });
});
