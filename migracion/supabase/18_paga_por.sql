-- CUIT que paga por otro cliente.
--
-- El consorcio de Av. Alvear 1592 (30-71115957-2) no paga con su CUIT: paga
-- su administracion, Costa Propiedades SA (30-70830920-2). Las facturas salen
-- a nombre del consorcio, asi que el matcheo por CUIT nunca encontraba esos
-- pagos y el consorcio figuraba con todo impago.
--
-- `paga_por` marca que un CUIT paga por otro cliente (el titular). Al leer
-- un extracto, un pago de ese CUIT se toma como del titular: se buscan las
-- facturas del titular y el cobro se le suma a el. En ko.cobros queda
-- igual quien pago de verdad, en `cuit_pagador`.
--
-- Un solo titular por CUIT: si algun dia una administracion paga por varios
-- consorcios, esto no alcanza (habria que asignar cada pago por importe).
--
-- Se puede correr mas de una vez.

alter table ko.clientes
  add column if not exists paga_por text references ko.clientes(cuit);

alter table ko.clientes drop constraint if exists clientes_paga_por_no_si_mismo;
alter table ko.clientes
  add constraint clientes_paga_por_no_si_mismo check (paga_por is null or paga_por <> cuit);

comment on column ko.clientes.paga_por is
  'Si este CUIT paga por otro cliente (ej. la administracion de un consorcio), el CUIT de ese cliente. Sus pagos se concilian contra las facturas del titular.';

alter table ko.cobros
  add column if not exists cuit_pagador text;

comment on column ko.cobros.cuit_pagador is
  'CUIT que aparece en el extracto, cuando no es el del cliente (pago por cuenta de otro, ver clientes.paga_por). Null si pago el propio cliente.';

-- Costa Propiedades SA paga por el consorcio de Av. Alvear 1592, 1598, 1600.
-- (Se habia cargado con el nombre del consorcio; en los extractos figura
-- como Costa Propiedades.)
update ko.clientes
set paga_por = '30711159572',
    nombre   = 'COSTA PROPIEDADES SA'
where cuit = '30708309202';
