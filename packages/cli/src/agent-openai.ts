/**
 * The model call for any server that speaks OpenAI's Chat Completions: OpenAI
 * itself, OpenRouter, DeepSeek, Moonshot (Kimi), Groq, Mistral, and servers
 * on your own machine (Ollama, llama.cpp, vLLM). Plain `fetch`, no SDK.
 *
 * The loop in `agent-chat.ts` keeps its conversation as the Messages API
 * does; this turns each request into a chat completion and the answer back
 * into a reply, so the loop, its tools, its confirmations and its cap are the
 * same whichever model answers. What only Anthropic has (thinking, effort,
 * cache control, fallbacks) is left out on the way.
 */
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolUnion,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Reply, Think } from './agent-chat.js';
import { isRecord } from './json.js';

/** A chat message as Chat Completions takes it */
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Text from a block list, or a string as it is */
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block: unknown) =>
            isRecord(block) && typeof block.text === 'string' ? [block.text] : [],
          )
          .join('\n')
      : '';

/** One message of the loop's conversation, as one or more chat messages */
function toChat(message: BetaMessageParam): ChatMessage[] {
  if (typeof message.content === 'string')
    return message.role === 'assistant'
      ? [{ role: 'assistant', content: message.content }]
      : [{ role: 'user', content: message.content }];
  if (message.role === 'assistant') {
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    const calls = message.content.flatMap((block) =>
      block.type === 'tool_use'
        ? [
            {
              id: block.id,
              type: 'function' as const,
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            },
          ]
        : [],
    );
    return [{ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  // A tool's answer is a message of its own, straight after the call; anything else the person said follows.
  const answers: ChatMessage[] = message.content.flatMap((block) =>
    block.type === 'tool_result'
      ? [
          {
            role: 'tool' as const,
            tool_call_id: block.tool_use_id,
            content: `${block.is_error ? 'Error: ' : ''}${textOf(block.content)}`,
          },
        ]
      : [],
  );
  const said = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
  return said ? [...answers, { role: 'user', content: said }] : answers;
}

/** The loop's request as a chat completion request */
export function toChatRequest(params: MessageCreateParamsBase): Record<string, unknown> {
  const system = textOf(params.system);
  const tools = (params.tools ?? []).flatMap((tool: BetaToolUnion) =>
    'input_schema' in tool && typeof tool.name === 'string'
      ? [
          {
            type: 'function',
            function: {
              name: tool.name,
              ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
              parameters: tool.input_schema,
            },
          },
        ]
      : [],
  );
  return {
    model: params.model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...params.messages.flatMap(toChat)],
    ...(tools.length ? { tools } : {}),
  };
}

const STOPS: Readonly<Record<string, Reply['stop_reason']>> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A chat completion as the loop's reply */
export function fromChatResponse(response: unknown, asked: string): Reply {
  if (!isRecord(response) || !Array.isArray(response.choices))
    throw new Error(
      isRecord(response) && isRecord(response.error) && typeof response.error.message === 'string'
        ? response.error.message
        : 'The model answered with something that is not a chat completion',
    );
  const choice: unknown = response.choices[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const content: BetaContentBlock[] = [];
  if (typeof message.content === 'string' && message.content)
    content.push({ type: 'text', text: message.content, citations: null });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') continue;
    let input: unknown = {};
    try {
      input = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : {};
    } catch {
      // Arguments that aren't JSON fail the action's own input check, which the model then reads.
      input = { unreadable: call.function.arguments };
    }
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : `call_${content.length}`,
      name: call.function.name,
      input,
    });
  }
  const reason = isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const usage = isRecord(response.usage) ? response.usage : {};
  const cached = isRecord(usage.prompt_tokens_details) ? count(usage.prompt_tokens_details.cached_tokens) : 0;
  return {
    model: typeof response.model === 'string' ? response.model : asked,
    // Some servers say "stop" even when they called a tool.
    stop_reason: content.some((block) => block.type === 'tool_use')
      ? 'tool_use'
      : (STOPS[reason] ?? 'end_turn'),
    content,
    usage: {
      input_tokens: Math.max(0, count(usage.prompt_tokens) - cached),
      output_tokens: count(usage.completion_tokens),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
    },
  };
}

/**
 * The model call at a Chat Completions server. `write` gets the text of each
 * answer once it is whole, for the terminal.
 */
export function openAIThink(options: {
  /** Up to `/v1`, like `https://api.openai.com/v1` or `http://localhost:11434/v1` */
  readonly baseUrl: string;
  /** Empty for a server on your own machine that asks for none */
  readonly apiKey: string;
  readonly write: (text: string) => void;
  readonly fetch?: typeof globalThis.fetch;
}): Think {
  const call = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (params) => {
    const response = await call(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(toChatRequest(params)),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.ok && !(isRecord(body) && isRecord(body.error)))
      throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
    const reply = fromChatResponse(body, params.model);
    const said = reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    if (said) options.write(said);
    return reply;
  };
}
