/**
 * Mailing a clientes con saldo pendiente.
 *
 * Toda la logica (a quien, con que saldo, que texto) esta en Supabase, en la
 * vista ko.v_mailing (ver migracion/supabase/10_mailing.sql). Aca solo se lee
 * esa vista y se manda lo que ya viene armado - nunca un texto que mande el
 * navegador. Del front solo se acepta QUE clientes, no QUE decirles.
 */

// Un template con esto adentro todavia tiene datos sin completar (CBU,
// firma) y no se puede mandar.
var MARCA_SIN_COMPLETAR = '[COMPLETAR';

function templatesActivos_() {
  return sbGet('mailing_templates', 'select=id,descripcion,saldo_min,saldo_max,dias_entre_envios,asunto,cuerpo&activo=is.true&order=id');
}

function filasMailing_(templateId) {
  return sbGetTodo(
    'v_mailing',
    'select=cuit,nombre,email,saldo,cantidad_facturas,asunto,cuerpo,remitente_nombre,responder_a,ultimo_envio,estado' +
      '&template_id=eq.' + encodeURIComponent(templateId),
    'cuit'
  ).map(function (f) {
    f.saldo = Number(f.saldo);
    return f;
  });
}

function sinCompletar_(t) {
  return t.asunto.indexOf(MARCA_SIN_COMPLETAR) !== -1 || t.cuerpo.indexOf(MARCA_SIN_COMPLETAR) !== -1;
}

// Cada direccion cuenta por separado contra la cuota diaria de Gmail.
function cantidadDirecciones_(email) {
  return email.split(',').filter(function (e) { return e.trim(); }).length;
}

/**
 * Templates activos y, si se pide uno, sus destinatarios con el mail armado.
 * No manda nada.
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

  const resultado = { templates: templates, cuota: MailApp.getRemainingDailyQuota() };
  if (body.template_id) resultado.destinatarios = filasMailing_(body.template_id);
  return resultado;
}

/**
 * Manda el template a los CUIT pedidos.
 *
 * Vuelve a leer la vista en el momento de mandar: el saldo y el estado son
 * los de ahora, no los de cuando se abrio la vista previa. Un cliente que
 * pago entre medio, o al que otro ya le mando, queda afuera solo.
 *
 * Registra cada envio apenas sale (no al final), asi si Apps Script corta por
 * tiempo lo que ya se mando queda anotado y no se repite.
 */
function accMailingEnviar_(body, usuario) {
  const templateId = body.template_id;
  const pedidos = body.cuits || [];
  if (!templateId) throw new ApiError(400, 'Falta template_id');
  if (!pedidos.length) throw new ApiError(400, 'No se eligió ningún cliente');

  const t = sbGet('mailing_templates', 'select=id,asunto,cuerpo,activo&id=eq.' + encodeURIComponent(templateId))[0];
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
  const cuota = MailApp.getRemainingDailyQuota();
  if (direcciones > cuota) {
    throw new ApiError(400, 'Gmail permite ' + cuota + ' destinatarios más por hoy y este envío tiene ' + direcciones + '. Mandá menos o esperá a mañana.');
  }

  const enviados = [];
  const fallidos = [];
  aEnviar.forEach(function (f) {
    try {
      const opciones = { name: f.remitente_nombre };
      if (f.responder_a) opciones.replyTo = f.responder_a;
      MailApp.sendEmail(f.email, f.asunto, f.cuerpo, opciones);
    } catch (err) {
      fallidos.push({ cuit: f.cuit, nombre: f.nombre, error: err.message || String(err) });
      return;
    }
    sbInsert('mailing_envios', [{
      template_id: templateId,
      cuit_cliente: f.cuit,
      email: f.email,
      saldo: f.saldo,
      asunto: f.asunto,
      cuerpo: f.cuerpo,
      enviado_por: usuario.email,
    }]);
    enviados.push({ cuit: f.cuit, nombre: f.nombre });
  });

  return { enviados: enviados, omitidos: omitidos, fallidos: fallidos };
}

/**
 * Para correr A MANO desde el editor (Ejecutar > autorizarGmail), una sola
 * vez: dispara el pedido del permiso "Enviar correo en tu nombre". Correr
 * otra funcion no siempre lo pide, y en la pantalla de permisos con casillas
 * hay que tildar ese en particular. Si loguea la cuota, quedo autorizado.
 */
function autorizarGmail() {
  console.log('Cuota de Gmail disponible hoy: ' + MailApp.getRemainingDailyQuota());
}
