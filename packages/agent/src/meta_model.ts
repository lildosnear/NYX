import { formatUsd } from '@nyx_meta/core';
import type { ModelAdapter, PlannedPurchase, RiskExplanationInput } from './model.js';
import { MockModelAdapter, buildRiskExplanation } from './mock_model.js';

export const DEFAULT_META_MODEL_ID = 'muse-spark-1.3';
export const DEFAULT_META_BASE_URL = 'https://api.meta.ai/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The only vendor and resource pairs the model may plan. It mirrors what
 * the merchants package sells. Anything the model returns outside this
 * catalog is dropped before it can reach a merchant.
 */
export const VENDOR_CATALOG: Readonly<Record<string, readonly string[]>> = {
  vendor_data_api: ['market_dataset', 'weather_feed'],
  vendor_research_api: ['research_brief', 'deep_report'],
  vendor_design_tool: ['icon_pack', 'brand_kit'],
};

/** Error from the Meta Model API call. Never carries the API key. */
export class MetaModelError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MetaModelError';
    this.status = status;
  }
}

export interface MetaModelAdapterConfig {
  /** Meta Model API key. Required, supplied by the caller from the environment. */
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * Removes dash characters from model text and tidies the spacing the
 * replacement leaves behind. The owner facing copy in Nyx uses no dashes.
 */
export function cleanModelText(text: string): string {
  return text
    .replace(/[—–]/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

export function parsePlan(content: string): PlannedPurchase[] {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const plan: PlannedPurchase[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const vendorId = item.vendorId;
    const resource = item.resource;
    if (typeof vendorId !== 'string' || typeof resource !== 'string') continue;
    const allowed = VENDOR_CATALOG[vendorId];
    if (!allowed || !allowed.includes(resource)) continue;
    plan.push({
      vendorId,
      resource,
      reason:
        typeof item.reason === 'string' && item.reason.length > 0
          ? item.reason
          : 'Planned by the model for this task.',
    });
    if (plan.length >= 5) break;
  }
  return plan;
}

/**
 * The Meta Model API adapter. It talks to the OpenAI compatible chat
 * completions endpoint with the standard tier model. Planning and risk
 * explanation are its only jobs: it never decides a payment, and if the
 * API is unreachable or answers badly it quietly falls back to the
 * deterministic mock adapter so the agent still works.
 */
export class MetaModelAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fallback = new MockModelAdapter();

  constructor(config: MetaModelAdapterConfig) {
    if (!config.apiKey) throw new MetaModelError('MetaModelAdapter requires an apiKey');
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_META_BASE_URL).replace(/\/+$/, '');
    this.modelId = config.model ?? DEFAULT_META_MODEL_ID;
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async planTask(task: string): Promise<PlannedPurchase[]> {
    try {
      const content = await this.chat([
        {
          role: 'system',
          content:
            'You are the planning model for Nyx, a payment control layer for AI agents. ' +
            'You choose purchases for a task. You may only choose from this catalog, using the exact vendorId and resource values: ' +
            'vendor_data_api sells market_dataset and weather_feed. ' +
            'vendor_research_api sells research_brief and deep_report. ' +
            'vendor_design_tool sells icon_pack and brand_kit. ' +
            'Reply with a JSON array and nothing else. Each item must be an object with vendorId, resource and reason. ' +
            'Choose only what the task genuinely needs, at most three purchases. ' +
            'If the task needs none of these, reply with an empty JSON array.',
        },
        { role: 'user', content: `Task: ${task}` },
      ]);
      const plan = parsePlan(content);
      if (plan.length === 0) return this.fallback.planTask(task);
      return plan;
    } catch {
      return this.fallback.planTask(task);
    }
  }

  async explainRisk(input: RiskExplanationInput): Promise<string> {
    try {
      const rule =
        input.code === 'CAP_EXCEEDED'
          ? 'the amount is above the per payment cap'
          : input.code === 'VENDOR_NOT_APPROVED'
            ? 'the vendor is not on the approved vendor list'
            : `the payment hit the rule ${input.code}`;
      const content = await this.chat([
        {
          role: 'system',
          content:
            'You explain payment risk for Nyx, a payment control layer for AI agents. ' +
            'Write two or three short sentences in plain English. ' +
            'State the amount and the rule the payment hit. ' +
            'Say that no money has moved and that the owner must approve or deny the payment. ' +
            'Do not use any dash characters in your reply.',
        },
        {
          role: 'user',
          content:
            `Vendor: ${input.vendorId}. Resource: ${input.resource}. ` +
            `Amount: ${formatUsd(input.amountCents)}. Rule hit: ${rule}. ` +
            `Per payment cap: ${formatUsd(input.perPaymentCapCents)}. ` +
            `Approved vendors: ${input.approvedVendors.join(', ')}.`,
        },
      ]);
      const cleaned = cleanModelText(content);
      if (cleaned.length === 0) return buildRiskExplanation(input);
      return cleaned;
    } catch {
      return buildRiskExplanation(input);
    }
  }

  /** One chat completions call. Throws MetaModelError on any failure. */
  private async chat(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: this.modelId, messages, temperature: 0.2 }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new MetaModelError(
          `Meta Model API request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        throw new MetaModelError(
          `Meta Model API returned HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
          res.status,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new MetaModelError('Meta Model API returned a non JSON response', res.status);
      }
      const choices = isRecord(parsed) ? parsed.choices : undefined;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message = isRecord(first) ? first.message : undefined;
      const content = isRecord(message) ? message.content : undefined;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new MetaModelError('Meta Model API returned an empty completion', res.status);
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ModelAdapterEnv {
  MODEL_API_KEY?: string | undefined;
  META_BASE_URL?: string | undefined;
  MODEL_API_BASE_URL?: string | undefined;
  META_MODEL_ID?: string | undefined;
  MODEL_API_MODEL?: string | undefined;
}

/**
 * Picks the model adapter for the current environment: the Meta adapter
 * when MODEL_API_KEY is set, the deterministic mock adapter otherwise.
 * META_BASE_URL or MODEL_API_BASE_URL can point the adapter at a local
 * connector proxy during development. The default stays with Meta.
 */
export function createModelAdapter(env: ModelAdapterEnv): ModelAdapter {
  const apiKey = env.MODEL_API_KEY?.trim();
  if (!apiKey) return new MockModelAdapter();
  const baseUrl = env.META_BASE_URL?.trim() || env.MODEL_API_BASE_URL?.trim() || undefined;
  const model = env.META_MODEL_ID?.trim() || env.MODEL_API_MODEL?.trim() || undefined;
  return new MetaModelAdapter({ apiKey, baseUrl, model });
}
