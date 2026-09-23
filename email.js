// email.js
//
// Notificaciones por email (SMTP de Gmail): avisa a los administradores
// cuando el scraper de la Raspberry Pi envía una alianza nueva a
// POST /api/alianzas/nueva (ver apiAlianzasNueva en server.js). Usa las
// credenciales SMTP_USER/SMTP_PASSWORD ya configuradas en el entorno para el
// envío de correo por Gmail. Si no están definidas, se registra un aviso en
// el log y se ignora en silencio: nunca debe romper la ingesta del scraper.

const nodemailer = require("nodemailer");
const path = require("path");

const DESTINATARIOS_ALIANZAS = ["fjose.cantos@verisure.es", "calvorotador@gmail.com"];
const DESTINATARIOS_CAMBIOS_CLAUSULAS = ["fjose.cantos@verisure.es"];
const EMAIL_SUPER_ADMIN_PRINCIPAL = "fjose.cantos@verisure.es";

// Logo UIC usado en las exportaciones a Excel/PDF (ver server.js); los
// emails que lo llevan lo adjuntan como imagen embebida (Content-ID) en vez
// de enlazarlo por URL, porque no hay ningun hosting publico para servirlo.
const RUTA_LOGO_UIC = path.join(__dirname, "assets", "LOGO_UIC_limpio.png");
const CID_LOGO_UIC = "logo-uic-segurpanel";

function adjuntoLogoUIC() {
  return { filename: "logo-uic.png", path: RUTA_LOGO_UIC, cid: CID_LOGO_UIC };
}

let transportador = null;
let avisoCredencialesMostrado = false;

function obtenerTransportador() {
  const usuario = process.env.SMTP_USER;
  const clave = process.env.SMTP_PASSWORD;
  if (!usuario || !clave) {
    if (!avisoCredencialesMostrado) {
      console.warn(
        "AVISO: SMTP_USER/SMTP_PASSWORD no están configuradas. No se enviarán emails de nuevas alianzas."
      );
      avisoCredencialesMostrado = true;
    }
    return null;
  }
  if (!transportador) {
    transportador = nodemailer.createTransport({
      service: "gmail",
      auth: { user: usuario, pass: clave },
    });
  }
  return transportador;
}

function escapeHtml(texto) {
  return String(texto == null ? "" : texto).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function filaAlianzaHtml(a) {
  const celda = (valor) =>
    `<td style="padding:10px 14px;border-bottom:1px solid #f0e2e5;color:#2b0009;font-size:14px;">${escapeHtml(valor || "—")}</td>`;
  return `<tr>${celda(a.empresaAlarma)}${celda(a.socio)}${celda(a.sector)}${celda(a.fuente)}</tr>`;
}

function construirHtmlAlianzas(alianzas) {
  const filas = alianzas.map(filaAlianzaHtml).join("");
  const plural = alianzas.length === 1 ? "" : "s";
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Nuevas alianzas detectadas</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;line-height:1.5;">
        El scraper de alianzas ha detectado ${alianzas.length} acuerdo${plural} nuevo${plural}, pendiente${plural} de revisión en el panel de Super Admin.
      </p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f7e9ec;">
            <th style="text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;color:#8B0026;">Empresa</th>
            <th style="text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;color:#8B0026;">Socio</th>
            <th style="text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;color:#8B0026;">Sector</th>
            <th style="text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;color:#8B0026;">Fuente</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// Fire and forget: nunca debe retrasar ni romper la respuesta de
// apiAlianzasNueva. Si fallan las credenciales, el transporte o el envío, se
// registra en el log y no se lanza ninguna excepción hacia el llamador.
async function enviarEmailAlianzasNuevas(alianzas) {
  if (!Array.isArray(alianzas) || alianzas.length === 0) return;
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: DESTINATARIOS_ALIANZAS.join(", "),
      subject: "SegurPanel - Nuevas alianzas detectadas",
      html: construirHtmlAlianzas(alianzas),
    });
  } catch (e) {
    console.error("Error enviando email de nuevas alianzas:", e.message || e);
  }
}

function listaHtml(items) {
  if (!items || items.length === 0) return '<p style="margin:0;color:#8a7680;font-size:13px;">Ninguna.</p>';
  const lis = items.map((t) => `<li style="margin:0 0 4px;color:#2b0009;font-size:14px;">${escapeHtml(t)}</li>`).join("");
  return `<ul style="margin:0;padding-left:18px;">${lis}</ul>`;
}

function construirHtmlCambioClausulas({ empresa, tipo, nuevas, modificadas, eliminadas, fecha }) {
  const etiquetaTipo = tipo === "hogar" ? "Hogar" : tipo === "negocio" ? "Negocio" : "Sin clasificar";
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Cambio de cláusulas detectado en el Repositorio</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;line-height:1.5;">
        <strong>${escapeHtml(empresa)}</strong> (${escapeHtml(etiquetaTipo)}) — nuevo contrato analizado con cláusulas distintas a la versión anterior de la misma empresa.
      </p>
      <p style="margin:0 0 16px;color:#8a7680;font-size:12px;">${escapeHtml(fecha || "")}</p>

      <h3 style="margin:16px 0 6px;color:#8B0026;font-size:13px;text-transform:uppercase;letter-spacing:0.4px;">Cláusulas nuevas</h3>
      ${listaHtml(nuevas)}

      <h3 style="margin:16px 0 6px;color:#8B0026;font-size:13px;text-transform:uppercase;letter-spacing:0.4px;">Cláusulas modificadas</h3>
      ${listaHtml(modificadas)}

      <h3 style="margin:16px 0 6px;color:#8B0026;font-size:13px;text-transform:uppercase;letter-spacing:0.4px;">Cláusulas eliminadas</h3>
      ${listaHtml(eliminadas)}
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente desde el Repositorio</p>
    </div>
  </div>
</div>`;
}

// Fire and forget, igual que enviarEmailAlianzasNuevas: nunca debe romper
// apiAnalisis si falla el envio.
async function enviarEmailCambioClausulas(cambio) {
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: DESTINATARIOS_CAMBIOS_CLAUSULAS.join(", "),
      subject: `SegurPanel - Cambio de cláusulas: ${cambio.empresa}`,
      html: construirHtmlCambioClausulas(cambio),
    });
  } catch (e) {
    console.error("Error enviando email de cambio de cláusulas:", e.message || e);
  }
}

/* ================================================================
   Doble factor (2FA): codigo de 6 digitos tras un login correcto
   ================================================================ */

function construirHtmlCodigo2FA(codigo) {
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Verificación en dos pasos</p>
    </div>
    <div style="padding:28px;text-align:center;">
      <p style="margin:0 0 18px;color:#4a0015;font-size:14px;line-height:1.5;">
        Introduce este código para completar tu inicio de sesión. Caduca en 10 minutos.
      </p>
      <div style="display:inline-block;background:#f7e9ec;border-radius:10px;padding:16px 28px;letter-spacing:8px;font-size:32px;font-weight:700;color:#8B0026;font-family:'Courier New',monospace;">
        ${escapeHtml(codigo)}
      </div>
      <p style="margin:20px 0 0;color:#8a7680;font-size:12px;">
        Si no has intentado iniciar sesión, cambia tu contraseña e informa a un Super Admin.
      </p>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// A diferencia de enviarEmailAlianzasNuevas/enviarEmailCambioClausulas
// (fire-and-forget), aqui SI interesa saber si el envio ha funcionado: sin
// el codigo por email el usuario no puede completar el login, asi que
// apiLogin en server.js usa el resultado para avisar de un problema en vez
// de dejar al usuario esperando un correo que nunca llegará. Devuelve
// {ok:boolean} en vez de lanzar, para que el llamador no necesite try/catch.
async function enviarEmailCodigo2FA(usuario, codigo) {
  const transporte = obtenerTransportador();
  if (!transporte) return { ok: false, motivo: "SMTP no configurado" };

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: usuario.email,
      subject: `SegurPanel - Tu código de verificación: ${codigo}`,
      html: construirHtmlCodigo2FA(codigo),
    });
    return { ok: true };
  } catch (e) {
    console.error("Error enviando email de código 2FA:", e.message || e);
    return { ok: false, motivo: e.message || "Error desconocido" };
  }
}

/* ================================================================
   Aviso de IP bloqueada por demasiados intentos de login fallidos
   ================================================================ */

function construirHtmlIPBloqueada({ ip, intentos, bloqueadaHasta }) {
  const hastaTexto = bloqueadaHasta
    ? new Date(bloqueadaHasta).toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" })
    : "—";
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Aviso de seguridad: IP bloqueada</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;line-height:1.5;">
        La dirección IP <strong>${escapeHtml(ip)}</strong> se ha bloqueado automáticamente durante 30 minutos tras
        registrar <strong>${escapeHtml(String(intentos))} intentos de inicio de sesión fallidos</strong> en los últimos 15 minutos.
      </p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Bloqueada hasta:</strong> ${escapeHtml(hastaTexto)}</p>
      <p style="margin:16px 0 0;color:#8a7680;font-size:12px;">
        Si reconoces esta actividad (p.ej. alguien del equipo con la contraseña olvidada), no hace falta ninguna acción: el bloqueo se levanta solo pasado ese tiempo.
        Si no la reconoces, revisa el Panel de auditoría.
      </p>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// Fire-and-forget, igual que enviarEmailAlianzasNuevas: nunca debe romper
// el flujo de login que lo origina. `destinatarios` es la lista de emails
// de los super_admin activos (la calcula el llamador con
// db.listarSuperAdminsActivos(), para no acoplar email.js a db.js).
async function enviarEmailIPBloqueada({ ip, intentos, bloqueadaHasta, destinatarios }) {
  if (!Array.isArray(destinatarios) || destinatarios.length === 0) return;
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: destinatarios.join(", "),
      subject: `SegurPanel - IP bloqueada por intentos de login fallidos (${ip})`,
      html: construirHtmlIPBloqueada({ ip, intentos, bloqueadaHasta }),
    });
  } catch (e) {
    console.error("Error enviando email de aviso de IP bloqueada:", e.message || e);
  }
}

/* ================================================================
   Aviso de inicio de sesion desde un dispositivo o IP nuevos
   ================================================================ */

function construirHtmlDispositivoNuevo({ usuario, ip, userAgent, fecha }) {
  const fechaTexto = new Date(fecha || Date.now()).toLocaleString("es-ES", {
    dateStyle: "long",
    timeStyle: "short",
  });
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Aviso de seguridad: nuevo dispositivo o conexión</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;line-height:1.5;">
        Se ha iniciado sesión en SegurPanel con la cuenta <strong>${escapeHtml(usuario.email)}</strong> desde un dispositivo o dirección IP que no se había usado antes con esta cuenta.
      </p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Usuario:</strong> ${escapeHtml(usuario.name || usuario.email)} (${escapeHtml(usuario.email)})</p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Dirección IP:</strong> ${escapeHtml(ip || "desconocida")}</p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Fecha y hora:</strong> ${escapeHtml(fechaTexto)}</p>
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;word-break:break-all;"><strong>Navegador/dispositivo:</strong> ${escapeHtml(userAgent || "desconocido")}</p>
      <p style="margin:16px 0 0;color:#8a7680;font-size:12px;">
        Si has sido tú, no hace falta ninguna acción. Si no reconoces esta conexión, cambia tu contraseña cuanto antes e informa a un Super Admin.
      </p>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// Fire-and-forget, igual que el resto de avisos de seguridad: nunca debe
// romper el flujo de login que lo origina. Destinatarios: el super_admin
// principal y el propio usuario que ha iniciado sesión (sin duplicar si
// coinciden).
async function enviarEmailDispositivoNuevo({ usuario, ip, userAgent, fecha }) {
  const transporte = obtenerTransportador();
  if (!transporte) return;

  const destinatarios = Array.from(
    new Set([EMAIL_SUPER_ADMIN_PRINCIPAL, usuario.email].filter(Boolean).map((e) => e.toLowerCase()))
  );

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: destinatarios.join(", "),
      subject: `SegurPanel - Nuevo inicio de sesión: ${usuario.email}`,
      html: construirHtmlDispositivoNuevo({ usuario, ip, userAgent, fecha }),
    });
  } catch (e) {
    console.error("Error enviando email de dispositivo nuevo:", e.message || e);
  }
}

/* ================================================================
   Aviso de actividad sospechosa: intentos seguidos sin permiso
   ================================================================ */

function construirHtmlActividadSospechosa({ usuario, ruta, intentos, ip, fecha }) {
  const fechaTexto = new Date(fecha || Date.now()).toLocaleString("es-ES", {
    dateStyle: "long",
    timeStyle: "short",
  });
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Aviso de seguridad: actividad sospechosa</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;line-height:1.5;">
        El usuario <strong>${escapeHtml(usuario.email)}</strong> ha intentado acceder
        <strong>${escapeHtml(String(intentos))} veces seguidas</strong> a una sección para la que su rol
        (<strong>${escapeHtml(usuario.role || "—")}</strong>) no tiene permiso.
      </p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Usuario:</strong> ${escapeHtml(usuario.name || usuario.email)} (${escapeHtml(usuario.email)})</p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;word-break:break-all;"><strong>Último recurso solicitado:</strong> ${escapeHtml(ruta || "—")}</p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Dirección IP:</strong> ${escapeHtml(ip || "desconocida")}</p>
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;"><strong>Fecha y hora:</strong> ${escapeHtml(fechaTexto)}</p>
      <p style="margin:16px 0 0;color:#8a7680;font-size:12px;">
        Revisa el Panel de auditoría si quieres ver el detalle completo de la actividad de este usuario.
      </p>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// Fire-and-forget, igual que enviarEmailIPBloqueada: nunca debe romper el
// flujo (exigirSesion) que lo origina. `destinatarios` es la lista de
// emails de los super_admin activos (la calcula el llamador con
// db.listarSuperAdminsActivos()).
async function enviarEmailActividadSospechosa({ usuario, ruta, intentos, ip, fecha, destinatarios }) {
  if (!Array.isArray(destinatarios) || destinatarios.length === 0) return;
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: destinatarios.join(", "),
      subject: `SegurPanel - Actividad sospechosa: ${usuario.email}`,
      html: construirHtmlActividadSospechosa({ usuario, ruta, intentos, ip, fecha }),
    });
  } catch (e) {
    console.error("Error enviando email de actividad sospechosa:", e.message || e);
  }
}

/* ================================================================
   Reporte diario (09:00) de los scrapers de la Raspberry Pi
   ================================================================ */
//
// `alianzas` y `ofertas` son, cada uno, o bien null (el scraper no ha
// llamado ni una sola vez hoy a /api/alianzas/sync o /api/ofertas/sync,
// ver db.ultimaEjecucionScraperHoy) o bien la fila de scraper_runs de su
// ULTIMA ejecucion de hoy: { encontradas, enviadas, errores, created_at }.

function bloqueEjecucionScraperHtml(titulo, ejecucion) {
  if (!ejecucion) {
    return `
      <div style="margin:0 0 20px;padding:14px 16px;background:#fdf1f1;border-left:4px solid #c0392b;border-radius:6px;">
        <p style="margin:0 0 4px;color:#4a0015;font-size:14px;font-weight:700;">${escapeHtml(titulo)}</p>
        <p style="margin:0;color:#c0392b;font-size:13px;">No se ejecutó hoy (no llegó ninguna sincronización a SegurPanel).</p>
      </div>`;
  }

  const hora = new Date(ejecucion.created_at).toLocaleString("es-ES", { timeStyle: "short" });
  const errores = ejecucion.errores ? ejecucion.errores.split("\n").filter(Boolean) : [];
  const colorBorde = errores.length ? "#c0392b" : "#2e8b57";
  const fondoBloque = errores.length ? "#fdf1f1" : "#f2faf5";

  return `
    <div style="margin:0 0 20px;padding:14px 16px;background:${fondoBloque};border-left:4px solid ${colorBorde};border-radius:6px;">
      <p style="margin:0 0 6px;color:#4a0015;font-size:14px;font-weight:700;">${escapeHtml(titulo)} — ejecutado a las ${escapeHtml(hora)}</p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:13px;">Encontradas: <strong>${escapeHtml(String(ejecucion.encontradas))}</strong> · Enviadas a SegurPanel: <strong>${escapeHtml(String(ejecucion.enviadas))}</strong></p>
      ${
        errores.length
          ? `<p style="margin:8px 0 2px;color:#c0392b;font-size:13px;font-weight:700;">Errores durante la ejecución:</p>${listaHtml(errores)}`
          : `<p style="margin:0;color:#2e8b57;font-size:13px;">Sin errores.</p>`
      }
    </div>`;
}

function construirHtmlReporteDiario({ fecha, alianzas, ofertas }) {
  const fechaTexto = new Date(fecha || Date.now()).toLocaleString("es-ES", { dateStyle: "long" });
  const todoOk = !!alianzas && !!ofertas && !alianzas.errores && !ofertas.errores;
  const badge = todoOk
    ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#2e8b57;color:#fff;font-size:12px;font-weight:700;">OK</span>`
    : `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#c0392b;color:#fff;font-size:12px;font-weight:700;">CON INCIDENCIAS</span>`;

  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;display:flex;align-items:center;gap:14px;">
      <img src="cid:${CID_LOGO_UIC}" alt="UIC" style="height:40px;width:auto;display:block;" />
      <div>
        <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Reporte diario de scrapers — ${escapeHtml(fechaTexto)}</p>
      </div>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 20px;color:#4a0015;font-size:14px;">Estado general: ${badge}</p>
      ${bloqueEjecucionScraperHtml("Scraper Alianzas", alianzas)}
      ${bloqueEjecucionScraperHtml("Scraper Precios/Ofertas", ofertas)}
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente todos los días a las 09:00</p>
    </div>
  </div>
</div>`;
}

// Fire-and-forget, igual que el resto de emails automaticos: nunca debe
// romper el programador diario (ver reportes.js) si falla el envio.
async function enviarEmailReporteDiario({ fecha, alianzas, ofertas }) {
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: EMAIL_SUPER_ADMIN_PRINCIPAL,
      subject: `SegurPanel - Reporte diario de scrapers (${new Date(fecha || Date.now()).toLocaleDateString("es-ES")})`,
      html: construirHtmlReporteDiario({ fecha, alianzas, ofertas }),
      attachments: [adjuntoLogoUIC()],
    });
  } catch (e) {
    console.error("Error enviando el reporte diario de scrapers:", e.message || e);
  }
}

/* ================================================================
   Recuperacion de contraseña ("Olvidaste tu contraseña")
   ================================================================ */

function construirHtmlRecuperacion({ enlace }) {
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Recuperación de contraseña</p>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 20px;color:#4a0015;font-size:14px;line-height:1.5;">
        Hemos recibido una solicitud para restablecer tu contraseña de SegurPanel. Pulsa el botón para elegir una contraseña nueva. El enlace caduca en 30 minutos.
      </p>
      <p style="text-align:center;margin:0 0 20px;">
        <a href="${escapeHtml(enlace)}" style="display:inline-block;padding:12px 24px;background:#8B0026;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Restablecer contraseña</a>
      </p>
      <p style="margin:0;color:#8a7680;font-size:12px;word-break:break-all;">Si el botón no funciona, copia y pega este enlace en tu navegador: ${escapeHtml(enlace)}</p>
      <p style="margin:20px 0 0;color:#8a7680;font-size:12px;">
        Si no has solicitado este cambio, ignora este correo: tu contraseña actual seguirá funcionando.
      </p>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// Fire-and-forget, igual que el resto de avisos: apiForgotPassword en
// server.js siempre responde el mismo mensaje generico al solicitante
// (evita revelar si el correo existe), asi que un fallo de envio aqui no
// debe alterar esa respuesta.
async function enviarEmailRecuperacion(usuario, enlace) {
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: usuario.email,
      subject: "SegurPanel - Recupera tu contraseña",
      html: construirHtmlRecuperacion({ enlace }),
    });
  } catch (e) {
    console.error("Error enviando email de recuperación de contraseña:", e.message || e);
  }
}

/* ================================================================
   Notificacion de nueva solicitud de acceso
   ================================================================ */

function construirHtmlSolicitudAcceso({ correo, name, message, enlaceAdmin }) {
  return `
<div style="background:#f5eef0;padding:32px 16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#E8003D,#8B0026);padding:24px 28px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-family:inherit;">SegurPanel</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Nueva solicitud de acceso</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;line-height:1.5;">
        Alguien ha solicitado acceso a SegurPanel y está pendiente de tu aprobación.
      </p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Correo:</strong> ${escapeHtml(correo)}</p>
      <p style="margin:0 0 4px;color:#4a0015;font-size:14px;"><strong>Nombre:</strong> ${escapeHtml(name || "—")}</p>
      <p style="margin:0 0 16px;color:#4a0015;font-size:14px;"><strong>Motivo:</strong> ${escapeHtml(message || "—")}</p>
      <a href="${escapeHtml(enlaceAdmin)}" style="display:inline-block;padding:12px 24px;background:#8B0026;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Ir al panel de administración</a>
    </div>
    <div style="padding:16px 28px;background:#faf5f6;border-top:1px solid #f0e2e5;">
      <p style="margin:0;color:#8a7680;font-size:12px;">SegurPanel · Uso interno · Enviado automáticamente</p>
    </div>
  </div>
</div>`;
}

// Fire-and-forget, igual que el resto: nunca debe romper apiRequestAccess
// si falla el envio (el solicitante ya recibio su confirmacion en pantalla,
// y la solicitud ya quedo guardada en access_requests de todos modos).
async function enviarEmailSolicitudAcceso({ correo, name, message, enlaceAdmin }) {
  const transporte = obtenerTransportador();
  if (!transporte) return;

  try {
    await transporte.sendMail({
      from: `"SegurPanel" <${process.env.SMTP_USER}>`,
      to: EMAIL_SUPER_ADMIN_PRINCIPAL,
      subject: `SegurPanel - Nueva solicitud de acceso: ${correo}`,
      html: construirHtmlSolicitudAcceso({ correo, name, message, enlaceAdmin }),
    });
  } catch (e) {
    console.error("Error enviando email de solicitud de acceso:", e.message || e);
  }
}

module.exports = {
  enviarEmailAlianzasNuevas,
  enviarEmailCambioClausulas,
  enviarEmailCodigo2FA,
  enviarEmailIPBloqueada,
  enviarEmailDispositivoNuevo,
  enviarEmailActividadSospechosa,
  enviarEmailReporteDiario,
  enviarEmailSolicitudAcceso,
  enviarEmailRecuperacion,
};
