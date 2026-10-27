import { describe, expect, it } from 'vitest';
import {
  MetaModelAdapter,
  MockModelAdapter,
  buildRiskExplanation,
  createModelAdapter,
  type RiskExplanationInput,
} from '@nyx_meta/agent';

interface FakeReply {
  status: number;
  body: string;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (call: RecordedCall) => FakeReply) {
  const calls: RecordedCall[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const call: RecordedCall = { url, init };
    calls.push(call);
    const reply = handler(call);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body,
      json: async () => JSON.parse(reply.body) as unknown,
    };
  };
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

function chatReply(content: string, status = 200): FakeReply {
  return {
    status,
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
  };
}

const RISK_INPUT: RiskExplanationInput = {
  vendorId: 'vendor_research_api',
  resource: 'deep_report',
  amountCents: 900,
  code: 'CAP_EXCEEDED',
  perPaymentCapCents: 500,
  approvedVendors: ['vendor_data_api', 'vendor_research_api', 'vendor_design_tool'],
};

describe('MetaModelAdapter planTask', () => {
  it('parses a valid JSON plan and returns it, calling the Meta endpoint as documented', async () => {
    const planJson =
      '```json\n' +
      JSON.stringify([
        { vendorId: 'vendor_data_api', resource: 'market_dataset', reason: 'The task needs market data.' },
        { vendorId: 'vendor_research_api', resource: 'research_brief', reason: 'The task needs a brief.' },
      ]) +
      '\n```';
    const { fetchFn, calls } = fakeFetch(() => chatReply(planJson));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const plan = await adapter.planTask('research the market and write a brief');
    expect(plan).toEqual([
      { vendorId: 'vendor_data_api', resource: 'market_dataset', reason: 'The task needs market data.' },
      { vendorId: 'vendor_research_api', resource: 'research_brief', reason: 'The task needs a brief.' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.meta.ai/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test_key');
    const sentBody = JSON.parse(calls[0]?.init.body as string) as { model: string; temperature: number };
    expect(sentBody.model).toBe('muse-spark-1.3');
    expect(sentBody.temperature).toBe(0.2);
  });

  it('drops catalog invalid items and keeps the valid ones', async () => {
    const planJson = JSON.stringify([
      { vendorId: 'vendor_shadow_leads', resource: 'premium_leads', reason: 'Not in the catalog.' },
      { vendorId: 'vendor_data_api', resource: 'made_up_resource', reason: 'Resource does not exist.' },
      { vendorId: 'vendor_data_api', resource: 'weather_feed', reason: 'The task mentions weather.' },
      'not an object at all',
    ]);
    const { fetchFn } = fakeFetch(() => chatReply(planJson));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const plan = await adapter.planTask('check the weather');
    expect(plan).toEqual([
      { vendorId: 'vendor_data_api', resource: 'weather_feed', reason: 'The task mentions weather.' },
    ]);
  });

  it('falls back to the mock plan when the API returns 500', async () => {
    const { fetchFn } = fakeFetch(() => chatReply('internal error', 500));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const task = 'research the market and write a brief';
    const plan = await adapter.planTask(task);
    expect(plan).toEqual(await new MockModelAdapter().planTask(task));
    expect(plan.length).toBeGreaterThan(0);
  });

  it('falls back to the mock plan when the API returns non JSON', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: 'this is not json' }));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const task = 'research the market and write a brief';
    const plan = await adapter.planTask(task);
    expect(plan).toEqual(await new MockModelAdapter().planTask(task));
  });

  it('falls back to the mock plan when the plan itself is not JSON', async () => {
    const { fetchFn } = fakeFetch(() => chatReply('Sure, buy some data and a report.'));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const task = 'research the market and write a brief';
    const plan = await adapter.planTask(task);
    expect(plan).toEqual(await new MockModelAdapter().planTask(task));
  });
});

describe('MetaModelAdapter explainRisk', () => {
  it('returns the model text on success, with dash characters cleaned out', async () => {
    const modelText = 'The amount of $9.00 is above the cap of $5.00 — this payment is risky – and no money has moved.';
    const { fetchFn } = fakeFetch(() => chatReply(modelText));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const text = await adapter.explainRisk(RISK_INPUT);
    expect(text).not.toContain('—');
    expect(text).not.toContain('–');
    expect(text).toBe(
      'The amount of $9.00 is above the cap of $5.00, this payment is risky, and no money has moved.',
    );
  });

  it('falls back to the template text when the API errors', async () => {
    const { fetchFn } = fakeFetch(() => chatReply('unauthorized', 401));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const text = await adapter.explainRisk(RISK_INPUT);
    expect(text).toBe(buildRiskExplanation(RISK_INPUT));
    expect(text).toContain('above the per payment cap');
  });

  it('falls back to the template text when the model returns an empty completion', async () => {
    const { fetchFn } = fakeFetch(() => chatReply('   '));
    const adapter = new MetaModelAdapter({ apiKey: 'test_key', fetchFn });
    const text = await adapter.explainRisk(RISK_INPUT);
    expect(text).toBe(buildRiskExplanation(RISK_INPUT));
  });
});

describe('createModelAdapter', () => {
  it('picks the Meta adapter when MODEL_API_KEY is set', () => {
    const adapter = createModelAdapter({ MODEL_API_KEY: 'test_key' });
    expect(adapter).toBeInstanceOf(MetaModelAdapter);
  });

  it('picks the mock adapter when MODEL_API_KEY is unset or blank', () => {
    expect(createModelAdapter({})).toBeInstanceOf(MockModelAdapter);
    expect(createModelAdapter({ MODEL_API_KEY: '' })).toBeInstanceOf(MockModelAdapter);
    expect(createModelAdapter({ MODEL_API_KEY: '   ' })).toBeInstanceOf(MockModelAdapter);
  });
});
