import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const serverSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  allowTools: z.array(z.string().min(1)).min(1),
}).strict();
const schema = z.object({
  roots: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
    path: z.string().min(1),
    writable: z.boolean().default(false),
  }).strict()).default([]),
  servers: z.array(serverSchema).max(16).default([]),
}).strict();
export function loadConfig(filename) {
  const config = schema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
  for (const group of [config.roots, config.servers]) {
    if (new Set(group.map(x => x.name)).size !== group.length) throw new Error('Duplicate names in configuration');
  }
  for (const root of config.roots) {
    if (!path.isAbsolute(root.path)) throw new Error('Root must be an absolute path');
    root.path = fs.realpathSync(root.path);
    if (!fs.statSync(root.path).isDirectory()) throw new Error('Root must be a directory');
    if (root.path === path.parse(root.path).root) throw new Error('Sharing the entire filesystem is not allowed');
  }
  return config;
}
