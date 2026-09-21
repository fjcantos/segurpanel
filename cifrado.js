// cifrado.js
//
// Cifrado en reposo (AES-256-GCM) de los campos mas sensibles guardados en
// SQLite: el texto ya anonimizado de los contratos analizados
// (contract_stats.texto_anonimizado, contratos_avanzados.texto_anonimizado)
// y el detalle de los logs de auditoria (audit_log.detail). Lo usa db.js,
// de forma transparente para el resto de la aplicacion: server.js sigue
// leyendo/escribiendo estos campos como texto plano de siempre, es db.js
// quien cifra justo antes de un INSERT y descifra justo despues de un
// SELECT.
//
// La clave se deriva (SHA-256, para admitir cualquier longitud/formato de
// entrada) de la variable de entorno ENCRYPTION_KEY. En Render se
// configura como variable de entorno del servicio, igual que JWT_SECRET o
// SMTP_USER/SMTP_PASSWORD.
//
// Compatibilidad retroactiva: los valores cifrados por esta version llevan
// el prefijo PREFIJO_CIFRADO. Al descifrar, cualquier valor que NO lleve
// ese prefijo se devuelve tal cual (texto plano de antes de activar el
// cifrado): asi las filas ya existentes en la base de datos se siguen
// pudiendo leer con normalidad, sin necesitar una migracion sincrona de
// toda la tabla justo en el momento del despliegue.

const crypto = require("crypto");

const PREFIJO_CIFRADO = "enc:v1:";
const ALGORITMO = "aes-256-gcm";
const LONGITUD_IV = 12; // 12 bytes es el tamaño de IV recomendado para GCM
const LONGITUD_TAG = 16; // tamaño fijo del tag de autenticacion de GCM

let avisoClaveMostrado = false;

// Deriva una clave de 32 bytes (AES-256) a partir de ENCRYPTION_KEY,
// cualquiera que sea su longitud/formato original. Si no esta configurada,
// devuelve null: el resto de funciones de este modulo degradan entonces a
// "no cifrar" en vez de romper la aplicacion, igual que el resto de
// integraciones opcionales del proyecto (SMTP, Unsplash...) cuando falta
// alguna variable de entorno.
function obtenerClave() {
  const claveEnv = process.env.ENCRYPTION_KEY;
  if (!claveEnv) {
    if (!avisoClaveMostrado) {
      console.warn(
        "AVISO: ENCRYPTION_KEY no está configurada. Los datos sensibles (textos de contratos anonimizados, detalle de los logs de auditoría) se guardarán SIN cifrar. Defínela (en Render, y en local si quieres probar el cifrado) para activar el cifrado en reposo."
      );
      avisoClaveMostrado = true;
    }
    return null;
  }
  return crypto.createHash("sha256").update(String(claveEnv)).digest();
}

// Cifra un texto. Si no hay ENCRYPTION_KEY configurada, lo devuelve tal
// cual (sin el prefijo, para que quede claro que sigue en texto plano).
// null/undefined pasan sin tocar (columnas opcionales).
function cifrar(texto) {
  if (texto == null) return texto;
  const clave = obtenerClave();
  if (!clave) return texto;

  const iv = crypto.randomBytes(LONGITUD_IV);
  const cifradorObj = crypto.createCipheriv(ALGORITMO, clave, iv);
  const cifrado = Buffer.concat([cifradorObj.update(String(texto), "utf8"), cifradorObj.final()]);
  const tag = cifradorObj.getAuthTag();
  // iv + tag + cifrado, todo junto en una sola columna TEXT (base64) en vez
  // de tres columnas separadas: mas simple de encajar en el esquema actual.
  return PREFIJO_CIFRADO + Buffer.concat([iv, tag, cifrado]).toString("base64");
}

// Descifra un valor cifrado por cifrar(). Si no lleva el prefijo (texto
// plano de antes de activar el cifrado, o ENCRYPTION_KEY sin configurar en
// el momento de guardarlo), se devuelve tal cual. Si lleva el prefijo pero
// no se puede descifrar (clave incorrecta o cambiada, dato corrupto),
// devuelve un marcador en vez de lanzar una excepcion que tumbe toda la
// peticion que lo estaba leyendo.
function descifrar(valor) {
  if (valor == null || typeof valor !== "string" || !valor.startsWith(PREFIJO_CIFRADO)) {
    return valor;
  }
  const clave = obtenerClave();
  if (!clave) return "[cifrado: falta ENCRYPTION_KEY para descifrar]";

  try {
    const datos = Buffer.from(valor.slice(PREFIJO_CIFRADO.length), "base64");
    const iv = datos.subarray(0, LONGITUD_IV);
    const tag = datos.subarray(LONGITUD_IV, LONGITUD_IV + LONGITUD_TAG);
    const cifrado = datos.subarray(LONGITUD_IV + LONGITUD_TAG);
    const descifradorObj = crypto.createDecipheriv(ALGORITMO, clave, iv);
    descifradorObj.setAuthTag(tag);
    return Buffer.concat([descifradorObj.update(cifrado), descifradorObj.final()]).toString("utf8");
  } catch (e) {
    console.error("Error descifrando un campo (clave ENCRYPTION_KEY incorrecta/cambiada, o dato corrupto):", e.message);
    return "[error al descifrar: revisa ENCRYPTION_KEY]";
  }
}

module.exports = { cifrar, descifrar };
