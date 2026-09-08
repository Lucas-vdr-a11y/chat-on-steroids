import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defaultConfig, effectiveCapabilities, getConfig, initConfigPath, loadConfig, updateConfig } from '../src/main/config.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { publishPluginSurface, pluginRefreshPublications } from '../src/main/plugin-refresh.js';
import { startBridge } from '../src/main/bridge.js';
import { localIpcAllowed } from '../src/main/local-policy.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
let directory = ''; let endpoint: McpEndpoint | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close(); await endpoint?.stop(); await unifiedExecManager.terminateAllProcesses(); if(directory) await rm(directory,{recursive:true,force:true}); });
it('locks browser-dependent features off even after an explicit configuration write', async () => {
 directory = await mkdtemp(path.join(os.tmpdir(),'cos-local-'));
 initConfigPath(directory); await loadConfig();
 await updateConfig(config => ({ ...config, sessions:{...config.sessions,record:true}, multiAgent:{...config.multiAgent,enabled:true}, compaction:{...config.compaction,auto:true}, goal:{...config.goal,enabled:true,impulseMinutes:5}, ui:{...config.ui,finishTool:true,autoRefreshPlugins:true} }));
 for(const config of [defaultConfig(),getConfig()]) {
 expect(config.sessions.record).toBe(false); expect(config.multiAgent.enabled).toBe(false); expect(config.compaction.auto).toBe(false); expect(config.goal.enabled).toBe(false); expect(config.goal.impulseMinutes).toBe(0); expect(config.ui.finishTool).toBe(false); expect(config.ui.autoRefreshPlugins).toBe(false);
 }
 expect(await startBridge()).toBeNull();
 publishPluginSurface('core','Local','1','',[]);
 expect(pluginRefreshPublications()).toEqual([]);
 for(const channel of ['sessions:send','chatModels:request','bridge:downloadExtension','swarm:reset','update:install']) expect(localIpcAllowed(channel)).toBe(false);
 for(const channel of ['plugins:install','roots:add','settings:save','connection:connect']) expect(localIpcAllowed(channel)).toBe(true);
});
it('creates, edits, moves and deletes files and executes commands over MCP without browser evidence', async () => {
 directory = await realpath(await mkdtemp(path.join(os.tmpdir(),'cos-local-http-'))); initConfigPath(directory); await loadConfig();
 await updateConfig(config => ({...config, roots:[{name:'shared',path:directory}]}));
 endpoint = await startMcpServer(() => ({roots:getConfig().roots,caps:effectiveCapabilities(getConfig()),readOnly:false, sessionTools:true,agentTools:true,exposedFinishTool:true}));
 client = new Client({name:'Local edition acceptance',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.urls.core)));
 const names = (await client.listTools()).tools.map(tool=>tool.name);
 expect(names).toContain('apply_patch'); expect(names).toContain('exec_command');
 expect(names).not.toContain('session');expect(names).not.toContain('agents');expect(names).not.toContain('session_finish');
 const patch = async (text:string) => { const result = await client!.callTool({name:'apply_patch',arguments:{patch:text}});expect(result.isError,JSON.stringify(result)).not.toBe(true); };
 await patch('*** Begin Patch\n*** Add File: /shared/new.txt\n+created\n*** End Patch');
 expect(await readFile(path.join(directory,'new.txt'),'utf8')).toBe('created\n');
 await patch('*** Begin Patch\n*** Update File: /shared/new.txt\n*** Move to: /shared/moved.txt\n@@\n-created\n+edited\n*** End Patch');
 expect(await readFile(path.join(directory,'moved.txt'),'utf8')).toBe('edited\n');
 const command = await client.callTool({name:'exec_command',arguments:{cmd:'node -e "process.stdout.write(\'local-mcp-works\')"' ,workdir:'/shared',yield_time_ms:1000}});
 expect(command.isError,JSON.stringify(command)).not.toBe(true);expect(JSON.stringify(command)).toContain('local-mcp-works');
 await patch('*** Begin Patch\n*** Delete File: /shared/moved.txt\n*** End Patch');
 await expect(readFile(path.join(directory,'moved.txt'),'utf8')).rejects.toThrow();
 const outside = await client.callTool({name:'apply_patch',arguments:{patch:'*** Begin Patch\n*** Add File: /outside/no.txt\n+denied\n*** End Patch'}});
 expect(outside.isError).toBe(true);
});
