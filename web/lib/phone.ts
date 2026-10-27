/**
 * PERSONAL PHONE — real validation and normalization (libphonenumber, full "max" metadata:
 * number plan patterns per country, not just a digit count). Pure; used by the server
 * actions (the authority) and by the account page to build the country list server-side,
 * so the browser never downloads the metadata.
 *
 * The person picks a country and types the NATIONAL number; changing the country keeps what
 * they typed. A number typed with its own "+<code>" wins over the picked country (people
 * paste international numbers). The stored value is E.164 + the ISO country.
 */
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";

export interface CountryOption {
  code: string;
  dial: string;
  name: string;
  /** An example national number, for the placeholder. */
  example: string;
}

/** Shown first (where the platform's businesses are); then every other country A→Z. */
export const PRIORITY_COUNTRIES = ["CO", "MX", "PE", "CL", "AR", "EC", "ES", "US"] as const;

const EXAMPLES: Record<string, string> = {
  CO: "300 123 4567",
  MX: "55 1234 5678",
  PE: "912 345 678",
  CL: "9 1234 5678",
  AR: "11 2345 6789",
  EC: "99 123 4567",
  ES: "612 34 56 78",
  US: "201 555 0123",
};

export function countryOptions(locale = "es"): { priority: CountryOption[]; rest: CountryOption[] } {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const opt = (code: CountryCode): CountryOption => ({
    code,
    dial: `+${getCountryCallingCode(code)}`,
    name: names.of(code) ?? code,
    example: EXAMPLES[code] ?? "",
  });
  const all = getCountries();
  const priority = PRIORITY_COUNTRIES.filter((c) => all.includes(c)).map(opt);
  const rest = all
    .filter((c) => !(PRIORITY_COUNTRIES as readonly string[]).includes(c))
    .map(opt)
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  return { priority, rest };
}

export function isKnownCountry(code: unknown): code is CountryCode {
  return typeof code === "string" && (getCountries() as string[]).includes(code);
}

export type PhoneResult =
  | { ok: true; phone: { e164: string; country: string } | null }
  | { ok: false; error: string };

/**
 * Validate what the person typed. Empty → clears the phone (it is optional). The error copy
 * names the country so a wrong prefix is easy to spot.
 */
export function normalizePhone(input: { country: unknown; national: unknown }): PhoneResult {
  const raw = typeof input.national === "string" ? input.national.trim() : "";
  if (!raw) return { ok: true, phone: null };
  if (raw.length > 40 || /[^\d\s()+.\-\/]/.test(raw)) {
    return { ok: false, error: "Escribe solo el número: dígitos, espacios o guiones." };
  }
  const country = isKnownCountry(input.country) ? input.country : null;
  const parsed = raw.startsWith("+") ? parsePhoneNumberFromString(raw) : country ? parsePhoneNumberFromString(raw, country) : undefined;
  if (!country && !raw.startsWith("+")) return { ok: false, error: "Elige el país del número." };
  if (!parsed || !parsed.isValid()) {
    const where = country ? new Intl.DisplayNames(["es"], { type: "region" }).of(country) : null;
    return {
      ok: false,
      error: where
        ? `Revisa el número: no es un teléfono válido de ${where}. Escríbelo sin el prefijo +${getCountryCallingCode(country!)}.`
        : "Revisa el número: no es un teléfono válido.",
    };
  }
  return { ok: true, phone: { e164: parsed.number, country: parsed.country ?? country ?? "" } };
}

/** The stored number back as what the person would type in the national field. */
export function nationalOf(e164: string | null | undefined): string {
  if (!e164) return "";
  return parsePhoneNumberFromString(e164)?.formatNational() ?? "";
}

/** "+57 300 123 4567" for display. */
export function formatInternational(e164: string | null | undefined): string {
  if (!e164) return "";
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
