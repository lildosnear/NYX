import { describe, expect, it } from 'vitest';
import { createTestSystem, getQuote, makeRequest, AGENT_ID } from './helpers.js';

describe('policy engine rules', () => {
  it('settles a payment inside the rules', async () => {
    const sys = createTestSystem();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'market_dataset')),
    );
    expect(decision.outcome).toBe('settled');
    expect(decision.code).toBe('SETTLED');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(240);
    expect(sys.provider.chargeCount()).toBe(1);
    const receipts = sys.engine.receipts.byOutcome('settled');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.chargeId).toBeTruthy();
  });

  it('holds a payment above the per payment cap for approval instead of settling it', async () => {
    const sys = createTestSystem();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_research_api', 'deep_report')),
    );
    expect(decision.outcome).toBe('approval_required');
    expect(decision.code).toBe('CAP_EXCEEDED');
    expect(decision.approvalId).toBeTruthy();
    expect(sys.provider.chargeCount()).toBe(0);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(0);
  });

  it('holds a payment to a vendor that is not approved for approval', async () => {
    const sys = createTestSystem();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, sys.unapprovedVendorId, 'premium_leads')),
    );
    expect(decision.outcome).toBe('approval_required');
    expect(decision.code).toBe('VENDOR_NOT_APPROVED');
    expect(sys.provider.chargeCount()).toBe(0);
  });

  it('blocks a payment that would exceed the daily budget', async () => {
    const sys = createTestSystem({ dailyBudgetCents: 600 });
    const first = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_research_api', 'research_brief')),
    );
    expect(first.outcome).toBe('settled');
    const second = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'market_dataset')),
    );
    expect(second.outcome).toBe('blocked');
    expect(second.code).toBe('BUDGET_EXCEEDED');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(480);
  });

  it('blocks an expired quote', async () => {
    const sys = createTestSystem();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed', { ttlMs: -1000 })),
    );
    expect(decision.outcome).toBe('blocked');
    expect(decision.code).toBe('QUOTE_EXPIRED');
    expect(sys.provider.chargeCount()).toBe(0);
  });

  it('blocks a replayed quote', async () => {
    const sys = createTestSystem();
    const quote = getQuote(sys, 'vendor_data_api', 'weather_feed');
    const first = await sys.engine.submitPayment(makeRequest(quote));
    expect(first.outcome).toBe('settled');
    const replay = await sys.engine.submitPayment(makeRequest(quote));
    expect(replay.outcome).toBe('blocked');
    expect(replay.code).toBe('QUOTE_REPLAYED');
    expect(sys.provider.chargeCount()).toBe(1);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(120);
  });

  it('returns the original decision for a safe retry with the same idempotency key', async () => {
    const sys = createTestSystem();
    const request = makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed'));
    const first = await sys.engine.submitPayment(request);
    const retry = await sys.engine.submitPayment(request);
    expect(first.outcome).toBe('settled');
    expect(retry.outcome).toBe('settled');
    expect(retry.replayed).toBe(true);
    expect(retry.receiptId).toBe(first.receiptId);
    expect(sys.provider.chargeCount()).toBe(1);
  });

  it('blocks a caller who is not authorized for the agent', async () => {
    const sys = createTestSystem();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed'), { callerId: 'mallory' }),
    );
    expect(decision.outcome).toBe('blocked');
    expect(decision.code).toBe('CALLER_NOT_AUTHORIZED');
    expect(sys.engine.receipts.blockedAttempts()).toHaveLength(1);
  });

  it('blocks payments while the agent is paused, then settles again after resume', async () => {
    const sys = createTestSystem();
    sys.engine.setAgentStatus(AGENT_ID, 'paused');
    const paused = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed')),
    );
    expect(paused.outcome).toBe('blocked');
    expect(paused.code).toBe('AGENT_NOT_ACTIVE');
    sys.engine.setAgentStatus(AGENT_ID, 'active');
    const resumed = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed')),
    );
    expect(resumed.outcome).toBe('settled');
  });

  it('blocks payments after the agent is revoked', async () => {
    const sys = createTestSystem();
    sys.engine.setAgentStatus(AGENT_ID, 'revoked');
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed')),
    );
    expect(decision.outcome).toBe('blocked');
    expect(decision.code).toBe('AGENT_NOT_ACTIVE');
    expect(sys.provider.chargeCount()).toBe(0);
  });

  it('blocks a payment for an agent that does not exist', async () => {
    const sys = createTestSystem();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'weather_feed'), { agentId: 'ghost' }),
    );
    expect(decision.outcome).toBe('blocked');
    expect(decision.code).toBe('AGENT_NOT_FOUND');
  });

  it('blocks a quote whose amount was tampered with', async () => {
    const sys = createTestSystem();
    const quote = getQuote(sys, 'vendor_data_api', 'weather_feed');
    const tampered = { ...quote, amountCents: 1 };
    const decision = await sys.engine.submitPayment(makeRequest(tampered));
    expect(decision.outcome).toBe('blocked');
    expect(decision.code).toBe('QUOTE_SIGNATURE_INVALID');
    expect(sys.provider.chargeCount()).toBe(0);
  });
});
