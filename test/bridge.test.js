import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridge } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { readFile, writeFile, listFiles } from '../src/files.js';
function setup(t,writable=false) {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mcp-only-')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'share'));
 fs.writeFileSync(path.join(dir,'share','a.txt'),'before');
 fs.writeFileSync(path.join(dir,'outside.txt'),'private');
 return {dir, config:{roots:[{name:'work',path:path.join(dir,'share'),writable}],servers:[]}};
}
test('reads and lists only configured files; refuses traversal, symlinks and hard links',t=>{
 const {dir,config}=setup(t);
 assert.equal(readFile(config,{root:'work',path:'a.txt'}).text,'before');
 assert.equal(listFiles(config,{root:'work',path:'.'}).entries[0].name,'a.txt');
 assert.throws(()=>readFile(config,{root:'work',path:'../outside.txt'}));
 assert.throws(()=>readFile(config,{root:'unknown',path:'a.txt'}));
 assert.throws(()=>readFile(config,{root:'work',path:path.join(dir,'outside.txt')}));
 fs.symlinkSync(path.join(dir,'outside.txt'),path.join(dir,'share','link'));
 assert.throws(()=>readFile(config,{root:'work',path:'link'}));
 fs.linkSync(path.join(dir,'outside.txt'),path.join(dir,'share','hard'));
 assert.throws(()=>readFile(config,{root:'work',path:'hard'}));
 fs.mkdirSync(path.join(dir,'elsewhere'));
 fs.symlinkSync(path.join(dir,'elsewhere'),path.join(dir,'share','nested'));
 assert.throws(()=>listFiles(config,{root:'work',path:'nested'}));
});
test('read-only and stale revision writes fail; valid write succeeds',t=>{
 const {config}=setup(t);
 const args={root:'work',path:'a.txt'};
 const initial=readFile(config,args);
 assert.throws(()=>writeFile(config,{...args,text:'after',expectedSha256:initial.sha256}));
 config.roots[0].writable=true;
 assert.throws(()=>writeFile(config,{...args,text:'after',expectedSha256:'0'.repeat(64)}));
 writeFile(config,{...args,text:'after',expectedSha256:initial.sha256});
 assert.equal(readFile(config,args).text,'after');
 assert.throws(()=>writeFile(config,{...args,text:'oops',expectedSha256:initial.sha256}));
 assert.throws(()=>writeFile(config,{...args,path:'new.txt',text:'x',expectedSha256:initial.sha256}));
});
test('binary and oversized files are rejected',t=>{
 const {dir,config}=setup(t);
 const filename=path.join(dir,'share','a.txt');
 fs.writeFileSync(filename,Buffer.from([0xff]));
 assert.throws(()=>readFile(config,{root:'work',path:'a.txt'}));
 fs.writeFileSync(filename,Buffer.alloc(1024*1024+1,97));
 assert.throws(()=>readFile(config,{root:'work',path:'a.txt'}));
});
test('configuration rejects unknown automation options and duplicate names',t=>{
 const {dir,config}=setup(t);
 const file=path.join(dir,'config.json');
 fs.writeFileSync(file,JSON.stringify({...config,automation:true}));
 assert.throws(()=>loadConfig(file));
 fs.writeFileSync(file,JSON.stringify({...config,roots:[...config.roots,...config.roots]}));
 assert.throws(()=>loadConfig(file));
});
async function connect(t,config) {
 const bridge=await createBridge(config);
 const client=new Client({name:'test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await bridge.server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await bridge.close();});
 return client;
}
test('MCP exposes only selected tools and rejects stale or invented calls',async t=>{
 const {config}=setup(t);
 const client=await connect(t,config);
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['local_folders','local_list','local_read']);
 assert.equal((await client.callTool({name:'local_write',arguments:{}})).isError,true);
 assert.equal((await client.callTool({name:'agents',arguments:{}})).isError,true);
 const read=await client.callTool({name:'local_read',arguments:{root:'work',path:'a.txt'}});
 assert.equal(JSON.parse(read.content[0].text).text,'before');
});
test('real stdio upstream allowlist, arguments, conservative annotations and credential isolation',async t=>{
 const previous=process.env.CONTROL_PLANE_API_KEY;
 process.env.CONTROL_PLANE_API_KEY='test-only-secret';
 t.after(()=>{if(previous===undefined)delete process.env.CONTROL_PLANE_API_KEY;else process.env.CONTROL_PLANE_API_KEY=previous;});
 const client=await connect(t,{roots:[],servers:[{name:'example',command:process.execPath,args:[path.resolve('test/fixtures/upstream.js')],env:{},allowTools:['echo']}]});
 const tools=(await client.listTools()).tools;
 assert.deepEqual(tools.map(t=>t.name),['example__echo']);
 assert.equal(tools[0].annotations.readOnlyHint,false);
 const response=await client.callTool({name:'example__echo',arguments:{hello:'world'}});
 assert.deepEqual(JSON.parse(response.content[0].text),{args:{hello:'world'},secret:null});
 assert.equal((await client.callTool({name:'example__forbidden',arguments:{}})).isError,true);
});
test('missing allowed upstream tool prevents startup',async()=>{
 await assert.rejects(createBridge({roots:[],servers:[{name:'example',command:process.execPath,args:[path.resolve('test/fixtures/upstream.js')],env:{},allowTools:['missing']}]}),/Allowed tool missing/);
});
test('actual entrypoint completes MCP initialization and a file call over stdio',async t=>{
 const {dir,config}=setup(t);
 const filename=path.join(dir,'config.json');fs.writeFileSync(filename,JSON.stringify(config));
 const client=new Client({name:'integration',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.js'),'--config',filename]}));
 t.after(()=>client.close());
 assert.equal((await client.listTools()).tools.length,3);
 const response=await client.callTool({name:'local_read',arguments:{root:'work',path:'a.txt'}});
 assert.equal(JSON.parse(response.content[0].text).text,'before');
});
