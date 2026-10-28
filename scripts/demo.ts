import { randomUUID } from 'node:crypto';
import {
  PolicyEngine,
  SandboxPaymentProvider,
  formatUsd,
  type PaymentRequest,
  type Quote,
} from '@nyx_meta/core';
import { createMerchants } from '@nyx_meta/merchants';
import { AgentRunner, MockModelAdapter, attemptInjectedPurchase } from '@nyx_meta/agent';

/**
 * The Nyx demo. Five scenes, run in process against the real policy engine,
 * the real signed quotes and the sandbox payment provider. Prints one PASS
 * or FAIL line per check and exits nonzero when anything fails.
 */

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures += 1;
}

const AGENT_ID = 'agent_research';
const CALLER_ID = 'runner';

async function main(): Promise<void> {
  const merchantSet = createMerchants();
  const provider = new SandboxPaymentProvider();
  const engine = new PolicyEngine({ signers: merchantSet.signers, provider });
  engine.registerAgent(
    { id: AGENT_ID, name: 'Research Agent', status: 'active', authorizedCallers: [CALLER_ID] },
    {
      agentId: AGENT_ID,
      perPaymentCapCents: 500,
      dailyBudgetCents: 5000,
      approvedVendors: [...merchantSet.approvedVendorIds],
      version: 1,
    },
  );
  const model = new MockModelAdapter();
  const runner = new AgentRunner(engine, merchantSet.merchants, model, AGENT_ID, CALLER_ID);

  const submit = (quote: Quote, callerId: string = CALLER_ID, agentId: string = AGENT_ID) => {
    const request: PaymentRequest = {
      requestId: `req_${randomUUID()}`,
      agentId,
      callerId,
      quote,
      idempotencyKey: `idem_${randomUUID()}`,
      purpose: 'demo purchase',
    };
    return engine.submitPayment(request);
  };
  const quoteFor = (vendorId: string, resource: string, ttlMs?: number) => {
    const merchant = merchantSet.merchants.get(vendorId);
    if (!merchant) throw new Error(`unknown vendor ${vendorId}`);
    return merchant.getQuote(resource, { ttlMs });
  };

  console.log('Nyx demo: an agent with a job, a budget, and rules it cannot break.');
  console.log('Rules: $5.00 per payment cap, $50.00 daily budget, three approved vendors.\n');

  // Scene 1: a payment inside the rules settles.
  const task = await runner.runTask('research the market and write a brief');
  const scene1Ok =
    task.attempts.length === 2 && task.attempts.every((a) => a.decision.outcome === 'settled');
  check(
    'Scene 1, payment inside the rules settles',
    scene1Ok,
    `the agent bought a market data set and a research brief for ${formatUsd(task.settledTotalCents)} in total.`,
  );

  // Scene 2: an over cap payment is held and blocked from settling.
  const overCapQuote = quoteFor('vendor_research_api', 'deep_report');
  const overCap = await submit(overCapQuote);
  check(
    'Scene 2, over cap payment blocked',
    overCap.outcome === 'approval_required' &&
      overCap.code === 'CAP_EXCEEDED' &&
      overCap.approvalId !== null &&
      provider.chargeCount() === 2,
    `a ${formatUsd(overCapQuote.amountCents)} report is above the cap, so no money moved and the payment is waiting for the owner.`,
  );

  // Scene 3: the owner approves that one payment as an exception, it settles.
  const approved = await engine.approveApproval(overCap.approvalId as string);
  check(
    'Scene 3, approved exception settles',
    approved.outcome === 'settled' && engine.spentToday(AGENT_ID) === 1620,
    `the owner approved the exception and the deep report settled. Settled today: ${formatUsd(engine.spentToday(AGENT_ID))}.`,
  );

  // Scene 4: a paused agent is blocked, and a revoked agent is blocked.
  // Revoking is final, so this agent takes no further part in the demo.
  engine.setAgentStatus(AGENT_ID, 'paused');
  const pausedAttempt = await submit(quoteFor('vendor_data_api', 'weather_feed'));
  engine.setAgentStatus(AGENT_ID, 'active');
  engine.setAgentStatus(AGENT_ID, 'revoked');
  const revokedAttempt = await submit(quoteFor('vendor_data_api', 'weather_feed'));
  check(
    'Scene 4, paused and revoked agents blocked',
    pausedAttempt.outcome === 'blocked' &&
      pausedAttempt.code === 'AGENT_NOT_ACTIVE' &&
      revokedAttempt.outcome === 'blocked' &&
      revokedAttempt.code === 'AGENT_NOT_ACTIVE',
    'while paused, and again after revoke, the agent could not pay for anything.',
  );

  // A second agent carries the remaining scenes, with its own budget.
  const SECOND_AGENT_ID = 'agent_field';
  engine.registerAgent(
    { id: SECOND_AGENT_ID, name: 'Field Agent', status: 'active', authorizedCallers: [CALLER_ID] },
    {
      agentId: SECOND_AGENT_ID,
      perPaymentCapCents: 500,
      dailyBudgetCents: 5000,
      approvedVendors: [...merchantSet.approvedVendorIds],
      version: 1,
    },
  );

  // Scene 5: a prompt injection pushes the agent to an unapproved vendor,
  // over the cap. The money still does not move.
  const spentBefore = engine.spentToday(SECOND_AGENT_ID);
  const injection = await attemptInjectedPurchase({
    engine,
    merchants: merchantSet.merchants,
    unapprovedVendorId: merchantSet.unapprovedVendorId,
    agentId: SECOND_AGENT_ID,
    callerId: CALLER_ID,
  });
  const injectionApproval =
    injection.approvalId !== null ? engine.approvals.get(injection.approvalId) : undefined;
  check(
    'Scene 5, injection attempt blocked',
    injection.outcome !== 'settled' &&
      engine.spentToday(SECOND_AGENT_ID) === spentBefore &&
      injectionApproval !== undefined &&
      injectionApproval.status === 'pending',
    `a vendor response told the agent to buy from ${merchantSet.unapprovedVendorId} for ${formatUsd(750)}. The payment never settled and is flagged for the owner: ${injectionApproval?.riskExplanation ?? ''}`,
  );

  // Extra checks: replay, expiry, unauthorized caller.
  const replayQuote = quoteFor('vendor_data_api', 'market_dataset');
  const firstTry = await submit(replayQuote, CALLER_ID, SECOND_AGENT_ID);
  const secondTry = await submit(replayQuote, CALLER_ID, SECOND_AGENT_ID);
  check(
    'Extra, replayed quote blocked',
    firstTry.outcome === 'settled' && secondTry.outcome === 'blocked' && secondTry.code === 'QUOTE_REPLAYED',
    'the same signed quote cannot be paid twice.',
  );

  const expiredQuote = quoteFor('vendor_data_api', 'weather_feed', -1000);
  const expired = await submit(expiredQuote, CALLER_ID, SECOND_AGENT_ID);
  check(
    'Extra, expired quote blocked',
    expired.outcome === 'blocked' && expired.code === 'QUOTE_EXPIRED',
    'a quote that has expired cannot be paid.',
  );

  const stranger = await submit(quoteFor('vendor_data_api', 'weather_feed'), 'mallory', SECOND_AGENT_ID);
  check(
    'Extra, unauthorized caller blocked',
    stranger.outcome === 'blocked' && stranger.code === 'CALLER_NOT_AUTHORIZED',
    'a caller the owner never authorized cannot act for the agent.',
  );

  const blockedCount = engine.receipts.blockedAttempts().length;
  const settledTotal = engine.spentToday(AGENT_ID) + engine.spentToday(SECOND_AGENT_ID);
  console.log(
    `\nTotals: settled today ${formatUsd(settledTotal)}, blocked attempts recorded ${blockedCount}, approvals pending ${engine.approvals.list('pending').length}.`,
  );
  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll demo checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
