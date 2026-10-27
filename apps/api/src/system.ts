import { PolicyEngine, SandboxPaymentProvider } from '@nyx_meta/core';
import { createMerchants, type Merchant } from '@nyx_meta/merchants';
import {
  AgentRunner,
  MetaModelAdapter,
  createModelAdapter,
  createSecondModelAdapter,
  secondModelInfo,
  type ModelAdapter,
  type OpenAiCompatibleModelAdapter,
  type SecondModelInfo,
} from '@nyx_meta/agent';

export const DEFAULT_AGENT_ID = 'agent_research';
export const DEFAULT_CALLER_ID = 'runner';

export interface ModelInfo {
  mode: 'meta' | 'mock';
  model: string | null;
  second: SecondModelInfo;
}

export interface NyxSystem {
  engine: PolicyEngine;
  provider: SandboxPaymentProvider;
  merchants: Map<string, Merchant>;
  approvedVendorIds: string[];
  unapprovedVendorId: string;
  model: ModelAdapter;
  modelInfo: ModelInfo;
  secondModel: OpenAiCompatibleModelAdapter | null;
  runner: AgentRunner;
}

/**
 * Wires the whole demo system together: merchants, sandbox provider, policy
 * engine with one registered agent, and the agent runner on whichever model
 * adapter the environment selects. When MODEL_API_KEY is set the agent runs
 * on Muse Spark through the Meta Model API. When it is not set, the
 * deterministic mock adapter stands in, so the system still runs end to end.
 * Either way the model only plans and explains. The policy engine decides.
 */
export function createSystem(): NyxSystem {
  const merchantSet = createMerchants();
  const provider = new SandboxPaymentProvider();
  const model = createModelAdapter(process.env);
  const secondModel = createSecondModelAdapter(process.env);
  const modelInfo: ModelInfo =
    model instanceof MetaModelAdapter
      ? { mode: 'meta', model: model.modelId, second: secondModelInfo(process.env) }
      : { mode: 'mock', model: null, second: secondModelInfo(process.env) };
  const engine = new PolicyEngine({
    signers: merchantSet.signers,
    provider,
    explainRisk: (info) =>
      model.explainRisk({
        vendorId: info.request.quote.vendorId,
        resource: info.request.quote.resource,
        amountCents: info.request.quote.amountCents,
        code: info.code,
        perPaymentCapCents: info.policy.perPaymentCapCents,
        approvedVendors: info.policy.approvedVendors,
      }),
  });
  engine.registerAgent(
    {
      id: DEFAULT_AGENT_ID,
      name: 'Research Agent',
      status: 'active',
      authorizedCallers: [DEFAULT_CALLER_ID],
    },
    {
      agentId: DEFAULT_AGENT_ID,
      perPaymentCapCents: 500,
      dailyBudgetCents: 5000,
      approvedVendors: [...merchantSet.approvedVendorIds],
      version: 1,
    },
  );
  const runner = new AgentRunner(
    engine,
    merchantSet.merchants,
    model,
    DEFAULT_AGENT_ID,
    DEFAULT_CALLER_ID,
  );
  return {
    engine,
    provider,
    merchants: merchantSet.merchants,
    approvedVendorIds: merchantSet.approvedVendorIds,
    unapprovedVendorId: merchantSet.unapprovedVendorId,
    model,
    modelInfo,
    secondModel,
    runner,
  };
}
