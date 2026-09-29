/**
 * Other providers: the loop against a server that speaks OpenAI's Chat
 * Completions — requests translated there, answers back, and a real run over
 * HTTP with a real node.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { fromChatResponse, openAIThink, toChatRequest } from '../src/agent-openai.js';
import { createAgentChat, parsePrice, replyCost, type Spend } from '../src/agent-chat.js';
import { createNode } from '../../core/src/node/node.js';
import type { P2PNode } from '../../core/src/node/types.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { isRecord } from '../src/json.js';

const nodes: P2PNode[] = [];
const closers: Array<() => void> = [];
after(async () => {
  for (const close of closers) close();
  await Promise.all(nodes.map((node) => node.close()));
});

describe('Chat Completions', () => {
  test('a request becomes a chat: system first, tools as functions, each tool answer straight after its call', () => {
    const request = toChatRequest({
      model: 'deepseek-v4-pro',
      max_tokens: 1000,
      system: 'Be brief.',
      tools: [
        {
          name: 'spaces_list',
          description: 'Lists spaces',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      messages: [
        { role: 'user', content: 'What spaces do I have?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'call_1', name: 'spaces_list', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: '[{"name":"Club"}]' },
            { type: 'text', text: 'And be quick.' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'nope', is_error: true }],
        },
      ],
    });
    assert.deepEqual(request, {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'What spaces do I have?' },
        {
          role: 'assistant',
          content: 'Looking.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'spaces_list', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '[{"name":"Club"}]' },
        { role: 'user', content: 'And be quick.' },
        { role: 'tool', tool_call_id: 'call_2', content: 'Error: nope' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'spaces_list',
            description: 'Lists spaces',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });
  });

  test('an answer becomes a reply: tool calls, why it stopped, and what it cost, cached tokens apart', () => {
    const reply = fromChatResponse(
      {
        model: 'kimi-k3',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'On it.',
              tool_calls: [
                { id: 'a', type: 'function', function: { name: 'records_put', arguments: '{"space":"s"}' } },
                { id: 'b', type: 'function', function: { name: 'records_put', arguments: '{not json' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
      },
      'kimi-k3',
    );
    assert.equal(reply.stop_reason, 'tool_use', 'a call means tool_use, whatever the server says');
    assert.deepEqual(reply.content, [
      { type: 'text', text: 'On it.', citations: null },
      { type: 'tool_use', id: 'a', name: 'records_put', input: { space: 's' } },
      { type: 'tool_use', id: 'b', name: 'records_put', input: { unreadable: '{not json' } },
    ]);
    assert.deepEqual(reply.usage, {
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
    });
    const price = parsePrice('3/15/0.3');
    assert.ok(price);
    assert.equal(replyCost(reply, 'kimi-k3', price), (200 * 3 + 50 * 15 + 800 * 0.3) / 1_000_000);

    assert.equal(
      fromChatResponse({ choices: [{ finish_reason: 'length', message: {} }] }, 'x').stop_reason,
      'max_tokens',
    );
    assert.throws(() => fromChatResponse({ error: { message: 'Bad key' } }, 'x'), /Bad key/);
  });

  test('a price is dollars per million tokens: in/out, and cached when it costs less', () => {
    assert.deepEqual(parsePrice('0.15/0.60'), {
      input: 0.15,
      output: 0.6,
      cacheWrite: 0.15,
      cacheRead: 0.15,
    });
    assert.deepEqual(parsePrice('0/0'), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    assert.equal(parsePrice('cheap'), null);
    assert.equal(parsePrice('1/-2'), null);
  });

  test('the loop runs against a Chat Completions server: it calls a tool, reads the answer, and pays by --price', async () => {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(new Uint8Array(16).fill(71));
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores: memoryStores(),
      watchIntervalMs: 0,
    });
    nodes.push(node);
    const space = await node.spaces.create({ name: 'Club', visibility: 'public' });

    const seen: Array<{ auth: string | undefined; body: unknown }> = [];
    const answers = [
      {
        model: 'local-model',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'records_put',
                    arguments: JSON.stringify({
                      space: space.id,
                      collection: 'app.club.idea',
                      body: { idea: 'polls' },
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      },
      {
        model: 'local-model',
        choices: [{ finish_reason: 'stop', message: { content: 'Added it.' } }],
        usage: { prompt_tokens: 0, completion_tokens: 1_000_000 },
      },
    ];
    const read = async (request: IncomingMessage) => {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      return text;
    };
    const server = createServer((request, response) => {
      void read(request).then((text) => {
        seen.push({ auth: request.headers.authorization, body: JSON.parse(text) });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(answers.shift() ?? { error: { message: 'no more' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const { port } = server.address() as AddressInfo; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- listen() on a port gives an AddressInfo

    let spent = 0;
    const spend: Spend = { today: async () => spent, add: async (usd) => void (spent += usd) };
    const written: string[] = [];
    const chat = createAgentChat({
      node,
      think: openAIThink({
        baseUrl: `http://127.0.0.1:${port}/v1/`,
        apiKey: 'sk-test',
        write: (t) => written.push(t),
      }),
      model: 'local-model',
      price: { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 },
      plain: true,
      spend,
      dailyCap: 10,
      confirm: async () => false,
      log: () => {},
    });

    const turn = await chat.say('Add polls as an idea in Club');
    assert.equal(turn.tools, 1);
    assert.equal(turn.text, 'Added it.');
    assert.deepEqual(written, ['Added it.']);
    assert.equal(turn.cost, 1 + 2, 'a million tokens in at $1, a million out at $2');

    const ideas = await node.records.list(space.id, { collection: 'app.club.idea' });
    assert.deepEqual(
      ideas.map((r) => (isRecord(r.body) ? r.body.idea : null)),
      ['polls'],
    );
    assert.equal(seen[0]?.auth, 'Bearer sk-test');
    const second = seen[1]?.body;
    assert.ok(isRecord(second) && Array.isArray(second.messages));
    const last: unknown = second.messages.at(-1);
    assert.ok(isRecord(last) && last.role === 'tool' && last.tool_call_id === 'call_1');
    assert.ok(isRecord(seen[0]?.body) && !('thinking' in seen[0].body), 'nothing only Anthropic has');
  });
});
