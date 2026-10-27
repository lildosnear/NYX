import { formatUsd } from '@nyx_meta/core';
import type { ModelAdapter, PlannedPurchase, RiskExplanationInput } from './model.js';

/** Plain language risk text, shared by the mock adapter and the engine wiring. */
export function buildRiskExplanation(input: RiskExplanationInput): string {
  const parts: string[] = [];
  const amount = formatUsd(input.amountCents);
  if (input.code === 'CAP_EXCEEDED') {
    parts.push(
      `The amount ${amount} is above the per payment cap of ${formatUsd(input.perPaymentCapCents)} that the owner set for this agent.`,
    );
  }
  if (input.code === 'VENDOR_NOT_APPROVED') {
    parts.push(`The vendor ${input.vendorId} is not on the approved vendor list for this agent.`);
  }
  parts.push(
    `The agent wants to pay for ${input.resource}. No money has moved. This payment is waiting for the owner to approve or deny it.`,
  );
  return parts.join(' ');
}

/**
 * Deterministic fallback for the model adapter.
 *
 * Rule based purchase planning and template risk explanations. It runs
 * whenever no Meta Model API key is present, and the Meta adapter also
 * falls back to it whenever an API call fails, so the agent, the engine,
 * the dashboard and the tests all keep working either way.
 */
export class MockModelAdapter implements ModelAdapter {
  async planTask(task: string): Promise<PlannedPurchase[]> {
    const text = task.toLowerCase();
    const plan: PlannedPurchase[] = [];
    if (text.includes('weather')) {
      plan.push({
        vendorId: 'vendor_data_api',
        resource: 'weather_feed',
        reason: 'The task mentions weather, so the agent needs the weather data feed.',
      });
    }
    if (text.includes('market') || text.includes('data')) {
      plan.push({
        vendorId: 'vendor_data_api',
        resource: 'market_dataset',
        reason: 'The task needs market data, so the agent buys the market data set.',
      });
    }
    if (text.includes('deep')) {
      plan.push({
        vendorId: 'vendor_research_api',
        resource: 'deep_report',
        reason: 'The task asks for depth, so the agent wants the deep research report.',
      });
    } else if (text.includes('research') || text.includes('brief') || text.includes('report')) {
      plan.push({
        vendorId: 'vendor_research_api',
        resource: 'research_brief',
        reason: 'The task needs research, so the agent buys a research brief.',
      });
    }
    if (text.includes('design') || text.includes('icon') || text.includes('brand')) {
      plan.push({
        vendorId: 'vendor_design_tool',
        resource: 'icon_pack',
        reason: 'The task needs design assets, so the agent buys an icon pack.',
      });
    }
    if (plan.length === 0) {
      plan.push({
        vendorId: 'vendor_data_api',
        resource: 'market_dataset',
        reason: 'The default first step for a research task is a market data set.',
      });
    }
    return plan;
  }

  async explainRisk(input: RiskExplanationInput): Promise<string> {
    return buildRiskExplanation(input);
  }
}
