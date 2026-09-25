/**
 * GOLIVE_HANDOVER.md — the ownership document, rendered from the already-redacted handover data.
 *
 * Rendering is pure and adds no facts: it lays out the rows `src/handover/build.ts` read, tags each
 * one with how its claim can be checked, and runs the finished text through `redact()` as the last
 * line of defence. The file paths and the overwrite guard live here too, because they are the same
 * contract for both artifacts the `handoff --write` command writes.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandoverAccount, HandoverDoc, HandoverManual, HandoverResource, HandoverRetirement, Provenance } from '../handover/build.js';
import { HANDOVER_MARKER } from '../handover/build.js';
import { redact } from '../core/secret.js';

/** The two files `handoff --write` produces, mirroring the reportPaths convention of `verify`. */
export function handoverPaths(cwd: string): { json: string; markdown: string } {
  return { json: join(cwd, '.golive/handover.json'), markdown: join(cwd, 'GOLIVE_HANDOVER.md') };
}

/**
 * Refuse to overwrite a file golive did not write: one carrying the marker is ours to replace, a
 * symlink or any other file is the human's, and `--force` is their explicit consent to replace it.
 */
export function assertOverwritable(path: string, force: boolean): void {
  if (force) return;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return; // nothing there: nothing to protect
  }
  if (!stat.isFile()) throw new Error(`${path} exists and is not a regular file, so golive will not overwrite it; move it aside or pass --force.`);
  if (!readFileSync(path, 'utf8').includes(HANDOVER_MARKER)) {
    throw new Error(`${path} exists and carries no "${HANDOVER_MARKER}" marker, so golive will not overwrite it; move it aside or pass --force.`);
  }
}

/** The JSON artifact: the same document, never a secret value. */
export function handoverJson(doc: HandoverDoc): string {
  return redact(JSON.stringify(doc, null, 2)) + '\n';
}

/** The row tag vocabulary: how each claim can be checked. */
function tag(p: Provenance): string {
  switch (p.kind) {
    case 'verified':
      return '[verified by golive]';
    case 'recorded':
      return p.at ? `[recorded ${p.at.slice(0, 10)}, not re-checked]` : '[recorded, not re-checked]';
    case 'unverifiable':
      return '[not verifiable by golive]';
    case 'unknown':
      return '[unknown]';
  }
}

/** The same vocabulary for a section legend, where no single timestamp applies. */
const tagKind = (kind: Provenance['kind']): string => tag(kind === 'recorded' ? { kind: 'recorded' } : { kind });

/** Table cells stay one line and cannot break the table with a stray pipe. */
const cell = (text: string | undefined): string => (text ?? '—').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function renderHandover(doc: HandoverDoc): string {
  const lines: string[] = [];
  lines.push('# Ownership and handover', '');
  lines.push(`_Generated ${doc.generatedAt} by golive \`${doc.release.name}@${doc.release.version}\` (bundle \`${doc.release.bundleDigest}\`${doc.release.ref ? `, ref \`${doc.release.ref}\`` : ''})._`, '');
  lines.push(`**Product:** ${doc.product.name} · framework: ${doc.product.framework} · root: \`${doc.product.root}\`${doc.product.domain ? ` · custom domain: ${doc.product.domain}` : ''}`, '');
  const urls = Object.entries(doc.urls);
  lines.push(
    urls.length
      ? `**Live URLs (as the hosting provider reported them in this run):** ${urls.map(([t, u]) => `${t} \`${u}\``).join(' · ')}`
      : '**Live URLs:** none golive could read in this run — check the host dashboard and `GOLIVE_REPORT.md`.',
    '',
  );
  lines.push('**Keep in mind**', '');
  for (const l of doc.limits) lines.push(`- ${l}`);
  lines.push('');

  lines.push('## Accounts and login route', '');
  if (doc.accounts.length) {
    lines.push('| Axis | Provider | How golive reaches it | Account / team | If the login expires |', '| --- | --- | --- | --- | --- |');
    for (const a of doc.accounts) lines.push(accountLine(a));
  } else lines.push('_No providers are configured yet._');
  lines.push('');

  lines.push('## Resources created', '');
  if (doc.resources.length) {
    lines.push('| Axis | Provider | Name | Id | Public URL | Ownership | Proof |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of doc.resources) lines.push(resourceLine(r));
  } else lines.push('_golive found no resource it created or adopted._');
  lines.push('');

  lines.push('## Costs and recurrence', '');
  lines.push('golive holds no payment method, buys nothing and never calls a billing endpoint. Every resource above bills to the account named in "Accounts and login route".', '');
  if (doc.costs.length) {
    lines.push('| Provider | What golive read | Where the real numbers are |', '| --- | --- | --- |');
    for (const c of doc.costs) lines.push(`| ${cell(c.providerTitle)} | ${cell(c.read)} ${tag(c.provenance)} | ${cell(c.where)} |`);
  }
  lines.push('');
  for (const l of recurrence(doc)) lines.push(`- ${l}`);
  lines.push('');

  lines.push('## What is manual', '');
  lines.push(
    doc.manualClosed
      ? `The list below is what is still the human's. ${doc.manualClosed} handoff(s) were already closed by a passing check in this run.`
      : 'The list below is what is still the human\'s.',
    '',
  );
  for (const m of doc.manual) lines.push(...manualLines(m));
  if (!doc.manual.length) lines.push('_Nothing is outstanding._');
  lines.push('');

  lines.push('## If it breaks', '');
  for (const r of doc.runbook) {
    lines.push(`**${r.subject}**`, '');
    for (const c of r.commands) lines.push(`- \`${c}\``);
    lines.push('', r.note, '');
  }
  lines.push('Evidence lives in:', '');
  for (const e of doc.evidence) lines.push(`- ${e}`);
  lines.push('');

  lines.push('## Retirement', '');
  lines.push('`golive teardown` lists exactly these resources and deletes only what golive provably created, under its own approval:', '');
  lines.push('_golive lists only what it can name and prove: a provider it cannot reach right now contributes a row saying what remains and why golive will not remove it, never a silent gap and never a deletion it cannot do._', '');
  lines.push('_A removal is reported as done only after re-reading the resource at its provider; fetching the URL proves nothing, because a CDN cache can keep answering after the resource is gone._', '');
  if (doc.retirement.length) {
    lines.push('| Resource | How it goes away | Removal |', '| --- | --- | --- |');
    for (const r of doc.retirement) lines.push(retirementLine(r));
  } else lines.push('_Nothing golive created was found to remove._');
  lines.push('');

  lines.push('---', '');
  lines.push('## Provenance', '');
  lines.push('| Section | Source | This run | Row tags |', '| --- | --- | --- | --- |');
  for (const p of doc.provenance) lines.push(`| ${cell(p.section)} | ${cell(p.source)} | ${p.at} | ${p.tags.length ? p.tags.map(tagKind).join(' · ') : '—'} |`);
  lines.push('');
  lines.push(`${HANDOVER_MARKER}. This file contains no secrets: it is built from recorded metadata, ids, URLs and fingerprints only. Secret-free metadata can still identify private resources, so review it before sharing it.`, '');
  return redact(lines.join('\n') + '\n');
}

function accountLine(a: HandoverAccount): string {
  const via = a.via ?? (a.provenance.kind === 'verified' ? 'connected (the provider named no route)' : 'not read');
  return `| ${cell(a.axis)} | ${cell(a.providerTitle)} | ${cell(via)} ${tag(a.provenance)} | ${cell(a.account)} | ${cell(a.login)} |`;
}

function resourceLine(r: HandoverResource): string {
  return `| ${cell(r.axis)} | ${cell(r.providerTitle)} | ${cell(r.name)} | ${cell(r.id)} | ${cell(r.url)} | ${r.ownership === 'created' ? 'created by golive' : 'adopted (not golive\'s)'} | ${cell(r.proof)} ${tag(r.provenance)} |`;
}

function retirementLine(r: HandoverRetirement): string {
  return `| ${cell(r.resource)} | ${cell(`${r.how} ${tag(r.provenance)}`)} | ${r.removable ? 'golive teardown' : 'by hand'} |`;
}

function manualLines(m: HandoverManual): string[] {
  const out: string[] = [];
  const label = m.kind === 'recurring' ? 'recurring' : m.blocking ? 'blocking' : 'open';
  out.push(`- **[${label}]** ${m.action}${m.url ? ` (${m.url})` : ''} ${tag(m.provenance)}`);
  out.push(`  - Why: ${m.why ?? m.title}`);
  if (m.kind === 'handoff') out.push(`  - Handoff id: \`${m.title}\``);
  else out.push(`  - Job: \`${m.title}\``);
  return out;
}

/** Recurrence facts golive can state without reading a billing system. */
function recurrence(doc: HandoverDoc): string[] {
  const out = [
    'Nothing golive created has its own payment method: renewals, overage and plan changes happen in the account you signed in with.',
    'golive read no plan, quota or usage data for this document, so it states no figure — not even a free-tier limit.',
  ];
  if (doc.product.domain) out.push(`The domain ${doc.product.domain} renews at its registrar, separately from the DNS zone golive may write.`);
  return out;
}
