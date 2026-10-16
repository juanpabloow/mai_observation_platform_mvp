# Phase ID-H — Identity Hardening (report)

**Date:** 2026-10-15 · **Base:** `72c4099` · **Migration:** none (see
[Deploy / handoff](#deploy--handoff)).

Closes the WhatsApp-identity gaps the 2026-10 audit flagged **without changing the
identity model already decided and shipped**. Privacy and data-loss fixes only.

## Scope guardrails (what this phase deliberately did NOT touch)

The shipped model is unchanged, by design:

- **Resolution order** stays phone/`wa_id` PRIMARY, `BSUID`/`user_id` as the
  no-phone fallback; `conversation_ref = wa_id || user_id`; `external_id` for
  no-phone lookups; sends go out via the Cloud API `recipient`.
- **Phase I-1 multi-identity push** is unchanged: every declared identity links to
  *one* contact; when a declared identity already belongs to a *different* existing
  contact, that is recorded as a **duplicate candidate — never auto-merged**.
- **Per-client schemas and channel namespaces (phases I-2 / I-4)** remain out of
  scope.

Everything below is a guard, a data-move, a detect-and-contain tool, or a doc — no
change to how a legitimate identity is resolved.

## Q1–Q4 production results — NOT PROVIDED

The prompt carried a placeholder for the operator to paste the production query
results (Q1–Q4, the live extent of the identity collapse):

> `[OPERATOR: PASTE THE RESULTS…]` — **left unfilled.**

So this report makes **no claim about the production blast radius** and fabricates
no findings. The §4 containment capability was built as a reusable tool regardless,
exactly as instructed, so the operator can measure and remediate directly:

> **Run `npm run identity:contain` (dry-run) in production first** — it is read-only
> and prints the real Q1–Q4 numbers (sentinel-keyed conversations, sentinel
> contacts, legacy BSUID contacts). Only then decide on `--apply`.

## §1 — Sentinel guard

New `src/identity/sentinel.ts` is the single definition of a "non-identity":

- `isSentinelIdentifier(raw)` is **true** for: `null`/`undefined`; empty after
  trim; the case-insensitive words `undefined`, `null`, `nan`, `none`, `true`,
  `false`, `[object object]`; any value containing `{{` (an unrendered n8n
  expression); any value starting with `=` (a literal n8n expression).
- `isQuarantinedRef(raw)` is true only for the `quarantined:` prefix.

Wired as a fail-closed guard at every write/read entry point:

| Entry point | On a sentinel | Code |
| --- | --- | --- |
| `handoff/v1/messages` (POST) | 422, nothing written | `invalid_conversation_ref` / `invalid_identity` |
| `handoff/v1/context` (GET) | 422 (sentinel ref) / 404 (quarantined) | `invalid_conversation_ref` / `not_found` |
| `crm/v1/contacts/upsert` (POST) | 422 | `invalid_identity` |
| `crm/v1/contacts/lookup` (GET) | 422 | `invalid_identity` |
| `scheduling/v1/appointments` (POST) | 422, nothing written | `invalid_identity` |

Defence in depth behind the routes: the repository classifiers
(`classifyIdentity`, `classifyDeclaredIdentity`) return `null` on a sentinel, so a
sentinel never becomes a lookup key; `getOrCreateConversation` throws on a sentinel
or quarantined `conversation_ref`; `readConversationContext` returns `null` for
either. The by-time cancel/reschedule and CRM by-identity paths rely on this
classifier defence (sentinel → `null` → no match → 404) rather than a bespoke 422.

## §2 — BSUID shape, including the ENT variant

`src/scheduling/phone.ts`:

- `BSUID_SHAPE = /^[A-Za-z]{2}(?:\.[A-Za-z0-9]+)+$/`, `BSUID_MAX_LENGTH = 128`.
- Accepts both the direct form `CO.2405123456` **and** the managed-portfolio form
  the audit flagged, `US.ENT.11815799212886844830`.
- `normalizeE164` still returns `null` for any `isBsuid` value — the invariant from
  fix `1444d5a` (a letter-country-plus-dot value can never become a phone) is
  preserved and now covers the ENT variant too.

The SQL mirror in `contactIdentities.ts`
(`'^[[:space:]]*[A-Za-z]{2}([.][A-Za-z0-9]+)+[[:space:]]*$'`) matches the same shape.

## §3 — Merge no longer loses history

`mergeContacts` previously let child rows CASCADE-delete with the dropped contact —
on exactly the human-reviewed merges that I-1's duplicate candidates create. It now:

- **Moves every child row to the survivor:** `contact_notes`, `crm_tasks`, and
  `contact_tag_links` (de-duped against tags the survivor already has;
  `UNIQUE(contact_id, tag_id)`), alongside the existing `appointments` /
  `conversations` / `contact_identities` moves.
- **Takes the most-restrictive consent:** `messaging_consent` =
  max(`opted_out` > `unknown` > `opted_in`); `do_not_contact` = logical OR; when the
  value changes, `consent_updated_at = now()`, `consent_source = 'merge'`.
- **Keeps the survivor's custom fields, fills only its empties** from the loser
  (`$keep::jsonb || loser.custom_fields`).
- **Writes a `contact_merged` timeline event** (`crm_activity_events`) recording the
  kept/dropped ids and dropped name, with `actorKind` = `user` or `automation`.

## §4 — Detect and contain collapsed identities (never guess)

New `src/db/repositories/identityContainment.ts` + script
`src/scripts/identityContainmentPlan.ts` (`npm run identity:contain`).

- `detectCollapsedIdentity({ tenantId? })` is **read-only**: finds sentinel-keyed
  conversations, sentinel contacts (sentinel `channel_user_id` word/expression, or a
  sentinel identity value), and reports legacy BSUID contacts as informational.
- `applyContainment(report)` (one transaction, `--apply`) **quarantines**: re-keys
  each sentinel conversation to an unmatchable `quarantined:<uuid>` and detaches it
  (`contact_id = NULL`); drops each sentinel contact's sentinel identities and
  re-keys its `channel_user_id` so no future message can rejoin it. Idempotent.
- **Re-attribution is NOT attempted.** `handoff_messages` has no per-message field
  that reliably identifies the real sender inside a collapsed thread (`sender` is
  only `user`/`bot`), so splitting strangers back apart would be guessing. We
  contain, keep the data for human review, and leave a quarantined thread invisible
  to `GET /context`.

### Local dry-run → apply → re-run (seeded fixture, NOT production data)

```
=== ID-H §4 identity containment ===
scope: tenant 77CABE8C-07CD-4AB3-91C3-B13031CE3758
sentinel-keyed conversations: 1 (0 mix >1 distinct contact — active collapse)
sentinel contacts:            1
legacy BSUID-cuid contacts:   0 (informational — one real person each, NOT contained)

-- conversations that WOULD be quarantined (re-keyed + detached) --
  conv 0925f200-… wf=wf-whatsapp-barber ref="undefined" contact=2910481d-… distinct_contacts=1
-- contacts that WOULD be detached (sentinel identities dropped, cuid re-keyed) --
  contact 2910481d-… cuid="undefined" sentinel_identities=["undefined"]

DRY RUN — nothing was written. Re-run with --apply to contain the above.
# --apply →  APPLIED: quarantined 1 conversation(s), detached 1 contact(s).
# re-run   →  sentinel-keyed conversations: 0 ; sentinel contacts: 0   (idempotent)
```

## §5 — Documentation

`docs/handoff-contract-v1.md`: rewrote the §B.1 `conversation_ref` row and added
§B.1a — the single derivation helper (`ref = wa_id || user_id || from_user_id ||
from`, throw if none; phone only if E.164; identities = phone + BSUID; lookups phone
else `external_id`), with the rationale for each fallback (including "a `wa_id`
exists ≠ a phone"). Updated §B.3 to send a BSUID via the Cloud API `recipient`, and
D5 to note that bot memory now comes from `GET /context` — which is exactly why the
sentinel guard matters.

## §6 — Tests

- `test/unit/identitySentinel.test.ts` — sentinel words/expressions, the quarantine
  prefix, `isBsuid` incl. ENT, and the `normalizeE164` invariant.
- `test/integration/identityHardening.test.ts` — every entry point refuses a
  sentinel (422, nothing written); ENT BSUID classifies as `external`; a quarantined
  conversation returns nothing even with a valid anchor; merge preserves every child
  row + most-restrictive consent + custom-field rule + `contact_merged` event; §4
  detect→(dry-run writes nothing)→apply→re-detect-empty; and the non-regression that
  a phone + BSUID push links ONE contact carrying both identities.

## Verification

| Check | Result |
| --- | --- |
| Worker `tsc --noEmit` | clean (only pre-existing `s3PrivateStore.ts` implicit-any from the un-installed root `@aws-sdk/*`) |
| Web `tsc --noEmit` | clean (same pre-existing `s3PrivateStore.ts` only) |
| Unit tests | 1131 pass; 1 pre-existing fail (`meetingsStorage`, needs `@aws-sdk/client-s3`) |
| Integration (excl. `meetings*`) | 319 pass; the lone "fail" is `handoffContext.test.ts` bailing on its env guard — **14/14 pass** when run against its own `handoff_context_test` DB |
| Web lint | 18 problems — **unchanged from baseline**, all in pre-existing `page.tsx` / `BookingLinkCard.tsx` |

## Deploy / handoff

**No migration this phase.** All changes are validation, code, a detect/contain
tool, and docs; the `contact_merged` event type and the consent columns already
exist. So the usual DEPLOY.md schema step does **not** apply — this is a code-only
deploy (push to `main`; Railway auto-deploys worker + web).

The one operational handoff action is the §4 tool, run read-only first:

```
# In the Railway worker Console (reads DATABASE_URL from the environment):
npm run identity:contain                 # DRY RUN — prints the real Q1–Q4 numbers, writes nothing
npm run identity:contain -- --tenant=<uuid>          # scope to one tenant
npm run identity:contain -- --apply                  # quarantine, in one transaction
```

Review the dry-run output (it is the production answer to Q1–Q4 that was not
provided here) before running `--apply`. Containment is reversible-by-review: the
data is kept, only re-keyed and detached.
