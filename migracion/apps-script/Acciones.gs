/**
 * Un handler por `action` de doPost. Port directo de cada endpoint de
 * backend/main.py - mismo comportamiento, mismos mensajes de error.
 */

// Cuanto puede quedar por debajo del total de la factura un cobro para que
// igual se ofrezca como candidato "con retencion". Medido sobre los clientes
// reales que retienen: Diagnostico Medico ~0,3%, Clinica Delta 1,2%-2,9%,
// Rockwell ~3,5%, y varios consorcios entre 7% y 9,6%. 12% deja margen sin
// llegar a importes que ya serian de otra factura.
// Estos candidatos NUNCA se confirman solos: van a una cola de revision.
var RETENCION_MAX = 0.12;

// --- Tablero (lectura) ---
function accObtenerDatos_(usuario) {
  // sbGetTodo (no sbGet): las tres tablas superan o pueden superar las 1000
  // filas del límite de PostgREST - ver el comentario en Supabase.gs.
  const clientesFilas = sbGetTodo('clientes', 'select=cuit,nombre,condicion_iva,direccion,provincia', 'cuit');
  const clientes = {};
  clientesFilas.forEach(function (c) {
    clientes[c.cuit] = { nombre: c.nombre, condicion_iva: c.condicion_iva, direccion: c.direccion, provincia: c.provincia };
  });

  const facturas = sbGetTodo(
    'facturas',
    'select=numero,fecha_emision,periodo,cuit_cliente,cliente_informe,detalle,total,tipo,cuit_sugerido,nombre_sugerido',
    'numero'
  );
  facturas.forEach(function (f) { f.fecha_emision = isoADdmmaaaa_(f.fecha_emision); });

  const pagos = sbGetTodo(
    'pagos',
    'select=factura_numero,cuit_cliente,monto,retencion,origen,extracto,tipo_movimiento,fecha_aprox,numero_transaccion,confirmado_por,fecha_confirmacion',
    'id'
  );

  // Cuenta corriente: lo que entro al banco por cliente, imputado o no. Se
  // manda agregado (no fila por fila) porque el tablero solo necesita el
  // total por CUIT y son ~900 movimientos.
  const cobros = {};
  sbGetTodo('cobros', 'select=cuit_cliente,monto', 'id').forEach(function (c) {
    cobros[c.cuit_cliente] = (cobros[c.cuit_cliente] || 0) + Number(c.monto);
  });

  return { clientes: clientes, facturas: facturas, pagos: pagos, cobros: cobros, yo: usuario };
}

// --- 1) confirmar pago manual ---
function accConfirmarPago_(body, usuario) {
  const pago = {
    factura_numero: body.factura_numero,
    cuit_cliente: body.cuit_cliente,
    monto: null,
    origen: 'manual',
    extracto: null,
    tipo_movimiento: null,
    fecha_aprox: null,
    numero_transaccion: body.numero_transaccion,
    confirmado_por: usuario.email,
    fecha_confirmacion: body.fecha_ingreso,
  };
  try {
    // el UNIQUE de pagos.factura_numero es quien realmente evita el
    // duplicado - PostgREST traduce esa violación a un 409 solo, sin
    // necesidad de leer-antes-de-escribir como con el JSON en GitHub.
    return sbInsert('pagos', [pago])[0];
  } catch (err) {
    if (err instanceof SbError && err.status === 409) {
      throw new ApiError(409, 'Esa factura ya tiene un pago registrado');
    }
    throw err;
  }
}

// --- 2) informe consolidado mensual ---
// Se sube un informe por mes (no el acumulado completo cada vez): upsert
// por número de comprobante, nunca reemplaza toda la tabla. Si una factura
// ya tenía el CUIT confirmado (a mano o de una carga previa), se conserva.
function accImportarInforme_(body, usuario) {
  const texto = textoDelPdf_(body, 'informe.pdf');

  const registros = parsearInforme_(texto);
  if (!registros.length) throw new ApiError(422, 'No se pudo leer ningún comprobante en ese PDF');

  const clientesFilas = sbGetTodo('clientes', 'select=cuit,nombre,direccion', 'cuit');
  matchearClientes_(registros, clientesFilas);

  // Tiene que traer TODAS: si el listado viene truncado, las facturas que
  // falten se ven como nuevas y el upsert les pisa el cuit_cliente ya
  // confirmado con el que sugiera el informe.
  const existentes = sbGetTodo('facturas', 'select=numero,cuit_cliente', 'numero');
  const existentesPorNumero = {};
  existentes.forEach(function (f) { existentesPorNumero[f.numero] = f; });

  let agregadas = 0;
  let actualizadas = 0;
  const filas = registros.map(function (r) {
    const anterior = existentesPorNumero[r.numero];
    const yaConfirmado = anterior && anterior.cuit_cliente;
    if (anterior) actualizadas++; else agregadas++;

    return {
      numero: r.numero,
      fecha_emision: ddmmaaaaAIso_(r.fecha_emision),
      periodo: r.periodo,
      cuit_cliente: yaConfirmado ? anterior.cuit_cliente : r.cuit_cliente || null,
      cliente_informe: r.cliente_informe,
      detalle: r.detalle,
      total: r.total,
      tipo: r.tipo,
      cuit_sugerido: yaConfirmado ? null : r.cuit_sugerido || null,
      nombre_sugerido: yaConfirmado ? null : r.nombre_sugerido || null,
    };
  });

  // en tandas para no mandar un solo POST gigante con ~1200 filas
  const TANDA = 200;
  for (let i = 0; i < filas.length; i += TANDA) {
    sbUpsert('facturas', filas.slice(i, i + TANDA), 'numero');
  }

  const totalEnBase = existentes.length + agregadas;
  const pendientes = sbGetTodo('facturas', 'select=numero&cuit_cliente=is.null', 'numero').length;

  return { agregadas: agregadas, actualizadas: actualizadas, total_en_base: totalEnBase, pendientes: pendientes };
}

// Resuelve a mano las facturas que el matcheo automático dejó sin CUIT -
// aplica el mismo CUIT a TODAS las que compartan el mismo cliente_informe.
function accConfirmarCuit_(body, usuario) {
  const clienteInforme = body.cliente_informe;
  const cuit = body.cuit_cliente || '';
  if (!clienteInforme) throw new ApiError(400, 'Falta cliente_informe');
  if (!/^\d{11}$/.test(cuit)) throw new ApiError(400, 'El CUIT tiene que tener 11 dígitos');

  const clienteFilas = sbGet('clientes', 'select=cuit&cuit=eq.' + encodeURIComponent(cuit));
  if (!clienteFilas.length) throw new ApiError(400, 'Ese CUIT no está cargado en Clientes - agregalo ahí primero');

  const pendientes = sbGetTodo(
    'facturas',
    'select=numero&cliente_informe=eq.' + encodeURIComponent(clienteInforme) + '&cuit_cliente=is.null',
    'numero'
  );
  if (!pendientes.length) throw new ApiError(404, 'No hay facturas pendientes con ese nombre');

  const numeros = pendientes.map(function (f) { return f.numero; });
  // un solo UPDATE con IN(...) - atómico, sin ciclo leer-modificar-escribir
  const resueltas = sbUpdate(
    'facturas',
    'numero=in.(' + numeros.map(encodeURIComponent).join(',') + ')',
    { cuit_cliente: cuit, cuit_sugerido: null, nombre_sugerido: null }
  );
  return { resueltas: resueltas };
}

// --- 3) extractos ---
// Solo calcula candidatos - no escribe nada. El frontend acumula la cola y
// recién consolidar_extractos confirma de verdad.
function accParseExtracto_(body, usuario) {
  const texto = textoDelPdf_(body, 'extracto.pdf');

  const nombrePorCuit = {};
  sbGetTodo('clientes', 'select=cuit,nombre', 'cuit').forEach(function (c) { nombrePorCuit[c.cuit] = c.nombre; });

  const pagos = sbGetTodo('pagos', 'select=factura_numero,cuit_cliente,monto,fecha_aprox,mov_firma', 'id');

  const yaPagadas = {};
  pagos.forEach(function (p) { yaPagadas[p.factura_numero] = true; });

  // Movimientos que YA se conciliaron alguna vez.
  //
  // Sin esto, volver a subir el mismo extracto genera pagos inventados: las
  // facturas que ese archivo ya salvó salen de la lista de pendientes, así
  // que el mismo movimiento del banco pasa a reclamar la SIGUIENTE factura
  // impaga. Medido sobre los 4 extractos reales: 27 pagos falsos en la
  // segunda subida. Que la factura no se pueda pagar dos veces (el UNIQUE)
  // no alcanza - acá el problema es el movimiento usado dos veces.
  //
  // La firma lleva la fecha a propósito: estos clientes son abonos
  // mensuales, o sea que un mismo CUIT paga el mismo importe todos los
  // meses, y sin la fecha se descartarían pagos legítimos.
  // Si el pago tiene mov_firma guardada se usa esa, que es el dato explícito.
  // Reconstruirla desde (cuit, monto, fecha) solo sirve cuando el pago vale
  // lo mismo que el movimiento, y eso NO pasa en los pagos que cubren varias
  // facturas: ahí cada uno vale lo de su factura. Los pagos viejos (sin la
  // columna) siguen por el camino reconstruido.
  //
  // Un movimiento que salvó varias facturas deja varios pagos con la MISMA
  // firma; se cuenta una sola vez, porque un movimiento es uno solo.
  const usados = {};
  const grupoContado = {};
  pagos.forEach(function (p) {
    let k = p.mov_firma;
    if (!k) {
      if (!p.fecha_aprox) return;
      k = firmaMovimiento_(p.cuit_cliente, p.monto, p.fecha_aprox);
      usados[k] = (usados[k] || 0) + 1;
      return;
    }
    if (grupoContado[k]) return;
    grupoContado[k] = true;
    usados[k] = (usados[k] || 0) + 1;
  });

  // las facturas pendientes de validar (sin CUIT) no tienen con qué buscar
  const pendientes = sbGetTodo('facturas', 'select=numero,cuit_cliente,total', 'numero').filter(function (f) {
    return f.cuit_cliente && !yaPagadas[f.numero];
  });

  // Más viejas primero: los números de comprobante son crecientes en el
  // tiempo, y saldar la más vieja es el criterio contable habitual.
  const porCuit = {};
  pendientes.forEach(function (f) {
    if (!porCuit[f.cuit_cliente]) porCuit[f.cuit_cliente] = [];
    porCuit[f.cuit_cliente].push(f);
  });
  Object.keys(porCuit).forEach(function (c) {
    porCuit[c].sort(function (a, b) { return a.numero < b.numero ? -1 : a.numero > b.numero ? 1 : 0; });
  });

  // Se recorren los MOVIMIENTOS, no las facturas, y cada uno salda como
  // mucho UNA. Al revés era el bug que dejaba plata mal conciliada:
  // preguntando "¿hay un crédito de este CUIT por $45.000?" daba que sí para
  // las 5 facturas de $45.000 impagas, aunque hubiera un solo pago.
  const cobros = movimientosDelExtracto_(texto, Object.keys(porCuit)).filter(function (mov) {
    return mov.importe > 0 && mov.cuits.length && esCobro_(mov.descripcion);
  });

  const tomadas = {};
  const matches = [];
  const libres = [];

  // Pasada 1: importe exacto. Va entera antes de la de retenciones, si no un
  // cobro con retención podría quedarse con una factura que otro movimiento
  // necesitaba para un match exacto.
  cobros.forEach(function (mov) {
    for (let c = 0; c < mov.cuits.length; c++) {
      const cuit = mov.cuits[c];
      const k = firmaMovimiento_(cuit, mov.importe, mov.fecha);
      if (usados[k]) { usados[k] -= 1; return; } // ya conciliado en otra subida

      const f = elegirFactura_(porCuit[cuit], tomadas, function (f) {
        return Math.abs(f.total - mov.importe) < 0.005;
      });
      if (!f) continue;
      tomadas[f.numero] = true;
      matches.push({
        factura_numero: f.numero,
        cuit_cliente: cuit,
        nombre_cliente: nombrePorCuit[cuit] || cuit,
        monto: f.total,
        tipo_movimiento: mov.descripcion,
        fecha_aprox: mov.fecha,
        mov_firma: k,
      });
      return;
    }
    libres.push(mov);
  });

  // Pasada 2: un cobro que salda VARIAS facturas juntas.
  //
  // Hay clientes que dejan pasar dos o tres meses y despues pagan todo en una
  // transferencia. Ese importe no coincide con ninguna factura sola, pero sí
  // con la suma de las mas viejas impagas. Se prueban hasta 6 seguidas.
  //
  // Se exige coincidencia al centavo, y aun asi puede haber mas de un
  // subconjunto que de el mismo total; se toma el que arranca en la mas
  // vieja, que es el criterio contable habitual. Como el saldo del cliente
  // ahora sale de ko.cobros y no de esta imputacion, elegir un subconjunto
  // equivocado cambia que factura figura cobrada, no cuanto debe.
  const libres2 = [];
  libres.forEach(function (mov) {
    let saldo = false;
    for (let c = 0; c < mov.cuits.length && !saldo; c++) {
      const cuit = mov.cuits[c];
      const grupo = elegirGrupoQueSuma_(porCuit[cuit], tomadas, mov.importe);
      if (!grupo) continue;
      const k = firmaMovimiento_(cuit, mov.importe, mov.fecha);
      grupo.forEach(function (f) {
        tomadas[f.numero] = true;
        matches.push({
          factura_numero: f.numero,
          cuit_cliente: cuit,
          nombre_cliente: nombrePorCuit[cuit] || cuit,
          monto: f.total,
          tipo_movimiento: mov.descripcion,
          fecha_aprox: mov.fecha,
          mov_firma: k,
          // para que el frontend pueda mostrar "1 de 3 facturas de un mismo pago"
          grupo_total: mov.importe,
          grupo_cantidad: grupo.length,
        });
      });
      saldo = true;
    }
    if (!saldo) libres2.push(mov);
  });

  // Pasada 3: cobros con retención, sobre lo que quedó sin usar.
  // Nunca se confirman solos - van a una cola de revisión en el frontend.
  const aproximados = [];
  libres2.forEach(function (mov) {
    for (let c = 0; c < mov.cuits.length; c++) {
      const cuit = mov.cuits[c];
      const f = elegirFactura_(porCuit[cuit], tomadas, function (f) {
        const ret = f.total - mov.importe;
        return ret > 0 && ret <= f.total * RETENCION_MAX;
      });
      if (!f) continue;
      tomadas[f.numero] = true;
      const retencion = Math.round((f.total - mov.importe) * 100) / 100;
      aproximados.push({
        factura_numero: f.numero,
        cuit_cliente: cuit,
        nombre_cliente: nombrePorCuit[cuit] || cuit,
        monto: mov.importe,
        monto_factura: f.total,
        retencion: retencion,
        porcentaje: Math.round((retencion / f.total) * 10000) / 100,
        tipo_movimiento: mov.descripcion,
        fecha_aprox: mov.fecha,
        mov_firma: firmaMovimiento_(cuit, mov.importe, mov.fecha),
      });
      return;
    }
  });

  return { extracto_label: body.filename, matches: matches, aproximados: aproximados };
}

/**
 * Busca un tramo de facturas consecutivas (las mas viejas primero) cuya suma
 * sea exactamente `objetivo`. Devuelve el tramo o null.
 *
 * Solo tramos consecutivos, no cualquier combinacion: un cliente al dia paga
 * en orden, y probar todos los subconjuntos multiplicaria las coincidencias
 * casuales - con 14 facturas hay 16.383 combinaciones, y alguna va a dar el
 * total por azar.
 */
function elegirGrupoQueSuma_(facturas, tomadas, objetivo) {
  if (!facturas) return null;
  const MAX = 6; // mas de medio año junto ya no es un atraso, es otra cosa
  const libres = facturas.filter(function (f) { return !tomadas[f.numero] && f.total > 0; });

  for (let ini = 0; ini < libres.length; ini++) {
    let suma = 0;
    for (let n = ini; n < Math.min(ini + MAX, libres.length); n++) {
      suma += libres[n].total;
      if (suma > objetivo + 0.005) break; // ya se paso: alargar no ayuda
      if (n > ini && Math.abs(suma - objetivo) < 0.005) return libres.slice(ini, n + 1);
    }
  }
  return null;
}

/**
 * Registra en ko.cobros todo lo que entro al banco de clientes conocidos,
 * se haya podido imputar a una factura o no.
 *
 * Es el hecho bancario, no una interpretacion: por eso se guarda entero y
 * aparte de ko.pagos (que dice que factura quedo saldada). El saldo del
 * cliente sale de restar esto a lo facturado, y asi cierra aunque el cliente
 * haya pagado tres meses juntos en una sola transferencia.
 *
 * Es idempotente: la firma incluye el extracto y un orden, asi que volver a
 * subir el mismo archivo no duplica nada.
 */
function accRegistrarCobros_(body, usuario) {
  const texto = textoDelPdf_(body, 'extracto.pdf');
  const etiqueta = body.filename || '';

  const cuits = sbGetTodo('clientes', 'select=cuit', 'cuit').map(function (c) { return c.cuit; });

  const vistos = {};
  const filas = [];
  movimientosDelExtracto_(texto, cuits).forEach(function (mov) {
    if (mov.importe <= 0 || !mov.cuits.length || !esCobro_(mov.descripcion)) return;
    mov.cuits.forEach(function (cuit) {
      const base = etiqueta + '|' + firmaMovimiento_(cuit, mov.importe, mov.fecha);
      const orden = (vistos[base] = (vistos[base] || 0) + 1);
      filas.push({
        cuit_cliente: cuit,
        monto: mov.importe,
        fecha: mov.fecha,
        tipo_movimiento: mov.descripcion,
        extracto: etiqueta,
        firma: base + '|' + orden,
        orden: orden,
      });
    });
  });

  if (!filas.length) return { registrados: 0, total: 0 };

  const TANDA = 200;
  for (let i = 0; i < filas.length; i += TANDA) {
    sbUpsert('cobros', filas.slice(i, i + TANDA), 'firma');
  }
  return {
    registrados: filas.length,
    total: filas.reduce(function (s, f) { return s + f.monto; }, 0),
  };
}

function firmaMovimiento_(cuit, importe, fecha) {
  return cuit + '|' + Number(importe).toFixed(2) + '|' + fecha;
}

function esCobro_(descripcion) {
  return MOVIMIENTO_KEYWORDS.some(function (k) { return descripcion.indexOf(k) !== -1; });
}

function elegirFactura_(facturas, tomadas, cumple) {
  if (!facturas) return null;
  for (let i = 0; i < facturas.length; i++) {
    if (tomadas[facturas[i].numero]) continue;
    if (cumple(facturas[i])) return facturas[i];
  }
  return null;
}

function accConsolidarExtractos_(body, usuario) {
  const matches = body.matches || [];
  if (!matches.length) throw new ApiError(400, 'No hay pagos para consolidar');

  const yaPagadas = {};
  sbGetTodo('pagos', 'select=factura_numero', 'id').forEach(function (p) { yaPagadas[p.factura_numero] = true; });

  const confirmados = [];
  const omitidos = [];
  const vistos = {};
  matches.forEach(function (m) {
    const numero = m.factura_numero;
    if (yaPagadas[numero] || vistos[numero]) { omitidos.push(numero); return; }
    vistos[numero] = true;
    confirmados.push({
      factura_numero: numero,
      cuit_cliente: m.cuit_cliente,
      monto: m.monto,
      // `monto` es lo que entró al banco; si el cliente retuvo, la diferencia
      // contra el total de la factura queda registrada aparte (la factura se
      // considera saldada igual: la retención es crédito fiscal).
      retencion: m.retencion || 0,
      origen: m.retencion ? 'retencion' : 'auto',
      // qué movimiento del extracto lo originó: es lo que evita volver a
      // usar el mismo cobro si se resube el archivo, y ademas agrupa los
      // pagos que se saldaron con una misma transferencia.
      mov_firma: m.mov_firma || null,
      extracto: m.extracto_label || null,
      tipo_movimiento: m.tipo_movimiento || null,
      fecha_aprox: m.fecha_aprox || null,
      numero_transaccion: null,
      confirmado_por: usuario.email,
      fecha_confirmacion: Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'yyyy-MM-dd'),
    });
  });

  if (confirmados.length) {
    // el UNIQUE de pagos.factura_numero protege igual si algo se coló entre
    // el chequeo de arriba y este insert - constraint real, no una
    // condición de carrera resuelta a mano.
    sbInsert('pagos', confirmados);
  }
  return { confirmados: confirmados, omitidos: omitidos };
}

// --- 4) clientes ---
function accUpsertCliente_(body, usuario) {
  const cuit = body.cuit || '';
  if (!/^\d{11}$/.test(cuit)) throw new ApiError(400, 'El CUIT tiene que tener 11 dígitos');
  const fila = {
    cuit: cuit,
    nombre: body.nombre,
    condicion_iva: body.condicion_iva || '',
    direccion: body.direccion || '',
    provincia: body.provincia || '',
  };
  return sbUpsert('clientes', [fila], 'cuit')[0];
}

// --- 5) usuarios (solo admin) ---
function accListarUsuarios_() {
  const filas = sbGetTodo('usuarios', 'select=email,nombre,apellido,perfil', 'email');
  const usuarios = {};
  filas.forEach(function (u) { usuarios[u.email] = { nombre: u.nombre, apellido: u.apellido, perfil: u.perfil }; });
  return usuarios;
}

function accUpsertUsuario_(body, usuario) {
  const email = (body.email || '').trim().toLowerCase();
  const perfil = body.perfil || '';
  const perfilesValidos = ['admin', 'supervisor', 'usuario'];
  if (!email || email.indexOf('@') === -1) throw new ApiError(400, 'Email inválido');
  if (perfilesValidos.indexOf(perfil) === -1) {
    throw new ApiError(400, 'Perfil inválido, tiene que ser uno de: ' + perfilesValidos.join(', '));
  }
  const fila = {
    email: email,
    nombre: (body.nombre || '').trim(),
    apellido: (body.apellido || '').trim(),
    perfil: perfil,
  };
  return sbUpsert('usuarios', [fila], 'email')[0];
}
