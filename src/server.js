import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { listFiles, readFile, writeFile } from './files.js';

const fileArgs = z.object({root: z.string(), path: z.string().default('.')}).strict();
const writeArgs = fileArgs.extend({text: z.string(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/)});
const objectSchema = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const paths = {root:{type:'string',description:'Shared folder name'}, path:{type:'string',description:'Relative path within that folder; use . to list its root'}};
const readAnnotations = {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false};
const result = value => ({content:[{type:'text', text:JSON.stringify(value)}]});

export async function createBridge(config) {
  const clients = [];
  const routes = new Map();
  const add = (tool, call) => routes.set(tool.name, {tool, call});
  if (config.roots.length) {
    add({name:'local_folders', description:'List the folders explicitly shared with this connection.', inputSchema:objectSchema({}), annotations:readAnnotations}, args => {
      z.object({}).strict().parse(args);
      return result(config.roots.map(({name,writable}) => ({name,writable})));
    });
    add({name:'local_list', description:'List up to 500 entries in a shared folder. Symlinks cannot be opened.', inputSchema:objectSchema(paths), annotations:readAnnotations}, args => result(listFiles(config,fileArgs.parse(args))));
    add({name:'local_read', description:'Read an existing UTF-8 text file, at most 1 MiB, with its SHA-256 revision.', inputSchema:objectSchema(paths), annotations:readAnnotations}, args => result(readFile(config,fileArgs.parse(args))));
    if (config.roots.some(r => r.writable)) add({name:'local_write', description:'Replace an existing text file in a writable shared folder. First read it and supply its SHA-256 revision. Requires user authorization; does not create or delete files.', inputSchema:objectSchema({...paths,text:{type:'string'},expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}), annotations:{readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false}}, args => result(writeFile(config,writeArgs.parse(args))));
  }
  try {
    for (const entry of config.servers) {
      const client = new Client({name:'mcp-only-local-proxy', version:'0.1.0'});
      clients.push(client);
      // Do not inherit tunnel/API credentials into third-party MCP processes.
      await client.connect(new StdioClientTransport({command:entry.command,args:entry.args,cwd:entry.cwd,env:{...getDefaultEnvironment(),...entry.env},stderr:'inherit'}));
      const discovered = new Map();
      let cursor;
      const seen = new Set();
      do {
        const page = await client.listTools(cursor ? {cursor} : {});
        for (const tool of page.tools) discovered.set(tool.name,tool);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('MCP server repeated a pagination cursor');
        if (cursor) seen.add(cursor);
        if (seen.size > 20 || discovered.size > 1000) throw new Error('MCP catalog exceeds limits');
      } while (cursor);
      for (const name of entry.allowTools) {
        const upstream = discovered.get(name);
        if (!upstream) throw new Error(`Allowed tool missing: ${entry.name}/${name}`);
        const exposed = `${entry.name}__${name}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(exposed) || routes.has(exposed)) throw new Error('Invalid or duplicate exposed tool name');
        // Imported hints are not security evidence. Require conservative confirmation metadata.
        add({...upstream, name:exposed, annotations:{readOnlyHint:false, destructiveHint:true,idempotentHint:false,openWorldHint:true}}, async args => {
          const response = await client.callTool({name, arguments:args}, undefined, {timeout:60000});
          if (Buffer.byteLength(JSON.stringify(response)) > 4 * 1024 * 1024) throw new Error('MCP result exceeds 4 MiB');
          return response;
        });
      }
    }
  } catch (error) { await Promise.allSettled(clients.map(c=>c.close())); throw error; }
  const server = new Server({name:'chat-on-steroids-mcp-only',version:'0.1.0'}, {capabilities:{tools:{}},instructions:'Use tools only for the user’s current request. Folder access is limited to configured shares. Third-party tools have their own authority. No chat recording, scheduled tasks, browser injection or automatic continuation is provided.'});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[...routes.values()].map(r=>r.tool)}));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const route = routes.get(request.params.name);
      if (!route) throw new Error('Tool is not enabled');
      return await route.call(request.params.arguments ?? {});
    } catch (error) { return {isError:true,content:[{type:'text',text:error instanceof Error ? error.message : 'Tool failed'}]}; }
  });
  return {server, close:async()=>{await server.close();await Promise.allSettled(clients.map(c=>c.close()));}};
}
async function main() {
  const args = process.argv.slice(2);
  const configFlag = args.indexOf('--config');
  const filename = configFlag >= 0 ? args[configFlag+1] : path.resolve('config.json');
  if (!filename) throw new Error('--config requires a filename');
  const config = loadConfig(filename);
  if (args.includes('--check')) {
    console.error(`Configuration valid: ${config.roots.length} shared folders, ${config.servers.length} MCP servers. No servers started.`);
    return;
  }
  const bridge = await createBridge(config);
  let closing = false;
  const close = async()=>{if(closing)return;closing=true;await bridge.close();};
  process.once('SIGINT',()=>void close());
  process.once('SIGTERM',()=>void close());
  const transport = new StdioServerTransport();
  await bridge.server.connect(transport);
  transport.onclose = ()=>void close();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
