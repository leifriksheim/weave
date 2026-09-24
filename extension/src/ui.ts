/**
 * The little the two visible pages share: building elements, and drawing the
 * carried spaces and the pod the same way in both.
 */
import type { CarriedSpace } from 'weave-protocol/node';
import { ensureFolderPermission, recallDataFolder } from 'weave-protocol/storage';
import type { CarrierStatus } from './shared';

type Child = Node | string | null | false | undefined;

/** An element, with attributes (`on*` for listeners) and children */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    else if (name === 'class') element.className = String(value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  for (const child of children) if (child !== null && child !== false && child !== undefined) element.append(child);
  return element;
}

/** The wordmark, as in the home */
export function mark(): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.innerHTML = '<path d="M2 5 L7 15 L10 8 L13 15 L18 5" fill="none" stroke="#000" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
  return h('div', { class: 'mark' }, svg, 'Weave');
}

/** What to call a carried space — the account's own list has no name of its own worth showing */
const nameOf = (space: CarriedSpace) => (space.name === 'Account registry' ? 'Your list of spaces' : space.name);

/** The spaces being carried, with whether each is reaching anyone */
export function spaceList(status: CarrierStatus): HTMLElement {
  const spaces = status.spaces.filter((space) => !space.carry);
  if (spaces.length === 0) {
    return h('p', { class: 'hint' }, status.state === 'starting' ? 'Starting…' : 'No spaces yet. They appear here as your account adds them.');
  }
  return h(
    'ul',
    { class: 'spaces' },
    ...spaces.map((space) =>
      h(
        'li',
        {},
        h('span', { class: 'name' }, h('span', { class: `dot ${space.connection === 'connected' ? 'good' : space.connection === 'error' ? 'bad' : ''}` }), nameOf(space)),
        h('span', { class: 'meta' }, space.peers === 0 ? 'nobody else online' : `with ${space.peers} other${space.peers === 1 ? '' : 's'}`),
      ),
    ),
  );
}

/** One line on how many spaces are carried */
export function summary(status: CarrierStatus): string {
  const spaces = status.spaces.filter((space) => !space.carry);
  const count = `${spaces.length} space${spaces.length === 1 ? '' : 's'}`;
  return spaces.some((space) => space.peers > 0) ? `Keeping ${count} online.` : `Keeping ${count} online. Nobody else is online right now.`;
}

/**
 * Asks Chrome to let the extension write the pod again. Needs a click: call
 * it from one.
 * @returns Whether it may
 */
export async function resumePod(): Promise<boolean> {
  const handle = await recallDataFolder();
  return handle ? ensureFolderPermission(handle, { request: true }) : false;
}
