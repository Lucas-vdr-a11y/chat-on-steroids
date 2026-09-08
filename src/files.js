import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
export const digest = data => createHash('sha256').update(data).digest('hex');
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
export function resolveFile(config, name, relative = '.') {
  const root = config.roots.find(r => r.name === name);
  if (!root) throw new Error('Unknown shared folder');
  if (path.isAbsolute(relative)) throw new Error('Use a relative path inside the shared folder');
  const target = path.resolve(root.path, relative);
  if (!inside(root.path, target)) throw new Error('Path leaves shared folder');
  // Reject symlinks at every existing component, even when their target is in-root.
  let current = root.path;
  if (fs.realpathSync(current) !== current) throw new Error('Shared folder changed; restart and review configuration');
  for (const part of path.relative(root.path, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not exposed');
  }
  if (!inside(root.path, fs.realpathSync(target))) throw new Error('Path leaves shared folder');
  return { root, target };
}
function openText(target, flags, fn) {
  const fd = fs.openSync(target, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Only ordinary files with one hard link are supported');
    if (stat.size > MAX_BYTES) throw new Error('File exceeds 1 MiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_BYTES) throw new Error('File exceeds 1 MiB');
    const bytes = buffer.subarray(0, size);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Binary files are not supported');
    return fn(fd, text, bytes);
  } finally { fs.closeSync(fd); }
}
export function listFiles(config, args) {
  const { target } = resolveFile(config, args.root, args.path);
  const dir = fs.opendirSync(target);
  const entries = [];
  try {
    for (let item; (item = dir.readSync());) {
      if (entries.length >= 500) return { entries, truncated: true };
      entries.push({ name: item.name, type: item.isSymbolicLink() ? 'blocked-link' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'unsupported' });
    }
  } finally { dir.closeSync(); }
  return { entries, truncated: false };
}
export function readFile(config, args) {
  const { target } = resolveFile(config, args.root, args.path);
  return openText(target, fs.constants.O_RDONLY, (_fd, text, bytes) => ({ text, sha256: digest(bytes) }));
}
export function writeFile(config, args) {
  const { root, target } = resolveFile(config, args.root, args.path);
  if (!root.writable) throw new Error('Shared folder is read-only');
  const replacement = Buffer.from(args.text, 'utf8');
  if (replacement.length > MAX_BYTES || args.text.includes('\0')) throw new Error('Replacement must be UTF-8 text of at most 1 MiB');
  return openText(target, fs.constants.O_RDWR, (fd, _text, bytes) => {
    if (digest(bytes) !== args.expectedSha256) throw new Error('File changed; read it again before editing');
    let offset = 0;
    while (offset < replacement.length) offset += fs.writeSync(fd, replacement, offset, replacement.length - offset, offset);
    fs.ftruncateSync(fd, replacement.length);
    fs.fsyncSync(fd);
    return { written: replacement.length, sha256: digest(replacement) };
  });
}
