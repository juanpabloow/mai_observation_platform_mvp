import type { Weekday } from './timezone.js';

/** A local wall-clock range within a day, "HH:MM"–"HH:MM" in the site timezone. */
export interface HoursRange {
  start: string;
  end: string;
}

/** Weekly opening/working hours: weekday → local ranges. A missing weekday = closed. */
export type WeeklyHours = Partial<Record<Weekday, HoursRange[]>>;

/** Per-site scheduling parameters (stored in sites.scheduling_config). */
export interface SchedulingConfig {
  slot_interval_min: number;
  min_notice_min: number;
  booking_horizon_days: number;
  default_buffer_before_min: number;
  default_buffer_after_min: number;
}

export const DEFAULT_SCHEDULING_CONFIG: SchedulingConfig = {
  slot_interval_min: 15,
  min_notice_min: 120,
  booking_horizon_days: 30,
  default_buffer_before_min: 0,
  default_buffer_after_min: 0,
};

/** The site facts the availability engine needs (no DB types leak in). */
export interface SiteAvailabilityInput {
  id: string;
  timezone: string;
  opening_hours: WeeklyHours;
  scheduling_config: SchedulingConfig;
}

/** A candidate staff member with resolved (post-override) service timing. */
export interface StaffAvailabilityInput {
  id: string;
  working_hours: WeeklyHours;
  /** UTC blocked ranges from that staff's ACTIVE appointments. */
  busy: Array<{ from: Date; until: Date }>;
  /** UTC ranges from staff-specific exceptions. */
  exceptions: Array<{ from: Date; until: Date }>;
}

/** Effective service timing (after site/staff overrides applied by the caller). */
export interface ServiceTiming {
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
}

export interface AvailabilityRequest {
  site: SiteAvailabilityInput;
  service: ServiceTiming;
  staff: StaffAvailabilityInput[];
  /** UTC ranges from site-wide exceptions (staff_id NULL). */
  siteExceptions: Array<{ from: Date; until: Date }>;
  from: Date;
  to: Date;
  /** "Now" for min-notice/horizon filtering (injected for testability). */
  now: Date;
}

/** One bookable slot: the customer-visible service window + the staff to book. */
export interface Slot {
  start_at: Date;
  service_end_at: Date;
  /** Deterministically chosen staff for "any"; the requested staff otherwise. */
  staff_id: string;
  /** All staff that can take this exact slot (⊇ {staff_id}). */
  available_staff_ids: string[];
}
