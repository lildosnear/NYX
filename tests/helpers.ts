import {
  PolicyEngine,
  SandboxPaymentProvider,
  type PaymentRequest,
  type Quote,
} from '@nyx_meta/core';
import { createMerchants, type Merchant } from '@nyx_meta/merchants';

export const AGENT_ID = 'agent_test';
export const CALLER_ID = 'runner';

export interface TestSystem {
  engine: PolicyEngine;
  provider: SandboxPaymentProvider;
  merchants: Map<string, Merchant>;
  approvedVendorIds: string[];
  unapprovedVendorId: string;
}

export function createTestSystem(
  policyPatch: { perPaymentCapCents?: number; dailyBudgetCents?: number } = {},
): TestSystem {
  const merchantSet = createMerchants();
  const provider = new SandboxPaymentProvider();
  const engine = new PolicyEngine({ signers: merchantSet.signers, provider });
  engine.registerAgent(
    { id: AGENT_ID, name: 'Test Agent', status: 'active', authorizedCallers: [CALLER_ID] },
    {
      agentId: AGENT_ID,
      perPaymentCapCents: policyPatch.perPaymentCapCents ?? 500,
      dailyBudgetCents: policyPatch.dailyBudgetCents ?? 5000,
      approvedVendors: [...merchantSet.approvedVendorIds],
      version: 1,
    },
  );
  return {
    engine,
    provider,
    merchants: merchantSet.merchants,
    approvedVendorIds: merchantSet.approvedVendorIds,
    unapprovedVendorId: merchantSet.unapprovedVendorId,
  };
}

let counter = 0;

export function getQuote(
  sys: TestSystem,
  vendorId: string,
  resource: string,
  opts: { ttlMs?: number } = {},
): Quote {
  const merchant = sys.merchants.get(vendorId);
  if (!merchant) throw new Error(`unknown vendor ${vendorId}`);
  return merchant.getQuote(resource, opts);
}

export function makeRequest(quote: Quote, overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  counter += 1;
  return {
    requestId: `req_test_${counter}`,
    agentId: AGENT_ID,
    callerId: CALLER_ID,
    quote,
    idempotencyKey: `idem_test_${counter}`,
    purpose: 'test purchase',
    ...overrides,
  };
}
