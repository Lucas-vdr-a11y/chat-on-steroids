import { afterEach, expect, it, vi } from 'vitest';
import { startPluginRecovery } from '../src/main/plugin-recovery.js';
import type { PluginSnapshot, PluginView } from '../src/shared/plugins.js';
afterEach(() => vi.useRealTimers());
it('reconnects enabled failures with backoff, skips authentication/disabled plugins and stops cleanly', async () => {
 vi.useFakeTimers();
 const manager = { snapshot: () => ({ plugins: [
  {id:'broken',enabled:true,status:'error'}, {id:'auth',enabled:true,status:'needs-auth'},
  {id:'off',enabled:false,status:'error'}, {id:'ready',enabled:true,status:'ready'}
 ] as PluginView[], catalog:[],schemaRevision:1 }), restart:vi.fn(async () => ({} as PluginSnapshot)) };
 const stop=startPluginRecovery(manager,1000);
 await vi.advanceTimersByTimeAsync(3000);expect(manager.restart.mock.calls).toEqual([['broken'],['broken']]);
 await vi.advanceTimersByTimeAsync(1000);expect(manager.restart).toHaveBeenCalledTimes(3);
 stop();await vi.advanceTimersByTimeAsync(10000);expect(manager.restart).toHaveBeenCalledTimes(3);
});
it('does not overlap a connection attempt',async()=>{
 vi.useFakeTimers();let finish!:(s:PluginSnapshot)=>void;
 const manager={snapshot:()=>({plugins:[{id:'one',enabled:true,status:'error'}] as PluginView[],catalog:[],schemaRevision:1}),restart:vi.fn(()=>new Promise<PluginSnapshot>(resolve=>{finish=resolve;}))};
 const stop=startPluginRecovery(manager,1000);await vi.advanceTimersByTimeAsync(10000);expect(manager.restart).toHaveBeenCalledTimes(1);
 stop();finish({plugins:[],catalog:[],schemaRevision:1});await Promise.resolve();
});
