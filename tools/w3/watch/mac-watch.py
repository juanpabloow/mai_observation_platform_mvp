#!/usr/bin/env python3
"""Sonda LIGERA en el Mac: ¿por dónde se pierde el servidor, LAN o Tailscale?

    python3 mac-watch.py --out ~/w3-diag-mac.ndjson                  # continuo
    python3 mac-watch.py --out /tmp/prueba.ndjson --samples 3         # una prueba

Es la mitad imprescindible del diagnóstico. La sonda del servidor puede decir «yo
estaba bien»; sólo ésta puede decir «y yo no te veía» — y, sobre todo, POR QUÉ RUTA
sí y por cuál no.

Mide las dos rutas por separado, que es lo que estaba sin distinguir:

  LAN        : `W3_LAN_IP` — cable del servidor, router, Wi-Fi del Mac. Sin Tailscale.
  Tailscale  : `W3_TS_IP` — la superposición, que puede caerse sola.

Y mide el estado del Wi-Fi del MAC, porque es el único tramo inalámbrico de la cadena
y hasta ahora no se estaba mirando: si el Mac cambia de punto de acceso o pierde la
asociación, se pierden LAS DOS rutas a la vez sin que el servidor tenga nada que ver.

No cambia configuración ni toca servicios. Un paquete ICMP y una conexión TCP por
destino y por muestra. Cada línea se sincroniza a disco al escribirla.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import socket
import subprocess
import time

# Las direcciones NO se escriben aquí: describen una red privada concreta, y este
# repositorio es público. Se pasan por entorno, y los valores por omisión son de
# documentación (rangos reservados), así que la sonda avisa en vez de medir algo
# equivocado si alguien la ejecuta sin configurarla.
#
#   W3_TS_IP=<ip de tailscale>  W3_LAN_IP=<ip de LAN>  python3 mac-watch.py …
# Sin valores por omisión. Un marcador tampoco vale: el que puse primero resultó ser
# el resolutor de MagicDNS de Tailscale —o sea una dirección real— y, sobre todo, un
# revisor automático no sabe distinguir un marcador de una dirección de verdad. Si no
# hay ninguna en el fichero, no hay nada que revisar y el aviso no sale en falso.
#
# Y la sonda falla en vez de medir algo equivocado: apuntar a la IP de otro devuelve
# respuestas, y su registro parece válido.
TS_IP = os.environ.get("W3_TS_IP", "")
LAN_IP = os.environ.get("W3_LAN_IP", "")
GW_IP = os.environ.get("W3_GW_IP", "")


def run(cmd: list[str], timeout: float = 3.0) -> str:
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return done.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def ping_ms(host: str, timeout_ms: int = 1500) -> float | None:
    """
    UN paquete. `-W` en macOS va en milisegundos, no en segundos como en Linux.

    `-t 2` es imprescindible y no es redundante: sin el, `ping -c 1` de macOS espera
    hasta 10 s a que llegue la respuesta aunque `-W` sea menor. Medido: con la LAN
    caida la cadencia de la sonda se degradaba de 10 s a 74 s de media y hasta 2113 s
    — o sea que perdia resolucion JUSTO cuando pasa lo que hay que medir.
    """
    out = run(["ping", "-n", "-c", "1", "-t", "2", "-W", str(timeout_ms), host],
              timeout=timeout_ms / 1000 + 2)
    for token in out.split():
        if token.startswith("time="):
            try:
                return round(float(token[5:]), 1)
            except ValueError:
                return None
    return None


# El MOTIVO del fallo, no solo el fallo. Lo aprendimos por las malas: el primer corte
# devolvio `Connection reset by peer`, no un tiempo de espera agotado, y eso cambia el
# diagnostico — un reset significa que la conexion ESTABA establecida y algo en el
# camino perdio su estado, mientras un timeout es compatible con un extremo caido.
# Registrar solo exito/fallo borraba justamente esa distincion.
_ERRNO_NAMES = {
    errno.ECONNREFUSED: "rechazada",
    errno.ECONNRESET: "reset",
    errno.ETIMEDOUT: "timeout",
    errno.EHOSTUNREACH: "host-inalcanzable",
    errno.ENETUNREACH: "red-inalcanzable",
    errno.ENETDOWN: "red-caida",
    errno.EPIPE: "tuberia-rota",
}


def _fail(cause: OSError) -> str:
    if isinstance(cause, socket.timeout):
        return "timeout"
    return _ERRNO_NAMES.get(cause.errno, f"errno-{cause.errno}")


def tcp_ms(host: str, port: int = 22, timeout_s: float = 3.0):
    """Milisegundos si conecta; si no, el MOTIVO como texto."""
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            pass
    except OSError as cause:
        return _fail(cause)
    return round((time.monotonic() - started) * 1000, 1)


def tunnel_state() -> dict:
    """
    Direccion del tunel de Tailscale y arranque de su demonio, en este lado.

    Mismo motivo que en el servidor: un reinicio del demonio o un cambio de direccion
    del tunel resetea las conexiones que lo usaban, y los dos cortes de hoy fueron
    resets. Una sola llamada a `ifconfig` y una a `ps`.
    """
    addr = None
    for line in run(["ifconfig"]).splitlines():
        token = line.strip()
        if token.startswith("inet 100."):  # el rango CGNAT que usa Tailscale
            addr = token.split()[1]
            break
    started = ""
    pid = run(["pgrep", "-n", "-f", "Tailscale.app|tailscaled"])
    if pid.isdigit():
        started = run(["ps", "-o", "lstart=", "-p", pid]).strip()
    return {"addr": addr, "daemon_started": started}


def wifi_state() -> dict:
    """Estado del único tramo inalámbrico de la cadena."""
    ifc = run(["ifconfig", "en0"])
    status = "?"
    for line in ifc.splitlines():
        if "status:" in line:
            status = line.split("status:")[1].strip()
    ssid = ""
    out = run(["networksetup", "-getairportnetwork", "en0"])
    if ":" in out:
        ssid = out.split(":", 1)[1].strip()
    ip = run(["ipconfig", "getifaddr", "en0"])
    return {"status": status, "ssid": ssid[:32], "ip": ip}


def tailscale_peer() -> dict:
    """El par tal y como lo ve ESTE lado: en línea, y por ruta directa o por relé."""
    binaries = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]
    for binary in binaries:
        out = run([binary, "status", "--json"], timeout=8)
        if not out:
            continue
        try:
            data = json.loads(out)
        except ValueError:
            continue
        result: dict = {"backend": data.get("BackendState")}
        for peer in (data.get("Peer") or {}).values():
            if "ml-server" not in (peer.get("HostName") or "").lower():
                continue
            addr = peer.get("CurAddr") or ""
            result.update({
                "online": peer.get("Online"),
                "path": "directa" if addr else ("rele" if peer.get("Relay") else "sin-ruta"),
                "addr": addr,
                "relay": peer.get("Relay") or "",
                "last_seen": peer.get("LastSeen"),
            })
            break
        return result
    return {"err": "sin CLI de tailscale"}


# Tope defensivo por linea. Nada de lo que se registra deberia acercarse; si una
# lectura devuelve algo enorme e inesperado, se escribe una nota en vez del contenido.
MAX_LINE_BYTES = 4096


def daemonize() -> None:
    """
    Doble bifurcacion + `setsid`: la sonda queda con PPID 1 y sin terminal de control.

    Hace falta porque `nohup ... &` NO basta. Comprobado: el proceso sobrevivio al
    SIGHUP pero se lo llevo el shell que lo lanzo al cerrarse el grupo de procesos, y
    la sonda murio a los dos minutos. Como el proximo corte de red va a cerrar
    justamente la sesion que la lanzo, desacoplarse de verdad no es un detalle: es el
    requisito para que la sonda esté ahí cuando ocurra.

    `macOS` no trae `setsid(1)`, asi que se hace aqui y sirve para los dos lados.
    """
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        try:
            os.dup2(devnull, fd)
        except OSError:
            pass
    if devnull > 2:
        os.close(devnull)


def open_log(path: str):
    """
    Abre el registro y lo deja en 0600 SIEMPRE, tambien si ya existia.

    No se registran secretos: de Tailscale solo se extraen nombre, estado, ruta y
    relevo, nunca el JSON completo (que lleva claves publicas y datos del nodo). Aun
    asi el fichero queda a 0600, porque una traza de red revela topologia.
    """
    handle = open(path, "a", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return handle


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--every", type=float, default=10.0)
    parser.add_argument("--ts-every", type=int, default=3)
    parser.add_argument("--samples", type=int, default=0)
    parser.add_argument(
        "--max-hours", type=float, default=24.0,
        help="Parada automatica. La sonda no se queda corriendo indefinidamente.",
    )
    parser.add_argument(
        "--max-mb", type=float, default=8.0,
        help="Tope del registro. Al llegar, rota a .1; nunca ocupa mas del doble.",
    )
    parser.add_argument(
        "--daemon", action="store_true",
        help="Desacoplarse del shell que la lanza. Imprescindible para dejarla corriendo.",
    )
    parser.add_argument("--pidfile", help="Donde escribir el PID, desde el propio proceso.")
    args = parser.parse_args(argv)

    faltan = [n for n, v in (("W3_TS_IP", TS_IP), ("W3_LAN_IP", LAN_IP), ("W3_GW_IP", GW_IP)) if not v]
    if faltan:
        raise SystemExit(
            "Faltan las direcciones a vigilar: " + ", ".join(faltan) + ".\n"
            "No tienen valor por omisión a propósito: este repositorio es público y las\n"
            "direcciones describen una red concreta. Ejemplo:\n"
            "  W3_TS_IP=<ip de tailscale> W3_LAN_IP=<ip de LAN> W3_GW_IP=<puerta de enlace> \\\n"
            "    python3 mac-watch.py --out ~/w3-diag-mac/mac.ndjson --daemon"
        )

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    if args.daemon:
        daemonize()
    if args.pidfile:
        # Lo escribe EL PROCESO, no quien lo lanza: capturarlo desde fuera con `ps` ya
        # dio dos veces el PID equivocado (el intermedio de la bifurcacion).
        with open(args.pidfile, "w", encoding="utf-8") as handle:
            handle.write(f"{os.getpid()}\n")
        try:
            os.chmod(args.pidfile, 0o600)
        except OSError:
            pass

    count = 0
    started_mono = time.monotonic()
    deadline = started_mono + args.max_hours * 3600.0
    state = {"handle": open_log(args.out)}

    if True:
        def emit(row: dict) -> None:
            line = json.dumps(row, ensure_ascii=False)
            if len(line) > MAX_LINE_BYTES:
                line = json.dumps({"t": row.get("t"), "evento": "linea-descartada",
                                   "bytes": len(line)}, ensure_ascii=False)
            handle = state["handle"]
            if handle.tell() >= args.max_mb * 1024 * 1024:
                handle.close()
                os.replace(args.out, args.out + ".1")
                try:
                    os.chmod(args.out + ".1", 0o600)
                except OSError:
                    pass
                handle = state["handle"] = open_log(args.out)
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())

        emit({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "evento": "inicio",
              "lado": "mac", "ts_ip": TS_IP, "lan_ip": LAN_IP, "gw_ip": GW_IP,
              "every_s": args.every, "pid": os.getpid()})

        scheduled = time.monotonic()
        last_wall = None
        last_mono = None
        while (args.samples == 0 or count < args.samples) and time.monotonic() < deadline:
            now_wall, now_mono = time.time(), time.monotonic()
            drift = max(0.0, (now_mono - scheduled) * 1000.0)
            # De TIC A TIC, no el hueco ocioso entre muestras: se toman al ENTRAR en la
            # iteracion. Medido de la otra forma daba 0,0 cuando la muestra tardaba mas
            # que el intervalo, que es justo el caso interesante.
            wall_gap = None if last_wall is None else round(now_wall - last_wall, 2)
            mono_gap = None if last_mono is None else round(now_mono - last_mono, 2)
            last_wall, last_mono = now_wall, now_mono
            # Una muestra que falle NO puede tumbar 24 horas de sonda: se anota el
            # fallo y se sigue.
            try:
                row = {
                    "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "drift_ms": round(drift, 1),
                    # Los mismos dos que la sonda del servidor, y por el mismo motivo:
                    # sin ellos, un hueco en el registro del Mac no distingue «la sonda
                    # tardo» de «el portatil se durmio», y esa diferencia cambia por
                    # completo como se lee una desconexion.
                    "wall_gap_s": wall_gap,
                    "mono_gap_s": mono_gap,
                    # LAN, sin Tailscale de por medio
                    "gw_ms": ping_ms(GW_IP),
                    "lan_ping_ms": ping_ms(LAN_IP),
                    "lan_ssh_ms": tcp_ms(LAN_IP),
                    # Tailscale
                    "ts_ping_ms": ping_ms(TS_IP),
                    "ts_ssh_ms": tcp_ms(TS_IP),
                    # el tramo inalámbrico
                    "wifi": wifi_state(),
                    "tunel": tunnel_state(),
                }
                if count % args.ts_every == 0:
                    row["ts"] = tailscale_peer()
            except Exception as cause:  # noqa: BLE001
                row = {
                    "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "evento": "error-muestra",
                    "tipo": type(cause).__name__,
                    "drift_ms": round(drift, 1),
                    "wall_gap_s": wall_gap,
                    "mono_gap_s": mono_gap,
                }
            emit(row)
            count += 1
            scheduled += args.every
            sleep_for = scheduled - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                scheduled = time.monotonic()

        emit({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "evento": "fin",
              "muestras": count, "horas": round((time.monotonic() - started_mono) / 3600, 3),
              "motivo": "limite de tiempo" if time.monotonic() >= deadline else "limite de muestras"})
        state["handle"].close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
