const fmtMoney = (n) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);

// clientes.json, facturas.json y pagos.json son la fuente de verdad (las edita
// el panel de admin vía commits a GitHub). Este archivo solo lee y calcula la
// conciliación en el navegador - no hay ningún JSON pre-calculado.
let CLIENTES = {};
let FACTURAS = [];
let PAGOS = [];
let CLIENTES_VIEW = [];
let filtroActual = "todos";

// Todo el portal exige login de Google, no solo las acciones de escritura:
// clientes.json/facturas.json/pagos.json ya NO se sirven como estáticos
// públicos (se movieron fuera de docs/), así que la única forma de leerlos
// es a través del backend, que valida el token de Google antes de responder.
// admin.js llama a esto recién después de un login exitoso.
async function cargarDatosAutenticado() {
  const datos = await llamarBackend("/api/data");
  CLIENTES = datos.clientes;
  FACTURAS = datos.facturas;
  PAGOS = datos.pagos;
  recomputar();
}

function recomputar() {
  const pagoPorFactura = new Map(PAGOS.map((p) => [p.factura_numero, p]));
  const porCliente = new Map();

  for (const f of FACTURAS) {
    const pago = pagoPorFactura.get(f.numero) || null;
    const estado = pago ? "pagada" : "pendiente";
    const info = CLIENTES[f.cuit_cliente] || { nombre: "(cliente no encontrado en Clientes)" };

    if (!porCliente.has(f.cuit_cliente)) {
      porCliente.set(f.cuit_cliente, { cuit: f.cuit_cliente, nombre: info.nombre, facturas: [] });
    }
    porCliente.get(f.cuit_cliente).facturas.push({ ...f, estado, pago });
  }

  const resumen = {
    cantidad_facturas: FACTURAS.length,
    cantidad_pagadas: 0,
    cantidad_pendientes: 0,
    total_facturado: 0,
    total_cobrado: 0,
    total_pendiente: 0,
  };

  CLIENTES_VIEW = [...porCliente.values()].map((c) => {
    const total_facturado = c.facturas.reduce((s, f) => s + f.total, 0);
    const total_pagado = c.facturas.filter((f) => f.estado === "pagada").reduce((s, f) => s + f.total, 0);
    resumen.total_facturado += total_facturado;
    resumen.total_cobrado += total_pagado;
    resumen.total_pendiente += total_facturado - total_pagado;
    resumen.cantidad_pagadas += c.facturas.filter((f) => f.estado === "pagada").length;
    resumen.cantidad_pendientes += c.facturas.filter((f) => f.estado === "pendiente").length;
    return { ...c, total_facturado, total_pagado, total_pendiente: total_facturado - total_pagado };
  });
  CLIENTES_VIEW.sort((a, b) => b.total_pendiente - a.total_pendiente);

  RESUMEN = resumen;
  renderMeta();
  renderKpis();
  renderTabla();
}

let RESUMEN = null;

function renderMeta() {
  const el = document.getElementById("meta");
  const periodos = [...new Set(FACTURAS.map((f) => f.periodo))].sort();
  el.textContent = `Períodos facturados: ${periodos.join(", ") || "—"} · ${Object.keys(CLIENTES).length} clientes en la base · ${FACTURAS.length} facturas cargadas`;
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

function renderTabla() {
  const tbody = document.getElementById("tbody-clientes");
  const clientes = CLIENTES_VIEW.filter((c) => {
    if (filtroActual === "todos") return true;
    if (filtroActual === "pendiente") return c.total_pendiente > 0;
    if (filtroActual === "pagada") return c.total_pendiente === 0;
    return true;
  });

  tbody.innerHTML = clientes
    .map((c) => {
      const alDia = c.total_pendiente === 0;
      return `
        <tr data-cuit="${c.cuit}">
          <td class="nombre">${c.nombre}</td>
          <td class="cuit">${formatCuit(c.cuit)}</td>
          <td class="num">${fmtMoney(c.total_facturado)}</td>
          <td class="num">${fmtMoney(c.total_pagado)}</td>
          <td class="num">${fmtMoney(c.total_pendiente)}</td>
          <td><span class="badge ${alDia ? "ok" : "warn"}">${alDia ? "Al día" : "Pendiente"}</span></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => abrirModal(tr.dataset.cuit));
  });
}

function formatCuit(cuit) {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

function abrirModal(cuit) {
  const cliente = CLIENTES_VIEW.find((c) => c.cuit === cuit);
  const content = document.getElementById("modal-content");
  content.innerHTML = `
    <h3>${cliente.nombre}</h3>
    <div class="modal-cuit">CUIT ${formatCuit(cliente.cuit)}</div>
    ${cliente.facturas
      .map((f) => {
        const badge = f.estado === "pagada" ? `<span class="badge ok">Pagada</span>` : `<span class="badge warn">Pendiente</span>`;
        let pagoInfo = "";
        if (f.pago) {
          if (f.pago.origen === "manual") {
            pagoInfo = `<div class="pago-info">Confirmado a mano · transacción ${f.pago.numero_transaccion} · ingresó ${f.pago.fecha_confirmacion}${f.pago.confirmado_por ? " · " + f.pago.confirmado_por : ""}</div>`;
          } else {
            pagoInfo = `<div class="pago-info">Detectado en extracto de ${f.pago.extracto}${f.pago.fecha_aprox ? " · " + f.pago.fecha_aprox : ""}</div>`;
          }
        }
        const accionConfirmar =
          f.estado === "pendiente"
            ? `<button class="btn-confirmar-pago" data-factura="${f.numero}" data-cuit="${cliente.cuit}" data-monto="${f.total}">Confirmar pago manual</button>`
            : "";
        return `
          <div class="factura-row">
            <div>
              <div class="num-fact">FC ${f.numero} · ${f.fecha_emision}</div>
              <div class="detalle">${f.detalle}</div>
              ${pagoInfo}
              ${accionConfirmar}
            </div>
            <div>
              <div class="monto">${fmtMoney(f.total)}</div>
              ${badge}
            </div>
          </div>
        `;
      })
      .join("")}
  `;
  document.getElementById("modal-backdrop").classList.add("open");

  content.querySelectorAll(".btn-confirmar-pago").forEach((btn) => {
    btn.addEventListener("click", () => window.abrirFormConfirmarPago(btn.dataset));
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
function aplicarFacturaLocal(factura) {
  FACTURAS.push(factura);
  recomputar();
}
function aplicarClienteLocal(cuit, info) {
  CLIENTES[cuit] = info;
  recomputar();
}

// No hay cargar() automático: el dashboard queda vacío/oculto detrás del
// gate de login (ver admin.js) hasta que haya un login de Google válido.
