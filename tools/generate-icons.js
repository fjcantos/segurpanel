// tools/generate-icons.js
//
// Genera los iconos PNG de la PWA sin dependencias externas: dibuja el escudo
// de SegurPanel por software y codifica el PNG a mano (solo zlib de Node).
//
//   node tools/generate-icons.js
//
// Salida: icons/icon-192.png, icon-512.png, icon-180.png (Apple) y icon-32.png.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const NAVY = [11, 37, 69];      // #0b2545
const WHITE = [255, 255, 255];  // #ffffff
const GREEN = [31, 157, 85];    // #1f9d55

/* ---------- Codificador PNG minimo (RGBA, 8 bits) ---------- */

const TABLA_CRC = (() => {
  const tabla = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c;
  }
  return tabla;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozo(tipo, datos) {
  const nombre = Buffer.from(tipo, "ascii");
  const longitud = Buffer.alloc(4);
  longitud.writeUInt32BE(datos.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([nombre, datos])), 0);
  return Buffer.concat([longitud, nombre, datos, crc]);
}

function codificarPNG(ancho, alto, rgba) {
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8;  // profundidad de bits
  cabecera[9] = 6;  // color RGBA
  // 10, 11, 12 = compresion/filtro/entrelazado por defecto (0)

  // Scanlines con byte de filtro 0 al inicio de cada fila.
  const crudo = Buffer.alloc(alto * (1 + ancho * 4));
  for (let y = 0; y < alto; y++) {
    const destino = y * (1 + ancho * 4);
    crudo[destino] = 0;
    rgba.copy(crudo, destino + 1, y * ancho * 4, (y + 1) * ancho * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo("IHDR", cabecera),
    trozo("IDAT", zlib.deflateSync(crudo, { level: 9 })),
    trozo("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- Geometria del escudo ---------- */
//
// Se reutiliza el mismo trazado del logotipo de la cabecera de index.html
// (viewBox 24x24) para que icono y logo sean la misma marca:
//   escudo: M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z
//   check:  M9 12l2 2 4-4

const PASOS_BEZIER = 16;

function cubica(p0, c1, c2, p1, t) {
  const s = 1 - t;
  return [0, 1].map(
    (i) =>
      s * s * s * p0[i] +
      3 * s * s * t * c1[i] +
      3 * s * t * t * c2[i] +
      t * t * t * p1[i]
  );
}

// Contorno del escudo aplanado a poligono, en coordenadas del viewBox 24x24.
const CONTORNO_ESCUDO = (() => {
  const puntos = [[12, 3], [19, 6], [19, 11]];
  const curvas = [
    { p0: [19, 11], c1: [19, 15.5], c2: [16, 18.7], p1: [12, 20] },
    { p0: [12, 20], c1: [8, 18.7], c2: [5, 15.5], p1: [5, 11] },
  ];
  for (const { p0, c1, c2, p1 } of curvas) {
    for (let i = 1; i <= PASOS_BEZIER; i++) {
      puntos.push(cubica(p0, c1, c2, p1, i / PASOS_BEZIER));
    }
  }
  puntos.push([5, 6]);
  return puntos;
})();

const CAJA_ESCUDO = (() => {
  const xs = CONTORNO_ESCUDO.map((p) => p[0]);
  const ys = CONTORNO_ESCUDO.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, alto: maxY - minY };
})();

function dentroPoligono(x, y, poligono) {
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const [xi, yi] = poligono[i];
    const [xj, yj] = poligono[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      dentro = !dentro;
    }
  }
  return dentro;
}

// Distancia de un punto a un segmento.
function distanciaSegmento(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const largo2 = dx * dx + dy * dy;
  let t = largo2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / largo2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const CHECK = [[8.7, 12.1], [11, 14.4], [15.4, 10]];
const GROSOR_CHECK = 1.25; // radio del trazo, en unidades del viewBox

function dentroCheck(x, y) {
  for (let i = 0; i < CHECK.length - 1; i++) {
    const [ax, ay] = CHECK[i];
    const [bx, by] = CHECK[i + 1];
    if (distanciaSegmento(x, y, ax, ay, bx, by) <= GROSOR_CHECK) return true;
  }
  return false;
}

/* ---------- Render ---------- */

const MUESTRAS = 4; // supersampling NxN para suavizar bordes

// El escudo ocupa el 58% de la altura del lienzo: cabe en el 80% central que
// exigen los iconos "maskable" de Android.
const ALTO_ESCUDO = 0.58;

function dibujarIcono(tam) {
  const rgba = Buffer.alloc(tam * tam * 4);
  const centro = tam / 2;
  const escala = (tam * ALTO_ESCUDO) / CAJA_ESCUDO.alto;
  const paso = 1 / MUESTRAS;
  const total = MUESTRAS * MUESTRAS;

  for (let y = 0; y < tam; y++) {
    for (let x = 0; x < tam; x++) {
      let cobEscudo = 0;
      let cobCheck = 0;

      for (let sy = 0; sy < MUESTRAS; sy++) {
        for (let sx = 0; sx < MUESTRAS; sx++) {
          // Pixel del lienzo -> coordenadas del viewBox 24x24.
          const vx = (x + (sx + 0.5) * paso - centro) / escala + CAJA_ESCUDO.cx;
          const vy = (y + (sy + 0.5) * paso - centro) / escala + CAJA_ESCUDO.cy;
          if (dentroPoligono(vx, vy, CONTORNO_ESCUDO)) {
            cobEscudo++;
            if (dentroCheck(vx, vy)) cobCheck++;
          }
        }
      }

      const aEscudo = cobEscudo / total;
      const aCheck = cobCheck / total;

      // Fondo navy a sangre (lo exigen los iconos "maskable" de Android),
      // escudo blanco encima y check verde sobre el escudo.
      const i = (y * tam + x) * 4;
      for (let c = 0; c < 3; c++) {
        const conEscudo = NAVY[c] + (WHITE[c] - NAVY[c]) * aEscudo;
        rgba[i + c] = Math.round(conEscudo + (GREEN[c] - conEscudo) * aCheck);
      }
      rgba[i + 3] = 255;
    }
  }

  return codificarPNG(tam, tam, rgba);
}

const salida = path.join(__dirname, "..", "icons");
fs.mkdirSync(salida, { recursive: true });

for (const tam of [32, 180, 192, 512]) {
  const archivo = path.join(salida, `icon-${tam}.png`);
  fs.writeFileSync(archivo, dibujarIcono(tam));
  console.log(`Generado ${path.relative(path.join(__dirname, ".."), archivo)} (${tam}x${tam})`);
}
