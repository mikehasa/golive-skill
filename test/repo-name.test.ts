/**
 * Issue #64: a new provider project must not be named after the folder golive happened to run in.
 * The repository's `origin` remote wins when it can be read; the folder stays the fallback, and the
 * plan names which one it used (a worktree or a second checkout then proposes the same name).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { repoIdentity } from '../src/core/repo.js';
import { buildPlan, planView } from '../src/core/plan.js';
import { projectsLink } from '../src/links/projects.js';
import { resetMemo } from '../src/links/util.js';
import type { Adapter, Exec, ProjectRef } from '../src/core/types.js';
import { mockExec, testCtx } from './helpers.js';

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

/** A directory that looks like a worktree root: `.git` is a file pointing at the main checkout. */
function worktree(name: string): string {
  root = mkdtempSync(join(tmpdir(), `golive-${name}-`));
  writeFileSync(join(root, '.git'), 'gitdir: /main/.git/worktrees/whatever\n');
  return root;
}

const remote = (url: string) => mockExec([['git config --get remote.origin.url', { code: 0, stdout: `${url}\n` }]]);

describe('repository identity for default project names', () => {
  it('takes the name from the git origin remote, not the worktree folder', async () => {
    const cwd = worktree('setup-deploy-b59cf2');
    const { run, calls } = remote('https://github.com/mikehasa/golive-gstack-demo.git');
    expect(await repoIdentity(testCtx({ exec: run, cwd }))).toEqual({
      name: 'golive-gstack-demo',
      from: 'git-remote',
      folder: basename(cwd),
    });
    // One read per run: the whole plan shares the answer.
    expect(calls.filter((c) => c.cmd === 'git')).toHaveLength(1);
  });

  it('reads scp-style and ssh remotes, and slugifies what provider names cannot carry', async () => {
    for (const [url, name] of [
      ['git@github.com:acme/My_Repo.git', 'my-repo'],
      ['ssh://git@github.com:22/acme/shop.frontend', 'shop-frontend'],
      ['https://gitlab.com/acme/demo/', 'demo'],
    ] as const) {
      const cwd = worktree('wt');
      const { run } = remote(url);
      expect((await repoIdentity(testCtx({ exec: run, cwd }))).name, url).toBe(name);
    }
  });

  it('falls back to the working folder without a .git and never shells out', async () => {
    root = mkdtempSync(join(tmpdir(), 'golive-plain-'));
    const calls = mockExec([]);
    const ctx = testCtx({ exec: calls.run, cwd: root });
    expect(await repoIdentity(ctx)).toEqual({ name: basename(root).toLowerCase(), from: 'folder', folder: basename(root) });
    expect(calls.calls).toHaveLength(0);
  });

  it('keeps the folder name in a subdirectory of a repository, so two apps never share one name', async () => {
    root = mkdtempSync(join(tmpdir(), 'golive-monorepo-'));
    const app = join(root, 'apps', 'billing');
    mkdirSync(app, { recursive: true });
    const calls = mockExec([]);
    expect(await repoIdentity(testCtx({ exec: calls.run, cwd: app }))).toMatchObject({ name: 'billing', from: 'folder' });
    expect(calls.calls).toHaveLength(0);
  });

  it('falls back to the folder when git cannot answer, and caches the answer per run', async () => {
    const cwd = worktree('scratch');
    const failing = mockExec([['git config --get remote.origin.url', { code: 1 }]]);
    const ctx = testCtx({ exec: failing.run, cwd });
    expect(await repoIdentity(ctx)).toMatchObject({ name: basename(cwd).toLowerCase(), from: 'folder' });
    expect(await repoIdentity(ctx)).toMatchObject({ from: 'folder' });
    expect(failing.calls).toHaveLength(1);
  });
});

describe('the create step names where its project name came from', () => {
  function fakeHost(): Adapter {
    const created: string[] = [];
    return {
      id: 'fake', title: 'Fake', axes: ['hosting'], automated: true, auth: async () => ({ ok: true }),
      capabilities: {
        project: {
          current: async (): Promise<ProjectRef | null> => null,
          candidates: async () => [],
          select: async (ctx, id): Promise<ProjectRef> => ({ id, name: id }),
          create: async (ctx, name) => {
            created.push(name);
            return { id: 'prj_new', name };
          },
        },
      },
    };
  }

  const plan = (exec: Exec, cwd: string) => {
    const ctx = testCtx({ adapters: [fakeHost()], exec, cwd, config: { stack: { hosting: 'fake' } } });
    resetMemo(ctx);
    return { ctx, built: buildPlan(ctx, [projectsLink], { unmappedEnv: [], warnings: [] }) };
  };

  it('says the name came from the remote and warns that the folder would have named it differently', async () => {
    const cwd = worktree('setup-deploy-b59cf2');
    const { built } = plan(remote('git@github.com:mikehasa/golive-gstack-demo.git').run, cwd);
    const p = await built;
    expect(p.steps.map((s) => s.id)).toEqual(['project:hosting']);
    expect(planView(p).steps[0]!.preview.join('\n')).toContain(
      'name "golive-gstack-demo" comes from the git origin remote; "' + basename(cwd) + '" is only the working folder this run happens in',
    );
    expect(p.warnings.join('\n')).toContain(`named "golive-gstack-demo" (from the git origin remote), not "${basename(cwd)}" (the folder this run happens in)`);
    expect(p.warnings.join('\n')).toMatch(/init --project hosting=<name>/);
  });

  it('says nothing about the remote when the folder is all golive has', async () => {
    root = mkdtempSync(join(tmpdir(), 'golive-scratch-'));
    const { built } = plan(mockExec([]).run, root);
    const p = await built;
    expect(planView(p).steps[0]!.preview.join('\n')).toContain(`name "${basename(root).toLowerCase()}" comes from the working folder (no git origin remote to read)`);
    expect(p.warnings).toEqual([]);
  });
});
