import { Expression } from '../types.js';
import { StorageProvider } from '../storage/storage-provider.js';
import { SyncMessage, encodeSyncMessage, decodeSyncMessage } from './sync-messages.js';
import { compareRoots, findMissingExpressions } from './anti-entropy.js';
import { listMSTKeys } from '../storage/mst.js';

/** Verdict on an expression that arrived from a peer */
export interface IncomingValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface SyncEngineConfig {
  readonly storageProvider: StorageProvider;
  readonly sendToPeer: (peerId: string, data: Uint8Array) => void;
  readonly heartbeatInterval?: number;
  /**
   * Gatekeeper for expressions arriving from peers — typically a
   * `ValidationEngine`. Anything it rejects is dropped instead of committed,
   * and surfaces as a `rejected` event.
   *
   * Leaving it out accepts whatever peers send, which is only ever appropriate
   * for a trusted transport or a test.
   */
  readonly validate?: (expression: Expression) => Promise<IncomingValidation>;
}

export type SyncEvent = 'synced' | 'expression-received' | 'rejected' | 'error';
type EventHandler = (...args: any[]) => void;

export interface SyncEngine {
  start(): void;
  stop(): void;
  handleMessage(peerId: string, data: Uint8Array): Promise<void>;
  notifyPeers(peers: ReadonlyArray<string>): void;
  onLocalChange(expression: Expression): void;
  addPeer(peerId: string): void;
  removePeer(peerId: string): void;
  on(event: SyncEvent, callback: EventHandler): void;
  off(event: SyncEvent, callback: EventHandler): void;
}

/**
 * Creates a sync engine orchestrator.
 * @param config Sync engine configuration.
 * @returns A sync engine instance.
 */
export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { storageProvider, sendToPeer, heartbeatInterval = 30000, validate } = config;
  const peers = new Set<string>();
  const eventHandlers = new Map<SyncEvent, Set<EventHandler>>();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const emit = (event: SyncEvent, ...args: any[]) => {
    const handlers = eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          console.error(`Error in event handler for ${event}`, err);
        }
      }
    }
  };

  /**
   * Commits an expression from a peer, but only if the gatekeeper allows it.
   * @returns Whether the expression was accepted
   */
  const admit = async (peerId: string, expression: Expression): Promise<boolean> => {
    if (validate) {
      const verdict = await validate(expression);
      if (!verdict.valid) {
        emit('rejected', peerId, expression, verdict.reason);
        return false;
      }
    }
    await storageProvider.addExpression(expression);
    emit('expression-received', expression);
    return true;
  };

  const broadcast = (msg: SyncMessage) => {
    const data = encodeSyncMessage(msg);
    for (const peer of peers) {
      sendToPeer(peer, data);
    }
  };

  return {
    start() {
      if (intervalId !== null) return;
      intervalId = setInterval(async () => {
        const rootCid = await storageProvider.getRootCid();
        broadcast({ type: 'sync-request', rootCid });
      }, heartbeatInterval);
    },

    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    async handleMessage(peerId: string, data: Uint8Array): Promise<void> {
      try {
        const msg = decodeSyncMessage(data);
        const localRoot = await storageProvider.getRootCid();
        const adapter = storageProvider.getAdapter();

        switch (msg.type) {
          case 'sync-request': {
            const hasChanges = compareRoots(localRoot, msg.rootCid);
            if (hasChanges) {
              const localKeys = await listMSTKeys(adapter, localRoot);
              sendToPeer(peerId, encodeSyncMessage({
                type: 'sync-response',
                rootCid: localRoot,
                hasChanges: true,
                remoteKeys: localKeys
              }));
            } else {
              sendToPeer(peerId, encodeSyncMessage({
                type: 'sync-response',
                rootCid: localRoot,
                hasChanges: false
              }));
            }
            break;
          }
          case 'sync-response': {
            if (msg.hasChanges && msg.remoteKeys) {
              const missing = await findMissingExpressions(adapter, localRoot, msg.remoteKeys);
              if (missing.length > 0) {
                sendToPeer(peerId, encodeSyncMessage({
                  type: 'diff-request',
                  missingIds: missing
                }));
              } else {
                emit('synced', peerId);
              }
            } else {
              emit('synced', peerId);
            }
            break;
          }
          case 'diff-request': {
            const expressions: Expression[] = [];
            for (const id of msg.missingIds) {
              const expr = await storageProvider.getExpression(id);
              if (expr) {
                expressions.push(expr);
              }
            }
            if (expressions.length > 0) {
              sendToPeer(peerId, encodeSyncMessage({
                type: 'diff-response',
                expressions
              }));
            }
            break;
          }
          case 'diff-response': {
            for (const expr of msg.expressions) {
              await admit(peerId, expr);
            }
            emit('synced', peerId);
            break;
          }
          case 'push-update': {
            await admit(peerId, msg.expression);
            break;
          }
        }
      } catch (err) {
        emit('error', err);
      }
    },

    notifyPeers(peerIds: ReadonlyArray<string>) {
      storageProvider.getRootCid().then(rootCid => {
        const msg = encodeSyncMessage({ type: 'sync-request', rootCid });
        for (const peer of peerIds) {
          if (peers.has(peer)) {
            sendToPeer(peer, msg);
          }
        }
      }).catch(err => emit('error', err));
    },

    onLocalChange(expression: Expression) {
      storageProvider.getRootCid().then(newRootCid => {
        broadcast({ type: 'push-update', expression, newRootCid: newRootCid || '' });
      }).catch(err => emit('error', err));
    },

    addPeer(peerId: string) {
      peers.add(peerId);
    },

    removePeer(peerId: string) {
      peers.delete(peerId);
    },

    on(event: SyncEvent, callback: EventHandler) {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(callback);
    },

    off(event: SyncEvent, callback: EventHandler) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        handlers.delete(callback);
      }
    }
  };
}
