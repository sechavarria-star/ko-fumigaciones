"""
Genera data/facturas.json y data/pagos.json (fuentes editables) a partir
de data/facturas_abril2026.csv y el matching contra data/extractos_raw/.

A partir de acá estos dos JSON (+ data/clientes.json) son la fuente de verdad
del sistema: el backend los va a ir actualizando por commits cuando se suban nuevas
facturas/extractos o se confirmen pagos a mano. Este script solo sirve para el
"seed" inicial (o para regenerar desde cero si hiciera falta).

Nota: estos JSON NO viven en docs/ a propósito - si estuvieran ahí GitHub Pages
los serviría como estáticos públicos, sin pasar por el login que exige el backend.
"""
import json
import glob
from pathlib import Path

from match import EXTRACTOS_DIR, load_facturas, find_cuit_matches

BASE = Path(__file__).parent
FACTURAS_OUT = BASE / "data" / "facturas.json"
PAGOS_OUT = BASE / "data" / "pagos.json"


def periodo_de(fecha_emision: str) -> str:
    # fecha_emision viene como DD/MM/AAAA
    dia, mes, anio = fecha_emision.split("/")
    return f"{anio}-{mes}"


def main():
    facturas = load_facturas()
    extractos = sorted(glob.glob(str(EXTRACTOS_DIR / "*.txt")))

    facturas_out = []
    pagos_out = []

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

        facturas_out.append(
            {
                "numero": factura["numero_factura"],
                "fecha_emision": factura["fecha_emision"],
                "cuit_cliente": cuit,
                "detalle": factura["detalle"],
                "total": factura["total"],
                "periodo": periodo_de(factura["fecha_emision"]),
            }
        )

        if pago_exacto:
            pagos_out.append(
                {
                    "factura_numero": factura["numero_factura"],
                    "cuit_cliente": cuit,
                    "monto": factura["total"],
                    "origen": "auto",
                    "extracto": pago_exacto["extracto"],
                    "tipo_movimiento": pago_exacto["tipo"],
                    "fecha_aprox": pago_exacto["fecha_candidata"],
                    "numero_transaccion": None,
                    "confirmado_por": None,
                    "fecha_confirmacion": None,
                }
            )

    FACTURAS_OUT.write_text(json.dumps(facturas_out, ensure_ascii=False, indent=2), encoding="utf-8")
    PAGOS_OUT.write_text(json.dumps(pagos_out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"facturas.json: {len(facturas_out)} · pagos.json: {len(pagos_out)}")


if __name__ == "__main__":
    main()
