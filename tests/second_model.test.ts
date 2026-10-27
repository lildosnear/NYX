import { describe, expect, it } from 'vitest';
import {
  MockModelAdapter,
  OpenAiCompatibleModelAdapter,
  buildRiskExplanation,
  createSecondModelAdapter,
  secondModelInfo,
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

function makeAdapter(fetchFn: typeof fetch): OpenAiCompatibleModelAdapter {
  return new OpenAiCompatibleModelAdapter({
    provider: 'fireworks',
    apiKey: 'test_key',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/test',
    fetchFn,
  });
}

describe('OpenAiCompatibleModelAdapter', () => {
  it('plans through the provider endpoint and drops catalog invalid items', async () => {
    const planJson = JSON.stringify([
      { vendorId: 'vendor_shadow_leads', resource: 'premium_leads', reason: 'Not in the catalog.' },
      { vendorId: 'vendor_data_api', resource: 'market_dataset', reason: 'The task needs market data.' },
    ]);
    const { fetchFn, calls } = fakeFetch(() => chatReply(planJson));
    const plan = await makeAdapter(fetchFn).planTask('research the market');
    expect(plan).toEqual([
      { vendorId: 'vendor_data_api', resource: 'market_dataset', reason: 'The task needs market data.' },
    ]);
    expect(calls[0]?.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test_key');
    const sentBody = JSON.parse(calls[0]?.init.body as string) as { model: string };
    expect(sentBody.model).toBe('accounts/fireworks/models/test');
  });

  it('explains risk with dash characters cleaned out', async () => {
    const { fetchFn } = fakeFetch(() => chatReply('The amount is above the cap — no money has moved.'));
    const text = await makeAdapter(fetchFn).explainRisk(RISK_INPUT);
    expect(text).not.toContain('—');
    expect(text).toBe('The amount is above the cap, no money has moved.');
  });

  it('falls back to the mock plan and the template text when the provider errors', async () => {
    const { fetchFn } = fakeFetch(() => chatReply('unauthorized', 401));
    const adapter = makeAdapter(fetchFn);
    const task = 'research the market and write a brief';
    expect(await adapter.planTask(task)).toEqual(await new MockModelAdapter().planTask(task));
    expect(await adapter.explainRisk(RISK_INPUT)).toBe(buildRiskExplanation(RISK_INPUT));
  });
});

describe('createSecondModelAdapter', () => {
  it('returns null when any required value is missing', () => {
    expect(createSecondModelAdapter({})).toBeNull();
    expect(
      createSecondModelAdapter({ SECOND_MODEL_PROVIDER: 'fireworks', SECOND_MODEL_API_KEY: 'k' }),
    ).toBeNull();
    expect(
      createSecondModelAdapter({
        SECOND_MODEL_PROVIDER: 'modal',
        SECOND_MODEL_API_KEY: 'k',
        SECOND_MODEL_ID: 'm',
      }),
    ).toBeNull();
  });

  it('builds an adapter from a preset base URL and reports the info', () => {
    const env = {
      SECOND_MODEL_PROVIDER: 'Fireworks',
      SECOND_MODEL_API_KEY: 'test_key',
      SECOND_MODEL_ID: 'accounts/fireworks/models/test',
    };
    const adapter = createSecondModelAdapter(env);
    expect(adapter).toBeInstanceOf(OpenAiCompatibleModelAdapter);
    expect(adapter?.providerName).toBe('fireworks');
    expect(secondModelInfo(env)).toEqual({
      configured: true,
      provider: 'fireworks',
      model: 'accounts/fireworks/models/test',
    });
    expect(secondModelInfo({})).toEqual({ configured: false, provider: null, model: null });
  });

  it('accepts a Modal endpoint URL from the environment', () => {
    const adapter = createSecondModelAdapter({
      SECOND_MODEL_PROVIDER: 'modal',
      SECOND_MODEL_API_KEY: 'test_key',
      SECOND_MODEL_BASE_URL: 'https://example.modal.run/v1',
      SECOND_MODEL_ID: 'open weights model',
    });
    expect(adapter).toBeInstanceOf(OpenAiCompatibleModelAdapter);
    expect(adapter?.providerName).toBe('modal');
  });
});
