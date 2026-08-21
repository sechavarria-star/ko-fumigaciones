// Extracción del texto de un PDF en el navegador, con pdf.js.
//
// Por qué acá y no en el backend: Apps Script no sabe leer un PDF. La única
// opción del lado del servidor es convertirlo a Google Doc con la API de
// Drive, y eso APLANA las tablas - sobre el extracto de Abril 2026 mandaba
// la columna de importes lejos del movimiento al que pertenecía, y el
// matcheo pasaba de 43 pagos a 5. Ver migracion/apps-script/README.md.
//
// pdf.js expone la posición de cada fragmento de texto, así que agrupando
// por Y y ordenando por X se reconstruyen las columnas igual que pdfplumber
// (el backend viejo de Python). Verificado contra el extracto real: los 43
// pagos, idénticos uno por uno.

// pdf.js v4 solo se publica como ES module. Se carga con import() dinámico
// (y no con <script type="module">) para no obligar a que todo el sitio sea
// módulo, y para que el megabyte del worker recién se baje cuando alguien
// sube un PDF de verdad.
let pdfjsPromesa = null;

function cargarPdfJs() {
  if (!pdfjsPromesa) {
    pdfjsPromesa = import("./vendor/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", document.baseURI).href;
      return pdfjs;
    });
  }
  return pdfjsPromesa;
}

/**
 * Devuelve el texto del PDF respetando el orden visual (arriba->abajo,
 * izquierda->derecha). Si el PDF es una imagen escaneada devuelve "" (no
 * tiene capa de texto): ahí hay que caer al OCR del backend.
 */
async function extraerTextoDePdf(file) {
  const pdfjs = await cargarPdfJs();
  const datos = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: datos }).promise;

  const lineasTodas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pagina = await doc.getPage(p);
    const contenido = await pagina.getTextContent();

    // Agrupar por Y redondeado: cada grupo es una línea visual, aunque el
    // PDF la tenga guardada como fragmentos sueltos y desordenados.
    const porFila = new Map();
    for (const item of contenido.items) {
      if (!item.str) continue;
      const x = item.transform[4];
      const y = Math.round(item.transform[5]);
      if (!porFila.has(y)) porFila.set(y, []);
      porFila.get(y).push({ x, str: item.str });
    }

    // Y descendente = de arriba hacia abajo; dentro de la línea, X ascendente.
    const filas = [...porFila.keys()].sort((a, b) => b - a);
    for (const y of filas) {
      const texto = porFila
        .get(y)
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      lineasTodas.push(texto);
    }
  }

  await doc.destroy();
  return lineasTodas.join("\n");
}

/**
 * Prepara lo que se le manda al backend para un PDF: el texto si se pudo
 * leer, y si no el archivo en base64 para que lo pase por OCR.
 */
async function payloadDePdf(file) {
  let texto = "";
  try {
    texto = await extraerTextoDePdf(file);
  } catch (err) {
    // Un PDF roto o con un formato que pdf.js no soporta no tiene por qué
    // cortar la subida: que decida el OCR del backend.
    console.warn("pdf.js no pudo leer el PDF, se manda para OCR:", err);
  }

  if (texto.trim()) return { filename: file.name, texto };
  return { filename: file.name, file_base64: await aBase64(file) };
}

function aBase64(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    // readAsDataURL da "data:application/pdf;base64,XXXX" - solo interesa
    // lo que viene después de la coma.
    lector.onload = () => resolve(String(lector.result).split(",")[1]);
    lector.onerror = () => reject(lector.error);
    lector.readAsDataURL(file);
  });
}
