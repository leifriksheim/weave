/**
 * Liquid as a mini app (`@weave/app-shared/mini-app`): what a host like the
 * example app mounts inside one of its spaces. The standalone site
 * (`main.tsx`) wraps the same `AssemblySpace` in a shell of its own.
 */
import type { MiniApp } from '@weave/app-shared/mini-app';
import { AssemblySpace } from './Assembly';
import { ASSEMBLY, proposal, topic } from './schema';
import { injectAppStyles } from './styles';

export const liquid: MiniApp = {
  id: 'liquid',
  title: 'Liquid',
  description: 'Vote on proposals yourself, or trust someone to vote for you, topic by topic.',
  // Two votes flowing into a third, as in Liquid's own mark
  icon: 'M4.5 4a1.5 1.5 0 1 0 0 .01M11.5 4a1.5 1.5 0 1 0 0 .01M8 13.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5.3 5.4l1.7 3.6M10.7 5.4 9 9',
  hue: 196,
  needs: ASSEMBLY,
  notify: [{ label: 'New proposal', collection: proposal.name }],
  // A few topics to start from, when whoever adds it may set them; moderators change them later.
  setup: async (node, spaceId) => {
    if (!(await node.records.can(spaceId, 'create', topic.name))) return;
    if ((await node.records.list(spaceId, { collection: topic.name })).length > 0) return;
    for (const [name, hue] of [
      ['Budget', 150],
      ['Events', 28],
      ['Rules', 262],
    ] as const)
      await node.records.put(spaceId, topic, { name, hue });
  },
  injectStyles: injectAppStyles,
  Space: AssemblySpace,
};
