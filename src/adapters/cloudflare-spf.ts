/**
 * SPF merging (RFC 7208). A name may carry only ONE `v=spf1` TXT record (two = permerror, SPF fails
 * outright), so adding a sender means inserting its mechanisms into the existing record.
 */

const ALL = /^[+\-~?]?all$/i;
const MODIFIER = /^[a-z][a-z0-9_.-]*=/i;
/** Terms that cost a DNS lookup (RFC 7208 §4.6.4 caps these at 10). */
const LOOKUP = /^[+\-~?]?(include:|a$|a[:/]|mx$|mx[:/]|ptr$|ptr:|exists:|redirect=)/i;

export const SPF_LOOKUP_LIMIT = 10;

export function isSpf(txt: string): boolean {
  return /^v=spf1(\s|$)/i.test(txt.trim());
}

function terms(spf: string): string[] {
  return spf.trim().split(/\s+/).slice(1);
}

export function countSpfLookups(spf: string): number {
  return terms(spf).filter((t) => LOOKUP.test(t)).length;
}

/** A term's mechanism with any qualifier (+ - ~ ?) removed, lowercased: "?include:X" -> "include:x". */
const mech = (t: string): string => t.replace(/^[+\-~?]/, '').toLowerCase();
const passes = (t: string): boolean => !/^[-~?]/.test(t);

/**
 * Insert the mechanisms of `wanted` that `existing` lacks, before existing's all-term (or before its
 * modifiers when it has no all-term). The existing all qualifier (~all / -all) is kept; wanted's is
 * ignored. Mechanisms are compared without qualifiers, so `?include:x` is never duplicated as
 * `include:x`. Throws when the existing record already has the mechanism with a non-pass qualifier
 * (SPF takes the first match, so that sender could never pass) or when the result would exceed the
 * 10-lookup limit.
 */
export function mergeSpf(existing: string, wanted: string, name: string): { content: string; added: string[] } {
  const have = terms(existing);
  const seen = new Map<string, string>();
  for (const t of have) if (!seen.has(mech(t))) seen.set(mech(t), t);
  const current = ['v=spf1', ...have].join(' ');
  const added: string[] = [];
  for (const t of terms(wanted)) {
    if (ALL.test(t) || MODIFIER.test(t)) continue;
    const prior = seen.get(mech(t));
    if (prior !== undefined) {
      if (passes(t) && !passes(prior)) {
        throw new Error(
          `SPF at ${name} already has "${prior}", which matches this sender first with a non-pass result, so SPF for it can never pass. ` +
            `Change that term to "${t.replace(/^\+/, '')}" in the existing record "${current}" in your DNS dashboard, then re-run.`,
        );
      }
      continue;
    }
    seen.set(mech(t), t);
    added.push(t);
  }
  if (!added.length) return { content: current, added };

  let at = have.findIndex((t) => ALL.test(t));
  if (at < 0) at = have.findIndex((t) => MODIFIER.test(t));
  if (at < 0) at = have.length;
  const content = ['v=spf1', ...have.slice(0, at), ...added, ...have.slice(at)].join(' ');

  const lookups = countSpfLookups(content);
  if (lookups > SPF_LOOKUP_LIMIT) {
    throw new Error(
      `SPF at ${name} would need ${lookups} DNS lookups after adding ${added.join(' ')} (limit ${SPF_LOOKUP_LIMIT}; over it SPF fails). ` +
        `Remove unused include:/a/mx mechanisms from the existing record "${current}" (or flatten it) in your DNS dashboard, then re-run.`,
    );
  }
  return { content, added };
}
