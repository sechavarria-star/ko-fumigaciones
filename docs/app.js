const fmtMoney = (n) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);

// clientes.json, facturas.json y pagos.json son la fuente de verdad (las edita
// el panel de admin vía commits a GitHub). Este archivo solo lee y calcula la
// conciliación en el navegador - no hay ningún JSON pre-calculado.
let CLIENTES = {};
let FACTURAS = [];
let PAGOS = [];
// Total entrado al banco por CUIT, se haya imputado a una factura o no.
let COBROS = {};
let CLIENTES_VIEW = [];
let PENDIENTES_VALIDAR = []; // facturas del informe sin CUIT asociado, agrupadas por cliente_informe
let filtroActual = "todos";
// El perfil (admin/supervisor/usuario) lo decide el backend, nunca el propio
// navegador - esto es solo para mostrar/ocultar botones. Los permisos reales
// se validan de nuevo en cada request al backend.
let YO = null;
const puedeEscribir = () => YO && (YO.perfil === "admin" || YO.perfil === "supervisor");

// Todo el portal exige login de Google, no solo las acciones de escritura:
// clientes.json/facturas.json/pagos.json ya NO se sirven como estáticos
// públicos (se movieron fuera de docs/), así que la única forma de leerlos
// es a través del backend, que valida el token de Google antes de responder.
// admin.js llama a esto recién después de un login exitoso.
async function cargarDatosAutenticado() {
  const datos = await llamarBackend("obtener_datos");
  CLIENTES = datos.clientes;
  FACTURAS = datos.facturas;
  PAGOS = datos.pagos;
  COBROS = datos.cobros || {};
  YO = datos.yo;
  recomputar();
}

function recomputar() {
  const pagoPorFactura = new Map(PAGOS.map((p) => [p.factura_numero, p]));
  const porCliente = new Map();
  const porValidar = new Map();

  for (const f of FACTURAS) {
    // Las facturas que vinieron del informe consolidado sin poder asociarse
    // solas a un cliente no tienen CUIT todavía - no entran a ningún cliente,
    // van aparte a un cajón "pendientes de validar" (ver renderPendientesBanner).
    if (!f.cuit_cliente) {
      const clave = f.cliente_informe || "(sin nombre)";
      if (!porValidar.has(clave)) {
        porValidar.set(clave, {
          cliente_informe: clave,
          cuit_sugerido: f.cuit_sugerido || null,
          nombre_sugerido: f.nombre_sugerido || null,
          count: 0,
          total: 0,
        });
      }
      const g = porValidar.get(clave);
      g.count += 1;
      g.total += f.total;
      continue;
    }

    const pago = pagoPorFactura.get(f.numero) || null;
    const estado = pago ? "pagada" : "pendiente";
    const info = CLIENTES[f.cuit_cliente] || { nombre: "(cliente no encontrado en Clientes)" };

    if (!porCliente.has(f.cuit_cliente)) {
      porCliente.set(f.cuit_cliente, { cuit: f.cuit_cliente, nombre: info.nombre, facturas: [] });
    }
    porCliente.get(f.cuit_cliente).facturas.push({ ...f, estado, pago });
  }

  PENDIENTES_VALIDAR = [...porValidar.values()].sort((a, b) => b.total - a.total);

  const resumen = {
    cantidad_facturas: FACTURAS.length,
    cantidad_pagadas: 0,
    cantidad_pendientes: 0,
    total_facturado: 0,
    total_cobrado: 0,
    total_pendiente: 0,
    total_a_cuenta: 0,     // pagado de más: cancela deuda anterior a enero
    total_sin_imputar: 0,  // entró al banco pero no se pudo atar a una factura
  };

  CLIENTES_VIEW = [...porCliente.values()].map((c) => {
    const total_facturado = c.facturas.reduce((s, f) => s + f.total, 0);
    // Lo que se pudo atar a una factura concreta.
    const total_imputado = c.facturas.filter((f) => f.estado === "pagada").reduce((s, f) => s + f.total, 0);

    // Lo que realmente entró al banco de este cliente, imputado o no.
    //
    // Es lo que hace cerrar el arqueo: hay clientes que dejan pasar dos o
    // tres meses y después pagan todo junto en una transferencia. Ese importe
    // no coincide con ninguna factura, así que la imputación no lo encuentra
    // - pero la plata entró, y la deuda del cliente no es la que sugiere el
    // detalle factura por factura.
    const cobrado_banco = COBROS[c.cuit] || 0;
    const total_cobrado = Math.max(total_imputado, Math.min(cobrado_banco, total_facturado));

    // Si pagó más de lo facturado en el período, el excedente cancela deuda
    // anterior a enero (que no está cargada). No baja el saldo del período ni
    // se cuenta como cobrado: se muestra aparte, para que se vea de dónde
    // sale la diferencia.
    const a_cuenta = Math.max(0, cobrado_banco - total_facturado);

    resumen.total_facturado += total_facturado;
    resumen.total_cobrado += total_cobrado;
    resumen.total_pendiente += total_facturado - total_cobrado;
    resumen.total_a_cuenta += a_cuenta;
    resumen.total_sin_imputar += Math.max(0, total_cobrado - total_imputado);
    resumen.cantidad_pagadas += c.facturas.filter((f) => f.estado === "pagada").length;
    // Las notas de crédito (total negativo) no son algo que alguien vaya a
    // pagar - no cuentan como "factura pendiente" aunque nunca tengan pago.
    resumen.cantidad_pendientes += c.facturas.filter((f) => f.estado === "pendiente" && f.total >= 0).length;
    return {
      ...c,
      total_facturado,
      total_imputado,
      cobrado_banco,
      a_cuenta,
      total_pagado: total_cobrado,
      total_pendiente: total_facturado - total_cobrado,
    };
  });
  CLIENTES_VIEW.sort((a, b) => b.total_pendiente - a.total_pendiente);

  // Las facturas que todavía no se pudieron asociar a un cliente igual se
  // emitieron: tienen que estar en FACTURADO, si no el KPI no da el total del
  // informe y parece que falta plata. Y como nadie las pagó, van enteras a
  // PENDIENTE. Aparte siguen saliendo en el aviso naranja de arriba, que es
  // lo que dice cuánto de eso está sin identificar.
  const totalSinAsignar = PENDIENTES_VALIDAR.reduce((s, g) => s + g.total, 0);
  resumen.total_facturado += totalSinAsignar;
  resumen.total_pendiente += totalSinAsignar;
  resumen.sin_asignar = totalSinAsignar;

  RESUMEN = resumen;
  renderMeta();
  renderPendientesBanner();
  renderKpis();
  renderTabla();
  renderPendientesLista();
  renderColaConsolidacion();
  renderColaRetenciones();

  // Si el modal de un cliente está abierto (por ej. se acaba de confirmar un
  // pago desde ahí), lo refrescamos contra los datos nuevos en vez de dejarlo
  // desactualizado hasta que el usuario lo cierre y lo vuelva a abrir.
  if (document.getElementById("modal-backdrop").classList.contains("open") && MODAL_LISTA[MODAL_IDX]) {
    const cuitAbierto = MODAL_LISTA[MODAL_IDX].cuit;
    const listaNueva = clientesFiltrados();
    const idxNuevo = listaNueva.findIndex((c) => c.cuit === cuitAbierto);
    MODAL_LISTA = listaNueva;
    MODAL_IDX = idxNuevo === -1 ? 0 : idxNuevo;
    if (listaNueva.length) renderModal();
    else document.getElementById("modal-backdrop").classList.remove("open");
  }
}

let RESUMEN = null;

function renderMeta() {
  const el = document.getElementById("meta");
  const periodos = [...new Set(FACTURAS.map((f) => f.periodo))].sort();
  el.textContent = `Períodos facturados: ${periodos.join(", ") || "—"} · ${Object.keys(CLIENTES).length} clientes en la base · ${FACTURAS.length} facturas cargadas`;
}

function renderPendientesBanner() {
  const el = document.getElementById("pendientes-banner");
  if (!PENDIENTES_VALIDAR.length) {
    el.innerHTML = "";
    return;
  }
  const cantidad = PENDIENTES_VALIDAR.reduce((s, p) => s + p.count, 0);
  const total = PENDIENTES_VALIDAR.reduce((s, p) => s + p.total, 0);
  el.innerHTML = `
    <div class="pendientes-banner">
      <span>${cantidad} factura${cantidad === 1 ? "" : "s"} (${PENDIENTES_VALIDAR.length} cliente${PENDIENTES_VALIDAR.length === 1 ? "" : "s"}) pendiente${cantidad === 1 ? "" : "s"} de validar · ${fmtMoney(total)} sin asignar a ningún cliente</span>
      ${puedeEscribir() ? `<button id="btn-ir-pendientes" type="button">Resolver</button>` : ""}
    </div>`;
  document.getElementById("btn-ir-pendientes")?.addEventListener("click", () => window.irAPagina("pendientes"));
}

function renderKpis() {
  const r = RESUMEN;
  const el = document.getElementById("kpis");
  el.innerHTML = `
    <div class="kpi">
      <div class="label">Facturado</div>
      <div class="value">${fmtMoney(r.total_facturado)}</div>
    </div>
    <div class="kpi">
      <div class="label">Cobrado</div>
      <div class="value ok">${fmtMoney(r.total_cobrado)}</div>
      ${
        r.total_sin_imputar
          ? `<div class="kpi-nota">incluye ${fmtMoney(r.total_sin_imputar)} que entró al banco pero no se pudo atar a una factura</div>`
          : ""
      }
    </div>
    <div class="kpi">
      <div class="label">Pendiente</div>
      <div class="value warn">${fmtMoney(r.total_pendiente)}</div>
    </div>
    <div class="kpi">
      <div class="label">Facturas</div>
      <div class="value">${r.cantidad_pagadas} / ${r.cantidad_facturas}</div>
    </div>
  `;
}

let busquedaClientes = "";
let ordenColumna = null;
let ordenDireccion = "desc"; // "desc" | "asc" - clic en un header ordena de mayor a menor primero

function clientesFiltrados() {
  const q = busquedaClientes.trim().toLowerCase();
  let lista = CLIENTES_VIEW.filter((c) => {
    if (filtroActual === "pendiente" && c.total_pendiente <= 0) return false;
    if (filtroActual === "pagada" && c.total_pendiente !== 0) return false;
    if (q && !c.nombre.toLowerCase().includes(q) && !c.cuit.includes(q)) return false;
    return true;
  });

  if (ordenColumna) {
    const dir = ordenDireccion === "desc" ? -1 : 1;
    lista = [...lista].sort((a, b) => {
      const va = ordenColumna === "estado" ? (a.total_pendiente === 0 ? 1 : 0) : a[ordenColumna];
      const vb = ordenColumna === "estado" ? (b.total_pendiente === 0 ? 1 : 0) : b[ordenColumna];
      if (typeof va === "string") return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
  }

  return lista;
}

document.getElementById("buscar-clientes").addEventListener("input", (e) => {
  busquedaClientes = e.target.value;
  renderTabla();
});

document.querySelectorAll("#tabla-clientes thead th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const campo = th.dataset.sort;
    ordenDireccion = ordenColumna === campo && ordenDireccion === "desc" ? "asc" : "desc";
    ordenColumna = campo;
    renderTabla();
  });
});

function actualizarFlechasOrden() {
  document.querySelectorAll("#tabla-clientes thead th[data-sort]").forEach((th) => {
    const flecha = th.querySelector(".sort-arrow");
    flecha.textContent = th.dataset.sort === ordenColumna ? (ordenDireccion === "desc" ? " ▼" : " ▲") : "";
  });
}

function renderTabla() {
  const tbody = document.getElementById("tbody-clientes");
  const clientes = clientesFiltrados();

  tbody.innerHTML = clientes
    .map((c) => {
      const alDia = c.total_pendiente === 0;
      return `
        <tr data-cuit="${c.cuit}">
          <td class="nombre">${c.nombre}</td>
          <td class="cuit">${formatCuit(c.cuit)}</td>
          <td class="num">${fmtMoney(c.total_facturado)}</td>
          <td class="num">${fmtMoney(c.total_pagado)}${
            // Cobrado que no se pudo atar a una factura puntual: casi siempre
            // es un pago que junta varios meses. Se aclara para que no parezca
            // que el detalle de abajo está incompleto.
            c.total_pagado > c.total_imputado
              ? `<div class="archivo">${fmtMoney(c.total_pagado - c.total_imputado)} sin imputar</div>`
              : ""
          }</td>
          <td class="num">${fmtMoney(c.total_pendiente)}${
            c.a_cuenta ? `<div class="archivo">+${fmtMoney(c.a_cuenta)} a cuenta de 2025</div>` : ""
          }</td>
          <td><span class="badge ${alDia ? "ok" : "warn"}">${alDia ? "Al día" : "Pendiente"}</span></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => abrirModal(tr.dataset.cuit));
  });

  actualizarFlechasOrden();
}

function formatCuit(cuit) {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

function parseFechaAr(f) {
  const [d, m, a] = f.split("/").map(Number);
  return new Date(a, m - 1, d);
}

function abrirModal(cuit) {
  const lista = clientesFiltrados();
  const idx = lista.findIndex((c) => c.cuit === cuit);
  if (idx === -1) return;
  MODAL_LISTA = lista;
  MODAL_IDX = idx;
  renderModal();
  document.getElementById("modal-backdrop").classList.add("open");
}

let MODAL_LISTA = [];
let MODAL_IDX = 0;

function renderModal() {
  const cliente = MODAL_LISTA[MODAL_IDX];
  const content = document.getElementById("modal-content");
  const alDia = cliente.total_pendiente === 0;

  const facturasOrden = [...cliente.facturas].sort((a, b) => parseFechaAr(a.fecha_emision) - parseFechaAr(b.fecha_emision));
  let saldo = 0;
  const filas = facturasOrden.map((f) => {
    const haber = f.estado === "pagada" ? f.total : 0;
    saldo += f.total - haber;
    return { ...f, haber, saldo };
  });

  content.innerHTML = `
    <div class="modal-nav">
      <button id="modal-prev" aria-label="Cliente anterior" ${MODAL_LISTA.length < 2 ? "disabled" : ""}>&larr;</button>
      <span class="modal-contador">${MODAL_IDX + 1} de ${MODAL_LISTA.length}</span>
      <button id="modal-next" aria-label="Próximo cliente" ${MODAL_LISTA.length < 2 ? "disabled" : ""}>&rarr;</button>
    </div>
    <div class="modal-head">
      <div>
        <h3>${cliente.nombre}</h3>
        <div class="modal-cuit">CUIT ${formatCuit(cliente.cuit)}</div>
      </div>
      <span class="badge ${alDia ? "ok" : "warn"}">${alDia ? "Al día" : "Pendiente"}</span>
    </div>
    <div class="timeline">
      ${filas
        .map((f) => {
          const esNotaCredito = f.tipo === "NC" || f.total < 0;
          let pagoInfo = esNotaCredito ? "Nota de crédito" : "Sin pago registrado";
          if (f.pago) {
            pagoInfo =
              f.pago.origen === "manual"
                ? `Confirmado a mano · transacción ${f.pago.numero_transaccion} · ingresó ${f.pago.fecha_confirmacion}${f.pago.confirmado_por ? " · " + f.pago.confirmado_por : ""}`
                : `Detectado en extracto de ${f.pago.extracto}${f.pago.fecha_aprox ? " · " + f.pago.fecha_aprox : ""}`;
          }
          const accionConfirmar =
            f.estado === "pendiente" && !esNotaCredito && puedeEscribir()
              ? `<button class="btn-confirmar-pago" data-factura="${f.numero}" data-cuit="${cliente.cuit}" data-monto="${f.total}">Confirmar pago manual</button>`
              : "";
          // El matcheo automático se equivoca cuando hay dos edificios en la
          // misma calle y solo uno está cargado: le cuelga las facturas del
          // otro al que encuentra, y eso cruza cobros entre dos clientes.
          // Solo si no tiene pago: cambiarle el cliente a una factura ya
          // cobrada dejaría el pago colgado de otro CUIT.
          const accionReasignar =
            f.estado === "pendiente" && puedeEscribir()
              ? `<button class="btn-reasignar" data-factura="${f.numero}" data-informe="${(f.cliente_informe || "").replace(/"/g, "&quot;")}">Cambiar de cliente</button>`
              : "";
          return `
            <div class="timeline-item">
              <div class="timeline-dot ${f.estado === "pagada" ? "pagada" : ""}"></div>
              <div class="timeline-fecha">${f.fecha_emision}</div>
              <div class="detalle">${f.detalle} <span class="num-fact">· ${esNotaCredito ? "NC" : "FC"} ${f.numero}</span></div>
              <div class="timeline-cuenta">
                <div><span class="k">Debe</span>${fmtMoney(f.total)}</div>
                <div><span class="k">Haber</span>${f.haber ? fmtMoney(f.haber) : "—"}</div>
                <div><span class="k">Saldo</span>${fmtMoney(f.saldo)}</div>
              </div>
              <div class="pago-info ${esNotaCredito ? "" : f.estado === "pagada" ? "ok-text" : "warn-text"}">${pagoInfo}</div>
              ${accionConfirmar}
              ${accionReasignar}
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="modal-saldo">
      <span>Saldo pendiente</span>
      <span class="${alDia ? "ok-text" : "warn-text"}">${fmtMoney(cliente.total_pendiente)}</span>
    </div>
  `;

  content.querySelectorAll(".btn-confirmar-pago").forEach((btn) => {
    btn.addEventListener("click", () => window.abrirFormConfirmarPago(btn.dataset));
  });
  content.querySelectorAll(".btn-reasignar").forEach((btn) => {
    btn.addEventListener("click", () => window.reasignarCliente(btn.dataset.factura, btn.dataset.informe));
  });
  document.getElementById("modal-prev")?.addEventListener("click", () => {
    MODAL_IDX = (MODAL_IDX - 1 + MODAL_LISTA.length) % MODAL_LISTA.length;
    renderModal();
  });
  document.getElementById("modal-next")?.addEventListener("click", () => {
    MODAL_IDX = (MODAL_IDX + 1) % MODAL_LISTA.length;
    renderModal();
  });
}

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("modal-backdrop").classList.remove("open");
});
document.getElementById("modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") e.target.classList.remove("open");
});

document.getElementById("filters").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  filtroActual = btn.dataset.filter;
  renderTabla();
});

// admin.js llama a esto tras confirmar un pago a mano o subir datos nuevos,
// para reflejar el cambio al toque sin esperar a que GitHub Pages redepliegue.
function aplicarPagoLocal(pago) {
  PAGOS.push(pago);
  recomputar();
}
function aplicarClienteLocal(cuit, info) {
  CLIENTES[cuit] = info;
  recomputar();
}

// No hay cargar() automático: el dashboard queda vacío/oculto detrás del
// gate de login (ver admin.js) hasta que haya un login de Google válido.
