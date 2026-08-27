# CRM + Inbox visual rework — extracted spec

Source of truth: Claude Design project **"AI startup interface redesign"**
(`a18e2ec9-e531-4df1-a9a7-1eb8baf08e20`), file `CRM Inbox.dc.html`, artboards:

| Artboard | Title | Covers |
| --- | --- | --- |
| `16c` | Inbox — contraste: chat sobre gris | queue + thread + client panel |
| `22a` | Contactos — avatares esfera | title row + facets + table + contact panel |

The other files in that project (`CRM Contacts 3 Boxes.*`, `CRM Color Refactor.*`)
are **earlier iterations** — `22a` inside `CRM Inbox.dc.html` is the current one.
Distinguishing marks of the current iteration: search inline in the title row,
Importar/Exportar, the segmented facet pills, the `Origen` / `Visitas` /
`Última interacción` columns, and `Mostrando 1–15 de 312`.

Everything below is measured off that file, not eyeballed off a screenshot.
Values are recorded raw (hex, px) so a later diff against the artboard is
mechanical; mapping them onto app tokens is the implementation's job, not this
document's.

---

## 1. Shell values shared by both screens

| Thing | Value |
| --- | --- |
| Content canvas behind the cards | `#EFF0F3` (contacts) · `#E9EAEE` (inbox) |
| Canvas padding | 12px (contacts) · 16px (inbox) |
| Gap between stacked cards | 12px |
| Card | `#FFFFFF`, 1px `#E1E4E9`, radius **14px**, `0 1px 2px rgba(16,20,28,0.04)` |
| Inbox workspace card | `#FAFAFB`, 1px `#DEE0E5`, radius 14px, `0 1px 2px rgba(18,21,27,0.03)` |
| Topbar | 54px, `#FAFAFB`, bottom 1px `#C9CCD3` |
| Sidebar | 238px, `#1A1D24` — **out of scope for this rework** |

### Radii (the design is NOT on one radius)

| Use | Radius |
| --- | --- |
| Card / panel / composer | 14px |
| Control (search, primary button, queue search) | 11px |
| Chip / facet pill / secondary button / tab underline box | 9px |
| Pagination cell, status chip, small badge | 7–8px |
| Message bubble | 16px, with the **tail corner at 6px** (see §3.3) |
| Avatar | 50% |

### Type

| Role | Value |
| --- | --- |
| Screen title ("Contactos", "Inbox") | 15px / 600 (contacts), 590 (inbox), tracking −0.015em |
| Row primary (name) | 13px / 400, tracking −0.01em, `#1D1D1F` |
| Row secondary (email, preview) | 12.5px, `#6E6E73` |
| Body / bubble text | 13px, line-height 1.45, `text-wrap: pretty` |
| Meta / timestamp | 11px `#A1A1A6`, or 10.5px in the thread |
| Section heading in a panel | 11px / 590, `#6E6E73` |
| Table head | 11px / 590, tracking 0.01em, `#6E6E73` — **not** uppercase mono |
| Structured label (`SLOTS OFRECIDOS`) | mono 9.5px, tracking 0.09em |
| Phone / counts / ids | mono, `font-variant-numeric: tabular-nums` |

> Note the table head departs from the app's current `u-th` (mono, uppercase,
> tracked-out). The design uses plain sentence-case sans at 590.

### Greys

`#12151B` ink · `#1D1D1F` row title · `#3A3A3C` · `#3A404C` · `#4C5361` ·
`#6C7484` · `#6E6E73` · `#7B8494` · `#9BA3B2` · `#A1A1A6` · `#B7BEC9` ·
`#C6CAD3` · `#C9CCD3` · `#DCDFE5` · `#DDE0E6` · `#DEE0E5` · `#E1E4E9` ·
`#E9EAEE` · `#EAEBEE` · `#EEEFF2` · `#F1F2F5` · `#F3F4F7` · `#F5F6F8` ·
`#FAFAFB`

### Accent discipline

Red `#E60A2F` (hover `#C70826`) is spent on **only** three things:

1. the active sidebar nav item (out of scope),
2. `Agendar cita` — the one primary action in a **panel**,
3. the "a human is handling this" dot + an inline `Ver en agenda ↗` link.

Every other primary button — `Nuevo contacto`, `Devolver al bot`, `Enviar`,
the active facet pill, the current pagination page — is **ink `#12151B`**
(hover `#2A2E36`). This is the single biggest colour change from today's app,
where the toolbar primary is red.

### Avatars are two-tone spheres

`linear-gradient(135deg, A 0%, A 34%, B 66%, B 100%)` with white mono initials.
Observed pairs:

| Pair | Use in the design |
| --- | --- |
| `#2E9C7F` → `#2F6FA8` | Camila Reyes |
| `#E0568C` → `#8E4BC4` | Paola (staff), Savannah |
| `#7E6BD6` → `#4E7BD0` | Camila in the inbox panel |

Sizes: 40px (panel header) · 30px (table row, queue row) · 26px (thread) ·
22px (note author) · 18px/16px (inline staff mention). Font is mono 600 at
13.5 / 10 / 9.5 / 8 / 7.5px respectively.

The **queue** avatar is the exception: a flat tone, and it carries the
contact's **visit count**, not initials (`14`, `3`, `6`, `0`, `2`, `9`).
Flat tones seen: `#1F7A6B` `#C42A63` `#5B4BA6` `#2A5FA8` `#3F4756` `#3A404C`.

---

## 2. Contactos (`22a`)

### 2.1 Title row card

One card, 9px 12px padding, `align-items:center`, gap 4px:

- `Contactos` — 15px/600, padding `0 8px 0 6px`
- search shell — `flex:1`, `max-width:420px`, bg `#F5F6F8`, **1.5px transparent
  border** (hover `#DDE0E6`), radius 11px, padding 8px 11px, 14px magnifier
  stroke `#9BA3B2`, placeholder 12.5px `#7B8494`
- `margin-left:auto` group: `Importar`, `Exportar` — ghost, 12.5px `#3A404C`,
  padding 7px 10px, radius 9px, hover bg `#F1F2F5`; each with a 14px arrow icon
- `Nuevo contacto` — **ink** `#12151B`, white, 12.5px/600, padding 8px 14px,
  radius 11px, 13px plus icon, hover `#2A2E36`

### 2.2 Facet row (inside the table card, above the head)

Padding 11px 14px, bottom 1px `#EEEFF2`, gap 4px.

Segmented pills, each `label + mono count`:

- active: bg `#12151B`, label white 12.5px/600, count mono 10.5px `#B0B6C2`
- idle: transparent, label 12.5px `#4C5361`, count mono 10.5px `#9BA3B2`,
  hover bg `#F1F2F5` + label `#12151B`
- padding 6px 13px, radius 9px, gap 6px

Facets: `Todos 312` · `Nuevos 28` · `Activos 96` · `Clientes 188` · `Sin dueño 14`

Right side (`margin-left:auto`): `Filtrar` and `Orden: última visita` — outlined,
1px `#DDE0E6`, radius 9px, 12px `#3A404C`, padding 6px 11px, hover border
`#9BA3B2`.

### 2.3 Table

CSS **grid**, not a `<table>`. Same template on head and rows:

```
minmax(200px,1.7fr) minmax(128px,1fr) minmax(92px,0.72fr)
minmax(108px,0.86fr) minmax(140px,1fr) 44px 28px
```

gap 10px, padding `0 16px`.

- **head** — 38px, bg `#FFFFFF`, sticky top, bottom 1px `#EEEFF2`,
  11px/590 `#6E6E73`: `Nombre · Teléfono · Origen · Visitas · Última interacción · Dueño · ∅`
- **row** — 54px, bottom 1px `#F1F2F5`, hover `#FAFBFC`;
  selected row bg `#F3F4F7` (no left rule, no tint — just a step darker)

Cells:

| Column | Content |
| --- | --- |
| Nombre | 30px gradient avatar + two lines: name 13px `#1D1D1F` / email 12.5px `#6E6E73` |
| Teléfono | 13px `#3A3A3C`, tabular |
| Origen | 13px `#3A3A3C` — plain text ("WhatsApp"), no chip |
| Visitas | 4px track `#EEEFF2` radius 2px + fill `#8792A6` at `n%`, then mono 11.5px `#4C5361` count |
| Última interacción | two lines: channel 12.5px `#1D1D1F` / relative 11px `#A1A1A6` |
| Dueño | 26px disc, bg `#EDEFF3`, 1px `#E1E4E9`, mono 8.5px `#4C5361` initials |
| ∅ | `···` 12px `#9BA3B2`, right aligned |

### 2.4 Footer

11px 16px, top 1px `#EEEFF2`. Left: `Mostrando 1–15 de 312 contactos`
11.5px `#7B8494`. Right: 26px square cells, radius 8px, mono 11px — current
page ink `#12151B`/white, others `#4C5361` hover `#F1F2F5`, then `›`.

### 2.5 Contact panel — 380px

- **header** — padding 14px 16px 13px, bottom 1px `#F1F2F5`, background is a
  vertical wash of the contact's own avatar tones:
  `linear-gradient(180deg, rgba(46,156,127,0.10) 0%, rgba(47,111,168,0.035) 60%, rgba(255,255,255,0) 100%)`.
  40px avatar with `box-shadow:0 0 0 3px rgba(255,255,255,0.9)`; name 15.5px/400
  tracking −0.02em; stage chip `#EAF4EE` bg / `#1F5B3C` text, 10.5px, radius 7px;
  second line `phone · 14 citas`; then 28px edit + close glyphs.
- **tabs** — padding `0 16px`, bottom 1px `#F1F2F5`, gap 18px. Active tab:
  `box-shadow: inset 0 -2px 0 #1D1D1F`, 12.5px/590. Idle 12.5px `#6E6E73`
  with a count in 11px `#A1A1A6`. `Agendar cita` sits at `margin-left:auto`
  **on the tab row** — red, 12px/600, padding 6px 12px, radius 9px.
- **body sections** — padding 15px 18px 14px, gap 4px. Heading 11px/590
  `#6E6E73`. Each fact is a row, padding `6px 0`, gap 10px: label 104px fixed
  11.5px `#7B8494`, value `flex:1` **right-aligned** 12.5px `#12151B` (mono 12px
  when it is a number/phone).
  Sections: `Contacto` · `Asignación` · `Mensajería` · `Etiquetas` · `Notas`.
- **footer** — a warn strip with a dot, the sentence, and a right-aligned
  action (`Falta confirmar el consentimiento de mensajería` / `Completar`).

---

## 3. Inbox (`16c`)

Three columns inside ONE workspace card: queue 320px · thread `flex:1` ·
client panel 340px.

### 3.1 Queue — 320px, bg `#FAFAFB`, right 1px `#DCDFE5`

- header 13px 14px 11px: `Inbox` 15px/590 + `2 te necesitan` 11px `#A1A1A6`
- search: margin `0 14px 11px`, bg `#F1F2F5`, 1.5px transparent, radius 11px
- **group heading** — padding 14px 14px 8px (20px top after the first), 7px dot,
  11px/590 `#6E6E73`, count right 11px `#A1A1A6`. Dots:
  `#E60A2F` *Un humano atiende* · `#5B4BA6` *El bot atiende* · `#C6CAD3` *Cerradas hoy*
- **row** — padding 14px, gap 10px, bottom 1px `#E9EAEE`, hover `#F1F2F4`;
  30px flat avatar carrying the visit count; title 13px (or mono 12.5px tabular
  for a bare phone); preview 12.5px with the speaker prefix in a lighter grey;
  meta `Flujo · Canal` 11px
- **selected row** — breaks out of the list: `margin:4px 8px`, padding 12px,
  bg `#EEF0F5`, radius 12px, **no** bottom border
- unread vs read is carried by the greys: preview `#3A3A3C` / `#6E6E73`,
  prefix `#7B8494` / `#9BA3B2`, meta `#6E6E73` / `#A1A1A6`

### 3.2 Thread header — bg `#FAFAFB`, bottom 1px `#DEE0E5`, padding 10px 16px

- state chip: bg `#F1F2F5`, radius 8px, 11px/590 `#3A3A3C`, 6px dot `#E60A2F`,
  label `Humano`
- name 14.5px/400 tracking −0.015em + phone 11.5px `#6E6E73` tabular
- second line: flow name 11.5px `#7B8494` · `visto · escribiendo` 11.5px
  `#1F7A4D` with a 5px dot
- right: `Devolver al bot` **ink** 12.5px/600 radius 11px · `Detalles` outlined
  1px `#DDE0E6` · `✕` 32px outlined

### 3.3 Transcript — bg `#EDEEF1`, padding 20px 24px 14px, gap 16px

Bubbles cap at `max-width:62%`.

| Voice | Fill | Border | Radius | Text |
| --- | --- | --- | --- | --- |
| Customer (left) | `#FFFFFF` | 1px `#DEE0E5` | `16 16 16 6` | 13px `#12151B` |
| Bot (right) | `#16181D` | — | `16 16 6 16` | 13px `#F5F6F8` |
| Human agent (right) | `#FFFFFF` | **1px `#12151B`** | `16 16 6 16` | 13px `#12151B`, `0 1px 2px rgba(18,21,27,0.05)` |

Avatars 26px beside the bubble: customer `#E9E5F6`/`#5B4BA6` initials · bot
solid `#16181D` white mono `BOT` 8.5px · agent white with a **1.5px ink ring**.
Timestamp 10.5px `#A1A1A6` under the bubble, outside it. The agent bubble also
gets a mono 9px `SANTIAGO · EQUIPO` label above it and `10:36 AM · leído` below
in mono 9.5px `#9BA3B2`.

**Structured payload inside a bot bubble.** The bubble becomes a column
(gap 9px); below the prose a block separated by `padding-top:9px` +
`border-top:1px #2E323A`:

- label mono 9.5px tracking 0.09em `#8A93A3` — e.g. `SLOTS OFRECIDOS`
- each option: bg `#262A31`, radius 9px, padding 7px 9px — mono 11.5px
  `#F5F6F8` on the left, 11.5px `#9BA3B2` on the right (the staff name)
- the **chosen** option adds `box-shadow: inset 2px 0 0 #FFFFFF`, turns its
  text white/600, and its right slot becomes `✓ elegido`

**System event strip** — `align-self:center`, bg `#FAFAFB`, 1px `#DDE0E6`,
radius 10px, padding 9px 12px, `0 1px 2px rgba(18,21,27,0.04)`: a mono 9.5px
tracked label (`REAGENDADA POR EL BOT`), the sentence 12.5px `#3A404C` with the
key fact in 600, and a red `Ver en agenda ↗` link 12px.

**Day / takeover divider** — a centred 11px `#6E6E73` caption between two 1px
`#DEE0E5` rules (`hoy · el bot tomó la conversación 10:28`). The
*someone joined* variant puts a bordered pill on the rule instead: 6px ink dot
+ mono 9.5px `SANTIAGO ENTRÓ AL CHAT` + 10.5px time.

**Typing indicator** — a customer-shaped bubble holding three 5px `#C6CAD3`
dots + `Camila está escribiendo` 11.5px `#9BA3B2`.

### 3.4 Composer — padding 10px 20px 18px on the `#EDEEF1` ground

Card `#FFFFFF`, 1px `#DEE0E5`, radius 14px, and the one **real** elevation in
the design: `0 6px 16px rgba(18,21,27,0.08), 0 1px 2px rgba(18,21,27,0.05)`.

- textarea area padding 12px 13px, placeholder 13px `#A1A1A6`
- action bar: top 1px `#E9EAEE`, padding 8px 12px, gap 10px —
  `Insertar horario` / `Respuesta guardada` chips (bg `#EAEBEE`, 1px `#DEE0E5`,
  radius 9px, 11.5px), the hint `El bot queda en pausa mientras respondes`
  11.5px `#A1A1A6`, and `Enviar` **ink** 12px/600 padding 7px 17px radius 10px

### 3.5 Client panel — 340px, bg `#FAFAFB`, left 1px `#C9CCD3`

`box-shadow: inset 4px 0 0 #E9EAEE` — the panel reads as separated from the
transcript by a recessed gutter rather than by a gap.

1. **header bar** — `Cliente` 14px/590 + `✕`, bottom 1px `#DEE0E5`
2. **identity** — 38px gradient avatar, name 15px/400, `Ficha ↗` red link at
   `margin-left:auto`, second line `phone · ● WhatsApp`
3. **actions** — `Agendar cita` red, `flex:1`, radius 10px, 12.5px/600,
   `0 1px 2px rgba(230,10,47,0.30)` + a 34px outlined `···`
4. **stat strip** — centred, bg `#F3F4F6`, 1px `#DEE0E5` top and bottom,
   padding 9px 16px: `14 visitas · 1 no-show · hace 4 d la última`, numbers
   13px/600 `#12151B`, nouns 11.5px `#7B8494`
5. **Próxima cita** — heading row (`Próxima cita` — hairline — `2 en total →`),
   then a bordered card radius 11px: title row `Paquete de keratina` 12.5px/600
   + status chip (`#EAEBEE`, ink dot, `Agendada`); body `vie 7 ago · 4:00 → 4:45 PM`
   12px tabular + `en 3 días` 11px `#7B8494`; a staff line with an 18px gradient
   disc; and three outlined buttons `Reagendar` `Cancelar` — `Confirmar`
   (the last pushed right)
6. **Preferencias** — heading with an `Editar` affordance; label 112px fixed
   11.5px `#7B8494`, value 12px/500 `#12151B` **left**-aligned (note: the
   contacts panel right-aligns its values, this one does not)
7. **Tareas abiertas** — `+ Tarea`; a 15px checkbox (1px `#B7BEC9`, radius 5px),
   the task 12.5px, and a mono 10px `#B0313F` due marker (`HOY`)
8. **Notas** — `+ Nota`; each note is a 22px author disc + text 12.5px `#3A404C`
   + `SANTIAGO · HOY 10:35 AM` 10.5px `#A1A1A6`. The staff author uses a
   gradient disc, the current user a white disc with a 1.5px ink ring.
9. **Etiquetas** — chips + `+ Etiqueta`

Every section: padding 13px 16px, bottom 1px `#DEE0E5`, gap 10px, and a heading
row of `label — 1px #E9EAEE hairline — affordance`.

---

## 4. What the design shows that the data layer does not have yet

Recorded here so the UI and the migrations stay honest about which is which.

| Design element | Backing data today |
| --- | --- |
| `Origen` column + panel row | **missing** — no acquisition-source field on a contact |
| `Visitas` bar + count, queue avatar number | **missing** as a stored counter (derivable from appointments) |
| `1 no-show` | **missing** as a counter |
| `hace 4 d la última` | partially — `last_visit` exists |
| `Última interacción` channel + relative time | partially — needs the channel of the last message |
| Próxima cita card + Reagendar/Cancelar/Confirmar | endpoints exist; the panel does not read them |
| `Barbero preferido`, `Canal preferido` | **missing** as preferences |
| `Consentimiento` | exists |
| `SLOTS OFRECIDOS` structured payload | **missing** — messages are plain text; needs a payload column |
| `REAGENDADA POR EL BOT` event strip | **missing** — needs a typed conversation-event record |
| `Flujo de reagenda` (flow name on a conversation) | partially |
| Facet counts (312 / 28 / 96 / 188 / 14) | exists (`summarizeContacts`) |
| Pagination (page numbers) | **cursor**-based today; page numbers need a count + offset |
