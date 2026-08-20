"""
Genera 02_datos.sql a partir de los data/*.json actuales (la fuente de
verdad hoy en GitHub). Correr una sola vez, antes del corte a Apps Script,
para dejar Supabase con una foto de los datos actuales.

No necesita ninguna credencial de Supabase - solo arma el SQL para que el
usuario lo pegue en el SQL Editor.
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent.parent
SALIDA = Path(__file__).resolve().parent / "02_datos.sql"


def sql_str(v):
    """Para columnas realmente nullable (cuit_cliente pendiente, extracto, etc.)."""
    if v is None or v == "":
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def sql_str_req(v):
    """Para columnas `not null default ''` (nombre, dirección, detalle...) -
    nunca manda null explícito, porque eso pisaría el default y rompería la
    constraint."""
    return "'" + str(v or "").replace("'", "''") + "'"


def sql_num(v):
    return "null" if v is None else repr(float(v))


def fecha_ddmmaaaa_a_iso(s):
    d, m, a = s.split("/")
    return f"{a}-{m}-{d}"


def main():
    clientes = json.loads((RAIZ / "data/clientes.json").read_text())
    facturas = json.loads((RAIZ / "data/facturas.json").read_text())
    pagos = json.loads((RAIZ / "data/pagos.json").read_text())
    usuarios = json.loads((RAIZ / "data/usuarios.json").read_text())

    out = ["begin;", ""]

    out.append("-- clientes")
    for cuit, c in clientes.items():
        out.append(
            f"insert into ko.clientes (cuit, nombre, condicion_iva, direccion, provincia) values "
            f"({sql_str(cuit)}, {sql_str_req(c.get('nombre'))}, {sql_str_req(c.get('condicion_iva'))}, "
            f"{sql_str_req(c.get('direccion'))}, {sql_str_req(c.get('provincia'))});"
        )
    out.append("")

    out.append("-- usuarios")
    for email, u in usuarios.items():
        out.append(
            f"insert into ko.usuarios (email, nombre, apellido, perfil) values "
            f"({sql_str(email)}, {sql_str_req(u.get('nombre'))}, {sql_str_req(u.get('apellido'))}, {sql_str(u.get('perfil'))});"
        )
    out.append("")

    out.append("-- facturas")
    for f in facturas:
        out.append(
            "insert into ko.facturas (numero, fecha_emision, periodo, cuit_cliente, cliente_informe, "
            "detalle, total, tipo, cuit_sugerido, nombre_sugerido) values ("
            f"{sql_str(f['numero'])}, {sql_str(fecha_ddmmaaaa_a_iso(f['fecha_emision']))}, {sql_str(f['periodo'])}, "
            f"{sql_str(f.get('cuit_cliente'))}, {sql_str(f.get('cliente_informe'))}, {sql_str_req(f.get('detalle'))}, "
            f"{sql_num(f['total'])}, {sql_str(f.get('tipo', 'FC'))}, {sql_str(f.get('cuit_sugerido'))}, "
            f"{sql_str(f.get('nombre_sugerido'))});"
        )
    out.append("")

    out.append("-- pagos")
    for p in pagos:
        out.append(
            "insert into ko.pagos (factura_numero, cuit_cliente, monto, origen, extracto, tipo_movimiento, "
            "fecha_aprox, numero_transaccion, confirmado_por, fecha_confirmacion) values ("
            f"{sql_str(p['factura_numero'])}, {sql_str(p['cuit_cliente'])}, {sql_num(p.get('monto'))}, "
            f"{sql_str(p['origen'])}, {sql_str(p.get('extracto'))}, {sql_str(p.get('tipo_movimiento'))}, "
            f"{sql_str(p.get('fecha_aprox'))}, {sql_str(p.get('numero_transaccion'))}, {sql_str(p['confirmado_por'])}, "
            f"{sql_str(p['fecha_confirmacion'])});"
        )
    out.append("")
    out.append("commit;")

    SALIDA.write_text("\n".join(out) + "\n")
    print(f"Generado {SALIDA} - {len(clientes)} clientes, {len(usuarios)} usuarios, {len(facturas)} facturas, {len(pagos)} pagos")


if __name__ == "__main__":
    main()
