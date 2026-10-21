/**
 * CONTACTS LIST LAYOUT — the pure half of ContactsTable, unit-tested on its own
 * (test/unit/contactListLayout.test.ts).
 *
 * Three widths, one list:
 *   - phone (< md)      a compact row per contact (mobileRowLines), no table at all — the
 *                       desktop table measured 860px inside a 345px card at 390;
 *   - tablet (md – lg)  the table without `Visitas` (the meter is a ranking aid that
 *                       still lives in the record) and a 44px record link, so it fits the
 *                       ~720px a 768px screen leaves without scrolling sideways;
 *   - desktop (lg+)     the design's seven columns, unchanged.
 */
import { displayContactName, isMeaningfulName } from "./contactName";

/** The seven columns the design specifies, in order (desktop, lg+). */
export const CORE_TEMPLATE =
  "minmax(200px,1.7fr) minmax(128px,1fr) minmax(92px,0.72fr) minmax(108px,0.86fr) minmax(140px,1fr) 44px 28px";

/** Tablet (md – lg): no Visitas track, and the record link's track is a 44px target. */
export const TABLET_TEMPLATE =
  "minmax(180px,1.7fr) minmax(124px,1fr) minmax(84px,0.72fr) minmax(120px,1fr) 44px 44px";

/** Each opt-in column, appended before the record link. */
export const OPTIONAL_TRACK = "minmax(110px,1fr)";

/** Splice the optional tracks in before the LAST (record-link) track. */
export function withOptionalTracks(template: string, optionalCount: number): string {
  const tracks = template.split(" ");
  const last = tracks.pop()!;
  return [...tracks, ...Array.from({ length: optionalCount }, () => OPTIONAL_TRACK), last].join(" ");
}

/** The minimum width a grid template needs: track minimums + column gaps + row padding. */
export function templateMinWidth(template: string, gapPx = 10, paddingPx = 32): number {
  const tracks = template.split(" ");
  const min = tracks.reduce((sum, t) => {
    const m = /^minmax\((\d+)px,/.exec(t) ?? /^(\d+)px$/.exec(t);
    return sum + (m ? Number(m[1]) : 0);
  }, 0);
  return min + gapPx * (tracks.length - 1) + paddingPx;
}

export interface MobileRowContact {
  name: string | null;
  channel_user_id: string;
  phone_e164: string | null;
  email: string | null;
}

/**
 * The phone row's two text lines: WHO (name, else the raw id) and HOW TO REACH THEM —
 * the phone if there is one, else the email. When the list projection has neither,
 * direct the user to the record: additional canonical identities may exist there.
 * Everything else (owner, visits, columns) lives in the record.
 */
export function mobileRowLines(c: MobileRowContact): { title: string; titleIsId: boolean; identity: string; identityKind: "phone" | "email" | "none" } {
  // The SAME display name the pipeline board + queue use (shared helper): a real stored name, else
  // the masked phone, else "Sin nombre" — never the junk name "." and never the raw channel id.
  const named = isMeaningfulName(c.name);
  const title = displayContactName({ name: c.name, phoneE164: c.phone_e164, channelUserId: c.channel_user_id });
  if (c.phone_e164) return { title, titleIsId: !named, identity: c.phone_e164, identityKind: "phone" };
  if (c.email) return { title, titleIsId: !named, identity: c.email, identityKind: "email" };
  return { title, titleIsId: !named, identity: "Ver datos en la ficha", identityKind: "none" };
}
