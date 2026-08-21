#!/usr/bin/env python3
"""
Corre el pipeline real (parse_extracto -> consolidar_extractos) contra el Web
App, mandando el texto de cada extracto ya extraido.

Se usa para ponerse al dia con extractos que se parsearon pero cuya cola de
consolidacion nunca se confirmo (quedaban como deuda falsa en el tablero).

Uso:
    python3 consolidar_extractos.py <extracto.txt> [...]        # simulacion
    python3 consolidar_extractos.py --confirmar <extracto.txt>  # escribe

Sin --confirmar solo lista lo que haria: parsea y muestra los candidatos,
pero no llama a consolidar. El texto se saca con pdf.js, igual que el
frontend (ver docs/pdftexto.js).
"""
import hashlib
import json
import os
import sys
import urllib.request

URL = ("https://script.google.com/macros/s/"
       "AKfycbxoRncX1uo-DeuwmW84fi0LI2A9Z2AmKOIAMFMo_EGMS0Oo4l6bhhhExPplQ9RvKYqN/exec")
TOKEN = open(os.path.join(os.path.dirname(__file__), ".token")).read().strip()


def llamar(action, **params):
    """Un POST text/plain; Apps Script redirige y el resultado se pide con GET."""
    cuerpo = json.dumps({"token": TOKEN, "action": action, **params}).encode()
    req = urllib.request.Request(
        URL, data=cuerpo, headers={"Content-Type": "text/plain;charset=utf-8"}
    )

    class NoRedir(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            self.destino = newurl
            return None

    h = NoRedir()
    try:
        urllib.request.build_opener(h).open(req)
    except urllib.error.HTTPError:
        pass
    with urllib.request.urlopen(h.destino) as r:
        res = json.loads(r.read())

    if res.get("status", 200) >= 400:
        raise SystemExit(f"{res['status']}: {res.get('detail')}")
    return res["data"]


def main():
    args = sys.argv[1:]
    confirmar = "--confirmar" in args
    rutas = [a for a in args if a != "--confirmar"]
    if not rutas:
        raise SystemExit(__doc__)

    # EN ORDEN CRONOLOGICO, y consolidando cada uno antes de leer el
    # siguiente. Desde que cada movimiento salda una sola factura, el parseo
    # elige "la mas vieja impaga": si se parsean los 4 extractos contra el
    # mismo estado, los 4 reclaman la MISMA factura y se pierden pagos. Hay
    # que dejar que febrero se consolide para que marzo vea la siguiente.
    MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
             "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

    def orden(ruta):
        n = os.path.basename(ruta).lower()
        for i, mes in enumerate(MESES):
            if mes in n:
                return i
        return 99

    total_conf = total_omit = 0
    monto = 0.0
    vistos = {}
    for ruta in sorted(rutas, key=orden):
        texto = open(ruta, encoding="utf-8").read()
        # Los extractos vienen del cliente y ya llegó uno duplicado (el de
        # "Mayo" era una copia byte a byte del de Abril): consolidarlo dos
        # veces no rompe nada (el UNIQUE lo frena) pero ensucia el informe.
        firma = hashlib.sha256(texto.encode()).hexdigest()
        if firma in vistos:
            print(f"  {os.path.basename(ruta)}: SALTEADO, es identico a {vistos[firma]}")
            continue
        vistos[firma] = os.path.basename(ruta)

        etiqueta = os.path.basename(ruta).replace(".txt", ".pdf")
        res = llamar("parse_extracto", texto=texto, filename=etiqueta)
        matches = res["matches"]
        for m in matches:
            m["extracto_label"] = res["extracto_label"]
        sub = sum(m["monto"] for m in matches)

        if not confirmar:
            print(f"  {etiqueta}: {len(matches)} candidato(s)  ${sub:,.2f}")
            monto += sub
            total_conf += len(matches)
            continue

        if not matches:
            print(f"  {etiqueta}: sin candidatos")
            continue
        c = llamar("consolidar_extractos", matches=matches)
        total_conf += len(c["confirmados"])
        total_omit += len(c["omitidos"])
        monto += sum(p["monto"] for p in c["confirmados"])
        print(f"  {etiqueta}: {len(c['confirmados'])} consolidado(s), "
              f"{len(c['omitidos'])} omitido(s)  ${sum(p['monto'] for p in c['confirmados']):,.2f}")

    if not confirmar:
        print(f"\nTotal (simulacion, SUBESTIMA: sin consolidar entremedio "
              f"cada extracto reclama la misma factura): {total_conf}, ${monto:,.2f}")
        print("(no se escribio nada - agregar --confirmar para consolidar)")
        return

    print(f"\nCONSOLIDADOS: {total_conf}   OMITIDOS: {total_omit}   ${monto:,.2f}")


if __name__ == "__main__":
    main()
