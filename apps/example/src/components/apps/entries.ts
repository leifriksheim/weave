import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { supersededApps, type App, type AppNotify } from '@weaveprotocol/core/schemas';
import { hash } from '@weave/app-shared/hash';
import { APPS, readiness, type WeaveApp } from './index';
import { isAdded, useMadeApps } from './MadeApps';
import type { IconName } from '../Icon';
import { isObject } from '../../derive/schema-ui';

/**
 * An app a space can open, whichever kind: written as code here, or made for
 * the space and kept in it as a `std.app` record. The sidebar, the launcher,
 * what counts as new and what can be notified about all read this one list.
 */
export interface AppEntry {
  /** A built-in app's id, or `made:<record key>` */
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly icon: IconName;
  readonly hue: number;
  readonly notify: ReadonlyArray<AppNotify>;
  readonly builtIn?: WeaveApp;
  readonly made?: NodeRecord<App>;
}

/**
 * What a made app notifies about: what it says, or else new records in the
 * first collection it needs — usually the thing it is about.
 */
export function madeNotify(body: App): ReadonlyArray<AppNotify> {
  if (body.notify) return body.notify;
  const first = body.needs[0];
  return first ? [{ label: `New in ${body.title}`, collection: first.name }] : [];
}

/** An entry about records that name the person — "Mentions me", "A seat on my trip" */
export const isForMe = (notify: AppNotify): boolean => !!notify.topic && 'me' in notify.topic;

/** Whether a record is one of an app's "…me" entries is about: its topic field holds the person */
export function namesMe(
  notify: ReadonlyArray<AppNotify>,
  collection: string,
  body: unknown,
  did: string,
): boolean {
  return notify.some((entry) => {
    if (!isForMe(entry) || entry.collection !== collection || !entry.topic) return false;
    const value = isObject(body) ? body[entry.topic.field] : undefined;
    return Array.isArray(value) ? value.includes(did) : value === did;
  });
}

const builtInEntry = (app: WeaveApp): AppEntry => ({
  id: app.id,
  title: app.title,
  description: app.description,
  icon: app.icon,
  hue: app.hue,
  notify: app.notify,
  builtIn: app,
});

const madeEntry = (record: NodeRecord<App>): AppEntry => ({
  id: `made:${record.key}`,
  title: record.body!.title,
  description: record.body!.description,
  icon: 'sparkle',
  hue: hash(record.key) % 360,
  notify: madeNotify(record.body!),
  made: record,
});

/** Whether an app takes the whole window: a conversation, or a screen of its own */
export function fills(entry: AppEntry, collections: ReadonlyArray<NodeCollection>): boolean {
  if (entry.builtIn) return entry.builtIn.fill === true;
  const names = entry.made?.body?.needs.map((need) => need.name) ?? [];
  return names.some((name) => collections.find((c) => c.name === name)?.screen);
}

/** A space's apps: the ones ready to open, the built-in ones it could add, and proposals waiting */
export function useSpaceApps(space: SpaceSummary, collections: ReadonlyArray<NodeCollection>) {
  const made = useMadeApps(space);
  // A version a newer one replaced would only undo it: neither open nor offered.
  const superseded = supersededApps(made, collections);
  const current = made.filter((record) => !superseded.has(record.key));
  const ready: ReadonlyArray<AppEntry> = [
    ...current.filter((record) => isAdded(record, collections)).map(madeEntry),
    ...APPS.filter((app) => readiness(app, collections).ready).map(builtInEntry),
  ];
  return {
    ready,
    addable: APPS.filter((app) => !readiness(app, collections).ready),
    proposed: current.filter((record) => !isAdded(record, collections)),
    made,
  };
}
