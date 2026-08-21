/**
 * De dónde sale el texto de un PDF, en orden de preferencia:
 *
 *   1. `body.texto` - lo extrajo el navegador con pdf.js antes de mandarlo.
 *      Es el camino bueno: pdf.js conserva las coordenadas de cada palabra,
 *      así que reconstruye las columnas igual que pdfplumber (probado sobre
 *      el extracto de Abril: 43 matches, idénticos a los del backend Python).
 *
 *   2. `body.file_base64` - OCR de Drive, solo como respaldo para PDFs
 *      escaneados (sin capa de texto), donde pdf.js no puede hacer nada.
 *      OJO: la conversión de Drive APLANA la tabla - sobre ese mismo
 *      extracto devolvió 5 matches en vez de 43, porque manda la columna de
 *      importes a otra parte del documento, lejos de su movimiento. Sirve
 *      para PDFs de una sola factura (layout simple), no para extractos.
 */
function textoDelPdf_(body, nombrePorDefecto) {
  if (body.texto && body.texto.trim()) return body.texto;
  if (body.file_base64) return extraerTextoPdf_(body.file_base64, body.filename || nombrePorDefecto);
  throw new ApiError(422, 'Falta el archivo');
}

/**
 * Respaldo para PDFs escaneados: los sube a Drive convirtiéndolos a Google
 * Doc con OCR y devuelve el texto plano.
 *
 * Requiere el servicio avanzado Drive API (v2) habilitado en el editor
 * (Services + > Drive API) - sin eso `Drive.Files.insert` no existe.
 *
 * No usarlo para documentos con tablas: ver la advertencia en textoDelPdf_.
 */
function extraerTextoPdf_(base64, nombreArchivo) {
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, 'application/pdf', nombreArchivo);

  // El mimeType del recurso describe lo que se SUBE (el PDF), no el
  // resultado: la conversión a Doc se pide con `convert: true`. Declararlo
  // como GOOGLE_DOCS hace que Drive crea que el origen ya es un Doc y
  // rechace el pedido con "OCR is not supported for files of type
  // application/vnd.google-apps.document".
  const recurso = {
    title: '[OCR temporal] ' + nombreArchivo,
    mimeType: 'application/pdf',
  };
  const archivo = Drive.Files.insert(recurso, blob, {
    convert: true,
    ocr: true,
    ocrLanguage: 'es',
  });

  try {
    const doc = DocumentApp.openById(archivo.id);
    return doc.getBody().getText();
  } finally {
    // no dejar el Doc convertido dando vueltas en Drive
    DriveApp.getFileById(archivo.id).setTrashed(true);
  }
}

