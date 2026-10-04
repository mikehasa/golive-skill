import type { Check, ProjectRef } from '../core/types.js';
import { LOG_EVENT_TEXT, monitorStatusText, sameWatchedUrl, uptimeOf, type UptimeMonitor } from '../adapters/uptimerobot.js';
import { productionUrl } from '../links/util.js';
import { adapterFor, blocked, errMsg, pass, prereq, result, skip } from './util.js';

/** A duration in seconds as one short human phrase. */
function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** The provider's latest log line for the monitor, when it returned one (a down reason lives here). */
function logLine(log: UptimeMonitor['lastLog']): string | undefined {
  if (!log) return undefined;
  const kind = LOG_EVENT_TEXT[log.type] ?? `event ${log.type}`;
  const at = new Date(log.datetime * 1000).toISOString();
  return `last log: ${kind} at ${at}${log.duration !== undefined ? ` (duration ${humanDuration(log.duration)})` : ''}${log.reason ? ` — ${log.reason}` : ''}`;
}

/**
 * Does the linked UptimeRobot monitor watch this app's production URL, and does the provider report
 * it up? Read-only: one monitor read plus one account read behind it, and never a request to the app
 * — the production URL is compared as a string, not probed.
 *
 * Outcomes:
 *   - `skip` when the axis is not UptimeRobot, the adapter exposes no monitor surface, no monitor is
 *     linked/selected (the `uptimerobot:monitor` step has not been applied), or the login is unusable
 *     (`blocked by: login:uptimerobot` — as for every non-accounts check, that verdict belongs to the
 *     `accounts` check);
 *   - `skip` when the provider cannot be read (a refusal, a rate limit, an unreachable host) or when
 *     the production URL golive can name is not known yet (`blocked by: deploy:production`): neither
 *     is evidence about the app, and a transient provider answer never fails the run;
 *   - `warn` when the monitor watches another URL, or reports paused / not checked yet / seems down /
 *     down. A down site warns **high** and names the provider's own status and, when it returned one,
 *     its latest log line — including a downtime reason; the status of the site is the human's to act
 *     on, and this check never fails on it (the way `site-headers` treats a page that did not load);
 *   - `pass` only when the monitor watches exactly the production URL golive names and reports up.
 */
export const uptimeMonitorCheck: Check = {
  id: 'uptime-monitor',
  title: 'UptimeRobot watches the production URL and reports it up',
  severity: 'medium',
  applies: (ctx) => ctx.config.stack.monitoring === 'uptimerobot',
  async run(ctx) {
    const adapter = adapterFor(ctx, 'monitoring');
    if (!adapter || !adapter.automated) return skip(`monitoring provider ${ctx.config.stack.monitoring} has no automated adapter (guided)`);
    const uptime = uptimeOf(adapter);
    if (!uptime) return skip(`the ${adapter.title} adapter exposes no monitor read, so golive cannot check it`);

    const notLoggedIn = await prereq(ctx, 'monitoring');
    if (notLoggedIn) return notLoggedIn;

    const linker = adapter.capabilities.project;
    if (!linker) return skip(`the ${adapter.title} adapter has no monitor surface, so golive cannot name the monitor to check`);
    let linked: ProjectRef | null;
    try {
      linked = await linker.current(ctx);
    } catch (e) {
      return skip(`could not read the ${adapter.title} monitor this app is linked to: ${errMsg(e)}; re-run \`golive plan\` if that monitor is gone`);
    }
    if (!linked) return blocked('uptimerobot:monitor', `no ${adapter.title} monitor is linked for this app yet; run \`golive plan\` and apply it`);

    let monitor: UptimeMonitor | null;
    try {
      monitor = await uptime.monitor(ctx, linked.id);
    } catch (e) {
      return skip(`could not read ${adapter.title} monitor ${linked.id}: ${errMsg(e)}`);
    }
    if (!monitor) return blocked('uptimerobot:monitor', `the ${adapter.title} monitor ${linked.id} this app was linked to is gone from the account; run \`golive plan\` to select or create one`);

    const status = monitorStatusText(monitor.status);
    const evidence = [`${adapter.title} monitor ${monitor.name} (${monitor.id}) reports ${status}: watching ${monitor.url}${monitor.interval !== undefined ? `, checked every ${monitor.interval} s` : ''}`];
    const log = logLine(monitor.lastLog);
    if (log) evidence.push(log);

    // The production URL as the links register it (the configured domain, else the host's own once a
    // production deploy is recorded) — the same address the monitor is created for. It is only
    // compared: golive makes no request to the app here.
    const production = await productionUrl(ctx);
    if (!production) {
      return skip(
        `cannot confirm the production URL this monitor should watch yet (blocked by: deploy:production; golive.yaml names no domain and golive has not deployed production, so the host's URL is not confirmed). Apply a production deploy or set \`domain\`, then re-run verify`,
      );
    }

    const otherUrl = !sameWatchedUrl(monitor.url, production);
    if (otherUrl || monitor.status !== 2) {
      const problems = [
        ...(otherUrl ? [`it watches ${monitor.url}, not this app's production URL ${production}`] : []),
        ...(monitor.status !== 2 ? [`its status is ${status}`] : []),
      ];
      const fixes = [
        ...(otherUrl ? [`point the monitor at ${production} (or adopt the monitor that already watches it: set \`projects.monitoring\` to its id or name and re-run \`golive plan\`); golive never rewrites a monitor's URL on its own`] : []),
        ...(monitor.status === 0
          ? [`resume it in the ${adapter.title} dashboard — golive never pauses or resumes a monitor`]
          : monitor.status === 1
            ? ['a new monitor starts "not checked yet": re-run verify in a minute, and check the monitor\'s settings if it stays that way']
            : monitor.status === 8 || monitor.status === 9
              ? ['check the site now: the provider reports it unreachable (the dashboard has the check history and the reason)']
              : []),
        're-run `golive verify --only uptime-monitor`',
      ];
      const down = monitor.status === 8 || monitor.status === 9;
      return result('warn', down ? 'high' : 'medium', [...evidence, ...problems.map((p) => `— ${p}`)], fixes.join('; '));
    }
    return pass(evidence);
  },
};
