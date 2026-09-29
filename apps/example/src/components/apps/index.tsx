import type { ComponentType } from 'react';
import type {
  DefineCollection,
  NodeCollection,
  NodeRecord,
  P2PNode,
  SpaceSummary,
} from '@weaveprotocol/core';
import {
  ballot,
  call,
  channel,
  column,
  decision,
  direct,
  message,
  poll,
  proposal,
  reaction,
  task,
  vote,
  positionBetween,
} from '@weaveprotocol/core/schemas';
import { CallHistory } from './CallHistory';
import { Chat } from './Chat';
import { Decisions } from './Decisions';
import { Kanban } from './Kanban';
import { Polls } from './Polls';
import type { AppNotify } from '@weaveprotocol/core/schemas';
import type { Glyph } from '../Icon';
import type { MiniApp } from '@weave/app-shared/mini-app';
import { liquid } from '@weave/liquid/app';

export interface AppProps {
  readonly space: SpaceSummary;
  readonly collections: ReadonlyArray<NodeCollection>;
  readonly onOpen: (record: NodeRecord) => void;
  /** When the person last looked at this app, so it can mark what arrived since (`seen.ts`) */
  readonly since?: string;
}

/**
 * An app is a screen that knows some standard schemas — nothing more. It is
 * code in this example, not something stored in the space: it shows up in a
 * space as soon as the space holds the collections it needs, whoever
 * added them and however. What it writes are ordinary records, so the
 * Data tab (or any other app that knows the same schemas) sees them too.
 */
export interface WeaveApp {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** How its tile looks: a glyph on a tint of this hue */
  readonly icon: Glyph;
  readonly hue: number;
  /** What in it is worth hearing about: offered as notifications, and counted as new */
  readonly notify: ReadonlyArray<AppNotify>;
  /** Takes the whole window when open, the way a conversation does */
  readonly fill?: boolean;
  /** Without these it cannot work: adding the app defines the missing ones */
  readonly needs: ReadonlyArray<DefineCollection>;
  /** Shown when the space has them, left out when it does not */
  readonly uses?: ReadonlyArray<DefineCollection>;
  /** Runs once, right after someone adds the app — a board's first columns */
  readonly setup?: (node: P2PNode, spaceId: string) => Promise<void>;
  readonly View: ComponentType<AppProps>;
}

/**
 * A mini app (`@weave/app-shared/mini-app`) as one of ours: the same code
 * that runs as its own site, in a space's frame here. It brings its own
 * stylesheet, put in the page the first time it is shown.
 */
function fromMiniApp(app: MiniApp): WeaveApp {
  const Space = app.Space;
  return {
    id: app.id,
    title: app.title,
    description: app.description,
    icon: { path: app.icon },
    hue: app.hue,
    notify: app.notify ?? [],
    needs: app.needs,
    ...(app.setup ? { setup: app.setup } : {}),
    View: ({ space }) => {
      app.injectStyles?.();
      return <Space space={space} />;
    },
  };
}

export const APPS: ReadonlyArray<WeaveApp> = [
  {
    id: 'chat',
    icon: 'chat',
    hue: 212,
    notify: [
      { label: 'Mentions me', collection: message.name, topic: { field: 'mentions', me: true } },
      { label: 'Replies to me', collection: message.name, topic: { field: 'replyingTo', me: true } },
      { label: 'Direct message to me', collection: direct.name, topic: { field: 'to', me: true } },
      { label: 'New message', collection: message.name },
      {
        label: 'Reactions to what I wrote',
        collection: reaction.name,
        topic: { field: 'respondingTo', me: true },
      },
    ],
    fill: true,
    title: 'Chat',
    description:
      'Talk with everyone in the space, in channels, or directly with one person: only the two of you can read it.',
    needs: [message],
    uses: [reaction, channel, direct],
    View: Chat,
  },
  {
    id: 'kanban',
    icon: 'board',
    hue: 28,
    notify: [
      { label: 'New task', collection: task.name },
      { label: 'Assigned to me', collection: task.name, topic: { field: 'assignees', me: true } },
    ],
    title: 'Kanban',
    description: 'Tasks on a board: drag them between columns, and into order.',
    needs: [task, column],
    setup: async (node, spaceId) => {
      if ((await node.records.list(spaceId, { collection: column.name })).length > 0) return;
      let position: string | null = null;
      for (const name of ['To do', 'Doing', 'Done']) {
        position = positionBetween(position);
        await node.records.put(spaceId, column.name, { name, position });
      }
    },
    View: Kanban,
  },
  {
    id: 'polls',
    icon: 'poll',
    hue: 268,
    notify: [
      { label: 'New poll', collection: poll.name },
      { label: 'Votes on my polls', collection: vote.name, topic: { field: 'respondingTo', me: true } },
    ],
    title: 'Polls',
    description: 'Ask the space a question. Everyone picks one option, and can change their mind.',
    needs: [poll, vote],
    View: Polls,
  },
  {
    id: 'decisions',
    icon: 'decide',
    hue: 118,
    notify: [
      { label: 'New proposal', collection: proposal.name },
      { label: 'Decided', collection: decision.name },
      {
        label: 'Ballots on my proposals',
        collection: ballot.name,
        topic: { field: 'respondingTo', me: true },
      },
    ],
    title: 'Decisions',
    description:
      'Put something to the space, and decide it once enough people agree. Every device checks the count.',
    needs: [proposal, ballot, decision],
    View: Decisions,
  },
  fromMiniApp(liquid),
  {
    id: 'calls',
    icon: 'phone',
    hue: 150,
    notify: [],
    title: 'Calls',
    description: 'Keeps a log of the calls in this space: who was in each, and calls nobody answered.',
    needs: [call],
    View: CallHistory,
  },
];

/** Which of an app's schemas a space already has, and which it lacks */
export function readiness(
  app: WeaveApp,
  collections: ReadonlyArray<NodeCollection>,
): { ready: boolean; missing: ReadonlyArray<DefineCollection> } {
  const defined = new Set(collections.filter((c) => c.version !== null).map((c) => c.name));
  const missing = app.needs.filter((s) => !defined.has(s.name));
  return { ready: missing.length === 0, missing };
}

/** Whether the space has defined a collection */
export const has = (collections: ReadonlyArray<NodeCollection>, name: string) =>
  collections.some((c) => c.name === name && c.version !== null);
