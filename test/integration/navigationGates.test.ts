import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';
import { buildSections, type NavContext, type PageId } from '../../web/lib/sectionNav.js';
import { AGENCY_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } from '../../web/lib/permissions/catalog.js';

/**
 * NAVIGATION ↔ SERVER GATES, against a real local test database. Every page the sidebar
 * (lib/sectionNav.ts) can link to is INVOKED — its real server gate
 * runs (session → tenant membership → client scope → module → role) — for every role and
 * several module combinations, and the outcome is compared with what the rail/tabs show:
 *
 *   shown  ⇒ the page opens          (nobody is offered a link that 404s)
 *   hidden ⇒ the page refuses        (hiding a link is never the only protection)
 *
 * with the few pre-existing exceptions listed explicitly below (capabilities that the
 * brief says to keep exactly as they are). The legacy routes are invoked too: they keep
 * the same gate and redirect to the page that now owns each function.
 *
 * Only the session read and Next's boundaries are stubbed; page components are replaced
 * by inert stand-ins (nothing is rendered — the gate is what is under test).
 */

// ── Next boundaries ─────────────────────────────────────────────────────────────────
class NotFoundSignal extends Error {}
class RedirectSignal extends Error {
  constructor(readonly url: string) { super(`redirect ${url}`); }
}
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: {
    getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null),
  },
});
const webRoot = resolvePath(process.cwd(), 'web');
const reqFromWeb = createRequire(pathToFileURL(resolvePath(webRoot, 'lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: (url: string) => { throw new RedirectSignal(url); },
    permanentRedirect: (url: string) => { throw new RedirectSignal(url); },
    notFound: () => { throw new NotFoundSignal('404'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_noStore: () => {} } });
mock.module(urlOf('next/server'), { namedExports: { connection: async () => {}, after: () => {} } });
mock.module(urlOf('server-only'), { namedExports: {} });
mock.module(urlOf('next/link'), { defaultExport: () => null });
// Reuniones' data layer lazy-imports an `@worker/…` path the root runner cannot map; its gate
// (requireClientModulePage) runs BEFORE any of it, so an empty list is enough here.
mock.module(pathToFileURL(resolvePath(webRoot, 'lib/meetingsData.ts')).href, {
  namedExports: {
    listMeetings: async () => [],
    headlineOf: () => ({ total: 0, done: 0, processing: 0, attention: 0, transcribedSeconds: 0 }),
  },
});
// The root runner compiles the pages' JSX with the classic runtime (React.createElement).
(globalThis as { React?: unknown }).React = reqFromWeb('react');

// ── Pages under test ────────────────────────────────────────────────────────────────
const C = 'app/clients/[clientId]';
const PAGES: Array<{ file: string; page: PageId | null; legacyOf?: PageId; withChildren?: boolean }> = [
  { file: `${C}/inbox/page.tsx`, page: 'inbox' },
  { file: `${C}/contacts/page.tsx`, page: 'contacts' },
  { file: `${C}/scheduling/agenda/page.tsx`, page: 'calendar' },
  { file: `${C}/scheduling/staff/page.tsx`, page: 'team' },
  { file: `${C}/scheduling/hours/page.tsx`, page: 'hours' },
  { file: `${C}/scheduling/services/page.tsx`, page: 'services' },
  { file: `${C}/catalog/page.tsx`, page: 'products' },
  { file: `${C}/scheduling/promotions/page.tsx`, page: 'promotions' },
  { file: `${C}/scheduling/booking-page/page.tsx`, page: 'booking-page' },
  { file: `${C}/scheduling/reviews/page.tsx`, page: 'reviews' },
  { file: `${C}/campaigns/page.tsx`, page: 'campaigns' },
  { file: `${C}/analytics/layout.tsx`, page: 'value', withChildren: true },
  { file: `${C}/scheduling/sites/page.tsx`, page: 'sites' },
  { file: `${C}/scheduling/rules/page.tsx`, page: 'rules' },
  { file: `${C}/contacts/fields/page.tsx`, page: 'fields' },
  { file: `${C}/team/page.tsx`, page: 'users' },
  { file: `${C}/workflows/page.tsx`, page: 'workflows' },
  { file: `${C}/workflows/all/analytics/page.tsx`, page: 'tech-analytics' },
  { file: `${C}/reuniones/page.tsx`, page: 'meetings' },
  { file: `${C}/modules/page.tsx`, page: 'modules' },
  // Legacy routes: same gate as the page that now owns the function, then a redirect.
  { file: `${C}/scheduling/admin/page.tsx`, page: null, legacyOf: 'sites' },
  { file: `${C}/scheduling/availability/page.tsx`, page: null, legacyOf: 'hours' },
  { file: `${C}/scheduling/exceptions/page.tsx`, page: null, legacyOf: 'hours' },
];

/** Replace every `@/components/…` module a page imports with inert stand-ins, so importing
 *  a page never pulls a client component (hooks, CSS) into the server test process. */
function stubComponents(): void {
  const seen = new Set<string>();
  for (const p of PAGES) {
    const src = readFileSync(resolvePath(webRoot, p.file), 'utf8');
    for (const m of src.matchAll(/from "@\/components\/([^"]+)"/g)) {
      const rel = m[1];
      if (seen.has(rel)) continue;
      seen.add(rel);
      const file = ['.tsx', '.ts'].map((ext) => resolvePath(webRoot, `components/${rel}${ext}`)).find(existsSync);
      assert.ok(file, `component ${rel} exists`);
      const code = readFileSync(file, 'utf8');
      const names = new Set<string>();
      for (const e of code.matchAll(/export (?:async )?(?:function|const|class|let) (\w+)/g)) names.add(e[1]);
      for (const e of code.matchAll(/export \{([^}]+)\}/g)) for (const n of e[1].split(',')) names.add(n.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, ''));
      const stub = () => null;
      mock.module(pathToFileURL(file).href, {
        namedExports: Object.fromEntries([...names].filter(Boolean).map((n) => [n, stub])),
        ...(/export default/.test(code) ? { defaultExport: stub } : {}),
      });
    }
  }
}
stubComponents();

const loaded = new Map<string, (props: Record<string, unknown>) => Promise<unknown>>();
for (const p of PAGES) {
  const mod = (await import(pathToFileURL(resolvePath(webRoot, p.file)).href)) as { default: (props: Record<string, unknown>) => Promise<unknown> };
  loaded.set(p.file, mod.default);
}

type Outcome = 'ok' | '404' | `redirect:${string}`;
async function visit(file: string, clientId: string, withChildren = false): Promise<Outcome> {
  const props: Record<string, unknown> = { params: Promise.resolve({ clientId }), searchParams: Promise.resolve({}) };
  if (withChildren) props.children = null;
  try {
    await loaded.get(file)!(props);
    return 'ok';
  } catch (e) {
    if (e instanceof NotFoundSignal) return '404';
    if (e instanceof RedirectSignal) return `redirect:${e.url}`;
    throw new Error(`${file}: ${(e as Error).stack ?? e}`);
  }
}
const asUser = (userId: string | null) => { CURRENT = userId ? { id: userId, email: `${userId.slice(0, 8)}@test.local` } : null; };

after(closeDb);

const ALL = ['inbox', 'crm', 'scheduling', 'catalog', 'campaigns', 'meetings'];
const COMBOS: Record<string, string[]> = {
  'todos los módulos': ALL,
  'servicios sin productos': ['scheduling'],
  'productos sin agenda': ['catalog', 'crm'],
  'agenda sin campañas': ['scheduling', 'crm', 'inbox'],
  'sin módulos': [],
};

/**
 * PRE-EXISTING page rules that are wider than the rail (kept exactly, per the brief —
 * "conserva exactamente las capacidades actuales"). Each was already true before this
 * change; the navigation simply does not advertise it.
 */
const KNOWN_WIDER: Array<{ who: string; page: PageId; why: string }> = [
  // (empty) — recepción → Reuniones used to be the one wider rule; since 2026-10-20 the
  // server refuses it too (canAccessMeetings), so shown ⇔ opens holds with no exception.
]

test('every role × module combination: shown ⇔ the server gate opens, and legacy routes keep the gate', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  try {
    const users: Array<{ who: string; id: string; nav: Omit<NavContext, 'clientId' | 'modules' | 'defaultClientId'> }> = [
      { who: 'agency', id: await seedMember(s.tenantId, { role: 'owner' }), nav: { isAgency: true, permissions: [...AGENCY_PERMISSIONS], staffBound: false, memberClientId: null } },
      { who: 'admin', id: await seedMember(s.tenantId, { role: 'admin' }), nav: { isAgency: true, permissions: [...AGENCY_PERMISSIONS], staffBound: false, memberClientId: null } },
      { who: 'owner', id: await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' }), nav: { isAgency: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.owner], staffBound: false, memberClientId: s.clientId } },
      { who: 'setter', id: await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' }), nav: { isAgency: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.setter], staffBound: false, memberClientId: s.clientId } },
      { who: 'owner of B', id: await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' }), nav: { isAgency: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.owner], staffBound: false, memberClientId: s.otherClientId } },
    ];
    // A CUSTOM role (roles v1): «Marketing y agenda» — the rail must match the server gates
    // for it too, page by page, in every module combination.
    const customPerms = ['campaigns.view', 'campaigns.manage', 'analytics.view', 'agenda.view', 'agenda.book', 'hours.manage', 'contacts.view', 'access.users.view'];
    const role = (await query<{ id: string }>(`INSERT INTO access_roles (tenant_id, client_id, name) VALUES ($1, $2, 'Marketing y agenda') RETURNING id`, [s.tenantId, s.clientId])).rows[0].id;
    await query(`INSERT INTO access_role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[])`, [role, customPerms]);
    const customUser = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    await query(`UPDATE tenant_members SET client_role = 'custom', access_role_id = $3 WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, customUser, role]);
    users.push({ who: 'custom role', id: customUser, nav: { isAgency: false, permissions: customPerms, staffBound: false, memberClientId: s.clientId } });
    const staffUser = randomUUID();
    await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Staff', $2, true)`, [staffUser, `${staffUser.slice(0, 8)}@test.local`]);
    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
      [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
    );
    users.push({ who: 'staff', id: staffUser, nav: { isAgency: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.staff], staffBound: true, memberClientId: s.clientId } });
    const foreignAgency = await seedMember(other.tenantId, { role: 'owner' });

    const mismatches: string[] = [];
    // Optional evidence: NAV_MATRIX_OUT=<file> writes every observed outcome (for review).
    const matrix: string[] = ['combo\trole\tpage\tshown\toutcome'];
    for (const [combo, modules] of Object.entries(COMBOS)) {
      for (const m of ALL) await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: m, enabled: modules.includes(m) });

      for (const u of users) {
        asUser(u.id);
        const shown = new Set(
          buildSections({ ...u.nav, clientId: s.clientId, modules, defaultClientId: u.nav.isAgency ? s.defaultClientId : null })
            .flatMap((sec) => sec.pages.map((p) => p.id)),
        );
        for (const p of PAGES) {
          const out = await visit(p.file, s.clientId, p.withChildren);
          const opened = p.page ? out === 'ok' : out.startsWith('redirect:/clients/') && out.includes(`/scheduling/${p.legacyOf}`);
          const visible = shown.has((p.page ?? p.legacyOf)!);
          matrix.push(`${combo}\t${u.who}\t${p.file.replace(`${C}/`, '')}\t${visible ? 'sí' : 'no'}\t${out.replace(s.clientId, '<A>')}`);
          if (visible === opened) continue;
          const id = (p.page ?? p.legacyOf)!;
          if (!visible && opened && KNOWN_WIDER.some((k) => k.who === u.who && k.page === id)) continue;
          mismatches.push(`[${combo}] ${u.who} · ${p.file.replace(`${C}/`, '')}: ${visible ? 'shown' : 'hidden'} but ${out}`);
        }
      }

      // Another tenant's agency: nothing of this client opens, whatever its modules.
      asUser(foreignAgency);
      for (const p of PAGES) {
        const out = await visit(p.file, s.clientId, p.withChildren);
        if (out === 'ok' || out.includes(`/clients/${s.clientId}/`)) mismatches.push(`[${combo}] foreign agency · ${p.file}: ${out}`);
      }
      // Logged out: never opens.
      asUser(null);
      for (const p of PAGES) {
        const out = await visit(p.file, s.clientId, p.withChildren);
        if (out === 'ok' || out.includes(`/clients/${s.clientId}/`)) mismatches.push(`[${combo}] no session · ${p.file}: ${out}`);
      }
    }

    // The default ("Unassigned") client: no scheduling settings and no Módulos, even for
    // the agency and even with the modules rows present.
    for (const m of ALL) await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.defaultClientId, moduleKey: m, enabled: true });
    asUser(users[0].id);
    const shownDefault = new Set(
      buildSections({ ...users[0].nav, clientId: s.defaultClientId, modules: [], defaultClientId: s.defaultClientId }).flatMap((sec) => sec.pages.map((p) => p.id)),
    );
    for (const p of PAGES) {
      const id = (p.page ?? p.legacyOf)!;
      if (shownDefault.has(id)) continue;
      const out = await visit(p.file, s.defaultClientId, p.withChildren);
      const opened = p.page ? out === 'ok' : out.startsWith('redirect:/clients/');
      if (opened) mismatches.push(`[default client] agency · ${p.file}: hidden but ${out}`);
    }

    if (process.env.NAV_MATRIX_OUT) writeFileSync(process.env.NAV_MATRIX_OUT, `${matrix.join('\n')}\n`);
    assert.ok(matrix.filter((r) => r.endsWith('\tok')).length > 50, 'the matrix really opened pages');
    assert.ok(matrix.filter((r) => r.endsWith('\t404')).length > 50, 'and really refused others');
    assert.deepEqual(mismatches, [], `navigation and server gates disagree:\n${mismatches.join('\n')}`);
  } finally {
    await cleanupTenant(s.tenantId);
    await cleanupTenant(other.tenantId);
  }
});

test('legacy links keep their deep link through the redirect, behind the same gate', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const go = async (file: string, sp: Record<string, string>) => {
      try {
        await loaded.get(`${C}/${file}`)!({ params: Promise.resolve({ clientId: s.clientId }), searchParams: Promise.resolve(sp) });
        return 'ok';
      } catch (e) {
        if (e instanceof RedirectSignal) return e.url;
        if (e instanceof NotFoundSignal) return '404';
        throw e;
      }
    };
    asUser(owner);
    const base = `/clients/${s.clientId}/scheduling`;
    assert.equal(await go('scheduling/admin/page.tsx', {}), `${base}/sites`);
    assert.equal(await go('scheduling/admin/page.tsx', { m: 'servicio', id: s.serviceHaircut }), `${base}/services?m=servicio&id=${s.serviceHaircut}`);
    assert.equal(await go('scheduling/admin/page.tsx', { m: 'bloqueo-nuevo', plantilla: 'festivo' }), `${base}/hours?m=bloqueo-nuevo&plantilla=festivo#ausencias`);
    assert.equal(await go('scheduling/availability/page.tsx', { tab: 'excepciones' }), `${base}/hours#ausencias`);
    assert.equal(await go('scheduling/exceptions/page.tsx', {}), `${base}/hours#ausencias`);
    assert.equal(await go('scheduling/availability/page.tsx', { tab: 'profesionales' }), `${base}/hours`);
    assert.equal(await go('scheduling/booking-page/page.tsx', { tab: 'categorias' }), `${base}/booking-page#categorias`);
    asUser(setter);
    for (const f of ['scheduling/admin/page.tsx', 'scheduling/availability/page.tsx', 'scheduling/exceptions/page.tsx', 'scheduling/booking-page/page.tsx']) {
      assert.equal(await go(f, { tab: 'categorias' }), '404', `${f}: a setter learns nothing from the legacy link`);
    }
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
