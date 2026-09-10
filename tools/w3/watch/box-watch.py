#!/usr/bin/env python3
"""Sonda LIGERA en el servidor: ¿está viva, ve su LAN, y qué dice Tailscale?

    python3 box-watch.py --out ~/w3-diag/watch/box.ndjson            # continuo
    python3 box-watch.py --out /tmp/prueba.ndjson --samples 3         # una prueba

QUÉ ES Y QUÉ NO ES
------------------
No reproduce ninguna carga: nada de torch, nada de GPU, nada de audio. Por muestra
hace un ping de UN paquete a la puerta de enlace, dos conexiones TCP locales, y lee
cuatro ficheros de /proc y /sys. No cambia configuración, no toca servicios ni
controladores, y no escribe fuera de --out.

POR QUÉ ESCRIBE EN DISCO Y CON fsync
------------------------------------
El servidor no tiene pantalla: si se pierde el acceso, la única evidencia posible es
la que ya esté en su disco. Y journald corre con `SyncIntervalSec=5m` por defecto, así
que su cola se pierde en un corte. Aquí cada línea se sincroniza al escribirla, de modo
que la última línea del fichero es el último instante DEMOSTRABLE de vida — no una cota
inferior de hasta cinco minutos.

LAS TRES CAPAS QUE SEPARA
-------------------------
  respuesta del sistema : `drift_ms` — cuánto se retrasó este tic respecto de su hora.
                          Un bloqueo se ve como un drift grande; una parada, como un
                          fichero que se corta. Distinguirlos era imposible hasta ahora.
  LAN                   : `link` (operstate/carrier del interfaz) y `gw_ms` (ping a la
                          puerta de enlace). Capa 1 y capa 3, por separado.
  Tailscale             : `ts` — estado del backend y si el par se ve por ruta DIRECTA
                          o por relé. Se consulta cada 3 muestras: es lo único que
                          invoca un binario externo.

Y `ssh_local_ms` / `ssh_lan_ms` contestan la pregunta que de verdad importaba: si sshd
sigue aceptando conexiones cuando yo ya no puedo llegar. Si acepta en 127.0.0.1 y en su
IP de LAN mientras desde fuera no se llega, el problema no está en el servidor.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import socket
import struct
import subprocess
import sys
import time


def read(path: str, default: str = "") -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return default


def default_gateway() -> tuple[str, str]:
    """(interfaz, ip) de la ruta por omisión, leídos de /proc/net/route."""
    for line in read("/proc/net/route").splitlines()[1:]:
        parts = line.split()
        if len(parts) > 2 and parts[1] == "00000000":
            raw = parts[2]
            octets = [str(int(raw[i : i + 2], 16)) for i in (6, 4, 2, 0)]
            return parts[0], ".".join(octets)
    return "", ""


def ping_ms(host: str, timeout_s: int = 1) -> float | None:
    """UN paquete. None si no responde; no distingue el motivo, y no pretende hacerlo."""
    if not host:
        return None
    started = time.monotonic()
    try:
        done = subprocess.run(
            ["ping", "-n", "-c", "1", "-W", str(timeout_s), host],
            capture_output=True, timeout=timeout_s + 2, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return round((time.monotonic() - started) * 1000, 1)


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


def tcp_ms(host: str, port: int, timeout_s: float = 3.0, expect_banner: bool = False):
    """
    Conecta, opcionalmente lee el saludo, y cierra. No autentica NADA.

    Devuelve milisegundos si funciona; si no, el MOTIVO como texto.
    """
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout_s) as sock:
            if expect_banner:
                sock.settimeout(timeout_s)
                if not sock.recv(64):
                    return "sin-saludo"
    except OSError as cause:
        return _fail(cause)
    return round((time.monotonic() - started) * 1000, 1)


def tailscaled_started() -> int | None:
    """
    Momento de arranque de tailscaled, en tics desde el arranque del sistema.

    Sin subprocesos: se lee de /proc. Si este numero CAMBIA entre dos muestras,
    tailscaled se reinicio — y un reinicio del demonio reconfigura el tunel y resetea
    las conexiones que iban por el. Los dos cortes de hoy dieron `Connection reset by
    peer`, asi que distinguir «el demonio se reinicio» de «el camino se rompio» dejo de
    ser un detalle.
    """
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            if read(f"/proc/{entry}/comm") != "tailscaled":
                continue
            fields = read(f"/proc/{entry}/stat").rsplit(") ", 1)
            if len(fields) != 2:
                return None
            return int(fields[1].split()[19])
    except OSError:
        return None
    return None


def iface_addr(name: str) -> str | None:
    """
    Direccion IPv4 del interfaz, por ioctl. Tambien sin subprocesos.

    Si `tailscale0` pierde o cambia su direccion, las conexiones que la usaban se
    rompen aunque el proceso siga vivo. Es la otra mitad de la pregunta anterior.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        packed = fcntl.ioctl(
            sock.fileno(), 0x8915, struct.pack("256s", name.encode()[:15])  # SIOCGIFADDR
        )
        return socket.inet_ntoa(packed[20:24])
    except OSError:
        return None
    finally:
        sock.close()


def tailscale_state() -> dict:
    """
    Estado del backend y la RUTA al par. `CurAddr` no vacío = directa; vacío con
    `Relay` = por relé DERP, que es la señal de que la ruta directa se cayó.
    """
    try:
        done = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=8, check=False,
        )
        if done.returncode != 0:
            return {"err": (done.stderr or "").strip()[:120] or f"rc={done.returncode}"}
        data = json.loads(done.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as cause:
        return {"err": f"{type(cause).__name__}"}

    out: dict = {
        "backend": data.get("BackendState"),
        "self_online": (data.get("Self") or {}).get("Online"),
    }
    peers = []
    for peer in (data.get("Peer") or {}).values():
        addr = peer.get("CurAddr") or ""
        peers.append({
            "host": (peer.get("HostName") or "")[:24],
            "online": peer.get("Online"),
            "path": "directa" if addr else ("rele" if peer.get("Relay") else "sin-ruta"),
            "addr": addr,
            "relay": peer.get("Relay") or "",
        })
    out["peers"] = peers
    return out


def sample(
    iface: str,
    lan_ip: str,
    gw: str,
    drift_ms: float,
    wall_gap_s,
    mono_gap_s,
    with_tailscale: bool,
) -> dict:
    uptime = read("/proc/uptime").split()
    loads = read("/proc/loadavg").split()
    mem_avail = None
    for line in read("/proc/meminfo").splitlines():
        if line.startswith("MemAvailable:"):
            mem_avail = int(line.split()[1]) // 1024
            break
    procs_running = None
    for line in read("/proc/stat").splitlines():
        if line.startswith("procs_running"):
            procs_running = int(line.split()[1])
            break

    row = {
        "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        # RESPUESTA DEL SISTEMA
        #
        # `drift_ms` es cuanto se retraso este tic respecto de su hora prevista. Con la
        # maquina sana ronda cero. Un bloqueo lo dispara a miles.
        "drift_ms": round(drift_ms, 1),
        # Y estos dos separan BLOQUEO de SUSPENSION, que se parecen en el hueco que
        # dejan y en nada mas. CLOCK_MONOTONIC no avanza mientras el sistema esta
        # suspendido y el reloj de pared si, asi que:
        #   wall ~= mono, ambos grandes -> estuvo despierto y atascado
        #   wall >> mono                -> estuvo suspendido
        "wall_gap_s": None if wall_gap_s is None else round(wall_gap_s, 2),
        "mono_gap_s": None if mono_gap_s is None else round(mono_gap_s, 2),
        "up_s": int(float(uptime[0])) if uptime else None,
        "load1": float(loads[0]) if loads else None,
        "mem_avail_mb": mem_avail,
        "procs_running": procs_running,
        # LAN
        "link": f"{read(f'/sys/class/net/{iface}/operstate', '?')}/{read(f'/sys/class/net/{iface}/carrier', '?')}",
        "gw": gw,
        "gw_ms": ping_ms(gw),
        # sshd, independiente de la ruta de fuera
        "ssh_local_ms": tcp_ms("127.0.0.1", 22, expect_banner=True),
        "ssh_lan_ms": tcp_ms(lan_ip, 22) if lan_ip else None,
        # El tunel: si estos dos cambian, las conexiones que iban por el se rompen
        # aunque nada mas falle. Es la lectura que faltaba para explicar un reset.
        "ts_addr": iface_addr("tailscale0"),
        "tsd_started": tailscaled_started(),
    }
    if with_tailscale:
        row["ts"] = tailscale_state()
    return row


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
    parser.add_argument("--every", type=float, default=10.0, help="segundos entre muestras")
    parser.add_argument("--ts-every", type=int, default=3, help="consultar tailscale cada N muestras")
    parser.add_argument("--samples", type=int, default=0, help="0 = sin límite")
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

    iface, gw = default_gateway()
    lan_ip = ""
    if iface:
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect((gw or "192.168.1.1", 9))
            lan_ip = probe.getsockname()[0]
            probe.close()
        except OSError:
            lan_ip = ""

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    header = {
        "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "evento": "inicio",
        "iface": iface, "lan_ip": lan_ip, "gw": gw,
        "every_s": args.every, "pid": os.getpid(),
        "boot_id": read("/proc/sys/kernel/random/boot_id"),
    }

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
            # Sin esto, la cola del fichero se pierde igual que la de journald, y la
            # sonda no serviría para lo único que tiene que servir.
            os.fsync(handle.fileno())

        emit(header)
        scheduled = time.monotonic()
        last_wall = None
        last_mono = None
        while (args.samples == 0 or count < args.samples) and time.monotonic() < deadline:
            now_mono = time.monotonic()
            now_wall = time.time()
            drift = max(0.0, (now_mono - scheduled) * 1000.0)
            wall_gap = None if last_wall is None else now_wall - last_wall
            mono_gap = None if last_mono is None else now_mono - last_mono
            # Una muestra que falle NO puede tumbar 24 horas de sonda: se anota el
            # fallo y se sigue. Perder una muestra es un hueco de 10 s; perder la sonda
            # es perder el proximo corte, que es lo unico que interesa medir.
            try:
                row = sample(
                    iface, lan_ip, gw, drift, wall_gap, mono_gap,
                    with_tailscale=(count % args.ts_every == 0),
                )
            except Exception as cause:  # noqa: BLE001
                row = {
                    "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "evento": "error-muestra",
                    "tipo": type(cause).__name__,
                    "drift_ms": round(drift, 1),
                }
            emit(row)
            last_wall, last_mono = now_wall, now_mono
            count += 1
            scheduled += args.every
            sleep_for = scheduled - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                # Vamos tarde. No se recupera el tiempo perdido acumulando tics: se
                # reengancha a la rejilla y el retraso queda escrito en `drift_ms` de
                # la muestra siguiente, que es el dato que interesa.
                scheduled = time.monotonic()

        emit({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "evento": "fin",
              "muestras": count, "horas": round((time.monotonic() - started_mono) / 3600, 3),
              "motivo": "limite de tiempo" if time.monotonic() >= deadline else "limite de muestras"})
        state["handle"].close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
