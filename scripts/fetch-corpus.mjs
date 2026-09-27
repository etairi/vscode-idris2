#!/usr/bin/env node
// Fetches the real-world corpora pinned in test/corpus/corpus.json into .corpus/<name>
// (git-ignored), for test/grammar/corpus.test.ts.
//
// Each corpus is a shallow, sparse, blob-less fetch of exactly the pinned commit, limited to the
// entry's `paths`. A corpus already checked out at its commit with those paths is left alone
// and needs no network, so the script can run before every corpus test. A checkout at another
// commit (the pin moved) is updated in place. Nothing fetched here is ever copied into the
// repository (several corpora declare no licence that would allow it).
//
// Usage: node scripts/fetch-corpus.mjs     (requires git; network only for a missing or moved corpus)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { corpora } = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'corpus', 'corpus.json'), 'utf8'));
const root = path.join(repo, '.corpus');

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) {
    throw new Error(`cannot run git: ${r.error.message}`);
  }
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

function mustGit(cwd, ...args) {
  const r = git(cwd, ...args);
  if (!r.ok) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.err}`);
  }
  return r.out;
}

/** True when `dir` is a checkout of `commit` whose sparse paths are exactly `paths`. */
function isCurrent(dir, commit, paths) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return false;
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  const sparse = git(dir, 'sparse-checkout', 'list');
  return head.ok && head.out === commit && sparse.ok &&
    sparse.out.split('\n').sort().join('\n') === [...paths].sort().join('\n') &&
    paths.every((p) => fs.existsSync(path.join(dir, p)));
}

fs.mkdirSync(root, { recursive: true });
let failed = 0;
for (const { name, url, commit, paths } of corpora) {
  const dir = path.join(root, name);
  if (isCurrent(dir, commit, paths)) {
    console.log(`${name}: present at ${commit.slice(0, 12)}`);
    continue;
  }
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      mustGit(dir, 'init', '--quiet');
      mustGit(dir, 'remote', 'add', 'origin', url);
    } else {
      mustGit(dir, 'remote', 'set-url', 'origin', url);
    }
    mustGit(dir, 'sparse-checkout', 'set', ...paths);
    console.log(`${name}: fetching ${url} at ${commit.slice(0, 12)} (${paths.join(', ')})`);
    mustGit(dir, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit);
    mustGit(dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit);
    if (!isCurrent(dir, commit, paths)) {
      throw new Error(`checkout of ${commit} is incomplete`);
    }
    console.log(`${name}: checked out`);
  } catch (e) {
    failed++;
    console.error(`${name}: ${e.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
