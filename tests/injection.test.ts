import { describe, expect, it } from 'vitest';
import { AgentRunner, MockModelAdapter, attemptInjectedPurchase } from '@nyx_meta/agent';
import { createTestSystem, AGENT_ID, CALLER_ID } from './helpers.js';

describe('agent and injection', () => {
  it('blocks the injection attempt: the agent is talked into it, the money does not move', async () => {
    const sys = createTestSystem();
    const decision = await attemptInjectedPurchase({
      engine: sys.engine,
      merchants: sys.merchants,
      unapprovedVendorId: sys.unapprovedVendorId,
      agentId: AGENT_ID,
      callerId: CALLER_ID,
    });
    expect(decision.outcome).not.toBe('settled');
    expect(decision.code).toBe('VENDOR_NOT_APPROVED');
    expect(sys.provider.chargeCount()).toBe(0);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(0);
    const pending = sys.engine.approvals.list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.riskExplanation).toContain('not on the approved vendor list');
  });

  it('runs a normal task end to end and settles inside the rules', async () => {
    const sys = createTestSystem();
    const runner = new AgentRunner(sys.engine, sys.merchants, new MockModelAdapter(), AGENT_ID, CALLER_ID);
    const result = await runner.runTask('research the market and write a brief');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.decision.outcome === 'settled')).toBe(true);
    expect(result.settledTotalCents).toBe(720);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(720);
  });
});
