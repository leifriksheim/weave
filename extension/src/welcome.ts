/**
 * The extension's own tab: connecting to the account home, picking the pod,
 * and seeing what is carried. Opened on install, and from the toolbar popup.
 *
 * Connecting happens here rather than in the popup because the popup closes
 * the moment the home's window takes focus, and the home's answer would have
 * nowhere to arrive.
 */
import { appKey, connectCarrier, homeAddress, type CarryGrant } from 'weave-protocol/session';
import { pickDataFolder, rememberDataFolder, type DirectoryHandleLike } from 'weave-protocol/storage';
import { ask, DEFAULT_HOME, EXTENSION_NAME, KEY_NAME, loadGrant, saveGrant, setRemoved, type CarrierStatus, type StatusChanged } from './shared';
import { h, mark, resumePod, spaceList, summary } from './ui';

const app = document.getElementById('app')!;
let status: CarrierStatus | null = null;
let grant: CarryGrant | null = null;
let error: string | null = null;
let busy = false;

function render(): void {
  const view = status?.state === 'not-connected' || !grant ? connectView() : connectedView();
  app.replaceChildren(mark(), ...view.filter((node): node is Node => node !== null));
}

async function update(next?: CarrierStatus): Promise<void> {
  status = next ?? (await ask({ to: 'offscreen', type: 'status' }));
  grant = await loadGrant();
  render();
}

async function run(task: () => Promise<void>): Promise<void> {
  busy = true;
  error = null;
  render();
  try {
    await task();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    await update();
  }
}

// ─── Not connected ────────────────────────────────────────────────────

function connectView(): Array<Node | null> {
  const input = h('input', { id: 'home', value: new URL(DEFAULT_HOME).host, autocomplete: 'off', spellcheck: 'false' });
  const connect = () =>
    run(async () => {
      const home = homeAddress(input.value);
      const key = await appKey(KEY_NAME);
      const received = await connectCarrier({ home, key, name: EXTENSION_NAME });
      await saveGrant(received);
      await setRemoved(false);
      await ask({ to: 'offscreen', type: 'reload' });
    });

  return [
    status?.removed ? h('p', { class: 'note' }, 'Your account disconnected this extension, and it forgot everything it held.') : null,
    h('h1', {}, 'Keep your spaces online'),
    h(
      'p',
      { class: 'lead' },
      'While Chrome is open, this keeps your Weave spaces in sync with your other devices and the people you share with — even with no app open. It can’t read them.',
    ),
    h(
      'section',
      {},
      h('label', { for: 'home' }, 'Your account home'),
      input,
      h('div', { class: 'actions' }, h('button', { class: 'wide', disabled: busy, onClick: () => void connect() }, busy ? 'Waiting for your account home…' : 'Connect')),
      h('p', { class: 'hint', style: 'margin-top: 12px' }, 'Your account home opens in a new window. Sign in there, and allow it.'),
      error ? h('p', { class: 'error' }, error) : null,
    ),
    h('p', { class: 'faint' }, 'It holds your spaces as they travel, private ones still locked. It never gets your password or the keys that open them.'),
  ];
}

// ─── Connected ────────────────────────────────────────────────────────

function connectedView(): Array<Node | null> {
  const account = status?.account;
  const accountHome = grant ? new URL(grant.home).origin : null;
  return [
    h('h1', {}, 'Keeping your spaces online'),
    h(
      'p',
      { class: 'lead' },
      'For ',
      h('strong', {}, account?.name ?? grant?.name ?? 'your account'),
      '. While Chrome is open, your spaces stay in sync — even with no app open.',
    ),
    status?.state === 'error' ? h('p', { class: 'note' }, `Something went wrong: ${status.error ?? 'unknown'}. It will try again when Chrome restarts.`) : null,
    h('section', {}, h('h2', {}, 'Spaces'), status ? h('p', { class: 'hint' }, summary(status)) : null, status ? spaceList(status) : null),
    grant?.pod ? podSection(grant.pod) : null,
    h(
      'section',
      {},
      h('h2', {}, 'Disconnect'),
      h('p', { class: 'hint' }, 'Forgets everything this extension holds. Your spaces stay on your devices.'),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'danger small', disabled: busy, onClick: () => void disconnect() }, 'Disconnect'),
        accountHome ? h('a', { href: accountHome, target: '_blank', class: 'hint', style: 'align-self: center' }, 'Your account home') : null,
      ),
    ),
    error ? h('p', { class: 'error' }, error) : null,
  ];
}

function podSection(pod: NonNullable<CarryGrant['pod']>): HTMLElement {
  const state = status?.pod.state ?? 'not-picked';
  const choose = () =>
    run(async () => {
      const folder = await pickDataFolder({ id: 'weave-pod' });
      await checkPod(folder, pod.dataPath, pod.folder);
      await rememberDataFolder(folder);
      await ask({ to: 'offscreen', type: 'reload' });
    });
  const resume = () =>
    run(async () => {
      if (!(await resumePod())) throw new Error('Chrome did not allow it. Try again, or choose the folder again.');
      await ask({ to: 'offscreen', type: 'reload' });
    });

  const body =
    state === 'writing'
      ? [h('p', { class: 'hint' }, h('span', { class: 'dot good' }), `Everything that arrives is written into “${pod.folder}”.`), h('div', { class: 'actions' }, h('button', { class: 'quiet small', disabled: busy, onClick: () => void choose() }, 'Choose another folder'))]
      : state === 'needs-permission'
        ? [h('p', { class: 'hint' }, h('span', { class: 'dot warn' }), `Chrome wants a click before this writes to “${pod.folder}” again. Until then, your pod catches up later.`), h('div', { class: 'actions' }, h('button', { class: 'small', disabled: busy, onClick: () => void resume() }, 'Resume pod sync'))]
        : [h('p', { class: 'hint' }, `Your account lives in a pod, “${pod.folder}”. Choose that folder, and this keeps it up to date while your apps are closed.`), h('div', { class: 'actions' }, h('button', { class: 'small', disabled: busy, onClick: () => void choose() }, 'Choose your pod folder'))];

  return h('section', {}, h('h2', {}, 'Your pod'), ...body);
}

/** Refuses a folder that does not hold this account, before anything is written to it. */
async function checkPod(folder: DirectoryHandleLike, dataPath: string, expected: string): Promise<void> {
  let at = folder;
  for (const part of dataPath.split('/')) {
    try {
      at = await at.getDirectoryHandle(part);
    } catch {
      throw new Error(`That folder doesn’t hold this account. Choose the folder called “${expected}”.`);
    }
  }
}

async function disconnect(): Promise<void> {
  if (!confirm('Forget everything this extension holds? Your spaces stay on your devices. To stop your account sending it anything, also disconnect it in your account home.')) return;
  await run(async () => {
    await ask({ to: 'offscreen', type: 'disconnect' });
  });
}

chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message?.to === 'pages' && message.type === 'status' && !busy) void update(message.status);
  return false;
});

void update();
