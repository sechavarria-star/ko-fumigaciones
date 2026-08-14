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
# ALLOWED_EMAILS es un allowlist de "romper vidrio": estos emails son admin
# siempre, exista o no data/usuarios.json (para no poder quedar nunca afuera
# del propio sistema si el archivo de usuarios se corrompe o queda vacío).
ALLOWED_EMAILS = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

PERFILES_VALIDOS = {"admin", "supervisor", "usuario"}

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


def usuario_autorizado(authorization: str | None) -> dict:
    """Valida el login de Google y devuelve {email, nombre, apellido, perfil}."""
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
    if not payload.get("email_verified"):
        raise HTTPException(403, "Tu cuenta de Google no tiene el email verificado")

    usuarios, _ = github_store.get_json("data/usuarios.json")
    info = usuarios.get(email)

    if email in ALLOWED_EMAILS:
        return {
            "email": email,
            "nombre": info["nombre"] if info else payload.get("given_name", ""),
            "apellido": info["apellido"] if info else payload.get("family_name", ""),
            "perfil": "admin",
        }
    if info:
        return {"email": email, "nombre": info["nombre"], "apellido": info["apellido"], "perfil": info["perfil"]}
    raise HTTPException(403, "Tu cuenta no está dada de alta en KO Fumigaciones")


def requerir_perfil(usuario: dict, *perfiles_permitidos: str) -> None:
    if usuario["perfil"] not in perfiles_permitidos:
        raise HTTPException(403, "Tu perfil no tiene permiso para hacer esto")


# --- 1) confirmar pago manual (admin, supervisor) ---
@app.post("/api/pagos/confirmar")
def confirmar_pago(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
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
        "confirmado_por": usuario["email"],
        "fecha_confirmacion": body["fecha_ingreso"],
    }
    pagos.append(pago)
    github_store.put_json(
        "data/pagos.json",
        pagos,
        f"Confirma pago manual FC {body['factura_numero']} ({usuario['email']})",
        usuario["email"],
    )
    return pago


# --- 2) subir factura (admin, supervisor) ---
@app.post("/api/facturas/parse")
async def parse_factura(file: UploadFile, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    try:
        texto = pdf_extract.extraer_texto(await file.read())
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))
    draft = pdf_extract.parse_factura(texto)

    clientes, _ = github_store.get_json("data/clientes.json")
    cuit = draft.get("cuit_cliente")
    cliente = clientes.get(cuit) if cuit else None

    return {
        **draft,
        "cuit_encontrado": cliente is not None,
        "nombre_cliente": cliente["nombre"] if cliente else None,
    }


def _armar_factura(body: dict) -> dict:
    for campo in ["numero", "fecha_emision", "cuit_cliente", "total"]:
        if not body.get(campo):
            raise ValueError(f"Falta el campo {campo}")
    dia, mes, anio = body["fecha_emision"].split("/")
    return {
        "numero": body["numero"],
        "fecha_emision": body["fecha_emision"],
        "cuit_cliente": body["cuit_cliente"],
        "detalle": body.get("detalle") or "",
        "total": float(body["total"]),
        "periodo": f"{anio}-{mes}",
    }


@app.post("/api/facturas/guardar")
def guardar_factura(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    try:
        factura = _armar_factura(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    facturas, _ = github_store.get_json("data/facturas.json")
    if any(f["numero"] == factura["numero"] for f in facturas):
        raise HTTPException(409, "Ya existe una factura con ese número")

    facturas.append(factura)
    github_store.put_json(
        "data/facturas.json", facturas, f"Agrega factura {factura['numero']} ({usuario['email']})", usuario["email"]
    )
    return factura


# Carga masiva: el número de factura es la clave única. Un solo commit para
# todo el lote en vez de uno por factura (más rápido y no ensucia el historial
# con decenas de commits cuando se sube un mes entero de una).
@app.post("/api/facturas/guardar-lote")
def guardar_facturas_lote(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    entradas = body.get("facturas", [])
    if not isinstance(entradas, list) or not entradas:
        raise HTTPException(400, "No se mandó ninguna factura")

    facturas, _ = github_store.get_json("data/facturas.json")
    existentes = {f["numero"] for f in facturas}

    guardadas = []
    omitidas = []
    for entrada in entradas:
        numero = entrada.get("numero")
        try:
            factura = _armar_factura(entrada)
        except ValueError as exc:
            omitidas.append({"numero": numero, "motivo": str(exc)})
            continue
        if factura["numero"] in existentes:
            omitidas.append({"numero": factura["numero"], "motivo": "ya existe (número repetido)"})
            continue
        facturas.append(factura)
        existentes.add(factura["numero"])
        guardadas.append(factura)

    if guardadas:
        github_store.put_json(
            "data/facturas.json",
            facturas,
            f"Carga masiva: agrega {len(guardadas)} factura(s) ({usuario['email']})",
            usuario["email"],
        )
    return {"guardadas": guardadas, "omitidas": omitidas}


# --- 3) subir extracto (admin, supervisor; no se persiste el texto crudo) ---
# El match ya exige CUIT + monto exacto contra una factura pendiente, así que
# no hace falta una confirmación manual por cada uno: se concilian solos en
# un único commit. Una vez conciliada una factura dentro del lote no se
# vuelve a tocar, aunque su CUIT/monto aparezcan de nuevo en el extracto.
@app.post("/api/extractos/parse")
async def parse_extracto(file: UploadFile, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    try:
        texto = pdf_extract.extraer_texto(await file.read())
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))

    clientes, _ = github_store.get_json("data/clientes.json")
    facturas, _ = github_store.get_json("data/facturas.json")
    pagos, _ = github_store.get_json("data/pagos.json")
    cuits_ya_pagados = {p["factura_numero"] for p in pagos}
    pendientes = [f for f in facturas if f["numero"] not in cuits_ya_pagados]

    confirmadas = []
    for f in pendientes:
        cliente = clientes.get(f["cuit_cliente"])
        for h in pdf_extract.find_cuit_matches(texto, f["cuit_cliente"]):
            if h["tipo"] and f["total"] in h["importes_candidatos"]:
                confirmadas.append(
                    {
                        "factura_numero": f["numero"],
                        "cuit_cliente": f["cuit_cliente"],
                        "nombre_cliente": cliente["nombre"] if cliente else f["cuit_cliente"],
                        "monto": f["total"],
                        "origen": "auto",
                        "extracto": file.filename,
                        "tipo_movimiento": h["tipo"],
                        "fecha_aprox": h["fecha_candidata"],
                        "numero_transaccion": None,
                        "confirmado_por": usuario["email"],
                        "fecha_confirmacion": datetime.now(timezone.utc).date().isoformat(),
                    }
                )
                break  # una coincidencia por factura alcanza, no seguir buscando otras

    if confirmadas:
        pagos.extend(confirmadas)
        github_store.put_json(
            "data/pagos.json",
            pagos,
            f"Extracto {file.filename}: concilia automáticamente {len(confirmadas)} pago(s) por CUIT+monto ({usuario['email']})",
            usuario["email"],
        )

    return {
        "extracto_label": file.filename,
        "confirmadas": confirmadas,
    }


# --- 4) clientes (admin, supervisor; CUIT como clave única) ---
@app.post("/api/clientes/upsert")
def upsert_cliente(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
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
        "data/clientes.json", clientes, f"{accion} cliente {cuit} ({usuario['email']})", usuario["email"]
    )
    return clientes[cuit]


# --- 5) usuarios (solo admin; email como clave única) ---
@app.get("/api/usuarios")
def listar_usuarios(authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin")
    usuarios, _ = github_store.get_json("data/usuarios.json")
    return usuarios


@app.post("/api/usuarios/upsert")
def upsert_usuario(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin")

    email = body.get("email", "").strip().lower()
    perfil = body.get("perfil", "")
    if not email or "@" not in email:
        raise HTTPException(400, "Email inválido")
    if perfil not in PERFILES_VALIDOS:
        raise HTTPException(400, f"Perfil inválido, tiene que ser uno de: {', '.join(sorted(PERFILES_VALIDOS))}")

    usuarios, _ = github_store.get_json("data/usuarios.json")
    accion = "actualiza" if email in usuarios else "agrega"
    usuarios[email] = {
        "nombre": body.get("nombre", "").strip(),
        "apellido": body.get("apellido", "").strip(),
        "perfil": perfil,
    }
    github_store.put_json(
        "data/usuarios.json", usuarios, f"{accion} usuario {email} como {perfil} ({usuario['email']})", usuario["email"]
    )
    return usuarios[email]


# --- lectura del tablero: todo el portal, no solo las escrituras, exige login ---
@app.get("/api/data")
def obtener_datos(authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    clientes, _ = github_store.get_json("data/clientes.json")
    facturas, _ = github_store.get_json("data/facturas.json")
    pagos, _ = github_store.get_json("data/pagos.json")
    return {"clientes": clientes, "facturas": facturas, "pagos": pagos, "yo": usuario}


@app.get("/api/health")
def health():
    return {"status": "ok"}
