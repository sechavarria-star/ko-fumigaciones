"""
Extracción de texto de PDF (facturas y extractos) y los mismos parsers
regex que se usaron para el prototipo inicial (ver ../match.py).

Algunas facturas (las de este sistema de facturación en particular) no
tienen texto real adentro del PDF - son una imagen escaneada (JPEG) sin
ninguna capa de texto, así que pdfplumber/pypdf/PyMuPDF devuelven vacío
sin tirar ningún error. Para esos casos hace falta OCR de verdad: se
renderiza cada página como imagen y se manda a Google Cloud Vision.
"""
import base64
import io
import logging
import os
import re

import requests

logger = logging.getLogger("uvicorn.error")

GOOGLE_VISION_API_KEY = os.environ.get("GOOGLE_VISION_API_KEY")
VISION_API_URL = "https://vision.googleapis.com/v1/images:annotate"

AMOUNT_RE = re.compile(r"\$\s?([\d\.]+,\d{2})")
DATE_RE = re.compile(r"\b(\d{2}/\d{2}/26)\b")
MOVIMIENTO_KEYWORDS = [
    "Pago a proveedores recibido",
    "Transferencia recibida",
    "Credito transf online banking emp",
    "Crédito transf online banking emp",
    "Credito transferencia por internet",
    "Crédito transferencia por internet",
]


def extraer_texto(file_bytes: bytes) -> str:
    texto = _extraer_texto_directo(file_bytes)
    if texto and len(texto.strip()) > 20:
        return texto
    logger.info("PDF sin texto extraíble directo, probando OCR (Vision API)")
    return _extraer_texto_ocr(file_bytes)


def _extraer_texto_directo(file_bytes: bytes) -> str:
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            texto = "\n".join(page.extract_text() or "" for page in pdf.pages)
        if texto.strip():
            return texto
    except Exception as exc:
        logger.warning("pdfplumber no pudo leer el PDF: %s", exc)

    try:
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(file_bytes))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:
        logger.warning("pypdf no pudo leer el PDF: %s", exc)
        return ""


def _extraer_texto_ocr(file_bytes: bytes) -> str:
    if not GOOGLE_VISION_API_KEY:
        raise RuntimeError(
            "Este PDF no tiene texto legible directo (parece escaneado) y "
            "GOOGLE_VISION_API_KEY no está configurada para hacer OCR"
        )

    import fitz  # PyMuPDF

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    partes = []
    for page in doc:
        pix = page.get_pixmap(dpi=200)
        partes.append(_ocr_imagen(pix.tobytes("png")))
    return "\n".join(partes)


def _ocr_imagen(png_bytes: bytes) -> str:
    body = {
        "requests": [
            {
                "image": {"content": base64.b64encode(png_bytes).decode("ascii")},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
            }
        ]
    }
    res = requests.post(VISION_API_URL, params={"key": GOOGLE_VISION_API_KEY}, json=body, timeout=30)
    res.raise_for_status()
    resultado = res.json()["responses"][0]
    if "error" in resultado:
        raise RuntimeError(f"Vision API error: {resultado['error']}")
    return resultado.get("fullTextAnnotation", {}).get("text", "")


def parse_amount(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def cuit_pattern(cuit: str) -> re.Pattern:
    # El extracto a veces trae el CUIT con un espacio o un guión metido en
    # cualquier punto (ej. "3 0707681582" en vez de "30707681582", corte de
    # columna al extraer el texto del PDF) - se tolera ese ruido entre
    # cualquier par de dígitos, no solo después del primero.
    return re.compile(r"[\s-]*".join(re.escape(d) for d in cuit))


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
