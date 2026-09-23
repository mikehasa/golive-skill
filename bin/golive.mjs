#!/usr/bin/env node
// npm entrypoint: offline owned installation, otherwise the bundled CLI.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, INSTALL_HELP, manage } from '../scripts/install-cli.mjs';
import { PRODUCT } from '../scripts/install-lib.mjs';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function defaultExec(command, args, { cwd }) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', () => reject(new Error('Could not start the bundled CLI.')));
    child.once('exit', (code, signal) => done({ code: code ?? (signal ? 1 : 0) }));
  });
}
export async function main(argv, { cwd = process.cwd(), home = homedir(), packageRoot = PACKAGE_ROOT, exec = defaultExec, write = (line) => process.stdout.write(line + '\n'), smoke, fetcher, hook } = {}) {
  if (COMMANDS.includes(argv[0])) return manage(argv, { cwd, home, bundleRoot: join(packageRoot, 'skills', PRODUCT), write, smoke, fetcher, hook });
  if (argv.length === 1 && argv[0] === '--version') { write(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version); return 0; }
  const help = !argv.length || ['--help', '-h', 'help'].includes(argv[0]); if (help) write(INSTALL_HELP);
  const result = await exec(process.execPath, [join(packageRoot, 'skills', PRODUCT, 'scripts', `${PRODUCT}.mjs`), ...(help ? ['help', ...argv.slice(1)] : argv)], { cwd }); return result.code;
}
let direct = false;
try { direct = Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { /* imported */ }
if (direct) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${PRODUCT}: ${error.message}\n`); process.exitCode = 1; });
