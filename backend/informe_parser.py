"""
Parser del "Informe general de ventas" consolidado que exporta el sistema de
facturación de KO Fumigaciones (reemplaza a la carga de facturas una por una).

El informe no trae CUIT - solo un nombre de cliente en texto libre (ej.
"CONSORCIO: ARENALES 2264"), muy distinto de la razón social formal que
tenemos cargada en Clientes. matchear_clientes() intenta asociar cada
comprobante a un CUIT existente comparando el número de calle y las
palabras del nombre/dirección; lo que no llega a un umbral de confianza
alto queda con cuit_cliente=None para resolver a mano desde el frontend
(ver /api/facturas/confirmar-cuit en main.py).
"""
import re
import unicodedata
from collections import defaultdict

NOISE_PATTERNS = [
    re.compile(r"^KNOCKOUT FUMIGACIONES"),
    re.compile(r"^Informe general de ventas"),
    re.compile(r"^Page \d+ of \d+"),
    re.compile(r"^\d{2}/\d{2}/\d{4}$"),
    re.compile(r"^Comprobante\s+Fecha\s+Cliente"),
    re.compile(r"^\d+\)\s+KNOCKOUT FUMIGACIONES"),
    re.compile(r"^Totales de la Empresa"),
    re.compile(r"^TOTALES GENERALES:"),
]
COMPROBANTE_RE = re.compile(r"^(FC|NC)\s+(\S+)\s+(\d{2}/\d{2}/\d{2})\s+(.*)$")
MONEY_LINE_RE = re.compile(r"^(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$")
ITEM_LINE_RE = re.compile(r"^(-?[\d.]+,\d{2})\s+(\S+)\s+(.*?)\s+(\d{1,3}\.\d{2}%)\s+(-?[\d.]+,\d{2})$")
ITEM_LINE_RE_AMOUNT_FIRST = re.compile(r"^(-?[\d.]+,\d{2})\s+(\S+)\s+(.*?)\s+(-?[\d.]+,\d{2})\s+(\d{1,3}\.\d{2}%)$")

NUMBER_RE = re.compile(r"\b(\d{2,5})\b")
STOPWORDS = {
    "AV", "AVDA", "AVENIDA", "GRAL", "GENERAL", "DE", "DEL", "LA", "LAS", "LOS", "SAN", "SANTA",
    "CONSORCIO", "PROPIETARIOS", "PROPIETARIO", "PROP", "EDIFICIO", "EDIF", "CALLE", "N",
}

AUTO_ACCEPT_SCORE = 0.9
AUTO_ACCEPT_MARGIN = 0.15
SUGERIR_SCORE_MIN = 0.4


def _parse_amount(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def _is_noise(line: str) -> bool:
    return any(p.match(line) for p in NOISE_PATTERNS)


def _normalize(s: str) -> str:
    s = s.upper()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[.\-`´'\"()/#]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _tokens(s: str) -> set:
    return {t for t in _normalize(s).split() if t not in STOPWORDS and len(t) > 1 and not t.isdigit()}


def _numbers(s: str) -> set:
    return set(NUMBER_RE.findall(s))


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _strip_consorcio_prefix(s: str) -> str:
    return re.sub(r"^CONSORCIO\s*:?\s*(DE\s+PROPIETARIOS\s*)?", "", s, flags=re.IGNORECASE).strip()


def parse_informe(texto: str) -> list[dict]:
    lines = [l.strip() for l in texto.splitlines() if l.strip() and not _is_noise(l.strip())]

    blocks = []
    current = None
    for line in lines:
        m = COMPROBANTE_RE.match(line)
        if m:
            if current:
                blocks.append(current)
            current = {"tipo": m.group(1), "numero_raw": m.group(2), "fecha": m.group(3), "cliente_raw": m.group(4), "lines": []}
        elif current:
            current["lines"].append(line)
    if current:
        blocks.append(current)

    records = []
    for b in blocks:
        total = None
        detalle_parts = []
        for line in b["lines"]:
            mm = MONEY_LINE_RE.match(line)
            if mm:
                total = _parse_amount(mm.group(2))
                continue
            im = ITEM_LINE_RE.match(line) or ITEM_LINE_RE_AMOUNT_FIRST.match(line)
            detalle_parts.append(im.group(3).strip() if im else line)

        if total is None:
            continue

        numero = re.sub(r"-[AB]$", "", b["numero_raw"])
        d, m, y = b["fecha"].split("/")
        detalle = " - ".join(dict.fromkeys(p for p in detalle_parts if p))

        records.append(
            {
                "tipo": b["tipo"],
                "numero": numero,
                "fecha_emision": f"{d}/{m}/20{y}",
                "periodo": f"20{y}-{m}",
                "cliente_informe": b["cliente_raw"],
                "detalle": detalle,
                "total": total,
            }
        )
    return records


def matchear_clientes(records: list[dict], clientes: dict) -> None:
    """Completa cuit_cliente en cada record (in-place). Si la confianza no
    alcanza, cuit_cliente queda en None y se agrega cuit_sugerido/nombre_sugerido
    como ayuda para la resolución manual."""
    perfiles = {}
    numeros_a_cuits = defaultdict(set)
    for cuit, info in clientes.items():
        direccion = info.get("direccion", "") or ""
        nombre = info.get("nombre", "") or ""
        perfiles[cuit] = {
            "tokens_dir": _tokens(direccion),
            "numeros_dir": _numbers(direccion),
            "tokens_nom": _tokens(nombre),
            "numeros_nom": _numbers(nombre),
            "nombre": nombre,
        }
        for n in _numbers(direccion) | _numbers(nombre):
            numeros_a_cuits[n].add(cuit)

    for r in records:
        candidate = _strip_consorcio_prefix(r["cliente_informe"])
        cand_toks = _tokens(candidate)
        cand_nums = _numbers(candidate)

        candidatos = set()
        for n in cand_nums:
            candidatos |= numeros_a_cuits.get(n, set())
        if not candidatos:
            candidatos = set(perfiles.keys())

        scored = []
        for cuit in candidatos:
            p = perfiles[cuit]
            score_dir = _jaccard(cand_toks, p["tokens_dir"]) + (0.5 if cand_nums and (cand_nums & p["numeros_dir"]) else 0)
            score_nom = _jaccard(cand_toks, p["tokens_nom"]) + (0.5 if cand_nums and (cand_nums & p["numeros_nom"]) else 0)
            scored.append((max(score_dir, score_nom), cuit))
        scored.sort(reverse=True)

        best_score, best_cuit = scored[0] if scored else (0, None)
        second_score = scored[1][0] if len(scored) > 1 else 0

        if best_score >= AUTO_ACCEPT_SCORE and (best_score - second_score) >= AUTO_ACCEPT_MARGIN:
            r["cuit_cliente"] = best_cuit
        else:
            r["cuit_cliente"] = None
            if best_score >= SUGERIR_SCORE_MIN:
                r["cuit_sugerido"] = best_cuit
                r["nombre_sugerido"] = perfiles[best_cuit]["nombre"]
