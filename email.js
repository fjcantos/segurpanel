// email.js
//
// Notificaciones por email (SMTP de Gmail): avisa a los administradores
// cuando el scraper de la Raspberry Pi envía una alianza nueva a
// POST /api/alianzas/nueva (ver apiAlianzasNueva en server.js). Usa las
// credenciales SMTP_USER/SMTP_PASSWORD ya configuradas en el entorno para el
// envío de correo por Gmail. Si no están definidas, se registra un aviso en
// el log y se ignora en silencio: nunca debe romper la ingesta del scraper.

const nodemailer = require("nodemailer");

const DESTINATARIOS_ALIANZAS = ["fjose.cantos@verisure.es", "calvorotador@gmail.com"];

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

module.exports = { enviarEmailAlianzasNuevas };
