/** Tiny typed event emitter + the DOM events Home Assistant expects. */

// `object` rather than `Record<string, unknown>`: an *interface* (which is how
// ViewerEvents is declared) has no implicit index signature, so the stricter
// constraint would reject every event map declared that way.
export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as (payload: never) => void);
    return () => {
      set!.delete(cb as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      cb(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a handler may unsubscribe during dispatch.
    for (const cb of [...set]) {
      try {
        (cb as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`[floorplan-3d] listener for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface FireEventOptions {
  bubbles?: boolean;
  composed?: boolean;
  cancelable?: boolean;
}

/** HA's `fireEvent` — bubbles + composed so it escapes the shadow root. */
export function fireEvent<T>(
  node: HTMLElement | Window,
  type: string,
  detail?: T,
  options: FireEventOptions = {},
): CustomEvent<T> {
  const event = new CustomEvent<T>(type, {
    bubbles: options.bubbles ?? true,
    composed: options.composed ?? true,
    cancelable: options.cancelable ?? false,
    detail: detail as T,
  });
  node.dispatchEvent(event);
  return event;
}

/** Opens HA's entity dialog. */
export function showMoreInfo(node: HTMLElement, entityId: string): void {
  fireEvent(node, 'hass-more-info', { entityId });
}

export function showToast(node: HTMLElement, message: string): void {
  fireEvent(node, 'hass-notification', { message });
}

/** Leading-edge throttle that always delivers the trailing call. */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const invoke = (args: A) => {
    last = Date.now();
    fn(...args);
  };

  const wrapped = (...args: A) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(args);
    } else {
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) {
            const p = pending;
            pending = null;
            invoke(p);
          }
        }, remaining);
      }
    }
  };

  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return wrapped;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
