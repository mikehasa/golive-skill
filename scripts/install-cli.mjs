#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT, changeInstallation, installLocation, installationStatus, ownedLocationForBundle, recoverLock, rollbackInstallation, setUpdatePolicy } from './install-lib.mjs';

export const COMMANDS = ['install', 'update', 'rollback', 'install-status', 'update-policy', 'recover-lock'];
export const INSTALL_HELP = `${PRODUCT}: manage complete agent skill installations.

  ${PRODUCT} install --agent codex|claude [--global] [--from BUNDLE] [--ref TAG] [--pin]
  ${PRODUCT} install-status --agent codex|claude [--global] [--json]
  ${PRODUCT} update --agent codex|claude [--global] --from BUNDLE | --ref TAG
  ${PRODUCT} rollback --agent codex|claude [--global]
  ${PRODUCT} update-policy --agent codex|claude [--global] --auto on|off
  ${PRODUCT} recover-lock --agent codex|claude [--global]

--agent claude-code is accepted anywhere --agent claude is: the Skills CLI uses that spelling for the
same destination.

Installed owned copies can run scripts/install-cli.mjs without --agent or --global.
Automatic replacement is off by default; enabled copies may run update --auto --between-runs
with an explicit --ref at the start of a new run, never between plan approval and apply.
Pinned copies never auto-update. External manager copies are never changed.
Rollback changes only the local skill bundle, not deployments or user data.
`;
function options(command, argv) {
  const result = {}; const bools = ['global', 'pin', 'between-runs', 'json']; const values = ['agent', 'from', 'ref'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || Object.hasOwn(result, key)) throw new Error('Invalid or duplicate installation option.');
    if (bools.includes(key)) result[key] = true;
    else if (values.includes(key) || (key === 'auto' && command === 'update-policy')) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Installation option requires a value.');
      result[key] = argv[++i];
    } else if (key === 'auto' && command === 'update') result.auto = true;
    else throw new Error('Unknown installation option.');
  }
  const allowed = { install: ['agent', 'global', 'from', 'ref', 'pin', 'json'], update: ['agent', 'global', 'from', 'ref', 'auto', 'between-runs', 'json'], rollback: ['agent', 'global', 'json'], 'install-status': ['agent', 'global', 'json'], 'update-policy': ['agent', 'global', 'auto', 'json'], 'recover-lock': ['agent', 'global', 'json'] };
  if (Object.keys(result).some((key) => !allowed[command]?.includes(key))) throw new Error('Option is not valid for this installation command.');
  return result;
}
export async function manage(argv, { cwd = process.cwd(), home = homedir(), bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), write = (line) => process.stdout.write(line + '\n'), smoke, fetcher, hook } = {}) {
  const command = argv[0];
  if (!COMMANDS.includes(command)) throw new Error('Unknown installation command.');
  if (argv.length === 2 && ['--help', '-h'].includes(argv[1])) { write(INSTALL_HELP); return 0; }
  const opts = options(command, argv.slice(1));
  const implicit = !opts.agent && !opts.global ? (ownedLocationForBundle(bundleRoot) ?? (command === 'install' ? null : bundleRoot)) : null;
  const destination = implicit ?? installLocation({ cwd, home, agent: opts.agent, global: opts.global });
  let result;
  const candidates = ['codex', 'claude'].flatMap((agent) => [false, true].map((global) => installLocation({ cwd, home, agent, global })));
  if (command === 'install-status') result = installationStatus(destination, { global: opts.global, candidates });
  else if (command === 'update-policy') { if (!['on', 'off'].includes(opts.auto)) throw new Error('Choose --auto on or --auto off.'); result = await setUpdatePolicy(destination, opts.auto === 'on'); }
  else if (command === 'recover-lock') result = recoverLock(destination);
  else if (command === 'rollback') result = await rollbackInstallation(destination, { smoke, hook });
  else {
    const source = opts.from ? resolve(cwd, opts.from) : command === 'install' && !opts.ref ? bundleRoot : undefined;
    result = await changeInstallation({ destination, source, ref: opts.ref, install: command === 'install', pin: opts.pin, auto: opts.auto, betweenRuns: opts['between-runs'], smoke, fetcher, hook });
  }
  write(JSON.stringify(result, null, opts.json ? undefined : 2)); return 0;
}
let direct = false;
try { direct = Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { /* imported */ }
if (direct) manage(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { process.stderr.write(`${PRODUCT}: installation command failed; verify the command, ownership, release bundle and lock status. No provider operation was performed.\n`); process.exitCode = 1; });
