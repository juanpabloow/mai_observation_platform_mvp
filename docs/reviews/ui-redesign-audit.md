# UI-Redesign Merge Audit (PR #3 — `feature/ui-contacts-inbox-redesign`)

**Status: READ-ONLY audit — nothing was changed or fixed.** This document is the only
artifact. Every finding below is reported, none implemented.

Audited on local `main` @ `ba5289a`. Note: `origin/main` is **one commit ahead**
(`1bfc84b2`, created after this local HEAD) — that commit is *outside* the UI-redesign
merge and was **not** audited here; if production runs it, see the caveat in §5.

---

## Bottom line

**No critical issues. No cross-tenant/client data leak. No permission regression. No data
loss.** The suites pass, both builds and tsc are clean. The non-UI parts of this merge are
real but **benign and additive**. The user-visible problems are visual, and the most likely
one is a *global token change bleeding onto surfaces the redesign never intended to touch*.

---

## 1. Scope of the change

| | |
|---|---|
| **Merge SHA** | `3e1b402493b957bb19fc0ca4d49051b28d1b91b4` |
| **PR** | #3, branch `feature/ui-contacts-inbox-redesign` |
| **Author / date** | VanegasMora · 2026-08-05 |
| **Parents** | `5b73852` (main) · `c7eb046` (branch tip) |
| **Branch commits** | `d642392 feat(ui): redesign client operations workspace` + `c7eb046 merge(main): integrate latest changes` |
| **Totals** | **35 files, +3999 / −541** |

### File-level breakdown by area

- **Presentational components (13, all M):** `AccountMenu`, `AppHeader`, `AppSidebar`,
  `AppSidebarServer`, `ClientInboxWorkspace`, `HeaderBar`, `InboxTabLink`, `InboxThread`,
  `MessageTranscript`, `contacts/ContactAssociations`, `contacts/ContactRecord`,
  `CustomerDetailsPanel`, `scheduling/AgendaView`.
- **New components (2, A):** `contacts/ContactsToolbar`, `ui/primitives`.
- **Pages / layouts (4, M):** `clients/[clientId]/contacts/page`,
  `contacts/[contactId]/page`, `scheduling/agenda/page`, `app/layout`.
- **Styles / tokens (1, M):** `app/globals.css`.
- **`web/lib` logic (4):** `clientSurface` (M), `format` (M), `contactColumns` (A),
  `sidebarTheme` (A).
- **Repositories / SQL (2, M):** `src/db/repositories/contacts.ts`,
  `src/db/repositories/scheduling/appointments.ts`.
- **Tests (8):** 5 new (`contactsListFacets`[int], `agendaMergeContract`, `contactColumns`,
  `contactsRedesignContract`, `sidebarTheme`), 3 modified (`deactivationLifecycle`[int],
  `clientInboxNavContract`, `clientSurface`).
- **Docs (1, M):** `machine-api-output-catalog.md`.
- **Server actions / API routes / migrations / `package.json`:** **NONE.**

### Is the "UI-only" description accurate? — **NO, but the non-UI parts are safe.**

Files that are *not* UI, with what each now does:

- **`src/db/repositories/contacts.ts`** — adds a whole CRM **tasks** data layer to the
  contacts list: `open_task_count` / `overdue_task_count` columns, `owner` + `tasks`
  (`open`/`overdue`) filters, an `UNASSIGNED_OWNER` sentinel, and a **new
  `summarizeContacts()`** grouped-count query for the summary strip. It reads the
  **`crm_tasks`** table + indexes `crm_tasks_contact_idx` / `crm_tasks_open_due_idx`.
  *Verified those objects already exist* (`migrations/1782700000000_crm-operational.ts`), so
  **no missing migration** — this is not a code-outruns-schema crash. The join is
  tenant-scoped and client-scoped on both sides (no leak). Not UI, but correct and additive.
- **`src/db/repositories/scheduling/appointments.ts`** — **comment-only** change,
  documenting that main's `primary_identity` superseded the branch's `contact_phone` during
  the merge. No behavior change.
- **`web/lib/format.ts`** — new `formatStampShort` / `formatStampFull` and a new
  `formatMoneyCOP` (see F2-money below — duplicates existing `priceLabelCOP`).
- **`web/lib/clientSurface.ts`** — adds an optional breadcrumb `group` ("CRM"/"Scheduling").
  No routing or gating change.
- **`web/lib/contactColumns.ts`** (new) / **`web/lib/sidebarTheme.ts`** (new) — pure,
  presentational-only by construction (column visibility; a cookie-backed rail color).
- **`web/app/globals.css`** — token/scale changes with **app-wide reach** (see M-1 and the
  global-rescale note): `--background` white→gray, `html{font-size:90%}`, a global radius
  scale. These re-style pages the redesign never touched.

---

## 2. Behavior changes hiding inside a visual change

- **Data access.** The only new/changed queries are in `contacts.ts` (`listContacts` tasks
  join + `summarizeContacts`). **Both carry `tenant_id` AND `client_id`** — the `crm_tasks`
  aggregate is `WHERE tenant_id = $1` and joined `ON t.contact_id = c.id AND t.client_id =
  c.client_id`; `summarizeContacts` scopes `c.tenant_id = $1` and `c.client_id = $N` when a
  clientId is passed. **The contacts page passes the validated `client.id` to both**
  (`contacts/page.tsx:70-84`, one shared `filters` object). No predicate was lost; no
  cross-client count leak. Directly covered by an integration test
  (`contactsListFacets.test.ts`: "fail-closed: the facets never widen past the client").
- **Permissions.** No server/data-layer gate was demoted to a UI-only conditional. The
  contacts list/detail still gate the *data* (`isFullAccess ? listOpenCandidates(...) :
  []`). The sidebar rewrite removed **Settings/Executions/Analytics** as rail *items*, but
  the workflow **Settings page still enforces owner/admin server-side**
  (`workflows/all/settings/page.tsx:30` `notFound()` for members; handoff webhook withheld
  at the data layer; all `webhookActions.ts` mutations call `requireFullAccessForAction()`).
  Moved link, not moved permission.
- **Module gating.** CRM/scheduling/inbox gates still run: contacts routes remain `crm`-gated,
  the record's scheduling actions stay behind the module gate, and
  `createManualAppointmentAction` still gates via `resolveClientModuleContext`.
- **Routing.** No route added/renamed/moved. **H-8.1 route-group contract holds** — no bare
  `[workflowId]` page was added without a wrapper; `(workspace)`/`(padded)`/workflow
  `layout.tsx` are untouched (still pass-through/guard-only). The shell was recomposed
  (sidebar = full-height first column; header moved *inside* the content column) — intentional,
  not a flush-edge regression, though it introduces a universal content gutter (see L-1).
- **Scope model (W-1).** Intact: server-seed → context → URL-wins. The sidebar reads scope
  from context (`useScope()`), `ScopeSync` pushes the URL scope on every transition, and
  `AppSidebarServer` passes **no** scope value — so the "captured at layout render" staleness
  trap is structurally avoided.
- **Deleted / duplicated components.** `git diff --diff-filter=D` is **empty** — nothing
  deleted, no shared export removed. Two duplications noted below (F2-transcript, F2-money).

---

## 3. Things previous phases paid for — intact vs broken

| Feature | State | Evidence |
|---|---|---|
| Inbox: three-panel workspace, take/dismiss/return, composer, send pipeline, scope filtering | **INTACT** | `ClientInboxWorkspace` diff is className/token-only; `ThreadActions`/`Composer`/`sendActions`/`api/inbox` not in the merge |
| Contact record: keyset "load more" (not offset), identities list, appointment/conversation cross-links | **INTACT** | timeline keyset preserved (`ContactTimeline` "Load more is keyset, never offset"); `listIdentitiesForContact` still wired; cross-links relocated to the header, each appears once |
| Contacts list: keyset pagination, client-scoped facets/summary | **INTACT** | keyset cursor only (`ORDER BY c.last_contact_at DESC, c.id DESC`); facet change resets the cursor |
| Scheduling settings: sites/services/staff/exceptions, Featured, booking rules, reactivation | **INTACT (untouched)** | live in `scheduling/admin/page.tsx`, **not in the merge** — the redesign changed only the agenda |
| Agenda | **INTACT + additive** | reads reconciled `primary_identity` + `price_snapshot`; adds week view, KPI deltas, ⌘A shortcut — all still server-scoped/module-gated |
| Executions table + `?execution=` side pane; analytics at both scopes | **INTACT** | not in the merge; but see L-1 (executions now sits inside the shell gutter) and M-1 (side pane fill) |
| Machine API surfaces | **INTACT (untouched)** | no `web/app/api/**` file in the merge |

---

## 4. Quality & consistency

- **Tokens / primitives.** `ui/primitives.tsx` is a clean **canonical** set (no pre-existing
  Card/Button/Badge/Panel it duplicates), fully token-based. **No hardcoded hex** in the
  changed components (the `#8984`-style hits in AgendaView are HTML entities, not colors).
- **Duplicate re-implementations (drift risk):**
  - **F2-money** — `web/lib/format.ts:formatMoneyCOP` (new, used by AgendaView) duplicates
    `web/lib/money.ts:priceLabelCOP` (used by the scheduling machine API). They **agree on
    whole pesos** but **diverge on cents**: `priceLabelCOP` keeps them (`"$2.500,50"`),
    `formatMoneyCOP` uses `maximumFractionDigits: 0` and rounds them away (`"$2.501"`). Same
    price could render two ways across UI vs API.
  - **F2-transcript** — `MessageTranscript` was restyled onto neutral `bubble-*` tokens, but
    its untouched duplicate `ChatTranscript` still hardcodes `bg-emerald-700/90`. **Both are
    rendered by `ExecutionDetailPanel`**, so the same view now shows two bubble styles.
    Pre-existing duplication the merge *widened*.
- **Both themes.** The rail is themed via `data-sidebar-theme` + tokens (not hardcoded); all
  new color tokens have `.dark` variants. The one light/dark-by-construction spot is
  `ChatTranscript`'s hardcoded emerald (F2-transcript) and the header dropdown's
  `bg-white dark:bg-neutral-900` bypassing the `--popover` token (L-2).
- **Global rescale (scope note, not a bug).** `html { font-size: 90% }` and a global radius
  scale in `globals.css` re-tune **every** page in the app, not just the redesigned surfaces.
  Intentional, but it means "UI-only" understates the blast radius.
- **Test coverage.** 71 new cases across 5 files. The 5 `contactsListFacets` are **real
  runtime** integration tests (client/tenant isolation of the new facets — strong). The 38
  `contactsRedesignContract` + others are **source-level pattern assertions** (they string-match
  the code, verifying presence of tokens/structure, not runtime behavior) — a legitimate
  technique used elsewhere in this repo, but brittle to refactors and not a behavior proof.
  **No modified test was weakened**: `deactivationLifecycle` just passes an explicit `NOW` for
  determinism; `clientInboxNavContract` is a genuine structural rewrite of the rail; `clientSurface`
  adds the new `group` field. None changed an assertion to paper over a behavior change.
- **Known stubs (informational):** the contacts **"New contact" button is rendered but
  disabled** (no creation flow behind it — confirmed by test), and AgendaView carries TODOs
  for still-missing backend. Neither is a regression.
- **Interaction:** ⌘A/Ctrl+A on the agenda overrides browser select-all to open the
  new-appointment modal — worth a note for keyboard users (not a gate bypass).

---

## 5. What was run

| Check | Result |
|---|---|
| Auth suite | **21/21 pass** |
| Unit suite | **230/230 pass** |
| Integration suite | **158/158 pass** |
| `tsc` (worker + web) | **clean** |
| `build:worker` / web `build` | **clean** |
| web `lint` | **9 errors + 1 warning — all PRE-DATE the merge** |

The 9 lint errors are React-Compiler rule violations in components the redesign **did not
touch** (`AutoRefresh`, `SidePane`, `ScopeProvider`, `ColumnsMenu`, `FieldPicker`,
`EnableHandoffCallout`, `ExecutionsTable`, and the team/invite pages) — zero overlap with the
merge's 24 web files. Not introduced by this merge.

Suites/builds were run at local HEAD `ba5289a` (which includes this merge + later CRM work).

**Caveats.** (1) `claude-in-chrome` was unavailable this session, so the two visual findings
(M-1, L-1) were confirmed from source/tokens, not a live browser render — a quick visual pass
is advised before/after any fix. (2) `origin/main` is one commit ahead (`1bfc84b2`) of the
tree audited; that commit is outside the UI-redesign merge. If the operator's bug is very
recent and *not* one of the findings below, it may live in that unaudited commit.

---

## 6. Findings (by severity)

No **critical** or **high** findings. No data-integrity or cross-tenant/client issue exists.

### Medium

**M-1 — Untouched surfaces render gray-on-gray after the global `--background` change.**
The merge changed `--background` from white to a gray canvas (`#ffffff→#eff1f5` light,
`#0a0a0a→#101012` dark) to create the "floating card on a canvas" look. But surfaces the
redesign didn't migrate still use `bg-background`, so they now blend into the canvas instead
of reading as a distinct white panel.
- *Where:* `web/components/SidePane.tsx:114` (`bg-background shadow-2xl` slide-over),
  `web/components/ClientInboxWorkspace.tsx:304` (`bg-background/95` sticky header).
- *Reproduce:* open any execution/detail SidePane, or scroll the inbox — the pane/header fill
  is now the canvas gray, not a distinct surface. **Most likely candidate for the reported
  production bug.**
- *Suggested fix (do not implement):* switch these surfaces from `bg-background` to
  `bg-surface` (the new panel token); audit remaining repo-wide `bg-background` usages.

**M-2 — "Last activity" column silently changed meaning.**
The cell now renders `contacts.last_contact_at` (a stored column also bumped by message-count
and CRM-enrichment writes) instead of the previous `last_conversation_at` (a conversations
aggregate). Same rows, different value.
- *Where:* `web/app/clients/[clientId]/contacts/page.tsx:231`.
- *Reproduce:* a contact whose most recent conversation predates a later non-conversation
  touch (e.g. an enrichment write) shows a different, more-recent timestamp than before.
- *Note:* it now matches the keyset sort key, so it reads as intentional — but the header
  still says "Last activity", which the value no longer strictly is.
- *Suggested fix:* rename the header to "Last contact", or revert the cell to
  `c.last_conversation_at` (still selected and available).

**M-3 — Duplicate money + transcript implementations diverging.**
`formatMoneyCOP` vs `priceLabelCOP` disagree on cents (`web/lib/format.ts` vs
`web/lib/money.ts`); `MessageTranscript` (token-based) vs `ChatTranscript` (hardcoded
`bg-emerald-700/90`) render side-by-side in `ExecutionDetailPanel`.
- *Reproduce:* a fractional price shows differently in the agenda vs the machine API; the
  execution-detail view shows two bubble styles, and `ChatTranscript` won't follow the theme.
- *Suggested fix:* consolidate to one money formatter and one transcript component.

### Low

- **L-1 — Full-bleed `(workspace)` executions is no longer edge-to-edge:** it now sits inside
  the shell's universal `p-[var(--content-pad)]` gutter (`app/layout.tsx:84`). Cosmetic;
  internal scroll preserved. *Fix:* have the `(workspace)` slot cancel the gutter, or move the
  gutter into `(padded)` only.
- **L-2 — Header dropdown bypasses the popover token:** hardcodes `bg-white dark:bg-neutral-900`
  (`HeaderBar.tsx:148`) instead of `bg-popover`. Works in both themes, inconsistent with the
  sidebar's tokenized popover.
- **L-3 — Suspense rail fallback mismatch:** `app/layout.tsx:70` uses the old `bg-sidebar`
  token + hardcoded `w-60` (240px) vs the resolved rail's `bg-sidebar-bg` /
  `var(--sidebar-width)` (238px) — a ~2px width flash pre-hydration, and it won't reflect the
  "Navy" rail preference.
- **L-4 — Agenda empty-state double padding:** the no-sites state keeps `px-6 py-20`
  (`scheduling/agenda/page.tsx:48`) on top of the shell gutter.
- **L-5 — Cosmetic JSX mis-indentation** in `contacts/ContactRecord.tsx:74-113` (renders fine).

---

## The three to fix first

1. **M-1 (gray-on-gray surfaces).** Broadest impact, user-visible on surfaces the redesign
   didn't intend to change, and the most likely thing the operator actually saw. Cheap:
   `bg-background → bg-surface` on the affected panels.
2. **M-2 ("Last activity" meaning).** It silently changed what a column *means* in the
   operator's primary list — actively misleading, and a one-line fix (rename or revert).
3. **M-3 (duplicate money/transcript).** Most structural of the rest: collapsing the two
   money formatters and the two transcript components stops ongoing drift and removes the one
   real both-theme inconsistency (`ChatTranscript`'s hardcoded emerald).

Order = reach × how-misleading, then structural debt.
