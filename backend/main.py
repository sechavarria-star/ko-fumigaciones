import logging
import os
from datetime import date, datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

import github_store
import pdf_extract

logger = logging.getLogger("uvicorn.error")

GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
ALLOWED_EMAILS = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

app = FastAPI(title="KO Fumigaciones - backend admin")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Starlette solo agrega los headers de CORS a las respuestas que salen por el
# camino normal de la app. Si algo tira una excepción no controlada (ValueError
# aparte), la respuesta de error sale por fuera de CORSMiddleware, sin esos
# headers - y el navegador lo reporta como "bloqueado por CORS" en vez de
# mostrar el 500 real, que es mucho más difícil de diagnosticar. Este handler
# evita eso: cualquier excepción no prevista sigue devolviendo CORS ok.
@app.exception_handler(Exception)
async def excepcion_no_controlada(request: Request, exc: Exception):
    logger.exception("Error no controlado en %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"Error interno: {exc}"})


_google_request = google_requests.Request()


def usuario_autorizado(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Falta el token de Google")
    token = authorization.removeprefix("Bearer ")
    try:
        payload = id_token.verify_oauth2_token(token, _google_request, GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(401, "Token de Google inválido")
    except Exception as exc:
        # ej. fallo de red del backend al pedirle a Google sus certificados
        # públicos (típico en un arranque en frío) - no es que el token esté mal.
        logger.warning("No se pudo verificar el token de Google: %s", exc)
        raise HTTPException(503, "No se pudo validar el login con Google, probá de nuevo")
    email = payload.get("email", "").lower()
    if not payload.get("email_verified") or email not in ALLOWED_EMAILS:
        raise HTTPException(403, "Tu cuenta no tiene permiso para editar KO Fumigaciones")
    return email


# --- 1) confirmar pago manual ---
@app.post("/api/pagos/confirmar")
def confirmar_pago(body: dict, authorization: str | None = Header(None)):
    email = usuario_autorizado(authorization)
    pagos, _ = github_store.get_json("data/pagos.json")

    if any(p["factura_numero"] == body["factura_numero"] for p in pagos):
        raise HTTPException(409, "Esa factura ya tiene un pago registrado")

    pago = {
        "factura_numero": body["factura_numero"],
        "cuit_cliente": body["cuit_cliente"],
        "monto": None,
        "origen": "manual",
        "extracto": None,
        "tipo_movimiento": None,
        "fecha_aprox": None,
        "numero_transaccion": body["numero_transaccion"],
        "confirmado_por": email,
        "fecha_confirmacion": body["fecha_ingreso"],
    }
    pagos.append(pago)
    github_store.put_json(
        "data/pagos.json",
        pagos,
        f"Confirma pago manual FC {body['factura_numero']} ({email})",
        email,
    )
    return pago


# --- 2) subir factura ---
@app.post("/api/facturas/parse")
async def parse_factura(file: UploadFile, authorization: str | None = Header(None)):
    usuario_autorizado(authorization)
    texto = pdf_extract.extraer_texto(await file.read())
    draft = pdf_extract.parse_factura(texto)

    clientes, _ = github_store.get_json("data/clientes.json")
    cuit = draft.get("cuit_cliente")
    cliente = clientes.get(cuit) if cuit else None

    return {
        **draft,
        "cuit_encontrado": cliente is not None,
        "nombre_cliente": cliente["nombre"] if cliente else None,
    }


@app.post("/api/facturas/guardar")
def guardar_factura(body: dict, authorization: str | None = Header(None)):
    email = usuario_autorizado(authorization)
    for campo in ["numero", "fecha_emision", "cuit_cliente", "total"]:
        if not body.get(campo):
            raise HTTPException(400, f"Falta el campo {campo}")

    facturas, _ = github_store.get_json("data/facturas.json")
    if any(f["numero"] == body["numero"] for f in facturas):
        raise HTTPException(409, "Ya existe una factura con ese número")

    dia, mes, anio = body["fecha_emision"].split("/")
    factura = {
        "numero": body["numero"],
        "fecha_emision": body["fecha_emision"],
        "cuit_cliente": body["cuit_cliente"],
        "detalle": body.get("detalle") or "",
        "total": float(body["total"]),
        "periodo": f"{anio}-{mes}",
    }
    facturas.append(factura)
    github_store.put_json(
        "data/facturas.json", facturas, f"Agrega factura {factura['numero']} ({email})", email
    )
    return factura


# --- 3) subir extracto (no se persiste el texto crudo, solo los matches) ---
@app.post("/api/extractos/parse")
async def parse_extracto(file: UploadFile, authorization: str | None = Header(None)):
    usuario_autorizado(authorization)
    texto = pdf_extract.extraer_texto(await file.read())

    clientes, _ = github_store.get_json("data/clientes.json")
    facturas, _ = github_store.get_json("data/facturas.json")
    pagos, _ = github_store.get_json("data/pagos.json")
    cuits_ya_pagados = {p["factura_numero"] for p in pagos}
    pendientes = [f for f in facturas if f["numero"] not in cuits_ya_pagados]

    matches = []
    for f in pendientes:
        cliente = clientes.get(f["cuit_cliente"])
        for h in pdf_extract.find_cuit_matches(texto, f["cuit_cliente"]):
            if h["tipo"] and f["total"] in h["importes_candidatos"]:
                matches.append(
                    {
                        "factura_numero": f["numero"],
                        "cuit_cliente": f["cuit_cliente"],
                        "nombre_cliente": cliente["nombre"] if cliente else f["cuit_cliente"],
                        "monto": f["total"],
                        "tipo_movimiento": h["tipo"],
                        "fecha_aprox": h["fecha_candidata"],
                    }
                )

    return {
        "extracto_label": file.filename,
        "matches": matches,
    }


@app.post("/api/extractos/confirmar-match")
def confirmar_match(body: dict, authorization: str | None = Header(None)):
    email = usuario_autorizado(authorization)
    pagos, _ = github_store.get_json("data/pagos.json")

    if any(p["factura_numero"] == body["factura_numero"] for p in pagos):
        raise HTTPException(409, "Esa factura ya tiene un pago registrado")

    pago = {
        "factura_numero": body["factura_numero"],
        "cuit_cliente": body["cuit_cliente"],
        "monto": body["monto"],
        "origen": "auto",
        "extracto": body.get("extracto_label"),
        "tipo_movimiento": body.get("tipo_movimiento"),
        "fecha_aprox": body.get("fecha_aprox"),
        "numero_transaccion": None,
        "confirmado_por": email,
        "fecha_confirmacion": datetime.now(timezone.utc).date().isoformat(),
    }
    pagos.append(pago)
    github_store.put_json(
        "data/pagos.json",
        pagos,
        f"Confirma pago detectado en extracto para FC {body['factura_numero']} ({email})",
        email,
    )
    return pago


# --- 4) clientes (CUIT como clave única) ---
@app.post("/api/clientes/upsert")
def upsert_cliente(body: dict, authorization: str | None = Header(None)):
    email = usuario_autorizado(authorization)
    cuit = body.get("cuit", "")
    if not (cuit.isdigit() and len(cuit) == 11):
        raise HTTPException(400, "El CUIT tiene que tener 11 dígitos")

    clientes, _ = github_store.get_json("data/clientes.json")
    accion = "actualiza" if cuit in clientes else "agrega"
    clientes[cuit] = {
        "nombre": body["nombre"],
        "condicion_iva": body.get("condicion_iva", ""),
        "direccion": body.get("direccion", ""),
        "provincia": body.get("provincia", ""),
    }
    github_store.put_json(
        "data/clientes.json", clientes, f"{accion} cliente {cuit} ({email})", email
    )
    return clientes[cuit]


# --- lectura del tablero: todo el portal, no solo las escrituras, exige login ---
@app.get("/api/data")
def obtener_datos(authorization: str | None = Header(None)):
    usuario_autorizado(authorization)
    clientes, _ = github_store.get_json("data/clientes.json")
    facturas, _ = github_store.get_json("data/facturas.json")
    pagos, _ = github_store.get_json("data/pagos.json")
    return {"clientes": clientes, "facturas": facturas, "pagos": pagos}


@app.get("/api/health")
def health():
    return {"status": "ok"}
