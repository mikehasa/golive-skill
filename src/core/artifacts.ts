/**
 * The files golive writes into a repo, and how a CLI deploy keeps them private.
 *
 * Some hosts upload the deploy folder itself (`vercel deploy`) and serve what they uploaded, so a
 * static app publishes everything that is not excluded — the walkthrough behind issue #65 caught
 * `.golive/state.json` (team/project ids, account name), `golive.yaml` and the run documents one
 * deploy short of being publicly fetchable. Both the plan step that extends the host's ignore file
 * and the check that re-reads the live site work from the one list here.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from './config.js';
import { STATE_FILE } from './state.js';

/** The last `verify` results, and the ownership document `handoff --write` adds. */
export const REPORT_FILE = 'GOLIVE_REPORT.md';
export const HANDOVER_FILE = 'GOLIVE_HANDOVER.md';
/** The pre-rename report name. golive preserves it, so it stays in the list. */
export const LEGACY_REPORT_FILE = 'SHIP_REPORT.md';
/** The per-run JSON files under `.golive/` (the state file is `STATE_FILE`). */
export const STATE_DIR_FILES = ['state.json', 'report.json', 'handover.json'];

/** The comment line that marks golive's block in a host ignore file. */
export const GOLIVE_IGNORE_MARKER = '# golive: keep its own files (state, config, reports, run docs) out of this upload';

/**
 * The ignore-file patterns for those files. `docs/GOLIVE-*` covers the agent-written run documents
 * the skill names (`docs/GOLIVE-<stage>-PLAN.md`), which carry the same ids and account names.
 */
export const GOLIVE_IGNORE_LINES: readonly string[] = ['.golive/', CONFIG_FILE, REPORT_FILE, HANDOVER_FILE, LEGACY_REPORT_FILE, 'docs/GOLIVE-*'];

/** Whether an ignore file already carries golive's block, so a re-plan does not rewrite it. */
export function hasGoliveIgnoreBlock(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === GOLIVE_IGNORE_MARKER);
}

/**
 * `text` with golive's block appended: existing rules stay exactly as they are, and an allowlist the
 * human wrote (`/*` plus `!app`) keeps working — the block only adds exclusions of golive's own files.
 */
export function withGoliveIgnoreBlock(text: string): string {
  const base = text.replace(/\s*$/, '');
  return `${base ? `${base}\n\n` : ''}${[GOLIVE_IGNORE_MARKER, ...GOLIVE_IGNORE_LINES].join('\n')}\n`;
}

/**
 * The golive files this repo actually has, repo-relative and in probe order. Bounded: the state dir
 * files by name, the root documents by name, and `docs/GOLIVE-*` from one directory read.
 */
export function goliveRepoFiles(cwd: string): string[] {
  const isFile = (rel: string): boolean => {
    try {
      return statSync(join(cwd, rel)).isFile();
    } catch {
      return false;
    }
  };
  const out: string[] = [];
  for (const name of STATE_DIR_FILES) {
    // STATE_FILE is `.golive/state.json`; the same directory holds the report and handover JSON.
    const rel = `${STATE_FILE.split('/')[0]}/${name}`;
    if (isFile(rel)) out.push(rel);
  }
  for (const name of [CONFIG_FILE, REPORT_FILE, HANDOVER_FILE, LEGACY_REPORT_FILE]) if (isFile(name)) out.push(name);
  try {
    for (const entry of readdirSync(join(cwd, 'docs')).sort()) {
      if (/^GOLIVE-.+\.(?:md|json)$/i.test(entry) && isFile(join('docs', entry))) out.push(`docs/${entry}`);
    }
  } catch {
    // No docs directory: nothing agent-written to hide.
  }
  return out;
}
