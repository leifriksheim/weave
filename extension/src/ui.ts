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

/**
 * The account's avatar, drawn exactly as the home draws it (`home/src/components/Avatar.tsx`),
 * so the account here and the account there are recognisably the same one — or
 * recognisably not.
 */
export function avatar(did: string, size = 32): SVGSVGElement {
  let seed = 2166136261;
  for (let i = 0; i < did.length; i++) {
    seed ^= did.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  seed >>>= 0;
  const hue = seed % 360;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 5 5');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Account avatar');
  svg.style.cssText = `border-radius:${size / 4}px;background:hsl(${hue} 46% 92%);flex-shrink:0;display:block`;
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (((seed >> (x * 5 + y)) & 1) === 0) continue;
      for (const at of x < 2 ? [x, 4 - x] : [x]) {
        const cell = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        cell.setAttribute('x', String(at));
        cell.setAttribute('y', String(y));
        cell.setAttribute('width', '1');
        cell.setAttribute('height', '1');
        cell.setAttribute('fill', `hsl(${hue} 62% 48%)`);
        svg.append(cell);
      }
    }
  }
  return svg;
}

/** Whose spaces these are, and which home connected them — the thing to check when something looks wrong */
export function accountLine(account: NonNullable<CarrierStatus['account']>, action?: Node): HTMLElement {
  return h(
    'div',
    { class: 'account' },
    avatar(account.did),
    h('div', { class: 'who' }, h('strong', {}, account.name), h('span', { class: 'faint' }, `through ${new URL(account.home).host}`)),
    action ?? null,
  );
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
