import { formatUsd } from '@nyx_meta/core';
import type { ModelAdapter, PlannedPurchase, RiskExplanationInput } from './model.js';
import { MockModelAdapter, buildRiskExplanation } from './mock_model.js';
import { cleanModelText, parsePlan } from './meta_model.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Known second provider shapes. Fireworks and Baseten both expose an OpenAI
 * compatible chat completions route, so a preset only needs the base URL.
 * Modal serves each deployment at its own endpoint URL, so Modal always
 * needs SECOND_MODEL_BASE_URL from the environment. Every provider needs a
 * model id from the environment, because providers retire model ids and the
 * owner should pick the one their credit actually covers.
 */
export const SECOND_MODEL_PRESETS: Readonly<Record<string, { baseUrl?: string }>> = {
  fireworks: { baseUrl: 'https://api.fireworks.ai/inference/v1' },
  baseten: { baseUrl: 'https://inference.baseten.co/v1' },
  modal: {},
};

export interface SecondModelInfo {
  configured: boolean;
  provider: string | null;
  model: string | null;
}

export interface OpenAiCompatibleAdapterConfig {
  /** Short provider label, such as fireworks, baseten or modal. */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
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
 * A second model behind the same ModelAdapter seam. It exists so Nyx can run
 * an open weights model from Fireworks, Baseten or a Modal endpoint beside
 * Muse Spark, for comparison runs and as a stand in if the primary route is
 * down. It follows the same rules as the Meta adapter: it plans and explains,
 * it never decides a payment, and any failure falls back to the deterministic
 * mock adapter. It is never wired into the policy engine decision path.
 */
export class OpenAiCompatibleModelAdapter implements ModelAdapter {
  readonly providerName: string;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fallback = new MockModelAdapter();

  constructor(config: OpenAiCompatibleAdapterConfig) {
    if (!config.apiKey) throw new Error('OpenAiCompatibleModelAdapter requires an apiKey');
    if (!config.baseUrl) throw new Error('OpenAiCompatibleModelAdapter requires a baseUrl');
    if (!config.model) throw new Error('OpenAiCompatibleModelAdapter requires a model');
    this.providerName = config.provider;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelId = config.model;
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
        throw new Error(
          `Second model request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Second model returned HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error('Second model returned a non JSON response');
      }
      const choices = isRecord(parsed) ? parsed.choices : undefined;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message = isRecord(first) ? first.message : undefined;
      const content = isRecord(message) ? message.content : undefined;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('Second model returned an empty completion');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SecondModelEnv {
  SECOND_MODEL_PROVIDER?: string | undefined;
  SECOND_MODEL_API_KEY?: string | undefined;
  SECOND_MODEL_BASE_URL?: string | undefined;
  SECOND_MODEL_ID?: string | undefined;
}

/**
 * Builds the second model adapter from the environment, or returns null when
 * the provider, key, base URL or model id is missing. A null result is a
 * normal state, not an error: Nyx simply runs with Muse Spark alone.
 */
export function createSecondModelAdapter(env: SecondModelEnv): OpenAiCompatibleModelAdapter | null {
  const provider = env.SECOND_MODEL_PROVIDER?.trim().toLowerCase();
  const apiKey = env.SECOND_MODEL_API_KEY?.trim();
  const model = env.SECOND_MODEL_ID?.trim();
  if (!provider || !apiKey || !model) return null;
  const preset = SECOND_MODEL_PRESETS[provider];
  const baseUrl = env.SECOND_MODEL_BASE_URL?.trim() || preset?.baseUrl;
  if (!baseUrl) return null;
  return new OpenAiCompatibleModelAdapter({ provider, apiKey, baseUrl, model });
}

/** Describes the second model setup without exposing any key. */
export function secondModelInfo(env: SecondModelEnv): SecondModelInfo {
  const adapter = createSecondModelAdapter(env);
  if (!adapter) {
    return { configured: false, provider: env.SECOND_MODEL_PROVIDER?.trim().toLowerCase() || null, model: null };
  }
  return { configured: true, provider: adapter.providerName, model: adapter.modelId };
}
