/**
 * The SERVICE EDITOR's save, as a pure sequence over injected actions — so it can be
 * tested without a browser (test/unit/serviceSave.test.ts) and the editor only wires
 * the real server actions in.
 *
 * Saving is several writes in a row: the service (CREATE — atomic with its initial
 * sites, see createServiceWithSites — or UPDATE), `featured` after a create, the site
 * enablements, then the professionals. `persisted` is what the SERVER holds and is
 * advanced after every successful write, so when a write fails midway the next save
 * resumes from there: a service created before the failure is UPDATED, never created a
 * second time, and sites/staff are diffed against what was really written.
 */

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

export interface ServiceFields {
  name: string;
  description: string;
  durationMin: number;
  price: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  category: string | null;
}

export interface PersistedService {
  id: string | null;
  siteIds: string[];
  staffIds: string[];
}

export interface ServiceSaveActions {
  create: (fields: ServiceFields, siteIds: string[]) => Promise<ActionResult>;
  update: (id: string, patch: Partial<ServiceFields> & { featured?: boolean }) => Promise<ActionResult>;
  setSite: (siteId: string, serviceId: string, enabled: boolean) => Promise<ActionResult>;
  setStaff: (staffId: string, serviceId: string, assigned: boolean) => Promise<ActionResult>;
}

export interface ServiceSaveInput {
  fields: ServiceFields;
  featured: boolean;
  siteIds: string[];
  staffIds: string[];
  /** Every site / professional the form lists, in display order. */
  allSiteIds: string[];
  allStaffIds: string[];
}

export type ServiceSaveOutcome = { ok: true; id: string } | { ok: false; error: string; partial: boolean };

export async function runServiceSave(
  persisted: PersistedService,
  input: ServiceSaveInput,
  actions: ServiceSaveActions,
): Promise<ServiceSaveOutcome> {
  let wrote = false;
  const fail = (error: string): ServiceSaveOutcome => ({ ok: false, error, partial: wrote });
  try {
    if (persisted.id) {
      const r = await actions.update(persisted.id, { ...input.fields, featured: input.featured });
      if (!r.ok) return fail(r.error);
      wrote = true;
    } else {
      const r = await actions.create(input.fields, input.siteIds);
      if (!r.ok) return fail(r.error);
      if (!r.id) return fail("No se pudo crear el servicio.");
      // Created together with its sites, in one transaction (all or nothing).
      persisted.id = r.id;
      persisted.siteIds = [...input.siteIds];
      wrote = true;
      // `featured` is not part of create — set right after, through the update action.
      if (input.featured) {
        const rf = await actions.update(persisted.id, { featured: true });
        if (!rf.ok) return fail(rf.error);
      }
    }
    const id = persisted.id;
    for (const siteId of input.allSiteIds) {
      const want = input.siteIds.includes(siteId);
      if (want === persisted.siteIds.includes(siteId)) continue;
      const r = await actions.setSite(siteId, id, want);
      if (!r.ok) return fail(r.error);
      persisted.siteIds = want ? [...persisted.siteIds, siteId] : persisted.siteIds.filter((x) => x !== siteId);
    }
    for (const staffId of input.allStaffIds) {
      const want = input.staffIds.includes(staffId);
      if (want === persisted.staffIds.includes(staffId)) continue;
      const r = await actions.setStaff(staffId, id, want);
      if (!r.ok) return fail(r.error);
      persisted.staffIds = want ? [...persisted.staffIds, staffId] : persisted.staffIds.filter((x) => x !== staffId);
    }
    return { ok: true, id };
  } catch (e) {
    return fail(e instanceof Error && e.message ? e.message : "No se pudo guardar el servicio.");
  }
}
