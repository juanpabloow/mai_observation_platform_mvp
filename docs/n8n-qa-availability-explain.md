# n8n QA: explainable availability checks

Workflow: draft `[QA] Gallery - Visto y escribiendo` (`OQH2wDN8QNyM8OKQ`). These checks are for Codex.

**Not verified from here:** there was no authenticated n8n session in this browser, so nobody has confirmed from this side what the draft has configured. The backend was tested on its own. **n8n was not tested.**

## 0. Before running anything
- **Endpoints:** the draft must point to an isolated backend (local or staging with branch `feature/availability-explain` and migration 1803), never to production APIs, memory or sends.
- **Not published:** it stays unpublished and adds no active WhatsApp listener.
- **Credentials:** it uses its own `X-Workflow-Ref` and the token of that test environment. Do NOT impersonate the published workflow's ID to get QA working.
- **Production:** until this backend is deployed, production ignores `explain=true` and has no `/staff/status`.

## 1. Configuration to confirm in the draft
| Element | Expected |
| --- | --- |
| Both availability tools | Query param `explain=true`, fixed (not decided by the model). |
| `ver_estado_artista` | `GET …/api/scheduling/v1/staff/status?site_id=<Gallery-93>&staff=<name>&date=<YYYY-MM-DD>&days=1`, with no service. |
| Prompt | Separates shift (`staff/status`), bookable availability (`/availability`) and physical presence (neither endpoint confirms it). |
| Prompt | Forbids inventing reasons or return dates. Only states a reason when `public_reason` comes back. |
| Prompt | On error, timeout or missing `explanation`: says it couldn't check the schedule. Never "vacations". |
| Prompt | The alternatives in the 409 (`slots_checked: false`) are names only; it queries slots before offering hours. |
| Prompt | Keeps the current rules on consent, using slots and not duplicating bookings. Doesn't switch artist or book without confirmation. |

## 2. Cases and expected responses (synthetic fixtures)
Every date is a **fixture**. None is a real vacation of Falla's.

| # | Isolated environment setup | Message | Expected bot response |
| --- | --- | --- | --- |
| 1 | Falla with a normal shift that day | "¿Falla está hoy?" | Says Falla works today, from `ver_estado_artista` → `working`. Doesn't promise availability; if the customer wants a time, checks availability. |
| 2 | Falla with no shift that weekday | "¿Falla está mañana?" | "Falla no trabaja ese día." Offers another day or Federico. No vacation mention. |
| 3 | FIXTURE: full-day block for Falla, `public_reason = vacation` | "Quiero cita con Falla el <fixture date>" | "Falla está de vacaciones en esa fecha." Then asks "¿otro día con él o revisar con Federico?". Concrete hours only from `next_available` / `alternatives[].first_slot`. |
| 4 | FIXTURE: 2-hour block for Falla in the afternoon | "¿Falla está el <date>?" | Says he works only part of the day (`partly_working`). Doesn't say he's absent all day. |
| 5 | FIXTURE: site closure with `site_closed` | Any booking that day | "La sede está cerrada en esa fecha." No alternatives that day. |
| 6 | FIXTURE: block with a private note ("Cita médica…") and NO public reason | Booking with Falla that day | "Falla no tiene disponibilidad para ese horario." Never "vacaciones" and never the note. |
| 7 | Falla working but with the whole day booked | Booking with Falla | "Falla ya tiene ocupado ese horario." Offers alternatives. `ver_estado_artista` would say `working` (it doesn't read appointments). |
| 8 | A service Falla doesn't do | "Quiero <service> con Falla" | Explains he doesn't do that service. If it offers someone else, it checks their slots first (`slots_checked: false`). |
| 9 | Unknown artist ("Pedro") | "Quiero con Pedro" | Says there's no artist by that name and lists the valid ones (400 `staff_not_found`). Never "está de vacaciones". |
| 10 | Backend returns 401/403/500 or doesn't answer (timeout) | Any | "No pude consultar la agenda en este momento", plus retry or handoff to a person. Never invents a reason. |
| 11 | The customer accepts Federico | "Sí, con Federico" | Checks Federico's availability, offers real hours and asks for confirmation before booking. |

## 3. Contract reference
See `docs/scheduling-availability-explain.md`: fields, codes, messages and real examples.
