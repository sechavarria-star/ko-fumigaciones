"""
Prototipo de conciliación KO Fumigaciones.

Cruza las facturas emitidas (data/facturas_abril2026.csv) contra los movimientos
de crédito de los extractos bancarios (data/extractos_raw/*.txt), usando el CUIT
del cliente como clave de cruce (el CUIT aparece embebido en la descripción del
movimiento, a veces pegado, a veces partido por un espacio tras el primer dígito).

Los .txt de data/extractos_raw/ son el texto ya extraído de los PDF de Santander
(vía la API de Google Drive, que resuelve estos PDF mejor que pypdf/pdfplumber
localmente - ver nota en el README del proyecto).
"""
import csv
import glob
import re
from pathlib import Path

BASE = Path(__file__).parent
FACTURAS_CSV = BASE / "data" / "facturas_abril2026.csv"
EXTRACTOS_DIR = BASE / "data" / "extractos_raw"

AMOUNT_RE = re.compile(r"\$\s?([\d\.]+,\d{2})")
DATE_RE = re.compile(r"\b(\d{2}/\d{2}/26)\b")
MOVIMIENTO_KEYWORDS = [
    "Pago a proveedores recibido",
    "Transferencia recibida",
    "Credito transf online banking emp",
    "Crédito transf online banking emp",
]


def parse_amount(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def load_facturas():
    with open(FACTURAS_CSV, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["total"] = float(r["total"])
    return rows


def cuit_pattern(cuit: str) -> re.Pattern:
    # el CUIT de 11 dígitos aparece pegado o partido tras el primer dígito
    return re.compile(rf"{cuit[0]}\s?{cuit[1:]}")


def find_cuit_matches(text: str, cuit: str):
    pat = cuit_pattern(cuit)
    matches = []
    for m in pat.finditer(text):
        start = max(0, m.start() - 250)
        end = min(len(text), m.end() + 150)
        window = text[start:end]
        tipo = next((k for k in MOVIMIENTO_KEYWORDS if k in window), None)
        fechas = DATE_RE.findall(window)
        importes = [parse_amount(a) for a in AMOUNT_RE.findall(window)]
        matches.append(
            {
                "tipo": tipo,
                "fecha_candidata": fechas[-1] if fechas else None,
                "importes_candidatos": importes,
                "contexto": " ".join(window.split()),
            }
        )
    return matches


def main():
    facturas = load_facturas()
    extractos = sorted(glob.glob(str(EXTRACTOS_DIR / "*.txt")))

    print(f"Facturas a conciliar: {len(facturas)}")
    print(f"Extractos disponibles: {[Path(p).stem for p in extractos]}\n")

    resultados = []
    for factura in facturas:
        cuit = factura["cuit_cliente"]
        hallazgos = []
        for path in extractos:
            text = Path(path).read_text(encoding="utf-8")
            mes = Path(path).stem
            for match in find_cuit_matches(text, cuit):
                match["extracto"] = mes
                hallazgos.append(match)

        # de los hallazgos con tipo de movimiento reconocido, buscamos si algún
        # importe candidato coincide exactamente con el total de la factura
        pago_exacto = None
        for h in hallazgos:
            if h["tipo"] and factura["total"] in h["importes_candidatos"]:
                pago_exacto = h
                break

        resultados.append(
            {
                "factura": factura,
                "hallazgos": hallazgos,
                "pago_exacto": pago_exacto,
            }
        )

    conciliadas = [r for r in resultados if r["pago_exacto"]]
    con_indicio = [r for r in resultados if not r["pago_exacto"] and r["hallazgos"]]
    sin_rastro = [r for r in resultados if not r["hallazgos"]]

    print("=" * 100)
    print(f"CONCILIADAS (CUIT + importe exacto encontrados): {len(conciliadas)}/{len(facturas)}")
    print("=" * 100)
    for r in conciliadas:
        f = r["factura"]
        h = r["pago_exacto"]
        print(
            f"  FC {f['numero_factura']:16s} {f['cliente']:32s} ${f['total']:>12,.2f}  "
            f"-> pagada en {h['extracto']} ({h['tipo']}, fecha~{h['fecha_candidata']})"
        )

    print()
    print("=" * 100)
    print(f"CON INDICIO PERO SIN IMPORTE EXACTO (revisar a mano): {len(con_indicio)}")
    print("=" * 100)
    for r in con_indicio:
        f = r["factura"]
        print(f"  FC {f['numero_factura']:16s} {f['cliente']:32s} ${f['total']:>12,.2f}")
        for h in r["hallazgos"]:
            print(f"      [{h['extracto']}] tipo={h['tipo']} importes_cerca={h['importes_candidatos']}")
            print(f"      contexto: {h['contexto'][:180]}...")

    print()
    print("=" * 100)
    print(f"SIN NINGÚN RASTRO DEL CUIT EN LOS 5 EXTRACTOS: {len(sin_rastro)}")
    print("=" * 100)
    for r in sin_rastro:
        f = r["factura"]
        print(f"  FC {f['numero_factura']:16s} {f['cliente']:32s} CUIT {f['cuit_cliente']} ${f['total']:>12,.2f}")


if __name__ == "__main__":
    main()
