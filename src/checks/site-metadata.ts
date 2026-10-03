import type { Check } from '../core/types.js';
import { confirmedProductionUrl, errMsg, pass, probe, result, skip, trimSlash } from './util.js';

/** Values are evidence, not a payload: keep report lines bounded. */
const clip = (v: string): string => (v.length > 200 ? `${v.slice(0, 200)}…` : v);

/** One page is read; the head sits at the top of it, so a bounded slice is enough to parse. */
const MAX_HTML = 512 * 1024;

/** Every tag reported, in evidence order. */
const TAGS = ['title', 'meta description', 'link rel=canonical', 'og:title', 'og:description', 'og:image', 'og:url', 'twitter:card'] as const;
type Tag = (typeof TAGS)[number];

/** The tags a link preview uses. `og:image` and `og:url` must be fetchable absolute URLs. */
const SHARE: Tag[] = ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card'];
const ABSOLUTE: Tag[] = ['og:image', 'og:url'];

/** `true` for a value a crawler or preview bot can fetch itself: a full http(s) URL, not a path. */
function isAbsoluteHttp(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.host);
  } catch {
    return false;
  }
}

/** The attribute strings of every `<tag …>`, tolerating either quote style and a `>` inside a value. */
function tags(html: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[1] ?? '');
}

/** A tag's attributes: lowercased names, either quote style or unquoted values. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** The non-empty content of the first meta matching `attr=value`, the way HTML documents declare it. */
function metaContent(metas: Array<Record<string, string>>, attr: 'name' | 'property', value: string): string | null {
  for (const m of metas) if ((m[attr] ?? '').toLowerCase() === value && (m.content ?? '').trim()) return m.content!.trim();
  return null;
}

/** What the page's head says, as the check reports it. Empty or whitespace-only counts as absent. */
function readHead(html: string): Record<Tag, string | null> {
  const head = /<head\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/head\s*>/i.exec(html);
  const doc = head?.[1] ?? html;
  const metas = tags(doc, 'meta').map(attrs);
  const title = /<title\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/title\s*>/i.exec(doc)?.[1]?.trim();
  let canonical: string | null = null;
  for (const l of tags(doc, 'link').map(attrs)) {
    if (!(l.rel ?? '').toLowerCase().split(/\s+/).includes('canonical')) continue;
    if ((l.href ?? '').trim()) {
      canonical = l.href!.trim();
      break;
    }
  }
  return {
    title: title || null,
    'meta description': metaContent(metas, 'name', 'description'),
    'link rel=canonical': canonical,
    'og:title': metaContent(metas, 'property', 'og:title'),
    'og:description': metaContent(metas, 'property', 'og:description'),
    'og:image': metaContent(metas, 'property', 'og:image'),
    'og:url': metaContent(metas, 'property', 'og:url'),
    'twitter:card': metaContent(metas, 'name', 'twitter:card') ?? metaContent(metas, 'property', 'twitter:card'),
  };
}

/**
 * One read-only GET of the host-confirmed production URL (never config.domain) for the page's own
 * `<head>` metadata: the title, description and canonical link a crawler reads, and the Open Graph /
 * Twitter tags a link preview uses. Nothing here ever fails and golive changes no app code: a missing
 * core tag warns medium, missing share tags warn low, and a response that is not the app's own page —
 * 401/403 (a private deployment), a redirect, a non-2xx answer or a non-HTML body — skips or warns
 * rather than claiming the metadata is wrong.
 */
export const siteMetadataCheck: Check = {
  id: 'site-metadata',
  title: 'The production page carries the metadata crawlers and link previews read',
  severity: 'medium',
  applies: () => true,
  async run(ctx) {
    const confirmed = await confirmedProductionUrl(ctx);
    if (!confirmed.ok) return confirmed.outcome;
    const url = `${trimSlash(confirmed.url)}/`;

    let res;
    try {
      res = await probe(ctx, url, { headers: { 'user-agent': 'golive-verify' }, timeoutMs: 15_000 });
    } catch (e) {
      return result('warn', 'medium', [`could not fetch ${url}: ${errMsg(e)}`], 'Make sure the production deployment is reachable, then re-run verify.');
    }

    const got = `GET ${url} → HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      return skip(`${got}: the deployment may be private (visitor access, SSO or an auth wall answering anonymous requests), so its page metadata is unverified; make production publicly reachable, then re-run verify`);
    }
    if (res.status >= 300 && res.status < 400) {
      return skip(`${got}: a redirect is not followed, so the metadata of the app's own page is unverified; point the production URL at the deployed app (or set the host's redirect), then re-run verify`);
    }
    if (res.status < 200 || res.status >= 300) {
      return result('warn', 'medium', [`${got}: the production page did not load, so its page metadata is unverified`], 'Fix the deployment, then re-run verify.');
    }

    const html = res.text.slice(0, MAX_HTML);
    if (!/<(?:head|html|title)\b/i.test(html)) {
      const type = res.headers['content-type'];
      return result('warn', 'medium', [got, `the response is not an HTML page${type ? ` (content-type: ${clip(type)})` : ''}, so no <head> metadata could be read`], 'Point the production URL at the deployed app page, then re-run verify.');
    }

    const values = readHead(html);
    const evidence = [
      got,
      ...TAGS.map((t) => {
        const v = values[t];
        if (v === null) return `${t}: absent`;
        const relative = ABSOLUTE.includes(t) && !isAbsoluteHttp(v) ? ' (not an absolute http(s) URL)' : '';
        return `${t}: ${clip(v)}${relative}`;
      }),
    ];

    const missingCore: string[] = [];
    if (!values.title) missingCore.push('<title>');
    if (!values['meta description']) missingCore.push('<meta name="description">');
    const missingShare: string[] = [];
    for (const t of SHARE) {
      const v = values[t];
      if (!v) missingShare.push(t);
      else if (ABSOLUTE.includes(t) && !isAbsoluteHttp(v)) missingShare.push(`${t} (not an absolute http(s) URL)`);
    }

    if (missingCore.length) {
      const also = missingShare.length ? `; share tags also missing: ${missingShare.join(', ')}` : '';
      return result('warn', 'medium', [...evidence, `missing: ${[...missingCore, ...missingShare].join(', ')}`], `Add ${missingCore.join(' and ')} in the app's own <head>${also}: use the framework's metadata API — Next.js's \`metadata\` export, Nuxt's \`useHead\`, Astro frontmatter — or the template's <head>. Crawlers and link-preview bots often do not run client-side JavaScript, so render these tags server-side. golive does not edit app code: this is a change in your repo — then redeploy and re-run verify.`);
    }
    if (missingShare.length) {
      const absolute = missingShare.some((t) => t.startsWith('og:image') || t.startsWith('og:url')) ? ' `og:image` and `og:url` must be absolute http(s) URLs.' : '';
      return result('warn', 'low', [...evidence, `missing: ${missingShare.join(', ')}`], `Add the missing share tags (${missingShare.join(', ')}) as <meta> tags in the app's own <head> — the same framework metadata APIs (Next.js \`metadata\`, Nuxt \`useHead\`, Astro frontmatter) or the template's <head> — and render them server-side: link-preview bots often do not run client-side JavaScript.${absolute} golive does not edit app code: this is a change in your repo — then redeploy and re-run verify.`);
    }
    return pass(evidence);
  },
};
