/**
 * Mailing a clientes con saldo pendiente.
 *
 * Toda la logica (a quien, con que saldo, que texto) esta en Supabase, en la
 * vista ko.v_mailing (ver migracion/supabase/10_mailing.sql). Aca solo se lee
 * esa vista y se manda lo que ya viene armado - nunca un texto que mande el
 * navegador. Del front solo se acepta QUE clientes, no QUE decirles.
 *
 * Los mails NO salen de este Apps Script (que es de GIWA): se dejan en la
 * cola ko.mailing_cola y los manda el "cartero" (migracion/cartero/), un
 * Apps Script de facturacion@kofumigacion.com que cada 1 minuto pide los
 * pendientes (cartero_tomar) y avisa como le fue (cartero_resultado).
 *
 * Es el cartero el que llama, y no al reves, porque la cuenta de KO no
 * consigue publicar apps web abiertas: asi no hace falta.
 *
 * Script Property: CARTERO_CLAVE (la misma que CLAVE_CARTERO en el cartero).
 */

// Un template con esto adentro todavia tiene datos sin completar (CBU,
// firma) y no se puede mandar.
var MARCA_SIN_COMPLETAR = '[COMPLETAR';

// Un mail "tomado" que no vuelve en este tiempo se vuelve a ofrecer: el
// cartero pudo haberse cortado. Hasta MAX_INTENTOS veces.
var MINUTOS_REINTENTO = 10;
var MAX_INTENTOS = 3;

// Si el cartero no pide nada en este tiempo, el panel avisa que esta caido.
var MINUTOS_CARTERO_CAIDO = 5;

function templatesActivos_() {
  return sbGet('mailing_templates', 'select=id,descripcion,saldo_min,saldo_max,dias_entre_envios,asunto,cuerpo,datos_pago,firma&activo=is.true&order=id');
}

function filasMailing_(templateId) {
  return sbGetTodo(
    'v_mailing',
    'select=cuit,nombre,email,saldo,cantidad_facturas,asunto,cuerpo,cuerpo_html,remitente_nombre,responder_a,ultimo_envio,estado' +
      '&template_id=eq.' + encodeURIComponent(templateId),
    'cuit'
  ).map(function (f) {
    f.saldo = Number(f.saldo);
    return f;
  });
}

function sinCompletar_(t) {
  return [t.asunto, t.cuerpo, t.datos_pago, t.firma].some(function (x) {
    return (x || '').indexOf(MARCA_SIN_COMPLETAR) !== -1;
  });
}

// Cada direccion cuenta por separado contra la cuota diaria de Gmail.
function cantidadDirecciones_(email) {
  return email.split(',').filter(function (e) { return e.trim(); }).length;
}

// --- estado del cartero ------------------------------------------------------------
// Lo que reporto el cartero la ultima vez que paso: desde que cuenta manda,
// cuanta cuota le queda y cuando fue.

function carteroEstado_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CARTERO_ULTIMO');
  if (!raw) return { cuenta: null, cuota: null, visto_en: null, activo: false };
  const e = JSON.parse(raw);
  e.activo = Date.now() - new Date(e.visto_en).getTime() < MINUTOS_CARTERO_CAIDO * 60000;
  return e;
}

function cola_(query) {
  return sbGet('mailing_cola', query);
}

function filaCola_(f, tipo, templateId, para, usuario) {
  return {
    tipo: tipo,
    template_id: templateId,
    cuit_cliente: f.cuit,
    para: para,
    asunto: f.asunto,
    texto: f.cuerpo,
    html: f.cuerpo_html,
    nombre: f.remitente_nombre,
    responder_a: f.responder_a || '',
    saldo: f.saldo,
    pedido_por: usuario.email,
  };
}

// --- acciones del panel --------------------------------------------------------------

/**
 * Templates activos y, si se pide uno, sus destinatarios con el mail armado,
 * el estado del cartero y lo que hay en la cola. No manda nada.
 */
function accMailingVista_(body, usuario) {
  const templates = templatesActivos_().map(function (t) {
    return {
      id: t.id,
      descripcion: t.descripcion,
      saldo_min: Number(t.saldo_min),
      saldo_max: t.saldo_max === null ? null : Number(t.saldo_max),
      dias_entre_envios: t.dias_entre_envios,
      sin_completar: sinCompletar_(t),
    };
  });

  const resultado = { templates: templates, cartero: carteroEstado_() };
  if (!body.template_id) return resultado;

  const tid = encodeURIComponent(body.template_id);
  const enEspera = cola_('select=cuit_cliente&tipo=eq.real&estado=in.(pendiente,tomado)&template_id=eq.' + tid);
  const esperando = {};
  enEspera.forEach(function (c) { esperando[c.cuit_cliente] = true; });

  resultado.destinatarios = filasMailing_(body.template_id).map(function (f) {
    if (esperando[f.cuit]) f.estado = 'en_cola';
    return f;
  });
  resultado.cola = {
    en_espera: cola_('select=id&estado=in.(pendiente,tomado)').length,
    // Errores de las ultimas 48 horas, para que se vean en el panel.
    errores: cola_(
      'select=tipo,cuit_cliente,para,error,terminado_en&estado=eq.error' +
        '&terminado_en=gte.' + encodeURIComponent(new Date(Date.now() - 48 * 3600000).toISOString()) +
        '&order=terminado_en.desc&limit=20'
    ),
  };
  return resultado;
}

/**
 * Pone el template en la cola para los CUIT pedidos.
 *
 * Vuelve a leer la vista en el momento: el saldo y el estado son los de
 * ahora, no los de cuando se abrio la vista previa. Un cliente que pago entre
 * medio, al que ya se le mando o que ya esta en la cola, queda afuera solo.
 */
function accMailingEnviar_(body, usuario) {
  const templateId = body.template_id;
  const pedidos = body.cuits || [];
  if (!templateId) throw new ApiError(400, 'Falta template_id');
  if (!pedidos.length) throw new ApiError(400, 'No se eligió ningún cliente');

  const t = sbGet('mailing_templates', 'select=id,asunto,cuerpo,datos_pago,firma,activo&id=eq.' + encodeURIComponent(templateId))[0];
  if (!t || !t.activo) throw new ApiError(404, 'No existe un template activo "' + templateId + '"');
  if (sinCompletar_(t)) {
    throw new ApiError(400, 'El template todavía tiene datos sin completar ([COMPLETAR ...]). Editalo en Supabase antes de mandar.');
  }

  const vista = accMailingVista_({ template_id: templateId }, usuario);
  const porCuit = {};
  vista.destinatarios.forEach(function (f) { porCuit[f.cuit] = f; });

  const aEncolar = [];
  const omitidos = [];
  pedidos.forEach(function (cuit) {
    const f = porCuit[cuit];
    if (!f) omitidos.push({ cuit: cuit, motivo: 'ya no tiene saldo en el rango del template' });
    else if (f.estado !== 'listo') omitidos.push({ cuit: cuit, nombre: f.nombre, motivo: f.estado });
    else aEncolar.push(f);
  });

  // Si se sabe la cuota del cartero, no se encola mas de lo que puede
  // mandar hoy: lo que sobre quedaria esperando hasta mañana sin avisar.
  const c = vista.cartero;
  if (c.cuota !== null && c.cuota !== undefined) {
    const direcciones = aEncolar.reduce(function (s, f) { return s + cantidadDirecciones_(f.email); }, 0);
    if (direcciones > c.cuota) {
      throw new ApiError(400, 'A ' + (c.cuenta || 'la cuenta que manda') + ' le quedan ' + c.cuota + ' destinatarios por hoy y este envío tiene ' + direcciones + '. Mandá menos o esperá a mañana.');
    }
  }

  const filas = aEncolar.map(function (f) { return filaCola_(f, 'real', templateId, f.email, usuario); });
  const encolados = [];
  if (filas.length) {
    try {
      sbInsert('mailing_cola', filas);
      aEncolar.forEach(function (f) { encolados.push({ cuit: f.cuit, nombre: f.nombre }); });
    } catch (err) {
      // Choque con el indice unico (alguien encolo al mismo cliente recien):
      // se reintenta de a uno para no perder al resto del lote.
      if (!(err instanceof SbError) || err.status !== 409) throw err;
      filas.forEach(function (fila, i) {
        try {
          sbInsert('mailing_cola', [fila]);
          encolados.push({ cuit: aEncolar[i].cuit, nombre: aEncolar[i].nombre });
        } catch (e2) {
          omitidos.push({ cuit: aEncolar[i].cuit, nombre: aEncolar[i].nombre, motivo: 'en_cola' });
        }
      });
    }
  }

  return { encolados: encolados, omitidos: omitidos, cartero_activo: c.activo };
}

/**
 * Encola el mail de UN cliente dirigido a quien lo pide - nunca al cliente.
 * Sale por el cartero igual que los reales, asi se ve tambien el remitente.
 *
 * A proposito NO se registra en ko.mailing_envios (si no, el cliente quedaria
 * como "enviado hace poco" sin haber recibido nada) y se permite aunque el
 * template tenga [COMPLETAR]: es justamente para revisarlo.
 */
function accMailingPrueba_(body, usuario) {
  if (!body.template_id || !body.cuit) throw new ApiError(400, 'Falta template_id o cuit');
  const f = filasMailing_(body.template_id).filter(function (x) { return x.cuit === body.cuit; })[0];
  if (!f) throw new ApiError(404, 'Ese cliente no está en el mailing de este template');

  const aviso = 'Mail de prueba: así le llegaría a ' + f.nombre + ' (' + (f.email || 'sin email cargado') + '). No se le mandó nada al cliente.';
  const fila = filaCola_(f, 'prueba', body.template_id, usuario.email, usuario);
  fila.asunto = '[PRUEBA] ' + f.asunto;
  fila.texto = aviso + '\n\n----------------------------------------\n\n' + f.cuerpo;
  // Franja amarilla arriba de todo, para que la prueba no se confunda con un
  // mail real si se reenvía.
  fila.html = f.cuerpo_html.replace(
    /(<body[^>]*>)/,
    '$1<div style="background:#fef3c7;color:#92400e;font-family:Arial,sans-serif;font-size:13px;padding:10px 16px;text-align:center;">' +
      aviso.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>'
  );
  sbInsert('mailing_cola', [fila]);
  return { enviado_a: usuario.email, cliente: f.nombre, cartero_activo: carteroEstado_().activo };
}

// --- acciones del cartero ----------------------------------------------------------
// No traen token de Google (el cartero no es una persona): se autentican con
// la clave compartida.

function despacharCartero_(body) {
  const clave = PropertiesService.getScriptProperties().getProperty('CARTERO_CLAVE');
  if (!clave) throw new ApiError(500, 'Falta la Script Property CARTERO_CLAVE en el backend');
  if (!mismaClave_(String(body.clave || ''), clave)) throw new ApiError(403, 'Clave inválida');

  switch (body.action) {
    case 'cartero_tomar':
      return accCarteroTomar_(body);
    case 'cartero_resultado':
      return accCarteroResultado_(body);
    default:
      throw new ApiError(404, 'Acción desconocida: ' + body.action);
  }
}

// Comparacion sin cortar en la primera diferencia, para no filtrar por el
// tiempo de respuesta cuantos caracteres de la clave se acertaron.
function mismaClave_(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/**
 * El cartero avisa que esta vivo (cuenta y cuota) y se lleva hasta `max`
 * mails pendientes. Los marca "tomado" en el mismo update, filtrando por
 * estado: si dos pasadas se pisaran, cada mail queda para una sola.
 */
function accCarteroTomar_(body) {
  PropertiesService.getScriptProperties().setProperty('CARTERO_ULTIMO', JSON.stringify({
    cuenta: body.cuenta || null,
    cuota: typeof body.cuota === 'number' ? body.cuota : null,
    visto_en: new Date().toISOString(),
  }));

  const max = Math.max(0, Math.min(Number(body.max) || 0, 50));
  if (!max) return { mails: [] };

  const vencido = new Date(Date.now() - MINUTOS_REINTENTO * 60000).toISOString();
  const candidatos = cola_(
    'select=id,intentos&or=(estado.eq.pendiente,and(estado.eq.tomado,tomado_en.lt.' + vencido + '))' +
      '&order=id&limit=' + max
  );

  const agotados = candidatos.filter(function (c) { return c.intentos >= MAX_INTENTOS; }).map(function (c) { return c.id; });
  if (agotados.length) {
    sbUpdate('mailing_cola', 'id=in.(' + agotados.join(',') + ')', {
      estado: 'error',
      error: 'El cartero lo tomó ' + MAX_INTENTOS + ' veces sin confirmar el envío',
      terminado_en: new Date().toISOString(),
    });
  }

  // El update se vuelve a filtrar por estado: solo se lleva lo que sigue
  // disponible en este instante.
  const tomados = [];
  candidatos.forEach(function (c) {
    if (c.intentos >= MAX_INTENTOS) return;
    const r = sbUpdate(
      'mailing_cola',
      'id=eq.' + c.id + '&or=(estado.eq.pendiente,and(estado.eq.tomado,tomado_en.lt.' + vencido + '))',
      { estado: 'tomado', tomado_en: new Date().toISOString(), intentos: c.intentos + 1 }
    );
    if (r && r.length) tomados.push(r[0]);
  });

  return {
    mails: tomados.map(function (m) {
      return { id: m.id, para: m.para, asunto: m.asunto, texto: m.texto, html: m.html, nombre: m.nombre, responder_a: m.responder_a };
    }),
  };
}

/**
 * El cartero informa como le fue con cada mail. Los reales que salieron se
 * registran en ko.mailing_envios: recien ahi el cliente pasa a "enviado hace
 * poco" y no se le vuelve a mandar.
 */
function accCarteroResultado_(body) {
  const resultados = body.resultados || [];
  const ahora = new Date().toISOString();
  let enviados = 0;
  let errores = 0;

  resultados.forEach(function (r) {
    const id = Number(r.id);
    if (!id) return;
    const filas = sbUpdate(
      'mailing_cola',
      'id=eq.' + id + '&estado=eq.tomado',
      r.ok ? { estado: 'enviado', error: null, terminado_en: ahora }
           : { estado: 'error', error: String(r.error || 'error desconocido').slice(0, 500), terminado_en: ahora }
    );
    const m = filas && filas[0];
    if (!m) return; // ya lo habia cerrado otra pasada
    if (!r.ok) { errores++; return; }
    enviados++;
    if (m.tipo === 'real') {
      sbInsert('mailing_envios', [{
        template_id: m.template_id,
        cuit_cliente: m.cuit_cliente,
        email: m.para,
        saldo: m.saldo,
        asunto: m.asunto,
        cuerpo: m.texto,
        cuerpo_html: m.html,
        enviado_por: m.pedido_por,
        enviado_en: ahora,
      }]);
    }
  });

  return { enviados: enviados, errores: errores };
}
