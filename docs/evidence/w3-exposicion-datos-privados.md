# Exposición de datos privados en un repositorio público · nota y plan

**Estado: contenida en el árbol, NO en el historial.** Este documento es para
coordinarlo con el propietario del repositorio; nada de lo que propone se ha
ejecutado.

## Qué pasó

`github.com/juanpabloow/mai_observation_platform_mvp` es **público**. Entre el 10 de
septiembre y esa misma tarde se publicaron en él, en 19 commits:

* **Fragmentos literales de una conversación privada real** — 29 líneas en 4
  ficheros, usados como fixtures de prueba y como cita en un documento de evidencia.
  Es la parte grave: son datos personales de un tercero que no consintió.
* Direcciones de una red privada (Tailscale y LAN), el usuario SSH del servidor y
  rutas de sistema de dos máquinas concretas.

**No se publicó ninguna credencial.** Ninguna cadena de conexión, token, clave
privada ni asignación de secreto. Verificado por barrido del diff completo.

Los identificadores de reunión, tenant y cliente **ya eran públicos** antes: estaban
en `docs/meetings-w3-handoff-diarizacion.md`, del commit `5dd6082`.

## Qué ya está hecho

Commit `e23e7b4`, publicado con un push normal:

* Los fragmentos de la grabación se sustituyeron por un diálogo **sintético** que
  ejercita exactamente los mismos casos — mismo número de palabras, mismos tiempos,
  misma estructura. Ninguna prueba se debilitó.
* En la evidencia la cita **se retiró**, no se sustituyó por una inventada: falsear
  una cita en un documento que reporta una medición real sería peor que la fuga.
* Direcciones y rutas salen por entorno (`W3_TS_IP`, `W3_LAN_IP`, `W3_GW_IP`,
  `W3_DIAG`, `W3_WORKER`). La sonda del Mac **se niega a arrancar** sin ellas, en vez
  de usar un marcador: un marcador no se distingue de una dirección real ni a ojo ni
  con un revisor automático.
* `.gitignore` excluye audio, NDJSON y volcados de transcripción.
* `tools/w3/revisar-datos-privados.py` revisa el diff antes de cada push.

**Nada de esto toca el historial.** Los 19 commits siguen conteniendo los fragmentos y
seguirán siendo accesibles mientras el repositorio sea público.

## Lo que falta, por orden de eficacia

### 1 · Decidir la visibilidad del repositorio — lo único que corta la exposición ya

Ponerlo en privado no requiere tocar nada y detiene la indexación y el acceso
anónimo. Con **0 forks**, la ventana ha sido corta. Es reversible.

Decisión del propietario, no de quien escribe esto.

### 2 · Limpiar los dos documentos anteriores a esta sesión

Conservan datos de red de antes del incidente:

| fichero | qué contiene |
|---|---|
| `docs/meetings-w3-handoff-diarizacion.md` | IP de Tailscale, `usuario@host` SSH, rutas |
| `docs/meetings-technical-design.md` | direcciones de red |

Se limpian igual que el resto —marcadores y variables de entorno— en un commit
aparte. **Preparado, no aplicado**: no se toca sin acordarlo, porque el handoff es un
documento de referencia que otras personas pueden estar leyendo.

### 3 · Retirada del historial

Sólo si se quiere el historial limpio. Es la parte que exige coordinación, porque
**reescribe SHAs publicados**.

**Antes de empezar, hay que saber esto:**

* Reescribir cambia el SHA de todos los commits afectados. Cualquiera que tenga la
  rama clonada tendrá que rehacer su copia; los enlaces a commits o líneas concretas
  dejarán de resolver.
* Railway despliega desde esta rama. Un force-push con la rama desplegada puede
  disparar un despliegue del árbol reescrito. Conviene pausar el despliegue
  automático primero.
* **GitHub NO borra los objetos al instante.** Un commit reescrito sigue siendo
  accesible por su SHA hasta que GitHub recolecta. Hay que **pedírselo a soporte de
  GitHub** explícitamente; si no, el paso 3 da una falsa sensación de limpieza.
* Si el repositorio tuviera forks, los objetos viven también allí. Hoy son 0, y por
  eso este es el momento menos malo.

**Procedimiento propuesto** (a ejecutar por el propietario, o con su visto bueno):

    # 0. pausar el despliegue automático de Railway en esta rama
    # 1. copia de seguridad, por si acaso
    git branch respaldo/t3-antes-de-reescribir e23e7b4
    git push origin respaldo/t3-antes-de-reescribir   # en un repositorio PRIVADO, no aquí

    # 2. reescribir (git-filter-repo, no filter-branch)
    #    Sustituye los fragmentos por el texto sintético que ya está en e23e7b4.
    git filter-repo --replace-text reemplazos.txt --refs 5dd6082..t3/meetings-ui

    # 3. revisar el resultado ANTES de publicar
    python3 tools/w3/revisar-datos-privados.py 5dd6082..t3/meetings-ui

    # 4. publicar, y avisar a quien tenga la rama clonada
    git push --force-with-lease origin t3/meetings-ui

    # 5. pedir a soporte de GitHub la recolección de los objetos huérfanos
    # 6. reanudar el despliegue de Railway

`--force-with-lease` y no `--force`: aborta si alguien publicó algo mientras tanto,
en vez de pisarlo.

### 4 · Decidir qué grabación se usa para probar

`cc00c4cf-a69f-46a3-acf7-f22e90fed109` es una conversación privada real. Su
transcripción vive en staging, que es lo correcto — pero conviene decidir si las
pruebas futuras usan una grabación hecha a propósito. Afecta a cualquier reproceso.

## La lección, escrita para que quede

El fallo no fue de configuración: fue **pegar datos reales en un fixture** porque
eran los que tenía a mano. `.gitignore` no protege de eso — evita añadir ficheros, no
copiar contenido dentro de ficheros que sí deben versionarse. Lo que protege es
generar los fixtures sintéticos desde el principio, y revisar el diff antes de
publicar.
