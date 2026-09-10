#!/usr/bin/env python3
"""Sonda LIGERA en el Mac: ¿por dónde se pierde el servidor, LAN o Tailscale?

    python3 mac-watch.py --out ~/w3-diag-mac.ndjson                  # continuo
    python3 mac-watch.py --out /tmp/prueba.ndjson --samples 3         # una prueba

Es la mitad imprescindible del diagnóstico. La sonda del servidor puede decir «yo
estaba bien»; sólo ésta puede decir «y yo no te veía» — y, sobre todo, POR QUÉ RUTA
sí y por cuál no.

Mide las dos rutas por separado, que es lo que estaba sin distinguir:

  LAN        : 192.168.1.15 — cable del servidor, router, Wi-Fi del Mac. Sin Tailscale.
  Tailscale  : 100.103.187.118 — la superposición, que puede caerse sola.

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

TS_IP = "100.103.187.118"
LAN_IP = "192.168.1.15"


def run(cmd: list[str], timeout: float = 5.0) -> str:
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return done.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def ping_ms(host: str, timeout_ms: int = 1500) -> float | None:
    """UN paquete. `-W` en macOS va en milisegundos, no en segundos como en Linux."""
    out = run(["ping", "-n", "-c", "1", "-W", str(timeout_ms), host], timeout=timeout_ms / 1000 + 2)
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
        if token.startswith("inet 100."):
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--every", type=float, default=10.0)
    parser.add_argument("--ts-every", type=int, default=3)
    parser.add_argument("--samples", type=int, default=0)
    args = parser.parse_args(argv)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    count = 0
    with open(args.out, "a", encoding="utf-8") as handle:
        def emit(row: dict) -> None:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

        emit({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "evento": "inicio",
              "lado": "mac", "ts_ip": TS_IP, "lan_ip": LAN_IP,
              "every_s": args.every, "pid": os.getpid()})

        scheduled = time.monotonic()
        while args.samples == 0 or count < args.samples:
            drift = max(0.0, (time.monotonic() - scheduled) * 1000.0)
            row = {
                "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "drift_ms": round(drift, 1),
                # LAN, sin Tailscale de por medio
                "gw_ms": ping_ms("192.168.1.1"),
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
            emit(row)
            count += 1
            scheduled += args.every
            sleep_for = scheduled - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                scheduled = time.monotonic()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
