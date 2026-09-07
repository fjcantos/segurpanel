// backup.js
//
// Backup automatico diario de la base de datos SQLite: cada dia a las 02:00
// (hora local del servidor) copia segurpanel.db a DIR_DATOS/backups/ con la
// fecha en el nombre, y mantiene solo los ultimos 7. No usa ninguna
// dependencia de cron externa: server.js llama a `iniciarProgramador()` una
// vez al arrancar, que arma un setInterval de 60s comprobando la hora
// actual (ver decision del usuario: setInterval interno en vez de
// node-cron).
//
// DIR_DATOS ya es /data en Render (via DATA_DIR) y ./data en local (ver
// db.js), asi que DIR_BACKUPS = DIR_DATOS/backups sobrevive a despliegues
// igual que el resto de datos persistentes.

const fs = require("fs");
const path = require("path");
const db = require("./db");

const RUTA_DB = path.join(db.DIR_DATOS, "segurpanel.db");
const DIR_BACKUPS = path.join(db.DIR_DATOS, "backups");
const MAX_BACKUPS = 7;
const HORA_BACKUP = 2; // 02:00
const MINUTO_BACKUP = 0;

fs.mkdirSync(DIR_BACKUPS, { recursive: true });

function nombreBackup(fecha) {
  const iso = fecha.toISOString().slice(0, 10); // YYYY-MM-DD
  return `segurpanel-${iso}.db`;
}

function limpiarBackupsAntiguos() {
  const archivos = fs
    .readdirSync(DIR_BACKUPS)
    .filter((f) => /^segurpanel-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort(); // orden lexicografico == orden cronologico (nombre con fecha ISO)

  const sobrantes = archivos.length - MAX_BACKUPS;
  for (let i = 0; i < sobrantes; i++) {
    try {
      fs.unlinkSync(path.join(DIR_BACKUPS, archivos[i]));
    } catch (e) {
      console.error(`Error borrando backup antiguo ${archivos[i]}:`, e.message || e);
    }
  }
}

// PRAGMA wal_checkpoint(FULL) vuelca todo el WAL al fichero .db principal
// (db.js usa journal_mode = WAL), imprescindible para que la copia del .db
// contenga los datos ya confirmados sin depender de los ficheros -wal/-shm.
function ejecutarBackup() {
  try {
    db.db.exec("PRAGMA wal_checkpoint(FULL);");
    const destino = path.join(DIR_BACKUPS, nombreBackup(new Date()));
    fs.copyFileSync(RUTA_DB, destino);
    limpiarBackupsAntiguos();
    console.log(`Backup diario completado: ${destino}`);
  } catch (e) {
    console.error("Error ejecutando el backup diario:", e.message || e);
  }
}

// Arma el temporizador que dispara ejecutarBackup() la primera vez que el
// reloj local marca HORA_BACKUP:MINUTO_BACKUP, con una guarda por fecha para
// no repetirlo dos veces el mismo dia (el setInterval sigue corriendo cada
// minuto durante toda la ejecucion del proceso).
function iniciarProgramador() {
  let ultimaFechaBackup = null;

  setInterval(() => {
    const ahora = new Date();
    if (ahora.getHours() !== HORA_BACKUP || ahora.getMinutes() !== MINUTO_BACKUP) return;

    const hoy = ahora.toISOString().slice(0, 10);
    if (ultimaFechaBackup === hoy) return;

    ultimaFechaBackup = hoy;
    ejecutarBackup();
  }, 60 * 1000);
}

module.exports = { iniciarProgramador, ejecutarBackup, DIR_BACKUPS };
