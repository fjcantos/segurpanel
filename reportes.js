// reportes.js
//
// Reporte diario por email (09:00, hora local del servidor) con el resumen
// de los scrapers de la Raspberry Pi (scraper_alianzas.py / scraper_precios.py):
// si se ejecutaron hoy, cuanto encontraron/enviaron y si hubo errores. Se
// basa en la tabla `scraper_runs` (ver db.registrarEjecucionScraper, que
// rellenan apiAlianzasSync/apiOfertasSync en server.js cada vez que un
// scraper llama a /sync, incluso sin nada nuevo que enviar).
//
// Mismo patron que backup.js: sin dependencia de cron externo, un
// setInterval de 60s con una guarda por fecha para no repetir el envio dos
// veces el mismo dia.

const db = require("./db");
const email = require("./email");

const HORA_REPORTE = 9; // 09:00
const MINUTO_REPORTE = 0;

async function enviarReporteDiario() {
  try {
    const alianzas = db.ultimaEjecucionScraperHoy("alianzas");
    const ofertas = db.ultimaEjecucionScraperHoy("ofertas");
    await email.enviarEmailReporteDiario({ fecha: new Date(), alianzas, ofertas });
    console.log("Reporte diario de scrapers enviado.");
  } catch (e) {
    console.error("Error generando/enviando el reporte diario de scrapers:", e.message || e);
  }
}

function iniciarProgramador() {
  let ultimaFechaReporte = null;

  setInterval(() => {
    const ahora = new Date();
    if (ahora.getHours() !== HORA_REPORTE || ahora.getMinutes() !== MINUTO_REPORTE) return;

    const hoy = ahora.toISOString().slice(0, 10);
    if (ultimaFechaReporte === hoy) return;

    ultimaFechaReporte = hoy;
    enviarReporteDiario();
  }, 60 * 1000);
}

module.exports = { iniciarProgramador, enviarReporteDiario };
