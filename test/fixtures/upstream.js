import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['echo','forbidden'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))}));
server.setRequestHandler(CallToolRequestSchema,async req=>({content:[{type:'text',text:JSON.stringify({args:req.params.arguments,secret:process.env.CONTROL_PLANE_API_KEY ?? null})}]}));
await server.connect(new StdioServerTransport());
