/**
 * The small part of the Chrome extension API the Presign extension uses
 * (avoids a dependency on @types/chrome).
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab;
      frameId?: number;
      url?: string;
      origin?: string;
      id?: string;
    }
    interface Event<T extends (...args: never[]) => unknown> {
      addListener(cb: T): void;
      removeListener(cb: T): void;
    }
    const id: string;
    const lastError: { message?: string } | undefined;
    function sendMessage(message: unknown, callback?: (response: never) => void): void;
    function getURL(path: string): string;
    const onMessage: Event<(message: never, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void>;
    const onMessageExternal: Event<(message: never, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void>;
  }
  namespace dom {
    /** Content scripts only: the element's shadow root, open or closed. */
    function openOrClosedShadowRoot(element: HTMLElement): ShadowRoot | null;
  }
  namespace storage {
    interface Area {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: Area;
    const session: Area;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      url?: string;
      active?: boolean;
    }
    function get(tabId: number): Promise<Tab>;
    function query(q: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    const onRemoved: runtime.Event<(tabId: number) => void>;
  }
  namespace windows {
    interface Window {
      id?: number;
    }
    function create(data: { url: string; type?: "normal" | "popup"; width?: number; height?: number; focused?: boolean }): Promise<Window | undefined>;
    function update(windowId: number, info: { focused?: boolean }): Promise<Window>;
    function remove(windowId: number): Promise<void>;
    const onRemoved: runtime.Event<(windowId: number) => void>;
  }
}
