/**
 * A mini app: one job, written once, run two ways.
 *
 * - **Standalone**, as its own site: it connects to the person's account
 *   home, and wraps `Space` in a shell of its own (a list of its spaces, a
 *   header, invites). `apps/liquid` is one.
 * - **Inside a host**, like the example app: the host lists it beside its
 *   other apps, defines `needs` when someone adds it to a space, and renders
 *   `Space` in its own frame (`fromMiniApp` in `apps/example/src/components/apps/index.tsx`).
 *
 * A mini app reads and writes only through `@weaveprotocol/core/react`
 * below the host's `WeaveProvider`, and only in the collections it names in
 * `needs`, so it runs the same wherever it is mounted. It keeps no state the
 * host has to know about.
 */
import type { ComponentType } from 'react';
import type { DefineCollection, P2PNode, SpaceSummary } from '@weaveprotocol/core';
import type { AppNotify } from '@weaveprotocol/core/schemas';

export interface MiniApp {
  /** Stable, lower case: how a host remembers it */
  readonly id: string;
  readonly title: string;
  /** One sentence, for a host's list of apps */
  readonly description: string;
  /** Its glyph: an SVG path on a 16-unit grid, drawn as a 1.5 stroke */
  readonly icon: string;
  /** The hue of its tile, 0–359 */
  readonly hue: number;
  /** The collections it works in: a host defines the missing ones when it is added */
  readonly needs: ReadonlyArray<DefineCollection>;
  /** What in it is worth hearing about */
  readonly notify?: ReadonlyArray<AppNotify>;
  /** Runs once, right after it is added to a space */
  readonly setup?: (node: P2PNode, spaceId: string) => Promise<void>;
  /** Puts its own stylesheet in the page, once; the host's base styles are already there */
  readonly injectStyles?: () => void;
  /** Everything it shows for one space, sized to whatever frame it is given */
  readonly Space: ComponentType<{ readonly space: SpaceSummary }>;
}
