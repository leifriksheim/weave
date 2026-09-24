/**
 * The toolbar popup: how things are, at a glance. Anything that opens the
 * account home happens in the welcome tab instead — this popup closes as soon
 * as another window takes focus.
 */
import { ask, type CarrierStatus, type StatusChanged } from './shared';
import { accountLine, h, mark, spaceList, summary } from './ui';

const app = document.getElementById('app')!;
let status: CarrierStatus | null = null;

/**
 * Anything that asks Chrome for the pod happens in the welcome tab. Asked from
 * this popup, Chrome grants the folder silently but only until the popup
 * closes; asked from a tab, it shows its own prompt, which offers "Allow on
 * every visit" — and that one lasts.
 */
const openWelcome = () => void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).then(() => window.close());

function render(): void {
  if (!status) return app.replaceChildren(mark(), h('p', { class: 'hint' }, 'Starting…'));

  if (status.state === 'not-connected') {
    return app.replaceChildren(
      mark(),
      h('p', { class: 'hint' }, status.removed ? 'Your account disconnected this extension.' : 'Not connected to your account yet.'),
      h('div', { class: 'actions' }, h('button', { class: 'wide', onClick: openWelcome }, 'Set up')),
    );
  }

  const pod = status.pod;

  const parts: Array<Node | null> = [
    mark(),
    status.account ? h('section', {}, accountLine(status.account)) : null,
    h('section', {}, h('p', { class: 'hint' }, summary(status)), spaceList(status)),
    pod.state === 'none'
      ? null
      : h(
          'section',
          {},
          h('h2', {}, 'Pod'),
          pod.state === 'writing'
            ? h('p', { class: 'hint' }, h('span', { class: 'dot good' }), `Up to date in “${pod.folder}”.`)
            : pod.state === 'needs-permission'
              ? h('div', {}, h('p', { class: 'hint' }, h('span', { class: 'dot warn' }), 'Chrome wants a click before writing to it again.'), h('div', { class: 'actions' }, h('button', { class: 'small', onClick: openWelcome }, 'Resume pod sync')))
              : h('p', { class: 'hint' }, h('span', { class: 'dot warn' }), 'Choose your pod folder to keep it up to date.'),
        ),
    status.state === 'error' ? h('p', { class: 'error' }, status.error ?? 'Something went wrong.') : null,
    h('div', { class: 'actions' }, h('button', { class: 'quiet wide small', onClick: openWelcome }, 'Open Weave')),
  ];
  app.replaceChildren(...parts.filter((node): node is Node => node !== null));
}

chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message?.to === 'pages' && message.type === 'status') {
    status = message.status;
    render();
  }
  return false;
});

render();
void ask({ to: 'offscreen', type: 'status' }).then((answer) => {
  status = answer;
  render();
});
