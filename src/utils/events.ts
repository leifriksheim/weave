/**
 * Typed event emitter utilities.
 * @module events
 */

/**
 * A typed wrapper around EventTarget.
 * @template EventMap - A record mapping event names to their payload types.
 */
export class TypedEventTarget<EventMap extends Record<string, unknown>> {
  /**
   * The underlying EventTarget.
   * @private
   * @readonly
   */
  private readonly target = new EventTarget();

  /**
   * Adds an event listener.
   * @template K - The event name.
   * @param {K} type - The event type to listen for.
   * @param {(event: CustomEvent<EventMap[K]>) => void} listener - The callback function.
   * @param {AddEventListenerOptions} [options] - Options for the listener.
   */
  public on<K extends string & keyof EventMap>(
    type: K,
    listener: (event: CustomEvent<EventMap[K]>) => void,
    options?: AddEventListenerOptions
  ): void {
    this.target.addEventListener(type, listener as EventListener, options);
  }

  /**
   * Removes an event listener.
   * @template K - The event name.
   * @param {K} type - The event type to remove.
   * @param {(event: CustomEvent<EventMap[K]>) => void} listener - The callback function to remove.
   * @param {EventListenerOptions} [options] - Options used when adding the listener.
   */
  public off<K extends string & keyof EventMap>(
    type: K,
    listener: (event: CustomEvent<EventMap[K]>) => void,
    options?: EventListenerOptions
  ): void {
    this.target.removeEventListener(type, listener as EventListener, options);
  }

  /**
   * Emits a typed event.
   * @template K - The event name.
   * @param {K} type - The event type to emit.
   * @param {EventMap[K]} detail - The payload for the event.
   * @returns {boolean} True if the event was not canceled.
   */
  public emit<K extends string & keyof EventMap>(type: K, detail: EventMap[K]): boolean {
    const event = new CustomEvent(type, { detail });
    return this.target.dispatchEvent(event);
  }
}
