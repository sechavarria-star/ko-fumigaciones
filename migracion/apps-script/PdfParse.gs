/**
 * Port a JS de backend/pdf_extract.py + backend/informe_parser.py. Misma
 * lógica, mismos umbrales - ver esos archivos Python para el razonamiento
 * completo de cada regex (ya viene de varias rondas de ajuste contra datos
 * reales esta sesión).
 */

// --- extracto bancario: buscar un CUIT y clasificar el movimiento cercano ---

var MOVIMIENTO_KEYWORDS = [
  'Pago a proveedores recibido',
  'Transferencia recibida',
  'Credito transf online banking emp',
  'Crédito transf online banking emp',
  'Credito transferencia por internet',
  'Crédito transferencia por internet',
  // Estos dos faltaban y son cobros reales (el saldo sube). Se colaban de
  // rebote cuando el matcheo miraba una ventana de texto - agarraba la
  // palabra clave del movimiento vecino - y se perdían al pasar a leer cada
  // movimiento por separado. Los usa, entre otros, el consorcio de José
  // Bonifacio. Ojo: la descripción no dice si entra o sale plata, eso lo
  // decide el signo del importe (se filtra por importe > 0).
  'Transferencia pagos a terceros',
  'Transf recibida cvu dif titular',
];

function parseImporte_(s) {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

function cuitPatternSource_(cuit) {
  // Tolera un espacio o guión metido en cualquier punto del CUIT (corte de
  // columna al extraer el texto del PDF) - no solo después del primer dígito.
  return cuit
    .split('')
    .map(function (d) { return d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); })
    .join('[\\s-]*');
}

function buscarCuitEnTexto_(texto, cuit) {
  const pat = new RegExp(cuitPatternSource_(cuit), 'g');
  const amountRe = /\$\s?([\d.]+,\d{2})/g;
  const dateRe = /\b(\d{2}\/\d{2}\/26)\b/g;
  const resultados = [];
  let m;
  while ((m = pat.exec(texto)) !== null) {
    const inicio = Math.max(0, m.index - 250);
    const fin = Math.min(texto.length, m.index + m[0].length + 150);
    const ventana = texto.slice(inicio, fin);

    const tipo = MOVIMIENTO_KEYWORDS.filter(function (k) { return ventana.indexOf(k) !== -1; })[0] || null;

    const fechas = [];
    dateRe.lastIndex = 0;
    let fm;
    while ((fm = dateRe.exec(ventana)) !== null) fechas.push(fm[1]);

    const importes = [];
    amountRe.lastIndex = 0;
    let am;
    while ((am = amountRe.exec(ventana)) !== null) importes.push(parseImporte_(am[1]));

    resultados.push({ tipo: tipo, fecha: fechas.length ? fechas[fechas.length - 1] : null, importes: importes });
    if (pat.lastIndex === m.index) pat.lastIndex++; // guarda contra match vacío
  }
  return resultados;
}

// Un movimiento del resumen ocupa dos líneas:
//   24/04/26 219254 Pago a proveedores recibido $ 260.000,00 $ 5.223.927,81
//   Consorcio de propietarios edi 30714365432 03 02192 54
// (fecha, comprobante, descripción, importe, saldo) + el detalle con el CUIT.
var MOVIMIENTO_RE = /^(\d{2}\/\d{2}\/\d{2})\s+(\d+)\s+(.+?)\s+(-?\$\s?[\d.]+,\d{2})\s+(-?\$\s?[\d.]+,\d{2})$/;

/**
 * Devuelve los movimientos del extracto ya separados en campos.
 *
 * A diferencia de buscarCuitEnTexto_, que mira una ventana de ~250
 * caracteres alrededor del CUIT y junta TODOS los importes que encuentre
 * (el del movimiento, el saldo, y los de los movimientos vecinos), acá cada
 * movimiento trae un único importe: el suyo. Eso hace falta para comparar
 * importes que NO son exactos (retenciones), donde agarrar el importe del
 * vecino daría un candidato inventado.
 *
 * `cuits` sale de buscar los CUIT de clientes conocidos en la línea de
 * detalle. No se usa una regex genérica de 11 dígitos a propósito: la línea
 * suele traer la altura de la calle pegada al CUIT ("Cons prop schiaffino
 * 2029 30535588844") y una regex así se lleva los dígitos equivocados.
 */
function movimientosDelExtracto_(texto, cuitsConocidos) {
  const pats = cuitsConocidos.map(function (c) {
    return { cuit: c, re: new RegExp(cuitPatternSource_(c)) };
  });

  const lineas = texto.split('\n');
  const movs = [];
  for (let i = 0; i < lineas.length; i++) {
    const m = MOVIMIENTO_RE.exec(lineas[i].trim());
    if (!m) continue;

    const detalle = i + 1 < lineas.length ? lineas[i + 1] : '';
    const encontrados = [];
    for (let j = 0; j < pats.length; j++) {
      if (pats[j].re.test(detalle) || pats[j].re.test(lineas[i])) encontrados.push(pats[j].cuit);
    }

    movs.push({
      fecha: m[1],
      descripcion: m[3],
      importe: parseImporte_(m[4].replace(/[$\s]/g, '')),
      cuits: encontrados,
    });
  }
  return movs;
}

// --- informe consolidado: parsear comprobantes ---

var NOISE_PATTERNS = [
  /^KNOCKOUT FUMIGACIONES/,
  /^Informe general de ventas/,
  /^Page \d+ of \d+/,
  /^\d{2}\/\d{2}\/\d{4}$/,
  /^Comprobante\s+Fecha\s+Cliente/,
  /^\d+\)\s+KNOCKOUT FUMIGACIONES/,
  /^Totales de la Empresa/,
  /^TOTALES GENERALES:/,
];
var COMPROBANTE_RE = /^(FC|NC)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+(.*)$/;
var MONEY_LINE_RE = /^(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/;
var ITEM_LINE_RE = /^(-?[\d.]+,\d{2})\s+(\S+)\s+(.*?)\s+(\d{1,3}\.\d{2}%)\s+(-?[\d.]+,\d{2})$/;
var ITEM_LINE_RE_AMOUNT_FIRST = /^(-?[\d.]+,\d{2})\s+(\S+)\s+(.*?)\s+(-?[\d.]+,\d{2})\s+(\d{1,3}\.\d{2}%)$/;

function esRuidoInforme_(linea) {
  return NOISE_PATTERNS.some(function (p) { return p.test(linea); });
}

function parsearInforme_(texto) {
  const lineas = texto
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && !esRuidoInforme_(l); });

  const bloques = [];
  let actual = null;
  lineas.forEach(function (linea) {
    const m = COMPROBANTE_RE.exec(linea);
    if (m) {
      if (actual) bloques.push(actual);
      actual = { tipo: m[1], numeroRaw: m[2], fecha: m[3], clienteRaw: m[4], lineas: [] };
    } else if (actual) {
      actual.lineas.push(linea);
    }
  });
  if (actual) bloques.push(actual);

  const registros = [];
  bloques.forEach(function (b) {
    let total = null;
    const detalleParts = [];
    b.lineas.forEach(function (linea) {
      const mm = MONEY_LINE_RE.exec(linea);
      if (mm) {
        total = parseImporte_(mm[2]);
        return;
      }
      const im = ITEM_LINE_RE.exec(linea) || ITEM_LINE_RE_AMOUNT_FIRST.exec(linea);
      detalleParts.push(im ? im[3].trim() : linea);
    });
    if (total === null) return; // bloque sin línea de total - no debería pasar, se descarta

    const numero = b.numeroRaw.replace(/-[AB]$/, '');
    const partes = b.fecha.split('/');
    const d = partes[0], mo = partes[1], y = partes[2];

    const detalleUnico = [];
    detalleParts.forEach(function (p) {
      if (p && detalleUnico.indexOf(p) === -1) detalleUnico.push(p);
    });

    registros.push({
      tipo: b.tipo,
      numero: numero,
      fecha_emision: d + '/' + mo + '/20' + y,
      periodo: '20' + y + '-' + mo,
      cliente_informe: b.clienteRaw,
      detalle: detalleUnico.join(' - '),
      total: total,
    });
  });
  return registros;
}

// --- matcheo de cliente contra Clientes (sin CUIT en el informe) ---

var STOPWORDS_ = {};
[
  'AV', 'AVDA', 'AVENIDA', 'GRAL', 'GENERAL', 'DE', 'DEL', 'LA', 'LAS', 'LOS', 'SAN', 'SANTA',
  'CONSORCIO', 'PROPIETARIOS', 'PROPIETARIO', 'PROP', 'EDIFICIO', 'EDIF', 'CALLE', 'N',
].forEach(function (w) { STOPWORDS_[w] = true; });

var AUTO_ACCEPT_SCORE_ = 0.9;
var AUTO_ACCEPT_MARGIN_ = 0.15;
var SUGERIR_SCORE_MIN_ = 0.4;

function normalizarTexto_(s) {
  s = (s || '').toUpperCase();
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[.\-`´'"()/#]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokensDe_(s) {
  return normalizarTexto_(s)
    .split(' ')
    .filter(function (t) { return t.length > 1 && !STOPWORDS_[t] && !/^\d+$/.test(t); });
}

function numerosDe_(s) {
  const out = [];
  const re = /\b(\d{2,5})\b/g;
  let m;
  while ((m = re.exec(s || '')) !== null) out.push(m[1]);
  return out;
}

function setDe_(arr) {
  const o = {};
  arr.forEach(function (x) { o[x] = true; });
  return o;
}

function jaccard_(setA, arrB) {
  const keysA = Object.keys(setA);
  if (!keysA.length || !arrB.length) return 0;
  const setB = setDe_(arrB);
  let inter = 0;
  keysA.forEach(function (k) { if (setB[k]) inter++; });
  const union = keysA.length + arrB.length - inter;
  return union === 0 ? 0 : inter / union;
}

function algunoEnComun_(setA, arrB) {
  return arrB.some(function (x) { return setA[x]; });
}

function quitarPrefijoConsorcio_(s) {
  return (s || '').replace(/^CONSORCIO\s*:?\s*(DE\s+PROPIETARIOS\s*)?/i, '').trim();
}

/** Completa `cuit_cliente` (o `cuit_sugerido`/`nombre_sugerido`) en cada registro, in-place. */
function matchearClientes_(registros, clientesFilas) {
  const perfiles = {};
  const numerosACuits = {};

  clientesFilas.forEach(function (c) {
    const toksDir = tokensDe_(c.direccion);
    const toksNom = tokensDe_(c.nombre);
    const numsDir = numerosDe_(c.direccion);
    const numsNom = numerosDe_(c.nombre);
    perfiles[c.cuit] = {
      setTokensDir: setDe_(toksDir),
      numsDir: numsDir,
      setTokensNom: setDe_(toksNom),
      numsNom: numsNom,
      nombre: c.nombre,
    };
    numsDir.concat(numsNom).forEach(function (n) {
      if (!numerosACuits[n]) numerosACuits[n] = [];
      if (numerosACuits[n].indexOf(c.cuit) === -1) numerosACuits[n].push(c.cuit);
    });
  });

  registros.forEach(function (r) {
    const candidato = quitarPrefijoConsorcio_(r.cliente_informe);
    const candTokSet = setDe_(tokensDe_(candidato));
    const candNums = numerosDe_(candidato);

    let candidatos = [];
    candNums.forEach(function (n) {
      (numerosACuits[n] || []).forEach(function (cuit) {
        if (candidatos.indexOf(cuit) === -1) candidatos.push(cuit);
      });
    });
    if (!candidatos.length) candidatos = Object.keys(perfiles);

    const scored = candidatos.map(function (cuit) {
      const p = perfiles[cuit];
      let scoreDir = jaccard_(candTokSet, Object.keys(p.setTokensDir));
      if (candNums.length && algunoEnComun_(setDe_(p.numsDir), candNums)) scoreDir += 0.5;
      let scoreNom = jaccard_(candTokSet, Object.keys(p.setTokensNom));
      if (candNums.length && algunoEnComun_(setDe_(p.numsNom), candNums)) scoreNom += 0.5;
      return { score: Math.max(scoreDir, scoreNom), cuit: cuit };
    });
    scored.sort(function (a, b) { return b.score - a.score; });

    const best = scored[0] || { score: 0, cuit: null };
    const second = scored[1] ? scored[1].score : 0;

    if (best.cuit && best.score >= AUTO_ACCEPT_SCORE_ && best.score - second >= AUTO_ACCEPT_MARGIN_) {
      r.cuit_cliente = best.cuit;
    } else {
      r.cuit_cliente = null;
      if (best.cuit && best.score >= SUGERIR_SCORE_MIN_) {
        r.cuit_sugerido = best.cuit;
        r.nombre_sugerido = perfiles[best.cuit].nombre;
      }
    }
  });
}

function ddmmaaaaAIso_(s) {
  const p = s.split('/');
  return p[2] + '-' + p[1] + '-' + p[0];
}

function isoADdmmaaaa_(iso) {
  const p = iso.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}
