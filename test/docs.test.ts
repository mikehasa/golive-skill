import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the agent-facing docs. They are what the agent relays to the human, so a wrong command
 * there is a real bug (round-2 finding #13: `! supabase login` can't work, `!` has no TTY).
 */
const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const refs = readdirSync(join(root, 'skills/golive/references')).map((f) => `skills/golive/references/${f}`);
const docs = ['skills/golive/SKILL.md', 'README.md', 'docs/ARCHITECTURE.md', ...refs];

describe('agent docs', () => {
  it('never tells the human to run an interactive vendor login through Claude Code `!` (no TTY)', () => {
    for (const p of docs) {
      expect(read(p), p).not.toMatch(/`!\s*(supabase|resend|vercel)\s+login/);
    }
  });

  it('sends vendor logins to a separate terminal window and says why', () => {
    const skill = read('skills/golive/SKILL.md');
    expect(skill).toMatch(/separate terminal window/);
    expect(skill).toMatch(/no TTY/);
    for (const p of ['skills/golive/references/supabase.md', 'skills/golive/references/resend.md', 'skills/golive/references/vercel.md']) {
      expect(read(p), p).toMatch(/separate terminal window|real terminal window/);
    }
  });

  it('mentions --token / --key only as something never to use', () => {
    for (const p of docs) {
      read(p)
        .split('\n')
        .filter((l) => /--token|--key\b/.test(l))
        .forEach((l) => expect(l, `${p}: ${l}`).toMatch(/\b(never|not|Never|Not)\b/));
    }
    expect(read('skills/golive/references/supabase.md')).toMatch(/Never run `supabase login --token/);
  });

  it('says the Vercel CLI is required even with VERCEL_TOKEN', () => {
    expect(read('skills/golive/SKILL.md')).toMatch(/`VERCEL_TOKEN` only replaces `vercel login`/);
    const vercel = read('skills/golive/references/vercel.md');
    expect(vercel).toMatch(/Install the Vercel CLI either way/);
    expect(vercel).not.toMatch(/alternative, e\.g\. no CLI/);
  });

  it('describes done:null as manual-or-skipped, not "no check" (a checkless handoff is open)', () => {
    expect(read('skills/golive/SKILL.md')).toMatch(/`done: null` \(a `manual` item, or its check skipped\)/);
    const pv = read('skills/golive/references/plan-and-verify.md');
    expect(pv).not.toMatch(/a `manual` item, no check, or the check skipped/);
    expect(pv).toMatch(/it has no check and isn't `manual`/);
  });

  it('only names CLI flags the CLI actually parses', () => {
    const cli = read('src/cli.ts');
    const flags = new Set(read('skills/golive/SKILL.md').match(/--[a-z][a-z-]*/g) ?? []);
    for (const f of flags) {
      if (f === '--token' || f === '--key') continue; // named only as "never use"
      const name = f.slice(2);
      expect(cli.includes(f) || cli.includes(`'${name}'`), f).toBe(true);
    }
  });
});
