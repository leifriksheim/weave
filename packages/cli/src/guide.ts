/**
 * The flows a person follows once, walked through at a terminal: which model
 * an agent thinks with, a rule, a standard collection. Each is also a set of
 * flags, so an agent or a script gets there without being asked anything
 * (`ask.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFINE, roleHolds, type P2PNode } from '@weaveprotocol/core';
import {
  SCHEDULES,
  checkCron,
  profile,
  rule,
  ruleRun,
  standardDefinition,
} from '@weaveprotocol/core/schemas';
import * as ask from './ask.js';
import { pickCollection, pickSpace } from './complete.js';
import { commaList, errorCode, isRecord } from './json.js';

// ─── Which model an agent thinks with ─────────────────────────────────

/** What `weave agent` was told to think with: flags, the environment, or what setup kept */
export interface ModelSetting {
  readonly provider: 'anthropic' | 'openai';
  readonly model: string;
  readonly baseUrl?: string;
  /** Dollars per million tokens, as `--price` takes it */
  readonly price?: string;
}

/** Where to start from, for the servers people use most. Prices are what each lists, and change. */
const PRESETS: ReadonlyArray<
  { readonly id: string; readonly label: string; readonly hint: string } & Partial<ModelSetting>
> = [
  {
    id: 'anthropic',
    label: 'Claude, from Anthropic',
    hint: 'the default; best with tools',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'cheap, open weights, hosted in China',
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    price: '0.66/1.98',
  },
  {
    id: 'kimi',
    label: 'Kimi, from Moonshot',
    hint: 'open weights',
    provider: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
    price: '3/15/0.3',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'its newest models ask for ID verification',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'one key for many models',
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'ollama',
    label: 'A model on this machine, with Ollama',
    hint: 'nothing leaves your machine',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3',
    price: '0/0',
  },
  {
    id: 'other',
    label: 'Another server that speaks Chat Completions',
    hint: 'its address',
    provider: 'openai',
  },
];

const settingFile = (home: string) => path.join(home, 'agent', 'model.json');

/** What setup kept, or null before it ran */
export async function loadModelSetting(home: string): Promise<ModelSetting | null> {
  try {
    const stored: unknown = JSON.parse(await readFile(settingFile(home), 'utf8'));
    if (!isRecord(stored) || (stored.provider !== 'anthropic' && stored.provider !== 'openai')) return null;
    if (typeof stored.model !== 'string' || !stored.model) return null;
    return {
      provider: stored.provider,
      model: stored.model,
      ...(typeof stored.baseUrl === 'string' ? { baseUrl: stored.baseUrl } : {}),
      ...(typeof stored.price === 'string' ? { price: stored.price } : {}),
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Asks which model to think with, and keeps the answer for next time, in the
 * agent's folder. Only at a terminal; `--provider`, `--model`, `--base-url`
 * and `--price` say the same without asking.
 * @param knowsPrice Whether `weave agent` knows a model's price itself
 */
export async function setUpModel(
  home: string,
  knowsPrice: (model: string) => boolean,
): Promise<ModelSetting> {
  ask.intro('Which model should your agent think with?');
  const id = await ask.select({
    flag: 'provider',
    message: 'Where does it run?',
    options: PRESETS.map(({ id, label, hint }) => ({ value: id, label, hint })),
  });
  const chosen = PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
  const baseUrl =
    chosen.baseUrl ??
    (chosen.provider === 'openai'
      ? await ask.text({ flag: 'base-url', message: 'Its address, up to /v1', placeholder: 'https://…/v1' })
      : undefined);
  const model = await ask.text({
    flag: 'model',
    message: 'Which model?',
    ...(chosen.model ? { initialValue: chosen.model } : { placeholder: 'the name the server gives it' }),
  });
  const price =
    chosen.provider === 'anthropic' && knowsPrice(model)
      ? undefined
      : await ask.text({
          flag: 'price',
          message: 'What does it cost? Dollars per million tokens: in/out, or in/out/cached',
          ...(chosen.price && model === chosen.model
            ? { initialValue: chosen.price }
            : { placeholder: '0.15/0.60' }),
          validate: (value) =>
            /^\d+(\.\d+)?\/\d+(\.\d+)?(\/\d+(\.\d+)?)?$/.test(value) ? undefined : 'Like 0.15/0.60',
        });
  const setting: ModelSetting = {
    provider: chosen.provider ?? 'anthropic',
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(price ? { price } : {}),
  };
  await writeFile(settingFile(home), `${JSON.stringify(setting, null, 2)}\n`, { mode: 0o600 });
  ask.note(
    `Kept in ${settingFile(home)}.\n\`weave agent --setup\` asks again; flags such as --model win over it.`,
    'Saved',
  );
  return setting;
}

// ─── A watch ──────────────────────────────────────────────────────────

/** What sets a watch off, for the common cases a person would pick */
const CONDITIONS: Record<
  string,
  { readonly label: string; readonly field: string; readonly where: Record<string, unknown> }
> = {
  mentions: { label: 'One that mentions me', field: 'mentions', where: { mentions: { $contains: '$me' } } },
  assignees: { label: 'One given to me', field: 'assignees', where: { assignees: { $contains: '$me' } } },
  replyingTo: { label: 'One replying to me', field: 'replyingTo', where: { replyingTo: '$me' } },
  respondingTo: {
    label: 'One answering something of mine',
    field: 'respondingTo',
    where: { respondingTo: '$me' },
  },
};

export interface RuleFlags {
  readonly space?: string;
  readonly name?: string;
  readonly collection?: string;
  /** A condition in the query format, as JSON */
  readonly where?: string;
  readonly every?: string;
  readonly do?: string;
  /** Roles whose records set it off, comma separated; `member` is anyone with a role */
  readonly from?: string;
  /** The bot that runs it, by DID; `me`, or left out with no bot here, is the account's own agent */
  readonly by?: string;
}

const readJson = (text: string, flag: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`--${flag} must be JSON, like {"status": "done"}`);
  }
  if (!isRecord(value)) throw new Error(`--${flag} must be a JSON object`);
  return value;
};

/**
 * Adds a `std.rule` to a space that asks an agent: what the account's own
 * agent, or a bot there, does when some records appear or change, or at set
 * times. Defines `std.rule` first when the space lacks it and this account may
 * add collections.
 */
export async function addRule(node: P2PNode, flags: RuleFlags): Promise<unknown> {
  ask.intro('A new rule');
  const space = flags.space ?? (await pickSpace(node, 'Which space is it for?'));
  const collections = await node.collections.list(space);
  for (const definition of [rule, ruleRun]) {
    if (collections.some((c) => c.name === definition.name && c.version !== null)) continue;
    if (!roleHolds((await node.spaces.access(space)).role, DEFINE))
      throw new Error(
        'This space has no rules yet, and you may not add collections to it. Ask someone who can, or `weave collections define --standard std.rule`.',
      );
    await node.collections.define(space, definition);
  }
  const name =
    flags.name ??
    (await ask.text({ flag: 'name', message: 'What is it called?', placeholder: 'Answer when mentioned' }));

  const kind =
    flags.collection || flags.where
      ? 'records'
      : flags.every
        ? 'time'
        : await ask.select({
            flag: 'collection',
            message: 'What sets it off?',
            hint: 'Or --every for a schedule.',
            options: [
              {
                value: 'records',
                label: 'Records appearing or changing',
                hint: 'a message, a task, anything',
              },
              { value: 'time', label: 'The time', hint: 'a schedule' },
            ],
          });

  let query: Record<string, unknown> | undefined;
  let from: string[] | undefined;
  if (kind === 'records') {
    const collection = flags.collection ?? (await pickCollection(node, space));
    let where = flags.where ? readJson(flags.where, 'where') : undefined;
    if (!where && !flags.collection) {
      const properties: unknown = collections.find((c) => c.name === collection)?.schema?.properties;
      const fields = isRecord(properties) ? Object.keys(properties) : [];
      const custom = '\u0000custom';
      const picked = await ask.select({
        flag: 'where',
        message: 'Which of them?',
        options: [
          { value: 'any', label: 'Any of them' },
          ...Object.entries(CONDITIONS)
            .filter(([, condition]) => fields.includes(condition.field))
            .map(([value, condition]) => ({
              value,
              label: condition.label,
              hint: '"me" is whoever runs it',
            })),
          { value: custom, label: 'A condition of my own', hint: 'the query format, as JSON' },
        ],
      });
      where =
        picked === custom
          ? readJson(
              await ask.text({ flag: 'where', message: 'The condition', placeholder: '{"status": "done"}' }),
              'where',
            )
          : picked === 'any'
            ? undefined
            : CONDITIONS[picked]?.where;
      const roles = (await node.spaces.access(space)).roles;
      const by = await ask.select({
        flag: 'from',
        message: 'Written by whom?',
        options: [
          { value: 'anyone', label: 'Anyone' },
          { value: 'member', label: 'Anyone with a role here', hint: 'not someone who can only read' },
          ...roles.map((role) => ({ value: role.name, label: `Only ${role.title ?? role.name}s` })),
        ],
      });
      from = by === 'anyone' ? undefined : [by];
    }
    query = { collection, ...(where ? { where } : {}) };
  }
  if (flags.from) from = commaList(flags.from);

  let every: string | undefined;
  if (kind === 'time') {
    const custom = '\u0000custom';
    const picked =
      flags.every ??
      (await ask.select({
        flag: 'every',
        message: 'When?',
        options: [
          ...SCHEDULES.map(({ value, label }) => ({ value, label, hint: value })),
          { value: custom, label: 'Other', hint: 'five cron fields' },
        ],
      }));
    every =
      picked === custom
        ? await ask.text({
            flag: 'every',
            message: 'Minute hour day month weekday',
            placeholder: '30 7 * * 1-5',
            validate: (value) => checkCron(value) ?? undefined,
          })
        : picked;
    const problem = checkCron(every);
    if (problem) throw new Error(`--every: ${problem}`);
  }

  const what =
    flags.do ??
    (await ask.text({
      flag: 'do',
      message: 'What should the agent do?',
      placeholder: 'Answer them briefly, in the same channel',
    }));
  const by = flags.by === 'me' ? undefined : (flags.by ?? (await pickRunner(node, space)));
  const body = {
    name,
    ...(query ? { when: { query, ...(from?.length ? { from } : {}) } } : {}),
    ...(every ? { every } : {}),
    then: { kind: 'ask', text: what },
    ...(by ? { by } : {}),
    since: new Date().toISOString(),
  };
  const written = await node.records.put(space, rule.name, body);
  ask.outro(
    `“${name}” is on. ${by ? 'The bot' : 'Your agent'} runs it while \`weave agent${by ? ' --bot' : ''}\` does.`,
  );
  return { key: written.key, space, ...body };
}

/** Who runs a rule: the account's own agent, or a bot that says so on its profile here */
async function pickRunner(node: P2PNode, space: string): Promise<string | undefined> {
  const bots = (await node.records.list(space, { collection: profile.name }).catch(() => [])).filter(
    (record) => isRecord(record.body) && record.body.bot === true && !!record.createdBy,
  );
  if (bots.length === 0) return undefined;
  const mine = '\u0000mine';
  const names = new Map((await node.spaces.profiles(space)).map((p) => [p.did, p.name]));
  const picked = await ask.select({
    flag: 'by',
    message: 'Who runs it?',
    options: [
      { value: mine, label: 'My own agent', hint: 'weave agent' },
      ...bots.map((record) => ({
        value: record.createdBy!,
        label: names.get(record.createdBy!) ?? record.createdBy!,
        hint: 'a bot here',
      })),
    ],
  });
  return picked === mine ? undefined : picked;
}

// ─── A standard collection ────────────────────────────────────────────

/** Defines one of the library's collections in a space, by its name alone */
export async function defineStandard(node: P2PNode, name: string, space?: string): Promise<unknown> {
  const definition = standardDefinition(name);
  if (!definition)
    throw new Error(`The library has no ${name}. \`weave collections standard\` lists what it has.`);
  const target = space ?? (await pickSpace(node, `Which space should get ${name}?`));
  return node.collections.define(target, definition);
}
