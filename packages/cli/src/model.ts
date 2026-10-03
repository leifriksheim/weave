/**
 * Which model thinks, where, and at what price: from `weave agent`'s flags
 * and what setup kept, or from a host's environment for the bots it runs.
 */
import { parsePrice, priceOf, streamingThink, type Price, type Think } from './agent-chat.js';
import { openAIThink } from './agent-openai.js';

export interface ModelChoice {
  /** `anthropic`, or `openai` for any server that speaks Chat Completions */
  readonly provider: 'anthropic' | 'openai';
  readonly name: string;
  /** Another server than the provider's own: `http://localhost:11434/v1`, `https://api.deepseek.com` */
  readonly baseUrl?: string;
  readonly price: Price;
}

/** Whether an address is this machine: a model there asks for no key, and a free host there is safe. No address is. */
export function isLoopback(address?: string): boolean {
  if (!address) return true;
  let host = address;
  if (address.includes('://')) {
    try {
      host = new URL(address).hostname;
    } catch {
      return false;
    }
  }
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}

/**
 * Checks what was given and fills in the rest: Anthropic and `defaultModel`
 * unless told, and the price of a model known here.
 * @param names What the person gave each value as, to name in a refusal: `--model` or `WEAVE_BOT_MODEL`
 */
export function chooseModel(
  given: {
    readonly provider?: string;
    readonly model?: string;
    readonly baseUrl?: string;
    readonly price?: string;
  },
  defaultModel: string,
  names: { readonly provider: string; readonly model: string; readonly price: string },
): ModelChoice {
  const provider = given.provider?.trim() || 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai')
    throw new Error(
      `${names.provider} is anthropic, or openai for any server that speaks Chat Completions, not "${provider}"`,
    );
  const name = given.model?.trim() || (provider === 'anthropic' ? defaultModel : '');
  if (!name) throw new Error(`${names.provider} openai needs ${names.model}: gpt-5.5, deepseek-v4-pro, …`);
  const priceText = given.price?.trim();
  const price = priceText ? parsePrice(priceText) : priceOf(name);
  if (priceText && !price)
    throw new Error(
      `${names.price} is dollars per million tokens, input/output or input/output/cached, like 0.15/0.60, not "${priceText}"`,
    );
  if (!price)
    throw new Error(
      `No price is known for ${name}, so the daily cap can't be kept. Give ${names.price} in dollars per ` +
        'million tokens, like 0.15/0.60 (0/0 for a model on your machine).',
    );
  const baseUrl = given.baseUrl?.trim();
  return { provider, name, price, ...(baseUrl ? { baseUrl } : {}) };
}

/** Anthropic's own additions (thinking, effort, cache control, fallbacks) are asked only of Anthropic itself */
export const isPlain = (model: ModelChoice) => model.provider === 'openai' || !!model.baseUrl;

/**
 * How the model thinks, streaming its text to `write`. Anthropic's SDK is
 * loaded here, not at the top: it is most of the bundle.
 */
export async function thinker(
  model: ModelChoice,
  apiKey: string | null,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<(write: (text: string) => void) => Think> {
  if (model.provider === 'openai') {
    const baseUrl = model.baseUrl ?? 'https://api.openai.com/v1';
    return (write) => openAIThink({ baseUrl, apiKey: apiKey ?? '', write, fetch });
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
  });
  return (write) => streamingThink(client, write);
}
