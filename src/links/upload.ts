import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOLIVE_IGNORE_LINES, GOLIVE_IGNORE_MARKER, goliveRepoFiles, hasGoliveIgnoreBlock, withGoliveIgnoreBlock } from '../core/artifacts.js';
import type { Link } from '../core/plan.js';
import { errMsg, intentOf, ready, step, track } from './util.js';

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Keeps golive's own files out of a CLI upload that is also the served site. `vercel deploy` uploads
 * this folder and serves what it uploaded, so without an exclusion `.golive/state.json` (team and
 * project ids, account name), `golive.yaml` and the run documents are publicly fetchable — the
 * walkthrough behind issue #65 caught exactly that, one deploy short. The host declares its ignore
 * file (`capabilities.upload`); this link edits that file in the repo and nothing at the provider,
 * and the deploy link treats the change as a reason to redeploy (an upload only changes with a new
 * deployment).
 */
export const uploadLink: Link = {
  id: 'upload',
  async plan(ctx) {
    const h = await ready(ctx, 'hosting', 'deploy');
    const rules = h?.adapter.capabilities.upload;
    if (!h || !rules || !(await rules.servesFolder(ctx))) return null;

    // A combination the host's CLI itself refuses is not a plan step: say so and leave the file alone.
    const conflicting = (rules.conflicting ?? []).filter((file) => existsSync(join(ctx.cwd, file)));
    if (conflicting.length) {
      return {
        steps: [],
        handoffs: [],
        warnings: [
          `golive did not add ${rules.ignoreFile}: the ${h.adapter.title} CLI refuses it while ${conflicting.join(', ')} exists. Delete that file (the ${h.adapter.title} docs name the replacement), then run \`plan\` again, or keep golive's own files out of the upload yourself.`,
        ],
      };
    }

    const ignoreFile = join(ctx.cwd, rules.ignoreFile);
    const current = read(ignoreFile);
    if (current !== null && hasGoliveIgnoreBlock(current)) return null;
    const files = goliveRepoFiles(ctx.cwd);
    if (!files.length) return null;

    return {
      steps: track(ctx, [
        step({
          id: 'upload:excludes',
          title: `Keep golive's files out of the ${h.adapter.title} upload`,
          kind: 'provision',
          // An edit inside this repo, not a provider write. The preview names the file and every line.
          risk: { writes: false },
          preview: [
            `keep golive's own files out of the ${h.adapter.title} upload: append golive's block to ${rules.ignoreFile} (a local file in this repo; nothing is written at ${h.adapter.title}, and existing rules stay exactly as they are)`,
            `${h.adapter.title} uploads this folder and serves what it uploaded, so these paths would be publicly fetchable: ${files.join(', ')}`,
            ...GOLIVE_IGNORE_LINES.map((line) => `+ ${line}`),
          ],
          intent: intentOf({ file: rules.ignoreFile, lines: [...GOLIVE_IGNORE_LINES] }),
          async run(sctx) {
            const path = join(sctx.cwd, rules.ignoreFile);
            const text = read(path) ?? '';
            if (hasGoliveIgnoreBlock(text)) {
              return { changes: [`${rules.ignoreFile} already keeps golive's own files out of the ${h.adapter.title} upload`] };
            }
            try {
              writeFileSync(path, withGoliveIgnoreBlock(text));
            } catch (e) {
              throw new Error(
                `could not write ${rules.ignoreFile} (${errMsg(e)}): add golive's block to it yourself (${GOLIVE_IGNORE_MARKER}) and run \`apply\` again — golive does not deploy while its own files would be uploaded`,
              );
            }
            return { changes: [`wrote ${rules.ignoreFile}: golive's own files stay out of the ${h.adapter.title} upload (${files.join(', ')})`] };
          },
        }),
      ]),
      handoffs: [],
    };
  },
};
