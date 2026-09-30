/**
 * Reminders by email before paid time runs out: the host's own business, not
 * the protocol's (spec/06-nodes-and-sessions.md, Planned: hosts).
 *
 * Time paid up front — a wallet, or a space's chip-in — doesn't renew by
 * itself, so someone who wants to be told gives an address in their home, or
 * in the app where a space chips in (`remind`).
 * Nothing is sent to it but a link to confirm it (double opt-in), so nobody
 * can sign someone else up. Once confirmed, it gets a reminder 14 and 3 days
 * before the time runs out and one when the grace period starts, each with a
 * link that stops them. An address is kept with its subscription and nothing
 * else, and dropped with it.
 *
 * Mail goes out through an HTTP API rather than SMTP: Resend's by default
 * (`WEAVE_MAIL_API_KEY`, `WEAVE_MAIL_FROM`), or any server that takes the same
 * JSON at `WEAVE_MAIL_URL`.
 */
import type { BlobStore, StorageAdapter, Subscription, SubscriptionState } from '@weaveprotocol/core';

/** Sends one plain-text mail */
export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

/** Resend's API, or one that takes the same JSON, when WEAVE_MAIL_API_KEY and WEAVE_MAIL_FROM are set */
export function mailerFromEnv(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Mailer | null {
  const key = env.WEAVE_MAIL_API_KEY?.trim();
  const from = env.WEAVE_MAIL_FROM?.trim();
  if (!key || !from) return null;
  const url = env.WEAVE_MAIL_URL?.trim() || 'https://api.resend.com/emails';
  return Object.freeze({
    async send(mail: { to: string; subject: string; text: string }) {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!response.ok) throw new Error(`The mail service answered ${response.status}`);
    },
  });
}

/** One address asked for reminders about one subscription */
interface Asked {
  readonly subscription: string;
  readonly email: string;
  readonly confirmed: boolean;
  /** Reminders sent, as `<which>:<paidUntil>`: sent again only once the date moves */
  readonly sent: ReadonlyArray<string>;
  /** Unix seconds */
  readonly at: number;
}

export interface Reminders {
  /** Keeps an address for a subscription, unconfirmed, and mails it a link to confirm */
  ask(subscription: string, email: string, origin: string): Promise<void>;
  /** Whether a subscription has reminders on, asked for and waiting, or none */
  state(subscription: string): Promise<'on' | 'waiting' | 'off'>;
  /** Confirms the address a token was mailed to; false for a token it doesn't know */
  confirm(token: string): Promise<boolean>;
  /** Forgets the address a token belongs to; false for a token it doesn't know */
  stop(token: string): Promise<boolean>;
  /** Sends what is due, for every subscription; drops addresses whose subscription is gone */
  send(
    subscriptions: ReadonlyArray<Subscription>,
    state: (subscription: Subscription) => SubscriptionState,
    origin: string,
  ): Promise<void>;
}

const PREFIX = 'remind:';
const BUCKET_PREFIX = 'host/reminders/';
const DAY = 24 * 3600;
/** How long an unconfirmed address is kept */
const CONFIRM_SECONDS = 2 * DAY;
/** At most this many addresses per subscription: a space's may have several, from whoever chipped in */
const MAX_PER_SUBSCRIPTION = 20;
/** Days before the time runs out that a reminder goes out */
const BEFORE = [14, 3] as const;

/** An address as a person types it, checked loosely: the confirmation mail is the real check */
export function isEmail(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    text.length <= 254 &&
    /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(text)
  );
}

const newToken = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function createReminders(options: {
  readonly store: StorageAdapter;
  readonly mailer: Mailer;
  /** The host's name, as mails sign off */
  readonly name: string;
  readonly mirror?: BlobStore | null;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): Reminders {
  const { store, mailer, name } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? (() => {});

  const read = async (token: string): Promise<Asked | null> => {
    const bytes = await store.get(`${PREFIX}${token}`);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only `write` below puts anything here
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Asked) : null;
  };
  const write = async (token: string, asked: Asked) => {
    const bytes = new TextEncoder().encode(JSON.stringify(asked));
    await store.put(`${PREFIX}${token}`, bytes);
    await options.mirror?.put(`${BUCKET_PREFIX}${token}.json`, bytes);
  };
  const forget = async (token: string) => {
    await store.delete(`${PREFIX}${token}`);
    await options.mirror?.delete(`${BUCKET_PREFIX}${token}.json`);
  };
  const all = async (): Promise<Array<[string, Asked]>> => {
    const found: Array<[string, Asked]> = [];
    for (const key of await store.list(PREFIX)) {
      const token = key.slice(PREFIX.length);
      const asked = await read(token);
      if (asked) found.push([token, asked]);
    }
    return found;
  };
  const whose = (subscription: string) =>
    subscription.startsWith('space:') ? 'the space you chipped in for' : 'your spaces';
  const stopLine = (origin: string, token: string) =>
    `To get no more of these: ${origin}/host/remind/stop?t=${token}`;

  return Object.freeze({
    async ask(subscription: string, email: string, origin: string) {
      const mine = (await all()).filter(([, asked]) => asked.subscription === subscription);
      for (const [token, asked] of mine) if (asked.email === email) await forget(token);
      if (mine.length >= MAX_PER_SUBSCRIPTION) throw new Error('This has as many addresses as it can take');
      const token = newToken();
      await write(token, { subscription, email, confirmed: false, sent: [], at: now() });
      await mailer.send({
        to: email,
        subject: `Confirm reminders from ${name}`,
        text: [
          `Someone asked ${name} to remind this address before the time paid for ${whose(subscription)} runs out.`,
          '',
          `To say yes: ${origin}/host/remind/confirm?t=${token}`,
          '',
          'If that wasn’t you, ignore this mail: nothing more is sent.',
        ].join('\n'),
      });
    },

    async state(subscription: string) {
      const mine = (await all()).filter(([, asked]) => asked.subscription === subscription);
      if (mine.some(([, asked]) => asked.confirmed)) return 'on';
      return mine.length ? 'waiting' : 'off';
    },

    async confirm(token: string) {
      if (!TOKEN.test(token)) return false;
      const asked = await read(token);
      if (!asked) return false;
      if (!asked.confirmed) await write(token, { ...asked, confirmed: true });
      return true;
    },

    async stop(token: string) {
      if (!TOKEN.test(token) || !(await read(token))) return false;
      await forget(token);
      return true;
    },

    async send(
      subscriptions: ReadonlyArray<Subscription>,
      state: (subscription: Subscription) => SubscriptionState,
      origin: string,
    ) {
      const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
      const at = now();
      for (const [token, asked] of await all()) {
        const subscription = byId.get(asked.subscription);
        if (!subscription || (!asked.confirmed && at - asked.at > CONFIRM_SECONDS)) {
          await forget(token);
          continue;
        }
        // A card renews by itself, and time never paid has nothing to run out.
        if (!asked.confirmed || subscription.customer !== undefined || subscription.paidUntil === 0) continue;
        const until = subscription.paidUntil;
        const days = (until - at) / DAY;
        const due =
          state(subscription) === 'grace'
            ? 'grace'
            : (BEFORE.filter((before) => days <= before && days > 0)
                .at(-1)
                ?.toString() ?? null);
        if (due === null || asked.sent.includes(`${due}:${until}`)) continue;
        const date = new Date(until * 1000).toUTCString().slice(0, 16);
        const text =
          due === 'grace'
            ? `The time paid for ${whose(asked.subscription)} at ${name} ran out on ${date}. It is kept for a while longer; pay again to keep it online.`
            : `The time paid for ${whose(asked.subscription)} at ${name} runs out on ${date}, in ${Math.ceil(days)} days. Pay again to keep it online.`;
        try {
          await mailer.send({
            to: asked.email,
            subject: due === 'grace' ? `Your time at ${name} ran out` : `Your time at ${name} runs out soon`,
            text: [
              text,
              '',
              `Pay from your Weave home, or from the space in the app you use it with.`,
              '',
              stopLine(origin, token),
            ].join('\n'),
          });
          // Only this reminder, for this date: the ones before it for the same date are behind it.
          await write(token, {
            ...asked,
            sent: [...asked.sent.filter((s) => s.endsWith(`:${until}`)), `${due}:${until}`],
          });
        } catch (error) {
          log(`a reminder could not be sent: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  });
}
