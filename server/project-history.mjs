import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_NATIVE_PCB_SNAPSHOT_BYTES,
  parseProject,
  serializeProject,
} from './project-format.mjs';

const ref = 'refs/heads/main';
const objectId = /^[0-9a-f]{40}$/;
const maxSource = MAX_NATIVE_PCB_SNAPSHOT_BYTES;
const snapshotFile = 'project.openpe.json';

function snapshotTreeEntry(blob) {
  return `100644 blob ${blob}\t${snapshotFile}`;
}

// Private bare repositories never discover or modify a user's working repository.
// Only the Electron main process resolves native grants into paths.
export class ProjectHistory {
  constructor(dataDir, grants, { executable = 'git', timeout = 15_000 } = {}) {
    this.root = path.join(dataDir, 'project-history-v1');
    this.grants = grants;
    this.executable = executable;
    this.timeout = timeout;
    this.busy = new Set();
    this.children = new Set();
    this.closed = false;
  }

  close() {
    this.closed = true;
    for (const child of this.children) child.kill();
  }

  async run(repo, args, input = '', limit = 1_000_000, allowed = [0]) {
    if (this.closed) throw new Error('Version history is shutting down.');
    // Ignore inherited repository, config, credential and identity overrides.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_AUTHOR_NAME: 'OpenPE',
      GIT_AUTHOR_EMAIL: 'local@openpe.invalid',
      GIT_COMMITTER_NAME: 'OpenPE',
      GIT_COMMITTER_EMAIL: 'local@openpe.invalid',
    });
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.executable,
        [
          '--no-pager',
          '-c',
          `core.hooksPath=${path.join(this.root, 'disabled-hooks')}`,
          '-c',
          'commit.gpgSign=false',
          '-c',
          'gc.auto=0',
          ...(repo ? ['--git-dir', repo] : []),
          ...args,
        ],
        { env, cwd: this.root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.children.add(child);
      let size = 0,
        failure;
      const out = [],
        err = [];
      const stop = (message) => {
        failure = new Error(message);
        child.kill();
      };
      const timer = setTimeout(() => stop('Git timed out. Retry version history.'), this.timeout);
      child.stdout.on('data', (data) => {
        size += data.length;
        if (size > limit) stop('Git output exceeds the version history limit.');
        else out.push(data);
      });
      child.stderr.on('data', (data) => {
        size += data.length;
        if (size > limit) stop('Git output exceeds the version history limit.');
        else err.push(data);
      });
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        failure = new Error(
          error.code === 'ENOENT'
            ? 'Git was not found. Install Git and restart OpenPE to use version history.'
            : `Git could not start: ${error.message}`,
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (failure) reject(failure);
        else if (!allowed.includes(code))
          reject(
            new Error(
              `Git failed: ${Buffer.concat(err).toString('utf8').slice(0, 2000).trim() || code}`,
            ),
          );
        else resolve({ text: Buffer.concat(out).toString('utf8'), code });
      });
      child.stdin.end(input);
    });
  }

  async withProject(fileId, action) {
    const file = this.grants.get(fileId);
    if (!file) throw new Error('Save this project before using version history.');
    const normalized =
      process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const repo = path.join(
      this.root,
      createHash('sha256').update(normalized).digest('hex') + '.git',
    );
    if (this.busy.has(repo)) throw new Error('A version history operation is already running.');
    this.busy.add(repo);
    try {
      await mkdir(this.root, { recursive: true });
      return await action(repo);
    } finally {
      this.busy.delete(repo);
    }
  }

  async exists(repo) {
    try {
      await stat(repo);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async head(repo) {
    const result = await this.run(
      repo,
      ['rev-parse', '--verify', '--quiet', ref],
      '',
      1000,
      [0, 1],
    );
    if (result.code === 1) return null;
    return this.checkId(result.text.trim());
  }

  async initialize(repo) {
    await this.run(null, [
      'init',
      '--bare',
      '--initial-branch=main',
      '--object-format=sha1',
      '--template=',
      repo,
    ]);
  }

  async writeSnapshotTree(repo, content) {
    const blob = this.checkId(
      (await this.run(repo, ['hash-object', '-w', '--stdin'], content)).text.trim(),
    );
    const tree = await this.run(repo, ['mktree'], snapshotTreeEntry(blob) + '\n');
    return this.checkId(tree.text.trim());
  }

  checkId(id) {
    if (typeof id !== 'string' || !objectId.test(id)) throw new Error('Invalid version ID.');
    return id;
  }

  canonical(source) {
    if (typeof source !== 'string' || Buffer.byteLength(source) > maxSource)
      throw new Error(
        'Private project snapshots must be valid JSON within the project size limit.',
      );
    const result = serializeProject(parseProject(source));
    if (Buffer.byteLength(result) > maxSource) throw new Error('Project snapshot exceeds 8 MB.');
    return result;
  }

  async list(fileId, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000)
      throw new Error('Invalid history page.');
    if (!this.grants.get(fileId)) return { version: '', commits: [], more: false, needsSave: true };
    return this.withProject(fileId, async (repo) => {
      const version = (await this.run(null, ['--version'])).text.trim();
      if (!(await this.exists(repo)) || !(await this.head(repo)))
        return { version, commits: [], more: false };
      const log = await this.run(repo, [
        'log',
        ref,
        '--first-parent',
        '--no-show-signature',
        '--max-count=51',
        `--skip=${offset}`,
        '--format=%H%x00%cI%x00%s',
      ]);
      const rows = log.text
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, date, message] = line.split('\0');
          return { id: this.checkId(id), date, message };
        });
      return { version, commits: rows.slice(0, 50), more: rows.length > 50 };
    });
  }

  async read(fileId, id) {
    this.checkId(id);
    return this.withProject(fileId, async (repo) => {
      if (!(await this.exists(repo)) || !(await this.head(repo)))
        throw new Error('No versions have been created.');
      const reachable = await this.run(
        repo,
        ['merge-base', '--is-ancestor', id, ref],
        '',
        1000,
        [0, 1],
      );
      if (reachable.code !== 0)
        throw new Error('This version does not belong to this project history.');
      const source = (
        await this.run(repo, ['cat-file', 'blob', `${id}:${snapshotFile}`], '', maxSource)
      ).text;
      return this.canonical(source);
    });
  }

  async create(fileId, source, message) {
    const content = this.canonical(source);
    if (
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 240 ||
      /[\x00-\x1f\x7f]/.test(message)
    )
      throw new Error('Enter a version name of 1–240 characters on one line.');
    return this.withProject(fileId, async (repo) => {
      if (!(await this.exists(repo))) await this.initialize(repo);
      const parent = await this.head(repo);
      const tree = await this.writeSnapshotTree(repo, content);
      if (parent) {
        const previous = (await this.run(repo, ['rev-parse', `${parent}^{tree}`])).text.trim();
        if (tree === previous) throw new Error('This project matches the latest version.');
      }
      const id = this.checkId(
        (
          await this.run(
            repo,
            ['commit-tree', tree, ...(parent ? ['-p', parent] : [])],
            message.trim() + '\n',
          )
        ).text.trim(),
      );
      // Compare-and-swap preserves history if another process publishes concurrently.
      await this.run(repo, ['update-ref', ref, id, parent ?? '0'.repeat(40)]);
      return { id };
    });
  }

  // Trusted example preparation can refresh a sole automatic root commit.
  async ensureExampleInitial(fileId, source) {
    const file = this.grants.get(fileId);
    if (!file || !this.grants.isLocalExample(fileId))
      throw new Error('Only an example may initialize its initial history.');
    const content = this.canonical(source);
    return this.withProject(fileId, async (repo) => {
      let parent;
      if (!(await this.exists(repo))) {
        await this.initialize(repo);
      } else {
        // Inspect refs, parent and author together before reading the tree.
        const references = (
          await this.run(
            repo,
            [
              'for-each-ref',
              '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(parent)%00%(authorname)%00%(authoremail)%00%(subject)',
            ],
            '',
            4000,
          )
        ).text.trimEnd();
        if (references) {
          const [name, id, type, previous, author, email, subject, ...extra] =
            references.split('\0');
          if (
            extra.length ||
            name !== ref ||
            !objectId.test(id) ||
            type !== 'commit' ||
            previous !== '' ||
            author !== 'OpenPE' ||
            email !== '<local@openpe.invalid>' ||
            subject !== 'init'
          )
            return;
          parent = id;
          const blob = createHash('sha1')
            .update(`blob ${Buffer.byteLength(content)}\0`)
            .update(content)
            .digest('hex');
          const tree = (await this.run(repo, ['ls-tree', parent], '', 1000)).text.trim();
          if (tree === snapshotTreeEntry(blob)) return;
        }
      }
      const tree = await this.writeSnapshotTree(repo, content);
      const id = this.checkId((await this.run(repo, ['commit-tree', tree], 'init\n')).text.trim());
      await this.run(repo, ['update-ref', ref, id, parent ?? '0'.repeat(40)]);
      if (parent) {
        // Prune the superseded automatic seed.
        await this.run(repo, ['reflog', 'expire', '--expire=now', '--all']);
        await this.run(repo, ['gc', '--prune=now']);
      }
    });
  }
}
