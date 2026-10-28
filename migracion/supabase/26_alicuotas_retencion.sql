-- Alicuotas de retencion y su efecto en el saldo.
--
-- Los clientes agentes de retencion transfieren menos que la factura: el
-- resto lo depositan al fisco por cuenta de KO y es credito fiscal. Para los
-- clientes con algun tipo tildado (Clientes > pop-up), la plata del banco que
-- todavia no esta atada a una factura se reparte de la factura impaga mas
-- vieja a la mas nueva, y cada factura se cancela con lo que deberia
-- transferir: factura - sus retenciones. Esa factura cuenta entera en el
-- haber (lo transferido + las retenciones).
--
-- Retencion de una factura = suma, por cada tipo tildado, de
--   base = total (o neto sin IVA = total / 1,21 si `sobre_neto`)
--   r    = (base - minimo_no_imponible) * porcentaje, si es positivo
--   y si r < minimo_retencion, no se retiene.
--
--   IVA        13,88% del total (80% del IVA contenido en una factura al 21%)
--   IIBB AGIP   3,50% del total
--   IIBB ARBA   3,41% del total
--   Ganancias   regimen 94 (RG 830): 2% sobre el neto sin IVA que exceda
--               $67.170; si da menos de $240 no se retiene. (AFIP acumula
--               los pagos del mes; aca se calcula por factura, que para un
--               pago mensual da lo mismo.)
--
-- Lo ya imputado no cambia: un pago con retencion confirmado ya registra la
-- retencion real. Sin ningun tipo tildado: la formula de siempre.
-- La formula tiene su espejo en recomputar() de docs/app.js.
--
-- Se puede correr mas de una vez.

create table if not exists ko.alicuotas_retencion (
  tipo                 text primary key check (tipo in ('ret_iva', 'ret_iibb_arba', 'ret_iibb_agip', 'ret_ganancias')),
  nombre               text not null,
  porcentaje           numeric(6,3) not null check (porcentaje >= 0 and porcentaje < 100),
  sobre_neto           boolean not null default false,
  minimo_no_imponible  numeric(14,2) not null default 0,
  minimo_retencion     numeric(14,2) not null default 0
);

comment on table ko.alicuotas_retencion is
  'Como se calcula la retencion de cada tipo tildado en Clientes. Se suman. Ver 26_alicuotas_retencion.sql.';

insert into ko.alicuotas_retencion (tipo, nombre, porcentaje, sobre_neto, minimo_no_imponible, minimo_retencion) values
  ('ret_iva',       'IVA',        13.880, false,     0,   0),
  ('ret_iibb_agip', 'IIBB AGIP',   3.500, false,     0,   0),
  ('ret_iibb_arba', 'IIBB ARBA',   3.410, false,     0,   0),
  ('ret_ganancias', 'Ganancias',   2.000, true,  67170, 240)
on conflict (tipo) do nothing;

alter table ko.alicuotas_retencion enable row level security;
grant all privileges on ko.alicuotas_retencion to service_role;
revoke all on ko.alicuotas_retencion from anon, authenticated;

-- Retencion esperada de una factura segun los tipos tildados del cliente.
create or replace function ko.retencion_factura(total numeric, iva boolean, arba boolean, agip boolean, ganancias boolean)
returns numeric language sql stable as $$
  select coalesce(sum(r), 0)
  from (
    select case when x.r >= a.minimo_retencion then x.r else 0 end as r
    from ko.alicuotas_retencion a
    cross join lateral (
      select round(greatest(0, (case when a.sobre_neto then total / 1.21 else total end) - a.minimo_no_imponible)
                   * a.porcentaje / 100, 2) as r
    ) x
    where total > 0
      and ((a.tipo = 'ret_iva' and iva)
        or (a.tipo = 'ret_iibb_arba' and arba)
        or (a.tipo = 'ret_iibb_agip' and agip)
        or (a.tipo = 'ret_ganancias' and ganancias))
  ) t
$$;

create or replace view ko.v_saldos_clientes with (security_invoker = on) as
with det as (
  select f.cuit_cliente as cuit,
         f.numero,
         f.fecha_emision,
         f.total,
         p.factura_numero is not null as pagada,
         coalesce(p.monto, 0) as pago_monto,
         ko.factura_exenta(c.sin_cobro, c.sin_cobro_hasta, f.fecha_emision) as exenta,
         (c.ret_iva or c.ret_iibb_arba or c.ret_iibb_agip or c.ret_ganancias) as con_ret,
         ko.retencion_factura(f.total, c.ret_iva, c.ret_iibb_arba, c.ret_iibb_agip, c.ret_ganancias) as ret
  from ko.facturas f
  join ko.clientes c on c.cuit = f.cuit_cliente
  left join ko.pagos p on p.factura_numero = f.numero
),
fact as (
  select cuit,
         sum(total) as facturado,
         coalesce(sum(total) filter (where pagada or exenta), 0) as imputado,
         coalesce(sum(total) filter (where exenta), 0) as exento,
         coalesce(sum(total) filter (where not exenta), 0) as facturado_normal,
         coalesce(sum(total) filter (where pagada and not exenta), 0) as imputado_normal,
         -- lo que entro al banco por las facturas imputadas
         coalesce(sum(pago_monto) filter (where pagada and not exenta), 0) as pagado_normal,
         bool_or(con_ret) as con_ret
  from det
  group by cuit
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
-- Clientes con retenciones: la plata sin imputar se reparte de la factura
-- impaga mas vieja a la mas nueva, cada una por lo que deberia transferir.
sin_imputar as (
  select fact.cuit, greatest(0, coalesce(cob.banco_normal, 0) - fact.pagado_normal) as plata
  from fact left join cob on cob.cuit = fact.cuit
  where fact.con_ret
),
reparto as (
  select d.cuit, d.total, d.total - d.ret as neto,
         coalesce(sum(d.total - d.ret) over (partition by d.cuit order by d.fecha_emision, d.numero
                                             rows between unbounded preceding and 1 preceding), 0) as antes
  from det d
  where d.con_ret and not d.pagada and not d.exenta and d.total > 0
),
acreditado as (
  select r.cuit,
         sum(case
               when r.antes + r.neto <= s.plata then r.total
               when r.antes < s.plata then (s.plata - r.antes) * r.total / r.neto
               else 0
             end) as cubierto,
         -- lo que sobra despues de cubrir todas las impagas
         greatest(0, max(s.plata) - sum(r.neto)) as sobrante
  from reparto r join sin_imputar s on s.cuit = r.cuit
  group by r.cuit
),
calc as (
  select fact.cuit,
         fact.facturado,
         fact.imputado,
         fact.exento,
         fact.facturado_normal,
         coalesce(cob.banco, 0) as cobrado_banco,
         case
           when fact.con_ret then
             greatest(fact.imputado_normal,
                      least(fact.facturado_normal,
                            fact.imputado_normal
                              + coalesce(a.cubierto, 0)
                              + coalesce(a.sobrante, (select plata from sin_imputar s where s.cuit = fact.cuit))))
           else
             greatest(fact.imputado_normal, least(coalesce(cob.banco_normal, 0), fact.facturado_normal))
         end as cobrado_normal,
         case when fact.con_ret then coalesce(a.cubierto, 0) - (
             select least(coalesce(sum(r.neto), 0), max(s.plata)) from reparto r join sin_imputar s on s.cuit = r.cuit where r.cuit = fact.cuit
           ) else 0 end as retencion_estimada
  from fact
  left join cob on cob.cuit = fact.cuit
  left join acreditado a on a.cuit = fact.cuit
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
       c.sin_cobro_hasta,
       round(calc.retencion_estimada, 2) as retencion_estimada
from calc
join ko.clientes c on c.cuit = calc.cuit;

grant select on ko.v_saldos_clientes to service_role;
revoke all on ko.v_saldos_clientes from anon, authenticated;
