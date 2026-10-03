/**
 * The little the two visible pages share: building elements, and drawing the
 * carried spaces and the pod the same way in both.
 */
import type { CarriedSpace } from '@weaveprotocol/core/node';
import { ensureFolderPermission, recallDataFolder } from '@weaveprotocol/core/storage';
import { avatarCells } from '@weave/app-shared/avatar-cells';
import type { CarrierStatus, PodState } from './shared';

type Child = Node | string | null | false | undefined;
type Attribute = string | number | boolean | null | undefined | ((event: Event) => void);

/** An element, with attributes (`on*` for listeners) and children */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, Attribute> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function')
      element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'class') element.className = String(value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  for (const child of children)
    if (child !== null && child !== false && child !== undefined) element.append(child);
  return element;
}

/** The wordmark, as in the home */
export function mark(): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.innerHTML =
    '<path d="M2 5 L7 15 L10 8 L13 15 L18 5" fill="none" stroke="#000" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
  return h('div', { class: 'mark' }, svg, 'Weave');
}

/**
 * The account's avatar, drawn exactly as the home draws it (`apps/shared/src/avatar-cells.ts`),
 * so the account here and the account there are recognisably the same one — or
 * recognisably not.
 */
function avatar(did: string, size = 32): SVGSVGElement {
  const { hue, cells } = avatarCells(did);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 5 5');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Account avatar');
  svg.style.cssText = `border-radius:${size / 4}px;background:hsl(${hue} 46% 92%);flex-shrink:0;display:block`;
  for (const { x, y } of cells) {
    const cell = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [name, value] of Object.entries({ x, y, width: 1, height: 1, fill: `hsl(${hue} 62% 48%)` }))
      cell.setAttribute(name, String(value));
    svg.append(cell);
  }
  return svg;
}

/** Whose spaces these are, and which home connected them — the thing to check when something looks wrong */
export function accountLine(account: NonNullable<CarrierStatus['account']>, action?: Node): HTMLElement {
  return h(
    'div',
    { class: 'account' },
    avatar(account.did),
    h(
      'div',
      { class: 'who' },
      h('strong', {}, account.name),
      h('span', { class: 'faint' }, `through ${new URL(account.home).host}`),
    ),
    action ?? null,
  );
}

/** What to call a carried space — the account's own list has no name of its own worth showing */
const nameOf = (space: CarriedSpace) =>
  space.name === 'Account registry' ? 'Your list of spaces' : space.name;

/** The spaces being carried, with whether each is reaching anyone */
export function spaceList(status: CarrierStatus): HTMLElement {
  const spaces = status.spaces.filter((space) => !space.carry);
  if (spaces.length === 0) {
    return h(
      'p',
      { class: 'hint' },
      status.state === 'starting'
        ? 'Starting…'
        : 'No spaces yet. They appear here as your account adds them.',
    );
  }
  return h(
    'ul',
    { class: 'spaces' },
    ...spaces.map((space) =>
      h(
        'li',
        {},
        h(
          'span',
          { class: 'name' },
          h('span', {
            class: `dot ${space.connection === 'connected' ? 'good' : space.connection === 'error' || space.connection === 'refused' ? 'bad' : ''}`,
          }),
          nameOf(space),
        ),
        h(
          'span',
          { class: 'meta' },
          space.peers === 0
            ? 'nobody else online'
            : `with ${space.peers} other${space.peers === 1 ? '' : 's'}`,
        ),
      ),
    ),
  );
}

/** One line on how many spaces are carried */
export function summary(status: CarrierStatus): string {
  const spaces = status.spaces.filter((space) => !space.carry);
  const count = `${spaces.length} space${spaces.length === 1 ? '' : 's'}`;
  return spaces.some((space) => space.peers > 0)
    ? `Keeping ${count} online.`
    : `Keeping ${count} online. Nobody else is online right now.`;
}

/** How the pod is doing, in a line both pages show the same */
export function podLine(state: Exclude<PodState, 'none'>, folder: string | null): HTMLElement {
  const said =
    state === 'writing'
      ? `Up to date: everything that arrives is written into “${folder}”.`
      : state === 'needs-permission'
        ? `Chrome wants a click before this writes to “${folder}” again. Until then, your pod catches up later.`
        : `Your account lives in a pod, “${folder}”. Choose that folder, and this keeps it up to date while your apps are closed.`;
  return h(
    'p',
    { class: 'hint' },
    h('span', { class: `dot ${state === 'writing' ? 'good' : 'warn'}` }),
    said,
  );
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
