-- Mailing a clientes con saldo pendiente.
--
-- Todo el armado vive en la base: a quien le corresponde cada mail, con que
-- saldo y con que texto. El Apps Script solo lee `ko.v_mailing` y manda lo
-- que ya viene armado, asi el mail nunca dice algo distinto de lo que dice
-- la base.
--
--   ko.clientes.email      a donde se manda (puede ser una lista con comas)
--   ko.mailing_templates   asunto + cuerpo con {{variables}} y el rango de saldo
--   ko.mailing_envios      registro de lo enviado, para no repetir
--   ko.v_saldos_clientes   saldo por cliente, MISMA formula que el panel
--   ko.v_saldo_facturas    las facturas que componen ese saldo
--   ko.v_mailing           una fila por (template, cliente) con el mail listo
--
-- Se puede correr mas de una vez: no pisa templates ya editados.

-- --- email de los clientes -------------------------------------------------

alter table ko.clientes
  add column if not exists email text not null default '';

comment on column ko.clientes.email is
  'Email(s) para avisos de cobranza. Varios separados por coma. Vacio = no se le manda nada.';

-- --- templates ---------------------------------------------------------------

create table if not exists ko.mailing_templates (
  id                text primary key check (id ~ '^[a-z0-9-]+$'),
  descripcion       text not null default '',
  asunto            text not null,
  cuerpo            text not null,
  -- Rango de saldo, los dos extremos EXCLUSIVOS: entra si
  -- saldo > saldo_min y saldo < saldo_max. saldo_max null = sin tope.
  saldo_min         numeric(14,2) not null default 0,
  saldo_max         numeric(14,2),
  -- No se le vuelve a mandar el mismo template al mismo cliente antes de
  -- que pasen estos dias.
  dias_entre_envios int not null default 30 check (dias_entre_envios >= 0),
  remitente_nombre  text not null default 'KO Fumigaciones',
  responder_a       text not null default '',
  activo            boolean not null default true,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);

comment on table ko.mailing_templates is
  'Variables del asunto y el cuerpo: {{nombre}}, {{cuit}}, {{saldo}}, {{facturas}}, {{cantidad_facturas}}. '
  'Un texto con "[COMPLETAR" no se puede enviar: el Apps Script lo rechaza.';

drop trigger if exists mailing_templates_tocar_actualizado on ko.mailing_templates;
create trigger mailing_templates_tocar_actualizado before update on ko.mailing_templates
  for each row execute function ko.tocar_actualizado_en();

-- --- registro de envios ------------------------------------------------------

create table if not exists ko.mailing_envios (
  id            bigint generated always as identity primary key,
  template_id   text not null references ko.mailing_templates(id),
  cuit_cliente  text not null references ko.clientes(cuit),
  email         text not null,
  -- Se guarda lo que efectivamente salio: el saldo y el texto de ese dia,
  -- no los de hoy.
  saldo         numeric(14,2) not null,
  asunto        text not null,
  cuerpo        text not null,
  enviado_por   text not null,
  enviado_en    timestamptz not null default now()
);

create index if not exists mailing_envios_template_cuit_idx
  on ko.mailing_envios (template_id, cuit_cliente, enviado_en desc);

alter table ko.mailing_templates enable row level security;
alter table ko.mailing_envios enable row level security;

-- --- formato -----------------------------------------------------------------

-- $ 1.234.567,89 sin depender del locale del servidor (Supabase corre en
-- en_US y to_char con G/D devolveria 1,234,567.89).
create or replace function ko.fmt_pesos(n numeric) returns text
language sql immutable as $$
  select '$ ' || translate(to_char(round(n, 2), 'FM999,999,999,990.00'), ',.', '.,')
$$;

create or replace function ko.fmt_cuit(c text) returns text
language sql immutable as $$
  select substr(c, 1, 2) || '-' || substr(c, 3, 8) || '-' || substr(c, 11, 1)
$$;

-- --- saldo por cliente ---------------------------------------------------------
--
-- Replica `recomputar()` de docs/app.js. Si se cambia una, hay que cambiar la
-- otra: el mail no puede decirle al cliente una deuda distinta de la que KO
-- ve en el tablero.
--
--   facturado = suma de sus facturas (las NC restan)
--   imputado  = suma de las facturas que tienen pago
--   banco     = todo lo que entro de ese CUIT, imputado o no
--   cobrado   = max(imputado, min(banco, facturado))
--   saldo     = facturado - cobrado
--
-- `cobrado` usa lo del banco porque hay clientes que pagan dos o tres meses
-- juntos y esa transferencia no coincide con ninguna factura: la plata entro
-- aunque no se pueda imputar factura por factura. El tope en `facturado`
-- deja afuera lo pagado de mas (cancela deuda anterior a enero, que no esta
-- cargada).

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
       calc.cobrado,
       calc.facturado - calc.cobrado as saldo
from calc
join ko.clientes c on c.cuit = calc.cuit;

-- --- facturas que componen el saldo ------------------------------------------
--
-- No alcanza con listar "las facturas sin pago": si el cliente pago una
-- parte con una transferencia que no se pudo imputar, la suma de esas
-- facturas es MAYOR que lo que debe, y el mail le pediria de mas.
--
-- Criterio de cuenta corriente: lo cobrado cancela lo mas viejo. Se toman las
-- facturas sin pago de la mas nueva a la mas vieja hasta cubrir el saldo; la
-- ultima puede quedar parcial (`pendiente` < `total`). Las NC no se listan.
-- La suma de `pendiente` da siempre el saldo exacto.

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
  left join ko.pagos p on p.factura_numero = f.numero
  where p.factura_numero is null
    and f.total > 0
    and s.saldo > 0
)
select cuit,
       numero,
       fecha_emision,
       total,
       least(total, saldo - acumulado_antes) as pendiente,
       row_number() over (partition by cuit order by fecha_emision, numero) as orden
from impagas
where acumulado_antes < saldo;

-- --- mail armado ---------------------------------------------------------------
--
-- estado:
--   listo             se puede mandar
--   sin_email         falta cargar el email del cliente
--   enviado_reciente  ya se le mando este template hace menos de
--                     `dias_entre_envios`

create or replace view ko.v_mailing with (security_invoker = on) as
with base as (
  select t.id as template_id,
         t.asunto,
         t.cuerpo,
         t.remitente_nombre,
         t.responder_a,
         t.dias_entre_envios,
         s.cuit,
         s.nombre,
         trim(s.email) as email,
         s.saldo,
         coalesce(fx.lineas, '') as facturas,
         coalesce(fx.cantidad, 0) as cantidad_facturas,
         ult.enviado_en as ultimo_envio
  from ko.mailing_templates t
  join ko.v_saldos_clientes s
    on s.saldo > t.saldo_min
   and (t.saldo_max is null or s.saldo < t.saldo_max)
  left join lateral (
    select string_agg(
             '- Factura ' || sf.numero || ' del ' || to_char(sf.fecha_emision, 'DD/MM/YYYY') || ': '
               || ko.fmt_pesos(sf.pendiente)
               || case when sf.pendiente < sf.total
                       then ' (saldo de un total de ' || ko.fmt_pesos(sf.total) || ')'
                       else '' end,
             E'\n' order by sf.orden
           ) as lineas,
           count(*) as cantidad
    from ko.v_saldo_facturas sf
    where sf.cuit = s.cuit
  ) fx on true
  left join lateral (
    select max(e.enviado_en) as enviado_en
    from ko.mailing_envios e
    where e.template_id = t.id and e.cuit_cliente = s.cuit
  ) ult on true
  where t.activo
)
select template_id,
       cuit,
       nombre,
       email,
       saldo,
       cantidad_facturas,
       replace(replace(replace(replace(replace(asunto,
         '{{nombre}}', nombre),
         '{{cuit}}', ko.fmt_cuit(cuit)),
         '{{saldo}}', ko.fmt_pesos(saldo)),
         '{{cantidad_facturas}}', cantidad_facturas::text),
         '{{facturas}}', facturas) as asunto,
       replace(replace(replace(replace(replace(cuerpo,
         '{{nombre}}', nombre),
         '{{cuit}}', ko.fmt_cuit(cuit)),
         '{{saldo}}', ko.fmt_pesos(saldo)),
         '{{cantidad_facturas}}', cantidad_facturas::text),
         '{{facturas}}', facturas) as cuerpo,
       remitente_nombre,
       responder_a,
       ultimo_envio,
       case
         when email = '' then 'sin_email'
         when ultimo_envio > now() - make_interval(days => dias_entre_envios) then 'enviado_reciente'
         else 'listo'
       end as estado
from base;

-- --- permisos -----------------------------------------------------------------
-- Igual que el resto del schema: solo el Apps Script (service_role).

grant all privileges on ko.mailing_templates, ko.mailing_envios to service_role;
grant all privileges on all sequences in schema ko to service_role;
grant select on ko.v_saldos_clientes, ko.v_saldo_facturas, ko.v_mailing to service_role;
revoke all on ko.mailing_templates, ko.mailing_envios,
              ko.v_saldos_clientes, ko.v_saldo_facturas, ko.v_mailing
  from anon, authenticated;

-- --- template inicial ------------------------------------------------------------
-- Los [COMPLETAR ...] hay que reemplazarlos desde el Table Editor antes de
-- poder mandar.

insert into ko.mailing_templates (id, descripcion, asunto, cuerpo, saldo_min, saldo_max)
values (
  'saldo-menor-300k',
  'Recordatorio amable a clientes con saldo pendiente menor a $300.000',
  'KO Fumigaciones - Saldo pendiente de {{saldo}}',
  $cuerpo$Estimados/as {{nombre}}:

Les escribimos desde KO Fumigaciones para informarles que, según nuestros registros, su cuenta (CUIT {{cuit}}) presenta un saldo pendiente de {{saldo}}, correspondiente a:

{{facturas}}

Pueden abonarlo por transferencia a:
[COMPLETAR: titular, CUIT, banco, CBU y alias]

Si ya realizaron el pago, les pedimos que nos respondan este correo con el comprobante así lo registramos, y desestimen este aviso.

Ante cualquier consulta quedamos a disposición.

Saludos cordiales,
[COMPLETAR: nombre y teléfono de contacto]
KO Fumigaciones$cuerpo$,
  0,
  300000
)
on conflict (id) do nothing;
