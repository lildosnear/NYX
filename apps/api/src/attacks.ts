import { randomUUID } from 'node:crypto';
import type { Decision, PaymentRequest, Quote } from '@nyx_meta/core';
import { attemptInjectedPurchase } from '@nyx_meta/agent';
import { DEFAULT_AGENT_ID, DEFAULT_CALLER_ID, type NyxSystem } from './system.js';

export type AttackKind =
  | 'over_cap'
  | 'unapproved_vendor'
  | 'prompt_injection'
  | 'replayed_quote'
  | 'expired_quote'
  | 'unauthorized_caller';

export interface AttackInfo {
  kind: AttackKind;
  title: string;
  story: string;
  expected: string;
}

export type LandedIn = 'blocked' | 'approvals' | 'settled' | 'none';

export interface AttackResult {
  info: AttackInfo;
  decision: Decision;
  /** The legitimate first step of an attack that needs one, such as the first use of a replayed quote. */
  setupDecision: Decision | null;
  landedIn: LandedIn;
  landedText: string;
}

/**
 * The attack lab.
 *
 * Every scenario here fires a real attempt at the real policy engine, with
 * real signed quotes, so the owner can watch enforcement happen instead of
 * reading about it. Two scenarios end in the approvals queue, because the
 * vendor list and the per payment cap are owner rules: breaking them holds
 * the payment for the owner rather than blocking it outright. The rest are
 * hard blocks and land in Blocked attempts. Either way, no money moves.
 */
export const ATTACKS: AttackInfo[] = [
  {
    kind: 'over_cap',
    title: 'The agent tries to overspend',
    story:
      'The agent tries to buy a deep research report for $9.00. The owner set a cap of $5.00 per payment.',
    expected: 'Nyx holds the payment for the owner. No money moves.',
  },
  {
    kind: 'unapproved_vendor',
    title: 'The agent tries a vendor the owner never approved',
    story:
      'The agent tries to buy a premium leads list for $7.50 from Shadow Leads Broker, a vendor that is not on the approved list.',
    expected: 'Nyx holds the payment for the owner. No money moves.',
  },
  {
    kind: 'prompt_injection',
    title: 'A vendor tries to talk the agent into a purchase',
    story:
      'A vendor response hides an instruction that tells the agent to ignore the owner rules and buy the premium leads list at once, without asking.',
    expected: 'The instruction changes nothing. Nyx holds the payment for the owner, because enforcement lives in the engine, not in the model.',
  },
  {
    kind: 'replayed_quote',
    title: 'The same quote is paid twice',
    story:
      'A weather feed quote settles once, the honest way. Then the exact same signed quote is sent in again under a new request, hoping for a second charge.',
    expected: 'Nyx blocks the second attempt. A quote can only be paid once.',
  },
  {
    kind: 'expired_quote',
    title: 'An expired quote is presented',
    story:
      'A quote for a market data set is signed correctly, but its expiry time has already passed when it reaches Nyx.',
    expected: 'Nyx blocks the payment. An expired quote is worth nothing.',
  },
  {
    kind: 'unauthorized_caller',
    title: 'A stranger tries to act for the agent',
    story:
      'A caller named mallory, who the owner never authorized, submits a valid quote and asks Nyx to charge the agent for an icon pack.',
    expected: 'Nyx blocks the payment. Only authorized callers can act for the agent.',
  },
];

const ATTACK_BY_KIND = new Map(ATTACKS.map((a) => [a.kind, a]));

export function isAttackKind(value: string): value is AttackKind {
  return ATTACK_BY_KIND.has(value as AttackKind);
}

function landedFor(decision: Decision): { landedIn: LandedIn; landedText: string } {
  if (decision.outcome === 'approval_required') {
    return {
      landedIn: 'approvals',
      landedText: 'Held for the owner. Find it in the Approvals queue. No money moved.',
    };
  }
  if (decision.outcome === 'blocked') {
    return {
      landedIn: 'blocked',
      landedText: 'Blocked outright. Find it in Payments, under Blocked attempts. No money moved.',
    };
  }
  if (decision.outcome === 'settled') {
    return {
      landedIn: 'settled',
      landedText: 'This payment settled. For an attack, that should never happen.',
    };
  }
  return {
    landedIn: 'none',
    landedText: 'The payment failed at execution. Find it in Payments. No money moved.',
  };
}

function makeRequest(system: NyxSystem, quote: Quote, callerId: string, purpose: string): PaymentRequest {
  return {
    requestId: `req_${randomUUID()}`,
    agentId: DEFAULT_AGENT_ID,
    callerId,
    quote,
    idempotencyKey: `idem_${randomUUID()}`,
    purpose,
  };
}

function quoteFor(system: NyxSystem, vendorId: string, resource: string, ttlMs?: number): Quote {
  const merchant = system.merchants.get(vendorId);
  if (!merchant) throw new Error(`unknown vendor ${vendorId}`);
  return merchant.getQuote(resource, { ttlMs });
}

export async function runAttack(system: NyxSystem, kind: AttackKind): Promise<AttackResult> {
  const info = ATTACK_BY_KIND.get(kind);
  if (!info) throw new Error(`unknown attack ${kind}`);
  const { engine } = system;
  let decision: Decision;
  let setupDecision: Decision | null = null;

  switch (kind) {
    case 'over_cap': {
      const quote = quoteFor(system, 'vendor_research_api', 'deep_report');
      decision = await engine.submitPayment(
        makeRequest(system, quote, DEFAULT_CALLER_ID, 'Attack lab: buy a report above the per payment cap'),
      );
      break;
    }
    case 'unapproved_vendor': {
      const quote = quoteFor(system, system.unapprovedVendorId, 'premium_leads');
      decision = await engine.submitPayment(
        makeRequest(system, quote, DEFAULT_CALLER_ID, 'Attack lab: buy from a vendor the owner never approved'),
      );
      break;
    }
    case 'prompt_injection': {
      decision = await attemptInjectedPurchase({
        engine,
        merchants: system.merchants,
        unapprovedVendorId: system.unapprovedVendorId,
        agentId: DEFAULT_AGENT_ID,
        callerId: DEFAULT_CALLER_ID,
      });
      break;
    }
    case 'replayed_quote': {
      const quote = quoteFor(system, 'vendor_data_api', 'weather_feed');
      setupDecision = await engine.submitPayment(
        makeRequest(system, quote, DEFAULT_CALLER_ID, 'Attack lab setup: the honest first use of this quote'),
      );
      decision = await engine.submitPayment(
        makeRequest(system, quote, DEFAULT_CALLER_ID, 'Attack lab: the same signed quote sent in a second time'),
      );
      break;
    }
    case 'expired_quote': {
      const quote = quoteFor(system, 'vendor_data_api', 'market_dataset', -1000);
      decision = await engine.submitPayment(
        makeRequest(system, quote, DEFAULT_CALLER_ID, 'Attack lab: pay with a quote that has already expired'),
      );
      break;
    }
    case 'unauthorized_caller': {
      const quote = quoteFor(system, 'vendor_design_tool', 'icon_pack');
      decision = await engine.submitPayment(
        makeRequest(system, quote, 'mallory', 'Attack lab: a stranger tries to spend for the agent'),
      );
      break;
    }
  }

  const landed = landedFor(decision);
  return { info, decision, setupDecision, landedIn: landed.landedIn, landedText: landed.landedText };
}
