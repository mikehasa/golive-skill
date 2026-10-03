import { randomBytes } from 'node:crypto';
import type { Check, ProjectRef } from '../core/types.js';
import { monitoringOf, sentryTiming } from '../adapters/sentry.js';
import { adapterFor, blocked, errMsg, pass, prereq, result, skip } from './util.js';

/**
 * The synthetic event this check sends. The message is fixed so an operator can find it in Sentry; a
 * per-run `golive_marker` tag is what the read-back verifies, so an event from an earlier run can
 * never be mistaken for this one. The event id is generated here so the read-back can name the exact
 * event even when the Store endpoint does not echo one.
 */
export const EVENT = 'golive_ingest_check';
export const MARKER_TAG = 'golive_marker';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Does this app's Sentry project actually accept and store an event? One synthetic event through the
 * DSN's Store endpoint — no auth token, exactly what the app's SDK sends — followed by Sentry's OWN
 * event read by id with the auth token (`event:read`). A 2xx from the Store endpoint only means
 * accepted, so the check passes on the read-back and never on the 200.
 *
 * Outcomes:
 *   - `skip` when the axis is not Sentry, the adapter exposes no store/read-back surface, no project
 *     is linked/selected (the `sentry:project` step has not been applied), or the login is unusable
 *     (`blocked by: login:sentry` — as for every non-accounts check, that verdict belongs to the
 *     `accounts` check);
 *   - `fail` when the project cannot be read or the Store endpoint refuses the event, each with the
 *     adapter's actionable message (the 2xx-is-not-proof rule cuts both ways: a refused send is a
 *     real failure, a refused read-back is not);
 *   - `warn` when Sentry cannot read the event back within the window — including a refused read
 *     (usually a missing `event:read` scope, named with the fix) and an event that reads back without
 *     the run marker — never a pass;
 *   - `pass` only when Sentry returns the exact event with the marker this run sent, with the
 *     seconds named.
 */
export const sentryIngestCheck: Check = {
  id: 'sentry-ingest',
  title: 'Sentry ingests an event golive sent',
  severity: 'medium',
  applies: (ctx) => ctx.config.stack.monitoring === 'sentry',
  async run(ctx) {
    const adapter = adapterFor(ctx, 'monitoring');
    if (!adapter || !adapter.automated) return skip(`monitoring provider ${ctx.config.stack.monitoring} has no automated adapter (guided)`);
    const monitoring = monitoringOf(adapter);
    if (!monitoring) return skip(`the ${adapter.title} adapter exposes no store + read-back surface, so golive cannot prove ingest for it`);

    const notLoggedIn = await prereq(ctx, 'monitoring');
    if (notLoggedIn) return notLoggedIn;

    const linker = adapter.capabilities.project;
    if (!linker) return skip(`the ${adapter.title} adapter has no project surface, so golive cannot name the project to check`);
    let project: ProjectRef | null;
    try {
      project = await linker.current(ctx);
    } catch (e) {
      return result('fail', 'medium', [`could not read the ${adapter.title} project this app reports to: ${errMsg(e)}`], `Re-run verify; if it persists, check the ${adapter.title} access with \`golive doctor\` and re-plan.`);
    }
    if (!project) return blocked('sentry:project', `no ${adapter.title} project is linked or selected for this app yet; run \`golive plan\` and apply it`);

    // A per-run marker: the read-back verifies it, so only THIS event can prove ingest.
    const marker = randomBytes(4).toString('hex');
    const sentId = randomBytes(16).toString('hex');
    let accepted: { status: number; eventId?: string };
    try {
      accepted = await monitoring.capture(ctx, project.id, {
        eventId: sentId,
        message: `${EVENT} ${marker}`,
        tags: { [MARKER_TAG]: marker, golive_check: 'sentry-ingest' },
      });
    } catch (e) {
      return result('fail', 'medium', [`sending one "${EVENT}" event to ${adapter.title} project ${project.name} (${project.id}) failed: ${errMsg(e)}`], 'Fix the DSN/network or the project, then re-run `golive verify --only sentry-ingest`.');
    }
    const eventId = accepted.eventId ?? sentId;
    const evidence = [
      `sent one "${EVENT}" event (event id ${eventId}, marker ${marker}) to ${adapter.title} project ${project.name} (${project.id}); the store endpoint answered HTTP ${accepted.status}`,
      'the 2xx means accepted, not ingested: only Sentry\'s own event read proves it',
      ...(accepted.eventId ? [] : ['the store endpoint returned no event id; the read-back asks for the id golive sent']),
    ];

    const started = Date.now();
    const deadline = started + sentryTiming.windowMs;
    let readError: string | undefined;
    let seenWithoutMarker = false;
    for (;;) {
      let state: 'pending' | 'seen' | 'seen-without-marker' | null = null;
      try {
        state = await monitoring.readEvent(ctx, project.id, eventId, marker);
      } catch (e) {
        const code = (e as { status?: number }).status;
        // A refused read-back is not evidence about the app; it means golive's own token cannot prove
        // anything, so it warns with the scope fix instead of failing the app's monitoring.
        if (code === 401 || code === 403) {
          return result(
            'warn',
            'medium',
            [...evidence, `the read-back was refused: ${errMsg(e)}`],
            `Grant the ${adapter.title} token the event:read scope (and org:read/project:read), then re-run \`golive verify --only sentry-ingest\`; until then golive cannot prove the event arrived even though the store endpoint accepted it.`,
          );
        }
        readError = errMsg(e);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      if (state === 'seen') {
        return pass([...evidence, `Sentry returned event ${eventId} with marker ${marker} after ${seconds}s`]);
      }
      if (state === 'seen-without-marker') seenWithoutMarker = true;
      if (Date.now() >= deadline) {
        return result(
          'warn',
          'medium',
          [
            ...evidence,
            state === null
              ? `the read-back could not be read within ${seconds}s: ${readError ?? 'no answer'}`
              : seenWithoutMarker
                ? `Sentry returned event ${eventId} after ${seconds}s, but without the run marker ${marker} in it`
                : `Sentry had not returned the event (marker ${marker}) yet after ${seconds}s (error ingestion and issue indexing can lag)`,
          ],
          `Ingestion is asynchronous, so this is not a failure yet: re-run \`golive verify --only sentry-ingest\` in a minute. If it stays invisible, check the project the app reports to (${project.id}) and that the app initializes the ${adapter.title} SDK with the DSN env name golive writes.`,
        );
      }
      await sleep(Math.max(0, Math.min(sentryTiming.pollMs, deadline - Date.now())));
    }
  },
};
