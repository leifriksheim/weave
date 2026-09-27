import type { ComponentType } from 'react';
import type { DefineCollection, NodeCollection, NodeRecord, P2PNode, SpaceSummary } from '@weaveprotocol/core';
import { call, column, message, poll, reaction, task, vote, positionBetween } from '@weaveprotocol/core/schemas';
import { CallHistory } from './CallHistory';
import { Chat } from './Chat';
import { Kanban } from './Kanban';
import { Polls } from './Polls';

export interface AppProps {
  readonly space: SpaceSummary;
  readonly collections: ReadonlyArray<NodeCollection>;
  readonly onOpen: (record: NodeRecord) => void;
}

/**
 * An app is a screen that knows some standard schemas — nothing more. It is
 * code in this example, not something stored in the space: it shows up in a
 * space as soon as the space holds the collections it needs, whoever
 * added them and however. What it writes are ordinary records, so the
 * Collections tab (or any other app that knows the same schemas) sees them too.
 */
export interface WeaveApp {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Without these it cannot work: adding the app defines the missing ones */
  readonly needs: ReadonlyArray<DefineCollection>;
  /** Shown when the space has them, left out when it does not */
  readonly uses?: ReadonlyArray<DefineCollection>;
  /** Runs once, right after someone adds the app — a board's first columns */
  readonly setup?: (node: P2PNode, spaceId: string) => Promise<void>;
  readonly View: ComponentType<AppProps>;
}

export const APPS: ReadonlyArray<WeaveApp> = [
  {
    id: 'chat',
    title: 'Chat',
    description: 'Talk with everyone in the space. The whole space is the room.',
    needs: [message],
    uses: [reaction],
    View: Chat,
  },
  {
    id: 'kanban',
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
    title: 'Polls',
    description: 'Ask the space a question. Everyone picks one option, and can change their mind.',
    needs: [poll, vote],
    View: Polls,
  },
  {
    id: 'calls',
    title: 'Calls',
    description: 'Keeps a log of the calls in this space: who was in each, and calls nobody answered.',
    needs: [call],
    View: CallHistory,
  },
];

/** Which of an app's schemas a space already has, and which it lacks */
export function readiness(app: WeaveApp, collections: ReadonlyArray<NodeCollection>): { ready: boolean; missing: ReadonlyArray<DefineCollection> } {
  const defined = new Set(collections.filter((c) => c.version !== null).map((c) => c.name));
  const missing = app.needs.filter((s) => !defined.has(s.name));
  return { ready: missing.length === 0, missing };
}

/** Whether the space has defined a collection */
export const has = (collections: ReadonlyArray<NodeCollection>, name: string) => collections.some((c) => c.name === name && c.version !== null);
