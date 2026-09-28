/**
 * @module events
 * The one way modules here let others listen to them.
 */

// never[]: any listener, whatever it takes, fits the constraint.
type Listener = (...args: never[]) => void;

/** Its methods close over their listeners, so they can be passed around unbound. */
export interface Emitter<Events extends { [K in keyof Events]: Listener }> {
  on<K extends keyof Events>(this: void, event: K, callback: Events[K]): void;
  off<K extends keyof Events>(this: void, event: K, callback: Events[K]): void;
  /** Calls every listener; one that throws is reported and does not stop the rest. */
  emit<K extends keyof Events>(this: void, event: K, ...args: Parameters<Events[K]>): void;
}

/** Creates an emitter for a map of event names to listener signatures. */
export function createEmitter<Events extends { [K in keyof Events]: Listener }>(): Emitter<Events> {
  const listeners = new Map<keyof Events, Set<Listener>>();
  return {
    on(event, callback) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(callback);
    },
    off(event, callback) {
      listeners.get(event)?.delete(callback);
    },
    emit(event, ...args) {
      for (const callback of [...(listeners.get(event) ?? [])]) {
        try {
          callback(...args);
        } catch (error) {
          console.error(`Error in a listener for ${String(event)}:`, error);
        }
      }
    },
  };
}
