#!/usr/bin/env python3
"""
scraper_competidores.py
=======================
Raspberry Pi — Bloque 3

1. Visita las webs de cada competidor y extrae precios/info clave.
2. Monitoriza cambios en páginas específicas (hash del contenido relevante).
3. Si detecta cambio significativo → actualiza BD en SegurPanel vía API
   y envía email de alerta.

Cron recomendado (diario a las 7:00):
  0 7 * * * /usr/bin/python3 /home/pi/scrapers/scraper_competidores.py >> /home/pi/scrapers/logs/competidores.log 2>&1

Dependencias:
  pip3 install requests beautifulsoup4 lxml

Variables de entorno (o editar CONFIGURACION más abajo):
  SEGURPANEL_URL    → URL base de SegurPanel (ej: https://segurpanel.onrender.com)
  SCRAPER_TOKEN     → Token de autenticación
  SMTP_USER         → Cuenta Gmail para enviar alertas
  SMTP_PASSWORD     → Contraseña de aplicación Gmail
"""

import os
import sys
import json
import hashlib
import logging
import requests
import re
import time
from datetime import datetime
from pathlib import Path

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: Instala beautifulsoup4:  pip3 install requests beautifulsoup4 lxml")
    sys.exit(1)

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────────────────────────────────────

CONFIGURACION = {
    "segurpanel_url": os.environ.get("SEGURPANEL_URL", "https://segurpanel.onrender.com"),
    "scraper_token":  os.environ.get("SCRAPER_TOKEN",  "uic-alianzas-2026-seguro"),
    # Umbral (€) para considerar un cambio de precio significativo
    "umbral_cambio_precio": 1.0,
    # Directorio donde guardar snapshots de páginas
    "dir_snapshots": Path(__file__).parent / "snapshots_competidores",
    # Timeout HTTP en segundos
    "timeout_http": 20,
}
# Nota: los emails de alerta los envía SegurPanel automáticamente
# cuando recibe la actualización de precios. La Pi no necesita SMTP.

# ─────────────────────────────────────────────────────────────────────────────
# DEFINICIÓN DE COMPETIDORES
# Cada entrada tiene:
#   empresa      → clave en BD (debe coincidir con competidores.empresa)
#   nombre       → nombre legible
#   url_precios  → página principal de precios/alarmas
#   selector_precio → lista de selectores CSS a probar para extraer precio
#   patron_precio   → regex para extraer número del texto encontrado
#   url_monitor  → página a monitorizar para detectar cualquier cambio
#   selector_monitor → selector CSS del bloque a vigilar (None = body)
# ─────────────────────────────────────────────────────────────────────────────

COMPETIDORES = [
    {
        "empresa": "Verisure",
        "nombre": "Verisure",
        "url_precios": "https://www.verisure.es/alarmas-para-el-hogar/precio-alarma.html",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            "strong", ".offer-price", ".monthly-price"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.verisure.es/alarmas-para-el-hogar/precio-alarma.html",
        "selector_monitor": "main",
    },
    {
        "empresa": "Sector Alarm",
        "nombre": "Sector Alarm",
        "url_precios": "https://www.sectoralarm.es/alarma-hogar/precio/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            ".monthly", "strong"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.sectoralarm.es/alarma-hogar/precio/",
        "selector_monitor": "main",
    },
    {
        "empresa": "Sicor",
        "nombre": "Sicor Sistemas",
        "url_precios": "https://www.sicor.es/alarmas-para-el-hogar/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            "strong", "b"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.sicor.es/alarmas-para-el-hogar/",
        "selector_monitor": None,
    },
    {
        "empresa": "Segurma",
        "nombre": "Segurma",
        "url_precios": "https://www.segurma.es/alarmas-hogar/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            "strong"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.segurma.es/alarmas-hogar/",
        "selector_monitor": None,
    },
    {
        "empresa": "ADT",
        "nombre": "ADT",
        "url_precios": "https://www.adt.es/alarmas-hogar/precios/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            ".plan-price", "strong"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.adt.es/alarmas-hogar/precios/",
        "selector_monitor": ".pricing",
    },
    {
        "empresa": "Seguridad 3D",
        "nombre": "Seguridad 3D",
        "url_precios": "https://www.seguridad3d.com/alarmas/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            "strong", "b"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.seguridad3d.com/alarmas/",
        "selector_monitor": None,
    },
    {
        "empresa": "Grupo Control",
        "nombre": "Grupo Control",
        "url_precios": "https://www.grupocontrol.com/alarmas-hogar/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            "strong"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.grupocontrol.com/alarmas-hogar/",
        "selector_monitor": None,
    },
    {
        "empresa": "Trablisa",
        "nombre": "Trablisa",
        "url_precios": "https://www.trablisa.com/alarmas-hogar/",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            "strong", "b"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.trablisa.com/alarmas-hogar/",
        "selector_monitor": None,
    },
    {
        "empresa": "MPA/Prosegur",
        "nombre": "Prosegur Alarmas",
        "url_precios": "https://www.prosegur.es/alarmas-hogar/precios",
        "selector_precio": [".price", ".precio", "[class*='price']", "[class*='precio']",
                            ".plan__price", "strong"],
        "patron_precio": r"(\d+[,.]?\d*)\s*[€$]|[€$]\s*(\d+[,.]?\d*)",
        "url_monitor": "https://www.prosegur.es/alarmas-hogar/precios",
        "selector_monitor": "main",
    },
]

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("scraper_competidores")

# ─────────────────────────────────────────────────────────────────────────────
# UTILIDADES HTTP
# ─────────────────────────────────────────────────────────────────────────────

HEADERS_NAVEGADOR = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "es-ES,es;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def fetch_html(url: str, timeout: int = None) -> str | None:
    """Descarga el HTML de una URL. Devuelve None si falla."""
    t = timeout or CONFIGURACION["timeout_http"]
    try:
        resp = requests.get(url, headers=HEADERS_NAVEGADOR, timeout=t, allow_redirects=True)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException as e:
        log.warning(f"HTTP error en {url}: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# EXTRACCIÓN DE PRECIOS
# ─────────────────────────────────────────────────────────────────────────────

def extraer_precios_de_html(html: str, comp: dict) -> list[float]:
    """
    Intenta extraer precios numéricos de la página.
    Devuelve lista de floats encontrados (puede estar vacía).
    """
    soup = BeautifulSoup(html, "lxml")

    # Eliminar scripts y estilos para no contaminar el texto
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    textos_candidatos = []

    # 1. Probar selectores específicos del competidor
    for selector in comp.get("selector_precio", []):
        elementos = soup.select(selector)
        for el in elementos:
            textos_candidatos.append(el.get_text(" ", strip=True))

    # 2. Búsqueda genérica de patrones €/mes en todo el body
    texto_body = soup.get_text(" ", strip=True)
    textos_candidatos.append(texto_body)

    patron = re.compile(comp.get("patron_precio", r"(\d+[,.]?\d*)\s*€"))
    precios = []
    for texto in textos_candidatos:
        matches = patron.findall(texto)
        for match in matches:
            # findall con grupos devuelve tuplas
            val = match if isinstance(match, str) else next((m for m in match if m), None)
            if val:
                val = val.replace(",", ".")
                try:
                    precio = float(val)
                    # Filtro de rango razonable (1 € – 150 €/mes)
                    if 1.0 <= precio <= 150.0:
                        precios.append(precio)
                except ValueError:
                    pass

    # Deduplicar y ordenar
    precios = sorted(set(precios))
    return precios


# ─────────────────────────────────────────────────────────────────────────────
# SNAPSHOTS (monitorización de cambios)
# ─────────────────────────────────────────────────────────────────────────────

def _ruta_snapshot(empresa: str) -> Path:
    d = CONFIGURACION["dir_snapshots"]
    d.mkdir(parents=True, exist_ok=True)
    nombre = empresa.replace("/", "_").replace(" ", "_")
    return d / f"{nombre}.json"


def cargar_snapshot(empresa: str) -> dict:
    ruta = _ruta_snapshot(empresa)
    if ruta.exists():
        try:
            return json.loads(ruta.read_text())
        except Exception:
            pass
    return {}


def guardar_snapshot(empresa: str, datos: dict):
    ruta = _ruta_snapshot(empresa)
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=2))


def hash_contenido(html: str, selector: str | None) -> str:
    """Genera un hash SHA256 del bloque relevante de la página."""
    try:
        soup = BeautifulSoup(html, "lxml")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        if selector:
            bloque = soup.select_one(selector)
            texto = bloque.get_text(" ", strip=True) if bloque else soup.get_text(" ", strip=True)
        else:
            texto = soup.get_text(" ", strip=True)
        # Normalizar espacios
        texto = re.sub(r"\s+", " ", texto).strip()
        return hashlib.sha256(texto.encode()).hexdigest()
    except Exception as e:
        log.warning(f"Error calculando hash: {e}")
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# API SEGURPANEL
# ─────────────────────────────────────────────────────────────────────────────

def actualizar_competidor_en_bd(empresa: str, datos: dict) -> bool:
    """
    Llama a PUT /api/competidores/:empresa con los datos de precios.
    datos puede incluir: precioMin, precioMax, precioMedio, permanenciaMeses, valoracion
    """
    url = f"{CONFIGURACION['segurpanel_url']}/api/competidores/{requests.utils.quote(empresa)}"
    headers = {
        "Content-Type": "application/json",
        "X-Scraper-Token": CONFIGURACION["scraper_token"],
    }
    try:
        resp = requests.put(url, json=datos, headers=headers,
                            timeout=CONFIGURACION["timeout_http"])
        if resp.status_code == 200:
            log.info(f"  ✓ BD actualizada para {empresa}: {datos}")
            return True
        else:
            log.warning(f"  ✗ BD responde {resp.status_code} para {empresa}: {resp.text[:200]}")
            return False
    except requests.RequestException as e:
        log.error(f"  ✗ Error actualizando BD para {empresa}: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# RESUMEN POR CONSOLA (el email lo envía SegurPanel al recibir la API call)
# ─────────────────────────────────────────────────────────────────────────────

def log_resumen(resultados: list[dict]):
    log.info("════════════════════════════════════════════════")
    log.info(" RESUMEN FINAL")
    log.info("════════════════════════════════════════════════")
    for r in resultados:
        icon = {"actualizado": "✓", "sin_cambio": "=", "sin_precios": "?",
                "error": "✗", "cambio_pagina": "↻"}.get(r["estado"], " ")
        precios = ""
        if r.get("precio_min"):
            precios = f" [{r['precio_min']:.2f}–{r['precio_max']:.2f} €]"
        log.info(f"  {icon} {r['nombre']:20s} → {r['estado']}{precios}")


# ─────────────────────────────────────────────────────────────────────────────
# LÓGICA PRINCIPAL POR COMPETIDOR
# ─────────────────────────────────────────────────────────────────────────────

def procesar_competidor(comp: dict) -> dict:
    nombre  = comp["nombre"]
    empresa = comp["empresa"]
    log.info(f"── {nombre} ──────────────────────────────────────")

    resultado = {
        "empresa": empresa,
        "nombre":  nombre,
        "estado":  "error",
        "precio_min": None,
        "precio_max": None,
        "precio_medio": None,
    }

    snapshot_anterior = cargar_snapshot(empresa)
    umbral = CONFIGURACION["umbral_cambio_precio"]

    # ── 1. Descargar página de precios ────────────────────────────────────────
    html = fetch_html(comp["url_precios"])
    if not html:
        log.warning(f"  No se pudo descargar {comp['url_precios']}")
        resultado["estado"] = "error"
        return resultado

    # ── 2. Monitorización de cambios en la página ─────────────────────────────
    hash_actual = hash_contenido(html, comp.get("selector_monitor"))
    hash_anterior = snapshot_anterior.get("hash_pagina", "")

    pagina_cambio = hash_actual and hash_actual != hash_anterior

    # ── 3. Extracción de precios ───────────────────────────────────────────────
    precios = extraer_precios_de_html(html, comp)
    log.info(f"  Precios encontrados: {precios}")

    if not precios:
        log.warning(f"  Sin precios detectados en {comp['url_precios']}")
        if pagina_cambio:
            log.info("  Cambio de página detectado (sin precios extraíbles)")
        # Guardar snapshot actualizado
        guardar_snapshot(empresa, {
            **snapshot_anterior,
            "hash_pagina": hash_actual,
            "ultima_revision": datetime.now().isoformat(),
        })
        resultado["estado"] = "sin_precios" if not pagina_cambio else "cambio_pagina"
        return resultado

    precio_min    = min(precios)
    precio_max    = max(precios)
    precio_medio  = round(sum(precios) / len(precios), 2)

    resultado["precio_min"]   = precio_min
    resultado["precio_max"]   = precio_max
    resultado["precio_medio"] = precio_medio

    # ── 4. Comparar con snapshot anterior ─────────────────────────────────────
    p_ant_min = snapshot_anterior.get("precio_min")
    p_ant_max = snapshot_anterior.get("precio_max")

    hay_cambio_precio = (
        p_ant_min is None or p_ant_max is None or
        abs(precio_min - p_ant_min) >= umbral or
        abs(precio_max - p_ant_max) >= umbral
    )

    # ── 5. Actualizar BD y enviar alertas si hay cambio ───────────────────────
    if hay_cambio_precio:
        log.info(f"  Cambio de precio: min {p_ant_min}→{precio_min}, max {p_ant_max}→{precio_max}")
        # Actualizar BD — SegurPanel enviará el email de alerta automáticamente
        actualizar_competidor_en_bd(empresa, {
            "precioMin":   precio_min,
            "precioMax":   precio_max,
            "precioMedio": precio_medio,
        })
        resultado["estado"] = "actualizado"

    elif pagina_cambio:
        log.info("  Cambio menor en página (precios sin variación significativa)")
        # Actualizar igualmente para refrescar la BD con los últimos precios
        actualizar_competidor_en_bd(empresa, {
            "precioMin":   precio_min,
            "precioMax":   precio_max,
            "precioMedio": precio_medio,
        })
        resultado["estado"] = "cambio_pagina"

    else:
        log.info(f"  Sin cambios (min={precio_min}, max={precio_max})")
        resultado["estado"] = "sin_cambio"

    # ── 6. Guardar snapshot actualizado ───────────────────────────────────────
    guardar_snapshot(empresa, {
        "precio_min":       precio_min,
        "precio_max":       precio_max,
        "precio_medio":     precio_medio,
        "hash_pagina":      hash_actual,
        "ultima_revision":  datetime.now().isoformat(),
        "todos_los_precios": precios,
    })

    return resultado


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    log.info("════════════════════════════════════════════════")
    log.info(" SegurPanel — Scraper de competidores")
    log.info(f" {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log.info("════════════════════════════════════════════════")

    resultados = []
    for comp in COMPETIDORES:
        try:
            r = procesar_competidor(comp)
            resultados.append(r)
        except Exception as e:
            log.error(f"Error inesperado procesando {comp['nombre']}: {e}", exc_info=True)
            resultados.append({
                "empresa": comp["empresa"],
                "nombre":  comp["nombre"],
                "estado":  "error",
                "precio_min": None, "precio_max": None, "precio_medio": None,
            })
        # Pausa entre peticiones para no saturar
        time.sleep(3)

    log_resumen(resultados)
    log.info("════════════════════════════════════════════════")
    log.info(" Scraper finalizado")
    log.info("════════════════════════════════════════════════")


if __name__ == "__main__":
    main()
