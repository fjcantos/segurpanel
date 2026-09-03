// tools/generate-icons.js
//
// Genera los iconos PWA de SegurPanel a partir del logo real
// (assets/LOGO_UIC_limpio.png) sin dependencias externas: decodifica y
// recodifica PNG a mano (solo el modulo zlib de Node para inflate/deflate).
//
//   node tools/generate-icons.js
//
// Salida en icons/:
//   icon-32.png, icon-180.png, icon-192.png, icon-512.png   (purpose: any,
//     fondo transparente, recortados al contenido real del logo)
//   icon-192-maskable.png, icon-512-maskable.png             (purpose:
//     maskable, fondo navy solido + logo al 65% centrado, para que Android
//     no recorte mal el escudo al aplicar la mascara del icono)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ORIGEN = path.join(__dirname, "..", "assets", "LOGO_UIC_limpio.png");
const SALIDA = path.join(__dirname, "..", "icons");
const NAVY = [11, 37, 69]; // #0b2545, fondo de marca para los iconos maskable

/* ================================================================
   Decodificador PNG minimo (8 bits, color RGBA o RGB, sin entrelazar)
   ================================================================ */

function leerPNG(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("No es un PNG valido");
  }

  let offset = 8;
  let ihdr = null;
  const idat = [];
  let paleta = null;
  let transparencia = null;

  while (offset < buffer.length) {
    const longitud = buffer.readUInt32BE(offset);
    const tipo = buffer.toString("ascii", offset + 4, offset + 8);
    const datos = buffer.subarray(offset + 8, offset + 8 + longitud);

    if (tipo === "IHDR") {
      ihdr = {
        ancho: datos.readUInt32BE(0),
        alto: datos.readUInt32BE(4),
        profundidad: datos[8],
        colorType: datos[9],
        entrelazado: datos[12],
      };
    } else if (tipo === "IDAT") {
      idat.push(datos);
    } else if (tipo === "PLTE") {
      paleta = datos;
    } else if (tipo === "tRNS") {
      transparencia = datos;
    } else if (tipo === "IEND") {
      break;
    }

    offset += 12 + longitud;
  }

  if (!ihdr) throw new Error("PNG sin IHDR");
  if (ihdr.profundidad !== 8) throw new Error("Solo se admite profundidad de 8 bits");
  if (ihdr.entrelazado !== 0) throw new Error("No se admite PNG entrelazado (Adam7)");
  if (![2, 3, 6].includes(ihdr.colorType)) {
    throw new Error(`Tipo de color PNG no soportado: ${ihdr.colorType}`);
  }

  const crudo = zlib.inflateSync(Buffer.concat(idat));

  const canalesPorTipo = { 2: 3, 3: 1, 6: 4 };
  const canales = canalesPorTipo[ihdr.colorType];
  const bytesPorPixel = canales; // 8 bits por canal
  const bytesPorFila = ihdr.ancho * bytesPorPixel;

  const sinFiltrar = Buffer.alloc(ihdr.alto * bytesPorFila);

  let posEntrada = 0;
  for (let y = 0; y < ihdr.alto; y++) {
    const filtro = crudo[posEntrada];
    posEntrada += 1;
    const filaEntrada = crudo.subarray(posEntrada, posEntrada + bytesPorFila);
    posEntrada += bytesPorFila;

    const filaSalida = sinFiltrar.subarray(y * bytesPorFila, (y + 1) * bytesPorFila);
    const filaAnterior = y > 0 ? sinFiltrar.subarray((y - 1) * bytesPorFila, y * bytesPorFila) : null;

    for (let i = 0; i < bytesPorFila; i++) {
      const izquierda = i >= bytesPorPixel ? filaSalida[i - bytesPorPixel] : 0;
      const arriba = filaAnterior ? filaAnterior[i] : 0;
      const arribaIzquierda = filaAnterior && i >= bytesPorPixel ? filaAnterior[i - bytesPorPixel] : 0;
      const x = filaEntrada[i];

      let valor;
      switch (filtro) {
        case 0: // None
          valor = x;
          break;
        case 1: // Sub
          valor = x + izquierda;
          break;
        case 2: // Up
          valor = x + arriba;
          break;
        case 3: // Average
          valor = x + Math.floor((izquierda + arriba) / 2);
          break;
        case 4: { // Paeth
          const p = izquierda + arriba - arribaIzquierda;
          const pa = Math.abs(p - izquierda);
          const pb = Math.abs(p - arriba);
          const pc = Math.abs(p - arribaIzquierda);
          let predictor;
          if (pa <= pb && pa <= pc) predictor = izquierda;
          else if (pb <= pc) predictor = arriba;
          else predictor = arribaIzquierda;
          valor = x + predictor;
          break;
        }
        default:
          throw new Error(`Tipo de filtro PNG desconocido: ${filtro}`);
      }
      filaSalida[i] = valor & 0xff;
    }
  }

  // Normaliza siempre a RGBA para simplificar el resto del pipeline.
  const rgba = Buffer.alloc(ihdr.ancho * ihdr.alto * 4);
  for (let p = 0; p < ihdr.ancho * ihdr.alto; p++) {
    let r, g, b, a;
    if (ihdr.colorType === 6) {
      r = sinFiltrar[p * 4];
      g = sinFiltrar[p * 4 + 1];
      b = sinFiltrar[p * 4 + 2];
      a = sinFiltrar[p * 4 + 3];
    } else if (ihdr.colorType === 2) {
      r = sinFiltrar[p * 3];
      g = sinFiltrar[p * 3 + 1];
      b = sinFiltrar[p * 3 + 2];
      a = 255;
    } else {
      // Paleta (color type 3): cada byte es un indice a PLTE/tRNS.
      const indice = sinFiltrar[p];
      r = paleta[indice * 3];
      g = paleta[indice * 3 + 1];
      b = paleta[indice * 3 + 2];
      a = transparencia && indice < transparencia.length ? transparencia[indice] : 255;
    }
    rgba[p * 4] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = a;
  }

  return { ancho: ihdr.ancho, alto: ihdr.alto, rgba };
}

/* ================================================================
   Codificador PNG minimo (RGBA, 8 bits) — igual que el generador anterior
   ================================================================ */

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

function escribirPNG(ancho, alto, rgba) {
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8;
  cabecera[9] = 6;

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

/* ================================================================
   Recorte al contenido real (bounding box por alfa) y reescalado
   ================================================================ */

// Bounding box del componente conectado con mas pixeles opacos, en vez del
// bbox global de alfa: el PNG de origen trae alguna marca aislada suelta
// (p.ej. una esquina de recorte del generador de imagenes) separada del
// sello, y un bbox global la incluiria descuadrando el icono. Se trabaja
// sobre una rejilla reducida (bloques de PASO px) para que el flood fill
// sea rapido en una imagen de varios megapixeles.
function bboxComponenteMayor(img, umbralAlfa = 50) {
  const PASO = 4;
  const cols = Math.ceil(img.ancho / PASO);
  const filas = Math.ceil(img.alto / PASO);
  const ocupado = new Uint8Array(cols * filas);

  for (let gy = 0; gy < filas; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = gx * PASO, y0 = gy * PASO;
      const x1 = Math.min(img.ancho, x0 + PASO);
      const y1 = Math.min(img.alto, y0 + PASO);
      let maxA = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const a = img.rgba[(y * img.ancho + x) * 4 + 3];
          if (a > maxA) maxA = a;
        }
      }
      if (maxA > umbralAlfa) ocupado[gy * cols + gx] = 1;
    }
  }

  const visitado = new Uint8Array(cols * filas);
  let mejor = null;
  const pila = [];

  for (let inicio = 0; inicio < cols * filas; inicio++) {
    if (!ocupado[inicio] || visitado[inicio]) continue;

    let tam = 0;
    let minGX = cols, minGY = filas, maxGX = -1, maxGY = -1;
    pila.push(inicio);
    visitado[inicio] = 1;

    while (pila.length) {
      const idx = pila.pop();
      const gx = idx % cols;
      const gy = (idx - gx) / cols;
      tam++;
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gy < minGY) minGY = gy;
      if (gy > maxGY) maxGY = gy;

      const vecinos = [
        gx > 0 ? idx - 1 : -1,
        gx < cols - 1 ? idx + 1 : -1,
        gy > 0 ? idx - cols : -1,
        gy < filas - 1 ? idx + cols : -1,
      ];
      for (const v of vecinos) {
        if (v >= 0 && ocupado[v] && !visitado[v]) {
          visitado[v] = 1;
          pila.push(v);
        }
      }
    }

    if (!mejor || tam > mejor.tam) {
      mejor = { tam, minGX, minGY, maxGX, maxGY };
    }
  }

  if (!mejor) return { minX: 0, minY: 0, maxX: img.ancho - 1, maxY: img.alto - 1 };

  return {
    minX: Math.max(0, mejor.minGX * PASO),
    minY: Math.max(0, mejor.minGY * PASO),
    maxX: Math.min(img.ancho - 1, (mejor.maxGX + 1) * PASO - 1),
    maxY: Math.min(img.alto - 1, (mejor.maxGY + 1) * PASO - 1),
  };
}

// Recorta a un cuadrado centrado en el contenido, con un margen extra, y
// devuelve un buffer RGBA cuadrado (relleno transparente si se sale del origen).
function recortarCuadrado(img, bbox, margenFraccion) {
  const anchoContenido = bbox.maxX - bbox.minX + 1;
  const altoContenido = bbox.maxY - bbox.minY + 1;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const lado = Math.round(Math.max(anchoContenido, altoContenido) * (1 + margenFraccion));

  const salida = Buffer.alloc(lado * lado * 4); // transparente por defecto
  const origenX = Math.round(cx - lado / 2);
  const origenY = Math.round(cy - lado / 2);

  for (let y = 0; y < lado; y++) {
    const sy = origenY + y;
    if (sy < 0 || sy >= img.alto) continue;
    for (let x = 0; x < lado; x++) {
      const sx = origenX + x;
      if (sx < 0 || sx >= img.ancho) continue;
      const iEntrada = (sy * img.ancho + sx) * 4;
      const iSalida = (y * lado + x) * 4;
      salida[iSalida] = img.rgba[iEntrada];
      salida[iSalida + 1] = img.rgba[iEntrada + 1];
      salida[iSalida + 2] = img.rgba[iEntrada + 2];
      salida[iSalida + 3] = img.rgba[iEntrada + 3];
    }
  }
  return { ancho: lado, alto: lado, rgba: salida };
}

// Reescalado por promediado de area (buena calidad al reducir tamano).
function reescalar(img, tamDestino) {
  const salida = Buffer.alloc(tamDestino * tamDestino * 4);
  const escala = img.ancho / tamDestino;

  for (let y = 0; y < tamDestino; y++) {
    const y0 = y * escala;
    const y1 = (y + 1) * escala;
    for (let x = 0; x < tamDestino; x++) {
      const x0 = x * escala;
      const x1 = (x + 1) * escala;

      let r = 0, g = 0, b = 0, a = 0, pesoTotal = 0, pesoGeom = 0;
      const ixStart = Math.floor(x0);
      const ixEnd = Math.min(img.ancho - 1, Math.ceil(x1) - 1);
      const iyStart = Math.floor(y0);
      const iyEnd = Math.min(img.alto - 1, Math.ceil(y1) - 1);

      for (let sy = iyStart; sy <= iyEnd; sy++) {
        const pesoY = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (pesoY <= 0) continue;
        for (let sx = ixStart; sx <= ixEnd; sx++) {
          const pesoX = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (pesoX <= 0) continue;
          const peso = pesoX * pesoY;
          const i = (sy * img.ancho + sx) * 4;
          const alfa = img.rgba[i + 3];
          // Se pondera el color por su propio alfa para no mezclar el
          // color de pixeles totalmente transparentes en el borde.
          const pesoColor = peso * (alfa / 255);
          r += img.rgba[i] * pesoColor;
          g += img.rgba[i + 1] * pesoColor;
          b += img.rgba[i + 2] * pesoColor;
          a += alfa * peso;
          pesoTotal += pesoColor;
          pesoGeom += peso;
        }
      }

      const iSalida = (y * tamDestino + x) * 4;
      if (pesoTotal > 0) {
        salida[iSalida] = Math.round(r / pesoTotal);
        salida[iSalida + 1] = Math.round(g / pesoTotal);
        salida[iSalida + 2] = Math.round(b / pesoTotal);
      }
      // Alfa promedio, normalizado por el peso geometrico realmente cubierto
      // (que en los bordes del recorte es menor que el area nominal).
      salida[iSalida + 3] = pesoGeom > 0 ? Math.round(a / pesoGeom) : 0;
    }
  }

  return { ancho: tamDestino, alto: tamDestino, rgba: salida };
}

// Compone `capa` centrada sobre un fondo solido `color`, ocupando una
// fraccion `escalaContenido` del lienzo cuadrado `tam`.
function componerSobreFondo(capa, tam, color, escalaContenido) {
  const fondo = Buffer.alloc(tam * tam * 4);
  for (let i = 0; i < tam * tam; i++) {
    fondo[i * 4] = color[0];
    fondo[i * 4 + 1] = color[1];
    fondo[i * 4 + 2] = color[2];
    fondo[i * 4 + 3] = 255;
  }

  const capaEscalada = reescalar(capa, Math.round(tam * escalaContenido));
  const desplazamiento = Math.round((tam - capaEscalada.ancho) / 2);

  for (let y = 0; y < capaEscalada.alto; y++) {
    const dy = y + desplazamiento;
    if (dy < 0 || dy >= tam) continue;
    for (let x = 0; x < capaEscalada.ancho; x++) {
      const dx = x + desplazamiento;
      if (dx < 0 || dx >= tam) continue;
      const iOrigen = (y * capaEscalada.ancho + x) * 4;
      const iDestino = (dy * tam + dx) * 4;
      const alfa = capaEscalada.rgba[iOrigen + 3] / 255;
      for (let c = 0; c < 3; c++) {
        fondo[iDestino + c] = Math.round(
          capaEscalada.rgba[iOrigen + c] * alfa + fondo[iDestino + c] * (1 - alfa)
        );
      }
    }
  }

  return { ancho: tam, alto: tam, rgba: fondo };
}

/* ================================================================
   Generacion
   ================================================================ */

fs.mkdirSync(SALIDA, { recursive: true });

const original = leerPNG(fs.readFileSync(ORIGEN));
const bbox = bboxComponenteMayor(original);
const recorte = recortarCuadrado(original, bbox, 0.04); // 4% de margen

console.log(
  `Logo original ${original.ancho}x${original.alto}, contenido detectado ` +
    `${bbox.maxX - bbox.minX + 1}x${bbox.maxY - bbox.minY + 1}, recorte cuadrado ${recorte.ancho}px`
);

for (const tam of [32, 180, 192, 512]) {
  const escalado = reescalar(recorte, tam);
  const archivo = path.join(SALIDA, `icon-${tam}.png`);
  fs.writeFileSync(archivo, escribirPNG(tam, tam, escalado.rgba));
  console.log(`Generado ${path.relative(path.join(__dirname, ".."), archivo)} (${tam}x${tam}, transparente)`);
}

for (const tam of [192, 512]) {
  const maskable = componerSobreFondo(recorte, tam, NAVY, 0.72);
  const archivo = path.join(SALIDA, `icon-${tam}-maskable.png`);
  fs.writeFileSync(archivo, escribirPNG(tam, tam, maskable.rgba));
  console.log(`Generado ${path.relative(path.join(__dirname, ".."), archivo)} (${tam}x${tam}, maskable, fondo navy)`);
}
