/**
 * Único entry point HTTP. Apps Script Web Apps siempre devuelven HTTP 200
 * (no se puede setear el status code real de la respuesta) - por eso el
 * resultado lógico va codificado adentro del JSON como `status`, y
 * `llamarBackend()` en el frontend tiene que leer ESE campo en vez de
 * `res.ok` / `res.status` de fetch(). Ver docs/admin.js.
 *
 * Body esperado (text/plain, ver README.md - evita el preflight CORS):
 *   { "token": "<id_token>", "action": "<nombre>", ...resto de params }
 *
 * El CORS de la respuesta no lo controla este código: ContentService no
 * expone forma de setear headers de respuesta custom (no hay
 * `Access-Control-Allow-Origin` posible desde acá). Un request "simple"
 * (sin headers custom, text/plain) evita el preflight y en la práctica los
 * Web Apps de Apps Script sí quedan legibles desde fetch() cross-origin -
 * es comportamiento de la infraestructura de Google, no algo que este
 * archivo configure. Si en la prueba real el navegador igual bloquea la
 * respuesta, no hay vuelta de rosca por código: tocaría meter un proxy.
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const usuario = usuarioAutorizado_(body.token);
    return responderOk_(despachar_(body.action, body, usuario));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error('Error no controlado', err, err.stack);
    }
    return responderError_(status, err.message || String(err));
  }
}

// Un GET simple sirve como health check (no necesita token) - útil para el
// mismo tipo de ping que hoy se le hace a /api/health en Render.
function doGet(e) {
  return responderOk_({ salud: 'ok' });
}

// El payload va ANIDADO en `data`, no desparramado al lado de `status`:
// varias acciones devuelven mapas con claves que no controlamos
// (listar_usuarios devuelve {email: {...}}), y aplanarlas metía `status`
// adentro del propio listado - un usuario fantasma llamado "status".
function responderOk_(data) {
  return salida_({ status: 200, data: data === undefined ? null : data });
}

function responderError_(status, detail) {
  return salida_({ status: status, detail: detail });
}

function salida_(cuerpo) {
  return ContentService.createTextOutput(JSON.stringify(cuerpo)).setMimeType(ContentService.MimeType.JSON);
}

function despachar_(action, body, usuario) {
  switch (action) {
    case 'obtener_datos':
      return accObtenerDatos_(usuario);

    case 'confirmar_pago':
      requerirPerfil_(usuario, ['admin', 'supervisor']);
      return accConfirmarPago_(body, usuario);

    case 'importar_informe':
      requerirPerfil_(usuario, ['admin', 'supervisor']);
      return accImportarInforme_(body, usuario);

    case 'confirmar_cuit':
      requerirPerfil_(usuario, ['admin', 'supervisor']);
      return accConfirmarCuit_(body, usuario);

    case 'parse_extracto':
      requerirPerfil_(usuario, ['admin', 'supervisor']);
      return accParseExtracto_(body, usuario);

    case 'consolidar_extractos':
      requerirPerfil_(usuario, ['admin', 'supervisor']);
      return accConsolidarExtractos_(body, usuario);

    case 'upsert_cliente':
      requerirPerfil_(usuario, ['admin', 'supervisor']);
      return accUpsertCliente_(body, usuario);

    // Diagnóstico: devuelve el texto crudo que sacó el OCR del PDF que
    // mandó el que llama, sin tocar la base. Los regex de PdfParse.gs están
    // afinados contra el texto de pdfplumber, y el de Drive no sale igual -
    // sin poder ver el texto, cualquier diferencia de matcheo es a ciegas.
    case 'extraer_texto':
      requerirPerfil_(usuario, ['admin']);
      return { texto: extraerTextoPdf_(body.file_base64, body.filename || 'archivo.pdf') };

    case 'listar_usuarios':
      requerirPerfil_(usuario, ['admin']);
      return accListarUsuarios_();

    case 'upsert_usuario':
      requerirPerfil_(usuario, ['admin']);
      return accUpsertUsuario_(body, usuario);

    default:
      throw new ApiError(404, 'Acción desconocida: ' + action);
  }
}
