# Gallery — perfiles públicos de los artistas (carga pendiente)

Estado: **preparado, sin ejecutar**. No se ha escrito nada en producción. Los textos se cargan
con el **editor de Equipo** (mecanismo editable), una vez desplegada la migración
`1800000000000_staff-public-profile.ts`. No van en el código: la página de reservas solo
muestra lo que está guardado en el perfil público de cada profesional.

## Textos aprobados

| Profesional (M_AI) | Título público | Presentación |
|---|---|---|
| Federico | Barbero profesional | Barbero profesional enfocado en encontrar un estilo que refleje tu personalidad. Cuida cada detalle con técnica, precisión y dedicación, buscando una experiencia cómoda y cercana. |
| Falla | Barbero profesional | Barbero profesional con trayectoria en el cuidado masculino. Su enfoque combina precisión, limpieza en cada trazo y respeto por el estilo personal de cada cliente, para resaltar su imagen y presencia. |

Las dos presentaciones pasan la validación (≤ 600 caracteres, sin enlaces, correos ni
teléfonos), como prueba `test/unit/staffPublicProfile.test.ts`.

Valeria (recepcionista, no recibe citas) **no** aparece en la página de reservas, tenga o no
perfil. No hay que crear ni borrar nada.

## Cómo cargarlos (cuando se autorice)

1. Con un usuario propietario o administrador del cliente Gallery: **Agenda → Equipo**
   (o la página de Staff en escritorio).
2. Abrir a **Federico** → pestaña *Details* → sección **Public profile**. En el teléfono:
   **Más opciones → Editar perfil → Perfil público**.
3. Pegar el título y la presentación de la tabla y **guardar**.
4. Repetir con **Falla**.
5. Comprobar en `/book/{slug de Gallery-93}` → paso 2: los textos aparecen en la tarjeta (primera
   frase) y en «Ver perfil» (completos).

## Fotos

Pendientes. Hasta que existan fotos reales aprobadas, la página muestra las **iniciales**
sobre un pastel discreto. Para subirlas:

- Requiere R2 configurado en el Web service (`R2_*`, el mismo bucket público de los logos).
- En la misma sección **Public profile**: «Upload photo» / «Subir foto». Se acepta JPG, PNG o
  WebP; el navegador la reduce a 1200 px y el servidor valida los bytes.
- No usar retratos que no sean del profesional, ni enlaces a Fresha u otro sitio: la URL guardada
  es siempre la del bucket propio (`https://…/staff/{tenant}/{cliente}/{profesional}/…`).
