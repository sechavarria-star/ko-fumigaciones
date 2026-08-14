// Panel de admin: login con Google + acciones que escriben datos (confirmar
// pago manual, subir factura/extracto, editar clientes). Todas las escrituras
// pasan por el backend (CONFIG.BACKEND_URL), que valida el login de Google
// contra una lista de emails permitidos y hace el commit real a GitHub - el
// navegador nunca tiene un token de GitHub.

let ID_TOKEN = null;
let SIGNED_IN_EMAIL = null;
let pagoPendienteContext = null; // {factura_numero, cuit_cliente}

function backendListo() {
  if (!CONFIG.BACKEND_URL || !CONFIG.GOOGLE_CLIENT_ID) {
    console.warn("Falta configurar CONFIG.BACKEND_URL / GOOGLE_CLIENT_ID en config.js - el panel de admin queda oculto.");
    return false;
  }
  return true;
}

async function llamarBackend(path, options = {}) {
  const res = await fetch(CONFIG.BACKEND_URL + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${ID_TOKEN}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return res.json();
}

async function handleGoogleCredential(response) {
  const payload = JSON.parse(atob(response.credential.split(".")[1]));
  const gateError = document.getElementById("gate-error");
  gateError.hidden = true;

  // El token lo valida de verdad el backend en cada llamada; esto es solo
  // para no mostrar el portal ni por un instante si claramente va a fallar.
  ID_TOKEN = response.credential;
  try {
    await cargarDatosAutenticado();
  } catch (err) {
    ID_TOKEN = null;
    gateError.hidden = false;
    gateError.textContent =
      err.message.startsWith("403")
        ? "Tu cuenta de Google no tiene acceso a este panel."
        : "No se pudo validar el login: " + err.message;
    return;
  }

  SIGNED_IN_EMAIL = payload.email;
  document.getElementById("gate").hidden = true;
  document.getElementById("portal").hidden = false;
  document.getElementById("signed-in-as").hidden = false;
  document.getElementById("signed-in-email").textContent = payload.email;
  document.getElementById("admin-panel").hidden = false;
  renderTablaClientesAdmin();
}

function initGoogleSignIn() {
  if (!backendListo() || typeof google === "undefined") {
    document.getElementById("gate-error").hidden = false;
    document.getElementById("gate-error").textContent =
      "Falta configurar el backend (ver SETUP.md) - el portal queda inaccesible.";
    return;
  }
  google.accounts.id.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
  });
  google.accounts.id.renderButton(document.getElementById("google-signin-btn"), {
    theme: "filled_black",
    size: "large",
  });
}

document.getElementById("btn-signout").addEventListener("click", () => {
  ID_TOKEN = null;
  SIGNED_IN_EMAIL = null;
  CLIENTES = {};
  FACTURAS = [];
  PAGOS = [];
  document.getElementById("portal").hidden = true;
  document.getElementById("gate").hidden = false;
  document.getElementById("signed-in-as").hidden = true;
  document.getElementById("admin-panel").hidden = true;
  if (typeof google !== "undefined") google.accounts.id.disableAutoSelect();
});

// --- tabs del panel admin ---
document.getElementById("admin-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  document.querySelectorAll("#admin-tabs .chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".admin-tab").forEach((t) => (t.hidden = true));
  document.getElementById(`admin-tab-${btn.dataset.tab}`).hidden = false;
});

// --- 1) confirmar pago manual ---
window.abrirFormConfirmarPago = function (dataset) {
  pagoPendienteContext = dataset;
  document.getElementById("confirmar-pago-sub").textContent =
    `Factura ${dataset.factura} · ${fmtMoney(Number(dataset.monto))}`;
  document.getElementById("modal-confirmar-backdrop").classList.add("open");
};

document.getElementById("modal-confirmar-close").addEventListener("click", () => {
  document.getElementById("modal-confirmar-backdrop").classList.remove("open");
});
document.getElementById("modal-confirmar-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-confirmar-backdrop") e.target.classList.remove("open");
});

document.getElementById("form-confirmar-pago").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const pago = await llamarBackend("/api/pagos/confirmar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factura_numero: pagoPendienteContext.factura,
        cuit_cliente: pagoPendienteContext.cuit,
        numero_transaccion: fd.get("numero_transaccion"),
        fecha_ingreso: fd.get("fecha_ingreso"),
      }),
    });
    aplicarPagoLocal(pago);
    document.getElementById("modal-confirmar-backdrop").classList.remove("open");
    document.getElementById("modal-backdrop").classList.remove("open");
    e.target.reset();
  } catch (err) {
    alert("No se pudo confirmar el pago: " + err.message);
  }
});

// --- 2) subir factura ---
document.getElementById("input-factura").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const draftEl = document.getElementById("factura-draft");
  draftEl.innerHTML = `<div class="draft-card">Leyendo PDF…</div>`;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const draft = await llamarBackend("/api/facturas/parse", { method: "POST", body: fd });
    if (!draft.cuit_encontrado) {
      draftEl.innerHTML = `
        <div class="draft-card">
          <div class="draft-row"><span class="k">CUIT detectado</span><span>${draft.cuit_cliente}</span></div>
          <div class="warn-text">Ese CUIT no está en la sección Clientes. Agregalo primero ahí y volvé a subir la factura.</div>
        </div>`;
      return;
    }
    draftEl.innerHTML = `
      <div class="draft-card">
        <div class="draft-row"><span class="k">Factura</span><span>${draft.numero}</span></div>
        <div class="draft-row"><span class="k">Fecha emisión</span><span>${draft.fecha_emision}</span></div>
        <div class="draft-row"><span class="k">Cliente</span><span>${draft.nombre_cliente} (${draft.cuit_cliente})</span></div>
        <div class="draft-row"><span class="k">Detalle</span><span>${draft.detalle}</span></div>
        <div class="draft-row"><span class="k">Total</span><span>${fmtMoney(draft.total)}</span></div>
        <button id="btn-guardar-factura">Guardar factura</button>
      </div>`;
    document.getElementById("btn-guardar-factura").addEventListener("click", async () => {
      try {
        const factura = await llamarBackend("/api/facturas/guardar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        aplicarFacturaLocal(factura);
        draftEl.innerHTML = `<div class="draft-card">Factura ${factura.numero} guardada.</div>`;
        e.target.value = "";
      } catch (err) {
        alert("No se pudo guardar la factura: " + err.message);
      }
    });
  } catch (err) {
    draftEl.innerHTML = `<div class="draft-card warn-text">No se pudo leer el PDF: ${err.message}</div>`;
  }
});

// --- 3) subir extracto ---
document.getElementById("input-extracto").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const draftEl = document.getElementById("extracto-draft");
  draftEl.innerHTML = `<div class="draft-card">Leyendo PDF y buscando coincidencias…</div>`;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const resultado = await llamarBackend("/api/extractos/parse", { method: "POST", body: fd });
    if (!resultado.matches.length) {
      draftEl.innerHTML = `<div class="draft-card">No se encontraron coincidencias de CUIT contra facturas pendientes en este extracto.</div>`;
      return;
    }
    draftEl.innerHTML = `<div class="draft-card">${resultado.matches
      .map(
        (m, i) => `
        <div class="match-item">
          <div>
            <div>${m.nombre_cliente} · FC ${m.factura_numero}</div>
            <div class="k" style="font-size:0.78rem">${m.tipo_movimiento} · ${m.fecha_aprox || "sin fecha"} · ${fmtMoney(m.monto)}</div>
          </div>
          <button data-idx="${i}" class="btn-aceptar-match">Aceptar</button>
        </div>`
      )
      .join("")}</div>`;
    draftEl.querySelectorAll(".btn-aceptar-match").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const m = resultado.matches[Number(btn.dataset.idx)];
        try {
          const pago = await llamarBackend("/api/extractos/confirmar-match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...m, extracto_label: resultado.extracto_label }),
          });
          aplicarPagoLocal(pago);
          btn.closest(".match-item").remove();
        } catch (err) {
          alert("No se pudo confirmar: " + err.message);
        }
      });
    });
  } catch (err) {
    draftEl.innerHTML = `<div class="draft-card warn-text">No se pudo leer el PDF: ${err.message}</div>`;
  }
});

// --- 4) clientes ---
document.getElementById("form-cliente").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const cuit = fd.get("cuit").trim();
  if (!/^\d{11}$/.test(cuit)) {
    alert("El CUIT tiene que tener 11 dígitos, sin guiones.");
    return;
  }
  const info = {
    nombre: fd.get("nombre").trim(),
    condicion_iva: fd.get("condicion_iva").trim(),
    direccion: fd.get("direccion").trim(),
    provincia: "",
  };
  try {
    await llamarBackend("/api/clientes/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cuit, ...info }),
    });
    aplicarClienteLocal(cuit, info);
    renderTablaClientesAdmin();
    e.target.reset();
  } catch (err) {
    alert("No se pudo guardar el cliente: " + err.message);
  }
});

function renderTablaClientesAdmin() {
  const tbody = document.getElementById("tbody-clientes-admin");
  if (!tbody) return;
  const filas = Object.entries(CLIENTES)
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
    .map(([cuit, info]) => `<tr><td class="cuit">${formatCuit(cuit)}</td><td>${info.nombre}</td><td>${info.condicion_iva || ""}</td></tr>`);
  tbody.innerHTML = filas.join("");
}

window.addEventListener("load", initGoogleSignIn);
