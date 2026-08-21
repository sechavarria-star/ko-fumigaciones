-- Cuenta corriente: todo lo que entro al banco, se haya podido imputar a una
-- factura o no.
--
-- El problema: hay clientes que dejan pasar dos o tres meses y despues pagan
-- todo junto en una transferencia. Ese importe no coincide con ninguna
-- factura, asi que el matcheo por importe no lo encuentra y el tablero lo
-- muestra como deuda, aunque el arqueo con el cliente cierre.
--
-- Medido sobre los 7 extractos: entraron $90.038.835,79 de clientes
-- identificados, pero solo $66.586.830,18 se pudieron atar a una factura.
-- Los $23.452.005 de diferencia se mostraban como deuda inexistente.
--
-- `ko.pagos` sigue siendo la IMPUTACION (que factura quedo saldada). Esta
-- tabla es el HECHO BANCARIO: cuanto entro, de quien y cuando. El saldo del
-- cliente sale de restar esto a lo facturado, asi que cierra aunque no se
-- haya podido imputar factura por factura.

create table if not exists ko.cobros (
  id            bigint generated always as identity primary key,
  cuit_cliente  text not null references ko.clientes(cuit),
  monto         numeric(14,2) not null check (monto > 0),
  fecha         text not null,              -- dd/mm/aa, tal cual el extracto
  tipo_movimiento text not null default '',
  extracto      text not null default '',

  -- Un mismo movimiento no se puede cargar dos veces aunque se vuelva a
  -- subir el extracto. El `orden` distingue dos movimientos identicos del
  -- mismo cliente, mismo dia y mismo importe dentro del mismo resumen.
  firma         text not null unique,
  orden         int not null default 0,

  creado_en     timestamptz not null default now()
);

create index if not exists cobros_cuit_idx on ko.cobros(cuit_cliente);

alter table ko.cobros enable row level security;

grant usage on schema ko to service_role;
grant all privileges on ko.cobros to service_role;
grant all privileges on all sequences in schema ko to service_role;
