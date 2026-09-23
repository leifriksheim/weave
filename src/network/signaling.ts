/**
 * @fileoverview WebRTC signaling client via WebSocket.
 */

export interface SignalingMessage {
  readonly type: 'offer' | 'answer' | 'candidate' | 'join' | 'leave';
  readonly from: string;
  readonly to?: string;
  readonly payload?: unknown;
}

export type SignalingEvents = {
  offer: (message: SignalingMessage) => void;
  answer: (message: SignalingMessage) => void;
  candidate: (message: SignalingMessage) => void;
  'peer-joined': (did: string) => void;
  'peer-left': (did: string) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
};

export interface SignalingClient {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  readonly sendOffer: (targetDid: string, offer: RTCSessionDescriptionInit) => void;
  readonly sendAnswer: (targetDid: string, answer: RTCSessionDescriptionInit) => void;
  readonly sendCandidate: (targetDid: string, candidate: RTCIceCandidateInit) => void;
  readonly on: <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]) => void;
  readonly off: <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]) => void;
  readonly isConnected: () => boolean;
}

/**
 * Creates a new signaling client.
 * 
 * @param url - The WebSocket signaling server URL.
 * @param did - The decentralized identifier of this peer.
 * @returns The signaling client instance.
 */
export function createSignalingClient(url: string, did: string): SignalingClient {
  let ws: WebSocket | null = null;
  let connected = false;
  let retryCount = 0;
  const maxRetries = 5;
  const maxBackoffMs = 30000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: { [K in keyof SignalingEvents]?: Set<any> } = {};

  const emit = <K extends keyof SignalingEvents>(event: K, ...args: Parameters<SignalingEvents[K]>) => {
    const eventListeners = listeners[event];
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (callback as any)(...args);
        } catch (e) {
          console.error(`Error in signaling event listener for ${event}:`, e);
        }
      });
    }
  };

  const on = <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]): void => {
    if (!listeners[event]) {
      listeners[event] = new Set();
    }
    listeners[event]!.add(callback);
  };

  const off = <K extends keyof SignalingEvents>(event: K, callback: SignalingEvents[K]): void => {
    if (listeners[event]) {
      listeners[event]!.delete(callback);
    }
  };

  const sendMessage = (msg: Omit<SignalingMessage, 'from'>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const fullMsg: SignalingMessage = { ...msg, from: did };
    ws.send(JSON.stringify(fullMsg));
  };

  const connect = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      ws.onopen = () => {
        connected = true;
        retryCount = 0;
        emit('connected');
        sendMessage({ type: 'join' });
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as SignalingMessage;
          switch (msg.type) {
            case 'offer':
              emit('offer', msg);
              break;
            case 'answer':
              emit('answer', msg);
              break;
            case 'candidate':
              emit('candidate', msg);
              break;
            case 'join':
              emit('peer-joined', msg.from);
              break;
            case 'leave':
              emit('peer-left', msg.from);
              break;
            default:
              console.warn('Unknown signaling message type:', msg.type);
          }
        } catch (err) {
          emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onerror = () => {
        const error = new Error('WebSocket error occurred');
        emit('error', error);
        if (!connected) {
          reject(error);
        }
      };

      ws.onclose = () => {
        connected = false;
        emit('disconnected');
        
        if (retryCount < maxRetries) {
          const backoff = Math.min(1000 * Math.pow(2, retryCount), maxBackoffMs);
          retryCount++;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }
          reconnectTimer = setTimeout(() => {
            connect().catch(() => {
              // Ignore promise rejection on reconnect attempt
            });
          }, backoff);
        }
      };
    });
  };

  const disconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    retryCount = maxRetries; // Prevent reconnection
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
  };

  return Object.freeze({
    connect,
    disconnect,
    sendOffer: (targetDid: string, offer: RTCSessionDescriptionInit) => 
      sendMessage({ type: 'offer', to: targetDid, payload: offer }),
    sendAnswer: (targetDid: string, answer: RTCSessionDescriptionInit) => 
      sendMessage({ type: 'answer', to: targetDid, payload: answer }),
    sendCandidate: (targetDid: string, candidate: RTCIceCandidateInit) => 
      sendMessage({ type: 'candidate', to: targetDid, payload: candidate }),
    on,
    off,
    isConnected: () => connected
  });
}
