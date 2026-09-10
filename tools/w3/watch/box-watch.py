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
import json
import os
import socket
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
    }
    if with_tailscale:
        row["ts"] = tailscale_state()
    return row


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--every", type=float, default=10.0, help="segundos entre muestras")
    parser.add_argument("--ts-every", type=int, default=3, help="consultar tailscale cada N muestras")
    parser.add_argument("--samples", type=int, default=0, help="0 = sin límite")
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

    count = 0
    with open(args.out, "a", encoding="utf-8") as handle:
        def emit(row: dict) -> None:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            # Sin esto, la cola del fichero se pierde igual que la de journald, y la
            # sonda no serviría para lo único que tiene que servir.
            os.fsync(handle.fileno())

        emit(header)
        scheduled = time.monotonic()
        last_wall = None
        last_mono = None
        while args.samples == 0 or count < args.samples:
            now_mono = time.monotonic()
            now_wall = time.time()
            drift = max(0.0, (now_mono - scheduled) * 1000.0)
            wall_gap = None if last_wall is None else now_wall - last_wall
            mono_gap = None if last_mono is None else now_mono - last_mono
            row = sample(
                iface, lan_ip, gw, drift, wall_gap, mono_gap,
                with_tailscale=(count % args.ts_every == 0),
            )
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
