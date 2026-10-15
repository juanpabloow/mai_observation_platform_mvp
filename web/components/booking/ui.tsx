/**
 * Shared pieces of the public booking page (v3 design): the data shapes the page
 * receives from the public endpoints, the class recipes the design repeats, and the
 * line icons. Presentational only.
 */

import type { ApptCategory } from "@/lib/agendaCategory";
import { ratingText, reviewCountText } from "@/lib/publicReviews";

export interface PublicSiteView {
  name: string;
  address: string | null;
  timezone: string;
  closed_weekdays: string[];
  booking_horizon_days: number;
  /** E.164, validated server-side; null = the business published no WhatsApp. */
  whatsapp?: string | null;
  directions_url?: string | null;
  hours?: Array<{ days: string; hours: string }>;
}

export interface CategoryView {
  id: string;
  name: string;
  tagline: string | null;
  layout: "list" | "featured" | "contact";
}

export interface RatingSummary {
  average: number;
  count: number;
}

export interface PublicReview {
  author: string;
  service: string;
  rating: number;
  comment: string | null;
  submitted_at: string;
}

export interface ServiceOption {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price: string | null;
  family: ApptCategory;
  /** Approved reviews only; null = none yet. */
  rating?: RatingSummary | null;
  /** The latest approved reviews of this service (≤ 3). */
  reviews?: PublicReview[];
  /** Booking-page presentation (migration 1804). */
  category_id?: string | null;
  recommended?: boolean;
  image_url?: string | null;
  includes?: string[];
  upgrade_to?: string | null;
}

export interface StaffOption {
  id: string;
  name: string;
  duration_min: number;
  price: string | null;
  title: string | null;
  bio: string | null;
  photo_url: string | null;
  service_ids: string[];
  rating?: RatingSummary | null;
  reviews?: PublicReview[];
}

export interface Slot {
  start_at: string;
  service_end_at: string;
  staff_id: string;
  available_staff_ids: string[];
}

export interface PublicConfirmation {
  reference: string;
  site: string;
  address: string | null;
  service: string;
  staff_name: string | null;
  start_at: string;
  service_end_at: string;
  duration_min: number;
  price: string | null;
  timezone: string;
}

/** Selected card: 1px black border + 1px ring (2px total, the layout never jumps). Cards
 * stay WHITE on the grey ground either way; the ring and the ✓ say "selected". The change
 * is animated (`pb-sel`, globals.css) and honours reduced motion. */
export const ring = (selected: boolean) =>
  `pb-sel ${selected ? "border border-pb-ink shadow-[0_0_0_1px_#111316] bg-white" : "border border-pb-line bg-white"}`;

/** The black primary action; `muted` is the design's disabled look (still focusable). */
export const CTA_BASE =
  "pb-press inline-flex min-h-[52px] items-center justify-center gap-2.5 whitespace-nowrap rounded-[12px] px-[22px] text-[16px] font-[590] transition-[background-color,color,transform] duration-150";
export const ctaTone = (state: "on" | "muted" | "sending" | "outline") =>
  state === "on"
    ? "bg-pb-ink text-white"
    : state === "sending"
      ? "bg-pb-tx2 text-white cursor-progress"
      : state === "outline"
        ? "border border-pb-line3 bg-white text-pb-ink"
        : "bg-pb-line text-pb-muted cursor-not-allowed";

/** Secondary pill-ish button ("Elegir artista", "Reservar sin preferencia"). */
export const BTN_SECONDARY =
  "pb-sel pb-press inline-flex min-h-[44px] items-center justify-center whitespace-nowrap rounded-[12px] border border-pb-line3 bg-white px-4 text-[15px] text-pb-ink";
export const BTN_PRIMARY_SM =
  "pb-sel pb-press inline-flex min-h-[44px] items-center justify-center whitespace-nowrap rounded-[12px] border border-pb-ink bg-pb-ink px-4 text-[15px] font-[590] text-white";
/** Underlined text action ("Ver más", "Ver perfil", "Cambiar", "Editar"). */
export const LINK_BTN =
  "inline-flex min-h-[44px] items-center rounded-[12px] px-2 text-[14px] text-pb-ink underline underline-offset-[3px]";

export const SERIF = "font-pb-serif font-normal";

export function IconBack({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 12H5M11 5l-7 7 7 7" />
    </svg>
  );
}
export function IconArrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}
export function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  );
}
export function IconCheck({ size = 18, stroke = "#fff", width = 2 }: { size?: number; stroke?: string; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={width} aria-hidden>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}
export function IconPlus() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#111316" strokeWidth="1.6" aria-hidden>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
export function IconChevron({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d={dir === "prev" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}
export function IconInfo() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="mt-px flex-none">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.8v3.6M8 10.8v.4" />
    </svg>
  );
}
export function IconWifi() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="mt-px flex-none">
      <path d="M2 6.5a9 9 0 0 1 12 0M4.3 8.9a5.6 5.6 0 0 1 7.4 0M8 12.5v.3" />
    </svg>
  );
}
export function IconShuffle() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4B3F78" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7h3.5c2.5 0 3.8 1.3 5.5 5s3 5 5.5 5H21M18 14l3 3-3 3M3 17h3.5c1.2 0 2.1-.3 2.9-1M14.6 8c.8-.7 1.7-1 2.9-1H21M18 4l3 3-3 3" />
    </svg>
  );
}

/** The design's amber star (decorative — the number beside it carries the meaning). */
export function IconStar({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="flex-none">
      <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z" fill="#E8A317" />
    </svg>
  );
}

export function Spinner() {
  return <span aria-hidden className="pb-spin inline-block size-4 rounded-full border-2 border-white/35 border-t-white" />;
}

/** Artist portrait: the uploaded photo, or a discreet pastel with initials. */
export function Portrait({
  photoUrl,
  initials,
  tone,
  className,
  initialsClass,
  label,
}: {
  photoUrl: string | null;
  initials: string;
  tone: string;
  className: string;
  initialsClass: string;
  label: string;
}) {
  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2), sized by CSS
      <img src={photoUrl} alt={label} className={`${className} object-cover`} loading="lazy" decoding="async" />
    );
  }
  return (
    <div role="img" aria-label={label} className={`${className} flex items-center justify-center`} style={{ background: tone }}>
      <span aria-hidden className={`${SERIF} text-pb-body ${initialsClass}`}>
        {initials}
      </span>
    </div>
  );
}

/** WhatsApp's mark, monochrome (the page stays black and white). */
export function IconWhatsApp({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="flex-none">
      <path d="M12 2.2a9.7 9.7 0 0 0-8.4 14.6L2.3 21.7l5-1.3A9.7 9.7 0 1 0 12 2.2Zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9Zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3Z" />
    </svg>
  );
}
export function IconPin() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="mt-px flex-none">
      <path d="M8 14.5s4.8-4.3 4.8-8a4.8 4.8 0 1 0-9.6 0c0 3.7 4.8 8 4.8 8Z" />
      <circle cx="8" cy="6.4" r="1.7" />
    </svg>
  );
}
export function IconHours() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="mt-px flex-none">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.4 1.5" />
    </svg>
  );
}
export function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
export function IconUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden className="flex-none">
      <path d="M8 13V3.5M4 7.5 8 3.5l4 4" />
    </svg>
  );
}

/** "★ 4,8 (4)" as a button that opens the reviews it summarises — never a fake value. */
export function RatingButton({
  rating,
  onOpen,
  label,
  size = "sm",
}: {
  rating: RatingSummary;
  onOpen: (trigger: HTMLElement) => void;
  /** What the rating is OF, for the accessible name ("Corte Signature"). */
  label: string;
  size?: "sm" | "md";
}) {
  const avg = ratingText(rating.average);
  const count = reviewCountText(rating.count);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`${avg} de 5, ${count} de ${label}. Ver reseñas`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
      className={`pb-sel pb-press -mx-1.5 -my-2.5 inline-flex min-h-[44px] items-center gap-1 rounded-[8px] px-1.5 text-pb-tx2 underline-offset-[3px] hover:underline ${size === "md" ? "text-[14.5px]" : "text-[13.5px]"}`}
    >
      <IconStar size={size === "md" ? 15 : 13} />
      <span aria-hidden className="[font-variant-numeric:tabular-nums]">
        <span className="font-semibold text-pb-ink">{avg}</span> <span className="text-pb-muted">({count})</span>
      </span>
    </button>
  );
}
