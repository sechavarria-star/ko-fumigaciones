/**
 * Mailing a clientes con saldo pendiente.
 *
 * Toda la logica (a quien, con que saldo, que texto) esta en Supabase, en la
 * vista ko.v_mailing (ver migracion/supabase/10_mailing.sql). Aca solo se lee
 * esa vista y se manda lo que ya viene armado - nunca un texto que mande el
 * navegador. Del front solo se acepta QUE clientes, no QUE decirles.
 *
 * Los mails NO salen de este Apps Script (que es de GIWA) sino del "cartero"
 * (migracion/cartero/), un Apps Script publicado por cobranzas@kofumigacion.com
 * que manda desde esa cuenta. Script Properties: CARTERO_URL y CARTERO_CLAVE.
 */

// Un template con esto adentro todavia tiene datos sin completar (CBU,
// firma) y no se puede mandar.
var MARCA_SIN_COMPLETAR = '[COMPLETAR';

// Mails por llamada al cartero. Se registra cada tanda apenas vuelve: si
// Apps Script corta por tiempo, lo ya enviado queda anotado y no se repite.
var TANDA_CARTERO = 20;

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

// --- cartero ---------------------------------------------------------------------

function llamarCartero_(params) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('CARTERO_URL');
  const clave = props.getProperty('CARTERO_CLAVE');
  if (!url || !clave) {
    throw new ApiError(500, 'Falta configurar el cartero (Script Properties CARTERO_URL y CARTERO_CLAVE). Ver SETUP.md.');
  }
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(Object.assign({ clave: clave }, params)),
    muteHttpExceptions: true,
  });
  let cuerpo;
  try {
    cuerpo = JSON.parse(res.getContentText());
  } catch (err) {
    // HTML en vez de JSON: deployment del cartero sin publicar, URL vieja, o
    // sin acceso "Cualquier usuario".
    throw new ApiError(502, 'El cartero no respondió JSON (HTTP ' + res.getResponseCode() + '). ¿Está publicado con acceso "Cualquier usuario"?');
  }
  if (cuerpo.status >= 400) throw new ApiError(502, 'Cartero: ' + cuerpo.detail);
  return cuerpo.data;
}

function mailCartero_(f, para) {
  return {
    para: para || f.email,
    asunto: f.asunto,
    texto: f.cuerpo,
    // Se manda HTML con el texto plano como alternativa, para los clientes
    // de correo que no muestran HTML.
    html: f.cuerpo_html,
    nombre: f.remitente_nombre,
    responder_a: f.responder_a,
  };
}

// --- acciones ----------------------------------------------------------------------

/**
 * Templates activos y, si se pide uno, sus destinatarios con el mail armado.
 * No manda nada. Si el cartero no responde se informa igual la vista previa,
 * con el error, para que se vea que hay que arreglar antes de mandar.
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

  const resultado = { templates: templates, cuota: 0, remitente: null, cartero_error: null };
  try {
    const c = llamarCartero_({ accion: 'cuota' });
    resultado.cuota = c.cuota;
    resultado.remitente = c.cuenta;
  } catch (err) {
    resultado.cartero_error = err.message;
  }
  if (body.template_id) resultado.destinatarios = filasMailing_(body.template_id);
  return resultado;
}

/**
 * Manda el template a los CUIT pedidos.
 *
 * Vuelve a leer la vista en el momento de mandar: el saldo y el estado son
 * los de ahora, no los de cuando se abrio la vista previa. Un cliente que
 * pago entre medio, o al que otro ya le mando, queda afuera solo.
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

  const porCuit = {};
  filasMailing_(templateId).forEach(function (f) { porCuit[f.cuit] = f; });

  const aEnviar = [];
  const omitidos = [];
  pedidos.forEach(function (cuit) {
    const f = porCuit[cuit];
    if (!f) omitidos.push({ cuit: cuit, motivo: 'ya no tiene saldo en el rango del template' });
    else if (f.estado !== 'listo') omitidos.push({ cuit: cuit, nombre: f.nombre, motivo: f.estado });
    else aEnviar.push(f);
  });

  const direcciones = aEnviar.reduce(function (s, f) { return s + cantidadDirecciones_(f.email); }, 0);
  const cuota = llamarCartero_({ accion: 'cuota' }).cuota;
  if (direcciones > cuota) {
    throw new ApiError(400, 'Gmail permite ' + cuota + ' destinatarios más por hoy y este envío tiene ' + direcciones + '. Mandá menos o esperá a mañana.');
  }

  const enviados = [];
  const fallidos = [];
  for (let i = 0; i < aEnviar.length; i += TANDA_CARTERO) {
    const tanda = aEnviar.slice(i, i + TANDA_CARTERO);
    let resultados;
    try {
      resultados = llamarCartero_({ accion: 'enviar', mails: tanda.map(function (f) { return mailCartero_(f); }) }).resultados;
    } catch (err) {
      // El cartero no respondio: no se sabe si salieron. No se registran (si
      // salieron, el peor caso es un segundo aviso) y se corta el lote.
      tanda.concat(aEnviar.slice(i + TANDA_CARTERO)).forEach(function (f) {
        fallidos.push({ cuit: f.cuit, nombre: f.nombre, error: err.message });
      });
      break;
    }

    const registros = [];
    tanda.forEach(function (f, j) {
      const r = resultados[j] || { ok: false, error: 'sin respuesta del cartero' };
      if (!r.ok) {
        fallidos.push({ cuit: f.cuit, nombre: f.nombre, error: r.error });
        return;
      }
      registros.push({
        template_id: templateId,
        cuit_cliente: f.cuit,
        email: f.email,
        saldo: f.saldo,
        asunto: f.asunto,
        cuerpo: f.cuerpo,
        cuerpo_html: f.cuerpo_html,
        enviado_por: usuario.email,
      });
      enviados.push({ cuit: f.cuit, nombre: f.nombre });
    });
    if (registros.length) sbInsert('mailing_envios', registros);
  }

  return { enviados: enviados, omitidos: omitidos, fallidos: fallidos };
}

/**
 * Manda el mail de UN cliente a la casilla de quien lo pide - nunca al
 * cliente. Sirve para ver como llega antes de mandar de verdad. Sale por el
 * cartero igual que los reales, asi se ve tambien el remitente.
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
  const mail = mailCartero_(f, usuario.email);
  mail.asunto = '[PRUEBA] ' + f.asunto;
  mail.texto = aviso + '\n\n----------------------------------------\n\n' + f.cuerpo;
  // Franja amarilla arriba de todo, para que la prueba no se confunda con un
  // mail real si se reenvía.
  mail.html = f.cuerpo_html.replace(
    /(<body[^>]*>)/,
    '$1<div style="background:#fef3c7;color:#92400e;font-family:Arial,sans-serif;font-size:13px;padding:10px 16px;text-align:center;">' +
      aviso.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>'
  );

  const r = llamarCartero_({ accion: 'enviar', mails: [mail] }).resultados[0];
  if (!r.ok) throw new ApiError(502, 'Cartero: ' + r.error);
  return { enviado_a: usuario.email, cliente: f.nombre };
}
