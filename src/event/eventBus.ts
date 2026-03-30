/**
 * 应用级事件总线：通用的 `on` / `emit` / `clear`，与 `@mariozechner/pi-agent-core` 的
 * {@link AgentEvent} 流式协议无关。
 *
 * 阶段机状态变化：向 {@link createAgent} 传入 `eventBus` 时，会在
 * {@link STATE_CHANGE_EVENT} 上发出 {@link MachineStateChangePayload}（见 `src/event/stateChange.ts`）。
 */
export type EventUnsubscribe = () => void;

export interface EventBus<TEvents extends Record<string, unknown>> {
  on<K extends keyof TEvents & string>(event: K, handler: (payload: TEvents[K]) => void): EventUnsubscribe;
  emit<K extends keyof TEvents & string>(event: K, payload: TEvents[K]): void;
  /** 移除某个事件的全部监听；不传则清空所有事件 */
  clear(event?: keyof TEvents & string): void;
}

export function createEventBus<TEvents extends Record<string, unknown>>(): EventBus<TEvents> {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  return {
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapped = handler as (payload: unknown) => void;
      set.add(wrapped);
      return () => {
        set!.delete(wrapped);
        if (set!.size === 0) {
          listeners.delete(event);
        }
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const h of set) {
        h(payload);
      }
    },
    clear(event) {
      if (event === undefined) {
        listeners.clear();
      } else {
        listeners.delete(event);
      }
    },
  };
}
