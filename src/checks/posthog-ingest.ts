import { randomBytes } from 'node:crypto';
import type { Check, ProjectRef } from '../core/types.js';
import { analyticsOf, posthogTiming } from '../adapters/posthog.js';
import { adapterFor, blocked, errMsg, pass, prereq, result, skip } from './util.js';

/**
 * The synthetic event this check sends, and the distinct id it sends it as. The name is fixed so an
 * operator can find it in PostHog; a per-run `golive_marker` property is what the read-back filters
 * on, so an event from an earlier run inside the same window can never be mistaken for this one.
 */
export const EVENT = 'golive_ingest_check';
export const DISTINCT_ID = 'golive-verify';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Does this app's PostHog project actually record an event? One synthetic capture — no authorization
 * header, exactly what the app's SDK sends — followed by the provider's OWN read of what it ingested
 * (HogQL through `query:read`). A 2xx from the capture endpoint only means accepted, so the check
 * passes on the read-back and never on the 200.
 *
 * Ingestion is asynchronous and can lag minutes: the read-back is polled for a bounded window and
 * "not visible yet" is a warn that names what was sent and how long it waited — never a pass.
 *
 * Outcomes:
 *   - `skip` when the axis is not PostHog, the adapter exposes no capture/read-back surface, no
 *     project is linked/selected (the `analytics:project` step has not been applied), or the login
 *     is unusable (`blocked by: login:posthog` — as for every non-accounts check, that verdict
 *     belongs to the `accounts` check);
 *   - `fail` when the project cannot be read, the capture endpoint refuses the event, or the
 *     provider refuses the read-back (a 401/403: the key's scopes decide whether it may query) —
 *     each with the adapter's actionable message;
 *   - `warn` when the event is not visible within the window (including a read-back that never
 *     answered for a non-auth reason);
 *   - `pass` only when HogQL counts the marker this run sent, with the seconds named.
 */
export const posthogIngestCheck: Check = {
  id: 'posthog-ingest',
  title: 'PostHog ingests an event golive sent',
  severity: 'medium',
  applies: (ctx) => ctx.config.stack.monitoring === 'posthog',
  async run(ctx) {
    const adapter = adapterFor(ctx, 'monitoring');
    if (!adapter || !adapter.automated) return skip(`monitoring provider ${ctx.config.stack.monitoring} has no automated adapter (guided)`);
    const analytics = analyticsOf(adapter);
    if (!analytics) return skip(`the ${adapter.title} adapter exposes no capture + read-back surface, so golive cannot prove ingest for it`);

    const notLoggedIn = await prereq(ctx, 'monitoring');
    if (notLoggedIn) return notLoggedIn;

    const linker = adapter.capabilities.project;
    if (!linker) return skip(`the ${adapter.title} adapter has no project surface, so golive cannot name the project to check`);
    let project: ProjectRef | null;
    try {
      project = await linker.current(ctx);
    } catch (e) {
      return result('fail', 'medium', [`could not read the ${adapter.title} project this app reports to: ${errMsg(e)}`], 'Re-run verify; if it persists, check the PostHog access with `golive doctor` and re-plan.');
    }
    if (!project) return blocked('analytics:project', `no ${adapter.title} project is linked or selected for this app yet; run \`golive plan\` and apply it`);

    // A per-run marker: the read-back filters on it, so only THIS event can prove ingest.
    const marker = randomBytes(4).toString('hex');
    const filter = { event: EVENT, property: { key: 'golive_marker', value: marker }, minutes: posthogTiming.queryMinutes };
    let accepted: number;
    try {
      accepted = (await analytics.capture(ctx, project.id, { event: EVENT, distinctId: DISTINCT_ID, properties: { golive_marker: marker, golive_check: 'posthog-ingest' } })).status;
    } catch (e) {
      return result('fail', 'medium', [`sending one "${EVENT}" event to ${adapter.title} project ${project.name} (${project.id}) failed: ${errMsg(e)}`], 'Fix the ingestion host/network or the project token, then re-run `golive verify --only posthog-ingest`.');
    }
    const evidence = [
      `sent one "${EVENT}" event (distinct id ${DISTINCT_ID}, marker ${marker}) to ${adapter.title} project ${project.name} (${project.id}); the ingestion endpoint answered HTTP ${accepted}`,
      'the 2xx means accepted, not ingested: only the provider\'s own read-back proves it',
    ];

    const started = Date.now();
    const deadline = started + posthogTiming.windowMs;
    let readError: string | undefined;
    for (;;) {
      let count: number | null = null;
      try {
        count = await analytics.count(ctx, project.id, filter);
      } catch (e) {
        const code = (e as { status?: number }).status;
        // An auth refusal of the read-back is a failure of what this check verifies: without query
        // access golive can never prove ingest. Everything else is retried inside the window.
        if (code === 401 || code === 403) {
          return result('fail', 'medium', [...evidence, `the read-back was refused: ${errMsg(e)}`], `Grant the ${adapter.title} key the query:read scope (and organization:read/project:read), then re-run \`golive verify --only posthog-ingest\`.`);
        }
        readError = errMsg(e);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      if (count !== null && count > 0) {
        return pass([...evidence, `HogQL counted ${count} event(s) with marker ${marker} after ${seconds}s`]);
      }
      if (Date.now() >= deadline) {
        return result(
          'warn',
          'medium',
          [
            ...evidence,
            count !== null
              ? `PostHog had not recorded the marker ${marker} yet after ${seconds}s (the read-back counts ingested events and can lag minutes)`
              : `the read-back could not be read within ${seconds}s: ${readError ?? 'no answer'}`,
          ],
          `Ingestion is asynchronous, so this is not a failure yet: re-run \`golive verify --only posthog-ingest\` in a minute. If it stays invisible, check the project the app reports to (${project.id}) and that the app initializes the ${adapter.title} SDK.`,
        );
      }
      await sleep(Math.max(0, Math.min(posthogTiming.pollMs, deadline - Date.now())));
    }
  },
};
