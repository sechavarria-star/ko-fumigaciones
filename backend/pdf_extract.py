"""
Extracción de texto de PDF (facturas y extractos) y los mismos parsers
regex que se usaron para el prototipo inicial (ver ../match.py).
"""
import io
import re

KO_CUIT = "20209566061"

AMOUNT_RE = re.compile(r"\$\s?([\d\.]+,\d{2})")
DATE_RE = re.compile(r"\b(\d{2}/\d{2}/26)\b")
MOVIMIENTO_KEYWORDS = [
    "Pago a proveedores recibido",
    "Transferencia recibida",
    "Credito transf online banking emp",
    "Crédito transf online banking emp",
]


def extraer_texto(file_bytes: bytes) -> str:
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)
    except Exception:
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(file_bytes))
        return "\n".join(page.extract_text() or "" for page in reader.pages)


def parse_amount(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def parse_factura(texto: str) -> dict:
    numero_m = re.search(r"FACTURA\s*N[°ºOo]?\s*([\d\-]+)", texto)
    fecha_m = re.search(r"Fecha de emisi[oó]n:\s*(\d{2}/\d{2}/\d{4})", texto)
    cuits = re.findall(r"CUIT:\s*(\d{2}-\d{8}-\d)", texto)
    cuit_cliente = next((c.replace("-", "") for c in cuits if c.replace("-", "") != KO_CUIT), None)
    detalle_m = re.search(r"(FUMIGACI[ÓO]N.+?)(?:SON PESOS|R[ée]gimen de Transparencia)", texto, re.DOTALL)
    totales = re.findall(r"TOTAL\s*\$\s*([\d\.]+,\d{2})", texto)

    return {
        "numero": numero_m.group(1) if numero_m else None,
        "fecha_emision": fecha_m.group(1) if fecha_m else None,
        "cuit_cliente": cuit_cliente,
        "detalle": " ".join(detalle_m.group(1).split()) if detalle_m else None,
        "total": parse_amount(totales[-1]) if totales else None,
    }


def cuit_pattern(cuit: str) -> re.Pattern:
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
            }
        )
    return matches
