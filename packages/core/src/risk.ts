import { formatUsd } from './money.js';
import type { DecisionCode, PaymentRequest, Policy } from './types.js';

export interface RiskInfo {
  code: DecisionCode;
  request: PaymentRequest;
  policy: Policy;
}

/**
 * Plain language risk explanation for the approvals queue.
 *
 * The model layer can replace this explanation with a richer one written
 * by Muse Spark. The explanation never decides anything. It only helps
 * the owner decide. The payment decision always stays in the policy engine.
 */
export function buildRiskExplanation(info: RiskInfo): string {
  const parts: string[] = [];
  const amount = formatUsd(info.request.quote.amountCents);
  if (info.code === 'CAP_EXCEEDED') {
    parts.push(
      `The amount ${amount} is above the per payment cap of ${formatUsd(info.policy.perPaymentCapCents)} that the owner set for this agent.`,
    );
  }
  if (info.code === 'VENDOR_NOT_APPROVED') {
    parts.push(
      `The vendor ${info.request.quote.vendorId} is not on the approved vendor list for this agent.`,
    );
  }
  parts.push(
    `The agent wants to pay for ${info.request.quote.resource}. No money has moved. This payment is waiting for the owner to approve or deny it.`,
  );
  return parts.join(' ');
}
