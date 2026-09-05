// db.js
//
// Capa de datos de SegurPanel: usuarios, solicitudes de acceso y sesiones.
// Usa el modulo `node:sqlite` incorporado en Node (estable desde Node 22.5,
// sin flag experimental en Node 24), asi que no hace falta compilar nada
// nativo ni instalar un motor de base de datos aparte.
//
// El fichero de datos vive en DATA_DIR/segurpanel.db (o ./data/segurpanel.db
// si DATA_DIR no esta definida) y esta excluido del repositorio via
// .gitignore: contiene contrasenas hasheadas y no debe subirse a git ni
// compartirse.
//
// En Render (y otros PaaS con filesystem efimero) el directorio del proyecto
// se recrea en cada despliegue, así que hay que montar un disco persistente
// y apuntar DATA_DIR a su punto de montaje (p.ej. DATA_DIR=/data) para que
// los usuarios, sesiones y solicitudes sobrevivan a los despliegues.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DIR_DATOS = process.env.DATA_DIR || path.join(__dirname, "data");
const RUTA_DB = path.join(DIR_DATOS, "segurpanel.db");

fs.mkdirSync(DIR_DATOS, { recursive: true });

const db = new DatabaseSync(RUTA_DB);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    email                 TEXT NOT NULL UNIQUE,
    name                  TEXT,
    password_hash         TEXT,
    role                  TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'retencion')),
    status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')) DEFAULT 'pending',
    must_change_password  INTEGER NOT NULL DEFAULT 1,
    failed_attempts        INTEGER NOT NULL DEFAULT 0,
    locked_until          TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    approved_by           INTEGER REFERENCES users(id),
    approved_at           TEXT
  );

  CREATE TABLE IF NOT EXISTS access_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL,
    name          TEXT,
    message       TEXT,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    created_at    TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    user_agent  TEXT,
    ip          TEXT
  );

  CREATE TABLE IF NOT EXISTS alianzas (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id        TEXT NOT NULL UNIQUE,
    empresa_alarma     TEXT NOT NULL,
    sector             TEXT NOT NULL,
    socio              TEXT NOT NULL,
    tipo_acuerdo       TEXT,
    titular            TEXT,
    fuente             TEXT,
    url                TEXT,
    fecha_publicacion  TEXT,
    fecha_deteccion    TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'published', 'discarded')) DEFAULT 'pending',
    created_at         TEXT NOT NULL,
    reviewed_at        TEXT,
    reviewed_by        INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS contract_stats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    provincia           TEXT,
    empresa             TEXT,
    tipo                TEXT,
    puntuacion          INTEGER,
    clausulas_json      TEXT,
    texto_anonimizado   TEXT,
    user_id             INTEGER REFERENCES users(id),
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tab_visits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    tab         TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_requests_status ON access_requests(status);
  CREATE INDEX IF NOT EXISTS idx_alianzas_status ON alianzas(status);
  CREATE INDEX IF NOT EXISTS idx_contract_stats_provincia ON contract_stats(provincia);
  CREATE INDEX IF NOT EXISTS idx_tab_visits_user ON tab_visits(user_id);
`);

// Migracion defensiva: contract_stats se creo en una version anterior sin
// `tipo` ni `texto_anonimizado` (Repositorio). CREATE TABLE IF NOT EXISTS no
// anade columnas a una tabla que ya existe, asi que en despliegues con base
// de datos previa hay que anadirlas a mano una sola vez, ANTES de crear
// cualquier indice que las use.
function columnaExiste(tabla, columna) {
  return db
    .prepare(`PRAGMA table_info(${tabla})`)
    .all()
    .some((c) => c.name === columna);
}
if (!columnaExiste("contract_stats", "tipo")) {
  db.exec("ALTER TABLE contract_stats ADD COLUMN tipo TEXT");
}
if (!columnaExiste("contract_stats", "texto_anonimizado")) {
  db.exec("ALTER TABLE contract_stats ADD COLUMN texto_anonimizado TEXT");
}

db.exec("CREATE INDEX IF NOT EXISTS idx_contract_stats_empresa_tipo ON contract_stats(empresa, tipo);");

const ahoraISO = () => new Date().toISOString();

/* ---------- Usuarios ---------- */

function buscarUsuarioPorEmail(email) {
  return db
    .prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
    .get(email);
}

function buscarUsuarioPorId(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function listarUsuarios() {
  return db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
}

function crearUsuario({ email, name, passwordHash, role, status, mustChangePassword, approvedBy }) {
  const ahora = ahoraISO();
  const info = db
    .prepare(
      `INSERT INTO users
        (email, name, password_hash, role, status, must_change_password, created_at, updated_at, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      email.toLowerCase(),
      name || null,
      passwordHash,
      role,
      status,
      mustChangePassword ? 1 : 0,
      ahora,
      ahora,
      approvedBy || null,
      approvedBy ? ahora : null
    );
  return buscarUsuarioPorId(Number(info.lastInsertRowid));
}

function actualizarPassword(userId, passwordHash, { mustChangePassword }) {
  db.prepare(
    `UPDATE users
     SET password_hash = ?, must_change_password = ?, updated_at = ?, failed_attempts = 0, locked_until = NULL
     WHERE id = ?`
  ).run(passwordHash, mustChangePassword ? 1 : 0, ahoraISO(), userId);
}

function actualizarRol(userId, role) {
  db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, ahoraISO(), userId);
}

function actualizarEstado(userId, status) {
  db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, ahoraISO(), userId);
}

function registrarIntentoFallido(userId) {
  const usuario = buscarUsuarioPorId(userId);
  const intentos = (usuario.failed_attempts || 0) + 1;
  const UMBRAL_BLOQUEO = 5;
  const MINUTOS_BLOQUEO = 15;
  let bloqueadoHasta = null;
  if (intentos >= UMBRAL_BLOQUEO) {
    bloqueadoHasta = new Date(Date.now() + MINUTOS_BLOQUEO * 60 * 1000).toISOString();
  }
  db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?").run(
    intentos,
    bloqueadoHasta,
    ahoraISO(),
    userId
  );
  return { intentos, bloqueadoHasta };
}

function limpiarIntentosFallidos(userId) {
  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").run(
    ahoraISO(),
    userId
  );
}

/* ---------- Solicitudes de acceso ---------- */

function crearSolicitudAcceso({ email, name, message }) {
  const ahora = ahoraISO();
  const info = db
    .prepare(
      `INSERT INTO access_requests (email, name, message, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    )
    .run(email.toLowerCase(), name || null, message || null, ahora);
  return db.prepare("SELECT * FROM access_requests WHERE id = ?").get(Number(info.lastInsertRowid));
}

function solicitudPendientePorEmail(email) {
  return db
    .prepare("SELECT * FROM access_requests WHERE email = ? COLLATE NOCASE AND status = 'pending'")
    .get(email);
}

function listarSolicitudes(status) {
  if (status) {
    return db
      .prepare("SELECT * FROM access_requests WHERE status = ? ORDER BY created_at DESC")
      .all(status);
  }
  return db.prepare("SELECT * FROM access_requests ORDER BY created_at DESC").all();
}

function buscarSolicitudPorId(id) {
  return db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id);
}

function resolverSolicitud(id, status, resolvedBy) {
  db.prepare(
    "UPDATE access_requests SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?"
  ).run(status, ahoraISO(), resolvedBy, id);
}

/* ---------- Sesiones ---------- */

function crearSesion({ id, userId, expiresAt, userAgent, ip }) {
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked, user_agent, ip)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(id, userId, ahoraISO(), expiresAt, userAgent || null, ip || null);
}

function buscarSesion(id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

function revocarSesion(id) {
  db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(id);
}

function revocarSesionesDeUsuario(userId) {
  db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
}

function limpiarSesionesCaducadas() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(ahoraISO());
}

/* ---------- Alianzas (acuerdos entre empresas de alarmas y otros sectores) ---------- */
//
// El scraper de la Raspberry Pi (scraper_alianzas.py) envia periodicamente
// las alianzas que detecta a POST /api/alianzas/sync. Cada una entra como
// 'pending': solo el Super Admin las ve hasta que las publica (visibles para
// todos) o las descarta (ocultas para siempre). `external_id` es un hash
// estable generado por el scraper a partir de la URL de la noticia, para no
// duplicar la misma alianza en sucesivas ejecuciones diarias.

function insertarAlianzasPendientes(lista) {
  const ahora = ahoraISO();
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO alianzas
      (external_id, empresa_alarma, sector, socio, tipo_acuerdo, titular, fuente, url, fecha_publicacion, fecha_deteccion, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  let insertadas = 0;
  for (const a of lista) {
    const info = insertar.run(
      a.externalId,
      a.empresaAlarma,
      a.sector,
      a.socio,
      a.tipoAcuerdo || null,
      a.titular || null,
      a.fuente || null,
      a.url || null,
      a.fechaPublicacion || null,
      a.fechaDeteccion || ahora,
      ahora
    );
    if (info.changes > 0) insertadas++;
  }
  return insertadas;
}

function alianzaPublica(a) {
  return {
    id: a.id,
    empresaAlarma: a.empresa_alarma,
    sector: a.sector,
    socio: a.socio,
    tipoAcuerdo: a.tipo_acuerdo,
    titular: a.titular,
    fuente: a.fuente,
    url: a.url,
    fechaPublicacion: a.fecha_publicacion,
    fechaDeteccion: a.fecha_deteccion,
    status: a.status,
  };
}

function listarAlianzasPorEstado(status) {
  return db
    .prepare("SELECT * FROM alianzas WHERE status = ? ORDER BY fecha_deteccion DESC, id DESC")
    .all(status)
    .map(alianzaPublica);
}

function buscarAlianzaPorId(id) {
  return db.prepare("SELECT * FROM alianzas WHERE id = ?").get(id);
}

function resolverAlianza(id, status, reviewedBy) {
  db.prepare(
    "UPDATE alianzas SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?"
  ).run(status, ahoraISO(), reviewedBy, id);
}

function fechaUltimaAlianza() {
  const fila = db.prepare("SELECT MAX(created_at) AS ultima FROM alianzas").get();
  return (fila && fila.ultima) || null;
}

/* ---------- Estadisticas y Repositorio (contract_stats) ---------- */
//
// contract_stats guarda, por cada contrato pasado por /api/analisis,
// provincia + empresa detectadas (antes de anonimizar), la puntuacion y
// clausulas de riesgo ya calculadas, y el texto YA ANONIMIZADO completo
// (Repositorio): nunca el texto original ni ningun dato personal, porque la
// anonimizacion ya sustituyo nombres/DNI/IBAN/telefono/email/direccion/CP
// antes de que este texto se genere. `tipo` (hogar/negocio) se detecta
// automaticamente por palabras clave (ver detectarTipoContrato en
// analisis.js) y se guarda ya en el INSERT; si no hay certeza (o para
// contratos antiguos de antes de esta deteccion), llega vacio y se puede
// rellenar despues desde la pestana Analisis o Repositorio.
// tab_visits registra que un usuario ha abierto una pestana de la app, para
// poder mostrar "pestañas mas usadas" en la actividad del equipo.

function registrarContratoAnalizado({ provincia, empresa, puntuacion, clausulas, textoAnonimizado, userId, tipo }) {
  const info = db
    .prepare(
      `INSERT INTO contract_stats (provincia, empresa, puntuacion, clausulas_json, texto_anonimizado, user_id, created_at, tipo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      provincia || null,
      empresa || null,
      Number.isFinite(puntuacion) ? puntuacion : null,
      JSON.stringify(clausulas || []),
      textoAnonimizado || null,
      userId || null,
      ahoraISO(),
      tipo === "hogar" || tipo === "negocio" ? tipo : null
    );
  return Number(info.lastInsertRowid);
}

function contarContratosAnalizados() {
  return db.prepare("SELECT COUNT(*) AS n FROM contract_stats").get().n;
}

// created_at se guarda en UTC (new Date().toISOString()); date('now') de
// SQLite tambien es UTC por defecto, asi que ambas fechas son comparables
// sin conversion de zona horaria.
function contarContratosAnalizadosHoy() {
  return db
    .prepare("SELECT COUNT(*) AS n FROM contract_stats WHERE date(created_at) = date('now')")
    .get().n;
}

// "Alerta activa" = contrato de riesgo alto o muy alto detectado hoy
// (mismo umbral que nivelDesdeRiesgo en server.js: puntuacion > 6).
function contarAlertasActivasHoy() {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM contract_stats WHERE date(created_at) = date('now') AND puntuacion > 6"
    )
    .get().n;
}

function riesgoPromedioContratos() {
  const fila = db.prepare("SELECT AVG(puntuacion) AS media FROM contract_stats WHERE puntuacion IS NOT NULL").get();
  return fila && fila.media !== null ? fila.media : null;
}

function listarClausulasContratos() {
  return db.prepare("SELECT clausulas_json FROM contract_stats WHERE clausulas_json IS NOT NULL").all();
}

/* ---------- Repositorio de contratos ---------- */
//
// Vista completa (no solo agregada) de contract_stats: listado para
// filtrar/clasificar/detectar cambios, y detalle individual con el texto
// anonimizado completo. Se listan SIEMPRE en orden cronologico ascendente
// para que la deteccion de cambios (server.js) compare cada contrato con el
// inmediatamente anterior de su mismo grupo empresa+tipo.

function listarRepositorioResumen() {
  return db
    .prepare(
      `SELECT id, provincia, empresa, tipo, puntuacion, clausulas_json, created_at, user_id
       FROM contract_stats
       ORDER BY created_at ASC, id ASC`
    )
    .all();
}

function obtenerContratoDetalle(id) {
  return db.prepare("SELECT * FROM contract_stats WHERE id = ?").get(id);
}

function clasificarContrato(id, tipo) {
  db.prepare("UPDATE contract_stats SET tipo = ? WHERE id = ?").run(tipo, id);
  return db.prepare("SELECT id, tipo FROM contract_stats WHERE id = ?").get(id);
}

function estadisticasPorProvincia() {
  return db
    .prepare(
      `SELECT provincia, empresa, COUNT(*) AS n
       FROM contract_stats
       WHERE provincia IS NOT NULL AND empresa IS NOT NULL
       GROUP BY provincia, empresa
       ORDER BY provincia ASC, n DESC`
    )
    .all();
}

function contarUsuariosActivos() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").get().n;
}

function registrarVisitaTab({ userId, tab }) {
  db.prepare("INSERT INTO tab_visits (user_id, tab, created_at) VALUES (?, ?, ?)").run(userId, tab, ahoraISO());
}

function actividadUsuariosActivos() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role,
              (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) AS ultima_conexion
       FROM users u
       WHERE u.status = 'active'
       ORDER BY ultima_conexion DESC`
    )
    .all();
}

function conteoVisitasPorUsuarioYTab() {
  return db
    .prepare(
      `SELECT user_id, tab, COUNT(*) AS n
       FROM tab_visits
       GROUP BY user_id, tab`
    )
    .all();
}

module.exports = {
  db,
  DIR_DATOS,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  listarUsuarios,
  crearUsuario,
  actualizarPassword,
  actualizarRol,
  actualizarEstado,
  registrarIntentoFallido,
  limpiarIntentosFallidos,
  crearSolicitudAcceso,
  solicitudPendientePorEmail,
  listarSolicitudes,
  buscarSolicitudPorId,
  resolverSolicitud,
  crearSesion,
  buscarSesion,
  revocarSesion,
  revocarSesionesDeUsuario,
  limpiarSesionesCaducadas,
  insertarAlianzasPendientes,
  listarAlianzasPorEstado,
  buscarAlianzaPorId,
  resolverAlianza,
  fechaUltimaAlianza,
  registrarContratoAnalizado,
  contarContratosAnalizados,
  contarContratosAnalizadosHoy,
  contarAlertasActivasHoy,
  riesgoPromedioContratos,
  listarClausulasContratos,
  listarRepositorioResumen,
  obtenerContratoDetalle,
  clasificarContrato,
  estadisticasPorProvincia,
  contarUsuariosActivos,
  registrarVisitaTab,
  actividadUsuariosActivos,
  conteoVisitasPorUsuarioYTab,
};
