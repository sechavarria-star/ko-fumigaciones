-- Cola de mails.
--
-- El cartero (Apps Script de cobranzas@kofumigacion.com) no puede recibir
-- llamadas: la cuenta de KO no logra publicar apps web abiertas. Asi que se
-- invierte el flujo: el panel deja los mails aca y el cartero, con un
-- activador de cada 1 minuto, se los pide al backend, los manda y avisa
-- como le fue.
--
--   pendiente -> tomado (el cartero se lo llevo) -> enviado | error
--
-- Un "tomado" que no vuelve en 10 minutos se vuelve a ofrecer (hasta 3
-- intentos): el cartero pudo haberse cortado a mitad de camino.
--
-- Se puede correr mas de una vez.

create table if not exists ko.mailing_cola (
  id            bigint generated always as identity primary key,
  -- 'real' va al cliente y se registra en ko.mailing_envios al salir.
  -- 'prueba' va a quien la pidio y no se registra en ningun lado mas.
  tipo          text not null check (tipo in ('real', 'prueba')),
  template_id   text not null references ko.mailing_templates(id),
  cuit_cliente  text not null references ko.clientes(cuit),
  para          text not null,
  asunto        text not null,
  texto         text not null,
  html          text,
  nombre        text not null,
  responder_a   text not null default '',
  saldo         numeric(14,2) not null,
  pedido_por    text not null,
  estado        text not null default 'pendiente'
                check (estado in ('pendiente', 'tomado', 'enviado', 'error')),
  intentos      int not null default 0,
  error         text,
  creado_en     timestamptz not null default now(),
  tomado_en     timestamptz,
  terminado_en  timestamptz
);

create index if not exists mailing_cola_estado_idx on ko.mailing_cola (estado, id);

-- Un cliente no puede tener dos envios reales del mismo template esperando:
-- si se aprieta "Enviar" dos veces seguidas, el segundo no duplica.
create unique index if not exists mailing_cola_un_real_en_espera
  on ko.mailing_cola (template_id, cuit_cliente)
  where tipo = 'real' and estado in ('pendiente', 'tomado');

alter table ko.mailing_cola enable row level security;

grant all privileges on ko.mailing_cola to service_role;
grant all privileges on all sequences in schema ko to service_role;
revoke all on ko.mailing_cola from anon, authenticated;
