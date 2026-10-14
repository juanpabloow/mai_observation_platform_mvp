# Disponibilidad explicable — por qué un profesional no está disponible

Contrato **v1**. Es aditivo y opt-in: sin `explain=true`, `/availability` responde exactamente igual que antes.

## Principio

El motivo **sale de la configuración real**, nunca de una suposición:

- horario de la sede;
- turno del profesional;
- bloqueos;
- citas;
- reglas de reserva.

Del bloqueo solo se usa su **motivo público**, que es una elección explícita:

| Código | Etiqueta | Alcance |
| --- | --- | --- |
| `vacation` | Vacaciones | solo bloqueos de un profesional |
| `unavailable` | No disponible | profesional o sede |
| `site_closed` | Cierre de la sede | solo bloqueos de toda la sede |
| `null` | *(no mostrar)* | **predeterminado**, también para los bloqueos existentes |

Reglas sobre el motivo:

- El texto `reason` del bloqueo es **interno**: no se devuelve, no se copia, no se clasifica
  por palabras clave y no se envía al modelo.
- No hay código médico.
- Los bloqueos existentes quedan sin motivo público.

## `GET /api/scheduling/v1/availability?…&explain=true`

Agrega `explanation`. Los slots se calculan igual que sin el parámetro.
`explain` solo acepta `true` o `false`; cualquier otro valor da 400.

```
explanation: {
  version: 1,
  staff: [{                               // el profesional pedido (o cada uno que hace el servicio)
    staff_id, staff_name,
    status: "available" | "partial" | "unavailable",   // sobre todos los días pedidos
    summary,                              // ver la tabla de abajo
    public_reason, public_reason_label,   // solo si TODOS los días comparten el mismo motivo confirmado
    customer_message,                     // frase segura es-CO, construida solo con códigos
    days: [{ date, status, slot_count, summary, public_reason, public_reason_label,
             customer_message, causes: [{ code, coverage: "all"|"part", minutes, public_reason }] }],
    next_available: { start_at, service_end_at, day, time, start_label } | null
  }],
  alternatives: [{ staff_id, staff_name, slot_count, first_slot }]   // otros con slots reales
}
```

Cómo se arma la respuesta:

- **Por día y por intervalo.** Cada causa se mide sobre el intervalo pedido, recortado a ese
  día local de la sede.
  - Un bloqueo de una hora **no** convierte el día en ausencia: aparece como causa `part` y el
    día sigue `available`.
  - «En esa fecha» solo se dice cuando el bloqueo cubre todo el turno del día. Si no, la frase
    es «en ese horario».
- **Varias causas.** El `summary` queda en `multiple` y `causes` las lista todas con su parte.
  No se elige una «más probable».
- **Siguiente hora reservable.** `next_available` es el primer slot real del motor después de
  la ventana (mismo servicio y profesional, hasta 30 días). **Nunca** se deduce del final de un
  bloqueo.
- **Alternativas.** `alternatives` son otros profesionales con slots reales para el mismo
  servicio y la misma ventana. Solo se calculan cuando se pidió un profesional y este no está
  disponible.
- **Error 409.** `staff_service_mismatch` mantiene su estado y su código. Con `explain=true`
  agrega `explanation` con uno de estos `summary`:
  - `staff_does_not_perform_service`: el profesional no hace ese servicio;
  - `not_bookable`: el profesional no recibe reservas.
  En ese caso, `alternatives` son quienes sí lo hacen.

### `summary` / `causes[].code`

| Código | Significa | Mensaje al cliente |
| --- | --- | --- |
| `available` | hay slots | «X tiene N horarios disponibles ese día.» |
| `absence` + `vacation` | bloqueo del profesional con motivo público | «X está de vacaciones en esa fecha / en ese horario.» |
| `absence` + `unavailable` | ídem | «X no está disponible en esa fecha.» |
| `absence` sin motivo | bloqueo sin motivo público | «X no tiene disponibilidad para ese horario.» |
| `site_closure` + `site_closed` | bloqueo de toda la sede | «La sede está cerrada en esa fecha.» |
| `site_closed_day` | la sede no abre ese día de la semana | «La sede no abre ese día.» |
| `outside_site_hours` | el intervalo cae fuera del horario de la sede | «La sede no atiende en ese horario.» |
| `off_shift` | fuera de turno, pausa o sin turno ese día | «X no trabaja ese día / en ese horario.» |
| `booked` | ocupado por citas (sin ningún detalle de ellas) | «X ya tiene ocupado ese horario.» |
| `service_does_not_fit` | hay huecos, pero ninguno alcanza para duración + buffers | «X no tiene un espacio suficiente…» |
| `no_valid_start_in_window` | el servicio solo cabe terminando fuera del intervalo | «El servicio no alcanza a terminar…» |
| `min_notice` / `beyond_booking_horizon` / `in_the_past` | reglas de reserva | frases propias |
| `multiple` / `unknown` | varias causas / ninguna identificada | «X no tiene disponibilidad para ese horario.» |

## `GET /api/scheduling/v1/staff/status?site_id=&(staff_id|staff)=&date=YYYY-MM-DD&days=1..14`

Responde «¿trabaja hoy?» **sin servicio**. Se basa solo en el horario de la sede, el turno y
los bloqueos:

- No lee citas.
- No devuelve horas reservables, porque esas dependen del servicio.

Cada día trae:

- `status`: `working`, `partly_working` o `not_working`;
- `summary`, más `public_reason` cuando un bloqueo cubre todo el turno;
- `customer_message`;
- `shift`: lo que queda del turno después de los bloqueos.

Usa la misma autenticación (`scheduling.read`) y el mismo aislamiento cliente → sede →
profesional.

## Ejemplos (fixtures sintéticos de la base local de vista previa)

Bloqueo sintético de Falla: del 4 al 6 de noviembre de 2026, día completo, `public_reason = vacation`.
Su motivo interno es «Cita médica: control de rodilla (sintético)». Ese texto **no aparece** en
ninguna respuesta.

### 1. Un día de vacaciones (`staff=Falla&service=Corte&compact=true&explain=true`)

```json
{
  "site": {
    "id": "<id-1>",
    "timezone": "America/Bogota",
    "timezone_used": "America/Bogota"
  },
  "has_availability": {
    "2026-11-04": false,
    "2026-11-05": false
  },
  "free_blocks": [],
  "explanation": {
    "version": 1,
    "staff": [
      {
        "staff_id": "<id-2>",
        "staff_name": "Falla",
        "status": "unavailable",
        "summary": "absence",
        "public_reason": "vacation",
        "public_reason_label": "Vacaciones",
        "customer_message": "Falla está de vacaciones en esa fecha.",
        "days": [
          {
            "date": "2026-11-04",
            "status": "unavailable",
            "slot_count": 0,
            "summary": "absence",
            "public_reason": "vacation",
            "public_reason_label": "Vacaciones",
            "customer_message": "Falla está de vacaciones en esa fecha.",
            "causes": [
              {
                "code": "absence",
                "coverage": "all",
                "minutes": 600,
                "public_reason": "vacation"
              }
            ]
          }
        ],
        "next_available": {
          "start_at": "2026-11-07T15:00:00.000Z",
          "service_end_at": "2026-11-07T15:50:00.000Z",
          "day": "2026-11-07",
          "time": "10:00",
          "start_label": "10:00 a. m."
        }
      }
    ],
    "alternatives": [
      {
        "staff_id": "<id-3>",
        "staff_name": "Federico",
        "slot_count": 30,
        "first_slot": {
          "start_at": "2026-11-04T15:00:00.000Z",
          "service_end_at": "2026-11-04T15:50:00.000Z",
          "day": "2026-11-04",
          "time": "10:00",
          "start_label": "10:00 a. m."
        }
      }
    ]
  },
  "slots": "[] (0 slots)"
}
```

### 2. Varios días

```json
{
  "explanation": {
    "version": 1,
    "staff": [
      {
        "staff_id": "<id-2>",
        "staff_name": "Falla",
        "status": "unavailable",
        "summary": "absence",
        "public_reason": "vacation",
        "public_reason_label": "Vacaciones",
        "customer_message": "Falla está de vacaciones en esas fechas.",
        "next_available": {
          "start_at": "2026-11-07T15:00:00.000Z",
          "service_end_at": "2026-11-07T15:50:00.000Z",
          "day": "2026-11-07",
          "time": "10:00",
          "start_label": "10:00 a. m."
        },
        "days": "[3 días: 2026-11-04, 05, 06 — summary absence, public_reason vacation]"
      }
    ]
  }
}
```

### 3. Estado sin servicio (`/staff/status?staff=Falla&date=2026-11-04&days=4`)

```json
{
  "site": {
    "id": "<id-1>",
    "timezone": "America/Bogota"
  },
  "staff": {
    "id": "<id-2>",
    "name": "Falla",
    "takes_bookings": true
  },
  "days": [
    {
      "date": "2026-11-04",
      "status": "not_working",
      "summary": "absence",
      "public_reason": "vacation",
      "public_reason_label": "Vacaciones",
      "customer_message": "Falla está de vacaciones en esa fecha.",
      "shift": [],
      "causes": [
        {
          "code": "absence",
          "coverage": "all",
          "public_reason": "vacation"
        }
      ]
    },
    {
      "date": "2026-11-05",
      "status": "not_working",
      "summary": "absence",
      "public_reason": "vacation",
      "public_reason_label": "Vacaciones",
      "customer_message": "Falla está de vacaciones en esa fecha.",
      "shift": [],
      "causes": [
        {
          "code": "absence",
          "coverage": "all",
          "public_reason": "vacation"
        }
      ]
    },
    {
      "date": "2026-11-06",
      "status": "not_working",
      "summary": "absence",
      "public_reason": "vacation",
      "public_reason_label": "Vacaciones",
      "customer_message": "Falla está de vacaciones en esa fecha.",
      "shift": [],
      "causes": [
        {
          "code": "absence",
          "coverage": "all",
          "public_reason": "vacation"
        }
      ]
    },
    {
      "date": "2026-11-07",
      "status": "working",
      "summary": "working",
      "public_reason": null,
      "public_reason_label": null,
      "customer_message": "Falla trabaja ese día.",
      "shift": [
        {
          "from": "10:00",
          "until": "20:00"
        }
      ],
      "causes": []
    }
  ],
  "note": "Status only: whether the professional works. Bookable times depend on a service — call /availability for slots."
}
```

### 4. La misma consulta sin `explain`: contrato anterior

```json
{
  "site": {
    "id": "<id-1>",
    "timezone": "America/Bogota",
    "timezone_used": "America/Bogota"
  },
  "has_availability": {
    "2026-11-04": false,
    "2026-11-05": false
  },
  "free_blocks": [],
  "slots": []
}
```

## Para el bot

- **Motivo confirmado:** usar `customer_message`, o reformular a partir de `public_reason_label` sin agregar nada que el código no diga.
- **Sin motivo confirmado:** «Falla no tiene disponibilidad para ese horario.» Nunca
  sugerir vacaciones.
- **Alternativas:** ofrecer otra fecha con el mismo profesional (`next_available`) o
  disponibilidad con otro (`alternatives`). Solo se nombran horas concretas que vengan en los
  slots o en esos campos.
- **Cambio de profesional:** no se cambia ni se reserva sin consentimiento.
- **Fechas de regreso:** no se anuncian; solo la siguiente hora reservable real.

## Despliegue

1. Migración `1803000000000_exception-public-reason.ts`. Es aditiva, y aplicarla antes del
   código es seguro.
   - La disponibilidad normal y las reservas **no** dependen de la columna nueva.
   - Solo la usan `explain=true`, `/staff/status` y los formularios al guardar.
2. Orden de migraciones: 1802 (`feature/reviews-external-fresha`) va antes que 1803. Con el
   chequeo de orden de node-pg-migrate, aplicar 1803 antes que 1802 haría fallar la 1802 después.
