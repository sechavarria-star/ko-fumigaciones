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
  const clientesFilas = sbGetTodo('clientes', 'select=cuit,nombre,condicion_iva,direccion,provincia,email,paga_por,sin_cobro,sin_cobro_hasta,retiene,ret_iva,ret_iibb_arba,ret_iibb_agip,ret_ganancias', 'cuit');
  const clientes = {};
  clientesFilas.forEach(function (c) {
    clientes[c.cuit] = {
      nombre: c.nombre,
      condicion_iva: c.condicion_iva,
      direccion: c.direccion,
      provincia: c.provincia,
      email: c.email || '',
      paga_por: c.paga_por || '',
      sin_cobro: c.sin_cobro || '',
      sin_cobro_hasta: c.sin_cobro_hasta || '',
      retiene: !!c.retiene,
      ret_iva: !!c.ret_iva,
      ret_iibb_arba: !!c.ret_iibb_arba,
      ret_iibb_agip: !!c.ret_iibb_agip,
      ret_ganancias: !!c.ret_ganancias,
    };
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

  // Cuenta corriente: lo que entro al banco por cliente, imputado o no.
  //
  // Va el detalle y no solo el total porque el estado de cuenta de cada
  // cliente los muestra intercalados con las facturas. Sin eso, un consorcio
  // que paga de a poco (parciales que no coinciden con ninguna factura) se
  // veia como si nunca hubiera pagado nada, aunque el total dijera otra cosa.
  const cobros = sbGetTodo('cobros', 'select=cuit_cliente,monto,fecha,tipo_movimiento,extracto', 'id')
    .map(function (c) {
      return {
        cuit_cliente: c.cuit_cliente,
        monto: Number(c.monto),
        fecha: c.fecha,
        tipo_movimiento: c.tipo_movimiento,
        extracto: c.extracto,
      };
    });

  return { clientes: clientes, facturas: facturas, pagos: pagos, cobros: cobros, alicuotas: alicuotasRetencion_(), yo: usuario };
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
  const r = matchearCobros_(movimientosDeCobro_(texto));
  return { extracto_label: body.filename, matches: r.matches, aproximados: r.aproximados };
}

/**
 * Vuelve a conciliar contra los cobros YA GUARDADOS en ko.cobros, sin
 * necesidad de subir los PDF de nuevo.
 *
 * Los extractos son siempre los mismos, y ko.cobros ya tiene todo lo que el
 * matcheo necesita (cuit, importe, fecha, tipo). Sirve para cuando cambia el
 * otro lado de la ecuacion: se cargo un informe nuevo, se corrigio el CUIT de
 * un cliente, o se dio de alta un cliente que faltaba.
 */
function accReconciliar_(body, usuario) {
  const filas = sbGetTodo('cobros', 'select=cuit_cliente,monto,fecha,tipo_movimiento,extracto', 'id');

  // Cronologico por fecha real, no por nombre de archivo: cada cobro salda la
  // factura mas vieja impaga, asi que el orden decide a cual va. Los extractos
  // no se solapan (verificado sobre los 7 reales), asi que ordenar por fecha
  // reconstruye exactamente el orden en que entro la plata.
  const movimientos = filas
    .map(function (c) {
      return {
        cuits: [c.cuit_cliente],
        importe: Number(c.monto),
        fecha: c.fecha,
        descripcion: c.tipo_movimiento || '',
        extracto: c.extracto,
        orden: fechaOrdenable_(c.fecha),
      };
    })
    .sort(function (a, b) { return a.orden < b.orden ? -1 : a.orden > b.orden ? 1 : 0; });

  const r = matchearCobros_(movimientos);
  return {
    extracto_label: 'cobros ya registrados',
    cobros_revisados: movimientos.length,
    matches: r.matches,
    aproximados: r.aproximados,
  };
}

// "13/01/26" -> "20260113", para poder ordenar sin parsear fechas.
function fechaOrdenable_(fecha) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(fecha || '');
  if (!m) return '99999999';
  return '20' + m[3] + m[2] + m[1];
}

/**
 * El corazon de la conciliacion: recibe movimientos de cobro (vengan de un
 * PDF recien subido o de ko.cobros) y decide que factura salda cada uno.
 *
 * Se recorren los MOVIMIENTOS, no las facturas, y cada uno salda como mucho
 * una. Al reves era el bug que dejaba plata mal conciliada: preguntando "hay
 * un credito de este CUIT por $45.000?" daba que si para las 5 facturas de
 * $45.000 impagas, aunque en el extracto hubiera un solo pago.
 */
function matchearCobros_(movimientos) {
  const nombrePorCuit = {};
  const retiene = {};
  const tiposCliente = {};
  const alicuotas = alicuotasRetencion_();
  sbGetTodo('clientes', 'select=cuit,nombre,retiene,ret_iva,ret_iibb_arba,ret_iibb_agip,ret_ganancias', 'cuit').forEach(function (c) {
    nombrePorCuit[c.cuit] = c.nombre;
    retiene[c.cuit] = !!c.retiene;
    tiposCliente[c.cuit] = c;
  });

  const pagos = sbGetTodo('pagos', 'select=factura_numero,cuit_cliente,monto,fecha_aprox,mov_firma', 'id');
  const yaPagadas = {};
  pagos.forEach(function (p) { yaPagadas[p.factura_numero] = true; });

  // Movimientos que YA se conciliaron alguna vez.
  //
  // Sin esto, volver a conciliar genera pagos inventados: las facturas que
  // ese cobro ya salvo salen de la lista de pendientes, asi que el mismo
  // movimiento pasa a reclamar la SIGUIENTE factura impaga. Medido sobre los
  // 4 extractos reales: 27 pagos falsos en la segunda vuelta. Que la factura
  // no se pueda pagar dos veces (el UNIQUE) no alcanza - aca el problema es
  // el movimiento usado dos veces.
  //
  // Se prefiere la mov_firma guardada, que es el dato explicito.
  // Reconstruirla desde (cuit, monto, fecha) solo sirve cuando el pago vale
  // lo mismo que el movimiento, y eso NO pasa en los pagos que cubren varias
  // facturas: ahi cada uno vale lo de su factura. Los pagos viejos (sin la
  // columna) siguen por el camino reconstruido.
  //
  // Un movimiento que salvo varias facturas deja varios pagos con la MISMA
  // firma; se cuenta una sola vez, porque un movimiento es uno solo.
  //
  // Cuantos movimientos se usaron por firma sale de la PLATA imputada, no de
  // contar pagos: un movimiento que salda varias facturas deja varios pagos
  // que suman lo que entro (= 1 movimiento), y dos transferencias iguales el
  // mismo dia dejan dos pagos de ese importe cada uno (= 2 movimientos).
  // Antes se contaba "1 por firma" y, con dos transferencias iguales, la
  // segunda se volvia a imputar a otra factura al reconciliar (2026-10-20:
  // 7 pagos de mas).
  const usados = {};
  const imputadoPorFirma = {};
  pagos.forEach(function (p) {
    let k = p.mov_firma;
    if (!k) {
      if (!p.fecha_aprox) return;
      k = firmaMovimiento_(p.cuit_cliente, p.monto, p.fecha_aprox);
      usados[k] = (usados[k] || 0) + 1;
      return;
    }
    imputadoPorFirma[k] = (imputadoPorFirma[k] || 0) + Number(p.monto);
  });
  Object.keys(imputadoPorFirma).forEach(function (k) {
    const importe = Number(k.split('|')[1]);
    const veces = importe > 0 ? Math.max(1, Math.round(imputadoPorFirma[k] / importe)) : 1;
    usados[k] = (usados[k] || 0) + veces;
  });

  // las facturas pendientes de validar (sin CUIT) no tienen con que buscar
  const pendientes = sbGetTodo('facturas', 'select=numero,cuit_cliente,total', 'numero').filter(function (f) {
    return f.cuit_cliente && !yaPagadas[f.numero];
  });

  // Mas viejas primero: los numeros de comprobante son crecientes en el
  // tiempo, y saldar la mas vieja es el criterio contable habitual.
  const porCuit = {};
  pendientes.forEach(function (f) {
    if (!porCuit[f.cuit_cliente]) porCuit[f.cuit_cliente] = [];
    porCuit[f.cuit_cliente].push(f);
  });
  Object.keys(porCuit).forEach(function (c) {
    porCuit[c].sort(function (a, b) { return a.numero < b.numero ? -1 : a.numero > b.numero ? 1 : 0; });
  });

  const tomadas = {};
  const matches = [];
  const libres = [];

  // Pasada 1: importe exacto. Va entera antes de las otras, si no un cobro
  // con retencion podria quedarse con una factura que otro movimiento
  // necesitaba para un match exacto.
  movimientos.forEach(function (mov) {
    for (let c = 0; c < mov.cuits.length; c++) {
      const cuit = mov.cuits[c];
      const k = firmaMovimiento_(cuit, mov.importe, mov.fecha);
      if (usados[k]) { usados[k] -= 1; return; } // ya conciliado antes

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
        extracto_label: mov.extracto || null,
        mov_firma: k,
      });
      return;
    }
    libres.push(mov);
  });

  // Pasada 2: un cobro que salda VARIAS facturas juntas.
  //
  // Hay clientes que dejan pasar dos o tres meses y despues pagan todo en una
  // transferencia. Ese importe no coincide con ninguna factura sola, pero si
  // con la suma de las mas viejas impagas.
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
          extracto_label: mov.extracto || null,
          mov_firma: k,
          grupo_total: mov.importe,
          grupo_cantidad: grupo.length,
        });
      });
      saldo = true;
    }
    if (!saldo) libres2.push(mov);
  });

  // Pasada 3: cobros con retencion, sobre lo que quedo sin usar.
  // Nunca se confirman solos - van a una cola de revision en el frontend.
  // Solo para clientes marcados como agentes de retencion (Clientes >
  // "Retiene impuestos"): a los demas, un importe un poco menor que una
  // factura suele ser otra cosa y llenaba la cola de coincidencias falsas.
  const aproximados = [];
  libres2.forEach(function (mov) {
    for (let c = 0; c < mov.cuits.length; c++) {
      const cuit = mov.cuits[c];
      if (!retiene[cuit]) continue;
      // Con tipos tildados se sabe cuanto deberia retener cada factura (ej.
      // IVA + AGIP = 17,38%): el margen se estira hasta ahi, que si no
      // pasaria el 12%.
      const f = elegirFactura_(porCuit[cuit], tomadas, function (f) {
        const ret = f.total - mov.importe;
        const esperada = retencionFactura_(tiposCliente[cuit], f.total, alicuotas);
        const maximo = Math.max(RETENCION_MAX, esperada / f.total + 0.02);
        return ret > 0 && ret <= f.total * maximo;
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
        // Lo que tendria que haber entrado segun los tipos tildados del
        // cliente, para comparar en la revision. Null si no tiene tipos.
        esperado: esperadoRetencion_(tiposCliente[cuit], f.total, alicuotas),
        porcentaje_esperado: porcentajeEsperado_(tiposCliente[cuit], f.total, alicuotas),
        tipo_movimiento: mov.descripcion,
        fecha_aprox: mov.fecha,
        extracto_label: mov.extracto || null,
        mov_firma: firmaMovimiento_(cuit, mov.importe, mov.fecha),
      });
      return;
    }
  });

  return { matches: matches, aproximados: aproximados };
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
 * Cambia el cliente de una factura, o la devuelve a "pendientes de validar"
 * si no se manda CUIT.
 *
 * El matcheo automatico por nombre/direccion se equivoca cuando hay dos
 * edificios en la misma calle y solo uno esta cargado: le cuelga las facturas
 * del otro al que encuentra. Eso cruza cobros entre dos clientes distintos,
 * y hasta ahora no habia forma de arreglarlo desde la app.
 */
function accReasignarCliente_(body, usuario) {
  const numero = body.factura_numero;
  const cuit = (body.cuit_cliente || '').trim();
  if (!numero) throw new ApiError(400, 'Falta factura_numero');

  const fila = sbGet('facturas', 'select=numero&numero=eq.' + encodeURIComponent(numero));
  if (!fila.length) throw new ApiError(404, 'No existe esa factura');

  // Si tiene un pago imputado, cambiarle el cliente dejaria el pago colgado
  // de otro CUIT: primero hay que decidir que pasa con ese pago.
  const pago = sbGet('pagos', 'select=factura_numero&factura_numero=eq.' + encodeURIComponent(numero));
  if (pago.length) {
    throw new ApiError(409, 'Esa factura ya tiene un pago imputado - no se puede cambiar de cliente sin revisar el pago primero');
  }

  if (cuit) {
    if (!/^\d{11}$/.test(cuit)) throw new ApiError(400, 'El CUIT tiene que tener 11 digitos');
    const cliente = sbGet('clientes', 'select=cuit&cuit=eq.' + encodeURIComponent(cuit));
    if (!cliente.length) throw new ApiError(400, 'Ese CUIT no esta cargado en Clientes - agregalo ahi primero');
  }

  // Se limpia tambien la sugerencia: si quedara la vieja, la pantalla de
  // Pendientes volveria a proponer el CUIT equivocado.
  const cambios = { cuit_cliente: cuit || null, cuit_sugerido: null, nombre_sugerido: null };
  return sbUpdate('facturas', 'numero=eq.' + encodeURIComponent(numero), cambios)[0];
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

  // Cuantos movimientos iguales (CUIT, importe, fecha) ya estan registrados,
  // vengan del extracto que vengan.
  //
  // Antes el "ya lo tengo" dependia del nombre del archivo, y el 2026-10-14
  // se resubieron febrero, marzo y junio con otro nombre: entraron 383 cobros
  // repetidos (~$39 M) y bajaron los saldos de medio padron. Los extractos no
  // se solapan, asi que un movimiento con el mismo CUIT, importe y fecha es
  // el mismo movimiento. Si un dia hubo dos iguales, se cuentan.
  const yaHay = {};
  sbGetTodo('cobros', 'select=cuit_cliente,monto,fecha', 'id').forEach(function (c) {
    const k = firmaMovimiento_(c.cuit_cliente, c.monto, c.fecha);
    yaHay[k] = (yaHay[k] || 0) + 1;
  });

  const vistos = {};
  const filas = [];
  let repetidos = 0;
  movimientosDeCobro_(texto).forEach(function (mov) {
    mov.cuits.forEach(function (cuit) {
      const k = firmaMovimiento_(cuit, mov.importe, mov.fecha);
      const orden = (vistos[k] = (vistos[k] || 0) + 1);
      if (orden <= (yaHay[k] || 0)) { repetidos++; return; }
      filas.push({
        cuit_cliente: cuit,
        monto: mov.importe,
        fecha: mov.fecha,
        tipo_movimiento: mov.descripcion,
        extracto: etiqueta,
        firma: 'mov|' + k + '|' + orden,
        orden: orden,
        cuit_pagador: mov.pagadores[cuit] || null,
      });
    });
  });

  if (!filas.length) return { registrados: 0, repetidos: repetidos, total: 0 };

  const TANDA = 200;
  for (let i = 0; i < filas.length; i += TANDA) {
    sbUpsert('cobros', filas.slice(i, i + TANDA), 'firma');
  }
  return {
    registrados: filas.length,
    repetidos: repetidos,
    total: filas.reduce(function (s, f) { return s + f.monto; }, 0),
  };
}

/**
 * Los cobros de un extracto, con el CUIT ya traducido al del cliente
 * titular.
 *
 * Hay clientes que no pagan con su propio CUIT: el consorcio de Av. Alvear
 * 1592 paga por medio de su administracion (Costa Propiedades). Ese CUIT
 * esta cargado con `paga_por` = el del consorcio, y aca su pago pasa a ser
 * del consorcio: de ahi en adelante (matcheo, firma, ko.cobros, saldo, mails)
 * todo lo trata como un pago del titular. `pagadores` guarda quien pago de
 * verdad, para dejarlo en ko.cobros.cuit_pagador.
 */
function movimientosDeCobro_(texto) {
  const clientes = sbGetTodo('clientes', 'select=cuit,paga_por', 'cuit');
  const titular = {};
  clientes.forEach(function (c) { titular[c.cuit] = c.paga_por || c.cuit; });

  return movimientosDelExtracto_(texto, clientes.map(function (c) { return c.cuit; }))
    .filter(function (mov) {
      return mov.importe > 0 && mov.cuits.length && esCobro_(mov.descripcion);
    })
    .map(function (mov) {
      const cuits = [];
      const pagadores = {};
      mov.cuits.forEach(function (c) {
        const t = titular[c];
        if (cuits.indexOf(t) === -1) cuits.push(t);
        if (t !== c) pagadores[t] = c;
      });
      mov.cuits = cuits;
      mov.pagadores = pagadores;
      return mov;
    });
}

function firmaMovimiento_(cuit, importe, fecha) {
  return cuit + '|' + Number(importe).toFixed(2) + '|' + fecha;
}

function esCobro_(descripcion) {
  return MOVIMIENTO_KEYWORDS.some(function (k) { return descripcion.indexOf(k) !== -1; });
}

// Como se calcula cada tipo de retencion (ko.alicuotas_retencion):
// { ret_ganancias: { porcentaje, sobre_neto, minimo_no_imponible, minimo_retencion }, ... }
function alicuotasRetencion_() {
  const a = {};
  sbGet('alicuotas_retencion', 'select=tipo,porcentaje,sobre_neto,minimo_no_imponible,minimo_retencion').forEach(function (x) {
    a[x.tipo] = {
      porcentaje: Number(x.porcentaje),
      sobre_neto: !!x.sobre_neto,
      minimo_no_imponible: Number(x.minimo_no_imponible),
      minimo_retencion: Number(x.minimo_retencion),
    };
  });
  return a;
}

// Retencion esperada de una factura segun los tipos tildados del cliente.
// Misma cuenta que ko.retencion_factura en Supabase y retencionFactura() del
// panel.
function retencionFactura_(c, total, alicuotas) {
  if (!c || !(total > 0)) return 0;
  let suma = 0;
  ['ret_iva', 'ret_iibb_arba', 'ret_iibb_agip', 'ret_ganancias'].forEach(function (t) {
    const a = alicuotas[t];
    if (!c[t] || !a) return;
    const base = a.sobre_neto ? total / 1.21 : total;
    const r = Math.round(Math.max(0, base - a.minimo_no_imponible) * a.porcentaje) / 100;
    if (r >= a.minimo_retencion) suma += r;
  });
  return suma;
}

function tieneTipos_(c) {
  return !!c && (c.ret_iva || c.ret_iibb_arba || c.ret_iibb_agip || c.ret_ganancias);
}

// Lo que deberia transferir el cliente por esta factura. Null sin tipos.
function esperadoRetencion_(c, total, alicuotas) {
  if (!tieneTipos_(c)) return null;
  return Math.round((total - retencionFactura_(c, total, alicuotas)) * 100) / 100;
}

function porcentajeEsperado_(c, total, alicuotas) {
  if (!tieneTipos_(c) || !(total > 0)) return null;
  return Math.round((retencionFactura_(c, total, alicuotas) / total) * 10000) / 100;
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
  // Solo se toca si viene: un front viejo que no conoce el campo no tiene que
  // borrar el email que otro cargo.
  if (body.email !== undefined) fila.email = normalizarEmails_(body.email);
  if (body.paga_por !== undefined) fila.paga_por = validarPagaPor_(cuit, body.paga_por);
  // "Sin cobro": la leyenda de un cliente al que no se le cobra (sus
  // facturas cuentan como pagas). Vacio = cliente normal.
  if (body.sin_cobro !== undefined) {
    const leyenda = String(body.sin_cobro || '').trim();
    if (leyenda.length > 60) throw new ApiError(400, 'La leyenda de "sin cobro" puede tener hasta 60 caracteres');
    fila.sin_cobro = leyenda || null;
  }
  // Hasta que fecha de emision no se cobra (inclusive). Vacio = para siempre.
  // Sin leyenda no tiene sentido, asi que se borra junto con ella.
  if (body.sin_cobro_hasta !== undefined) {
    const hasta = String(body.sin_cobro_hasta || '').trim();
    if (hasta && !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new ApiError(400, '"Sin cobro hasta" tiene que ser una fecha');
    fila.sin_cobro_hasta = hasta && fila.sin_cobro !== null ? hasta : null;
  }
  if (body.retiene !== undefined) fila.retiene = body.retiene === true;
  // Tipos de retencion. Si vienen, "retiene" (lo que mira la conciliacion)
  // se calcula de ellos: true si tiene al menos uno.
  const TIPOS_RETENCION = ['ret_iva', 'ret_iibb_arba', 'ret_iibb_agip', 'ret_ganancias'];
  if (TIPOS_RETENCION.some(function (t) { return body[t] !== undefined; })) {
    TIPOS_RETENCION.forEach(function (t) { fila[t] = body[t] === true; });
    fila.retiene = TIPOS_RETENCION.some(function (t) { return fila[t]; });
  }
  return sbUpsert('clientes', [fila], 'cuit')[0];
}

// --- listado de clientes de GestionPro (PDF "Clientes - MM-AAAA") ---

// Mails que aparecen en el listado pero no son del cliente: la casilla de KO
// y el Gmail del dueño, que en GestionPro se usan de relleno.
var EMAILS_NO_CLIENTE = [/@kofumigacion\.com$/i, /^rodrigocamps@gmail\.com$/i];

// Digito verificador de CUIT/CUIL. El listado trae CUITs de relleno
// ("123456789", "20-12345678-9"): esos no se dan de alta.
function cuitValido_(cuit) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(cuit[i]) * pesos[i];
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(cuit[10]);
}

/**
 * Lee el listado: una fila por cliente con "razon social  CUIT  mails".
 *
 * Los mails que el PDF corta (la columna tiene ancho fijo y el ultimo de una
 * lista queda "proveedores@gui") no se toman: un mail completo tiene que
 * terminar con un dominio y seguir de coma, espacio o fin de linea.
 */
function clientesDelListado_(texto) {
  const CUIT = /\b(\d{2})-(\d{8})-(\d)\b/;
  const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
  const porCuit = {};
  let sinCuit = 0;
  let cuitInvalido = 0;
  let descartados = 0;

  texto.split('\n').forEach(function (linea) {
    if (/^(C[oó]digo|Raz[oó]n Social)\b/i.test(linea.trim()) || /^TOTAL/i.test(linea.trim())) return;
    const m = CUIT.exec(linea);
    if (!m) {
      if (EMAIL.test(linea)) sinCuit++;
      EMAIL.lastIndex = 0;
      return;
    }
    const cuit = m[1] + m[2] + m[3];
    if (!cuitValido_(cuit)) { cuitInvalido++; return; }

    const nombre = linea.slice(0, m.index).replace(/\s+/g, ' ').trim();
    const resto = linea.slice(m.index + m[0].length);
    const emails = [];
    let e;
    EMAIL.lastIndex = 0;
    while ((e = EMAIL.exec(resto))) {
      const sig = resto.charAt(e.index + e[0].length);
      if (sig && !/[\s,;]/.test(sig)) continue; // cortado por el PDF
      const mail = e[0].toLowerCase();
      if (EMAILS_NO_CLIENTE.some(function (re) { return re.test(mail); })) { descartados++; continue; }
      if (emails.indexOf(mail) === -1) emails.push(mail);
    }

    const c = porCuit[cuit] || (porCuit[cuit] = { cuit: cuit, nombre: nombre, emails: [] });
    emails.forEach(function (x) { if (c.emails.indexOf(x) === -1) c.emails.push(x); });
  });

  return {
    clientes: Object.keys(porCuit).map(function (k) { return porCuit[k]; }),
    sin_cuit: sinCuit,
    cuit_invalido: cuitInvalido,
    mails_descartados: descartados,
  };
}

function mailsDe_(texto) {
  return String(texto || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
}

/**
 * Sube el listado mes a mes. Sin `aplicar` solo devuelve que cambiaria.
 *
 *   - CUIT nuevo: se da de alta con nombre y mails.
 *   - CUIT existente: se le SUMAN los mails que falten. No se borra ningun
 *     mail ni se cambia el nombre: los nombres y mails se corrigen a mano en
 *     el panel (y el PDF corta los segundos mails).
 */
function accImportarClientes_(body, usuario) {
  const texto = textoDelPdf_(body, 'clientes.pdf');
  const r = clientesDelListado_(texto);
  if (!r.clientes.length) {
    throw new ApiError(400, 'No encontré clientes con CUIT en el archivo. ¿Es el listado de clientes de GestiónPro?');
  }

  const actuales = {};
  sbGetTodo('clientes', 'select=cuit,nombre,email', 'cuit').forEach(function (c) { actuales[c.cuit] = c; });

  const altas = [];
  const mails = [];
  let sinCambios = 0;
  r.clientes.forEach(function (c) {
    const a = actuales[c.cuit];
    if (!a) {
      altas.push({ cuit: c.cuit, nombre: c.nombre || '(sin nombre)', email: c.emails.join(', '), condicion_iva: '', direccion: '', provincia: '' });
      return;
    }
    const tiene = mailsDe_(a.email);
    const agregar = c.emails.filter(function (x) { return tiene.indexOf(x) === -1; });
    if (!agregar.length) { sinCambios++; return; }
    mails.push({ cuit: c.cuit, nombre: a.nombre, antes: a.email || '', despues: tiene.concat(agregar).join(', ') });
  });

  if (body.aplicar) {
    if (altas.length) sbInsert('clientes', altas);
    mails.forEach(function (m) { sbUpdate('clientes', 'cuit=eq.' + m.cuit, { email: m.despues }); });
  }

  return {
    aplicado: !!body.aplicar,
    leidos: r.clientes.length,
    altas: altas.map(function (a) { return { cuit: a.cuit, nombre: a.nombre, email: a.email }; }),
    mails: mails,
    sin_cambios: sinCambios,
    sin_cuit: r.sin_cuit,
    cuit_invalido: r.cuit_invalido,
    mails_descartados: r.mails_descartados,
  };
}

// "Paga por": el CUIT del cliente por el que paga este (vacio = paga por si
// mismo). Un solo salto: el titular no puede pagar a su vez por otro, ni
// este CUIT ser titular de otros - si no, un pago se podria ir encadenando.
function validarPagaPor_(cuit, valor) {
  const titular = String(valor || '').replace(/\D/g, '');
  if (!titular) return null;
  if (!/^\d{11}$/.test(titular)) throw new ApiError(400, '"Paga por" tiene que ser un CUIT de 11 dígitos');
  if (titular === cuit) throw new ApiError(400, 'Un cliente no puede pagar por sí mismo');
  const t = sbGet('clientes', 'select=cuit,paga_por&cuit=eq.' + titular)[0];
  if (!t) throw new ApiError(400, 'El CUIT ' + titular + ' no está cargado en Clientes');
  if (t.paga_por) throw new ApiError(400, 'Ese cliente ya paga por otro: no se puede encadenar');
  const dependientes = sbGet('clientes', 'select=cuit&paga_por=eq.' + cuit);
  if (dependientes.length) throw new ApiError(400, 'Hay clientes que pagan por este CUIT: no puede pagar a su vez por otro');
  return titular;
}

// Uno o varios emails separados por coma (los consorcios suelen tener mas de
// uno). Devuelve la lista limpia, o '' si viene vacio.
function normalizarEmails_(texto) {
  const emails = String(texto || '')
    .split(/[,;\s]+/)
    .map(function (e) { return e.trim().toLowerCase(); })
    .filter(Boolean);
  emails.forEach(function (e) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new ApiError(400, 'Email inválido: ' + e);
  });
  return emails.join(', ');
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
