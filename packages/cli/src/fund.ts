/**
 * A community's fund at the host (spec/06-nodes-and-sessions.md, Hosts: a space paying for itself).
 *
 * One balance per space's own subscription, in millionths of a dollar (the
 * same unit as USDC's six decimals). Anyone adds to it, by card or wallet,
 * once or every month. Keeping the space online draws from it by the second,
 * at the host's monthly rate, and each bot it runs draws its AI use as it is
 * spent. What the fund lasts is an estimate from that: the rate, and what its
 * bots spent over the last week. The host's status says the balance, the
 * daily spend, and the date the estimate reaches (`paidUntil`).
 *
 * Kept in the host's store, and in its bucket when it has one, as the
 * subscriptions are: a fund is money people paid.
 */
import type { BlobStore, StorageAdapter } from '@weaveprotocol/core';
import { isRecord } from './json.js';

export interface FundState {
  /** Millionths of a dollar; below zero only by what a bot spent in its last call */
  readonly balance: number;
  /** When the hosting fee was last taken, unix seconds */
  readonly at: number;
  /** What bots spent, by UTC day (`2026-09-30`), for the last two weeks */
  readonly spent: Readonly<Record<string, number>>;
  /** The same, for each bot by its DID: what the fund shows people it pays for */
  readonly byBot?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface Funds {
  get(id: string): Promise<FundState>;
  /** Adds what someone paid */
  add(id: string, micros: number): Promise<FundState>;
  /** Takes what a bot spent; with its DID, counted as that bot's too */
  charge(id: string, micros: number, bot?: string): Promise<FundState>;
  /** Takes the hosting fee for the time since it was last taken */
  settle(id: string): Promise<FundState>;
  /** What the fund spends in a day, as things go: the hosting fee, and what its bots spent a day this last week */
  daily(state: FundState): number;
  /** Until when it lasts at that rate, unix seconds; when it ran out, for an empty fund */
  until(state: FundState): number;
  /** What one bot spent a day this last week */
  botDaily(state: FundState, bot: string): number;
}

const PREFIX = 'fund:';
const BUCKET_PREFIX = 'host/funds/';
const DAY = 86_400;
const MONTH = 30 * DAY;

export function createFunds(options: {
  readonly store: StorageAdapter;
  /** What keeping one space online costs a month, in millionths of a dollar */
  readonly monthly: number;
  readonly mirror?: BlobStore | null;
  readonly now?: () => number;
}): Funds {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fee = options.monthly / MONTH;
  const empty = (): FundState => ({ balance: 0, at: now(), spent: {} });

  const read = async (id: string): Promise<FundState> => {
    const bytes =
      (await options.store.get(`${PREFIX}${id}`)) ??
      (await options.mirror?.get(`${BUCKET_PREFIX}${encodeURIComponent(id)}.json`));
    if (!bytes) return empty();
    const kept: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(kept) || typeof kept.balance !== 'number' || typeof kept.at !== 'number') return empty();
    const days = (value: unknown): Record<string, number> => {
      const found: Record<string, number> = {};
      if (isRecord(value))
        for (const [day, micros] of Object.entries(value))
          if (typeof micros === 'number') found[day] = micros;
      return found;
    };
    const byBot: Record<string, Record<string, number>> = {};
    if (isRecord(kept.byBot)) for (const [bot, spent] of Object.entries(kept.byBot)) byBot[bot] = days(spent);
    return { balance: kept.balance, at: kept.at, spent: days(kept.spent), byBot };
  };
  const write = async (id: string, state: FundState): Promise<FundState> => {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    await options.store.put(`${PREFIX}${id}`, bytes);
    await options.mirror?.put(`${BUCKET_PREFIX}${encodeURIComponent(id)}.json`, bytes);
    return state;
  };
  /** The fee for the time since it was last taken, taken; nothing is owed below zero */
  const settled = (state: FundState): FundState => {
    const at = now();
    const owed = Math.max(0, at - state.at) * fee;
    return { ...state, balance: state.balance > 0 ? Math.max(0, state.balance - owed) : state.balance, at };
  };
  const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
  /** What a record of spending by day adds up to this last week, a day */
  const week = (spent: Readonly<Record<string, number>>) =>
    Object.entries(spent)
      .filter(([when]) => now() - Date.parse(when) / 1000 < 7 * DAY)
      .reduce((sum, [, micros]) => sum + micros, 0) / 7;
  const daily = (state: FundState) => fee * DAY + week(state.spent);
  /** Two weeks of spending is all the estimate needs */
  const recent = (spent: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(spent).filter(([when]) => now() - Date.parse(when) / 1000 < 14 * DAY));

  // One change at a time: two payments landing together must both count.
  let queue: Promise<unknown> = Promise.resolve();
  const change = (id: string, work: (state: FundState) => FundState): Promise<FundState> => {
    const next = queue.then(async () => write(id, work(settled(await read(id)))));
    queue = next.catch(() => {});
    return next;
  };

  return Object.freeze({
    get: read,
    add: (id: string, micros: number) =>
      change(id, (state) => ({ ...state, balance: Math.max(0, state.balance) + Math.round(micros) })),
    charge: (id: string, micros: number, bot?: string) =>
      change(id, (state) => {
        const today = day(now());
        const cost = Math.round(micros);
        const kept = recent(state.spent);
        const byBot = { ...state.byBot };
        if (bot) {
          const its = recent(byBot[bot] ?? {});
          byBot[bot] = { ...its, [today]: (its[today] ?? 0) + cost };
        }
        return {
          ...state,
          balance: state.balance - cost,
          spent: { ...kept, [today]: (kept[today] ?? 0) + cost },
          byBot,
        };
      }),
    settle: (id: string) => change(id, (state) => state),
    daily,
    botDaily: (state: FundState, bot: string) => week(state.byBot?.[bot] ?? {}),
    until(state: FundState) {
      const rate = daily(state);
      if (state.balance <= 0 || rate <= 0) return state.balance > 0 ? now() + 10 * 365 * DAY : state.at;
      return now() + Math.floor((state.balance / rate) * DAY);
    },
  });
}
