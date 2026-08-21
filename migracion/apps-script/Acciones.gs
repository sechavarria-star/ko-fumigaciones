/**
 * Un handler por `action` de doPost. Port directo de cada endpoint de
 * backend/main.py - mismo comportamiento, mismos mensajes de error.
 */

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
    'select=factura_numero,cuit_cliente,monto,origen,extracto,tipo_movimiento,fecha_aprox,numero_transaccion,confirmado_por,fecha_confirmacion',
    'id'
  );

  return { clientes: clientes, facturas: facturas, pagos: pagos, yo: usuario };
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
  if (!body.file_base64) throw new ApiError(422, 'Falta el archivo');
  const texto = extraerTextoPdf_(body.file_base64, body.filename || 'informe.pdf');

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
// Solo calcula candidatos (CUIT + monto exacto) - no escribe nada. El
// frontend acumula la cola y recién /consolidar confirma de verdad.
function accParseExtracto_(body, usuario) {
  if (!body.file_base64) throw new ApiError(422, 'Falta el archivo');
  const texto = extraerTextoPdf_(body.file_base64, body.filename || 'extracto.pdf');

  const nombrePorCuit = {};
  sbGetTodo('clientes', 'select=cuit,nombre', 'cuit').forEach(function (c) { nombrePorCuit[c.cuit] = c.nombre; });

  // Truncar esta lectura haría re-conciliar pagos ya cargados (falso
  // duplicado); el UNIQUE de la base lo frena, pero mejor no llegar ahí.
  const yaPagadas = {};
  sbGetTodo('pagos', 'select=factura_numero', 'id').forEach(function (p) { yaPagadas[p.factura_numero] = true; });

  // las facturas pendientes de validar (sin CUIT) no tienen con qué buscar
  const pendientes = sbGetTodo('facturas', 'select=numero,cuit_cliente,total', 'numero').filter(function (f) {
    return f.cuit_cliente && !yaPagadas[f.numero];
  });

  const matches = [];
  pendientes.forEach(function (f) {
    const hits = buscarCuitEnTexto_(texto, f.cuit_cliente);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.tipo && h.importes.indexOf(f.total) !== -1) {
        matches.push({
          factura_numero: f.numero,
          cuit_cliente: f.cuit_cliente,
          nombre_cliente: nombrePorCuit[f.cuit_cliente] || f.cuit_cliente,
          monto: f.total,
          tipo_movimiento: h.tipo,
          fecha_aprox: h.fecha,
        });
        break; // una coincidencia por factura alcanza
      }
    }
  });

  return { extracto_label: body.filename, matches: matches };
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
      origen: 'auto',
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
