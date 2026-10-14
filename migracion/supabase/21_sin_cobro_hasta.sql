-- "Sin cobro" hasta una fecha.
--
-- 19_sin_cobro.sql marca clientes a los que no se les cobra nunca. Hay casos
-- en que es solo por un periodo: hasta cierta fecha no se cobra, y de ahi en
-- adelante el cliente se trata normal. `sin_cobro_hasta` es esa fecha
-- (inclusive); null = para siempre, como antes.
--
-- Cuando un cliente tiene periodo sin cobro:
--   - las facturas emitidas hasta esa fecha se dan por saldadas, se hayan
--     pagado o no: el periodo cierra en 0 (aunque tenga pagos de mas o notas
--     de credito sueltas);
--   - lo que entro al banco hasta esa fecha no se usa para saldar facturas
--     posteriores (si no, la primera factura nueva figuraria paga con plata
--     vieja);
--   - despues de esa fecha, la formula de siempre.
--
-- La formula tiene su espejo en recomputar() de docs/app.js.
-- Se puede correr mas de una vez.

alter table ko.clientes
  add column if not exists sin_cobro_hasta date;

comment on column ko.clientes.sin_cobro_hasta is
  'Con sin_cobro: ultima fecha de emision (inclusive) de las facturas que no se cobran. Null = no se cobra nunca. Despues de esta fecha el cliente se trata normal.';

-- Una factura esta "exenta" si su cliente tiene leyenda de sin cobro y, si
-- hay fecha tope, se emitio hasta esa fecha.
create or replace function ko.factura_exenta(sin_cobro text, hasta date, emision date) returns boolean
language sql immutable as $$
  select sin_cobro is not null and (hasta is null or emision <= hasta)
$$;

create or replace function ko.fecha_corta(f text) returns date
language sql immutable as $$
  -- 'dd/mm/aa' de los extractos
  select case when f ~ '^\d{2}/\d{2}/\d{2}$' then to_date(f, 'DD/MM/YY') end
$$;

create or replace view ko.v_saldos_clientes with (security_invoker = on) as
with fact as (
  select f.cuit_cliente as cuit,
         sum(f.total) as facturado,
         coalesce(sum(f.total) filter (where p.factura_numero is not null or ko.factura_exenta(c.sin_cobro, c.sin_cobro_hasta, f.fecha_emision)), 0) as imputado,
         coalesce(sum(f.total) filter (where ko.factura_exenta(c.sin_cobro, c.sin_cobro_hasta, f.fecha_emision)), 0) as exento,
         coalesce(sum(f.total) filter (where not ko.factura_exenta(c.sin_cobro, c.sin_cobro_hasta, f.fecha_emision)), 0) as facturado_normal,
         coalesce(sum(f.total) filter (where p.factura_numero is not null and not ko.factura_exenta(c.sin_cobro, c.sin_cobro_hasta, f.fecha_emision)), 0) as imputado_normal
  from ko.facturas f
  join ko.clientes c on c.cuit = f.cuit_cliente
  left join ko.pagos p on p.factura_numero = f.numero
  group by f.cuit_cliente
),
cob as (
  select k.cuit_cliente as cuit,
         sum(k.monto) as banco,
         -- lo que entro despues del periodo sin cobro (todo, si no hay periodo)
         coalesce(sum(k.monto) filter (where c.sin_cobro is null
                                          or (c.sin_cobro_hasta is not null and ko.fecha_corta(k.fecha) > c.sin_cobro_hasta)), 0) as banco_normal
  from ko.cobros k
  join ko.clientes c on c.cuit = k.cuit_cliente
  group by k.cuit_cliente
),
calc as (
  select fact.cuit,
         fact.facturado,
         fact.imputado,
         fact.exento,
         fact.facturado_normal,
         coalesce(cob.banco, 0) as cobrado_banco,
         greatest(fact.imputado_normal, least(coalesce(cob.banco_normal, 0), fact.facturado_normal)) as cobrado_normal
  from fact
  left join cob on cob.cuit = fact.cuit
)
select c.cuit,
       c.nombre,
       c.email,
       calc.facturado,
       calc.imputado,
       calc.cobrado_banco,
       calc.exento + calc.cobrado_normal as cobrado,
       calc.facturado_normal - calc.cobrado_normal as saldo,
       c.sin_cobro,
       c.sin_cobro_hasta
from calc
join ko.clientes c on c.cuit = calc.cuit;

-- Las facturas que componen el saldo: igual que en 10_mailing.sql, sin las
-- exentas.
create or replace view ko.v_saldo_facturas with (security_invoker = on) as
with impagas as (
  select f.cuit_cliente as cuit,
         f.numero,
         f.fecha_emision,
         f.total,
         s.saldo,
         coalesce(sum(f.total) over (
           partition by f.cuit_cliente
           order by f.fecha_emision desc, f.numero desc
           rows between unbounded preceding and 1 preceding
         ), 0) as acumulado_antes
  from ko.facturas f
  join ko.v_saldos_clientes s on s.cuit = f.cuit_cliente
  join ko.clientes c on c.cuit = f.cuit_cliente
  left join ko.pagos p on p.factura_numero = f.numero
  where p.factura_numero is null
    and f.total > 0
    and s.saldo > 0
    and not ko.factura_exenta(c.sin_cobro, c.sin_cobro_hasta, f.fecha_emision)
)
select cuit,
       numero,
       fecha_emision,
       total,
       least(total, saldo - acumulado_antes) as pendiente,
       row_number() over (partition by cuit order by fecha_emision, numero) as orden
from impagas
where acumulado_antes < saldo;

grant select on ko.v_saldos_clientes, ko.v_saldo_facturas to service_role;
revoke all on ko.v_saldos_clientes, ko.v_saldo_facturas from anon, authenticated;

-- Que clientes tienen periodo sin cobro (y su leyenda) se carga desde la
-- pestaña Clientes o a mano: no va en este archivo porque el repo es publico.
