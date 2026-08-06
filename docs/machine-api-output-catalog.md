# Machine API — output catalog & redundancy analysis

**Report only — no code changed.** Goal: a real, field-by-field picture of what every machine
endpoint returns today, so we can decide what a conversational AI agent actually needs and
what is context burned. The consumer we optimize for is an **LLM tool-calling loop**, where
every redundant field is tokens spent and a chance to misread.

**Method.** A realistic local tenant (one client "Barbería", one site `America/Bogota`,
5 services with 2 featured + a duplicate name, 2 staff with different hours/qualifications,
one contact "Camila Torres" with 2 identities + 2 notes + 2 tags + a custom field, and
appointments in every state incl. a mid-day one so availability has a gap) was seeded, then
**every** machine endpoint + the interesting error paths were executed with `curl` and a real
token. The exact request + full raw JSON for all 43 calls is in **Appendix A** (verbatim).
Token estimates use **~4 bytes/token** (a conservative BPE approximation for JSON + es/en
text); they are for comparison, not billing.

---

## 1. Saturation — measured (not adjectives)

| Response | Rows | Bytes | ~Tokens | vs full |
|---|---|--:|--:|--:|
| **availability — FULL** (1 day, 1 staff, Corte) | 12 slots | **8 139** | **~2 035** | — |
| availability — `compact=true` | 12 slots | 2 247 | ~562 | **−72 %** |
| availability — `free_blocks` only (site + has_availability + blocks) | 3 blocks | 1 019 | ~255 | **−87 %** |
| availability — multi-day (3 days), compact | 24 slots | 6 494 | ~1 624 | — |
| **appointments list — default** | 5 appts | **4 621** | **~1 155** | — |
| appointments list — `active=true` | 3 appts | 1 861 | ~465 | −60 % (fewer rows) |
| appointments list — *proposed* compact (see §5) | 5 appts | ~1 273 | ~318 | **−74 %** |
| **CRM contact summary** (GET/lookup) | 1 | **1 266** | **~316** | — |
| CRM contact — *proposed* compact (see §5) | 1 | ~795 | ~199 | −40 % |
| services (5, featured-first) | 5 | 909 | ~227 | — |
| services `?featured=true` | 2 | 377 | ~94 | — |
| staff | 2 | 228 | ~57 | — |

**Headline:** the two responses an agent hits every turn — availability and the appointments
list — are the fattest, and both are ~72–87 % compressible with no information loss for a
conversational caller. A full one-day availability response alone is ~2 000 tokens; a busy
week of "check availability" turns burns real context.

---

## 2. Availability slot — field-by-field

Full slot = **13 fields** (example: the 9:00 slot). `compact=true` already returns only 5.

| field | example | who needs it | verdict |
|---|---|---|---|
| `start_at` | `2026-08-05T14:00:00.000Z` | programmatic (canonical; pass back to book) | **KEEP** |
| `service_end_at` | `2026-08-05T14:45:00.000Z` | programmatic | **KEEP** |
| `start_local` | `2026-08-05T09:00:00-05:00` | display | COMPACT-ONLY drop (redundant with `start_at`+`start_label`) |
| `end_local` | `2026-08-05T09:45:00-05:00` | display | COMPACT-ONLY drop |
| `start_label` | `9:00 a. m.` | **agent** (say aloud) | **KEEP** |
| `end_label` | `9:45 a. m.` | agent | **KEEP** |
| `date_label` | `miércoles, 5 de agosto` | agent | **REDUNDANT** — identical on all 12 slots of the day |
| `day` | `2026-08-05` | agent/programmatic (group) | **KEEP** |
| `staff_id` | `0b7b…` (UUID) | programmatic | REMOVAL CANDIDATE (agent books by name/slot) |
| `staff_name` | `Ana` | **agent** | **KEEP** |
| `available_staff_ids` | `["0b7b…"]` | programmatic | **REDUNDANT** with `available_staff` |
| `available_staff` | `[{id,name}]` | agent (choose staff) | KEEP (but for a single-staff query it is one entry = the filter) |
| `candidates` | `[{staff_id, service_end_at}]` | programmatic (per-staff end) | **REMOVAL CANDIDATE** — duplicates `staff_id`+`service_end_at`; only meaningful when staff have different durations |
| `time` *(compact only)* | `09:00` | **agent** (pass back to book) | **KEEP** |

**A conversational agent needs 3 of the 13:** `start_label` (to say), `time` (to book), and
`staff_name`/`available_staff` (whom). That is exactly `compact=true` — and `free_blocks`
makes even the compact slot array optional for the "what's free?" question.

---

## 3. Appointment object — field-by-field

Returned by create / confirm / complete / cancel / no-show / reschedule (**23 fields**) and,
with a `contact` object added, by the appointments **list** (26 fields).

| field | example | who needs it | verdict |
|---|---|---|---|
| `id` | `ecda…` | agent (act on it) / programmatic | **KEEP** |
| `public_reference` | `1422…` (UUID) | customer-facing / programmatic | **REDUNDANT** for the agent (two ids for one row) |
| `site_id` / `staff_id` / `service_id` | UUIDs | programmatic | REMOVAL CANDIDATE (agent) |
| `contact_id` | `6595…`/null | programmatic | **REDUNDANT** with `contact.id` |
| `contact` `{id,name,primary_identity}` | `{…,"Camila Torres",…}` | agent | **KEEP** (list only) |
| `source_conversation_id` | null | platform | REMOVAL CANDIDATE (agent) |
| `start_at` / `service_end_at` | UTC | programmatic | **KEEP** (canonical) |
| `start_local` / `end_local` | offset-ISO | display | COMPACT-ONLY |
| `start_label` / `end_label` / `date_label` / `day` | labels | **agent** | **KEEP** |
| `status` | `scheduled` | **agent** | **KEEP** |
| `origin` | `n8n` | platform | REMOVAL CANDIDATE (agent) |
| `service_name` | `Corte de Cabello` | **agent** | **KEEP** |
| `duration_min` | `45` | agent-ish | REDUNDANT (= `service_end_at`−`start_at`) |
| `price` | `"35000.00"` | agent (quote) | KEEP — but a raw string an LLM may reformat wrong (see §6) |
| `version` | `1` | programmatic (optimistic lock) | REMOVAL CANDIDATE (agent) |
| `created_at` / `updated_at` | UTC | platform | REMOVAL CANDIDATE (agent) |
| **`staff_name`** | *(absent!)* | **agent** | **MISSING** — the object has `staff_id` + `service_name` but not `staff_name`; an agent can't say "with Ana" without a second lookup (see §6) |

**A conversational agent needs ~7 of 23–26:** `id`, `service_name`, `staff_name` (missing),
`start_label`, `date_label`, `status`, and `contact.name`. The rest is UUIDs, audit, and
duplicate time encodings.

---

## 4. CRM contact summary — field-by-field

**14 top-level fields; 1 266 B.** Leaner than availability, but not tuned for an agent.

| field | example | who | verdict |
|---|---|---|---|
| `id` | `6595…` | agent/programmatic | KEEP |
| `name` | `Camila Torres` | agent | KEEP |
| `stage` | `customer` | agent-ish | KEEP |
| `owner_user_id` | null (UUID) | platform UI | REMOVAL CANDIDATE (agent) |
| `is_customer`/`visits`/`no_shows` | true/1/1 | agent | KEEP |
| `consent` | `unknown` | agent (may I message?) | KEEP |
| `custom_fields` | `{barbero_preferido:"Ana"}` | agent | KEEP |
| `identities` `[{kind,value,label}]` | phone+email | agent | KEEP (`label`="whatsapp" is a source hint — minor) |
| `tags` | `["Frecuente","VIP"]` | agent | KEEP |
| `next_appointment.{start_at,start_local,start_label,date_label,day}` | 5 encodings of one instant | agent | KEEP labels; `start_at`+`start_local` are the redundant pair |
| `next_appointment.public_reference` | UUID | — | REDUNDANT with `next_appointment.id` |
| `recent_notes[].{created_at,created_at_local,created_at_label}` | 3 encodings | agent reads label only | `created_at`+`created_at_local` REDUNDANT for the agent |

---

## 5. Redundancy clusters (the three biggest)

1. **Time is encoded 3–4× per instant, everywhere.** A slot's start = `start_at` (UTC) +
   `start_local` (offset-ISO) + `start_label` (spoken) + `time` (24h). An appointment's start
   adds `date_label` + `day` on top. This is deliberate (UTC = canonical, labels = C-6 no-
   convert), but for an agent 2 of the 4 are dead weight; `compact` already collapses to
   `start_label`+`time`.
2. **`candidates[]` + `available_staff_ids` duplicate `available_staff`** in every slot.
   For the common single-staff query, `candidates` = `[{staff_id, service_end_at}]` restates
   fields already on the slot. Across 12 slots that is ~1.6 KB of pure restatement.
3. **`date_label` (and `day`) repeat identically on every slot of the same day**, and the
   appointment list repeats the entire 23-field object per row. The list is **~924 B/appt**;
   a 20-appointment history would be ~18 KB / ~4 600 tokens for what an agent reads as one
   line per appointment. `free_blocks` already carries `date_label` once per block — the
   right pattern.

---

## 6. What the agent is still MISSING

- **`staff_name` on appointment objects.** Create/transition/list expose `staff_id` +
  `service_name` but not `staff_name`. To confirm "tu cita con **Ana**" the agent must map a
  UUID — the exact failure this whole track exists to remove. (Availability slots already got
  `staff_name`; appointments didn't.) *Cheap, additive.*
- **A formatted `price_label`.** `price` is `"35000.00"` — an LLM asked to quote it may say
  "$35.00" or "35 mil pesos" inconsistently. A `price_label` (e.g. `"$35.000"`) in the
  client locale would remove that guess. *Additive.*
- Nothing missing for availability itself — `free_blocks` + `has_availability` cover the
  conversational needs well.

---

## 7. Recommendations

### 7.1 Per agent-facing tool — the exact n8n request

| Tool (intent) | Request | Read from response |
|---|---|---|
| **ver_servicios** | `GET /services?site_id=…&featured=true` | `name`, `duration_min`, `price` — lead with these (featured-first) |
| **ver_barberos** | `GET /staff?site_id=…&service=<name>` | `name` |
| **ver_disponibilidad** | `GET /availability?site_id=…&service=<name>[&staff=<name>]&from&to&compact=true` | **`free_blocks`** (say the ranges) → pick a slot's `time` to book |
| **agendar_cita** | `POST /appointments` `{site_id, service:<name>, staff?:<name>, day, time, customer_phone, customer_name}` + `Idempotency-Key` | `service_name`, `start_label`, `status` |
| **ver_mis_citas** | `GET /appointments?phone=<e164>&active=true` | `service_name`, `start_label`/`date_label`, `status` (+ `staff_name` once added) |
| **cancelar / reprogramar** | `POST /appointments/by-time/cancel` (or `/reschedule`) `{phone, current_day, current_time[, day, time]}` | `status`, `start_label` — **no UUID transcription** |
| **buscar_cliente** | `GET /crm/v1/contacts/lookup?phone=<e164>` | `name`, `tags`, `custom_fields`, `next_appointment.*_label` |

Guidance for every scheduling read: **always send `compact=true`** and prefer `free_blocks`;
resolve service/staff/appointment by **name / phone+day+time**, never by UUID.

### 7.2 Trims worth doing

**SAFE (additive — no v2 needed):**
1. **Extend `compact=true` to the appointments list** — measured **4 621 B → ~1 273 B (−74 %)**
   for 5 rows; the single biggest per-turn win. Same compact contract as availability.
2. **Add `staff_name` to appointment objects** — fills the §6 gap; additive.
3. **Add a `?compact=true` (or a lean `contacts/lookup` shape) to the CRM contact summary** —
   measured **1 266 B → ~795 B (−40 %)**: drop `owner_user_id`, `public_reference`, and the
   `created_at`/`created_at_local` pair (keep `created_at_label`).
4. **Add `price_label`** to services + appointments (formatted money).
5. **Document `free_blocks` as the primary availability surface** for conversational callers
   (compact slots become a fallback for exact booking).

**BREAKING (v2 rules only — flagged, NOT recommended lightly):**
6. Remove `candidates[]` and `available_staff_ids` from slots (duplicate `available_staff`).
7. Drop one of `id` / `public_reference` from appointment objects (two ids for one row).
8. Drop `duration_min`, `version`, `origin`, `source_conversation_id`, `created_at/updated_at`
   from the *default* appointment shape. These have real programmatic/UI consumers, so they
   must stay unless moved behind a mode — hence v2, not a trim.

**Net:** the safe additive set (compact appointments list + compact contact + `staff_name` +
`price_label`) captures essentially all the token savings with zero breakage. The breaking
removals are marginal on top and not worth a v2 on their own.

---

## Appendix A — executed calls (verbatim request + full raw JSON)

Seeded values (tenant `cccccccc-…`): site `América/Bogota`; services Barba/Corte (featured),
Cejas ×2 (duplicate → ambiguous), Tinte; staff Ana (all) / Beto (Corte+Barba, 10:00–16:00);
contact "Camila Torres" `+573001112233`; an inactive Sede Norte. Tokens/bytes are the wire
(minified) response; JSON below is pretty-printed for reading.

#### services (default, featured-first)  · `200` · 909 B

```
GET /api/scheduling/v1/services?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "services": [
    {
      "id": "fe2087ca-41d5-419c-97c9-e088d0cf2936",
      "name": "Barba",
      "description": null,
      "duration_min": 30,
      "price": "20000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": true
    },
    {
      "id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "name": "Corte de Cabello",
      "description": null,
      "duration_min": 45,
      "price": "35000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": true
    },
    {
      "id": "82192966-f292-45cc-8901-2132c68646c3",
      "name": "Cejas",
      "description": null,
      "duration_min": 15,
      "price": "15000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": false
    },
    {
      "id": "9f8ea61f-3d74-4f4b-8aee-b20772530cfd",
      "name": "Cejas",
      "description": null,
      "duration_min": 15,
      "price": "15000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": false
    },
    {
      "id": "7818d0aa-9087-4f3f-8a25-c77abeeeda8c",
      "name": "Tinte",
      "description": null,
      "duration_min": 90,
      "price": "120000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": false
    }
  ]
}
```

#### services ?featured=true  · `200` · 377 B

```
GET /api/scheduling/v1/services?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&featured=true
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "services": [
    {
      "id": "fe2087ca-41d5-419c-97c9-e088d0cf2936",
      "name": "Barba",
      "description": null,
      "duration_min": 30,
      "price": "20000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": true
    },
    {
      "id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "name": "Corte de Cabello",
      "description": null,
      "duration_min": 45,
      "price": "35000.00",
      "buffer_before_min": 0,
      "buffer_after_min": 0,
      "featured": true
    }
  ]
}
```

#### staff (all)  · `200` · 228 B

```
GET /api/scheduling/v1/staff?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "staff": [
    {
      "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "name": "Ana",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2"
    },
    {
      "id": "2cdac9de-fad0-44ea-8f63-3c5c47a1ee2c",
      "name": "Beto",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2"
    }
  ]
}
```

#### staff ?service=Corte de Cabello  · `200` · 228 B

```
GET /api/scheduling/v1/staff?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "staff": [
    {
      "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "name": "Ana",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2"
    },
    {
      "id": "2cdac9de-fad0-44ea-8f63-3c5c47a1ee2c",
      "name": "Beto",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2"
    }
  ]
}
```

#### availability FULL (Ana, Corte, 1 day)  · `200` · 8139 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello&staff=Ana&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "site": {
    "id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "timezone": "America/Bogota",
    "timezone_used": "America/Bogota"
  },
  "has_availability": {
    "2026-08-04": false,
    "2026-08-05": true
  },
  "free_blocks": [
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "9:00 a. m.",
      "to_label": "10:45 a. m.",
      "first_start_at": "2026-08-05T14:00:00.000Z",
      "first_start_local": "2026-08-05T09:00:00-05:00",
      "first_time": "09:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "12:00 p. m.",
      "to_label": "1:45 p. m.",
      "first_start_at": "2026-08-05T17:00:00.000Z",
      "first_start_local": "2026-08-05T12:00:00-05:00",
      "first_time": "12:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "2:30 p. m.",
      "to_label": "5:45 p. m.",
      "first_start_at": "2026-08-05T19:30:00.000Z",
      "first_start_local": "2026-08-05T14:30:00-05:00",
      "first_time": "14:30"
    }
  ],
  "slots": [
    {
      "start_at": "2026-08-05T14:00:00.000Z",
      "service_end_at": "2026-08-05T14:45:00.000Z",
      "start_local": "2026-08-05T09:00:00-05:00",
      "end_local": "2026-08-05T09:45:00-05:00",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T14:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T14:30:00.000Z",
      "service_end_at": "2026-08-05T15:15:00.000Z",
      "start_local": "2026-08-05T09:30:00-05:00",
      "end_local": "2026-08-05T10:15:00-05:00",
      "start_label": "9:30 a. m.",
      "end_label": "10:15 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T15:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T15:00:00.000Z",
      "service_end_at": "2026-08-05T15:45:00.000Z",
      "start_local": "2026-08-05T10:00:00-05:00",
      "end_local": "2026-08-05T10:45:00-05:00",
      "start_label": "10:00 a. m.",
      "end_label": "10:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T15:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T17:00:00.000Z",
      "service_end_at": "2026-08-05T17:45:00.000Z",
      "start_local": "2026-08-05T12:00:00-05:00",
      "end_local": "2026-08-05T12:45:00-05:00",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T17:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T17:30:00.000Z",
      "service_end_at": "2026-08-05T18:15:00.000Z",
      "start_local": "2026-08-05T12:30:00-05:00",
      "end_local": "2026-08-05T13:15:00-05:00",
      "start_label": "12:30 p. m.",
      "end_label": "1:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T18:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T18:00:00.000Z",
      "service_end_at": "2026-08-05T18:45:00.000Z",
      "start_local": "2026-08-05T13:00:00-05:00",
      "end_local": "2026-08-05T13:45:00-05:00",
      "start_label": "1:00 p. m.",
      "end_label": "1:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T18:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T19:30:00.000Z",
      "service_end_at": "2026-08-05T20:15:00.000Z",
      "start_local": "2026-08-05T14:30:00-05:00",
      "end_local": "2026-08-05T15:15:00-05:00",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T20:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T20:00:00.000Z",
      "service_end_at": "2026-08-05T20:45:00.000Z",
      "start_local": "2026-08-05T15:00:00-05:00",
      "end_local": "2026-08-05T15:45:00-05:00",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T20:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T20:30:00.000Z",
      "service_end_at": "2026-08-05T21:15:00.000Z",
      "start_local": "2026-08-05T15:30:00-05:00",
      "end_local": "2026-08-05T16:15:00-05:00",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T21:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T21:00:00.000Z",
      "service_end_at": "2026-08-05T21:45:00.000Z",
      "start_local": "2026-08-05T16:00:00-05:00",
      "end_local": "2026-08-05T16:45:00-05:00",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T21:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T21:30:00.000Z",
      "service_end_at": "2026-08-05T22:15:00.000Z",
      "start_local": "2026-08-05T16:30:00-05:00",
      "end_local": "2026-08-05T17:15:00-05:00",
      "start_label": "4:30 p. m.",
      "end_label": "5:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T22:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T22:00:00.000Z",
      "service_end_at": "2026-08-05T22:45:00.000Z",
      "start_local": "2026-08-05T17:00:00-05:00",
      "end_local": "2026-08-05T17:45:00-05:00",
      "start_label": "5:00 p. m.",
      "end_label": "5:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T22:45:00.000Z"
        }
      ]
    }
  ]
}
```

#### availability compact=true  · `200` · 2247 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello&staff=Ana&compact=true&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "site": {
    "id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "timezone": "America/Bogota",
    "timezone_used": "America/Bogota"
  },
  "has_availability": {
    "2026-08-04": false,
    "2026-08-05": true
  },
  "free_blocks": [
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "9:00 a. m.",
      "to_label": "10:45 a. m.",
      "first_start_at": "2026-08-05T14:00:00.000Z",
      "first_start_local": "2026-08-05T09:00:00-05:00",
      "first_time": "09:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "12:00 p. m.",
      "to_label": "1:45 p. m.",
      "first_start_at": "2026-08-05T17:00:00.000Z",
      "first_start_local": "2026-08-05T12:00:00-05:00",
      "first_time": "12:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "2:30 p. m.",
      "to_label": "5:45 p. m.",
      "first_start_at": "2026-08-05T19:30:00.000Z",
      "first_start_local": "2026-08-05T14:30:00-05:00",
      "first_time": "14:30"
    }
  ],
  "slots": [
    {
      "day": "2026-08-05",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "time": "09:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "9:30 a. m.",
      "end_label": "10:15 a. m.",
      "time": "09:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "10:00 a. m.",
      "end_label": "10:45 a. m.",
      "time": "10:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "time": "12:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "12:30 p. m.",
      "end_label": "1:15 p. m.",
      "time": "12:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "1:00 p. m.",
      "end_label": "1:45 p. m.",
      "time": "13:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "time": "14:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "time": "15:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "time": "15:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "time": "16:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "4:30 p. m.",
      "end_label": "5:15 p. m.",
      "time": "16:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "5:00 p. m.",
      "end_label": "5:45 p. m.",
      "time": "17:00",
      "staff_name": "Ana"
    }
  ]
}
```

#### availability staff by NAME (Ana), all staff omitted vs named — here named  · `200` · 8139 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello&staff=Ana&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "site": {
    "id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "timezone": "America/Bogota",
    "timezone_used": "America/Bogota"
  },
  "has_availability": {
    "2026-08-04": false,
    "2026-08-05": true
  },
  "free_blocks": [
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "9:00 a. m.",
      "to_label": "10:45 a. m.",
      "first_start_at": "2026-08-05T14:00:00.000Z",
      "first_start_local": "2026-08-05T09:00:00-05:00",
      "first_time": "09:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "12:00 p. m.",
      "to_label": "1:45 p. m.",
      "first_start_at": "2026-08-05T17:00:00.000Z",
      "first_start_local": "2026-08-05T12:00:00-05:00",
      "first_time": "12:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "2:30 p. m.",
      "to_label": "5:45 p. m.",
      "first_start_at": "2026-08-05T19:30:00.000Z",
      "first_start_local": "2026-08-05T14:30:00-05:00",
      "first_time": "14:30"
    }
  ],
  "slots": [
    {
      "start_at": "2026-08-05T14:00:00.000Z",
      "service_end_at": "2026-08-05T14:45:00.000Z",
      "start_local": "2026-08-05T09:00:00-05:00",
      "end_local": "2026-08-05T09:45:00-05:00",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T14:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T14:30:00.000Z",
      "service_end_at": "2026-08-05T15:15:00.000Z",
      "start_local": "2026-08-05T09:30:00-05:00",
      "end_local": "2026-08-05T10:15:00-05:00",
      "start_label": "9:30 a. m.",
      "end_label": "10:15 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T15:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T15:00:00.000Z",
      "service_end_at": "2026-08-05T15:45:00.000Z",
      "start_local": "2026-08-05T10:00:00-05:00",
      "end_local": "2026-08-05T10:45:00-05:00",
      "start_label": "10:00 a. m.",
      "end_label": "10:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T15:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T17:00:00.000Z",
      "service_end_at": "2026-08-05T17:45:00.000Z",
      "start_local": "2026-08-05T12:00:00-05:00",
      "end_local": "2026-08-05T12:45:00-05:00",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T17:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T17:30:00.000Z",
      "service_end_at": "2026-08-05T18:15:00.000Z",
      "start_local": "2026-08-05T12:30:00-05:00",
      "end_local": "2026-08-05T13:15:00-05:00",
      "start_label": "12:30 p. m.",
      "end_label": "1:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T18:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T18:00:00.000Z",
      "service_end_at": "2026-08-05T18:45:00.000Z",
      "start_local": "2026-08-05T13:00:00-05:00",
      "end_local": "2026-08-05T13:45:00-05:00",
      "start_label": "1:00 p. m.",
      "end_label": "1:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T18:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T19:30:00.000Z",
      "service_end_at": "2026-08-05T20:15:00.000Z",
      "start_local": "2026-08-05T14:30:00-05:00",
      "end_local": "2026-08-05T15:15:00-05:00",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T20:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T20:00:00.000Z",
      "service_end_at": "2026-08-05T20:45:00.000Z",
      "start_local": "2026-08-05T15:00:00-05:00",
      "end_local": "2026-08-05T15:45:00-05:00",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T20:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T20:30:00.000Z",
      "service_end_at": "2026-08-05T21:15:00.000Z",
      "start_local": "2026-08-05T15:30:00-05:00",
      "end_local": "2026-08-05T16:15:00-05:00",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T21:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T21:00:00.000Z",
      "service_end_at": "2026-08-05T21:45:00.000Z",
      "start_local": "2026-08-05T16:00:00-05:00",
      "end_local": "2026-08-05T16:45:00-05:00",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T21:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T21:30:00.000Z",
      "service_end_at": "2026-08-05T22:15:00.000Z",
      "start_local": "2026-08-05T16:30:00-05:00",
      "end_local": "2026-08-05T17:15:00-05:00",
      "start_label": "4:30 p. m.",
      "end_label": "5:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T22:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T22:00:00.000Z",
      "service_end_at": "2026-08-05T22:45:00.000Z",
      "start_local": "2026-08-05T17:00:00-05:00",
      "end_local": "2026-08-05T17:45:00-05:00",
      "start_label": "5:00 p. m.",
      "end_label": "5:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T22:45:00.000Z"
        }
      ]
    }
  ]
}
```
> same as FULL; shows staff filter

#### availability tz=America/Mexico_City  · `200` · 8144 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello&staff=Ana&tz=America%2FMexico_City&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "site": {
    "id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "timezone": "America/Bogota",
    "timezone_used": "America/Mexico_City"
  },
  "has_availability": {
    "2026-08-04": false,
    "2026-08-05": true
  },
  "free_blocks": [
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "8:00 a. m.",
      "to_label": "9:45 a. m.",
      "first_start_at": "2026-08-05T14:00:00.000Z",
      "first_start_local": "2026-08-05T08:00:00-06:00",
      "first_time": "08:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "11:00 a. m.",
      "to_label": "12:45 p. m.",
      "first_start_at": "2026-08-05T17:00:00.000Z",
      "first_start_local": "2026-08-05T11:00:00-06:00",
      "first_time": "11:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "1:30 p. m.",
      "to_label": "4:45 p. m.",
      "first_start_at": "2026-08-05T19:30:00.000Z",
      "first_start_local": "2026-08-05T13:30:00-06:00",
      "first_time": "13:30"
    }
  ],
  "slots": [
    {
      "start_at": "2026-08-05T14:00:00.000Z",
      "service_end_at": "2026-08-05T14:45:00.000Z",
      "start_local": "2026-08-05T08:00:00-06:00",
      "end_local": "2026-08-05T08:45:00-06:00",
      "start_label": "8:00 a. m.",
      "end_label": "8:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T14:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T14:30:00.000Z",
      "service_end_at": "2026-08-05T15:15:00.000Z",
      "start_local": "2026-08-05T08:30:00-06:00",
      "end_local": "2026-08-05T09:15:00-06:00",
      "start_label": "8:30 a. m.",
      "end_label": "9:15 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T15:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T15:00:00.000Z",
      "service_end_at": "2026-08-05T15:45:00.000Z",
      "start_local": "2026-08-05T09:00:00-06:00",
      "end_local": "2026-08-05T09:45:00-06:00",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T15:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T17:00:00.000Z",
      "service_end_at": "2026-08-05T17:45:00.000Z",
      "start_local": "2026-08-05T11:00:00-06:00",
      "end_local": "2026-08-05T11:45:00-06:00",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T17:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T17:30:00.000Z",
      "service_end_at": "2026-08-05T18:15:00.000Z",
      "start_local": "2026-08-05T11:30:00-06:00",
      "end_local": "2026-08-05T12:15:00-06:00",
      "start_label": "11:30 a. m.",
      "end_label": "12:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T18:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T18:00:00.000Z",
      "service_end_at": "2026-08-05T18:45:00.000Z",
      "start_local": "2026-08-05T12:00:00-06:00",
      "end_local": "2026-08-05T12:45:00-06:00",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T18:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T19:30:00.000Z",
      "service_end_at": "2026-08-05T20:15:00.000Z",
      "start_local": "2026-08-05T13:30:00-06:00",
      "end_local": "2026-08-05T14:15:00-06:00",
      "start_label": "1:30 p. m.",
      "end_label": "2:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T20:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T20:00:00.000Z",
      "service_end_at": "2026-08-05T20:45:00.000Z",
      "start_local": "2026-08-05T14:00:00-06:00",
      "end_local": "2026-08-05T14:45:00-06:00",
      "start_label": "2:00 p. m.",
      "end_label": "2:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T20:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T20:30:00.000Z",
      "service_end_at": "2026-08-05T21:15:00.000Z",
      "start_local": "2026-08-05T14:30:00-06:00",
      "end_local": "2026-08-05T15:15:00-06:00",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T21:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T21:00:00.000Z",
      "service_end_at": "2026-08-05T21:45:00.000Z",
      "start_local": "2026-08-05T15:00:00-06:00",
      "end_local": "2026-08-05T15:45:00-06:00",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T21:45:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T21:30:00.000Z",
      "service_end_at": "2026-08-05T22:15:00.000Z",
      "start_local": "2026-08-05T15:30:00-06:00",
      "end_local": "2026-08-05T16:15:00-06:00",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T22:15:00.000Z"
        }
      ]
    },
    {
      "start_at": "2026-08-05T22:00:00.000Z",
      "service_end_at": "2026-08-05T22:45:00.000Z",
      "start_local": "2026-08-05T16:00:00-06:00",
      "end_local": "2026-08-05T16:45:00-06:00",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "staff_name": "Ana",
      "available_staff_ids": [
        "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c"
      ],
      "available_staff": [
        {
          "id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "name": "Ana"
        }
      ],
      "candidates": [
        {
          "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
          "service_end_at": "2026-08-05T22:45:00.000Z"
        }
      ]
    }
  ]
}
```

#### availability multi-day (3 days), compact  · `200` · 6494 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello&staff=Ana&compact=true&from=2026-08-05T00%3A00%3A00Z&to=2026-08-07T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "site": {
    "id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "timezone": "America/Bogota",
    "timezone_used": "America/Bogota"
  },
  "has_availability": {
    "2026-08-04": false,
    "2026-08-05": true,
    "2026-08-06": true,
    "2026-08-07": true
  },
  "free_blocks": [
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "9:00 a. m.",
      "to_label": "10:45 a. m.",
      "first_start_at": "2026-08-05T14:00:00.000Z",
      "first_start_local": "2026-08-05T09:00:00-05:00",
      "first_time": "09:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "12:00 p. m.",
      "to_label": "1:45 p. m.",
      "first_start_at": "2026-08-05T17:00:00.000Z",
      "first_start_local": "2026-08-05T12:00:00-05:00",
      "first_time": "12:00"
    },
    {
      "day": "2026-08-05",
      "date_label": "miércoles, 5 de agosto",
      "staff_name": "Ana",
      "from_label": "2:30 p. m.",
      "to_label": "5:45 p. m.",
      "first_start_at": "2026-08-05T19:30:00.000Z",
      "first_start_local": "2026-08-05T14:30:00-05:00",
      "first_time": "14:30"
    },
    {
      "day": "2026-08-06",
      "date_label": "jueves, 6 de agosto",
      "staff_name": "Ana",
      "from_label": "9:00 a. m.",
      "to_label": "5:45 p. m.",
      "first_start_at": "2026-08-06T14:00:00.000Z",
      "first_start_local": "2026-08-06T09:00:00-05:00",
      "first_time": "09:00"
    },
    {
      "day": "2026-08-07",
      "date_label": "viernes, 7 de agosto",
      "staff_name": "Ana",
      "from_label": "9:00 a. m.",
      "to_label": "5:45 p. m.",
      "first_start_at": "2026-08-07T14:00:00.000Z",
      "first_start_local": "2026-08-07T09:00:00-05:00",
      "first_time": "09:00"
    }
  ],
  "slots": [
    {
      "day": "2026-08-05",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "time": "09:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "9:30 a. m.",
      "end_label": "10:15 a. m.",
      "time": "09:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "10:00 a. m.",
      "end_label": "10:45 a. m.",
      "time": "10:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "time": "12:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "12:30 p. m.",
      "end_label": "1:15 p. m.",
      "time": "12:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "1:00 p. m.",
      "end_label": "1:45 p. m.",
      "time": "13:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "time": "14:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "time": "15:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "time": "15:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "time": "16:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "4:30 p. m.",
      "end_label": "5:15 p. m.",
      "time": "16:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-05",
      "start_label": "5:00 p. m.",
      "end_label": "5:45 p. m.",
      "time": "17:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "time": "09:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "9:30 a. m.",
      "end_label": "10:15 a. m.",
      "time": "09:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "10:00 a. m.",
      "end_label": "10:45 a. m.",
      "time": "10:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "10:30 a. m.",
      "end_label": "11:15 a. m.",
      "time": "10:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "time": "11:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "11:30 a. m.",
      "end_label": "12:15 p. m.",
      "time": "11:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "time": "12:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "12:30 p. m.",
      "end_label": "1:15 p. m.",
      "time": "12:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "1:00 p. m.",
      "end_label": "1:45 p. m.",
      "time": "13:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "1:30 p. m.",
      "end_label": "2:15 p. m.",
      "time": "13:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "2:00 p. m.",
      "end_label": "2:45 p. m.",
      "time": "14:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "time": "14:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "time": "15:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "time": "15:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "time": "16:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "4:30 p. m.",
      "end_label": "5:15 p. m.",
      "time": "16:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-06",
      "start_label": "5:00 p. m.",
      "end_label": "5:45 p. m.",
      "time": "17:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "time": "09:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "9:30 a. m.",
      "end_label": "10:15 a. m.",
      "time": "09:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "10:00 a. m.",
      "end_label": "10:45 a. m.",
      "time": "10:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "10:30 a. m.",
      "end_label": "11:15 a. m.",
      "time": "10:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "time": "11:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "11:30 a. m.",
      "end_label": "12:15 p. m.",
      "time": "11:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "12:00 p. m.",
      "end_label": "12:45 p. m.",
      "time": "12:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "12:30 p. m.",
      "end_label": "1:15 p. m.",
      "time": "12:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "1:00 p. m.",
      "end_label": "1:45 p. m.",
      "time": "13:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "1:30 p. m.",
      "end_label": "2:15 p. m.",
      "time": "13:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "2:00 p. m.",
      "end_label": "2:45 p. m.",
      "time": "14:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "2:30 p. m.",
      "end_label": "3:15 p. m.",
      "time": "14:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "3:00 p. m.",
      "end_label": "3:45 p. m.",
      "time": "15:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "3:30 p. m.",
      "end_label": "4:15 p. m.",
      "time": "15:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "4:00 p. m.",
      "end_label": "4:45 p. m.",
      "time": "16:00",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "4:30 p. m.",
      "end_label": "5:15 p. m.",
      "time": "16:30",
      "staff_name": "Ana"
    },
    {
      "day": "2026-08-07",
      "start_label": "5:00 p. m.",
      "end_label": "5:45 p. m.",
      "time": "17:00",
      "staff_name": "Ana"
    }
  ]
}
```

#### appointments list (default, all states)  · `200` · 4621 B

```
GET /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointments": [
    {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T16:00:00.000Z",
      "service_end_at": "2026-08-05T16:45:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "end_local": "2026-08-05T11:45:00-05:00",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.301Z",
      "updated_at": "2026-08-04T22:34:19.301Z"
    },
    {
      "id": "08664e1b-dd8c-49fd-b518-8a36a6c55ffd",
      "public_reference": "2ca170bb-dcc3-4bd7-b11a-ddd4b32e3be8",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "fe2087ca-41d5-419c-97c9-e088d0cf2936",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T19:00:00.000Z",
      "service_end_at": "2026-08-05T19:30:00.000Z",
      "start_local": "2026-08-05T14:00:00-05:00",
      "end_local": "2026-08-05T14:30:00-05:00",
      "start_label": "2:00 p. m.",
      "end_label": "2:30 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "confirmed",
      "origin": "n8n",
      "service_name": "Barba",
      "duration_min": 30,
      "price": "20000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.313Z",
      "updated_at": "2026-08-04T22:34:19.313Z"
    },
    {
      "id": "1169f12a-aae1-479a-b27b-983bb0d715d4",
      "public_reference": "0213fc6b-44b5-480b-85c6-7a6c6f56f475",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "7818d0aa-9087-4f3f-8a25-c77abeeeda8c",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T21:00:00.000Z",
      "service_end_at": "2026-08-05T22:30:00.000Z",
      "start_local": "2026-08-05T16:00:00-05:00",
      "end_local": "2026-08-05T17:30:00-05:00",
      "start_label": "4:00 p. m.",
      "end_label": "5:30 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "completed",
      "origin": "n8n",
      "service_name": "Tinte",
      "duration_min": 90,
      "price": "120000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.319Z",
      "updated_at": "2026-08-04T22:34:19.319Z"
    },
    {
      "id": "a76a61f7-dd1a-4cac-817a-1a9bbbfdf0ac",
      "public_reference": "2ea149ea-81c1-4560-9455-96157e95f23f",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-06T14:00:00.000Z",
      "service_end_at": "2026-08-06T14:45:00.000Z",
      "start_local": "2026-08-06T09:00:00-05:00",
      "end_local": "2026-08-06T09:45:00-05:00",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "date_label": "jueves, 6 de agosto",
      "day": "2026-08-06",
      "status": "cancelled",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.326Z",
      "updated_at": "2026-08-04T22:34:19.326Z"
    },
    {
      "id": "f2d7e0ea-ed3e-4a62-8f66-9a438a0081c7",
      "public_reference": "b067b3ad-309c-4335-b710-3cd4e968da8c",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "2cdac9de-fad0-44ea-8f63-3c5c47a1ee2c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-06T16:00:00.000Z",
      "service_end_at": "2026-08-06T16:45:00.000Z",
      "start_local": "2026-08-06T11:00:00-05:00",
      "end_local": "2026-08-06T11:45:00-05:00",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "date_label": "jueves, 6 de agosto",
      "day": "2026-08-06",
      "status": "no_show",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.332Z",
      "updated_at": "2026-08-04T22:34:19.332Z"
    }
  ]
}
```

#### appointments list active=true  · `200` · 1861 B

```
GET /api/scheduling/v1/appointments?active=true
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointments": [
    {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T16:00:00.000Z",
      "service_end_at": "2026-08-05T16:45:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "end_local": "2026-08-05T11:45:00-05:00",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.301Z",
      "updated_at": "2026-08-04T22:34:19.301Z"
    },
    {
      "id": "08664e1b-dd8c-49fd-b518-8a36a6c55ffd",
      "public_reference": "2ca170bb-dcc3-4bd7-b11a-ddd4b32e3be8",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "fe2087ca-41d5-419c-97c9-e088d0cf2936",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T19:00:00.000Z",
      "service_end_at": "2026-08-05T19:30:00.000Z",
      "start_local": "2026-08-05T14:00:00-05:00",
      "end_local": "2026-08-05T14:30:00-05:00",
      "start_label": "2:00 p. m.",
      "end_label": "2:30 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "confirmed",
      "origin": "n8n",
      "service_name": "Barba",
      "duration_min": 30,
      "price": "20000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.313Z",
      "updated_at": "2026-08-04T22:34:19.313Z"
    }
  ]
}
```

#### appointments list ?phone=  · `200` · 4621 B

```
GET /api/scheduling/v1/appointments?phone=%2B573001112233
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointments": [
    {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T16:00:00.000Z",
      "service_end_at": "2026-08-05T16:45:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "end_local": "2026-08-05T11:45:00-05:00",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.301Z",
      "updated_at": "2026-08-04T22:34:19.301Z"
    },
    {
      "id": "08664e1b-dd8c-49fd-b518-8a36a6c55ffd",
      "public_reference": "2ca170bb-dcc3-4bd7-b11a-ddd4b32e3be8",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "fe2087ca-41d5-419c-97c9-e088d0cf2936",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T19:00:00.000Z",
      "service_end_at": "2026-08-05T19:30:00.000Z",
      "start_local": "2026-08-05T14:00:00-05:00",
      "end_local": "2026-08-05T14:30:00-05:00",
      "start_label": "2:00 p. m.",
      "end_label": "2:30 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "confirmed",
      "origin": "n8n",
      "service_name": "Barba",
      "duration_min": 30,
      "price": "20000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.313Z",
      "updated_at": "2026-08-04T22:34:19.313Z"
    },
    {
      "id": "1169f12a-aae1-479a-b27b-983bb0d715d4",
      "public_reference": "0213fc6b-44b5-480b-85c6-7a6c6f56f475",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "7818d0aa-9087-4f3f-8a25-c77abeeeda8c",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T21:00:00.000Z",
      "service_end_at": "2026-08-05T22:30:00.000Z",
      "start_local": "2026-08-05T16:00:00-05:00",
      "end_local": "2026-08-05T17:30:00-05:00",
      "start_label": "4:00 p. m.",
      "end_label": "5:30 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "completed",
      "origin": "n8n",
      "service_name": "Tinte",
      "duration_min": 90,
      "price": "120000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.319Z",
      "updated_at": "2026-08-04T22:34:19.319Z"
    },
    {
      "id": "a76a61f7-dd1a-4cac-817a-1a9bbbfdf0ac",
      "public_reference": "2ea149ea-81c1-4560-9455-96157e95f23f",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-06T14:00:00.000Z",
      "service_end_at": "2026-08-06T14:45:00.000Z",
      "start_local": "2026-08-06T09:00:00-05:00",
      "end_local": "2026-08-06T09:45:00-05:00",
      "start_label": "9:00 a. m.",
      "end_label": "9:45 a. m.",
      "date_label": "jueves, 6 de agosto",
      "day": "2026-08-06",
      "status": "cancelled",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.326Z",
      "updated_at": "2026-08-04T22:34:19.326Z"
    },
    {
      "id": "f2d7e0ea-ed3e-4a62-8f66-9a438a0081c7",
      "public_reference": "b067b3ad-309c-4335-b710-3cd4e968da8c",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "2cdac9de-fad0-44ea-8f63-3c5c47a1ee2c",
      "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-06T16:00:00.000Z",
      "service_end_at": "2026-08-06T16:45:00.000Z",
      "start_local": "2026-08-06T11:00:00-05:00",
      "end_local": "2026-08-06T11:45:00-05:00",
      "start_label": "11:00 a. m.",
      "end_label": "11:45 a. m.",
      "date_label": "jueves, 6 de agosto",
      "day": "2026-08-06",
      "status": "no_show",
      "origin": "n8n",
      "service_name": "Corte de Cabello",
      "duration_min": 45,
      "price": "35000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.332Z",
      "updated_at": "2026-08-04T22:34:19.332Z"
    }
  ]
}
```

#### appointments list ?status=completed  · `200` · 934 B

```
GET /api/scheduling/v1/appointments?status=completed
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointments": [
    {
      "id": "1169f12a-aae1-479a-b27b-983bb0d715d4",
      "public_reference": "0213fc6b-44b5-480b-85c6-7a6c6f56f475",
      "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
      "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
      "service_id": "7818d0aa-9087-4f3f-8a25-c77abeeeda8c",
      "contact_id": "65957646-9eb4-4f37-86f2-376b18e5d051",
      "contact": {
        "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
        "name": "Camila Torres",
        "primary_identity": "+573001112233"
      },
      "source_conversation_id": null,
      "start_at": "2026-08-05T21:00:00.000Z",
      "service_end_at": "2026-08-05T22:30:00.000Z",
      "start_local": "2026-08-05T16:00:00-05:00",
      "end_local": "2026-08-05T17:30:00-05:00",
      "start_label": "4:00 p. m.",
      "end_label": "5:30 p. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "completed",
      "origin": "n8n",
      "service_name": "Tinte",
      "duration_min": 90,
      "price": "120000.00",
      "version": 1,
      "created_at": "2026-08-04T22:34:19.319Z",
      "updated_at": "2026-08-04T22:34:19.319Z"
    }
  ]
}
```

#### crm lookup ?phone=  · `200` · 1266 B

```
GET /api/crm/v1/contacts/lookup?phone=%2B573001112233
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "contact": {
    "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
    "name": "Camila Torres",
    "stage": "customer",
    "owner_user_id": null,
    "is_customer": true,
    "visits": 1,
    "no_shows": 1,
    "consent": "unknown",
    "custom_fields": {
      "barbero_preferido": "Ana"
    },
    "identities": [
      {
        "kind": "phone",
        "value": "+573001112233",
        "label": "whatsapp"
      },
      {
        "kind": "email",
        "value": "camila@example.com",
        "label": "whatsapp"
      }
    ],
    "tags": [
      "Frecuente",
      "VIP"
    ],
    "next_appointment": {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "service_name": "Corte de Cabello",
      "staff_name": "Ana",
      "start_at": "2026-08-05T16:00:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "start_label": "11:00 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled"
    },
    "recent_notes": [
      {
        "id": "563d8506-8366-4a08-9d96-381239a92501",
        "body": "Alergia a un tinte específico.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.341Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      },
      {
        "id": "f1856940-bea4-4e77-b747-55f496e29056",
        "body": "Prefiere las mañanas.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.339Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      }
    ]
  }
}
```

#### crm get contact  · `200` · 1266 B

```
GET /api/crm/v1/contacts/65957646-9eb4-4f37-86f2-376b18e5d051
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "contact": {
    "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
    "name": "Camila Torres",
    "stage": "customer",
    "owner_user_id": null,
    "is_customer": true,
    "visits": 1,
    "no_shows": 1,
    "consent": "unknown",
    "custom_fields": {
      "barbero_preferido": "Ana"
    },
    "identities": [
      {
        "kind": "phone",
        "value": "+573001112233",
        "label": "whatsapp"
      },
      {
        "kind": "email",
        "value": "camila@example.com",
        "label": "whatsapp"
      }
    ],
    "tags": [
      "Frecuente",
      "VIP"
    ],
    "next_appointment": {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "service_name": "Corte de Cabello",
      "staff_name": "Ana",
      "start_at": "2026-08-05T16:00:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "start_label": "11:00 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled"
    },
    "recent_notes": [
      {
        "id": "563d8506-8366-4a08-9d96-381239a92501",
        "body": "Alergia a un tinte específico.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.341Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      },
      {
        "id": "f1856940-bea4-4e77-b747-55f496e29056",
        "body": "Prefiere las mañanas.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.339Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      }
    ]
  }
}
```

#### crm field-definitions  · `200` · 108 B

```
GET /api/crm/v1/field-definitions
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "field_definitions": [
    {
      "key": "barbero_preferido",
      "label": "Barbero preferido",
      "type": "text",
      "options": null
    }
  ]
}
```

#### create appointment (2026-08-07 9:00)  · `201` · 805 B

```
POST /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2", "service": "Corte de Cabello", "staff": "Ana", "day": "2026-08-07", "time": "9:00", "customer_phone": "+573009990000", "customer_name": "Test"}
```

```json
{
  "appointment": {
    "id": "ecdac32f-255f-47dc-8567-ea7f4c3a6ed5",
    "public_reference": "14222a4e-f804-4083-b905-3d0bb840b4b8",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T14:00:00.000Z",
    "service_end_at": "2026-08-07T14:45:00.000Z",
    "start_local": "2026-08-07T09:00:00-05:00",
    "end_local": "2026-08-07T09:45:00-05:00",
    "start_label": "9:00 a. m.",
    "end_label": "9:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "scheduled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 1,
    "created_at": "2026-08-04T22:36:14.149Z",
    "updated_at": "2026-08-04T22:36:14.149Z"
  }
}
```

#### confirm  · `200` · 805 B

```
POST /api/scheduling/v1/appointments/ecdac32f-255f-47dc-8567-ea7f4c3a6ed5/confirm
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointment": {
    "id": "ecdac32f-255f-47dc-8567-ea7f4c3a6ed5",
    "public_reference": "14222a4e-f804-4083-b905-3d0bb840b4b8",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T14:00:00.000Z",
    "service_end_at": "2026-08-07T14:45:00.000Z",
    "start_local": "2026-08-07T09:00:00-05:00",
    "end_local": "2026-08-07T09:45:00-05:00",
    "start_label": "9:00 a. m.",
    "end_label": "9:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "confirmed",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 2,
    "created_at": "2026-08-04T22:36:14.149Z",
    "updated_at": "2026-08-04T22:36:14.160Z"
  }
}
```

#### create appointment (2026-08-07 10:00)  · `201` · 807 B

```
POST /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2", "service": "Corte de Cabello", "staff": "Ana", "day": "2026-08-07", "time": "10:00", "customer_phone": "+573009990000", "customer_name": "Test"}
```

```json
{
  "appointment": {
    "id": "593f9756-933d-4cff-a78f-7169ace3a499",
    "public_reference": "1b91fbb3-3187-473e-a2a2-874361803bd5",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T15:00:00.000Z",
    "service_end_at": "2026-08-07T15:45:00.000Z",
    "start_local": "2026-08-07T10:00:00-05:00",
    "end_local": "2026-08-07T10:45:00-05:00",
    "start_label": "10:00 a. m.",
    "end_label": "10:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "scheduled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 1,
    "created_at": "2026-08-04T22:36:14.183Z",
    "updated_at": "2026-08-04T22:36:14.183Z"
  }
}
```

#### confirm (for complete)  · `200` · 807 B

```
POST /api/scheduling/v1/appointments/593f9756-933d-4cff-a78f-7169ace3a499/confirm
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointment": {
    "id": "593f9756-933d-4cff-a78f-7169ace3a499",
    "public_reference": "1b91fbb3-3187-473e-a2a2-874361803bd5",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T15:00:00.000Z",
    "service_end_at": "2026-08-07T15:45:00.000Z",
    "start_local": "2026-08-07T10:00:00-05:00",
    "end_local": "2026-08-07T10:45:00-05:00",
    "start_label": "10:00 a. m.",
    "end_label": "10:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "confirmed",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 2,
    "created_at": "2026-08-04T22:36:14.183Z",
    "updated_at": "2026-08-04T22:36:14.189Z"
  }
}
```

#### complete  · `200` · 807 B

```
POST /api/scheduling/v1/appointments/593f9756-933d-4cff-a78f-7169ace3a499/complete
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointment": {
    "id": "593f9756-933d-4cff-a78f-7169ace3a499",
    "public_reference": "1b91fbb3-3187-473e-a2a2-874361803bd5",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T15:00:00.000Z",
    "service_end_at": "2026-08-07T15:45:00.000Z",
    "start_local": "2026-08-07T10:00:00-05:00",
    "end_local": "2026-08-07T10:45:00-05:00",
    "start_label": "10:00 a. m.",
    "end_label": "10:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "completed",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 3,
    "created_at": "2026-08-04T22:36:14.183Z",
    "updated_at": "2026-08-04T22:36:14.195Z"
  }
}
```

#### create appointment (2026-08-07 11:00)  · `201` · 807 B

```
POST /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2", "service": "Corte de Cabello", "staff": "Ana", "day": "2026-08-07", "time": "11:00", "customer_phone": "+573009990000", "customer_name": "Test"}
```

```json
{
  "appointment": {
    "id": "c198416e-a4e6-4548-a4d6-b53ce6e3219b",
    "public_reference": "a3415f82-4757-4981-8008-30e3fd62a15a",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T16:00:00.000Z",
    "service_end_at": "2026-08-07T16:45:00.000Z",
    "start_local": "2026-08-07T11:00:00-05:00",
    "end_local": "2026-08-07T11:45:00-05:00",
    "start_label": "11:00 a. m.",
    "end_label": "11:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "scheduled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 1,
    "created_at": "2026-08-04T22:36:14.203Z",
    "updated_at": "2026-08-04T22:36:14.203Z"
  }
}
```

#### cancel  · `200` · 807 B

```
POST /api/scheduling/v1/appointments/c198416e-a4e6-4548-a4d6-b53ce6e3219b/cancel
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"reason": "cliente cancel\u00f3"}
```

```json
{
  "appointment": {
    "id": "c198416e-a4e6-4548-a4d6-b53ce6e3219b",
    "public_reference": "a3415f82-4757-4981-8008-30e3fd62a15a",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T16:00:00.000Z",
    "service_end_at": "2026-08-07T16:45:00.000Z",
    "start_local": "2026-08-07T11:00:00-05:00",
    "end_local": "2026-08-07T11:45:00-05:00",
    "start_label": "11:00 a. m.",
    "end_label": "11:45 a. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "cancelled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 2,
    "created_at": "2026-08-04T22:36:14.203Z",
    "updated_at": "2026-08-04T22:36:14.210Z"
  }
}
```

#### create appointment (2026-08-07 12:00)  · `201` · 807 B

```
POST /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2", "service": "Corte de Cabello", "staff": "Ana", "day": "2026-08-07", "time": "12:00", "customer_phone": "+573009990000", "customer_name": "Test"}
```

```json
{
  "appointment": {
    "id": "43cdbb3f-cea0-4733-b181-c577dc6425eb",
    "public_reference": "2c73b15c-5aa1-4375-aa01-d511d2a5975d",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T17:00:00.000Z",
    "service_end_at": "2026-08-07T17:45:00.000Z",
    "start_local": "2026-08-07T12:00:00-05:00",
    "end_local": "2026-08-07T12:45:00-05:00",
    "start_label": "12:00 p. m.",
    "end_label": "12:45 p. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "scheduled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 1,
    "created_at": "2026-08-04T22:36:14.218Z",
    "updated_at": "2026-08-04T22:36:14.218Z"
  }
}
```

#### no-show  · `200` · 805 B

```
POST /api/scheduling/v1/appointments/43cdbb3f-cea0-4733-b181-c577dc6425eb/no-show
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "appointment": {
    "id": "43cdbb3f-cea0-4733-b181-c577dc6425eb",
    "public_reference": "2c73b15c-5aa1-4375-aa01-d511d2a5975d",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T17:00:00.000Z",
    "service_end_at": "2026-08-07T17:45:00.000Z",
    "start_local": "2026-08-07T12:00:00-05:00",
    "end_local": "2026-08-07T12:45:00-05:00",
    "start_label": "12:00 p. m.",
    "end_label": "12:45 p. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "no_show",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 2,
    "created_at": "2026-08-04T22:36:14.218Z",
    "updated_at": "2026-08-04T22:36:14.224Z"
  }
}
```

#### create appointment (2026-08-07 13:00)  · `201` · 805 B

```
POST /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2", "service": "Corte de Cabello", "staff": "Ana", "day": "2026-08-07", "time": "13:00", "customer_phone": "+573009990000", "customer_name": "Test"}
```

```json
{
  "appointment": {
    "id": "ebf5be6d-7fde-42b4-b1f2-30aff92d47ce",
    "public_reference": "ba54bae6-1389-4e1c-8d5c-21b667dc03db",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T18:00:00.000Z",
    "service_end_at": "2026-08-07T18:45:00.000Z",
    "start_local": "2026-08-07T13:00:00-05:00",
    "end_local": "2026-08-07T13:45:00-05:00",
    "start_label": "1:00 p. m.",
    "end_label": "1:45 p. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "scheduled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 1,
    "created_at": "2026-08-04T22:36:14.232Z",
    "updated_at": "2026-08-04T22:36:14.232Z"
  }
}
```

#### reschedule (day+time)  · `200` · 805 B

```
POST /api/scheduling/v1/appointments/ebf5be6d-7fde-42b4-b1f2-30aff92d47ce/reschedule
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"day": "2026-08-07", "time": "15:00"}
```

```json
{
  "appointment": {
    "id": "ebf5be6d-7fde-42b4-b1f2-30aff92d47ce",
    "public_reference": "ba54bae6-1389-4e1c-8d5c-21b667dc03db",
    "site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2",
    "staff_id": "0b7bbd93-c92a-4ffa-8579-50e5edcd0a9c",
    "service_id": "80e59d3b-4ad1-4a9d-b858-611852823565",
    "contact_id": null,
    "contact": null,
    "source_conversation_id": null,
    "start_at": "2026-08-07T20:00:00.000Z",
    "service_end_at": "2026-08-07T20:45:00.000Z",
    "start_local": "2026-08-07T15:00:00-05:00",
    "end_local": "2026-08-07T15:45:00-05:00",
    "start_label": "3:00 p. m.",
    "end_label": "3:45 p. m.",
    "date_label": "viernes, 7 de agosto",
    "day": "2026-08-07",
    "status": "scheduled",
    "origin": "n8n",
    "service_name": "Corte de Cabello",
    "duration_min": 45,
    "price": "35000.00",
    "version": 2,
    "created_at": "2026-08-04T22:36:14.232Z",
    "updated_at": "2026-08-04T22:36:14.239Z"
  }
}
```

#### crm upsert (existing by phone)  · `200` · 1509 B

```
POST /api/crm/v1/contacts/upsert
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"phone": "+573001112233", "name": "Camila Torres"}
```

```json
{
  "contact": {
    "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
    "name": "Camila Torres",
    "stage": "customer",
    "owner_user_id": null,
    "is_customer": true,
    "visits": 1,
    "no_shows": 1,
    "consent": "unknown",
    "custom_fields": {
      "barbero_preferido": "Beto"
    },
    "identities": [
      {
        "kind": "phone",
        "value": "+573001112233",
        "label": "whatsapp"
      },
      {
        "kind": "email",
        "value": "camila@example.com",
        "label": "whatsapp"
      }
    ],
    "tags": [
      "Frecuente",
      "VIP"
    ],
    "next_appointment": {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "service_name": "Corte de Cabello",
      "staff_name": "Ana",
      "start_at": "2026-08-05T16:00:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "start_label": "11:00 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled"
    },
    "recent_notes": [
      {
        "id": "773fc158-461a-4469-a7a4-2e5a49c7b0f8",
        "body": "Confirmó por WhatsApp.",
        "author": "automation",
        "created_at": "2026-08-04T22:36:14.256Z",
        "created_at_local": "2026-08-04T17:36:14-05:00",
        "created_at_label": "martes, 4 de agosto, 5:36 p. m."
      },
      {
        "id": "563d8506-8366-4a08-9d96-381239a92501",
        "body": "Alergia a un tinte específico.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.341Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      },
      {
        "id": "f1856940-bea4-4e77-b747-55f496e29056",
        "body": "Prefiere las mañanas.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.339Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      }
    ]
  }
}
```

#### crm patch (custom field + stage)  · `200` · 1267 B

```
PATCH /api/crm/v1/contacts/65957646-9eb4-4f37-86f2-376b18e5d051
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"custom_fields": {"barbero_preferido": "Beto"}}
```

```json
{
  "contact": {
    "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
    "name": "Camila Torres",
    "stage": "customer",
    "owner_user_id": null,
    "is_customer": true,
    "visits": 1,
    "no_shows": 1,
    "consent": "unknown",
    "custom_fields": {
      "barbero_preferido": "Beto"
    },
    "identities": [
      {
        "kind": "phone",
        "value": "+573001112233",
        "label": "whatsapp"
      },
      {
        "kind": "email",
        "value": "camila@example.com",
        "label": "whatsapp"
      }
    ],
    "tags": [
      "Frecuente",
      "VIP"
    ],
    "next_appointment": {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "service_name": "Corte de Cabello",
      "staff_name": "Ana",
      "start_at": "2026-08-05T16:00:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "start_label": "11:00 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled"
    },
    "recent_notes": [
      {
        "id": "563d8506-8366-4a08-9d96-381239a92501",
        "body": "Alergia a un tinte específico.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.341Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      },
      {
        "id": "f1856940-bea4-4e77-b747-55f496e29056",
        "body": "Prefiere las mañanas.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.339Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      }
    ]
  }
}
```

#### crm notes POST  · `201` · 250 B

```
POST /api/crm/v1/contacts/65957646-9eb4-4f37-86f2-376b18e5d051/notes
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"body": "Confirm\u00f3 por WhatsApp."}
```

```json
{
  "note": {
    "id": "773fc158-461a-4469-a7a4-2e5a49c7b0f8",
    "body": "Confirmó por WhatsApp.",
    "author": "automation",
    "created_at": "2026-08-04T22:36:14.256Z",
    "created_at_local": "2026-08-04T17:36:14-05:00",
    "created_at_label": "martes, 4 de agosto, 5:36 p. m."
  }
}
```

#### crm tags POST (attach)  · `200` · 1517 B

```
POST /api/crm/v1/contacts/65957646-9eb4-4f37-86f2-376b18e5d051/tags
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"tag": "Nuevo"}
```

```json
{
  "contact": {
    "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
    "name": "Camila Torres",
    "stage": "customer",
    "owner_user_id": null,
    "is_customer": true,
    "visits": 1,
    "no_shows": 1,
    "consent": "unknown",
    "custom_fields": {
      "barbero_preferido": "Beto"
    },
    "identities": [
      {
        "kind": "phone",
        "value": "+573001112233",
        "label": "whatsapp"
      },
      {
        "kind": "email",
        "value": "camila@example.com",
        "label": "whatsapp"
      }
    ],
    "tags": [
      "Frecuente",
      "Nuevo",
      "VIP"
    ],
    "next_appointment": {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "service_name": "Corte de Cabello",
      "staff_name": "Ana",
      "start_at": "2026-08-05T16:00:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "start_label": "11:00 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled"
    },
    "recent_notes": [
      {
        "id": "773fc158-461a-4469-a7a4-2e5a49c7b0f8",
        "body": "Confirmó por WhatsApp.",
        "author": "automation",
        "created_at": "2026-08-04T22:36:14.256Z",
        "created_at_local": "2026-08-04T17:36:14-05:00",
        "created_at_label": "martes, 4 de agosto, 5:36 p. m."
      },
      {
        "id": "563d8506-8366-4a08-9d96-381239a92501",
        "body": "Alergia a un tinte específico.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.341Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      },
      {
        "id": "f1856940-bea4-4e77-b747-55f496e29056",
        "body": "Prefiere las mañanas.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.339Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      }
    ]
  }
}
```

#### crm tags DELETE (detach)  · `200` · 1509 B

```
DELETE /api/crm/v1/contacts/65957646-9eb4-4f37-86f2-376b18e5d051/tags/Nuevo
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "contact": {
    "id": "65957646-9eb4-4f37-86f2-376b18e5d051",
    "name": "Camila Torres",
    "stage": "customer",
    "owner_user_id": null,
    "is_customer": true,
    "visits": 1,
    "no_shows": 1,
    "consent": "unknown",
    "custom_fields": {
      "barbero_preferido": "Beto"
    },
    "identities": [
      {
        "kind": "phone",
        "value": "+573001112233",
        "label": "whatsapp"
      },
      {
        "kind": "email",
        "value": "camila@example.com",
        "label": "whatsapp"
      }
    ],
    "tags": [
      "Frecuente",
      "VIP"
    ],
    "next_appointment": {
      "id": "a468b620-d5a4-4116-90fd-09c73d6c7971",
      "public_reference": "b202239e-d3d3-49e9-92ce-c61b483bf51f",
      "service_name": "Corte de Cabello",
      "staff_name": "Ana",
      "start_at": "2026-08-05T16:00:00.000Z",
      "start_local": "2026-08-05T11:00:00-05:00",
      "start_label": "11:00 a. m.",
      "date_label": "miércoles, 5 de agosto",
      "day": "2026-08-05",
      "status": "scheduled"
    },
    "recent_notes": [
      {
        "id": "773fc158-461a-4469-a7a4-2e5a49c7b0f8",
        "body": "Confirmó por WhatsApp.",
        "author": "automation",
        "created_at": "2026-08-04T22:36:14.256Z",
        "created_at_local": "2026-08-04T17:36:14-05:00",
        "created_at_label": "martes, 4 de agosto, 5:36 p. m."
      },
      {
        "id": "563d8506-8366-4a08-9d96-381239a92501",
        "body": "Alergia a un tinte específico.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.341Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      },
      {
        "id": "f1856940-bea4-4e77-b747-55f496e29056",
        "body": "Prefiere las mañanas.",
        "author": "automation",
        "created_at": "2026-08-04T22:34:19.339Z",
        "created_at_local": "2026-08-04T17:34:19-05:00",
        "created_at_label": "martes, 4 de agosto, 5:34 p. m."
      }
    ]
  }
}
```

#### handoff mode (GET)  · `200` · 49 B

```
GET /api/handoff/v1/mode?workflow_ref=catalog-wf&conversation_ref=conv-cat-1
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "mode": "bot",
  "as_of": "2026-08-04T22:36:14.276Z"
}
```

#### handoff messages (POST)  · `201` · 149 B

```
POST /api/handoff/v1/messages
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"workflow_ref": "catalog-wf", "conversation_ref": "conv-cat-1", "sender": "user", "text": "Hola, quiero una cita"}
```

```json
{
  "message_id": "e3c596dd-39ae-433d-b93d-7b7063833008",
  "conversation": {
    "id": "e054a299-0e14-42f8-a478-ba3d9c863c3e",
    "mode": "bot",
    "assigned_agent": null
  }
}
```

#### handoff escalations (POST)  · `201` · 101 B

```
POST /api/handoff/v1/escalations
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"workflow_ref": "catalog-wf", "conversation_ref": "conv-cat-1", "reason_code": "customer_request"}
```

```json
{
  "conversation": {
    "id": "e054a299-0e14-42f8-a478-ba3d9c863c3e",
    "mode": "pending",
    "assigned_agent": null
  }
}
```

#### ERR service_not_found (bad name → valid list)  · `400` · 149 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Masaje&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "service_not_found",
    "message": "No service named “Masaje” at this site. Valid services: Barba, Cejas, Corte de Cabello, Tinte."
  }
}
```

#### ERR staff_not_found  · `400` · 111 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Corte+de+Cabello&staff=Zoe&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "staff_not_found",
    "message": "No staff named “Zoe” at this site. Valid staff: Ana, Beto."
  }
}
```

#### ERR staff_service_mismatch (Beto+Tinte)  · `409` · 184 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Tinte&staff=Beto&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "staff_service_mismatch",
    "message": "Beto doesn’t perform Tinte. Staff who do: Ana. Omit the staff filter to see all availability, or pick a service Beto performs."
  }
}
```

#### ERR ambiguous_match (service='Cejas' x2)  · `400` · 210 B

```
GET /api/scheduling/v1/availability?site_id=7f155ea0-34a9-4e20-ba53-1545ce3625f2&service=Cejas&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "ambiguous_match",
    "message": "More than one service matches “Cejas”: Cejas (82192966-f292-45cc-8901-2132c68646c3); Cejas (9f8ea61f-3d74-4f4b-8aee-b20772530cfd). Pass service_id to choose."
  }
}
```

#### ERR site_inactive  · `409` · 255 B

```
GET /api/scheduling/v1/availability?site_id=8b8c1978-d784-425d-90ee-47c99ff96813&service=Corte+de+Cabello&from=2026-08-05T00%3A00%3A00Z&to=2026-08-05T23%3A59%3A00Z
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "site_inactive",
    "message": "This site exists but is deactivated, so it can’t be used for availability or new bookings. Reactivate it in scheduling settings, or use a different site_id (GET /api/scheduling/v1/sites lists active sites)."
  }
}
```

#### ERR contact_not_found  · `404` · 187 B

```
GET /api/crm/v1/contacts/00000000-0000-4000-8000-000000000001
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "contact_not_found",
    "message": "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one."
  }
}
```

#### ERR 409 slot conflict  · `409` · 140 B

```
POST /api/scheduling/v1/appointments
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
body: {"site_id": "7f155ea0-34a9-4e20-ba53-1545ce3625f2", "service": "Corte de Cabello", "staff": "Ana", "day": "2026-08-07", "time": "09:00", "customer_phone": "+573008887777"}
```

```json
{
  "error": {
    "code": "unavailable",
    "message": "That time is no longer available. Available that day: 10:00, 10:30, 11:00, 11:30, 12:00, 12:30."
  }
}
```

#### ERR 400 unknown parameter  · `400` · 83 B

```
GET /api/scheduling/v1/appointments?foo=bar
Authorization: Bearer <token>; X-Workflow-Ref: catalog-wf
```

```json
{
  "error": {
    "code": "unknown_parameter",
    "message": "Unknown query parameter(s): foo."
  }
}
```
