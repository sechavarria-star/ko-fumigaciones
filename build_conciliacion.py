"""
Genera docs/data/conciliacion.json a partir del motor de matching (match.py).

Este es el único artefacto de datos que entra al repo/frontend: contiene CUIT,
nombre de cliente, número/monto de factura y estado de pago - pero no el texto
crudo de los extractos bancarios (que tiene CBU y movimientos ajenos a KO
Fumigaciones, y se queda en Drive).
"""
import json
from datetime import datetime, timezone

from match import EXTRACTOS_DIR, load_facturas, find_cuit_matches
from pathlib import Path
import glob

BASE = Path(__file__).parent
OUT = BASE / "docs" / "data" / "conciliacion.json"


def build():
    facturas = load_facturas()
    extractos = sorted(glob.glob(str(EXTRACTOS_DIR / "*.txt")))

    clientes = {}
    resumen = {
        "cantidad_facturas": len(facturas),
        "cantidad_pagadas": 0,
        "cantidad_pendientes": 0,
        "total_facturado": 0.0,
        "total_cobrado": 0.0,
        "total_pendiente": 0.0,
    }

    for factura in facturas:
        cuit = factura["cuit_cliente"]
        hallazgos = []
        for path in extractos:
            text = Path(path).read_text(encoding="utf-8")
            mes = Path(path).stem.replace("_2026", " 2026").capitalize()
            for m in find_cuit_matches(text, cuit):
                m["extracto"] = mes
                hallazgos.append(m)

        pago_exacto = next(
            (h for h in hallazgos if h["tipo"] and factura["total"] in h["importes_candidatos"]),
            None,
        )

        estado = "pagada" if pago_exacto else "pendiente"
        registro_factura = {
            "numero": factura["numero_factura"],
            "fecha_emision": factura["fecha_emision"],
            "detalle": factura["detalle"],
            "total": factura["total"],
            "estado": estado,
            "pago": (
                {
                    "extracto": pago_exacto["extracto"],
                    "tipo_movimiento": pago_exacto["tipo"],
                    "fecha_aprox": pago_exacto["fecha_candidata"],
                }
                if pago_exacto
                else None
            ),
        }

        clientes.setdefault(
            cuit, {"cuit": cuit, "nombre": factura["cliente"], "facturas": []}
        )["facturas"].append(registro_factura)

        resumen["total_facturado"] += factura["total"]
        if estado == "pagada":
            resumen["cantidad_pagadas"] += 1
            resumen["total_cobrado"] += factura["total"]
        else:
            resumen["cantidad_pendientes"] += 1
            resumen["total_pendiente"] += factura["total"]

    clientes_list = []
    for c in clientes.values():
        total_facturado = sum(f["total"] for f in c["facturas"])
        total_pagado = sum(f["total"] for f in c["facturas"] if f["estado"] == "pagada")
        clientes_list.append(
            {
                **c,
                "total_facturado": total_facturado,
                "total_pagado": total_pagado,
                "total_pendiente": total_facturado - total_pagado,
            }
        )
    clientes_list.sort(key=lambda c: c["total_pendiente"], reverse=True)

    salida = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "periodo_facturas": "Abril 2026",
        "extractos_incluidos": [Path(p).stem.replace("_2026", " 2026").capitalize() for p in extractos],
        "resumen_global": resumen,
        "clientes": clientes_list,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(salida, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Escrito {OUT} ({len(clientes_list)} clientes, {len(facturas)} facturas)")


if __name__ == "__main__":
    build()
