# GoDaddy DNS

Automated DNS-record adapter via REST v3. The Vercel-attached custom-domain journey (CNAME plus
`_vercel` ownership TXT writes, ownership verification, HTTPS serving) passed a disposable live run;
the update-by-ID path and other pairings await their live exercises. No CLI or MCP installation is
needed for this adapter (GoDaddy also ships a beta `gddy` CLI; golive does not require it). The
GoDaddy MCP cannot modify DNS.

1. Use `dns=godaddy` only when the domain's **authoritative DNS** is hosted at GoDaddy. Buying a
   domain there is not enough if its nameservers point elsewhere. golive checks public delegation and
   zone access, including subdomain delegations; it never changes nameservers.
2. Have the human create a Personal Access Token at `developer.godaddy.com` with
   `domains.domain:read` and `domains.dns:update` only. No purchase or nameserver permissions.
3. On macOS run `credentials --prompt GODADDY_API_TOKEN --json` for private native entry. Their own
   editor is the fallback if unavailable, unsupported, or preferred; follow
   [How the human connects accounts](../SKILL.md#how-the-human-connects-accounts) for fallback,
   replacement and cancellation. Never put the value in chat or arguments. Classic key/secret pairs are not used.
4. Run `doctor`. Current GoDaddy documentation allows domain management when the account holds at
   least one domain, or has a qualifying plan; a 403 may indicate missing scope or account eligibility.
5. Show the complete plan and obtain explicit DNS approval before `apply --confirm-dns`.

golive preserves unrelated records. It can change records it created only while their stored
fingerprints still match; existing matching records are accepted without taking ownership. An
unmanaged conflicting record, duplicate SPF or a delegated child zone stops the write. Ask the human
to resolve the specified record in the dashboard or choose a fresh subdomain, then re-plan. Existing
SPF policies requiring an added sender need manual review unless golive created the policy.

GoDaddy requires TTL 600–86400 and does not support an apex CNAME. Use the host's apex A/AAAA
instructions or a subdomain. Domain purchases, renewals, transfers and nameserver changes are outside
this adapter. Teardown needs human approval; use only record IDs tracked under
`godaddy.recordFingerprint:<zone>:<recordId>` and confirm their current state before dashboard removal.

Official references: [DNS API](https://developer.godaddy.com/en/docs/api-users/domains/manage/dns),
[PAT setup](https://developer.godaddy.com/en/docs/api-users/auth),
[MCP limits](https://developer.godaddy.com/en/docs/api-users/mcp).
