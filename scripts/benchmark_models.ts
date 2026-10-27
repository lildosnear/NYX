import {
  MetaModelAdapter,
  MockModelAdapter,
  createSecondModelAdapter,
  type ModelAdapter,
  type RiskExplanationInput,
} from '@nyx_meta/agent';

/**
 * Compares every configured model on the same two jobs Nyx gives a model:
 * planning the purchases for one task, and explaining one held payment.
 * Muse Spark runs when MODEL_API_KEY is set. The second model runs when
 * SECOND_MODEL_PROVIDER, SECOND_MODEL_API_KEY and SECOND_MODEL_ID are set,
 * with SECOND_MODEL_BASE_URL required for Modal. The mock always runs, so
 * the script works with no keys at all. Nothing here can move money.
 */

const SAMPLE_TASK =
  'Research the market for AI agent payment tools and write a short brief for the owner.';

const SAMPLE_RISK: RiskExplanationInput = {
  vendorId: 'vendor_research_api',
  resource: 'deep_report',
  amountCents: 900,
  code: 'CAP_EXCEEDED',
  perPaymentCapCents: 500,
  approvedVendors: ['vendor_data_api', 'vendor_research_api', 'vendor_design_tool'],
};

interface Entry {
  label: string;
  adapter: ModelAdapter;
}

async function main(): Promise<void> {
  const entries: Entry[] = [];
  const metaKey = process.env.MODEL_API_KEY?.trim();
  if (metaKey) {
    const baseUrl = process.env.META_BASE_URL?.trim() || undefined;
    entries.push({
      label: 'meta, muse spark 1.3',
      adapter: new MetaModelAdapter({ apiKey: metaKey, baseUrl }),
    });
  }
  const second = createSecondModelAdapter(process.env);
  if (second) {
    entries.push({ label: `second, ${second.providerName}, ${second.modelId}`, adapter: second });
  }
  entries.push({ label: 'mock, deterministic', adapter: new MockModelAdapter() });

  for (const entry of entries) {
    const planStart = Date.now();
    const plan = await entry.adapter.planTask(SAMPLE_TASK);
    const planMs = Date.now() - planStart;
    const riskStart = Date.now();
    const risk = await entry.adapter.explainRisk(SAMPLE_RISK);
    const riskMs = Date.now() - riskStart;
    console.log(`\n${entry.label}`);
    console.log(`  plan, ${planMs} ms, ${plan.length} purchase(s): ${plan.map((p) => `${p.vendorId}/${p.resource}`).join(', ') || 'none'}`);
    console.log(`  risk, ${riskMs} ms: ${risk}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
