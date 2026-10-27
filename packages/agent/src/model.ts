/**
 * The model seam.
 *
 * The agent's model plans purchases and explains risk. It never decides a
 * payment: every planned purchase still goes through the policy engine.
 * The Meta model adapter (Muse Spark) implements this interface when a
 * MODEL_API_KEY is present. The deterministic mock adapter stands in when
 * it is not, so the whole system runs end to end either way.
 */

export interface PlannedPurchase {
  vendorId: string;
  resource: string;
  reason: string;
}

export interface RiskExplanationInput {
  vendorId: string;
  resource: string;
  amountCents: number;
  code: string;
  perPaymentCapCents: number;
  approvedVendors: string[];
}

export interface ModelAdapter {
  planTask(task: string): Promise<PlannedPurchase[]>;
  explainRisk(input: RiskExplanationInput): Promise<string>;
}
