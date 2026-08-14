const fmtMoney = (n) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);

let DATA = null;
let filtroActual = "todos";

async function cargar() {
  const res = await fetch("data/conciliacion.json", { cache: "no-store" });
  DATA = await res.json();
  renderMeta();
  renderKpis();
  renderTabla();
}

function renderMeta() {
  const el = document.getElementById("meta");
  const fecha = new Date(DATA.generado).toLocaleString("es-AR");
  el.textContent = `Período facturado: ${DATA.periodo_facturas} · Extractos incluidos: ${DATA.extractos_incluidos.join(", ")} · Actualizado ${fecha}`;
}

function renderKpis() {
  const r = DATA.resumen_global;
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
  const clientes = DATA.clientes.filter((c) => {
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
  const cliente = DATA.clientes.find((c) => c.cuit === cuit);
  const content = document.getElementById("modal-content");
  content.innerHTML = `
    <h3>${cliente.nombre}</h3>
    <div class="modal-cuit">CUIT ${formatCuit(cliente.cuit)}</div>
    ${cliente.facturas
      .map((f) => {
        const badge = f.estado === "pagada" ? `<span class="badge ok">Pagada</span>` : `<span class="badge warn">Pendiente</span>`;
        const pagoInfo = f.pago
          ? `<div class="pago-info">Detectada en extracto de ${f.pago.extracto}${f.pago.fecha_aprox ? " · " + f.pago.fecha_aprox : ""}</div>`
          : "";
        return `
          <div class="factura-row">
            <div>
              <div class="num-fact">FC ${f.numero} · ${f.fecha_emision}</div>
              <div class="detalle">${f.detalle}</div>
              ${pagoInfo}
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

cargar();
