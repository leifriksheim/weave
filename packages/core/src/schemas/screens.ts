/**
 * @module schemas/screens
 * Screens: an app's own UI, kept on a collection definition and run sealed.
 *
 * A definition may carry a `screen` — one HTML document, scripts and styles
 * inline. An app that wants to show it runs it in a frame that has no network,
 * no storage and no way to reach the page around it, and hands it one thing:
 * a message port to a {@link createScreenBridge bridge}. Through that port the
 * screen reads and writes the records of the collections its app named, in
 * one space, as whoever is looking — so every rule still holds, and a screen
 * can do nothing its viewer couldn't.
 *
 * Inside the frame, the screen finds `window.weave` (see {@link SCREEN_GUIDE}).
 * The port is handed over once, when the document is written; a frame that
 * navigates somewhere else leaves it behind, so a page it navigates to hears
 * nothing.
 */
import type { NodeRecord, P2PNode } from '../node/types.js';
import type { Link } from '../types.js';

/** What a screen sees of a record */
export interface ScreenRecord {
  readonly key: string;
  /** The same as `key` — what a screen written by guessing tends to reach for */
  readonly id: string;
  readonly collection: string;
  readonly body: unknown;
  /** The same as `body` */
  readonly data: unknown;
  readonly links: ReadonlyArray<Link>;
  /** The account that created it */
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Whether the person looking created it */
  readonly mine: boolean;
  /** Written by an agent for `createdBy`'s account */
  readonly viaAgent: boolean;
}

/** Who is looking */
export interface ScreenViewer {
  readonly did: string;
  readonly name: string;
}

/** How to write a screen — for an agent, in `apps_screen_guide`, and for people */
export const SCREEN_GUIDE = `A screen is one HTML document (scripts and styles inline, at most 48 KB) put on a collection definition as "screen".
When the app is added, apps in the space can show it instead of plain lists. It runs sealed: no network (no fetch, no
images from URLs, no fonts from URLs), no storage, no popups, no forms that submit. Keep state in records, never in the page.

Inside it, window.weave is:
  weave.me                          { did, name } — who is looking
  weave.collections                 the collection names this screen may use (its app's)
  await weave.list(collection, { where? })   records, oldest first: { key, collection, body, links, createdBy, createdAt, updatedAt, mine, viaAgent }
                                    where: { "link:<rel>": "<record key>" } for records linking there, { field: value } for a field's value
  await weave.get(key)              one record, or null
  await weave.put(collection, body, { links?, key? })   → the record written, as the person looking
  await weave.update(key, body, { links? })             → the next version
  await weave.remove(key)
  await weave.people()              [{ did, name }] — everyone in the space who said their name
  weave.onChange(callback)          called whenever records in the space change, here or on another device; returns a function to stop

Calls may also take one object instead: weave.list({ collection, where }), weave.put({ collection, body, links, key }),
weave.update({ key, body, links }), weave.remove({ key }). Records answer to id / data as well as key / body.
Every write is checked against the collection's rules, as the person looking: a refused write rejects with the reason.
An error the screen doesn't catch is shown to the person, so they can tell you about it.
Links look like { rel: "game", to: "<record key>" }, with the roles the definition declares.
Draw everything from weave.list(...) and redraw on weave.onChange — other people's moves arrive that way.
Two people can write at once: design collections so that clashes resolve by the rules (onePer, creator-only edits), not by the screen.
Use plain DOM; no libraries can be loaded. Prefer system fonts and simple, readable styling that works in light and dark.`;

/** The script put in front of a screen's document: `window.weave`, over the port the host page kept for it */
export const SCREEN_CLIENT = `(() => {
  const given = window.__weave;
  delete window.__weave;
  if (!given) return;
  const port = given.port;
  const pending = new Map();
  const listeners = new Set();
  let next = 0;
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, method, args });
    });
  port.onmessage = (event) => {
    const message = event.data || {};
    if (message.change) {
      for (const listener of listeners) {
        try { listener(); } catch (error) { console.error(error); }
      }
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error));
  };
  // Shown to the person, so a screen that fails says why instead of sitting blank.
  const report = (message) => {
    let bar = document.getElementById('__weave-error');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__weave-error';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 10px;border-radius:8px;background:#fff0f0;color:#b00020;border:1px solid #f3c2c2;font:12px/1.4 system-ui,sans-serif;white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(bar);
    }
    bar.textContent = 'This screen hit an error: ' + message;
  };
  addEventListener('error', (event) => report(event.message || String(event.error)));
  addEventListener('unhandledrejection', (event) => report(event.reason && event.reason.message ? event.reason.message : String(event.reason)));
  // weave.me is who is looking; calling it — weave.me() — gives the same.
  // (defineProperty, because a function's own "name" can't be assigned)
  const me = () => ({ did: given.me.did, name: given.me.name });
  Object.defineProperty(me, 'did', { value: given.me.did, enumerable: true });
  Object.defineProperty(me, 'name', { value: given.me.name, enumerable: true });
  window.weave = Object.freeze({
    me: Object.freeze(me),
    collections: Object.freeze(given.collections.slice()),
    list: (collection) => call('list', collection),
    get: (key) => call('get', key),
    put: (collection, body, options) => call('put', collection, body, options || {}),
    update: (key, body, options) => call('update', key, body, options || {}),
    remove: (key) => call('remove', key),
    people: () => call('people'),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
})();`;

/** The document a host page writes into its frame: the client, then the screen */
export function screenDocument(screen: string): string {
  // Before anything the screen says, so `weave` is there when its scripts run.
  return `<script>${SCREEN_CLIENT}</script>\n${screen}`;
}

const toScreen = (record: NodeRecord, viewer: string): ScreenRecord => ({
  key: record.key,
  id: record.key,
  collection: record.collection,
  body: record.body,
  data: record.body,
  links: record.links,
  createdBy: record.createdBy,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  mine: record.createdBy === viewer,
  viaAgent: record.viaAgent === true,
});

/** Only plain data crosses into a screen, and only this much of it */
function plain(value: unknown, what: string): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length > 256 * 1024) throw new Error(`${what} is too large`);
  return JSON.parse(text);
}

function linksOf(options: unknown): { links?: ReadonlyArray<Link> } {
  const links = (options as { links?: unknown } | null)?.links;
  if (links === undefined) return {};
  if (!Array.isArray(links) || !links.every((l) => typeof l?.rel === 'string' && typeof l?.to === 'string')) {
    throw new Error('links must be a list of { rel, to }');
  }
  return { links: links.map((l) => ({ rel: l.rel, to: l.to })) };
}

export interface ScreenBridge {
  /** Tell the screen that records changed */
  changed(): void;
  /** Stop answering, and stop listening to the node */
  close(): void;
}

/**
 * Answers a screen's calls over `port`, for one space and these collections,
 * as the node's account. Every write goes through the node like any other,
 * so the collection's rules decide.
 */
export function createScreenBridge(params: {
  readonly node: P2PNode;
  readonly spaceId: string;
  readonly collections: ReadonlyArray<string>;
  readonly port: MessagePort;
}): ScreenBridge {
  const { node, spaceId, port } = params;
  const allowed = new Set(params.collections);
  let closed = false;

  const names = [...allowed].map((name) => `"${name}"`).join(', ');
  const collectionOf = (name: unknown) => {
    if (typeof name !== 'string') throw new Error(`Name the collection as text, like weave.list("${[...allowed][0] ?? 'app.example.thing'}"). This screen may use ${names}.`);
    if (!allowed.has(name)) throw new Error(`This screen can't use "${name}". It may use ${names}.`);
    return name;
  };
  const ownRecord = async (key: unknown) => {
    if (typeof key !== 'string') throw new Error('Name the record by its key, as text: weave.update(record.key, body)');
    const record = await node.records.get(spaceId, key);
    if (!record || !allowed.has(record.collection)) throw new Error(`No record ${key} this screen can use`);
    return record;
  };

  /** `f(a, b)` or `f({ a, b })`: a screen written by guessing may use either */
  const spread = <K extends string>(args: unknown[], keys: ReadonlyArray<K>): Record<K, unknown> => {
    const first = args[0];
    if (first && typeof first === 'object' && !Array.isArray(first) && keys.some((k) => k in first)) {
      return Object.fromEntries(keys.map((k) => [k, (first as Record<string, unknown>)[k]])) as Record<K, unknown>;
    }
    return Object.fromEntries(keys.map((k, i) => [k, args[i]])) as Record<K, unknown>;
  };
  /** `{ "link:game": key }` for records linking there, `{ field: value }` for a field's value */
  const matches = (record: NodeRecord, where: unknown) => {
    if (!where || typeof where !== 'object') return true;
    return Object.entries(where as Record<string, unknown>).every(([field, value]) =>
      field.startsWith('link:')
        ? record.links.some((link) => link.rel === field.slice(5) && link.to === value)
        : (record.body as Record<string, unknown> | null)?.[field] === value,
    );
  };

  const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    list: async (...args) => {
      const first = args[0] as { collection?: unknown; where?: unknown } | undefined;
      const { collection, where } =
        first && typeof first === 'object' ? { collection: first.collection, where: first.where } : { collection: first, where: (args[1] as { where?: unknown } | undefined)?.where };
      const records = await node.records.list(spaceId, { collection: collectionOf(collection) });
      return records.filter((record) => matches(record, where)).map((record) => toScreen(record, node.did));
    },
    get: async (...args) => {
      const { key } = spread(args, ['key']);
      try {
        return toScreen(await ownRecord(key), node.did);
      } catch {
        return null;
      }
    },
    put: async (...args) => {
      const first = args[0] as { collection?: unknown; body?: unknown; links?: unknown; key?: unknown } | undefined;
      const [collection, body, options] =
        first && typeof first === 'object' && 'collection' in first ? [first.collection, first.body, { links: first.links, key: first.key }] : args;
      const key = (options as { key?: unknown } | null)?.key;
      if (key !== undefined && typeof key !== 'string') throw new Error('key must be text');
      const record = await node.records.put(spaceId, collectionOf(collection), plain(body, 'The record'), {
        ...linksOf(options === null || typeof options !== 'object' || (options as { links?: unknown }).links === undefined ? {} : options),
        ...(key !== undefined ? { key } : {}),
      });
      return toScreen(record, node.did);
    },
    update: async (...args) => {
      const first = args[0] as { key?: unknown; body?: unknown; links?: unknown } | undefined;
      const [key, body, options] = first && typeof first === 'object' && 'key' in first ? [first.key, first.body, { links: first.links }] : args;
      const record = await ownRecord(key);
      const links = (options as { links?: unknown } | null)?.links === undefined ? {} : linksOf(options);
      return toScreen(await node.records.update(spaceId, record.key, plain(body, 'The record'), links), node.did);
    },
    remove: async (...args) => {
      const { key } = spread(args, ['key']);
      const record = await ownRecord(key);
      await node.records.delete(spaceId, record.key);
      return null;
    },
    people: async () => (await node.spaces.profiles(spaceId)).map((profile) => ({ did: profile.did, name: profile.name })),
  };

  port.onmessage = (event: MessageEvent) => {
    if (closed) return;
    const message = event.data as { id?: unknown; method?: unknown; args?: unknown } | null;
    if (typeof message?.id !== 'number' || typeof message.method !== 'string' || !Object.hasOwn(methods, message.method)) return;
    const args = Array.isArray(message.args) ? message.args : [];
    methods[message.method]!(...args).then(
      (value) => !closed && port.postMessage({ id: message.id, ok: true, value: plain(value, 'The answer') }),
      (error: unknown) => !closed && port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };

  // Changes arrive in bursts while syncing; one nudge per burst is enough.
  let soon: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (closed || soon) return;
    soon = setTimeout(() => {
      soon = null;
      if (!closed) port.postMessage({ change: true });
    }, 50);
  };
  const stop = node.subscribe((event) => {
    if (event.type === 'records' && event.space === spaceId) changed();
  });

  return {
    changed,
    close() {
      closed = true;
      if (soon) clearTimeout(soon);
      stop();
      port.close();
    },
  };
}
