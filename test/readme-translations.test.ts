import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the translated READMEs. English is authoritative: a translation may lag in wording,
 * but it must stay structurally honest — the same sections, the same switcher, a provenance marker,
 * code blocks that still match README.md byte for byte, and no release version the English README
 * does not name. A changed install command or a new section fails here instead of leaving a stale
 * copy in somebody's language. Prose drift stays a review duty (CONTRIBUTING.md, "Translations").
 */
const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const TRANSLATIONS = [
  { lang: 'zh-CN', name: '简体中文' },
  { lang: 'ja', name: '日本語' },
  { lang: 'ko', name: '한국어' },
  { lang: 'es', name: 'Español' },
  { lang: 'pt-BR', name: 'Português (Brasil)' },
  { lang: 'de', name: 'Deutsch' },
];
const file = (lang: string): string => `README.${lang}.md`;
const switcherTargets = ['README.md', ...TRANSLATIONS.map((t) => file(t.lang))];
const english = read('README.md');
const englishVersion = (JSON.parse(read('package.json')) as { version: string }).version;

/** The first line of a page that links to the English README; the switcher row, in every file. */
function switcher(text: string): string[] | null {
  const line = text.split('\n').find((l) => l.startsWith('[English](README.md)'));
  return line ? [...line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!) : null;
}

/** Lines outside fenced code blocks: structure is read from prose, never from a code sample. */
function proseLines(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { inside = !inside; continue; }
    if (!inside) out.push(line);
  }
  return out;
}

/** Non-blank lines inside fenced code blocks, trimmed. Commands must survive copy-paste intact. */
function fencedLines(text: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { inside = !inside; continue; }
    if (inside && line.trim()) lines.push(line.trim());
  }
  return lines;
}

/** Section structure as a level sequence, so a section added to the English README must be added here. */
function headingLevels(text: string): number[] {
  return proseLines(text)
    .map((l) => /^(#{1,6}) /.exec(l)?.[1]?.length)
    .filter((level): level is number => level !== undefined);
}

function versionTokens(text: string): string[] {
  return [...text.matchAll(/\b\d+\.\d+\.\d+(?:-[a-z0-9.]+)?\b/g)].map((m) => m[0]!);
}

function relativeLinks(text: string): string[] {
  return [...text.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => m[1]!)
    .filter((t) => !/^(?:https?:|mailto:|#)/.test(t))
    .map((t) => t.split('#')[0]!)
    .filter(Boolean);
}

function marker(text: string, p: string): Record<string, string> {
  const found = /^<!-- golive-translation: (.+) -->$/m.exec(text);
  expect(found, `${p}: no golive-translation marker`).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const m of found![1]!.matchAll(/([a-z-]+)=([^;]+)/g)) fields[m[1]!] = m[2]!.trim();
  return fields;
}

describe('translated READMEs', () => {
  it('has one translation per listed language and no unlisted ones', () => {
    const onDisk = readdirSync(root).filter((f) => /^README\..+\.md$/.test(f)).sort();
    expect(onDisk).toEqual(TRANSLATIONS.map((t) => file(t.lang)).sort());
  });

  it('links the same switcher row, in the same order, from the English README and every translation', () => {
    expect(switcher(english)).toEqual(switcherTargets);
    for (const { lang } of TRANSLATIONS) {
      const text = read(file(lang));
      expect(switcher(text), file(lang)).toEqual(switcherTargets);
      expect(text, file(lang)).toContain(TRANSLATIONS.find((t) => t.lang === lang)!.name);
    }
  });

  it('mirrors the English section structure, heading for heading', () => {
    const expected = headingLevels(english);
    for (const { lang } of TRANSLATIONS) expect(headingLevels(read(file(lang))), file(lang)).toEqual(expected);
  });

  it('carries a provenance marker that names the source and its review state', () => {
    for (const { lang } of TRANSLATIONS) {
      const p = file(lang);
      const fields = marker(read(p), p);
      expect(fields.lang, p).toBe(lang);
      expect(fields.source, p).toBe('README.md');
      expect(fields['source-commit'], p).toMatch(/^[0-9a-f]{7,40}$/);
      expect(fields.updated, p).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fields.reviewed, p).toMatch(/^(?:true|false)$/);
    }
  });

  it('keeps the English README’s fenced code blocks byte-identical, install commands included', () => {
    const expected = [...new Set(fencedLines(english))].sort();
    for (const { lang } of TRANSLATIONS) {
      const p = file(lang);
      const actual = [...new Set(fencedLines(read(p)))].sort();
      expect(actual, p).toEqual(expected);
      expect(actual, p).toContain('npx skills add https://github.com/mikehasa/golive-skill --skill golive --global');
    }
  });

  it('names no release version the English README does not, and carries the current one', () => {
    const allowed = new Set(versionTokens(english));
    expect(allowed.has(englishVersion), 'README.md does not state its own version').toBe(true);
    for (const { lang } of TRANSLATIONS) {
      const p = file(lang);
      const text = read(p);
      for (const token of versionTokens(text)) expect(allowed.has(token), `${p}: ${token}`).toBe(true);
      expect(text, `${p}: missing ${englishVersion}`).toContain(englishVersion);
    }
  });

  it('never names a secret-bearing flag or an interactive vendor login, and links only to files it has', () => {
    for (const { lang } of TRANSLATIONS) {
      const p = file(lang);
      const text = read(p);
      expect(text, p).not.toMatch(/--token|--key\b/);
      expect(text, p).not.toMatch(/`!\s*(?:supabase|resend|vercel)\s+login/);
      for (const target of relativeLinks(text)) expect(existsSync(join(root, target)), `${p}: ${target}`).toBe(true);
    }
  });
});
