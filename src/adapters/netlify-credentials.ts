/** Read-only reuse of the official CLI's documented current-user OAuth store; never migrate it. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Secret } from '../core/secret.js';

export function netlifyConfigPath(options: { platform?: string; home?: string; appData?: string; xdgConfigHome?: string } = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Preferences', 'netlify', 'config.json');
  if (platform === 'win32') return join(options.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'netlify', 'Config', 'config.json');
  return join(options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'netlify', 'config.json');
}

export function readNetlifyCliToken(expectedUserId: string, path = netlifyConfigPath()): Secret | undefined {
  let fd: number | undefined;
  try {
    // Restrict reads to an owner-private ordinary file and reject redirected paths.
    let parent = dirname(path);
    while (parent !== dirname(parent)) {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error();
      parent = dirname(parent);
    }
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error();
    if (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || process.getuid && before.uid !== process.getuid())) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = fstatSync(fd);
    if (current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 || current.size > 1024 * 1024) throw new Error();
    if (!current.isFile() || process.platform !== 'win32' && ((current.mode & 0o077) !== 0 || process.getuid && current.uid !== process.getuid())) throw new Error();
    const data = JSON.parse(readFileSync(fd, 'utf8')) as { userId?: unknown; users?: Record<string, { auth?: { token?: unknown } }> };
    if (typeof data.userId !== 'string' || data.userId !== expectedUserId || !Object.hasOwn(data.users ?? {}, data.userId)) throw new Error();
    const value = data.users?.[data.userId]?.auth?.token;
    if (typeof value !== 'string' || !value) return undefined;
    return new Secret('netlify-cli-oauth', value);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new Error('The Netlify CLI OAuth store could not be safely reused. Check its file permissions, update the CLI, then run netlify login in your own terminal. No credential content was logged.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
