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
  const base = SUPABASE_URL().replace(/\/$/, '') + '/rest/v1/' + tabla;
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
