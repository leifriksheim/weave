/**
 * The extension's "notify me when…" tab: pick from what your spaces hold,
 * and ask your account home to add it.
 *
 * The carrier can't read your spaces, but every record's kind is on its
 * outside, so it can offer those: "new messages in Club". Titles and topic
 * fields ("mentions me") only where a definition is readable — in a public
 * space. The home shows what was picked, the person keeps what they want, and
 * the home writes it; the subscriptions then reach this extension like any
 * other.
 *
 * A tab rather than the popup, for the same reason connecting is: the popup
 * closes the moment the home's window takes focus.
 */
import type { CarriedCollection } from '@weaveprotocol/core/node';
import { proposeToHome } from '@weaveprotocol/core/session';
import type { NotifyProposal } from '@weaveprotocol/core';
import { ask, askCollections, EXTENSION_NAME, loadGrant, notificationsPage, type CarrierStatus, type SpaceCollections } from './shared';
import { accountLine, h, mark } from './ui';

/** The home takes at most this many in one go */
const MAX = 8;

const app = document.getElementById('app')!;
let status: CarrierStatus | null = null;
let held: ReadonlyArray<SpaceCollections> = [];
const picked = new Map<string, NotifyProposal>();
let busy = false;
let error: string | null = null;
let added: ReadonlyArray<string> = [];

/** Its title, else its name made readable: `std.contact-request` → "contact request", `app.chat.message` → "chat message" */
function kindOf(collection: Pick<CarriedCollection, 'name' | 'title'>): string {
  if (collection.title) return collection.title;
  const parts = collection.name.split('.');
  return (parts[0] === 'std' || parts[0] === 'app' ? parts.slice(1) : parts).join(' ').replace(/-/g, ' ');
}

/** What can be offered for one kind of record, in one space or all of them */
function offers(collection: CarriedCollection, space: SpaceCollections['space'] | null): Array<{ key: string; label: string; proposal: NotifyProposal }> {
  const where = space ? ` in ${space.name}` : '';
  const spaces = space ? { spaces: [space.id] } : {};
  const kind = kindOf(collection);
  return [
    {
      key: `${space?.id ?? '*'}|${collection.name}`,
      label: `New ${kind}`,
      proposal: { label: `New ${kind}${where}`.slice(0, 120), collection: collection.name, others: true, ...spaces },
    },
    ...collection.topics.map((field) => ({
      key: `${space?.id ?? '*'}|${collection.name}|${field}`,
      label: `${kind[0]!.toUpperCase()}${kind.slice(1)} where ${field} is you`,
      proposal: { label: `${kind} where ${field} is you${where}`.slice(0, 120), collection: collection.name, topic: { field, me: true as const }, others: true, ...spaces },
    })),
  ];
}

/** Every kind of record across the spaces, once, for "in every space" */
function everywhere(): CarriedCollection[] {
  const byName = new Map<string, CarriedCollection>();
  for (const { collections } of held) {
    for (const found of collections) {
      const known = byName.get(found.name);
      byName.set(found.name, {
        name: found.name,
        ...((known?.title ?? found.title) ? { title: known?.title ?? found.title } : {}),
        topics: [...new Set([...(known?.topics ?? []), ...found.topics])],
        records: (known?.records ?? 0) + found.records,
      });
    }
  }
  return [...byName.values()].sort((a, b) => kindOf(a).localeCompare(kindOf(b)));
}

function group(title: string, collections: ReadonlyArray<CarriedCollection>, space: SpaceCollections['space'] | null): HTMLElement {
  const rows = collections.flatMap((collection) => offers(collection, space));
  return h(
    'section',
    {},
    h('h2', {}, title),
    h(
      'div',
      { class: 'choices' },
      ...rows.map((row) =>
        h(
          'label',
          { class: 'choice' },
          h('input', {
            type: 'checkbox',
            checked: picked.has(row.key),
            disabled: busy || (!picked.has(row.key) && picked.size >= MAX),
            onChange: () => {
              if (picked.has(row.key)) picked.delete(row.key);
              else picked.set(row.key, row.proposal);
              render();
            },
          }),
          row.label,
        ),
      ),
    ),
  );
}

function render(): void {
  if (!status) return app.replaceChildren(mark(), h('p', { class: 'hint' }, 'Starting…'));
  if (status.state === 'not-connected' || !status.account) {
    return app.replaceChildren(mark(), h('p', { class: 'hint' }, 'Connect this extension to your account first.'));
  }
  const account = status.account;
  const parts: Array<Node | null> = [
    mark(),
    h('h1', {}, 'Notify me when…'),
    h(
      'p',
      { class: 'lead' },
      'Pick from what your spaces hold, and your account home asks you to confirm. Notifications show the space and the time — this extension can’t read the message.',
    ),
    h('section', {}, accountLine(account)),
    added.length ? h('p', { class: 'note' }, `Added: ${added.join(', ')}. They reach this extension in a moment.`) : null,
    held.length === 0
      ? h('p', { class: 'hint' }, status.state === 'running' ? 'Nothing in your spaces yet to be notified about.' : 'Starting…')
      : h('div', {}, group('In every space', everywhere(), null), ...held.map((entry) => group(entry.space.name, entry.collections, entry.space))),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { disabled: busy || picked.size === 0, onClick: () => void send(account.home) },
        busy ? 'Waiting for your account home…' : picked.size ? `Ask my account (${picked.size})` : 'Ask my account',
      ),
      h('a', { href: notificationsPage(account.home), target: '_blank', class: 'hint', style: 'align-self: center' }, 'Pause or remove in your account'),
    ),
    picked.size >= MAX ? h('p', { class: 'hint' }, `At most ${MAX} at a time.`) : null,
    error ? h('p', { class: 'error' }, error) : null,
  ];
  app.replaceChildren(...parts.filter((part): part is Node => part !== null));
}

async function send(home: string): Promise<void> {
  busy = true;
  error = null;
  added = [];
  render();
  try {
    const answer = await proposeToHome({ home, notify: [...picked.values()], name: EXTENSION_NAME });
    added = answer.notify.map((sub) => sub.label);
    picked.clear();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    render();
  }
}

async function load(next?: CarrierStatus): Promise<void> {
  status = next ?? (await ask({ to: 'offscreen', type: 'status' }));
  // The grant's home, not the status's, in case the two ever disagree: the grant is what connected.
  const grant = await loadGrant();
  if (grant && status.account) status = { ...status, account: { ...status.account, home: grant.home } };
  held = await askCollections().catch(() => []);
  render();
}

chrome.runtime.onMessage.addListener((message: { to?: string; type?: string; status?: CarrierStatus }) => {
  if (message?.to === 'pages' && message.type === 'status' && message.status && !busy) void load(message.status);
});

render();
void load();
