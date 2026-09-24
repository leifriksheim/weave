/**
 * The service worker. Chrome stops it after about thirty quiet seconds, so the
 * carrier cannot live here; its one job is to keep the offscreen page — where
 * the carrier does live — in existence, and to show how it is doing on the
 * toolbar button.
 *
 * It makes the page when Chrome starts, when the extension is installed or
 * updated, when any page asks, and on a one-minute alarm in case Chrome closed
 * it for any reason.
 */
import type { CarrierStatus, WorkerMessage } from './shared';

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
  ensureOffscreen().then(
    () => respond(true),
    () => respond(false),
  );
  return true; // answering later
});

void ensureOffscreen();
