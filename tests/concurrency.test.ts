import { describe, expect, it } from 'vitest';
import { createTestSystem, getQuote, makeRequest, AGENT_ID } from './helpers.js';

describe('concurrency', () => {
  it('never overspends the daily budget when ten attempts race it at once', async () => {
    const sys = createTestSystem({ dailyBudgetCents: 1200 });
    const requests = Array.from({ length: 10 }, () =>
      makeRequest(getQuote(sys, 'vendor_data_api', 'market_dataset')),
    );
    const decisions = await Promise.all(
      requests.map((r) => sys.engine.submitPayment(r)),
    );
    const settled = decisions.filter((d) => d.outcome === 'settled');
    const blocked = decisions.filter((d) => d.outcome === 'blocked' && d.code === 'BUDGET_EXCEEDED');
    expect(settled).toHaveLength(5);
    expect(blocked).toHaveLength(5);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(1200);
    expect(sys.provider.chargeCount()).toBe(5);
  });
});
