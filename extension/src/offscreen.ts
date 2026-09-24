/**
 * The hidden page where the carrier runs, for as long as Chrome does.
 *
 * It starts the carrier from the stored grant, attaches the pod when Chrome
 * allows it, and reports how things are to the other pages and the badge. It
 * holds no seed and no space key: only its own key, the carry space's key, and
 * encrypted records (`weave-protocol/node`, `createCarrierNode`).
 */
import { createCarrierNode, folderStores, indexedDBStores, type CarrierNode } from 'weave-protocol/node';
import { appKey, forgetAppKey, type CarryGrant } from 'weave-protocol/session';
import { forgetDataFolder, queryFolderPermission, recallDataFolder } from 'weave-protocol/storage';
import {
  BUILT_IN_RELAYS,
  forgetGrant,
  KEY_NAME,
  loadGrant,
  loadRemoved,
  setRemoved,
  storePrefix,
  type CarrierStatus,
  type PodState,
  type Request,
  type StatusChanged,
  type WorkerMessage,
} from './shared';

let carrier: CarrierNode | null = null;
let grant: CarryGrant | null = null;
let status: CarrierStatus = { state: 'starting', spaces: [], pod: { state: 'none', folder: null } };
/** Bumped by every (re)start, so a slow one that was overtaken stops */
let generation = 0;

function set(next: CarrierStatus): void {
  status = next;
  const changed: StatusChanged = { to: 'pages', type: 'status', status };
  const badge: WorkerMessage = { to: 'worker', type: 'badge', status };
  // Nobody listening is fine: no page open, or the worker asleep.
  chrome.runtime.sendMessage(changed).catch(() => {});
  chrome.runtime.sendMessage(badge).catch(() => {});
}

const setPod = (state: PodState) => set({ ...status, pod: { state, folder: grant?.pod?.folder ?? null } });

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 250);
}

async function refresh(): Promise<void> {
  const node = carrier;
  if (!node) return;
  const spaces = await node.spaces().catch(() => status.spaces);
  if (node === carrier) set({ ...status, state: 'running', spaces });
}

async function stop(): Promise<void> {
  const node = carrier;
  carrier = null;
  await node?.close().catch(() => {});
}

async function start(): Promise<void> {
  const mine = ++generation;
  await stop();
  grant = await loadGrant();
  if (mine !== generation) return;
  if (!grant) {
    set({ state: 'not-connected', removed: await loadRemoved(), spaces: [], pod: { state: 'none', folder: null } });
    return;
  }

  set({
    state: 'starting',
    account: { name: grant.name, did: grant.did, home: grant.home },
    spaces: [],
    pod: { state: grant.pod ? 'not-picked' : 'none', folder: grant.pod?.folder ?? null },
  });
  try {
    const key = await appKey(KEY_NAME);
    const relays = [...new Set([...BUILT_IN_RELAYS, ...(grant.relays ?? [])])];
    const node = await createCarrierNode({
      key: key.keys,
      account: grant.did,
      carry: grant.carry.invite,
      stores: indexedDBStores(storePrefix(grant.did)),
      network: { relays },
    });
    if (mine !== generation) return void (await node.close());
    carrier = node;
    node.subscribe((event) => {
      if (event.type === 'closed') void forget({ byAccount: true });
      else refreshSoon();
    });
    await attachPod();
    await refresh();
  } catch (error) {
    if (mine === generation) set({ ...status, state: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Writes into the pod when Chrome lets this extension. A folder picked in the
 * welcome tab is remembered; after a restart Chrome may want a click before it
 * can be written again, and then the pod waits — the carrier's own copy goes
 * on, and the pod catches up as soon as it is allowed.
 */
async function attachPod(): Promise<void> {
  const node = carrier;
  if (!node || !grant?.pod) return;
  const handle = await recallDataFolder();
  if (!handle) {
    await node.usePod(null);
    return setPod('not-picked');
  }
  if ((await queryFolderPermission(handle).catch(() => 'denied')) !== 'granted') {
    await node.usePod(null);
    return setPod('needs-permission');
  }
  if (status.pod.state === 'writing') return;
  await node.usePod(folderStores(handle, { basePath: grant.pod.dataPath }));
  setPod('writing');
}

/**
 * Forgets everything: the carrier's copy, its key, the grant, the folder.
 * @param options.byAccount The account removed it, rather than the person here
 */
async function forget(options: { byAccount: boolean }): Promise<void> {
  generation++;
  const did = grant?.did;
  await stop();
  if (did) {
    const databases = await indexedDB.databases().catch(() => []);
    await Promise.all(
      databases
        .filter((db) => db.name?.startsWith(storePrefix(did)))
        .map(
          (db) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(db.name!);
              request.onsuccess = request.onerror = request.onblocked = () => resolve();
            }),
        ),
    );
  }
  await forgetGrant();
  await forgetDataFolder();
  await forgetAppKey(KEY_NAME);
  await setRemoved(options.byAccount);
  grant = null;
  set({ state: 'not-connected', removed: options.byAccount, spaces: [], pod: { state: 'none', folder: null } });
}

chrome.runtime.onMessage.addListener((message: Request, _sender, respond) => {
  if (message?.to !== 'offscreen') return false;
  const answer = () => respond(status);
  if (message.type === 'status') answer();
  else if (message.type === 'reload') void start().then(answer, answer);
  else if (message.type === 'disconnect') void forget({ byAccount: false }).then(answer, answer);
  return message.type !== 'status';
});

// A folder's permission can come or go while running (the welcome tab asked,
// or the person revoked it in Chrome's settings); look again now and then.
setInterval(() => void attachPod().catch(() => {}), 60_000);

void start();
