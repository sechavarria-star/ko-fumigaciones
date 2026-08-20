/**
 * Reemplaza a pdfplumber/pypdf/PyMuPDF/Vision API: convierte el PDF a
 * Google Doc vía la API de Drive (v2, servicio avanzado) con OCR, y
 * devuelve el texto plano. Sirve tanto para PDFs con texto real como
 * escaneados - a diferencia del backend de Python, acá no hace falta un
 * fallback en dos pasos (intentar texto directo, si falla recién OCR).
 *
 * Requiere: en el editor de Apps Script, Services (+) > Drive API (v2) -
 * sin esto `Drive.Files.insert` no existe.
 *
 * SIN VALIDAR TODAVÍA CONTRA ARCHIVOS REALES. El texto que devuelve el OCR
 * de Drive puede tener saltos de línea o espaciado distinto al de
 * pdfplumber, que es contra lo que están afinados los regex de
 * PdfParse.gs. Antes de dar esto por andando: subir el informe real y un
 * extracto real, y comparar contra los números ya conocidos (1192
 * comprobantes, $107.576.630,41 - ver migracion/apps-script/README.md).
 */
function extraerTextoPdf_(base64, nombreArchivo) {
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, 'application/pdf', nombreArchivo);

  const recurso = {
    title: '[OCR temporal] ' + nombreArchivo,
    mimeType: MimeType.GOOGLE_DOCS,
  };
  const archivo = Drive.Files.insert(recurso, blob, { ocr: true, ocrLanguage: 'es' });

  try {
    const doc = DocumentApp.openById(archivo.id);
    return doc.getBody().getText();
  } finally {
    // no dejar el Doc convertido dando vueltas en Drive
    DriveApp.getFileById(archivo.id).setTrashed(true);
  }
}
