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
const docs = ['skills/golive/SKILL.md', 'README.md', 'docs/ARCHITECTURE.md', 'docs/TRUST.md', 'docs/RECOVERY.md', ...refs];
/** Docs that name golive's own flags. README.md and VALIDATION.md also quote other tools' flags (skills CLI, Vercel, Neon), so that check stays with the golive-command docs. */
const flagDocs = ['skills/golive/SKILL.md', 'docs/ARCHITECTURE.md', 'docs/TRUST.md', 'docs/RECOVERY.md'];

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
    const parses = (f: string): boolean => cli.includes(f) || cli.includes(`'${f.slice(2)}'`);
    for (const p of flagDocs) {
      const text = read(p);
      for (const m of text.matchAll(/--[a-z][a-z-]*/g)) {
        const f = m[0]!;
        const at = m.index ?? 0;
        if (f === '--token' || f === '--key') continue; // named only as "never use"
        // A `--flag-*` wildcard stands for a family: it passes when the CLI parses a concrete member.
        if (text.slice(at + f.length).startsWith('*') && new RegExp(`${f}[a-z]`).test(cli)) continue;
        // A doc may also name a flag only to say there is no such flag ("there is no `--confirm-promote`"),
        // which can start on the line before the flag, so the window before the mention is what counts.
        if (/(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b)(?:[\s`]|--[a-z-]*|or)*`?$/.test(text.slice(0, at))) continue;
        expect(parses(f), `${p}: ${f}`).toBe(true);
      }
    }
  });
});
