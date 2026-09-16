# Diagnóstico ligero de acceso · LAN vs Tailscale vs sistema

> **Este repositorio es público.** Las direcciones concretas de la red no se escriben
> aquí: van por entorno (`W3_TS_IP`, `W3_LAN_IP`, `W3_GW_IP`, `W3_SSH`) y los valores
> por omisión son rangos de documentación. Tampoco se versionan audios ni
> transcripciones reales — ver `.gitignore`.

Dos sondas, una en cada lado. **No reproducen ninguna carga**: nada de torch, ni GPU,
ni audio. No cambian configuración, no tocan servicios ni controladores, y no escriben
fuera de su `--out`.

    # en el servidor (Linux), desde el Mac por LAN
    ssh $W3_SSH   # usuario@ip-de-lan, fuera del repositorio 'cd ~/w3-diag/watch && python3 box-watch.py \
        --out ~/w3-diag/watch/box.ndjson --pidfile ~/w3-diag/watch/box.pid \
        --daemon --every 10 --max-hours 24 --max-mb 8'

    # en el Mac — las direcciones son OBLIGATORIAS, no tienen valor por omisión
    W3_TS_IP=<ip-de-tailscale> W3_LAN_IP=<ip-de-lan> W3_GW_IP=<puerta-de-enlace> \
    python3 tools/w3/watch/mac-watch.py \
        --out ~/w3-diag-mac/mac.ndjson --pidfile ~/w3-diag-mac/mac.pid \
        --daemon --every 10 --max-hours 24 --max-mb 8

## Garantías de la sonda

* **Se para sola** a las `--max-hours` (24 por omisión) y escribe una línea `fin` con
  el motivo. No se queda corriendo indefinidamente.
* **`--daemon` de verdad**: doble bifurcación y `setsid`, así que queda con PPID 1.
  Hizo falta: `nohup ... &` sobrevive al SIGHUP pero se lo lleva el shell que lo lanzó
  al cerrarse el grupo de procesos —comprobado, murió a los dos minutos—, y el próximo
  corte va a cerrar justamente la sesión que la lanzó.
* **El PID lo escribe el propio proceso** en `--pidfile`. Capturarlo desde fuera con
  `ps` dio dos veces el PID equivocado, el intermedio de la bifurcación.
* **Registros a 0600**, siempre, también si el fichero ya existía.
* **Tope de tamaño** `--max-mb` (8 por omisión): al llegar rota a `.1`, así que nunca
  ocupa más del doble. A 10 s son unos 2,5 MB al día, o sea que no debería llegar.
* **Todas las consultas tienen tiempo máximo** — ICMP, TCP y el CLI de Tailscale—, así
  que una conexión colgada no bloquea la sonda.
* **Una muestra que falle no la tumba**: se anota `error-muestra` y sigue.
* **No registra secretos.** De Tailscale se extraen sólo nombre, estado, ruta y relevo;
  nunca el JSON completo, que lleva claves públicas y datos del nodo.

## Cómo se paran

    # servidor
    ssh $W3_SSH   # usuario@ip-de-lan, fuera del repositorio 'kill $(cat ~/w3-diag/watch/box.pid)'

    # Mac
    kill $(cat ~/w3-diag-mac/mac.pid)

Coste por muestra (cada 10 s): un paquete ICMP por destino, una conexión TCP por
destino, cuatro lecturas de `/proc` y `/sys`, y una llamada al CLI de Tailscale cada
tercera muestra.

## Por qué escriben en disco y con `fsync`

El servidor no tiene pantalla ni periféricos. Si se pierde el acceso, la única
evidencia posible es la que ya esté en su disco — y `journald` corre con
`SyncIntervalSec=5m` por defecto, así que su cola se pierde en un apagado forzado. Eso
es lo que convirtió las marcas de las 12:40:00 y las 13:03:48 en cotas inferiores en
vez de instantes. Aquí cada línea se sincroniza al escribirla, así que **la última
línea del fichero es el último instante demostrable de vida**.

## La vía de rescate, ya verificada

`ssh $W3_SSH   # usuario@ip-de-lan, fuera del repositorio` funciona y **no pasa por Tailscale**. `sshd` escucha en
`0.0.0.0:22` y el Mac está en la misma subred. Cuando se vuelva a perder el acceso, lo
primero es probar esa IP: distingue en un segundo entre «Tailscale» y «todo lo demás»,
sin esperar a leer ningún registro.

## Cómo se leen los dos ficheros juntos

Se alinean por `t`. Lo que cada combinación descarta:

| sonda del servidor | sonda del Mac | conclusión |
|---|---|---|
| viva · `link=up/1` · `gw_ms` normal · `ssh_local_ms` responde | LAN falla, Tailscale falla | **entre el Mac y el servidor** — Wi-Fi del Mac o router. El servidor no tiene nada que ver. |
| viva · todo normal | LAN **funciona**, Tailscale falla | **Tailscale**. Es el único caso que culpa a la superposición. |
| viva · `link=up/0` o `gw_ms` nulo | ambas fallan | **LAN del servidor** — cable, NIC o puerto del switch. |
| hueco con `drift_ms` alto y `wall_gap_s ≈ mono_gap_s` | ambas fallan | **el sistema se atascó estando despierto**. |
| hueco con `wall_gap_s >> mono_gap_s` | ambas fallan | **estuvo suspendido**. |
| el fichero **se corta** sin `drift` previo | ambas fallan | se detuvo o le cortaron la corriente; la última línea da la hora real. |

Ninguna de esas filas estaba distinguible con lo que había. Las paradas de hoy se
atribuyeron primero a la carga y después a la alimentación, y **ninguna de las dos
cosas está demostrada**: el apagado fue forzado desde fuera, a ciegas, tras perder SSH.

## El motivo del fallo, no solo el fallo

`ssh_*_ms` y `lan_ssh_ms`/`ts_ssh_ms` devuelven milisegundos cuando funcionan y, cuando
no, **por qué**: `rechazada`, `reset`, `timeout`, `host-inalcanzable`,
`red-inalcanzable`, `red-caida`. La distinción no es cosmética.

El primer corte de hoy devolvió `Connection reset by peer`, no un tiempo de espera
agotado. Un **reset** significa que la conexión estaba ESTABLECIDA y algo perdió su
estado — el NAT o la tabla de conexiones de un equipo intermedio, o la ruta de
Tailscale cambiando bajo los pies de la sesión. Un **timeout** es compatible con un
extremo caído. Registrar solo «funciona / no funciona» borraba justamente esa
distinción, y es la que separa «el servidor se fue» de «el camino se rompió».

Eso también explica el fichero con bytes nulos que apareció tras el primer corte: fue
una transferencia interrumpida a media escritura, no bloques sin volcar por un corte de
corriente. Un motivo menos atribuido a la alimentación.

## Dos candidatos ya descartados con los registros existentes

Los dos cortes de hoy dieron la MISMA firma: `Connection reset by peer`, no un tiempo
de espera agotado. Un reset sobre una conexión establecida apunta a pérdida de estado,
así que lo primero era mirar si alguno de los dos demonios de Tailscale se había
reiniciado. **Ninguno lo hizo:**

* Servidor: `tailscaled.service` arrancó exactamente tres veces hoy —09:46:40, 13:01:35
  y 13:54:57—, que son los tres arranques del sistema. **Cero reinicios** durante los
  cortes.
* Mac: el demonio lleva en marcha desde el **9 de septiembre a las 17:39:47**, sin
  interrupción.

Así que el túnel estaba levantado en los dos extremos, el servidor estaba vivo, su
enlace nunca cambió de estado — y aun así las conexiones establecidas se resetearon y
el par pasó a «desconectado» desde el Mac. Lo que queda por distinguir es si el camino
(Wi-Fi del Mac, router) dejó de pasar el UDP de WireGuard, o si algo perdió el estado
de ese flujo. Las sondas registran `ts_addr` y `tsd_started` en los dos lados para que
esto no haya que volver a deducirlo a posteriori.

## Lo que las sondas ya midieron, y que conviene vigilar

* **RTT del servidor CABLEADO a su puerta de enlace: 4,6–99 ms, media 15, jitter 26.**
  A sí mismo: 0,06 ms. En una LAN de gigabit por cable, el router debería contestar muy
  por debajo del milisegundo.

  **No es una conclusión.** Hacer ping a la IP del propio router mide el plano de
  control del router, y muchos equipos domésticos lo despriorizan a propósito; el
  número puede ser perfectamente benigno. Lo que sirve es que ahora queda registrado
  cada 10 s: si se degrada ANTES de la próxima pérdida de acceso, eso sí sería una
  señal; si se mantiene igual mientras el acceso se cae, queda descartado.

* **Tailscale va por ruta DIRECTA** (`<ip-de-lan>:41641`), no por relé. Consecuencia:
  un fallo de LAN o de Wi-Fi tumba las dos rutas a la vez, y Tailscale sólo sobrevive
  si consigue caer a un relé DERP — que sale por la misma Wi-Fi. Eso encaja con el
  `netcheck` y el relé nuevo que `tailscaled` registró a las 12:36:29, y es la razón
  por la que «se cayó Tailscale» y «se cayó la red» no se podían separar hasta ahora.

* **El Mac es el único tramo inalámbrico** de la cadena (`en0`, Wi-Fi, <ip-del-mac>);
  el servidor va por cable. No se estaba mirando. `mac-watch.py` registra el estado de
  la asociación y la IP para poder descartarlo o señalarlo.

  El SSID sale vacío: macOS lo restringe sin permiso de ubicación. El estado y la IP sí
  se leen, que es lo que hace falta para detectar una caída o un cambio de red.
