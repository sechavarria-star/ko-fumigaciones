-- Clientes a los que no se les cobra.
--
-- El consorcio de Guido 1583/1585 (30-53972749-0) es un edificio del dueño:
-- se le factura pero nunca se le cobra, y figuraba como deudor. `sin_cobro`
-- lleva la leyenda que explica por que (ej. "Comisión Chasman"); si tiene
-- algo, todas sus facturas, tambien las que vengan, cuentan como pagas: el
-- saldo da 0 en el tablero y en los mails, y la leyenda se muestra en el
-- panel.
--
-- Se puede correr mas de una vez.

alter table ko.clientes
  add column if not exists sin_cobro text;

comment on column ko.clientes.sin_cobro is
  'Si tiene texto, al cliente no se le cobra (sus facturas cuentan como pagas) y el texto es la leyenda que se muestra. Null = cliente normal.';

update ko.clientes
set sin_cobro = 'Comisión Chasman'
where cuit = '30539727490';

-- Misma vista que en 10_mailing.sql; cambia solo que un cliente sin_cobro
-- tiene todo cobrado (saldo 0), y se agrega la columna sin_cobro al final.
-- La formula tiene su espejo en recomputar() de docs/app.js.
create or replace view ko.v_saldos_clientes with (security_invoker = on) as
with fact as (
  select f.cuit_cliente as cuit,
         sum(f.total) as facturado,
         coalesce(sum(f.total) filter (where p.factura_numero is not null), 0) as imputado
  from ko.facturas f
  left join ko.pagos p on p.factura_numero = f.numero
  where f.cuit_cliente is not null
  group by f.cuit_cliente
),
cob as (
  select cuit_cliente as cuit, sum(monto) as banco
  from ko.cobros
  group by cuit_cliente
),
calc as (
  select fact.cuit,
         fact.facturado,
         fact.imputado,
         coalesce(cob.banco, 0) as cobrado_banco,
         greatest(fact.imputado, least(coalesce(cob.banco, 0), fact.facturado)) as cobrado
  from fact
  left join cob on cob.cuit = fact.cuit
)
select c.cuit,
       c.nombre,
       c.email,
       calc.facturado,
       calc.imputado,
       calc.cobrado_banco,
       case when c.sin_cobro is not null then calc.facturado else calc.cobrado end as cobrado,
       case when c.sin_cobro is not null then 0 else calc.facturado - calc.cobrado end as saldo,
       c.sin_cobro
from calc
join ko.clientes c on c.cuit = calc.cuit;

grant select on ko.v_saldos_clientes to service_role;
revoke all on ko.v_saldos_clientes from anon, authenticated;
