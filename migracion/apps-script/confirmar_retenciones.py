#!/usr/bin/env python3
"""
Confirma los cobros con retencion que quedaron para revisar.

Normalmente esto se hace desde la app (Extractos > "Pagos con retencion -
revisar"), que es donde una persona los mira uno por uno. Este script hace lo
mismo desde la terminal cuando hay que procesar muchos de una.

Uso:
    python3 confirmar_retenciones.py              # lista, no escribe
    python3 confirmar_retenciones.py --confirmar  # confirma

Sin --confirmar solo muestra que haria. El candidato sale de `reconciliar`,
que corre contra los cobros ya guardados en ko.cobros - no hace falta tener
los PDF.
"""
import importlib.util
import os
import sys

_spec = importlib.util.spec_from_file_location(
    "ce", os.path.join(os.path.dirname(os.path.abspath(__file__)), "consolidar_extractos.py")
)
_ce = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ce)
llamar = _ce.llamar


def main():
    confirmar = "--confirmar" in sys.argv

    r = llamar("reconciliar")
    aprox = r.get("aproximados", [])
    if not aprox:
        print("No hay retenciones para revisar.")
        return

    print(f"Cobros revisados: {r['cobros_revisados']}")
    print(f"Retenciones candidatas: {len(aprox)}\n")

    aprox.sort(key=lambda x: -x["retencion"])
    for a in aprox:
        print(
            f"  {a['nombre_cliente'][:34]:34s} {a['factura_numero']}"
            f"  factura ${a['monto_factura']:>11,.2f}"
            f"  cobrado ${a['monto']:>11,.2f}"
            f"  retuvo ${a['retencion']:>9,.2f} ({a['porcentaje']:>5.2f}%)"
        )

    total_f = sum(a["monto_factura"] for a in aprox)
    total_r = sum(a["retencion"] for a in aprox)
    print(f"\n  facturas que se saldarian: ${total_f:,.2f}")
    print(f"  retencion total          : ${total_r:,.2f}")

    if not confirmar:
        print("\n(simulacion: no se escribio nada - agregar --confirmar)")
        return

    res = llamar("consolidar_extractos", matches=aprox)
    print(f"\nCONFIRMADOS: {len(res['confirmados'])}   OMITIDOS: {len(res['omitidos'])}")


if __name__ == "__main__":
    main()
