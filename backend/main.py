import logging
import os
from datetime import date, datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

import github_store
import informe_parser
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

    def transformar(pagos):
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
        mensaje = f"Confirma pago manual FC {body['factura_numero']} ({usuario['email']})"
        return pagos, mensaje, pago

    return github_store.put_json_con_reintento("data/pagos.json", transformar, usuario["email"])


# --- 2) informe consolidado mensual de facturas ---
# Reemplaza a la carga de facturas una por una: KO exporta un PDF con los
# comprobantes del período (sin CUIT, solo nombre de cliente en texto
# libre), y esto lo matchea contra Clientes automáticamente donde puede. Se
# sube un informe por mes (no el acumulado completo cada vez), así que esto
# es un upsert por número de comprobante contra la base existente, NUNCA un
# reemplazo total - y no toca pagos.json, para no perder la conciliación ya
# hecha de meses anteriores. Si una factura ya tenía el CUIT confirmado (a
# mano o por el matcheo automático de una carga previa), ese CUIT se
# conserva aunque este informe la vuelva a traer.
@app.post("/api/facturas/importar-informe")
async def importar_informe(file: UploadFile, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    try:
        texto = pdf_extract.extraer_texto(await file.read())
    except RuntimeError as exc:
        raise HTTPException(422, str(exc))

    registros = informe_parser.parse_informe(texto)
    if not registros:
        raise HTTPException(422, "No se pudo leer ningún comprobante en ese PDF")

    clientes, _ = github_store.get_json("data/clientes.json")
    informe_parser.matchear_clientes(registros, clientes)

    def transformar(facturas_actuales):
        por_numero = {f["numero"]: f for f in facturas_actuales}
        agregadas = 0
        actualizadas = 0
        for r in registros:
            anterior = por_numero.get(r["numero"])
            factura = {
                "numero": r["numero"],
                "fecha_emision": r["fecha_emision"],
                "periodo": r["periodo"],
                "cuit_cliente": r["cuit_cliente"],
                "cliente_informe": r["cliente_informe"],
                "detalle": r["detalle"],
                "total": r["total"],
                "tipo": r["tipo"],
            }
            if anterior and anterior.get("cuit_cliente"):
                # ya estaba confirmado (a mano o de una carga anterior) - no lo pisamos
                factura["cuit_cliente"] = anterior["cuit_cliente"]
            elif r.get("cuit_sugerido"):
                factura["cuit_sugerido"] = r["cuit_sugerido"]
                factura["nombre_sugerido"] = r["nombre_sugerido"]

            if anterior:
                actualizadas += 1
            else:
                agregadas += 1
            por_numero[r["numero"]] = factura

        facturas = list(por_numero.values())
        mensaje = f"Importa informe ({file.filename}): {agregadas} factura(s) nueva(s), {actualizadas} actualizada(s) ({usuario['email']})"
        pendientes = sum(1 for f in facturas if not f["cuit_cliente"])
        resultado = {
            "agregadas": agregadas,
            "actualizadas": actualizadas,
            "total_en_base": len(facturas),
            "pendientes": pendientes,
        }
        return facturas, mensaje, resultado

    return github_store.put_json_con_reintento("data/facturas.json", transformar, usuario["email"])


# Resuelve a mano las facturas que el matcheo automático dejó sin CUIT -
# aplica el mismo CUIT a TODAS las que compartan el mismo cliente_informe
# (texto crudo del nombre en el informe), no una por una.
@app.post("/api/facturas/confirmar-cuit")
def confirmar_cuit_pendiente(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    cliente_informe = body.get("cliente_informe")
    cuit = body.get("cuit_cliente", "")
    if not cliente_informe:
        raise HTTPException(400, "Falta cliente_informe")
    if not (cuit.isdigit() and len(cuit) == 11):
        raise HTTPException(400, "El CUIT tiene que tener 11 dígitos")

    clientes, _ = github_store.get_json("data/clientes.json")
    if cuit not in clientes:
        raise HTTPException(400, "Ese CUIT no está cargado en Clientes - agregalo ahí primero")

    def transformar(facturas):
        resueltas = []
        for f in facturas:
            if f.get("cliente_informe") == cliente_informe and not f.get("cuit_cliente"):
                f["cuit_cliente"] = cuit
                f.pop("cuit_sugerido", None)
                f.pop("nombre_sugerido", None)
                resueltas.append(f)
        if not resueltas:
            raise HTTPException(404, "No hay facturas pendientes con ese nombre")
        mensaje = f"Confirma CUIT {cuit} para '{cliente_informe}' -> {len(resueltas)} factura(s) ({usuario['email']})"
        return facturas, mensaje, {"resueltas": resueltas}

    return github_store.put_json_con_reintento("data/facturas.json", transformar, usuario["email"])


# --- 3) subir extracto (admin, supervisor; no se persiste el texto crudo) ---
# Subir un extracto solo calcula candidatos (CUIT + monto exacto contra una
# factura pendiente) y no escribe nada todavía - el usuario puede subir
# varios extractos y recién mandarlos a /consolidar cuando quiera, desde el
# botón "Consolidación" del frontend, que junta los candidatos de todos los
# extractos subidos en esa sesión.
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
    # Las facturas pendientes de validar (sin CUIT, ver /importar-informe)
    # todavía no tienen con qué CUIT buscar en el extracto - se excluyen acá,
    # no por rechazo sino porque literalmente no hay nada que matchear.
    pendientes = [f for f in facturas if f["numero"] not in cuits_ya_pagados and f.get("cuit_cliente")]

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
                break  # una coincidencia por factura alcanza, no seguir buscando otras

    return {
        "extracto_label": file.filename,
        "matches": matches,
    }


# El usuario revisa la cola acumulada de candidatos (de uno o varios
# extractos) en el frontend y recién ahí dispara esto: un solo commit para
# todos los pagos seleccionados. Vuelve a chequear contra pagos.json por si
# alguna factura ya se pagó por otro camino mientras la cola esperaba.
@app.post("/api/extractos/consolidar")
def consolidar_extractos(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    matches = body.get("matches", [])
    if not matches:
        raise HTTPException(400, "No hay pagos para consolidar")

    def transformar(pagos):
        ya_pagadas = {p["factura_numero"] for p in pagos}
        confirmados = []
        omitidos = []
        vistos = set()
        for m in matches:
            numero = m.get("factura_numero")
            if numero in ya_pagadas or numero in vistos:
                omitidos.append(numero)
                continue
            vistos.add(numero)
            confirmados.append(
                {
                    "factura_numero": numero,
                    "cuit_cliente": m["cuit_cliente"],
                    "monto": m["monto"],
                    "origen": "auto",
                    "extracto": m.get("extracto_label"),
                    "tipo_movimiento": m.get("tipo_movimiento"),
                    "fecha_aprox": m.get("fecha_aprox"),
                    "numero_transaccion": None,
                    "confirmado_por": usuario["email"],
                    "fecha_confirmacion": datetime.now(timezone.utc).date().isoformat(),
                }
            )
        resultado = {"confirmados": confirmados, "omitidos": omitidos}
        if not confirmados:
            return None, "", resultado
        mensaje = f"Consolidación manual: concilia {len(confirmados)} pago(s) por CUIT+monto ({usuario['email']})"
        return pagos + confirmados, mensaje, resultado

    return github_store.put_json_con_reintento("data/pagos.json", transformar, usuario["email"])


# --- 4) clientes (admin, supervisor; CUIT como clave única) ---
@app.post("/api/clientes/upsert")
def upsert_cliente(body: dict, authorization: str | None = Header(None)):
    usuario = usuario_autorizado(authorization)
    requerir_perfil(usuario, "admin", "supervisor")
    cuit = body.get("cuit", "")
    if not (cuit.isdigit() and len(cuit) == 11):
        raise HTTPException(400, "El CUIT tiene que tener 11 dígitos")

    def transformar(clientes):
        accion = "actualiza" if cuit in clientes else "agrega"
        clientes[cuit] = {
            "nombre": body["nombre"],
            "condicion_iva": body.get("condicion_iva", ""),
            "direccion": body.get("direccion", ""),
            "provincia": body.get("provincia", ""),
        }
        mensaje = f"{accion} cliente {cuit} ({usuario['email']})"
        return clientes, mensaje, clientes[cuit]

    return github_store.put_json_con_reintento("data/clientes.json", transformar, usuario["email"])


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

    def transformar(usuarios):
        accion = "actualiza" if email in usuarios else "agrega"
        usuarios[email] = {
            "nombre": body.get("nombre", "").strip(),
            "apellido": body.get("apellido", "").strip(),
            "perfil": perfil,
        }
        mensaje = f"{accion} usuario {email} como {perfil} ({usuario['email']})"
        return usuarios, mensaje, usuarios[email]

    return github_store.put_json_con_reintento("data/usuarios.json", transformar, usuario["email"])


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
