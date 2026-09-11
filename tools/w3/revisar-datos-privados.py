#!/usr/bin/env python3
"""Revisión de datos privados ANTES de cada push. No sustituye al criterio.

    python3 tools/w3/revisar-datos-privados.py                 # contra origin/<rama>
    python3 tools/w3/revisar-datos-privados.py BASE..HEAD      # un rango concreto

Sale con código 1 si encuentra algo, para poder encadenarlo:

    python3 tools/w3/revisar-datos-privados.py && git push origin mi-rama

── POR QUÉ EXISTE, Y QUÉ NO CUBRE ──────────────────────────────────────────

`.gitignore` evita AÑADIR ciertos ficheros. No impide lo que de verdad pasó: pegar
fragmentos de una conversación privada dentro de un test como fixture, o una IP
dentro de un comentario. Eso entra por ficheros que sí deben versionarse, y ninguna
regla de ignorado lo ve.

Esto tampoco lo resuelve del todo. Es una red de seguridad con agujeros conocidos:

  · no entiende el SIGNIFICADO. Un diálogo inventado y uno real se parecen; sólo
    detecta el vocabulario concreto que se le enseñó del caso ya conocido.
  · no sabe distinguir un marcador de una dirección real, y por eso lo correcto es
    no escribir direcciones, no añadirlas a una lista de excepciones.
  · no mira los mensajes de commit, ni los binarios, ni lo ya publicado.

La revisión sigue siendo humana. Esto sólo evita repetir los errores ya cometidos.
"""
from __future__ import annotations

import collections
import re
import subprocess
import sys

PATRONES = [
    ("credencial · cadena de conexión",
     re.compile(r"(postgres(ql)?|mysql|mongodb|redis|amqp)://[^\s\"'<>]{6,}", re.I)),
    ("credencial · token con prefijo",
     re.compile(r"\b(mtk_[A-Za-z0-9]{4,}|sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}"
                r"|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})")),
    ("credencial · clave privada",
     re.compile(r"BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY")),
    ("credencial · asignación sospechosa",
     re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token"
                r"|client[_-]?secret)\s*[=:]\s*[\"']?[^\s\"'{}$,)\]<]{8,}")),
    ("credencial · cabecera Bearer", re.compile(r"(?i)authorization\s*:\s*bearer\s+\S{10,}")),
    ("privado · IP de LAN o Tailscale",
     re.compile(r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}"
                r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
                r"|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b")),
    ("privado · ruta personal", re.compile(r"/(Users|home)/[a-z][\w.-]*")),
    ("privado · dirección MAC", re.compile(r"\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b", re.I)),
    # Vocabulario de la grabación de prueba que ya se filtró una vez. Ampliar si
    # aparece otro caso real: es una lista de lo conocido, no una detección general.
    ("contenido · grabación real",
     re.compile(r"(?i)\b(almorzar|sushi|camarones|aguacate|zanahoria|cumpleaños)\b")),
]


def rango_por_defecto() -> str:
    rama = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    return f"origin/{rama}..HEAD"


def main(argv: list[str]) -> int:
    rango = argv[1] if len(argv) > 1 else rango_por_defecto()
    try:
        diff = subprocess.run(["git", "diff", "--unified=0", rango],
                              capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError as cause:
        print(f"No pude leer el diff de {rango}: {cause}", file=sys.stderr)
        return 2

    fichero = None
    hits: dict[str, dict[str, int]] = collections.defaultdict(lambda: collections.defaultdict(int))
    for linea in diff.splitlines():
        if linea.startswith("+++ b/"):
            fichero = linea[6:]
            continue
        if not linea.startswith("+") or linea.startswith("+++"):
            continue
        for nombre, patron in PATRONES:
            # Se cuenta y se localiza; NUNCA se imprime el valor, que es justo lo que
            # no debe acabar en una consola ni en un registro de CI.
            for _ in patron.finditer(linea[1:]):
                hits[nombre][fichero or "?"] += 1

    print(f"Revisión de datos privados · {rango}")
    if not hits:
        print("  ✓ sin coincidencias. NO significa «limpio»: lee el diff igual.")
        return 0
    for nombre in sorted(hits):
        print(f"  ⚠ {nombre}: {sum(hits[nombre].values())}")
        for f, n in sorted(hits[nombre].items(), key=lambda kv: -kv[1]):
            print(f"      {n:>4}  {f}")
    print("\n  Revisa cada una. Si alguna es legítima, quita el dato — no añadas una excepción.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
