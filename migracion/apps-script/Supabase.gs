/**
 * Helpers sobre la REST API de PostgREST que expone Supabase. Las tablas
 * viven en el schema `ko` (no `public`), así que hace falta:
 *   1) En Supabase: Database > API Settings > "Exposed schemas" - agregar
 *      `ko` a la lista (por default solo expone `public`).
 *   2) Acá: mandar el header Accept-Profile (lecturas) o Content-Profile
 *      (escrituras) = "ko" en cada request - PostgREST lo usa para saber
 *      contra qué schema resolver la tabla.
 *
 * Usa siempre la service_role key (nunca la anon key) - corre del lado del
 * servidor (Apps Script), no en el navegador, así que puede saltarse RLS
 * a propósito.
 */
function sbHeaders_(schemaHeader) {
  const h = {
    apikey: SUPABASE_SERVICE_ROLE_KEY(),
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY(),
    'Content-Type': 'application/json',
  };
  h[schemaHeader] = 'ko';
  return h;
}

function sbUrl_(tabla, query) {
  // La Script Property puede venir como "https://xxx.supabase.co" o ya con el
  // "/rest/v1" pegado (es como Supabase lo muestra en su panel) - se saca el
  // sufijo si está para no terminar armando ".../rest/v1/rest/v1/tabla".
  const raiz = SUPABASE_URL().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const base = raiz + '/rest/v1/' + tabla;
  return query ? base + '?' + query : base;
}

function sbFetch_(url, options) {
  const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options));
  const codigo = res.getResponseCode();
  const texto = res.getContentText();
  if (codigo >= 400) {
    throw new SbError(codigo, texto, url);
  }
  return texto ? JSON.parse(texto) : null;
}

function SbError(codigo, cuerpo, url) {
  this.name = 'SbError';
  this.status = codigo;
  this.body = cuerpo;
  this.message = 'Supabase ' + codigo + ' en ' + url + ': ' + cuerpo;
}
SbError.prototype = Object.create(Error.prototype);

/** SELECT. `query` es la query string de PostgREST tal cual, ej. "select=*&cuit=eq.123". */
function sbGet(tabla, query) {
  return sbFetch_(sbUrl_(tabla, query), {
    method: 'get',
    headers: sbHeaders_('Accept-Profile'),
  });
}

/**
 * SELECT de una tabla entera, paginando.
 *
 * PostgREST corta en `max-rows` (1000 en Supabase por default) y NO avisa:
 * devuelve 200 con las primeras 1000 filas como si fueran todas. Contra
 * `facturas` (1192 filas) eso significaba perder 192 comprobantes en
 * silencio, así que toda lectura de tabla completa tiene que pasar por acá.
 *
 * `orden` tiene que ser una columna única y estable (la PK): sin un ORDER BY
 * determinístico, Postgres puede repetir o saltear filas entre páginas.
 */
function sbGetTodo(tabla, select, orden) {
  const PAGINA = 1000;
  const filas = [];
  let desde = 0;

  while (true) {
    const query = select + '&order=' + orden + '&limit=' + PAGINA + '&offset=' + desde;
    const tanda = sbGet(tabla, query);
    filas.push.apply(filas, tanda);
    if (tanda.length < PAGINA) return filas;
    desde += PAGINA;
  }
}

/** INSERT de una o varias filas. Devuelve las filas insertadas. */
function sbInsert(tabla, filas) {
  return sbFetch_(sbUrl_(tabla, null), {
    method: 'post',
    headers: Object.assign(sbHeaders_('Content-Profile'), { Prefer: 'return=representation' }),
    payload: JSON.stringify(filas),
  });
}

/** UPDATE filtrado por query de PostgREST, ej. "cuit=eq.123". Devuelve las filas resultantes. */
function sbUpdate(tabla, query, cambios) {
  return sbFetch_(sbUrl_(tabla, query), {
    method: 'patch',
    headers: Object.assign(sbHeaders_('Content-Profile'), { Prefer: 'return=representation' }),
    payload: JSON.stringify(cambios),
  });
}

/** INSERT ... ON CONFLICT (columnaConflicto) DO UPDATE. */
function sbUpsert(tabla, filas, columnaConflicto) {
  return sbFetch_(sbUrl_(tabla, 'on_conflict=' + columnaConflicto), {
    method: 'post',
    headers: Object.assign(sbHeaders_('Content-Profile'), {
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    payload: JSON.stringify(filas),
  });
}
