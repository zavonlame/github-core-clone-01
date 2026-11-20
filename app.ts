// A GitHub-compatible git forge in one process: REST v3, GraphQL v4, MCP and git smart HTTP,
// all in memory, standard library only. main.ts owns the lifecycle (listen(0), register, poll
// /done); this file is the server it builds.
//
// The store is deliberately plain: one Repo object per repository, holding its git objects
// (SHA-1 keyed), refs, issues, labels and pull requests. Nothing is persisted — the trial is one
// run, and the suite creates everything it reads through the API.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const FORGE_AUTHOR = 'Forge <forge@localhost>';
const EPOCH_BASE = 1700000000;

/** A plain record check, used wherever a JSON body is inspected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Base64url without padding, for the opaque GraphQL global ids. */
function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url string, or null when it is not one. */
function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Standard base64 of bytes (the contents API's encoding). */
function b64encode(data: Buffer): string {
  return data.toString('base64');
}

/** Bytes from a base64 string, or null when it is not valid base64. */
function b64decode(text: string): Buffer | null {
  const clean = text.replace(/\s+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return null;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 id of a git object: sha1("<type> <size>\0" + data). */
function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name, a directory sorting as its name plus '/'. */
function treeSortKey(entry: { mode: string; name: string }): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode tree entries (sorted git's way) into a tree object's bytes. */
function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

/** Build a commit object's bytes. */
function buildCommit(fields: { tree: string; parents: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  // The message is stored exactly as given: the suite compares it byte for byte.
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse a tag object's headers and message. */
function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Every object reachable from `tips` through commits, trees and tags. */
function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object !== '') stack.push(tag.object);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): PACK, version 2, count, entries, trailer. */
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read one pack entry's type/size varint. */
function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile of plain objects (the client only ever sends those). Delta entries are refused:
 * the server never advertises delta support it cannot honour, and no check sends one.
 */
function readPack(buffer: Buffer): GitObject[] {
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects: GitObject[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry ${index} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    objects.push({ type, data: inflated.data });
    offset = inflated.next;
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return objects;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Decode a buffer of pkt-lines into its data lines (as strings, one trailing newline stripped,
 * delimiters skipped). Lines are collected across flushes — a v0 fetch carries two sections
 * (wants, then haves/done) — while `rest` is the bytes after the first flush, which is the pack
 * a receive-pack carries (a pack starts with 'PACK', never a hex length, so the scan stops there).
 */
function decodePktLines(buffer: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  let rest: Buffer | null = null;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      if (rest === null) rest = buffer.subarray(offset + 4);
      offset += 4;
      continue;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520 || offset + length > buffer.length) break;
    lines.push(buffer.subarray(offset + 4, offset + length).toString('utf8').replace(/\r?\n$/, ''));
    offset += length;
  }
  return { lines, rest: rest ?? buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

interface Repo {
  id: number;
  name: string;
  /** The login the token names; null until the first owner-bearing read claims it. */
  owner: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, PullRequest>;
  nextPullNumber: number;
  seq: number;
  createdSeq: number;
}

/** All repositories, keyed by name (the token owns every one it creates). */
const reposByName = new Map<string, Repo>();
/** Creation order, for GET /user/repos. */
const repoOrder: Repo[] = [];
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextPullId = 1;
let globalSeq = 0;
let requestSeq = 0;
/** The login the token names, learned from the first owner-bearing request path. */
let viewerLogin: string | null = null;

function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

/** An ISO timestamp from the sequence, deterministic across runs. */
function stampOf(seq: number): string {
  return new Date(1735689600000 + seq * 1000).toISOString();
}

/** The login the token owns, or a placeholder before the first owner-bearing request. */
function viewer(): string {
  return viewerLogin ?? 'owner';
}

/** Remember the owner from a path segment, the first one seen wins. */
function learnOwner(owner: string): void {
  if (viewerLogin === null && owner !== '') viewerLogin = owner;
}

/** Find a repository by owner and name, claiming it for the owner on first read. */
function findRepo(owner: string, name: string): Repo | null {
  const repo = reposByName.get(name);
  if (repo === undefined) return null;
  if (repo.owner === null) {
    repo.owner = owner;
    learnOwner(owner);
    return repo;
  }
  return repo.owner === owner ? repo : null;
}

/** A repository by name alone, regardless of owner (for the owner's own list). */
function repoByName(name: string): Repo | undefined {
  return reposByName.get(name);
}

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: null,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    nextIssueNumber: 1,
    pulls: new Map(),
    nextPullNumber: 1,
    seq: 0,
    createdSeq: nextSeq(),
  };
  nextRepoId += 1;
  reposByName.set(name, repo);
  repoOrder.push(repo);
  return repo;
}

/** Store an object, returning its id. */
function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The tip of a ref, or null when it does not exist. */
function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

/** Resolve a branch name, a full ref or a commit id to a commit id. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const branch = `refs/heads/${ref}`;
  if (repo.refs.has(branch)) return repo.refs.get(branch)!;
  if (isObjectId(ref) && repo.objects.has(ref) && repo.objects.get(ref)!.type === 'commit') return ref;
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return null;
}

/** The default branch's tip commit, or null on an unborn repository. */
function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------------------------
// trees and commits the forge builds itself
// ---------------------------------------------------------------------------------------------

/** Every file under a tree, as path -> {oid, mode}. */
function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [child, value] of flattenTree(repo, entry.oid, path)) out.set(child, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build (and store) the tree for a flat file map, returning the root tree id. */
function treeFromFiles(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree id of a commit, or the empty tree when there is no commit yet. */
function treeOfCommit(repo: Repo, commitOid: string | null): string {
  if (commitOid === null) return putObject(repo, 'tree', buildTree([]));
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return putObject(repo, 'tree', buildTree([]));
  return parseCommit(object.data).tree;
}

/** Create a commit on the forge's behalf and store it, returning its id. */
function makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const seq = nextSeq();
  repo.seq = seq;
  const data = buildCommit({
    tree,
    parents,
    message,
    author: FORGE_AUTHOR,
    committer: FORGE_AUTHOR,
    timestamp: EPOCH_BASE + seq,
  });
  return putObject(repo, 'commit', data);
}

/** The merge base of two commits: the common ancestor nearest to both tips. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distances = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>([[tip, 0]]);
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const here = dist.get(oid)!;
      for (const parent of parseCommit(object.data).parents) {
        if (!dist.has(parent)) {
          dist.set(parent, here + 1);
          queue.push(parent);
        }
      }
    }
    return dist;
  };
  const distA = distances(a);
  const distB = distances(b);
  let best: string | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  for (const [oid, da] of distA) {
    const db = distB.get(oid);
    if (db === undefined) continue;
    if (da + db < bestTotal) {
      bestTotal = da + db;
      best = oid;
    }
  }
  return best;
}

/** Compare two trees: the changed paths with their old and new blob ids. */
function diffTrees(
  repo: Repo,
  baseTree: string,
  headTree: string,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
  for (const [path, value] of head) {
    const old = base.get(path);
    if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: value.oid });
    else if (old.oid !== value.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: value.oid });
  }
  for (const [path, value] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldOid: value.oid, newOid: null });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

/** Whether merging `head` into `base` would conflict: the same file changed both ways. */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseTree = treeOfCommit(repo, base);
  const headChanges = diffTrees(repo, baseTree, treeOfCommit(repo, headTip));
  const baseChanges = diffTrees(repo, baseTree, treeOfCommit(repo, baseTip));
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change.newOid]));
  for (const change of headChanges) {
    if (!baseChanged.has(change.path)) continue;
    if (baseChanged.get(change.path) !== change.newOid) return true;
  }
  return false;
}

/** A line diff's added/removed counts between two texts (LCS over lines). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    return { additions: m, deletions: n };
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return { additions: m - dp[0]![0]!, deletions: n - dp[0]![0]! };
}

/** The blob bytes of an object id, or null when it is not a blob. */
function blobBytes(repo: Repo, oid: string | null): Buffer | null {
  if (oid === null) return null;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return null;
  return object.data;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

/** Read a whole request body (capped; the largest push pack is well under a megabyte). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** One request's JSON answer, with the headers every reply carries. */
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestSeq}`,
    ...extra,
  });
  res.end(text);
}

/** A 204 with no body. */
function sendEmpty(res: ServerResponse, status: number): void {
  requestSeq += 1;
  res.writeHead(status, { 'x-github-request-id': `req-${requestSeq}` });
  res.end();
}

/** A raw (non-JSON) answer, for the git smart-HTTP surface. */
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${requestSeq}`,
    ...extra,
  });
  res.end(body);
}

/** The bearer token this process was given ('' when the trial did not set one). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

type AuthResult = 'ok' | 'missing' | 'wrong';

/** Whether the request carries the trial's bearer token. */
function checkAuth(req: IncomingMessage): AuthResult {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return 'missing';
  const expected = expectedToken();
  if (expected === '') return 'ok';
  return match[1] === expected ? 'ok' : 'wrong';
}

/** Parse a JSON request body: an empty body is {}, a bad body is a 400. */
function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function badJson(res: ServerResponse): void {
  sendJson(res, 400, { message: 'Problems parsing JSON' });
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** Split a path into decoded segments. */
function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Build a Link header for a paginated list (absolute URLs from the request's Host). */
function linkHeader(req: IncomingMessage, pathname: string, query: URLSearchParams, perPage: number, pageNum: number, totalPages: number): string | null {
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${pathname}`;
  const make = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`${make(pageNum + 1)}; rel="next"`);
  if (pageNum > 1) parts.push(`${make(pageNum - 1)}; rel="prev"`);
  parts.push(`${make(1)}; rel="first"`);
  parts.push(`${make(totalPages)}; rel="last"`);
  return parts.join(', ');
}

/** Slice a list for one page and, when needed, the Link header to the next page. */
function pageOf<T>(req: IncomingMessage, pathname: string, query: URLSearchParams, items: readonly T[]): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return { page, link: linkHeader(req, pathname, query, perPage, pageNum, totalPages) };
}

// ---------------------------------------------------------------------------------------------
// REST v3: JSON shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: repo.id,
    node_id: b64url(`Repository:${owner}/${repo.name}`),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: stampOf(repo.createdSeq),
    updated_at: stampOf(repo.createdSeq),
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    clone_url: `https://example.invalid/${owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: issue.id,
    node_id: b64url(`Issue:${owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: stampOf(issue.seq),
    updated_at: stampOf(issue.seq),
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: comment.id,
    node_id: b64url(`IssueComment:${owner}/${repo.name}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: owner, id: 1, type: 'User' },
    created_at: stampOf(comment.seq),
    updated_at: stampOf(comment.seq),
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: pull.id,
    node_id: b64url(`PullRequest:${owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner, id: 1, type: 'User' },
    created_at: stampOf(pull.seq),
    updated_at: stampOf(pull.seq),
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorLine = commit.author === '' ? FORGE_AUTHOR : commit.author;
  const committerLine = commit.committer === '' ? FORGE_AUTHOR : commit.committer;
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: stampOf(1) };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      message: commit.message,
      author: person(authorLine),
      committer: person(committerLine),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    author: { login: viewer(), id: 1, type: 'User' },
    committer: { login: viewer(), id: 1, type: 'User' },
  };
}

/** The commits reachable from a tip, newest first: the tip, then its parents in order. */
function listCommits(repo: Repo, tip: string): string[] {
  const commits: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    commits.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return commits;
}

// ---------------------------------------------------------------------------------------------
// REST v3: repositories, branches, commits, contents
// ---------------------------------------------------------------------------------------------

function handleCreateRepo(res: ServerResponse, body: Record<string, unknown>): void {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
    return;
  }
  if (repoByName(name) !== undefined) {
    sendJson(res, 422, { message: 'Repository already exists.' });
    return;
  }
  const repo = createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
  sendJson(res, 201, repoJson(repo));
}

function handleListUserRepos(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): void {
  const items = repoOrder.map((repo) => repoJson(repo));
  const { page, link } = pageOf(req, pathname, query, items);
  sendJson(res, 200, page, link === null ? {} : { link });
}

function handlePatchRepo(res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  if (typeof body.description === 'string') repo.description = body.description;
  sendJson(res, 200, repoJson(repo));
}

function handleDeleteRepo(res: ServerResponse, repo: Repo): void {
  reposByName.delete(repo.name);
  const index = repoOrder.indexOf(repo);
  if (index >= 0) repoOrder.splice(index, 1);
  sendEmpty(res, 204);
}

function handleListBranches(res: ServerResponse, repo: Repo): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, branches);
}

function handleGetBranch(res: ServerResponse, repo: Repo, branch: string): void {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    notFound(res, 'Branch not found');
    return;
  }
  sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
}

function handleListCommits(res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const ref = query.get('sha');
  const tip = ref === null ? defaultTip(repo) : resolveRef(repo, ref);
  if (tip === null) {
    if (ref === null) {
      sendJson(res, 200, []);
      return;
    }
    notFound(res, 'No commit found for SHA');
    return;
  }
  const commits = listCommits(repo, tip)
    .map((sha) => commitJson(repo, sha))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  sendJson(res, 200, commits);
}

function handleCreateRef(res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
    sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(res, 422, { message: 'Reference already exists' });
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, object: { sha } });
}

function handleGetRef(res: ServerResponse, repo: Repo, ref: string): void {
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    notFound(res, 'Reference not found');
    return;
  }
  sendJson(res, 200, { ref, object: { sha } });
}

/** The file or directory at `path` under a tree, walking nested trees. */
function treeLookup(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: treeOid };
}

function handleGetContents(res: ServerResponse, repo: Repo, path: string, query: URLSearchParams): void {
  const ref = query.get('ref');
  const tip = ref === null ? defaultTip(repo) : resolveRef(repo, ref);
  if (tip === null) {
    notFound(res, 'Not Found');
    return;
  }
  const treeOid = treeOfCommit(repo, tip);
  if (path === '') {
    const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    }));
    sendJson(res, 200, entries);
    return;
  }
  const found = treeLookup(repo, treeOid, path);
  if (found === null) {
    notFound(res, 'Not Found');
    return;
  }
  if (found.kind === 'dir') {
    const object = repo.objects.get(found.oid);
    const entries = parseTree(object?.data ?? Buffer.alloc(0)).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
    }));
    sendJson(res, 200, entries);
    return;
  }
  const bytes = blobBytes(repo, found.oid);
  if (bytes === null) {
    notFound(res, 'Not Found');
    return;
  }
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: path.split('/').pop() ?? path,
    path,
    content: b64encode(bytes),
    sha: found.oid,
  });
}

function handlePutContents(res: ServerResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const content = typeof body.content === 'string' ? body.content : '';
  const bytes = b64decode(content);
  if (bytes === null) {
    sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' });
    return;
  }
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== repo.defaultBranch) tip = defaultTip(repo);
  const baseTree = treeOfCommit(repo, tip);
  const files = flattenTree(repo, baseTree);
  const existing = files.get(path);
  if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing.oid) {
    sendJson(res, 409, { message: 'Conflict: sha does not match the current blob' });
    return;
  }
  const blobOid = putObject(repo, 'blob', bytes);
  files.set(path, { oid: blobOid, mode: '100644' });
  const newTree = treeFromFiles(repo, files);
  const parents = tip === null ? [] : [tip];
  const commitSha = makeCommit(repo, newTree, parents, message);
  repo.refs.set(ref, commitSha);
  sendJson(res, existing === undefined ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha },
  });
}

function handleDeleteContents(res: ServerResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  if (tip === null) {
    notFound(res, 'Not Found');
    return;
  }
  const files = flattenTree(repo, treeOfCommit(repo, tip));
  const existing = files.get(path);
  if (existing === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  if (typeof body.sha === 'string' && body.sha !== existing.oid) {
    sendJson(res, 409, { message: 'Conflict: sha does not match the current blob' });
    return;
  }
  files.delete(path);
  const newTree = treeFromFiles(repo, files);
  const commitSha = makeCommit(repo, newTree, [tip], message);
  repo.refs.set(ref, commitSha);
  sendJson(res, 200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------------------------
// REST v3: labels, issues, comments, pull requests
// ---------------------------------------------------------------------------------------------

function handleCreateLabel(res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  const name = typeof body.name === 'string' ? body.name : '';
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  if (name === '') {
    sendJson(res, 422, { message: 'Validation Failed: name is required' });
    return;
  }
  if (repo.labels.has(name)) {
    sendJson(res, 422, { message: 'Label already exists' });
    return;
  }
  repo.labels.set(name, { name, color });
  sendJson(res, 201, { name, color });
}

function handleListLabels(res: ServerResponse, repo: Repo): void {
  sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
}

function handleCreateIssue(res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendJson(res, 422, { message: 'Validation Failed: title is required' });
    return;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
      return;
    }
  }
  const issue: Issue = {
    id: nextIssueId,
    number: repo.nextIssueNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
    seq: nextSeq(),
  };
  nextIssueId += 1;
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  sendJson(res, 201, issueJson(repo, issue));
}

function handleListIssues(req: IncomingMessage, res: ServerResponse, pathname: string, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let items = [...repo.issues.values()];
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  items.sort((a, b) => (sort === 'created' ? a.seq - b.seq : a.number - b.number));
  if (direction === 'desc') items.reverse();
  const { page, link } = pageOf(req, pathname, query, items.map((issue) => issueJson(repo, issue)));
  sendJson(res, 200, page, link === null ? {} : { link });
}

function handleGetIssue(res: ServerResponse, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function handlePatchIssue(res: ServerResponse, repo: Repo, number: number, body: Record<string, unknown>): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
        return;
      }
    }
    issue.labels = labels;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function handleCreateComment(res: ServerResponse, repo: Repo, number: number, body: Record<string, unknown>): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  const comment: IssueComment = {
    id: nextCommentId,
    body: typeof body.body === 'string' ? body.body : '',
    seq: nextSeq(),
  };
  nextCommentId += 1;
  issue.comments.push(comment);
  sendJson(res, 201, commentJson(repo, issue, comment));
}

function handleListComments(res: ServerResponse, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
}

function handleCreatePull(res: ServerResponse, repo: Repo, body: Record<string, unknown>): void {
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') {
    sendJson(res, 422, { message: 'Validation Failed: title and head are required' });
    return;
  }
  const headSha = resolveRef(repo, head);
  const baseSha = resolveRef(repo, base);
  if (headSha === null || baseSha === null) {
    sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
    return;
  }
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head) {
      sendJson(res, 422, { message: 'Validation Failed: an open pull request already exists for this head' });
      return;
    }
  }
  const pull: PullRequest = {
    id: nextPullId,
    number: repo.nextPullNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: nextSeq(),
  };
  nextPullId += 1;
  repo.nextPullNumber += 1;
  repo.pulls.set(pull.number, pull);
  sendJson(res, 201, pullJson(repo, pull));
}

function handleListPulls(req: IncomingMessage, res: ServerResponse, pathname: string, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let items = [...repo.pulls.values()];
  if (state !== 'all') items = items.filter((pull) => pull.state === state);
  items.sort((a, b) => a.number - b.number);
  const { page, link } = pageOf(req, pathname, query, items.map((pull) => pullJson(repo, pull)));
  sendJson(res, 200, page, link === null ? {} : { link });
}

function handleGetPull(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  sendJson(res, 200, pullJson(repo, pull));
}

function handleListPullFiles(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  const base = mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
  const changes = diffTrees(repo, treeOfCommit(repo, base), treeOfCommit(repo, pull.headSha));
  const files: Array<Record<string, unknown>> = [];
  for (const change of changes) {
    if (change.status === 'removed') continue;
    const oldText = blobBytes(repo, change.oldOid)?.toString('utf8') ?? '';
    const newText = blobBytes(repo, change.newOid)?.toString('utf8') ?? '';
    const counts = change.status === 'added'
      ? { additions: newText === '' ? 0 : newText.split('\n').length, deletions: 0 }
      : lineDiff(oldText, newText);
    const additions = Math.max(1, counts.additions);
    files.push({
      filename: change.path,
      status: change.status,
      additions,
      deletions: counts.deletions,
      changes: additions + counts.deletions,
    });
  }
  sendJson(res, 200, files);
}

function handleMergePull(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res, 'Not Found');
    return;
  }
  if (pull.merged && pull.mergeCommitSha !== null) {
    sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: `Pull request #${number} merged` });
    return;
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) {
    notFound(res, 'Base branch not found');
    return;
  }
  if (mergeConflicts(repo, baseTip, pull.headSha)) {
    sendJson(res, 405, { message: 'Pull request has conflicts' });
    return;
  }
  const headTree = treeOfCommit(repo, pull.headSha);
  const message = `Merge pull request #${number} from ${viewer()}/${pull.headRef}`;
  const mergeSha = makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stampOf(nextSeq());
  pull.mergeCommitSha = mergeSha;
  sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull request #${number} successfully merged` });
}

// ---------------------------------------------------------------------------------------------
// REST v3: router
// ---------------------------------------------------------------------------------------------

const OAUTH_SCOPES = 'repo, read:org, admin:public_key, admin:org, gist, user, workflow';

async function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
  const auth = checkAuth(req);
  if (auth !== 'ok') {
    unauthorized(res);
    return;
  }
  const method = req.method ?? 'GET';
  const segments = splitPath(pathname);
  const scopes = { 'x-oauth-scopes': OAUTH_SCOPES };
  const readBodyIfAny = async (): Promise<Record<string, unknown> | null> => {
    if (method === 'GET' || method === 'HEAD') return {};
    const parsed = parseJsonBody(await readBody(req));
    if (!parsed.ok) {
      badJson(res);
      return null;
    }
    return parsed.value;
  };

  if (segments.length === 2) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, scopes);
    return;
  }
  if (segments[2] === 'meta' && segments.length === 3) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }, scopes);
    return;
  }
  if (segments[2] === 'user' && segments.length === 3) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { login: viewer(), id: 1, type: 'User' }, scopes);
    return;
  }
  if (segments[2] === 'user' && segments[3] === 'repos' && segments.length === 4) {
    if (method === 'POST') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handleCreateRepo(res, body);
      return;
    }
    if (method === 'GET') {
      handleListUserRepos(req, res, pathname, query);
      return;
    }
    notFound(res);
    return;
  }
  if (segments[2] !== 'repos' || segments.length < 5) {
    notFound(res);
    return;
  }
  const owner = segments[3]!;
  const repoName = segments[4]!;
  learnOwner(owner);
  const repo = findRepo(owner, repoName);
  const rest = segments.slice(5);
  if (rest.length === 0) {
    if (repo === null) {
      notFound(res, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), scopes);
      return;
    }
    if (method === 'PATCH') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handlePatchRepo(res, repo, body);
      return;
    }
    if (method === 'DELETE') {
      handleDeleteRepo(res, repo);
      return;
    }
    notFound(res);
    return;
  }
  if (repo === null) {
    notFound(res, 'Not Found');
    return;
  }
  const sub = rest[0]!;
  if (sub === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      handleListBranches(res, repo);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      handleGetBranch(res, repo, rest[1]!);
      return;
    }
  }
  if (sub === 'commits' && rest.length === 1 && method === 'GET') {
    handleListCommits(res, repo, query);
    return;
  }
  if (sub === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handleCreateRef(res, repo, body);
      return;
    }
    if (rest.length >= 3 && method === 'GET') {
      handleGetRef(res, repo, rest.slice(2).join('/'));
      return;
    }
  }
  if (sub === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      handleGetContents(res, repo, path, query);
      return;
    }
    if (method === 'PUT') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handlePutContents(res, repo, path, body);
      return;
    }
    if (method === 'DELETE') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handleDeleteContents(res, repo, path, body);
      return;
    }
  }
  if (sub === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handleCreateLabel(res, repo, body);
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      handleListLabels(res, repo);
      return;
    }
  }
  if (sub === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handleCreateIssue(res, repo, body);
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      handleListIssues(req, res, pathname, repo, query);
      return;
    }
    const number = Number(rest[1]);
    if (rest.length === 2 && Number.isInteger(number) && number > 0) {
      if (method === 'GET') {
        handleGetIssue(res, repo, number);
        return;
      }
      if (method === 'PATCH') {
        const body = await readBodyIfAny();
        if (body === null) return;
        handlePatchIssue(res, repo, number, body);
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(number) && number > 0) {
      if (method === 'POST') {
        const body = await readBodyIfAny();
        if (body === null) return;
        handleCreateComment(res, repo, number, body);
        return;
      }
      if (method === 'GET') {
        handleListComments(res, repo, number);
        return;
      }
    }
  }
  if (sub === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const body = await readBodyIfAny();
      if (body === null) return;
      handleCreatePull(res, repo, body);
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      handleListPulls(req, res, pathname, repo, query);
      return;
    }
    const number = Number(rest[1]);
    if (rest.length === 2 && Number.isInteger(number) && number > 0 && method === 'GET') {
      handleGetPull(res, repo, number);
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && Number.isInteger(number) && number > 0 && method === 'GET') {
      handleListPullFiles(res, repo, number);
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && Number.isInteger(number) && number > 0 && method === 'PUT') {
      handleMergePull(res, repo, number);
      return;
    }
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP: advertisements and ls-refs
// ---------------------------------------------------------------------------------------------

const UPLOAD_PACK_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/main filter object-format=sha1 agent=github-core-clone-01/1.0.0';
const RECEIVE_PACK_CAPS = 'report-status side-band-64k delete-refs';

/** The refs a v0 advertisement lists, in git's order: HEAD, branches, tags, peeled tags. */
function v0RefLines(repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const tip = defaultTip(repo);
  const add = (oid: string, ref: string, first: boolean): void => {
    lines.push(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`);
  };
  let first = true;
  if (tip !== null) {
    add(tip, 'HEAD', first);
    first = false;
  }
  const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of branches) {
    add(repo.refs.get(ref)!, ref, first);
    first = false;
  }
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    add(oid, ref, first);
    first = false;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = parseTag(object.data).object;
      lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  return lines;
}

/** A v0 info/refs advertisement for upload-pack or receive-pack. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const lines = v0RefLines(repo, caps);
  if (lines.length === 0 && service === 'git-receive-pack') {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    for (const line of lines) chunks.push(pktLine(line));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** A protocol v2 info/refs advertisement. */
function advertiseV2(): Buffer {
  const chunks: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('agent=github-core-clone-01/1.0.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(chunks);
}

/** The ls-refs arguments a client sent (peel, unborn, symrefs, ref-prefixes). */
function parseLsRefsArgs(lines: string[]): { peel: boolean; unborn: boolean; symrefs: boolean; prefixes: string[] } {
  const args = { peel: false, unborn: false, symrefs: false, prefixes: [] as string[] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** The v2 ls-refs answer for a repository. */
function lsRefsResponse(repo: Repo, args: { peel: boolean; unborn: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const chunks: Buffer[] = [];
  const matches = (ref: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => ref.startsWith(prefix));
  const tip = defaultTip(repo);
  const lines: string[] = [];
  if (tip !== null && matches('HEAD')) {
    const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${tip} HEAD${symref}\n`);
  }
  const refs = [...repo.refs.keys()].sort();
  for (const ref of refs) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let line = `${oid} ${ref}`;
    const object = repo.objects.get(oid);
    if (args.peel && object !== undefined && object.type === 'tag') {
      line += ` peeled:${parseTag(object.data).object}`;
    }
    lines.push(`${line}\n`);
  }
  if (tip === null && args.unborn && matches('HEAD')) {
    const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`unborn HEAD${symref}\n`);
  }
  for (const line of lines) chunks.push(pktLine(line));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP: fetch
// ---------------------------------------------------------------------------------------------

/** The fetch arguments a client sent (wants, haves, shallow boundaries, deepen). */
function parseFetchArgs(lines: string[]): { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null } {
  const args = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], deepen: null as number | null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) args.deepen = depth;
    }
  }
  return args;
}

/** Add a tree and everything under it (subtrees and blobs) to a set. */
function addTreeObjects(repo: Repo, treeOid: string, into: Map<string, GitObject> | Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (into instanceof Map) {
      if (into.has(oid)) continue;
      into.set(oid, object);
    } else {
      if (into.has(oid)) continue;
      into.add(oid);
    }
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/** Add one object and its own tree (but never a commit's parents) to a set. */
function addCommitObjects(repo: Repo, oid: string, into: Map<string, GitObject> | Set<string>): void {
  const object = repo.objects.get(oid);
  if (object === undefined) return;
  if (into instanceof Map) {
    if (into.has(oid)) return;
    into.set(oid, object);
  } else {
    if (into.has(oid)) return;
    into.add(oid);
  }
  if (object.type === 'commit') {
    const commit = parseCommit(object.data);
    if (commit.tree !== '') addTreeObjects(repo, commit.tree, into);
  } else if (object.type === 'tag') {
    const target = parseTag(object.data).object;
    if (target !== '') addCommitObjects(repo, target, into);
  } else if (object.type === 'tree') {
    addTreeObjects(repo, oid, into);
  }
}

/**
 * The objects a fetch must send: the wanted commits up to the deepen depth, each with its own
 * tree and blobs — never the parents of a shallow boundary commit, and never anything the
 * client already holds. A have the client lists as a shallow boundary is held shallowly
 * (the commit and its tree only); any other have is held with its whole history.
 * Also the shallow boundary commits and the ones that stop being shallow.
 */
function fetchPlan(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  deepen: number | null,
  shallowHeld: readonly string[] = [],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (!depthOf.has(want)) {
      depthOf.set(want, 1);
      queue.push(want);
    }
  }
  const included: string[] = [];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const depth = depthOf.get(oid)!;
    included.push(oid);
    if (deepen !== null && depth >= deepen) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target !== '' && !depthOf.has(target)) {
        depthOf.set(target, depth);
        queue.push(target);
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  const shallow = deepen === null ? [] : included.filter((oid) => depthOf.get(oid) === deepen);
  const unshallow = deepen === null
    ? []
    : haves.filter((have) => depthOf.has(have) && (depthOf.get(have) ?? 0) < deepen);
  const objects = new Map<string, GitObject>();
  for (const oid of included) addCommitObjects(repo, oid, objects);
  const shallowSet = new Set(shallowHeld);
  const held = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) addCommitObjects(repo, have, held);
    else for (const oid of collectReachable(repo, [have])) held.add(oid);
  }
  for (const boundary of shallowHeld) {
    if (!haves.includes(boundary)) addCommitObjects(repo, boundary, held);
  }
  for (const oid of held) objects.delete(oid);
  return { objects, shallow, unshallow };
}

/** A sideband packet (band 1 = pack data, 2 = progress, 3 = error). The band is one raw byte. */
function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktLine(payload);
}

/** The v2 fetch answer: three headed sections (acknowledgments, shallow-info, packfile). */
function fetchResponseV2(repo: Repo, args: { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null }): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  const knownHaves = args.haves.filter((have) => repo.objects.has(have));
  if (args.haves.length === 0 || knownHaves.length === 0) {
    chunks.push(pktLine('NAK\n'));
  } else {
    for (const have of knownHaves) chunks.push(pktLine(`ACK ${have}\n`));
    chunks.push(pktLine('ready\n'));
  }
  chunks.push(pktDelim());
  chunks.push(pktLine('shallow-info\n'));
  const plan = fetchPlan(repo, args.wants, args.haves, args.deepen, args.shallow);
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(pktDelim());
  chunks.push(pktLine('packfile\n'));
  if (plan.objects.size > 0) {
    const pack = writePack([...plan.objects.values()]);
    for (let offset = 0; offset < pack.length; offset += 65515) {
      chunks.push(sideband(1, pack.subarray(offset, offset + 65515)));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** The v0 fetch answer: ACK/NAK and shallow lines, then the pack on sideband band 1. */
function fetchResponseV0(repo: Repo, args: { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null }): Buffer {
  const chunks: Buffer[] = [];
  const knownHaves = args.haves.filter((have) => repo.objects.has(have));
  if (args.haves.length === 0 || knownHaves.length === 0) {
    chunks.push(pktLine('NAK\n'));
  } else {
    for (const have of knownHaves) chunks.push(pktLine(`ACK ${have}\n`));
  }
  const plan = fetchPlan(repo, args.wants, args.haves, args.deepen, args.shallow);
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.size > 0) {
    const pack = writePack([...plan.objects.values()]);
    for (let offset = 0; offset < pack.length; offset += 65515) {
      chunks.push(sideband(1, pack.subarray(offset, offset + 65515)));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP: receive-pack
// ---------------------------------------------------------------------------------------------

/** Whether `oid` is a descendant of `ancestor` (or the same commit). */
function isDescendant(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const stack = [oid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The receive-pack answer: `unpack ok` and one line per ref, on sideband band 1. */
function handleReceivePack(repo: Repo, raw: Buffer): Buffer {
  const { lines, rest } = decodePktLines(raw);
  const updates: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of lines) {
    const clean = line.split('\0')[0]!;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (match !== null) updates.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (rest.length > 0) {
    try {
      for (const object of readPack(rest)) {
        repo.objects.set(hashObject(object.type, object.data), object);
      }
    } catch {
      // A pack the forge cannot read is reported as a failed unpack.
      const chunks: Buffer[] = [sideband(1, Buffer.from('unpack error\n'))];
      for (const update of updates) chunks.push(sideband(1, Buffer.from(`ng ${update.ref} unpack failed\n`)));
      chunks.push(pktFlush());
      return Buffer.concat(chunks);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const update of updates) {
    const current = repo.refs.get(update.ref) ?? null;
    if (update.newOid === ZERO_OID) {
      if (current === null) {
        results.push({ ref: update.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.delete(update.ref);
        results.push({ ref: update.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === null) {
      if (update.oldOid !== ZERO_OID || !repo.objects.has(update.newOid)) {
        results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(update.ref, update.newOid);
      results.push({ ref: update.ref, ok: true, reason: '' });
      continue;
    }
    if (update.oldOid !== current) {
      results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (update.newOid === current) {
      results.push({ ref: update.ref, ok: true, reason: '' });
      continue;
    }
    if (!isDescendant(repo, current, update.newOid)) {
      results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(update.ref, update.newOid);
    results.push({ ref: update.ref, ok: true, reason: '' });
  }
  const chunks: Buffer[] = [sideband(1, Buffer.from('unpack ok\n'))];
  for (const result of results) {
    chunks.push(sideband(1, Buffer.from(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`)));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP: router
// ---------------------------------------------------------------------------------------------

async function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
  const segments = splitPath(pathname);
  if (segments.length < 2) {
    notFound(res);
    return;
  }
  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  const name = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
  learnOwner(owner);
  const repo = findRepo(owner, name);
  if (repo === null) {
    notFound(res, 'Not Found');
    return;
  }
  const service = segments[2];
  if (service === 'info' && segments[3] === 'refs' && req.method === 'GET') {
    const requested = query.get('service');
    if (requested === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      sendRaw(res, 200, v2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (requested === 'git-receive-pack') {
      sendRaw(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    notFound(res);
    return;
  }
  if (service === 'git-upload-pack' && req.method === 'POST') {
    const raw = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const { lines } = decodePktLines(raw);
    if (v2) {
      if (lines[0] === 'command=ls-refs') {
        sendRaw(res, 200, lsRefsResponse(repo, parseLsRefsArgs(lines)), 'application/x-git-upload-pack-result');
        return;
      }
      if (lines[0] === 'command=fetch') {
        sendRaw(res, 200, fetchResponseV2(repo, parseFetchArgs(lines)), 'application/x-git-upload-pack-result');
        return;
      }
      sendJson(res, 400, { message: 'unknown command' });
      return;
    }
    sendRaw(res, 200, fetchResponseV0(repo, parseFetchArgs(lines)), 'application/x-git-upload-pack-result');
    return;
  }
  if (service === 'git-receive-pack' && req.method === 'POST') {
    const raw = await readBody(req);
    sendRaw(res, 200, handleReceivePack(repo, raw), 'application/x-git-receive-pack-result');
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// top-level router
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const query = url.searchParams;
      if (pathname === '/healthz') {
        if (req.method === 'GET') sendJson(res, 200, { ok: true });
        else notFound(res);
        return;
      }
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        await handleRest(req, res, pathname, query);
        return;
      }
      if (pathname === '/api/graphql') {
        await handleGraphQL(req, res);
        return;
      }
      if (pathname === '/mcp') {
        await handleMcp(req, res);
        return;
      }
      const segments = splitPath(pathname);
      if (segments.length >= 2) {
        await handleGit(req, res, pathname, query);
        return;
      }
      notFound(res);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
  return server;
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4: a small parser for the documents gh and github-mcp-server send
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeCondition: string | null; selections: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

interface GqlFragment {
  name: string;
  typeCondition: string;
  selections: GqlSelection[];
}

interface GqlToken {
  type: 'punct' | 'name' | 'string' | 'number' | 'variable' | 'spread';
  value: string;
}

function lexGraphQL(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source.startsWith('...', index)) {
      tokens.push({ type: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if (char === '$') {
      let value = '';
      index += 1;
      while (index < source.length && /[_0-9A-Za-z]/.test(source[index]!)) {
        value += source[index]!;
        index += 1;
      }
      tokens.push({ type: 'variable', value });
      continue;
    }
    if ('{}()[]:!=@'.includes(char)) {
      tokens.push({ type: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1]!;
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === 'u' && index + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else value += escaped;
          index += 2;
          continue;
        }
        value += source[index]!;
        index += 1;
      }
      index += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (index < source.length && /[0-9.eE+-]/.test(source[index]!)) {
        value += source[index]!;
        index += 1;
      }
      tokens.push({ type: 'number', value });
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let value = '';
      while (index < source.length && /[_0-9A-Za-z]/.test(source[index]!)) {
        value += source[index]!;
        index += 1;
      }
      tokens.push({ type: 'name', value });
      continue;
    }
    index += 1;
  }
  return tokens;
}

class GqlParser {
  private index = 0;
  private readonly tokens: GqlToken[];
  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.index];
  }

  private next(): GqlToken {
    return this.tokens[this.index++]!;
  }

  private expect(value: string): GqlToken {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token;
  }

  private is(value: string): boolean {
    return this.peek()?.value === value;
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlFragment> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment>();
    while (this.index < this.tokens.length) {
      if (this.is('fragment')) {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.is('{')) {
      return { kind, name, selections: this.parseSelectionSet() };
    }
    const keyword = this.next().value;
    if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unexpected ${keyword}`);
    kind = keyword;
    if (this.peek()?.type === 'name') name = this.next().value;
    if (this.is('(')) this.parseVariableDefinitions();
    return { kind, name, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (!this.is(')')) {
      this.next(); // $name
      this.expect(':');
      this.parseType();
      if (this.is('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.is('[')) {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    if (this.is('!')) this.next();
  }

  private parseFragment(): GqlFragment {
    this.expect('fragment');
    const name = this.next().value;
    this.expect('on');
    const typeCondition = this.next().value;
    return { name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (!this.is('}')) {
      if (this.peek()?.type === 'spread') {
        this.next();
        if (this.is('on')) {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek()?.type === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): GqlField {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.is(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args: Record<string, GqlValue> = {};
    if (this.is('(')) args = this.parseArguments();
    this.skipDirectives();
    const selections = this.is('{') ? this.parseSelectionSet() : null;
    return { alias, name, args, selections };
  }

  private skipDirectives(): void {
    while (this.is('@')) {
      this.next();
      this.next(); // directive name
      if (this.is('(')) this.parseArguments();
    }
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expect('(');
    const args: Record<string, GqlValue> = {};
    while (!this.is(')')) {
      const name = this.next().value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'variable') return { kind: 'variable', name: token.value };
    if (token.type === 'number') {
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value: Number(token.value) }
        : { kind: 'int', value: Number(token.value) };
    }
    if (token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.is(']')) values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.is('}')) {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name] ?? null;
    case 'list':
      return value.values.map((entry) => resolveGqlValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveGqlValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4: executor
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  variables: Record<string, unknown>;
  fragments: Map<string, GqlFragment>;
  errors: Array<{ message: string }>;
}

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: IssueComment }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; repo: Repo; nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; nodes: PullRequest[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Array<{ path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; typeName: string }
  | { __typename: 'GraphQLType'; name: string | null; kind: string; ofType: GqlObject | null }
  | { __typename: '__Field'; name: string; typeName: string; typeKind: string; required: boolean }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: IssueComment }
  | { __typename: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: IssueComment };

const GRAPHQL_SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: Array<{ name: string; typeName: string; typeKind: string; required: boolean }>; values?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR', required: true },
      { name: 'number', typeName: 'Int', typeKind: 'SCALAR', required: true },
      { name: 'title', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'body', typeName: 'String', typeKind: 'SCALAR', required: false },
      { name: 'state', typeName: 'IssueState', typeKind: 'ENUM', required: true },
      { name: 'author', typeName: 'User', typeKind: 'OBJECT', required: false },
      { name: 'createdAt', typeName: 'DateTime', typeKind: 'SCALAR', required: true },
      { name: 'url', typeName: 'URI', typeKind: 'SCALAR', required: true },
      { name: 'comments', typeName: 'IssueCommentConnection', typeKind: 'OBJECT', required: true },
      { name: 'labels', typeName: 'LabelConnection', typeKind: 'OBJECT', required: true },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR', required: true },
      { name: 'number', typeName: 'Int', typeKind: 'SCALAR', required: true },
      { name: 'title', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'body', typeName: 'String', typeKind: 'SCALAR', required: false },
      { name: 'state', typeName: 'PullRequestState', typeKind: 'ENUM', required: true },
      { name: 'merged', typeName: 'Boolean', typeKind: 'SCALAR', required: true },
      { name: 'mergeable', typeName: 'MergeableState', typeKind: 'ENUM', required: true },
      { name: 'headRefName', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'baseRefName', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'files', typeName: 'PullRequestChangedFileConnection', typeKind: 'OBJECT', required: true },
      { name: 'headRef', typeName: 'Ref', typeKind: 'OBJECT', required: false },
      { name: 'baseRef', typeName: 'Ref', typeKind: 'OBJECT', required: false },
      { name: 'author', typeName: 'User', typeKind: 'OBJECT', required: false },
      { name: 'createdAt', typeName: 'DateTime', typeKind: 'SCALAR', required: true },
      { name: 'url', typeName: 'URI', typeKind: 'SCALAR', required: true },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR', required: true },
      { name: 'databaseId', typeName: 'Int', typeKind: 'SCALAR', required: true },
      { name: 'name', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'nameWithOwner', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'owner', typeName: 'User', typeKind: 'OBJECT', required: true },
      { name: 'defaultBranchRef', typeName: 'Ref', typeKind: 'OBJECT', required: false },
      { name: 'viewerPermission', typeName: 'RepositoryPermission', typeKind: 'ENUM', required: true },
      { name: 'hasIssuesEnabled', typeName: 'Boolean', typeKind: 'SCALAR', required: true },
      { name: 'issue', typeName: 'Issue', typeKind: 'OBJECT', required: false },
      { name: 'issues', typeName: 'IssueConnection', typeKind: 'OBJECT', required: true },
      { name: 'pullRequests', typeName: 'PullRequestConnection', typeKind: 'OBJECT', required: true },
      { name: 'pullRequest', typeName: 'PullRequest', typeKind: 'OBJECT', required: false },
      { name: 'description', typeName: 'String', typeKind: 'SCALAR', required: false },
      { name: 'createdAt', typeName: 'DateTime', typeKind: 'SCALAR', required: true },
      { name: 'url', typeName: 'URI', typeKind: 'SCALAR', required: true },
    ],
  },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'] },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR', required: true },
      { name: 'login', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'name', typeName: 'String', typeKind: 'SCALAR', required: false },
      { name: 'url', typeName: 'URI', typeKind: 'SCALAR', required: true },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR', required: true },
      { name: 'name', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'target', typeName: 'GitObject', typeKind: 'OBJECT', required: false },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', typeName: 'Issue', typeKind: 'OBJECT', required: false },
      { name: 'pageInfo', typeName: 'PageInfo', typeKind: 'OBJECT', required: true },
      { name: 'totalCount', typeName: 'Int', typeKind: 'SCALAR', required: true },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', typeName: 'PullRequest', typeKind: 'OBJECT', required: false },
      { name: 'pageInfo', typeName: 'PageInfo', typeKind: 'OBJECT', required: true },
      { name: 'totalCount', typeName: 'Int', typeKind: 'SCALAR', required: true },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR', required: true },
      { name: 'body', typeName: 'String', typeKind: 'SCALAR', required: true },
      { name: 'author', typeName: 'User', typeKind: 'OBJECT', required: false },
      { name: 'createdAt', typeName: 'DateTime', typeKind: 'SCALAR', required: true },
    ],
  },
};

function repoGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.owner ?? viewer()}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.owner ?? viewer()}/${repo.name}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return b64url(`PullRequest:${repo.owner ?? viewer()}/${repo.name}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return b64url(`IssueComment:${repo.owner ?? viewer()}/${repo.name}:${issue.number}:${comment.id}`);
}

/**
 * Decode one of the forge's global ids back to the object it names. An id is
 * `Kind:owner/name` plus, for issues and pull requests, `:number`, and for a comment
 * `:issue:commentId` — so the owner/name is one colon-separated segment, not two.
 */
function decodeGlobalId(id: string): GqlObject | null {
  const text = unb64url(id);
  if (text === null) return null;
  const parts = text.split(':');
  const kind = parts[0];
  const ownerAndName = parts[1];
  if (kind === undefined || ownerAndName === undefined) return null;
  const slash = ownerAndName.indexOf('/');
  if (slash < 0) return null;
  const owner = ownerAndName.slice(0, slash);
  const name = ownerAndName.slice(slash + 1);
  const repo = repoByName(name);
  if (repo === undefined) return null;
  if (repo.owner === null) repo.owner = owner;
  if (repo.owner !== owner) return null;
  if (kind === 'Repository' && parts.length === 2) return { __typename: 'Repository', repo };
  if (kind === 'Issue' && parts.length === 3) {
    const issue = repo.issues.get(Number(parts[2]));
    if (issue === undefined) return null;
    return { __typename: 'Issue', repo, issue };
  }
  if (kind === 'PullRequest' && parts.length === 3) {
    const pull = repo.pulls.get(Number(parts[2]));
    if (pull === undefined) return null;
    return { __typename: 'PullRequest', repo, pull };
  }
  if (kind === 'IssueComment' && parts.length === 4) {
    const issue = repo.issues.get(Number(parts[2]));
    if (issue === undefined) return null;
    const comment = issue.comments.find((candidate) => candidate.id === Number(parts[3]));
    if (comment === undefined) return null;
    return { __typename: 'IssueComment', repo, issue, comment };
  }
  return null;
}

function createIssueObject(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: nextIssueId,
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: nextSeq(),
  };
  nextIssueId += 1;
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullObject(repo: Repo, title: string, head: string, base: string, body: string): PullRequest | null {
  const headSha = resolveRef(repo, head);
  const baseSha = resolveRef(repo, base);
  if (headSha === null || baseSha === null) return null;
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head) return pull;
  }
  const pull: PullRequest = {
    id: nextPullId,
    number: repo.nextPullNumber,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: nextSeq(),
  };
  nextPullId += 1;
  repo.nextPullNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function mergePullObject(repo: Repo, pull: PullRequest): boolean {
  if (pull.merged && pull.mergeCommitSha !== null) return true;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  if (mergeConflicts(repo, baseTip, pull.headSha)) return false;
  const headTree = treeOfCommit(repo, pull.headSha);
  const message = `Merge pull request #${pull.number} from ${viewer()}/${pull.headRef}`;
  const mergeSha = makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stampOf(nextSeq());
  pull.mergeCommitSha = mergeSha;
  return true;
}

function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return 'UNKNOWN';
  if (!repo.objects.has(pull.headSha)) return 'UNKNOWN';
  return mergeConflicts(repo, baseTip, pull.headSha) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveSelections(obj: GqlObject, selections: GqlSelection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.field.alias ?? selection.field.name;
      out[key] = resolveField(obj, selection.field, ctx);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === obj.__typename) {
        Object.assign(out, resolveSelections(obj, selection.selections, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === obj.__typename)) {
        Object.assign(out, resolveSelections(obj, fragment.selections, ctx));
      }
    }
  }
  return out;
}

/** Apply a field's sub-selection to a value (an object or a list of objects). */
function applySelection(value: unknown, field: GqlField, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (field.selections === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry !== null && typeof entry === 'object' && '__typename' in entry) {
        return resolveSelections(entry as GqlObject, field.selections!, ctx);
      }
      return entry;
    });
  }
  if (typeof value === 'object' && '__typename' in value) {
    return resolveSelections(value as GqlObject, field.selections, ctx);
  }
  return value;
}

function argOf(field: GqlField, name: string, ctx: GqlContext): unknown {
  const value = field.args[name];
  if (value === undefined) return undefined;
  return resolveGqlValue(value, ctx.variables);
}

function resolveField(obj: GqlObject, field: GqlField, ctx: GqlContext): unknown {
  const value = resolveFieldRaw(obj, field, ctx);
  return applySelection(value, field, ctx);
}

function resolveFieldRaw(obj: GqlObject, field: GqlField, ctx: GqlContext): unknown {
  const name = field.name;
  switch (obj.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: viewer() };
      if (name === 'repository') {
        const owner = argOf(field, 'owner', ctx);
        const repoName = argOf(field, 'name', ctx);
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const repo = findRepo(owner, repoName);
        return repo === null ? null : { __typename: 'Repository', repo };
      }
      if (name === 'node') {
        const id = argOf(field, 'id', ctx);
        if (typeof id !== 'string') return null;
        return decodeGlobalId(id);
      }
      if (name === '__type') {
        const typeName = argOf(field, 'name', ctx);
        if (typeof typeName !== 'string') return null;
        return { __typename: '__Type', typeName };
      }
      break;
    }
    case 'Mutation': {
      const input = argOf(field, 'input', ctx);
      const inputRecord = isRecord(input) ? input : {};
      if (name === 'createIssue') {
        const decoded = typeof inputRecord.repositoryId === 'string' ? decodeGlobalId(inputRecord.repositoryId) : null;
        if (decoded === null || decoded.__typename !== 'Repository') return null;
        const issue = createIssueObject(decoded.repo, typeof inputRecord.title === 'string' ? inputRecord.title : '', typeof inputRecord.body === 'string' ? inputRecord.body : '');
        return { __typename: 'CreateIssuePayload', repo: decoded.repo, issue };
      }
      if (name === 'closeIssue') {
        const decoded = typeof inputRecord.issueId === 'string' ? decodeGlobalId(inputRecord.issueId) : null;
        if (decoded === null || decoded.__typename !== 'Issue') return null;
        decoded.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', repo: decoded.repo, issue: decoded.issue };
      }
      if (name === 'createPullRequest') {
        const decoded = typeof inputRecord.repositoryId === 'string' ? decodeGlobalId(inputRecord.repositoryId) : null;
        if (decoded === null || decoded.__typename !== 'Repository') return null;
        const pull = createPullObject(
          decoded.repo,
          typeof inputRecord.title === 'string' ? inputRecord.title : '',
          typeof inputRecord.headRefName === 'string' ? inputRecord.headRefName : '',
          typeof inputRecord.baseRefName === 'string' ? inputRecord.baseRefName : decoded.repo.defaultBranch,
          typeof inputRecord.body === 'string' ? inputRecord.body : '',
        );
        if (pull === null) return null;
        return { __typename: 'CreatePullRequestPayload', repo: decoded.repo, pull };
      }
      if (name === 'mergePullRequest') {
        const decoded = typeof inputRecord.pullRequestId === 'string' ? decodeGlobalId(inputRecord.pullRequestId) : null;
        if (decoded === null || decoded.__typename !== 'PullRequest') return null;
        mergePullObject(decoded.repo, decoded.pull);
        return { __typename: 'MergePullRequestPayload', repo: decoded.repo, pull: decoded.pull };
      }
      if (name === 'addComment') {
        const decoded = typeof inputRecord.subjectId === 'string' ? decodeGlobalId(inputRecord.subjectId) : null;
        if (decoded === null || decoded.__typename !== 'Issue') return null;
        const comment: IssueComment = { id: nextCommentId, body: typeof inputRecord.body === 'string' ? inputRecord.body : '', seq: nextSeq() };
        nextCommentId += 1;
        decoded.issue.comments.push(comment);
        return { __typename: 'AddCommentPayload', repo: decoded.repo, issue: decoded.issue, comment };
      }
      break;
    }
    case 'User': {
      if (name === 'login') return obj.login;
      if (name === 'id') return b64url(`User:${obj.login}`);
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      const owner = repo.owner ?? viewer();
      if (name === 'id') return repoGlobalId(repo);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: owner };
      if (name === 'defaultBranchRef') {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'createdAt') return stampOf(repo.createdSeq);
      if (name === 'issue') {
        const number = argOf(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { __typename: 'Issue', repo, issue };
      }
      if (name === 'issues') {
        const states = argOf(field, 'states', ctx);
        const orderBy = argOf(field, 'orderBy', ctx);
        const after = argOf(field, 'after', ctx);
        const first = argOf(field, 'first', ctx);
        let items = [...repo.issues.values()];
        if (Array.isArray(states)) {
          items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const order = isRecord(orderBy) ? orderBy : {};
        if (order.field === 'CREATED_AT') {
          items.sort((a, b) => (order.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        } else {
          items.sort((a, b) => a.number - b.number);
        }
        let startIndex = 0;
        if (typeof after === 'string' && after !== '') {
          const decoded = unb64url(after);
          const num = decoded === null ? Number.NaN : Number(decoded.split(':')[1]);
          const index = items.findIndex((issue) => issue.number === num);
          if (index >= 0) startIndex = index + 1;
        }
        const count = typeof first === 'number' ? first : items.length;
        const page = items.slice(startIndex, startIndex + count);
        const hasNextPage = startIndex + count < items.length;
        const endCursor = page.length > 0 ? b64url(`cursor:${page[page.length - 1]!.number}`) : null;
        return { __typename: 'IssueConnection', repo, nodes: page, pageInfo: { hasNextPage, endCursor } };
      }
      if (name === 'pullRequests') {
        const first = argOf(field, 'first', ctx);
        const items = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        const count = typeof first === 'number' ? first : items.length;
        const page = items.slice(0, count);
        return {
          __typename: 'PullRequestConnection',
          repo,
          nodes: page,
          pageInfo: { hasNextPage: count < items.length, endCursor: page.length > 0 ? b64url(`cursor:${page[page.length - 1]!.number}`) : null },
        };
      }
      if (name === 'pullRequest') {
        const number = argOf(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
      }
      break;
    }
    case 'Issue': {
      if (name === 'id') return issueGlobalId(obj.repo, obj.issue);
      if (name === 'number') return obj.issue.number;
      if (name === 'title') return obj.issue.title;
      if (name === 'body') return obj.issue.body;
      if (name === 'state') return obj.issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'author') return { __typename: 'User', login: obj.repo.owner ?? viewer() };
      if (name === 'createdAt') return stampOf(obj.issue.seq);
      break;
    }
    case 'PullRequest': {
      if (name === 'id') return pullGlobalId(obj.repo, obj.pull);
      if (name === 'number') return obj.pull.number;
      if (name === 'title') return obj.pull.title;
      if (name === 'body') return obj.pull.body;
      if (name === 'state') return obj.pull.merged ? 'MERGED' : obj.pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return obj.pull.merged;
      if (name === 'mergeable') return pullMergeable(obj.repo, obj.pull);
      if (name === 'headRefName') return obj.pull.headRef;
      if (name === 'baseRefName') return obj.pull.baseRef;
      if (name === 'headRef') return { __typename: 'Ref', name: obj.pull.headRef };
      if (name === 'baseRef') return { __typename: 'Ref', name: obj.pull.baseRef };
      if (name === 'author') return { __typename: 'User', login: obj.repo.owner ?? viewer() };
      if (name === 'createdAt') return stampOf(obj.pull.seq);
      if (name === 'files') {
        const base = mergeBase(obj.repo, obj.pull.baseSha, obj.pull.headSha) ?? obj.pull.baseSha;
        const changes = diffTrees(obj.repo, treeOfCommit(obj.repo, base), treeOfCommit(obj.repo, obj.pull.headSha));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: changes.filter((change) => change.status !== 'removed').map((change) => ({ path: change.path })),
        };
      }
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return commentGlobalId(obj.repo, obj.issue, obj.comment);
      if (name === 'body') return obj.comment.body;
      if (name === 'author') return { __typename: 'User', login: obj.repo.owner ?? viewer() };
      if (name === 'createdAt') return stampOf(obj.comment.seq);
      break;
    }
    case 'Ref': {
      if (name === 'name') return obj.name;
      break;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return obj.nodes.map((issue) => ({ __typename: 'Issue', repo: obj.repo, issue }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', ...obj.pageInfo };
      if (name === 'totalCount') return obj.nodes.length;
      break;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return obj.nodes.map((pull) => ({ __typename: 'PullRequest', repo: obj.repo, pull }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', ...obj.pageInfo };
      if (name === 'totalCount') return obj.nodes.length;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return obj.nodes.map((entry) => ({ __typename: 'PullRequestChangedFile', path: entry.path }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (name === 'totalCount') return obj.nodes.length;
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return obj.path;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return obj.hasNextPage;
      if (name === 'endCursor') return obj.endCursor;
      break;
    }
    case '__Type': {
      const entry = GRAPHQL_SCHEMA[obj.typeName];
      if (entry === undefined) return null;
      if (name === 'name') return obj.typeName;
      if (name === 'kind') return entry.kind;
      if (name === 'fields') {
        if (entry.kind !== 'OBJECT' || entry.fields === undefined) return null;
        return entry.fields.map((entryField) => ({ __typename: '__Field', ...entryField }));
      }
      if (name === 'enumValues') {
        if (entry.kind !== 'ENUM' || entry.values === undefined) return null;
        return entry.values.map((value) => ({ __typename: '__EnumValue', name: value }));
      }
      break;
    }
    case 'GraphQLType': {
      if (name === 'name') return obj.name;
      if (name === 'kind') return obj.kind;
      if (name === 'ofType') return obj.ofType;
      break;
    }
    case '__Field': {
      if (name === 'name') return obj.name;
      if (name === 'type') {
        const inner: GqlObject = { __typename: 'GraphQLType', name: obj.typeName, kind: obj.typeKind, ofType: null };
        return obj.required
          ? { __typename: 'GraphQLType', name: null, kind: 'NON_NULL', ofType: inner }
          : inner;
      }
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return obj.name;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return { __typename: 'Issue', repo: obj.repo, issue: obj.issue };
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return { __typename: 'PullRequest', repo: obj.repo, pull: obj.pull };
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return { __typename: 'IssueCommentEdge', repo: obj.repo, issue: obj.issue, comment: obj.comment };
      break;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return { __typename: 'IssueComment', repo: obj.repo, issue: obj.issue, comment: obj.comment };
      break;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${obj.__typename}".` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4: handler
// ---------------------------------------------------------------------------------------------

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = checkAuth(req);
  if (auth !== 'ok') {
    unauthorized(res);
    return;
  }
  if (req.method !== 'POST') {
    notFound(res);
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    badJson(res);
    return;
  }
  const run = (operation: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof operation.query === 'string' ? operation.query : '';
    const variables = isRecord(operation.variables) ? operation.variables : {};
    const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
    try {
      const { operations, fragments } = new GqlParser(lexGraphQL(query)).parseDocument();
      const selected = operationName !== null
        ? operations.find((candidate) => candidate.name === operationName) ?? operations[0]
        : operations[0];
      if (selected === undefined) return { data: null, errors: [{ message: 'no operation found' }] };
      const ctx: GqlContext = { variables, fragments, errors: [] };
      const root: GqlObject = selected.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
      const data = resolveSelections(root, selected.selections, ctx);
      const out: Record<string, unknown> = { data };
      if (ctx.errors.length > 0) out.errors = ctx.errors;
      return out;
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
    }
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => (isRecord(entry) ? run(entry) : { data: null, errors: [{ message: 'invalid operation' }] })));
    return;
  }
  if (isRecord(body)) {
    sendJson(res, 200, run(body));
    return;
  }
  badJson(res);
}

// ---------------------------------------------------------------------------------------------
// MCP: Model Context Protocol over streamable HTTP
// ---------------------------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'github-core-clone-01', version: '1.0.0' };

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state to filter by: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state to filter by: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** A tool call's answer: text JSON plus the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** A tool call that failed because its arguments were missing or the object was not found. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function mcpRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || name === '') return null;
  learnOwner(owner);
  return findRepo(owner, name);
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (repoName === '') return toolError('name is required');
    if (repoByName(repoName) !== undefined) return toolError('Repository already exists');
    const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    const owner = viewer();
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${owner}/${repo.name}`,
      owner: { login: owner },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }
  if (name === 'get_repo') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') return toolError('title is required');
    const issue = createIssueObject(repo, title, typeof args.body === 'string' ? args.body : '');
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let items = [...repo.issues.values()];
    if (state !== 'all') items = items.filter((issue) => issue.state === state);
    items.sort((a, b) => a.number - b.number);
    return toolResult(items.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'get_issue') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    const number = Number(args.issue_number);
    const issue = repo.issues.get(number);
    if (issue === undefined) return toolError('Issue not found');
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'create_pull_request') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    if (title === '' || head === '') return toolError('title and head are required');
    const pull = createPullObject(repo, title, head, base, typeof args.body === 'string' ? args.body : '');
    if (pull === null) return toolError('head or base branch does not exist');
    const result = pullJson(repo, pull);
    result.pull_number = pull.number;
    return toolResult(result);
  }
  if (name === 'list_pull_requests') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let items = [...repo.pulls.values()];
    if (state !== 'all') items = items.filter((pull) => pull.state === state);
    items.sort((a, b) => a.number - b.number);
    return toolResult(items.map((pull) => pullJson(repo, pull)));
  }
  if (name === 'merge_pull_request') {
    const repo = mcpRepo(args);
    if (repo === null) return toolError('Repository not found');
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError('Pull request not found');
    const merged = mergePullObject(repo, pull);
    if (!merged) return toolError('Pull request has conflicts');
    const result = pullJson(repo, pull);
    result.pull_number = pull.number;
    result.sha = pull.mergeCommitSha;
    return toolResult(result);
  }
  return toolError(`unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = checkAuth(req);
  if (auth !== 'ok') {
    unauthorized(res);
    return;
  }
  if (req.method !== 'POST') {
    notFound(res);
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};
  // A notification (no id) is accepted with no body.
  if (id === null && method.startsWith('notifications/')) {
    sendEmpty(res, 202);
    return;
  }
  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'server/discover') {
    reply({
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-03-26'],
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    reply({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    });
    return;
  }
  if (method === 'ping') {
    reply({});
    return;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      replyError(-32602, `unknown tool: ${toolName}`);
      return;
    }
    const schema = tool.inputSchema as { required?: string[] };
    const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      reply({ ...toolError(`missing required arguments: ${missing.join(', ')}`), isError: true });
      return;
    }
    reply(callMcpTool(toolName, args));
    return;
  }
  replyError(-32601, `method not found: ${method}`);
}
