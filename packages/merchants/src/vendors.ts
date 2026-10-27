import { QuoteSigner, type Quote } from '@nyx_meta/core';

export interface VendorResource {
  resource: string;
  label: string;
  priceCents: number;
}

export interface VendorInfo {
  id: string;
  name: string;
  description: string;
  resources: VendorResource[];
}

/**
 * A mock vendor. It sells resources at fixed prices and issues signed,
 * expiring quotes for them. It never takes a payment itself: the agent
 * submits the quote to Nyx, and Nyx decides.
 */
export class Merchant {
  constructor(
    readonly info: VendorInfo,
    private readonly signer: QuoteSigner,
  ) {}

  getQuote(
    resource: string,
    opts: { ttlMs?: number; now?: Date } = {},
  ): Quote {
    const item = this.info.resources.find((r) => r.resource === resource);
    if (!item) {
      throw new Error(`vendor ${this.info.id} does not sell resource ${resource}`);
    }
    return this.signer.issue({
      vendorId: this.info.id,
      resource: item.resource,
      amountCents: item.priceCents,
      ttlMs: opts.ttlMs,
      now: opts.now,
    });
  }
}

export interface MerchantSet {
  merchants: Map<string, Merchant>;
  signers: Map<string, QuoteSigner>;
  approvedVendorIds: string[];
  unapprovedVendorId: string;
}

/**
 * The demo vendor set. Three vendors the owner approves, and one the owner
 * does not, for the blocked scenes. Signing secrets are demo values that
 * live in this file on purpose, so the whole demo runs from a clean clone.
 */
export function createMerchants(): MerchantSet {
  const definitions: Array<{ info: VendorInfo; secret: string; approved: boolean }> = [
    {
      approved: true,
      secret: 'demo_secret_for_data_api',
      info: {
        id: 'vendor_data_api',
        name: 'Northwind Data API',
        description: 'Paid data sets and feeds for research tasks.',
        resources: [
          { resource: 'market_dataset', label: 'Market data set', priceCents: 240 },
          { resource: 'weather_feed', label: 'Weather data feed', priceCents: 120 },
        ],
      },
    },
    {
      approved: true,
      secret: 'demo_secret_for_research_api',
      info: {
        id: 'vendor_research_api',
        name: 'Bright Research API',
        description: 'Paid research briefs and reports.',
        resources: [
          { resource: 'research_brief', label: 'Research brief', priceCents: 480 },
          { resource: 'deep_report', label: 'Deep research report', priceCents: 900 },
        ],
      },
    },
    {
      approved: true,
      secret: 'demo_secret_for_design_tool',
      info: {
        id: 'vendor_design_tool',
        name: 'Canvas Design Tool',
        description: 'Paid design assets.',
        resources: [
          { resource: 'icon_pack', label: 'Icon pack', priceCents: 300 },
          { resource: 'brand_kit', label: 'Brand kit', priceCents: 450 },
        ],
      },
    },
    {
      approved: false,
      secret: 'demo_secret_for_shadow_leads',
      info: {
        id: 'vendor_shadow_leads',
        name: 'Shadow Leads Broker',
        description: 'A data broker the owner has never approved.',
        resources: [
          { resource: 'premium_leads', label: 'Premium leads list', priceCents: 750 },
        ],
      },
    },
  ];

  const merchants = new Map<string, Merchant>();
  const signers = new Map<string, QuoteSigner>();
  const approvedVendorIds: string[] = [];
  let unapprovedVendorId = '';
  for (const def of definitions) {
    const signer = new QuoteSigner(def.secret);
    signers.set(def.info.id, signer);
    merchants.set(def.info.id, new Merchant(def.info, signer));
    if (def.approved) approvedVendorIds.push(def.info.id);
    else unapprovedVendorId = def.info.id;
  }
  return { merchants, signers, approvedVendorIds, unapprovedVendorId };
}
