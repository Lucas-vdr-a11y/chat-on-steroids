import type { PluginSnapshot } from '../shared/plugins.js';

/** Reconnect failed transports; never replay a tool call or an installation. */
export function startPluginRecovery(manager: {
  snapshot(): PluginSnapshot;
  restart(id: string): Promise<PluginSnapshot>;
}, intervalMs = 30_000): () => void {
  let stopped = false;
  const pending = new Set<string>();
  const retries = new Map<string, { attempts: number; after: number }>();
  const timer = setInterval(() => {
    if (stopped) return;
    for (const plugin of manager.snapshot().plugins) {
      if (!plugin.enabled || plugin.status !== 'error') {
        if (plugin.status === 'ready' || !plugin.enabled) retries.delete(plugin.id);
        continue;
      }
      if (pending.has(plugin.id) || (retries.get(plugin.id)?.after ?? 0) > Date.now()) continue;
      const attempts = (retries.get(plugin.id)?.attempts ?? 0) + 1;
      retries.set(plugin.id, { attempts, after: Date.now() + Math.min(300_000, intervalMs * 2 ** Math.min(attempts - 1, 4)) });
      pending.add(plugin.id);
      void manager.restart(plugin.id).catch(() => undefined).finally(() => pending.delete(plugin.id));
    }
  }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
