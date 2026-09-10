# Diagnóstico ligero de acceso · LAN vs Tailscale vs sistema

Dos sondas, una en cada lado. **No reproducen ninguna carga**: nada de torch, ni GPU,
ni audio. No cambian configuración, no tocan servicios ni controladores, y no escriben
fuera de su `--out`.

    # en el servidor (Linux)
    ssh santiagov@192.168.1.15 'cd ~/w3-diag/watch && nohup python3 box-watch.py \
        --out ~/w3-diag/watch/box.ndjson > /dev/null 2>&1 & echo lanzada'

    # en el Mac
    nohup python3 tools/w3/watch/mac-watch.py --out ~/w3-diag-mac.ndjson \
        > /dev/null 2>&1 & echo lanzada

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

`ssh santiagov@192.168.1.15` funciona y **no pasa por Tailscale**. `sshd` escucha en
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

## Lo que las sondas ya midieron, y que conviene vigilar

* **RTT del servidor CABLEADO a su puerta de enlace: 4,6–99 ms, media 15, jitter 26.**
  A sí mismo: 0,06 ms. En una LAN de gigabit por cable, el router debería contestar muy
  por debajo del milisegundo.

  **No es una conclusión.** Hacer ping a la IP del propio router mide el plano de
  control del router, y muchos equipos domésticos lo despriorizan a propósito; el
  número puede ser perfectamente benigno. Lo que sirve es que ahora queda registrado
  cada 10 s: si se degrada ANTES de la próxima pérdida de acceso, eso sí sería una
  señal; si se mantiene igual mientras el acceso se cae, queda descartado.

* **Tailscale va por ruta DIRECTA** (`192.168.1.15:41641`), no por relé. Consecuencia:
  un fallo de LAN o de Wi-Fi tumba las dos rutas a la vez, y Tailscale sólo sobrevive
  si consigue caer a un relé DERP — que sale por la misma Wi-Fi. Eso encaja con el
  `netcheck` y el relé nuevo que `tailscaled` registró a las 12:36:29, y es la razón
  por la que «se cayó Tailscale» y «se cayó la red» no se podían separar hasta ahora.

* **El Mac es el único tramo inalámbrico** de la cadena (`en0`, Wi-Fi, 192.168.1.25);
  el servidor va por cable. No se estaba mirando. `mac-watch.py` registra el estado de
  la asociación y la IP para poder descartarlo o señalarlo.

  El SSID sale vacío: macOS lo restringe sin permiso de ubicación. El estado y la IP sí
  se leen, que es lo que hace falta para detectar una caída o un cambio de red.
