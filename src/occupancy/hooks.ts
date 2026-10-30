import { recordOccupancyFailure } from './failures.js';
import {
  markDirtyExceptionRange,
  markDirtyForAppointment,
  markDirtyWindowForSite,
  markDirtyWindowForStaff,
} from '../db/repositories/scheduling/occupancy.js';

/**
 * JP-8 §1 — the fail-safe occupancy hooks. Each marks the affected (staff, local day) dirty AFTER
 * the underlying write has committed, wrapped so a marking error NEVER breaks that write (it is
 * swallowed + counted, like the pipeline hooks). A drain worker recomputes the dirty days; the
 * nightly pass is the backstop. The rolling window matches the nightly pass so an hours/break/
 * closure change reconciles the same range the nightly keeps fresh.
 */

/** Rolling recompute window: the past 35 days and the next 30 (operator's spec). */
export const OCCUPANCY_PAST_DAYS = 35;
export const OCCUPANCY_FUTURE_DAYS = 30;

/** What the appointment hooks need — a subset of AppointmentRow. */
export interface OccupancyApptRef {
  tenant_id: string;
  client_id: string;
  site_id: string;
  staff_id: string;
  start_at: Date;
}

async function safe(context: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    recordOccupancyFailure(context, err);
  }
}

/** An appointment was created, completed, no-showed, cancelled, or its service changed (same day). */
export async function occupancyOnAppointmentWritten(appt: OccupancyApptRef): Promise<void> {
  await safe({ job: 'mark-appointment', staffId: appt.staff_id }, () =>
    markDirtyForAppointment(appt.tenant_id, appt.client_id, appt.site_id, appt.staff_id, appt.start_at),
  );
}

/** An appointment moved (reschedule / time-or-artist correction): BOTH the old and new (staff, day)
 *  change, so mark each. Same site (a move never changes the site). */
export async function occupancyOnAppointmentMoved(before: OccupancyApptRef, after: OccupancyApptRef): Promise<void> {
  await occupancyOnAppointmentWritten(before);
  await occupancyOnAppointmentWritten(after);
}

/** A payment was recorded or voided on an appointment — its day's collected amount changed. */
export async function occupancyOnPayment(appt: OccupancyApptRef): Promise<void> {
  await occupancyOnAppointmentWritten(appt);
}

/** A professional's own weekly hours changed → recompute their rolling window. */
export async function occupancyOnStaffHoursChanged(tenantId: string, staffId: string): Promise<void> {
  await safe({ job: 'mark-staff-hours', staffId }, () =>
    markDirtyWindowForStaff(tenantId, staffId, OCCUPANCY_PAST_DAYS, OCCUPANCY_FUTURE_DAYS),
  );
}

/** A site's opening hours or a site-wide break/block changed → recompute the window for every
 *  bookable professional of the site. */
export async function occupancyOnSiteScheduleChanged(tenantId: string, siteId: string): Promise<void> {
  await safe({ job: 'mark-site-schedule', siteId }, () =>
    markDirtyWindowForSite(tenantId, siteId, OCCUPANCY_PAST_DAYS, OCCUPANCY_FUTURE_DAYS),
  );
}

/** A time off / closure was created, edited, or deleted → recompute the days it spans (for the one
 *  professional, or every bookable professional of the site when it is site-wide). */
export async function occupancyOnException(
  tenantId: string,
  siteId: string,
  staffId: string | null,
  startsAt: Date,
  endsAt: Date,
): Promise<void> {
  await safe({ job: 'mark-exception', siteId, staffId }, () =>
    markDirtyExceptionRange(tenantId, siteId, staffId, startsAt, endsAt),
  );
}
