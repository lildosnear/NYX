import { describe, expect, it } from 'vitest';
import { SandboxPaymentProvider } from '@nyx_meta/core';
import { createTestSystem, getQuote, makeRequest, AGENT_ID } from './helpers.js';

describe('payment execution', () => {
  it('records a failed execution and does not consume budget', async () => {
    const sys = createTestSystem();
    sys.provider.forceFailNextCharge();
    const decision = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'market_dataset')),
    );
    expect(decision.outcome).toBe('execution_failed');
    expect(decision.code).toBe('EXECUTION_FAILED');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(0);
    const failed = sys.engine.receipts.byOutcome('execution_failed');
    expect(failed).toHaveLength(1);
    expect(sys.engine.receipts.byOutcome('settled')).toHaveLength(0);
  });

  it('lets the agent buy again with a fresh quote after a failure', async () => {
    const sys = createTestSystem();
    sys.provider.forceFailNextCharge();
    const failed = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'market_dataset')),
    );
    expect(failed.outcome).toBe('execution_failed');
    const retry = await sys.engine.submitPayment(
      makeRequest(getQuote(sys, 'vendor_data_api', 'market_dataset')),
    );
    expect(retry.outcome).toBe('settled');
    expect(sys.engine.spentToday(AGENT_ID)).toBe(240);
  });

  it('makes sandbox charges idempotent by key', async () => {
    const provider = new SandboxPaymentProvider();
    const input = { amountCents: 100, vendorId: 'vendor_data_api', idempotencyKey: 'same_key' };
    const first = await provider.charge(input);
    const second = await provider.charge(input);
    expect(second.chargeId).toBe(first.chargeId);
    expect(provider.chargeCount()).toBe(1);
  });
});
