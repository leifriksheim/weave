/**
 * The service worker. Chrome stops it after about thirty quiet seconds, so the
 * carrier cannot live here; its one job is to keep the offscreen page — where
 * the carrier does live — in existence, and to show how it is doing on the
 * toolbar button.
 *
 * It makes the page when Chrome starts, when the extension is installed or
 * updated, when any page asks, and on a one-minute alarm in case Chrome closed
 * it for any reason.
 *
 * It also shows notifications — the offscreen page may not. The carrier found
 * a record one of the account's subscriptions asks about; all it knows is the
 * subscription's label, the space and the time, and that is what is shown.
 * Several for one subscription close together become one: "3 new".
 */
import { loadGrant, loadMuted, type CarrierStatus, type WorkerMessage } from './shared';

const OFFSCREEN = 'offscreen.html';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN);
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (existing.length > 0) return;
  // Two callers at once must not both create it: Chrome allows one.
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification: 'Runs a peer that keeps your Weave spaces synced with your other devices over WebRTC while the browser is open.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

function showBadge(status: CarrierStatus): void {
  const podNeedsYou = status.pod.state === 'not-picked' || status.pod.state === 'needs-permission';
  let text = '';
  let color = '#000000';
  let title = 'Weave';
  if (status.state === 'not-connected') {
    title = status.removed ? 'Weave — disconnected by your account' : 'Weave — not connected yet';
  } else if (status.state === 'error') {
    text = '!';
    color = '#e5484d';
    title = `Weave — ${status.error ?? 'something went wrong'}`;
  } else if (podNeedsYou) {
    text = '!';
    color = '#b45309';
    title = 'Weave — your pod needs a click to keep syncing';
  } else if (status.state === 'running') {
    // A small green mark: carrying.
    text = ' ';
    color = '#1a7f37';
    const carried = status.spaces.filter((space) => !space.carry).length;
    title = `Weave — keeping ${carried} space${carried === 1 ? '' : 's'} online`;
  }
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setTitle({ title });
}

/** A burst for one subscription shows as one notification, counted, for this long */
const BURST_MS = 60_000;
const bursts = new Map<string, { count: number; since: number }>();
/** Where clicking each notification goes. Lost if the worker sleeps: then the home. */
const opens = new Map<string, string>();

async function notify(message: Extract<WorkerMessage, { type: 'notify' }>): Promise<void> {
  const { subscription, space, record } = message.event;
  if ((await loadMuted()).has(subscription.id)) return;
  const id = `weave:${subscription.id}`;
  const now = Date.now();
  const burst = bursts.get(id);
  const count = burst && now - burst.since < BURST_MS ? burst.count + 1 : 1;
  bursts.set(id, { count, since: burst && count > 1 ? burst.since : now });
  opens.set(id, subscription.open ?? message.home);
  const when = new Date(record.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title: space.name,
    message: count > 1 ? `${subscription.label} · ${count} new` : subscription.label,
    contextMessage: `Weave · ${when}`,
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener((id) => {
  void (async () => {
    const url = opens.get(id) ?? (await loadGrant())?.home;
    bursts.delete(id);
    await chrome.notifications.clear(id);
    if (url) await chrome.tabs.create({ url });
  })();
});
chrome.notifications.onClosed.addListener((id) => {
  bursts.delete(id);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  void ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => void ensureOffscreen());

chrome.alarms.create('keep-carrying', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-carrying') void ensureOffscreen();
});

chrome.runtime.onMessage.addListener((message: WorkerMessage, _sender, respond) => {
  if (message?.to !== 'worker') return false;
  if (message.type === 'badge') {
    showBadge(message.status);
    return false;
  }
  if (message.type === 'notify') {
    void notify(message).catch(() => {});
    return false;
  }
  ensureOffscreen().then(
    () => respond(true),
    () => respond(false),
  );
  return true; // answering later
});

void ensureOffscreen();
