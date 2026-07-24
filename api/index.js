const express  = require('express');
const xmlrpc   = require('xmlrpc');
const cors     = require('cors');
const archiver = require('archiver');
const PDFDocument = require('pdfkit');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { sql, pool } = require('./db');
const { getComision, calcularLinea, sumarLineas } = require('./calc');
// nodemailer es opcional: si falta el paquete, el resto del portal sigue funcionando
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { console.warn('⚠ nodemailer no instalado — el formulario de contacto quedará solo en logs'); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' })); // antes 100kb por defecto — muy poco para configs con logo

// ── CONFIGURACIÓN ODOO TEMPONOVO ─────────────────────────────────
const ODOO_URL  = process.env.ODOO_URL  || 'https://temponovo.odoo.com';
const DB_GUESS  = new URL(ODOO_URL).hostname.split('.')[0];
const ODOO_DB   = process.env.ODOO_DB   || DB_GUESS;
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASS = process.env.ODOO_PASSWORD || '';

const CATEGORIAS_OK = (process.env.CATEGORIAS || '')
  .split('|').map(s => s.trim()).filter(Boolean);

// ── API REST DE VENTAS TEMPONOVO (documentación aparte, NO XML-RPC) ──
// Todas las ventas de las vendedoras se crean/editan a través de esta API
// (Authorization: API-KEY), nunca directo contra Odoo por XML-RPC.
const TEMPO_API_URL = (process.env.TEMPONOVO_API_URL || 'https://cmcorpcl-temponovo.odoo.com').replace(/\/$/, '');
const TEMPO_API_KEY = process.env.TEMPONOVO_API_KEY || '';
// Las ventas SIEMPRE se crean con este remitente (la cuenta admin), nunca con
// el email de cada vendedora — el nombre de la vendedora queda solo como
// referencia dentro de la observación de la venta (tempo_observation).
const TEMPO_VENDOR_EMAIL = process.env.TEMPONOVO_VENDOR_EMAIL || process.env.ODOO_USER || '';

// ── ODOO AUTH ────────────────────────────────────────────────────
let cachedUID = null, lastAuthTime = 0;
async function getUID() {
  if (!ODOO_USER || !ODOO_PASS) {
    throw new Error('Faltan credenciales de Odoo. Configura ODOO_USER y ODOO_PASSWORD (y ODOO_DB si aplica) en Vercel → Settings → Environment Variables, y vuelve a desplegar.');
  }
  if (cachedUID && (Date.now() - lastAuthTime) < 3600000) return cachedUID;
  const client = xmlrpc.createSecureClient({ host: new URL(ODOO_URL).hostname, port: 443, path: '/xmlrpc/2/common' });
  return new Promise((resolve, reject) => {
    client.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}], (err, uid) => {
      if (err) return reject(new Error('No se pudo conectar a Odoo (' + ODOO_DB + '): ' + err.message));
      if (!uid) return reject(new Error('Odoo rechazó las credenciales (usuario o contraseña/API key incorrectos, o base "' + ODOO_DB + '" equivocada).'));
      cachedUID = uid; lastAuthTime = Date.now();
      console.log('✅ UID Odoo Temponovo:', uid);
      resolve(uid);
    });
  });
}
function xmlrpcCall(model, method, args, kwargs) {
  return getUID().then(uid => {
    const client = xmlrpc.createSecureClient({ host: new URL(ODOO_URL).hostname, port: 443, path: '/xmlrpc/2/object' });
    return new Promise((resolve, reject) => {
      client.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs || {}],
        (err, r) => err ? reject(err) : resolve(r));
    });
  });
}

// ── ODOO AUTH GENÉRICO (multi-proveedor) ──────────────────────────
// getUID/xmlrpcCall de arriba quedan intactos y siguen hablando SOLO con el
// Odoo de Temponovo (los sigue usando readCfgOdooLegacy para el backfill de
// vendedora_config — no se puede tocar esa conexión). Estas versiones toman
// una conexión explícita {url, db, user, password} y sirven para cualquier
// proveedor, incluido Temponovo (que para el catálogo/ventas nuevas se
// resuelve igual que cualquier otro, leyendo su fila de "proveedores").
// El paquete "xmlrpc" no expone un timeout propio — sin esto, un proveedor
// caído o con el firewall bloqueado deja la llamada colgada para siempre
// (y con varios proveedores consultándose uno por uno, ESO cuelga el
// catálogo entero, no solo el de ese proveedor).
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ]);
}
const uidCache = {}; // cacheKey -> {uid, ts}
function getUidFor(conn, cacheKey) {
  if (!conn.user || !conn.password) {
    return Promise.reject(new Error('Faltan credenciales de Odoo para este proveedor'));
  }
  const cached = uidCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < 3600000) return Promise.resolve(cached.uid);
  const client = xmlrpc.createSecureClient({ host: new URL(conn.url).hostname, port: 443, path: '/xmlrpc/2/common' });
  const p = new Promise((resolve, reject) => {
    client.methodCall('authenticate', [conn.db, conn.user, conn.password, {}], (err, uid) => {
      if (err) return reject(new Error('No se pudo conectar a Odoo (' + conn.db + '): ' + err.message));
      if (!uid) return reject(new Error('Odoo rechazó las credenciales (usuario, clave o base "' + conn.db + '" equivocada).'));
      uidCache[cacheKey] = { uid, ts: Date.now() };
      resolve(uid);
    });
  });
  return withTimeout(p, 15000, 'Tiempo de espera agotado conectando a Odoo (' + conn.db + ')');
}
function xmlrpcCallFor(conn, cacheKey, model, method, args, kwargs) {
  return getUidFor(conn, cacheKey).then(uid => {
    const client = xmlrpc.createSecureClient({ host: new URL(conn.url).hostname, port: 443, path: '/xmlrpc/2/object' });
    const p = new Promise((resolve, reject) => {
      client.methodCall('execute_kw', [conn.db, uid, conn.password, model, method, args, kwargs || {}],
        (err, r) => err ? reject(err) : resolve(r));
    });
    return withTimeout(p, 15000, 'Tiempo de espera agotado llamando a Odoo (' + conn.db + ')');
  });
}
// Conexión Odoo resuelta desde una fila de "proveedores" (con la clave ya descifrada).
function connFor(proveedor) {
  return { url: proveedor.odoo_url, db: proveedor.odoo_db, user: proveedor.odoo_user, password: proveedor.odoo_password_enc ? decryptCred(proveedor.odoo_password_enc) : '' };
}
async function getProveedorActivo(id) {
  const { rows } = await sql`SELECT * FROM proveedores WHERE id = ${id} AND activo = true`;
  if (!rows.length) throw new Error('Proveedor no encontrado o inactivo');
  return rows[0];
}
async function getActiveProveedores() {
  const { rows } = await sql`SELECT * FROM proveedores WHERE activo = true ORDER BY orden, id`;
  return rows;
}
// Resuelve el proveedor de una fila de ventas_pendientes para reintentos.
// Filas de antes del split no tienen proveedor_id — se asume "temponovo"
// (el único proveedor que existía cuando se crearon).
async function getProveedorDeVenta(venta) {
  if (venta.proveedor_id) return getProveedorActivo(venta.proveedor_id);
  const { rows } = await sql`SELECT * FROM proveedores WHERE codigo = 'temponovo' AND activo = true`;
  if (!rows.length) throw new Error('No se pudo determinar el proveedor de esta venta');
  return rows[0];
}

// ── CACHÉ EN MEMORIA ─────────────────────────────────────────────
function shortErr(e) {
  const msg = (e && e.message) || String(e);
  const lines = msg.split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length > 1 ? lines[lines.length - 1] : msg;
}
const cache = {};
function cacheGet(k) { const e = cache[k]; if (!e) return null; if (Date.now() - e.ts > e.ttl) { delete cache[k]; return null; } return e.data; }
function cacheSet(k, d, ttl) { cache[k] = { data: d, ts: Date.now(), ttl }; }
// Cuánto tiempo se cachea el catálogo (y su stock) en memoria antes de
// volver a leerlo de Odoo. CATALOGO_TTL_MS es la capa de abajo (catálogo
// crudo de cada proveedor); VENDEDORA_TTL_MS es la capa de arriba (ya con
// precio/multiplicador calculado, por vendedora o vitrina pública) — el
// peor caso de desactualización es la suma de las dos. Admin → Proveedores
// tiene un botón "Actualizar catálogo ahora" para forzarlo antes de que
// venza el caché (DELETE /api/productos/cache).
const CATALOGO_TTL_MS = 10 * 60 * 1000;
const VENDEDORA_TTL_MS = 5 * 60 * 1000;

// ── SEGUIMIENTO LOGÍSTICO DE VENTAS ──────────────────────────────
// Único estado por el que pasa cada venta, en orden. Lo cambia solo el
// admin (Panel de Admin → Ventas). La vitrina de la vendedora solo lee
// este valor por el id interno de la venta — nunca toca Odoo para esto.
const SEGUIMIENTO_ORDEN = ['recibido', 'preparando', 'en_transito', 'entregado'];
const SEGUIMIENTO_LABEL = { recibido: 'Recibido', preparando: 'Preparando', en_transito: 'En tránsito', entregado: 'Entregado' };

// ── NÚMERO DE VENTA (interno, nunca es el de Odoo) ───────────────
// Cada vendedora tiene su propio correlativo, partiendo en 1, con la
// inicial de su código adelante — ej. la vendedora "CAROLINA" ve sus
// ventas como C00001, C00002, C00003... Desde el split por proveedor, UN
// pedido de cliente puede generar varias filas en ventas_pendientes (una
// por proveedor, mismo grupo_id) — así que el correlativo ya no se puede
// calcular contando filas al vuelo (se desalinearía). Se calcula y se graba
// UNA vez por grupo_id en orden_secuencia al insertar (ver /api/pedido), y
// acá solo se formatea.
function numeroVenta(codigo, secuencia) {
  const inicial = String(codigo || 'V').trim().charAt(0).toUpperCase() || 'V';
  return inicial + String(secuencia || 1).padStart(5, '0');
}

// ── ACADEMIA: normalizar links de video a formato embebible ──────
// Acepta lo que sea que pegue el admin (link normal de YouTube, youtu.be,
// Shorts, o Vimeo) y devuelve la URL para el <iframe>. Si no reconoce el
// formato, devuelve la URL tal cual (por si ya es un embed válido).
function embedVideoUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  try {
    // YouTube: youtu.be/ID, watch?v=ID, /shorts/ID, /embed/ID
    let m = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (m) return 'https://www.youtube.com/embed/' + m[1];
    // Vimeo: vimeo.com/ID  o player.vimeo.com/video/ID
    m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (m) return 'https://player.vimeo.com/video/' + m[1];
  } catch {}
  return u;
}

// ════════════════════════════════════════════════════════════════
// BASE DE DATOS — configuración (una sola empresa), vendedoras, ventas pendientes
// ════════════════════════════════════════════════════════════════
let dbReady = null;
function ensureDb() {
  if (dbReady) return dbReady;
  dbReady = (async () => {
    // Una sola fila (id=1): el nombre y el partnerId de Odoo de LA empresa.
    // Ya no hay "empresas" plural — todo el portal es de una sola empresa.
    await sql`CREATE TABLE IF NOT EXISTS configuracion (
      id INTEGER PRIMARY KEY DEFAULT 1,
      nombre TEXT NOT NULL DEFAULT '',
      partner_id INTEGER,
      updated_at TIMESTAMPTZ DEFAULT now(),
      CHECK (id = 1)
    )`;
    await sql`INSERT INTO configuracion (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

    await sql`CREATE TABLE IF NOT EXISTS vendedoras (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      clave_hash TEXT NOT NULL,
      nombre TEXT NOT NULL,
      multiplicador NUMERIC DEFAULT 2,
      categorias JSONB DEFAULT '[]',
      sucursales JSONB DEFAULT '[]',
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS ventas_pendientes (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER NOT NULL REFERENCES vendedoras(id) ON DELETE CASCADE,
      productos JSONB NOT NULL,
      nombre_venta TEXT,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      comuna TEXT,
      nota TEXT,
      total NUMERIC DEFAULT 0,
      estado TEXT DEFAULT 'pendiente',
      odoo_order_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),
      consolidado_at TIMESTAMPTZ
    )`;

    // ── Migración desde versiones anteriores (varias empresas) ──
    // Si el proyecto ya tenía las tablas viejas con empresa_id, las acomoda solo:
    await sql`ALTER TABLE vendedoras DROP COLUMN IF EXISTS empresa_id`;
    await sql`ALTER TABLE ventas_pendientes DROP COLUMN IF EXISTS empresa_id`;
    // "entrega": 'despacho' | 'retiro' — con qué método se acordó la entrega de la venta.
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS entrega TEXT DEFAULT 'despacho'`;
    // Email de la vendedora (queda solo como dato de referencia — las ventas
    // se crean siempre con el remitente admin, ver TEMPO_VENDOR_EMAIL).
    await sql`ALTER TABLE vendedoras ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`;
    // "Venta abierta": es UNA sola, compartida por TODAS las vendedoras (todas
    // facturan al mismo partner). El primer pedido de cualquiera la abre con
    // /sale/create; los pedidos siguientes de cualquier vendedora se agregan
    // a esa misma venta con /sale/update, hasta que la API la rechace (ya
    // pickeada) y se abra una nueva automáticamente.
    await sql`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS venta_abierta_id INTEGER`;
    await sql`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS venta_abierta_nombre TEXT`;
    // Columnas viejas de cuando la venta abierta era por vendedora (ya no se usan, se quitan)
    await sql`ALTER TABLE vendedoras DROP COLUMN IF EXISTS venta_abierta_id`;
    await sql`ALTER TABLE vendedoras DROP COLUMN IF EXISTS venta_abierta_nombre`;
    // Nombre de la venta en Odoo (ej. "S06819") y detalle del error si la API falló.
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS odoo_venta_nombre TEXT`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS error_msg TEXT`;
    // Borrar una vendedora ya NO borra en cascada su historial de ventas
    // (son registros con valor contable). Si tiene ventas, el borrado se
    // rechaza y el admin debe desactivarla en su lugar (columna "activo").
    await sql`ALTER TABLE ventas_pendientes DROP CONSTRAINT IF EXISTS ventas_pendientes_vendedora_id_fkey`;
    await sql`ALTER TABLE ventas_pendientes ADD CONSTRAINT ventas_pendientes_vendedora_id_fkey
      FOREIGN KEY (vendedora_id) REFERENCES vendedoras(id) ON DELETE RESTRICT`;
    // ── SEGUIMIENTO LOGÍSTICO ──────────────────────────────────────
    // Independiente de si la venta llegó o no a Odoo ("estado"): esto es el
    // avance físico del pedido, que solo el admin cambia a mano — la vitrina
    // (y la vendedora) nunca sabe nada de Odoo, solo lee este estado por el
    // id interno de ventas_pendientes.
    // 'recibido' → 'preparando' → 'en_transito' → 'entregado'
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS seguimiento TEXT NOT NULL DEFAULT 'recibido'`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS seguimiento_at TIMESTAMPTZ DEFAULT now()`;

    // ── MULTI-PROVEEDOR (fase 0) ─────────────────────────────────────
    // Columnas para cuando una venta se separe por proveedor: todavía no se
    // usan en ningún flujo (eso llega en una fase siguiente) — nullable, no
    // cambian nada del comportamiento actual.
    // grupo_id: comparte el mismo valor entre las N filas que salen de UN
    //   pedido de cliente cuando se divide entre proveedores.
    // proveedor_id: a qué proveedor pertenece esta fila (hoy siempre NULL /
    //   luego siempre "temponovo" hasta que haya split real).
    // orden_secuencia: número de pedido del cliente, calculado una vez por
    //   grupo_id (reemplaza el conteo al vuelo que hace numeroVenta()).
    // estado_manual: solo se usa cuando el proveedor es tipo 'manual' (sin
    //   Odoo) — el admin lo gestiona a mano dentro del portal.
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS grupo_id UUID`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS proveedor_id INTEGER`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS orden_secuencia INTEGER`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS estado_manual TEXT`;
    // Backfill único: las filas de antes del split (sin orden_secuencia)
    // se numeran respetando el orden histórico por vendedora — mismo
    // criterio que el ROW_NUMBER() que se usaba antes de guardar esto en
    // una columna. Sin esto, el próximo pedido de una vendedora con
    // historial volvería a arrancar en el N°1 y chocaría con sus números
    // viejos (ver /api/pedido, que calcula el siguiente número como
    // MAX(orden_secuencia)+1). Es idempotente — no toca filas que ya
    // tengan orden_secuencia (todas las creadas después del split).
    await sql`
      UPDATE ventas_pendientes vp SET orden_secuencia = sub.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY vendedora_id ORDER BY id) AS rn
        FROM ventas_pendientes WHERE orden_secuencia IS NULL
      ) sub
      WHERE vp.id = sub.id AND vp.orden_secuencia IS NULL`;

    // ── COMISIÓN POR VENDEDORA ───────────────────────────────────────
    // Comisión = lo que se lleva la vendedora sobre la GANANCIA de cada
    // venta (precio de venta − costo del proveedor) × este % — configurable
    // por vendedora en Admin → Vendedoras. Se calcula y se guarda por línea
    // al momento de la venta (ver /api/pedido), no se recalcula después —
    // así lo ya ganado no cambia si el proveedor sube el costo o el admin
    // ajusta el % más adelante.
    await sql`ALTER TABLE vendedoras ADD COLUMN IF NOT EXISTS comision NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE vendedoras ADD COLUMN IF NOT EXISTS rut TEXT DEFAULT ''`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS comision NUMERIC DEFAULT 0`;

    // ── LISTA DE PRECIOS GLOBAL ───────────────────────────────────────
    // El precio de venta dejó de depender de la vendedora (el multiplicador
    // por vendedora y los precios fijos "por vendedora" quedan retirados) —
    // ahora es UNO SOLO para cualquier cliente de cualquier vendedora:
    // 1) si el SKU tiene precio fijo acá, ese manda;
    // 2) si no, se usa el multiplicador de SU categoría (familia, ver
    //    famOf());
    // 3) si la categoría tampoco tiene multiplicador, se usa el default
    //    (MULT_DEFAULT, ×2).
    // "disponible=false" saca el producto de TODAS las vitrinas (de cada
    // vendedora y de la pública) — es una curación de catálogo a nivel
    // empresa, no el "ocultar" que cada vendedora ya tenía para su propia
    // vitrina (ese sigue existiendo, aparte).
    await sql`CREATE TABLE IF NOT EXISTS catalogo_productos (
      sku TEXT PRIMARY KEY,
      precio NUMERIC,
      disponible BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
    // Nuevas columnas para costo y margen (Fase 2: sistema de precios escalable)
    await sql`ALTER TABLE catalogo_productos ADD COLUMN IF NOT EXISTS costo NUMERIC DEFAULT NULL`;
    await sql`ALTER TABLE catalogo_productos ADD COLUMN IF NOT EXISTS precio_pvp NUMERIC DEFAULT NULL`;
    await sql`ALTER TABLE catalogo_productos ADD COLUMN IF NOT EXISTS iva_porcentaje NUMERIC DEFAULT 19`;
    await sql`ALTER TABLE catalogo_productos ADD COLUMN IF NOT EXISTS comision_vendedora_override NUMERIC DEFAULT NULL`;

    await sql`CREATE TABLE IF NOT EXISTS categoria_multiplicador (
      familia TEXT PRIMARY KEY,
      multiplicador NUMERIC NOT NULL DEFAULT 2,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
    // Ícono y nombre a mostrar por categoría (opcional) — si no se setea,
    // la vitrina sigue adivinando el ícono por el nombre de la categoría y
    // muestra el nombre tal cual viene de Odoo (ver ICON_LIB/famIcon en el
    // frontend).
    await sql`ALTER TABLE categoria_multiplicador ADD COLUMN IF NOT EXISTS icono TEXT DEFAULT ''`;
    await sql`ALTER TABLE categoria_multiplicador ADD COLUMN IF NOT EXISTS nombre TEXT DEFAULT ''`;
    // Override de comisión por categoría (Fase 2)
    await sql`ALTER TABLE categoria_multiplicador ADD COLUMN IF NOT EXISTS comision_override NUMERIC DEFAULT NULL`;

    // ── ACADEMIA ───────────────────────────────────────────────────
    // Contenido de formación para las vendedoras. Lo crea solo el admin.
    // Un curso agrupa lecciones; cada lección puede ser un video (link de
    // YouTube/Vimeo), texto, o imagen + texto. "categoria" separa los dos
    // grandes tipos: 'vender' (cómo vender) y 'producto' (conocer lo que vende).
    await sql`CREATE TABLE IF NOT EXISTS academia_cursos (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT DEFAULT '',
      categoria TEXT NOT NULL DEFAULT 'vender',  -- 'vender' | 'producto'
      portada TEXT DEFAULT '',                    -- URL o dataURL de imagen de portada (opcional)
      orden INTEGER DEFAULT 0,
      publicado BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS academia_lecciones (
      id SERIAL PRIMARY KEY,
      curso_id INTEGER NOT NULL REFERENCES academia_cursos(id) ON DELETE CASCADE,
      titulo TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'video',         -- 'video' | 'texto' | 'imagen'
      video_url TEXT DEFAULT '',                  -- link de YouTube/Vimeo si tipo='video'
      cuerpo TEXT DEFAULT '',                      -- texto de la lección (markdown-lite / plano)
      imagen TEXT DEFAULT '',                      -- URL o dataURL si tipo='imagen'
      sku_ref TEXT DEFAULT '',                     -- SKU de producto de Odoo asociado (opcional)
      orden INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;

    // ── INFO LIBRE DE PRODUCTO (desde Excel del admin) ─────────────
    // Odoo aporta lo operativo (código, precio, stock, foto). Este Excel
    // aporta la info comercial que Odoo no tiene, con columnas 100% libres:
    // una fila por SKU, y "campos" es un JSON { "Título de columna": "valor" }
    // tal como venían en el Excel. La ficha del producto muestra esos campos.
    await sql`CREATE TABLE IF NOT EXISTS producto_info (
      sku TEXT PRIMARY KEY,
      campos JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
    // ── PROVEEDORES (fase 0 del portal multi-proveedor) ─────────────
    // Hoy el portal habla con UN solo Odoo (Temponovo, vía las variables de
    // entorno ODOO_*/TEMPONOVO_*) y UN solo partner_id ("configuracion").
    // Esta tabla es el destino final de esa configuración — cada proveedor
    // (Temponovo, Aviv, futuros) tendrá su propia conexión y su propia
    // "venta abierta", editables desde Admin → Proveedores, sin redeploy.
    // En esta fase la tabla solo se crea y se siembra con Temponovo — el
    // resto del código todavía sigue usando las variables de entorno
    // directamente (eso cambia en una fase siguiente).
    await sql`CREATE TABLE IF NOT EXISTS proveedores (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'odoo',
      activo BOOLEAN DEFAULT true,
      partner_id INTEGER,
      odoo_url TEXT, odoo_db TEXT, odoo_user TEXT, odoo_password_enc TEXT,
      venta_api_url TEXT, venta_api_key_enc TEXT, venta_vendor_email TEXT,
      venta_abierta_id INTEGER, venta_abierta_nombre TEXT,
      categorias_filtro JSONB DEFAULT '[]',
      orden INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`ALTER TABLE ventas_pendientes DROP CONSTRAINT IF EXISTS ventas_pendientes_proveedor_id_fkey`;
    await sql`ALTER TABLE ventas_pendientes ADD CONSTRAINT ventas_pendientes_proveedor_id_fkey
      FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)`;

    // ── CONFIG DE VENDEDORA (fase 1 del portal multi-proveedor) ──────
    // Antes vivía como un adjunto en el Odoo de Temponovo (vitrina-cfg-<código>),
    // colgado del único partner_id global — ya no tiene sentido en cuanto hay
    // más de un proveedor (o uno sin Odoo). Se guarda acá de ahora en más;
    // ver readCfgDb/writeCfgDb para el backfill desde el adjunto viejo.
    await sql`CREATE TABLE IF NOT EXISTS vendedora_config (
      vendedora_id INTEGER PRIMARY KEY REFERENCES vendedoras(id) ON DELETE CASCADE,
      cfg JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;

    // Migración única: si nunca se creó ningún proveedor y existen las
    // variables de entorno de Temponovo, se crea como el primer proveedor
    // — llevándose el partner_id y la venta abierta que hoy viven en
    // "configuracion". Si CREDENTIALS_KEY todavía no está seteada, esto se
    // reintenta solo en el próximo request (falla cerrado, no a medias).
    const { rows: provRows } = await sql`SELECT id FROM proveedores LIMIT 1`;
    if (!provRows.length && (ODOO_USER || TEMPO_API_KEY)) {
      const { rows: cfgRows } = await sql`SELECT * FROM configuracion WHERE id = 1`;
      const cfg = cfgRows[0] || {};
      try {
        await sql`INSERT INTO proveedores
          (codigo, nombre, tipo, partner_id, odoo_url, odoo_db, odoo_user, odoo_password_enc,
           venta_api_url, venta_api_key_enc, venta_vendor_email, venta_abierta_id, venta_abierta_nombre, categorias_filtro)
          VALUES ('temponovo', ${cfg.nombre || 'Temponovo'}, 'odoo', ${cfg.partner_id || null},
            ${ODOO_URL}, ${ODOO_DB}, ${ODOO_USER || null}, ${ODOO_PASS ? encryptCred(ODOO_PASS) : null},
            ${TEMPO_API_URL}, ${TEMPO_API_KEY ? encryptCred(TEMPO_API_KEY) : null}, ${TEMPO_VENDOR_EMAIL || null},
            ${cfg.venta_abierta_id || null}, ${cfg.venta_abierta_nombre || null}, ${JSON.stringify(CATEGORIAS_OK)})`;
        console.log('✅ Proveedor "temponovo" creado automáticamente desde las variables de entorno');
      } catch (e) { console.error('❌ No se pudo migrar Temponovo a la tabla proveedores (¿falta CREDENTIALS_KEY?):', e.message); }
    }

    // Si había una sola empresa creada, rescata su nombre/partnerId a la config global.
    const oldEmpresas = await sql`SELECT to_regclass('public.empresas') AS t`;
    if (oldEmpresas.rows[0]?.t) {
      const { rows: viejas } = await sql`SELECT nombre, partner_id FROM empresas ORDER BY id LIMIT 1`;
      if (viejas.length) {
        await sql`UPDATE configuracion SET nombre = ${viejas[0].nombre}, partner_id = ${viejas[0].partner_id} WHERE id = 1 AND (nombre = '' OR nombre IS NULL)`;
      }
      await sql`DROP TABLE IF EXISTS empresas CASCADE`;
    }
  })();
  return dbReady;
}
// se asegura que las tablas existan antes de CUALQUIER request (barato y sin efecto una vez creadas)
// — excepto /health, que debe poder responder aunque la base de datos esté mal configurada
app.use(async (req, res, next) => {
  if (req.path === '/health') return next();
  try { await ensureDb(); next(); }
  catch (e) {
    console.error('❌ DB init', e.message);
    res.status(500).json({ error: 'No se pudo conectar a la base de datos. ¿Está creada y conectada en Vercel → Storage → Postgres?' });
  }
});

// ── CONTRASEÑAS (hash con salt, sin dependencias externas) ───────
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const check = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}

// ── SESIÓN DE ADMIN (token firmado con expiración, sin tabla de sesiones) ──
// ADMIN_SECRET NO tiene valor por defecto a propósito: si falta, todo lo que
// dependa de él (login de admin, tokens de imagen de vendedoras) falla
// cerrado en vez de usar un secreto conocido/público (estaba en el código
// fuente, que vive en un repo de GitHub).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || '';
function makeAdminToken() {
  const exp = Date.now() + 12 * 3600 * 1000; // 12 horas
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyAdminToken(token) {
  if (!ADMIN_SECRET || !token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  try { if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false; }
  catch { return false; }
  return Date.now() < parseInt(payload, 10);
}
function requireAdmin(req, res, next) {
  if (!verifyAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Sesión de administrador inválida o expirada' });
  next();
}

// ── LÍMITE DE INTENTOS FALLIDOS (fuerza bruta) ───────────────────
// En memoria, por proceso — suficiente para frenar intentos automatizados
// sin necesitar infraestructura extra. Solo cuenta intentos FALLIDOS, para
// no bloquear a alguien que ya inició sesión y sigue mandando su clave
// correcta en cada request (así funciona hoy la autenticación de vendedoras).
const failedAttempts = {};
function isBlocked(key, max, windowMs) {
  const now = Date.now();
  const hits = (failedAttempts[key] || []).filter(t => now - t < windowMs);
  failedAttempts[key] = hits;
  return hits.length >= max;
}
function registerFailure(key, windowMs) {
  const now = Date.now();
  const hits = (failedAttempts[key] || []).filter(t => now - t < windowMs);
  hits.push(now);
  failedAttempts[key] = hits;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ── TOKEN DE IMAGEN (para <img src>, que no puede mandar headers) ────
// Nunca se manda la clave real de la vendedora en una URL (queda en logs,
// historial del navegador y Referer). En su lugar, tras autenticarse una
// vez, el cliente recibe este token derivado de su clave_hash — sirve
// SOLO para pedir imágenes, no para nada más, y deja de servir sola si la
// vendedora cambia de clave (cambia el clave_hash del que se deriva).
function imgToken(v) {
  return crypto.createHmac('sha256', ADMIN_SECRET + ':img').update(v.codigo + ':' + v.clave_hash).digest('hex').slice(0, 32);
}
function verifyImgToken(v, token) {
  if (!ADMIN_SECRET || !token) return false;
  const expected = imgToken(v);
  try { return crypto.timingSafeEqual(Buffer.from(String(token), 'hex'), Buffer.from(expected, 'hex')); }
  catch { return false; }
}

// ── CREDENCIALES DE PROVEEDORES (cifradas en la base) ─────────────
// Cada proveedor (Temponovo, Aviv, futuros) guarda su clave de Odoo y su
// API key de ventas cifradas en Postgres — nunca en texto plano — para
// poder agregarse desde el Panel de Admin sin tocar variables de entorno.
// CREDENTIALS_KEY, igual que ADMIN_SECRET, NO tiene valor por defecto: sin
// ella, cifrar/descifrar falla en vez de usar algo conocido/inseguro.
// Se genera una vez con, por ejemplo: openssl rand -base64 32
const CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || '';
function credentialsKeyBuffer() {
  if (!CREDENTIALS_KEY) throw new Error('Falta CREDENTIALS_KEY en las variables de entorno del servidor');
  const key = Buffer.from(CREDENTIALS_KEY, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_KEY debe decodificar a 32 bytes en base64 (ej. generada con `openssl rand -base64 32`)');
  return key;
}
function encryptCred(plain) {
  if (plain == null || plain === '') return null;
  const key = credentialsKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}
function decryptCred(stored) {
  if (!stored) return '';
  const key = credentialsKeyBuffer();
  const [ivHex, tagHex, dataHex] = String(stored).split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── CONFIGURACIÓN GLOBAL (la única empresa) / VENDEDORAS ─────────
async function getConfig() {
  const { rows } = await sql`SELECT * FROM configuracion WHERE id = 1`;
  return rows[0] || { nombre: '', partner_id: null };
}
async function getVendedora(codigo) {
  const { rows } = await sql`SELECT * FROM vendedoras WHERE codigo = ${(codigo || '').toUpperCase()}`;
  return rows[0] || null;
}
function slugOf(codigo) {
  return crypto.createHash('sha256').update('tnv:' + (codigo || '').toUpperCase()).digest('hex').slice(0, 10);
}
async function vendedoraBySlug(slug) {
  const { rows } = await sql`SELECT * FROM vendedoras WHERE activo = true`;
  return rows.find(v => slugOf(v.codigo) === slug) || null;
}
async function publicClienteBySlug(slug) {
  const v = await vendedoraBySlug(slug);
  if (!v) return null;
  // partnerId (si existe) solo ayuda al backfill único de la config visual
  // vieja — el catálogo/precios de la vitrina pública ya no dependen del
  // Partner ID global de "configuracion" (cada proveedor tiene el suyo).
  const cfg = await getConfig();
  return { id: v.id, code: v.codigo, partnerId: cfg.partner_id || null, name: v.nombre, multiplicador: parseFloat(v.multiplicador) || 2, categorias: v.categorias || [] };
}

// ── ACCESO DE VENDEDORA (código + clave) ──────────────────────────
// Único punto que valida código+clave — lo usan tanto el middleware de las
// rutas normales como los endpoints que necesitan leer las credenciales de
// la query string (imágenes, zip de fotos). Cuenta intentos fallidos por
// código para frenar fuerza bruta, sin afectar a quien ya tiene la clave
// correcta y la sigue mandando en cada request (así funciona hoy esta app).
async function authenticateVendedora(req) {
  const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
  const clave  = req.headers['x-client-pass'] || req.query.p || '';
  if (!codigo || !clave) return { error: 'Faltan credenciales' };
  const key = 'v:' + codigo;
  if (isBlocked(key, 10, 10 * 60 * 1000)) return { error: 'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.' };
  const v = await getVendedora(codigo);
  if (!v || !v.activo || !verifyPassword(clave, v.clave_hash)) {
    registerFailure(key, 10 * 60 * 1000);
    return { error: 'Cliente no reconocido' };
  }
  return { v };
}
async function requireClient(req, res, next) {
  try {
    const { v, error } = await authenticateVendedora(req);
    if (error) return res.status(401).json({ error });
    // El Partner ID global de "configuracion" ya no es requisito para nada
    // del catálogo/carrito (cada proveedor tiene el suyo) — solo se sigue
    // usando, si existe, como ayuda para el backfill único de la config
    // visual vieja (ver readCfgDb). Por eso ya no bloquea acá si falta.
    const cfg = await getConfig();
    req.vendedora = v; req.config = cfg;
    req.partnerId = cfg.partner_id; req.clientName = v.nombre;
    next();
  } catch (e) { console.error('❌ requireClient', e.message); res.status(500).json({ error: shortErr(e) }); }
}

// ── LINK PÚBLICO + CONFIG DE VENDEDORA ────────────────────────────
// Hasta esta fase, la config visual (logo, colores...) y los precios fijos
// de cada vendedora vivían como un adjunto en el Odoo de Temponovo. Ahora
// se guardan en Postgres (tabla vendedora_config) — readCfgOdooLegacy queda
// SOLO para el backfill de lectura única de abajo, nunca se vuelve a
// escribir en Odoo por esto.
async function readCfgOdooLegacy(code, partnerId) {
  const name = 'vitrina-cfg-' + code;
  const ids = await xmlrpcCall('ir.attachment', 'search',
    [[['name', '=', name], ['res_model', '=', 'res.partner'], ['res_id', '=', partnerId]]], { limit: 1 });
  if (!ids.length) return {};
  const rec = await xmlrpcCall('ir.attachment', 'read', [ids, ['datas']]);
  try { return JSON.parse(Buffer.from(rec[0].datas, 'base64').toString('utf8')) || {}; } catch { return {}; }
}
// vendedora: objeto con al menos {id, codigo}. partnerId: solo se usa para
// el backfill de la primera lectura (si no hay partner_id, el backfill
// simplemente no encuentra nada y arranca de un config vacío).
async function readCfgDb(vendedora, partnerId) {
  const hit = cacheGet('cfg_' + vendedora.codigo); if (hit !== null) return hit;
  const { rows } = await sql`SELECT cfg FROM vendedora_config WHERE vendedora_id = ${vendedora.id}`;
  if (rows.length) {
    cacheSet('cfg_' + vendedora.codigo, rows[0].cfg || {}, 5 * 60 * 1000);
    return rows[0].cfg || {};
  }
  // Primera vez que se pide la config de esta vendedora desde que existe
  // vendedora_config: se trae una única vez del adjunto viejo de Odoo (si
  // hay partner_id) y se guarda ya en Postgres, para no volver a tocar Odoo.
  let legacy = {};
  if (partnerId) {
    try { legacy = await readCfgOdooLegacy(vendedora.codigo, partnerId); }
    catch (e) { console.warn('⚠ backfill config de ' + vendedora.codigo + ':', e.message); }
  }
  try {
    await sql`INSERT INTO vendedora_config (vendedora_id, cfg) VALUES (${vendedora.id}, ${JSON.stringify(legacy)})
      ON CONFLICT (vendedora_id) DO NOTHING`;
  } catch (e) { console.warn('⚠ no se pudo guardar el backfill de ' + vendedora.codigo + ':', e.message); }
  cacheSet('cfg_' + vendedora.codigo, legacy, 5 * 60 * 1000);
  return legacy;
}
async function writeCfgDb(vendedora, cfg) {
  await sql`INSERT INTO vendedora_config (vendedora_id, cfg, updated_at) VALUES (${vendedora.id}, ${JSON.stringify(cfg)}, now())
    ON CONFLICT (vendedora_id) DO UPDATE SET cfg = ${JSON.stringify(cfg)}, updated_at = now()`;
  cacheSet('cfg_' + vendedora.codigo, cfg, 5 * 60 * 1000);
}
// Recibe el PRODUCTO (no solo la categoría en texto): en proveedores de
// joyería como Aviv, la categoría de Odoo viene "Metal / Tipo" (ej.
// "Oro / Anillo") — ahí la familia que importa es el tipo de pieza (último
// segmento), no el metal (metal/piedra ya se filtran aparte, ver
// fetchProductosProveedor). Para todo lo demás se sigue usando el primer
// segmento, como siempre.
function famOf(p) {
  const categoria = (p && typeof p === 'object') ? (p.categoria || '') : (p || '');
  const parts = categoria.split('/').map(x => x.trim()).filter(x => x && x.toLowerCase() !== 'all');
  if (!parts.length) return 'Otros';
  const esJoya = p && typeof p === 'object' && (p.metal || p.piedra);
  return esJoya ? parts[parts.length - 1] : parts[0];
}
// familia + subfamilia — mismo criterio que famOf, espejo del famSub() del
// frontend (agrupa igual que los pills de la vitrina, para los catálogos PDF).
function famSub(p) {
  const parts = (p.categoria || '').split('/').map(x => x.trim()).filter(x => x && x.toLowerCase() !== 'all');
  if (!parts.length) return { fam: 'Otros', sub: '' };
  if (p.metal || p.piedra) return { fam: parts[parts.length - 1] || 'Otros', sub: parts.slice(0, -1).join(' / ') };
  return { fam: parts[0] || 'Otros', sub: parts.slice(1).join(' / ') };
}
// Carga la info libre de producto (del Excel del admin) como mapa
// { SKU_MAYUS: { "Título": "valor", ... } }. Cacheado en memoria.
async function getProductoInfoMap() {
  const hit = cacheGet('prod_info'); if (hit) return hit;
  let map = {};
  try {
    const { rows } = await sql`SELECT sku, campos FROM producto_info`;
    rows.forEach(r => { map[(r.sku || '').toUpperCase()] = r.campos || {}; });
  } catch (e) { console.warn('⚠ producto_info:', e.message); }
  cacheSet('prod_info', map, 5 * 60 * 1000);
  return map;
}
// Devuelve los campos libres como lista ordenada [{k, v}], omitiendo vacíos.
function infoToList(campos) {
  if (!campos || typeof campos !== 'object') return [];
  return Object.entries(campos)
    .filter(([k, v]) => String(k).trim() && String(v).trim())
    .map(([k, v]) => ({ k: String(k).trim(), v: String(v).trim() }));
}

// ── CATÁLOGO POR PROVEEDOR + MERGE (multi-proveedor) ──────────────
// Reemplaza a las viejas fetchProductos()/getPricelistId()/productosCliente()
// (single-Odoo) — ahora TODO proveedor activo (Temponovo incluido) se
// resuelve de la misma forma, leyendo su propia fila de "proveedores".
async function getPricelistIdProveedor(proveedor) {
  if (!proveedor.partner_id) return null;
  const cacheKey = 'pl_' + proveedor.id + '_' + proveedor.partner_id;
  const cached = cacheGet(cacheKey); if (cached !== null) return cached;
  const conn = connFor(proveedor);
  const r = await xmlrpcCallFor(conn, 'prov_' + proveedor.id, 'res.partner', 'read', [[proveedor.partner_id], ['property_product_pricelist']]);
  const pl = r[0]?.property_product_pricelist;
  const plId = Array.isArray(pl) ? pl[0] : null;
  cacheSet(cacheKey, plId, 3600000);
  return plId;
}

// Catálogo base de UN proveedor (sin precio de lista todavía). Cada producto
// lleva proveedorId/proveedorCodigo — necesario porque el id numérico de
// Odoo y hasta el sku pueden repetirse entre dos proveedores distintos.
async function fetchProductosProveedor(proveedor) {
  const cacheKey = 'productos_' + proveedor.id;
  const cached = cacheGet(cacheKey); if (cached) return cached;
  if (proveedor.tipo !== 'odoo') { cacheSet(cacheKey, [], CATALOGO_TTL_MS); return []; } // 'manual': fase 5, catálogo propio pendiente
  const conn = connFor(proveedor);
  const key = 'prov_' + proveedor.id;

  const domain = [['sale_ok', '=', true], ['active', '=', true]];
  const categoriasFiltro = proveedor.categorias_filtro || [];
  if (categoriasFiltro.length) {
    const categIds = await xmlrpcCallFor(conn, key, 'product.category', 'search', [[['complete_name', 'in', categoriasFiltro]]]);
    if (categIds.length) domain.push(['categ_id', 'in', categIds]);
  }

  const prodIds = await xmlrpcCallFor(conn, key, 'product.product', 'search', [domain]);
  if (!prodIds.length) { cacheSet(cacheKey, [], CATALOGO_TTL_MS); return []; }

  const result = [];
  for (let i = 0; i < prodIds.length; i += 200) {
    const chunk = prodIds.slice(i, i + 200);
    const prods = await xmlrpcCallFor(conn, key, 'product.product', 'read', [chunk, [
      'id', 'default_code', 'name', 'list_price', 'categ_id',
      'barcode', 'qty_available',
      'product_template_attribute_value_ids', 'product_tmpl_id'
    ]]);

    const tmplIds = [...new Set(prods.map(p => Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id))];
    let tmplMap = {};
    if (tmplIds.length) {
      const tmpls = await xmlrpcCallFor(conn, key, 'product.template', 'read', [tmplIds, ['id', 'description_sale']]);
      tmpls.forEach(t => { tmplMap[t.id] = t; });
    }
    // Campos "de joyería" (metal_type/rock_type) — solo existen en el Odoo de
    // proveedores como Aviv, no en el de Temponovo. Se piden aparte y con su
    // propio try/catch: si el campo no existe en ese Odoo, Odoo tira un
    // Fault y no queremos que eso tumbe el catálogo entero de ese proveedor.
    let joyeriaMap = {};
    if (tmplIds.length) {
      try {
        const extra = await xmlrpcCallFor(conn, key, 'product.template', 'read', [tmplIds, ['id', 'metal_type', 'rock_type']]);
        extra.forEach(t => { joyeriaMap[t.id] = t; });
      } catch (e) { /* este proveedor no tiene esos campos — normal, se ignora */ }
    }
    const attrValIds = [...new Set(prods.flatMap(p => p.product_template_attribute_value_ids || []))];
    let attrMap = {};
    if (attrValIds.length) {
      const attrVals = await xmlrpcCallFor(conn, key, 'product.template.attribute.value', 'read',
        [attrValIds, ['id', 'name', 'attribute_id']]);
      attrVals.forEach(v => {
        const attrName = Array.isArray(v.attribute_id) ? v.attribute_id[1] : '';
        attrMap[v.id] = { attr: attrName, val: v.name || '' };
      });
    }
    // "Medida" (talla/tamaño) se identifica dentro de los atributos genéricos
    // por el nombre del atributo — no hace falta un campo aparte en Odoo.
    const MEDIDA_RE = /medid|talla|tama[ñn]o|size/i;
    // Respaldo: en un ANILLO, un atributo cuyo valor es un número pelado
    // (13, 15, 17...) es casi siempre la talla, aunque el atributo en Odoo
    // tenga otro nombre (o ninguno reconocible) — no hay otro atributo de
    // joyería (metal, piedra, color) que sea un número sin texto. Evita
    // depender de adivinar cómo cada proveedor tituló ese atributo.
    const VALOR_TALLA_RE = /^\d{1,2}(\.\d+)?$/;
    // metal_type/rock_type pueden ser un campo de texto simple O una relación
    // many2one (Odoo los devuelve como [id, "Nombre"] en ese caso) — sin
    // esto, un many2one queda como "1,Plata Rodinada" (el array coaccionado
    // a texto) y encima nunca deduplica en el filtro (cada producto trae un
    // array distinto, aunque el texto sea igual).
    const nombreDe = v => Array.isArray(v) ? (v[1] || '') : (v || '');

    prods.forEach(p => {
      const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
      const tmpl = tmplMap[tmplId] || {};
      const joy = joyeriaMap[tmplId] || {};
      const categoria = Array.isArray(p.categ_id) ? p.categ_id[1] : '';
      const esAnilloProd = /anillo/i.test(categoria);
      const esMedida = a => MEDIDA_RE.test(a.attr) || (esAnilloProd && VALOR_TALLA_RE.test(String(a.val || '').trim()));
      const todosAtributos = (p.product_template_attribute_value_ids || [])
        .map(id => attrMap[id]).filter(Boolean);
      const medidas = todosAtributos.filter(esMedida);
      const atributos = todosAtributos.filter(a => !esMedida(a));
      result.push({
        id: p.id,
        proveedorId: proveedor.id,
        proveedorCodigo: proveedor.codigo,
        sku: p.default_code || '',
        nombre: p.name || '',
        descripcion: tmpl.description_sale || '',
        precio: parseFloat(p.list_price || 0),
        categoria,
        atributos,
        metal: nombreDe(joy.metal_type),
        piedra: nombreDe(joy.rock_type),
        medida: medidas.map(m => m.val).filter(Boolean).join(', '),
        barcode: p.barcode || '',
        stock: parseFloat(p.qty_available || 0)
      });
    });
  }
  cacheSet(cacheKey, result, CATALOGO_TTL_MS);
  return result;
}

// Fotos adicionales de UN producto (modelo product.image, "Extra Product
// Media" de Odoo) — más allá de la imagen principal. A propósito NO se pide
// para todo el catálogo de una (eso frenaba la carga entera de la colección
// por un round-trip extra a Odoo por cada tanda de 200 productos); se pide
// perezosamente, solo cuando se abre la ficha de ESE producto puntual.
async function fetchImagenesExtra(proveedor, productId) {
  if (proveedor.tipo !== 'odoo') return [];
  const cacheKey = 'imgids_' + proveedor.id + '_' + productId;
  const cached = cacheGet(cacheKey); if (cached) return cached;
  const conn = connFor(proveedor);
  const key = 'prov_' + proveedor.id;
  try {
    const prods = await xmlrpcCallFor(conn, key, 'product.product', 'read', [[productId], ['product_tmpl_id']]);
    const tmplId = prods && prods[0]
      ? (Array.isArray(prods[0].product_tmpl_id) ? prods[0].product_tmpl_id[0] : prods[0].product_tmpl_id)
      : null;
    if (!tmplId) { cacheSet(cacheKey, [], CATALOGO_TTL_MS); return []; }
    const imgs = await xmlrpcCallFor(conn, key, 'product.image', 'search_read', [[['product_tmpl_id', '=', tmplId]], ['id']]);
    const ids = imgs.map(im => im.id);
    cacheSet(cacheKey, ids, CATALOGO_TTL_MS);
    return ids;
  } catch (e) { return []; } // proveedor sin ese modelo/campo — no hay fotos extra, no es un error
}

// Catálogo de UN proveedor, con su precio de lista aplicado (si tiene partner_id/pricelist).
async function productosClienteProveedor(proveedor) {
  let prods = await fetchProductosProveedor(proveedor);
  if (proveedor.partner_id && prods.length) {
    try {
      const plId = await getPricelistIdProveedor(proveedor);
      if (plId) {
        const conn = connFor(proveedor);
        const ids = prods.map(p => p.id);
        const precios = await xmlrpcCallFor(conn, 'prov_' + proveedor.id, 'product.pricelist', 'get_products_price',
          [[plId], ids, ids.map(() => 1), new Date().toISOString().slice(0, 10)]);
        prods = prods.map(p => ({ ...p, precio: parseFloat(precios[p.id] || p.precio) }));
      }
    } catch (e) { console.warn('⚠ pricelist de ' + proveedor.codigo + ':', e.message); }
  }
  return prods;
}

// Catálogo combinado de TODOS los proveedores activos. Si uno falla (Odoo
// caído, credenciales vencidas), se loguea y se salta — no tumba a los demás.
async function productosClienteMulti() {
  const proveedores = await getActiveProveedores();
  // En paralelo — uno por uno, un proveedor lento (aunque tenga timeout)
  // sumaría su demora completa a la de los demás en vez de superponerse.
  const resultados = await Promise.allSettled(proveedores.map(p => productosClienteProveedor(p)));
  let todos = [];
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') todos = todos.concat(r.value);
    else console.warn('⚠ catálogo de ' + proveedores[i].codigo + ':', r.reason.message);
  });
  // Info libre del Excel del admin — keyeada por SKU puro (no por proveedor,
  // simplificación deliberada: Temponovo y Aviv usan formatos de código
  // visiblemente distintos, ver plan).
  try {
    const infoMap = await getProductoInfoMap();
    todos = todos.map(p => {
      const campos = infoMap[(p.sku || '').toUpperCase()];
      return campos ? { ...p, info: infoToList(campos) } : p;
    });
  } catch (e) { console.warn('⚠ merge producto_info:', e.message); }
  return todos;
}

// ── LISTA DE PRECIOS GLOBAL (Admin → Productos) ───────────────────
// Reemplaza el multiplicador/precios "por vendedora": un solo precio de
// venta para cualquier cliente de cualquier vendedora. Mismo patrón que
// getProductoInfoMap() — mapa en memoria con caché corta, invalidado en
// cada escritura.
const MULT_DEFAULT = 2;
async function getCatalogoMap() {
  const hit = cacheGet('catalogo_precios'); if (hit) return hit;
  let map = {};
  try {
    const { rows } = await sql`SELECT sku, precio, disponible FROM catalogo_productos`;
    rows.forEach(r => { map[(r.sku || '').toUpperCase()] = { precio: r.precio != null ? parseFloat(r.precio) : null, disponible: r.disponible !== false }; });
  } catch (e) { console.warn('⚠ catalogo_productos:', e.message); }
  cacheSet('catalogo_precios', map, 5 * 60 * 1000);
  return map;
}
async function getCategoriaMultMap() {
  const hit = cacheGet('categoria_mult'); if (hit) return hit;
  let map = {};
  try {
    const { rows } = await sql`SELECT familia, multiplicador FROM categoria_multiplicador`;
    rows.forEach(r => { map[r.familia] = parseFloat(r.multiplicador) || MULT_DEFAULT; });
  } catch (e) { console.warn('⚠ categoria_multiplicador:', e.message); }
  cacheSet('categoria_mult', map, 5 * 60 * 1000);
  return map;
}
function limpiarCacheCatalogoPrecios() {
  Object.keys(cache).filter(k => k === 'catalogo_precios' || k === 'categoria_mult' || k === 'categorias_display' || k.startsWith('productos') || k.startsWith('cat_') || k.startsWith('pub_'))
    .forEach(k => delete cache[k]);
}
// Catálogo con precio de venta y disponibilidad YA resueltos (precio fijo >
// multiplicador de su categoría > default). soloDisponibles=false es solo
// para el panel de Admin, que necesita ver también lo que está apagado.
async function catalogoConPrecioGlobal(soloDisponibles = true) {
  const todos = await productosClienteMulti();
  const [catalogoMap, multMap] = await Promise.all([getCatalogoMap(), getCategoriaMultMap()]);
  const conPrecio = todos.map(p => {
    const ov = catalogoMap[(p.sku || '').toUpperCase()];
    const disponible = !ov || ov.disponible !== false;
    const precioFijo = (ov && ov.precio > 0) ? Math.round(ov.precio) : null;
    const precioVenta = precioFijo != null ? precioFijo : Math.round(p.precio * (multMap[famOf(p)] || MULT_DEFAULT));
    return { ...p, precioVenta, precioFijo, disponible };
  });
  return soloDisponibles ? conPrecio.filter(p => p.disponible) : conPrecio;
}

// ════════════════════════════════════════════════════════════════
// VITRINA — catálogo con precio de venta global (ver catalogoConPrecioGlobal)
// ════════════════════════════════════════════════════════════════
app.get('/api/productos', async (req, res) => {
  try {
    const { v, error } = await authenticateVendedora(req);
    if (error) return res.status(401).json({ error });

    const cached = cacheGet('cat_' + v.codigo); if (cached) return res.json(cached);

    let prods = await catalogoConPrecioGlobal(true);
    const categorias = v.categorias || [];
    if (categorias.length) prods = prods.filter(p => categorias.includes(famOf(p)));

    cacheSet('cat_' + v.codigo, prods, VENDEDORA_TTL_MS);
    res.json(prods);
  } catch (e) { console.error('❌ /api/productos', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// "Actualizar catálogo" — botón-ícono en la propia vitrina de cada
// vendedora (junto al buscador), para traer precio/stock frescos de Odoo
// ahora mismo sin esperar el TTL normal del caché. También lo puede llamar
// el admin (token de admin). La vendedora solo limpia SU catálogo calculado
// y SU vitrina pública — el catálogo crudo por proveedor es compartido, así
// que igual se limpia siempre (es la única forma de traer stock de verdad
// nuevo de Odoo), pero eso no expone nada de otra vendedora.
app.delete('/api/productos/cache', async (req, res) => {
  if (verifyAdminToken(req.headers['x-admin-token'])) {
    Object.keys(cache).filter(k => k.startsWith('productos') || k.startsWith('cat_') || k.startsWith('img_') || k.startsWith('pub_'))
      .forEach(k => delete cache[k]);
    return res.json({ ok: true });
  }
  const { v, error } = await authenticateVendedora(req);
  if (error) return res.status(401).json({ error });
  const slug = slugOf(v.codigo);
  Object.keys(cache).filter(k => k.startsWith('productos') || k === 'cat_' + v.codigo || k.startsWith('pub_' + slug))
    .forEach(k => delete cache[k]);
  res.json({ ok: true });
});

// ── IMAGEN INDIVIDUAL (miniatura o grande) ───────────────────────
// GET /api/imagen/:proveedorId/:id?c=CODIGO&t=TOKEN&s=g → image_1024 (detalle / probar)
// El id numérico de Odoo NO es único entre proveedores (cada Odoo tiene su
// propia numeración) — va namespaced por proveedorId en la URL y en el
// caché, para no mezclar/pisar imágenes de dos proveedores distintos.
// Usa el token de imagen (ver imgToken), nunca la clave real — un <img src>
// no puede mandar headers, y una clave en la URL queda en logs/historial.
app.get('/api/imagen/:proveedorId/:id', async (req, res) => {
  try {
    const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    const token  = req.headers['x-client-token'] || req.query.t || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyImgToken(v, token)) return res.status(401).send('No autorizado');
    const proveedorId = parseInt(req.params.proveedorId);
    const id = parseInt(req.params.id);
    if (!proveedorId || !id) return res.status(400).send('ID inválido');
    const field = req.query.s === 'g' ? 'image_1024' : 'image_256';

    const key = 'img_' + proveedorId + '_' + field + '_' + id;
    let b64 = cacheGet(key);
    if (!b64) {
      // Si Odoo está lento/caído para ESTA imagen puntual, no tumba la
      // página con un 500 — se cae al placeholder y listo. Con la vitrina
      // pidiendo muchas imágenes de golpe (una por producto), un proveedor
      // lento puede fallar alguna suelta sin que sea un error real; no se
      // cachea el fallo, así que la próxima carga reintenta contra Odoo.
      try {
        const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
        if (proveedor && proveedor.tipo === 'odoo') {
          const conn = connFor(proveedor);
          const prods = await xmlrpcCallFor(conn, 'prov_' + proveedorId, 'product.product', 'read', [[id], [field]]);
          b64 = prods && prods[0] ? prods[0][field] : null;
          if (b64) cacheSet(key, b64, 2 * 60 * 60 * 1000);
        }
      } catch (e) { console.warn('⚠ /api/imagen/' + proveedorId + '/' + id + ':', e.message); }
    }
    if (!b64) {
      const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      res.setHeader('Content-Type', 'image/png');
      return res.send(px);
    }
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400');
    res.send(buf);
  } catch (e) {
    console.error('❌ /api/imagen/' + req.params.proveedorId + '/' + req.params.id, e.message);
    res.status(500).send('No se pudo cargar la imagen');
  }
});

// Foto adicional (galería) — mismo patrón que /api/imagen, pero contra el
// modelo product.image (id propio, no el id del product.product).
app.get('/api/imagen-extra/:proveedorId/:imgId', async (req, res) => {
  try {
    const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    const token  = req.headers['x-client-token'] || req.query.t || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyImgToken(v, token)) return res.status(401).send('No autorizado');
    const proveedorId = parseInt(req.params.proveedorId);
    const imgId = parseInt(req.params.imgId);
    if (!proveedorId || !imgId) return res.status(400).send('ID inválido');
    const field = req.query.s === 'g' ? 'image_1024' : 'image_256';

    const key = 'imgx_' + proveedorId + '_' + field + '_' + imgId;
    let b64 = cacheGet(key);
    if (!b64) {
      try {
        const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
        if (proveedor && proveedor.tipo === 'odoo') {
          const conn = connFor(proveedor);
          const imgs = await xmlrpcCallFor(conn, 'prov_' + proveedorId, 'product.image', 'read', [[imgId], [field]]);
          b64 = imgs && imgs[0] ? imgs[0][field] : null;
          if (b64) cacheSet(key, b64, 2 * 60 * 60 * 1000);
        }
      } catch (e) { console.warn('⚠ imagen-extra ' + proveedorId + '/' + imgId + ':', e.message); }
    }
    if (!b64) {
      const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      res.setHeader('Content-Type', 'image/png');
      return res.send(px);
    }
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400');
    res.send(buf);
  } catch (e) {
    console.error('❌ /api/imagen-extra/' + req.params.proveedorId + '/' + req.params.imgId, e.message);
    res.status(500).send('No se pudo cargar la imagen');
  }
});

// ── DIRECCIÓN — geocodificación server-side (evita el CORS/bloqueos que dan Photon/Nominatim directo desde el navegador) ──
// Usa el módulo https nativo (no depende de que el runtime de Node tenga fetch global).
const https = require('https');
function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 6000 }, (r) => {
      let data = '';
      r.on('data', chunk => { data += chunk; });
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) return reject(new Error('HTTP ' + r.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ── CLIENTE DE API DE VENTAS PROPIA DE UN PROVEEDOR (estilo Temponovo) ──
// Generalizado: toma el proveedor (con su venta_api_url/venta_api_key_enc/
// venta_vendor_email propios) en vez de las constantes de módulo TEMPO_*.
function tempoApiCall(proveedor, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = proveedor.venta_api_key_enc ? decryptCred(proveedor.venta_api_key_enc) : '';
    if (!apiKey) return reject(new Error('Falta la API key de ventas de ' + proveedor.nombre));
    let url;
    try { url = new URL((proveedor.venta_api_url || '').replace(/\/$/, '') + path); } catch { return reject(new Error('URL de la API de ventas de ' + proveedor.nombre + ' inválida')); }
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
      },
      timeout: 15000
    }, r => {
      let raw = '';
      r.on('data', chunk => { raw += chunk; });
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* respuesta no-JSON */ }
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve(parsed);
        const msg = (parsed && (parsed.error || parsed.message || JSON.stringify(parsed))) || raw || ('HTTP ' + r.statusCode);
        const err = new Error(msg); err.status = r.statusCode; err.body = parsed;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado llamando a la API de ventas de ' + proveedor.nombre)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function tempoCrearVenta(proveedor, { vendorEmail, observacion, tipoVenta, productos }) {
  const r = await tempoApiCall(proveedor, 'POST', '/sale/create', {
    body: { data: {
      vendor_email: vendorEmail || undefined,
      tempo_observation: observacion || '',
      tempo_type_sale: tipoVenta || '',
      productos
    } }
  });
  const d = (r && r.data) || r || {};
  if (!d.Id_Venta) throw new Error('La API de ' + proveedor.nombre + ' no devolvió Id_Venta');
  return d; // { Id_Venta, Nombre }
}
async function tempoAgregarProductos(proveedor, idVenta, productos) {
  const r = await tempoApiCall(proveedor, 'POST', '/sale/update', {
    headers: { Idventa: String(idVenta) },
    body: { data: { productos } }
  });
  return (r && r.data) || r || {};
}
// GET /api/sale — se usa DESPUÉS de cada /sale/update para confirmar que los
// productos de verdad quedaron en la venta. La API puede responder "éxito"
// (200, con Id_Venta y Nombre) sin haber agregado nada de verdad — por
// ejemplo si la venta ya está cancelada, bloqueada o facturada — así que no
// alcanza con mirar el código de respuesta, hay que releer la venta.
async function tempoConsultarVenta(proveedor, idVenta) {
  const r = await tempoApiCall(proveedor, 'GET', '/api/sale', { headers: { Idventa: String(idVenta) } });
  return (r && r.data) || r || {};
}
// Devuelve los SKU que se intentaron agregar pero que NO aparecen en la
// venta al releerla — esos son los que en realidad no quedaron guardados.
function productosFaltantes(productosEnviados, ventaInfo) {
  const lineas = (ventaInfo && ventaInfo.Productos) || [];
  const skusEnVenta = new Set(lineas.map(l => String(l.Sku || l.sku || '').toUpperCase()));
  return productosEnviados.filter(p => !skusEnVenta.has(String(p.sku).toUpperCase()));
}
// Intenta agregar la venta a la ÚNICA "venta abierta" de ESTE proveedor
// (compartida por todas las vendedoras que le venden, porque todas facturan
// al mismo partner). Si esa venta ya no admite cambios de verdad (aunque la
// API haya respondido "éxito"), abre una venta nueva automáticamente.
//
// Usa un lock a nivel de fila (SELECT ... FOR UPDATE) sobre la fila del
// proveedor en "proveedores" (antes era la fila única de "configuracion")
// mientras dura la llamada a la API, para que si dos vendedoras mandan un
// pedido casi al mismo tiempo, el segundo espere a que termine el primero
// en vez de leer el mismo estado viejo y terminar abriendo 2 ventas nuevas.
async function intentarEnviarVentaApi(proveedor, { productos, observacion, tipoVenta }, v) {
  const productosApi = (productos || []).map(p => ({ sku: p.sku, quantity: parseFloat(p.quantity) || 1 }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT venta_abierta_id, venta_abierta_nombre FROM proveedores WHERE id = $1 FOR UPDATE', [proveedor.id]);
    let idVenta = rows[0]?.venta_abierta_id || null;
    let nombreOdoo = rows[0]?.venta_abierta_nombre || null;

    if (idVenta) {
      try {
        await tempoAgregarProductos(proveedor, idVenta, productosApi);
        const info = await tempoConsultarVenta(proveedor, idVenta);
        const faltan = productosFaltantes(productosApi, info);
        if (faltan.length) {
          throw new Error('La venta no reflejó los productos agregados (' + faltan.map(p => p.sku).join(', ') + ') — probablemente está bloqueada, facturada o cancelada en Odoo');
        }
        await client.query('COMMIT');
        return { idVenta, nombreOdoo: info.Nombre || nombreOdoo };
      } catch (e) {
        console.warn(`⚠ venta abierta ${idVenta} de ${proveedor.nombre} ya no admite cambios de verdad (${shortErr(e)}), se abre una nueva`);
      }
    }
    const obsConVendedora = `Vendedora: ${v.nombre} (${v.codigo})` + (observacion ? ' | ' + observacion : '');
    const vendorEmail = proveedor.venta_vendor_email || undefined;
    const r = await tempoCrearVenta(proveedor, { vendorEmail, observacion: obsConVendedora, tipoVenta, productos: productosApi });
    await client.query('UPDATE proveedores SET venta_abierta_id = $1, venta_abierta_nombre = $2 WHERE id = $3', [r.Id_Venta, r.Nombre, proveedor.id]);
    await client.query('COMMIT');
    return { idVenta: r.Id_Venta, nombreOdoo: r.Nombre };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ── VENTA DIRECTA EN ODOO (proveedor sin API de ventas propia, ej. Aviv) ──
// Mismo patrón de lock + "agregar a la venta abierta, si ya no se puede
// abrir una nueva" que intentarEnviarVentaApi, pero contra Odoo directo:
// resuelve los product.product por default_code y crea/edita un sale.order
// estándar por XML-RPC (no hay middleware REST de por medio).
async function odooIntentarVentaDirecta(proveedor, { productos, observacion }, v) {
  const conn = connFor(proveedor);
  const key = 'prov_' + proveedor.id;
  const skus = (productos || []).map(p => p.sku);
  const encontrados = await xmlrpcCallFor(conn, key, 'product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'default_code'] });
  const idPorSku = {}; encontrados.forEach(r => { idPorSku[r.default_code] = r.id; });
  const faltantes = (productos || []).filter(p => !idPorSku[p.sku]);
  if (faltantes.length) {
    throw new Error('SKU no encontrado en Odoo de ' + proveedor.nombre + ': ' + faltantes.map(p => p.sku).join(', '));
  }
  const obsConVendedora = `Vendedora: ${v.nombre} (${v.codigo})` + (observacion ? ' | ' + observacion : '');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT venta_abierta_id, venta_abierta_nombre FROM proveedores WHERE id = $1 FOR UPDATE', [proveedor.id]);
    let idVenta = rows[0]?.venta_abierta_id || null;
    let nombreOdoo = rows[0]?.venta_abierta_nombre || null;

    if (idVenta) {
      try {
        const [venta] = await xmlrpcCallFor(conn, key, 'sale.order', 'read', [[idVenta], ['state']]);
        if (!venta || !['draft', 'sent'].includes(venta.state)) throw new Error('la venta ya no está editable (estado: ' + (venta ? venta.state : 'no existe') + ')');
        for (const p of productos) {
          await xmlrpcCallFor(conn, key, 'sale.order.line', 'create',
            [{ order_id: idVenta, product_id: idPorSku[p.sku], product_uom_qty: parseFloat(p.quantity) || 1 }]);
        }
        await client.query('COMMIT');
        return { idVenta, nombreOdoo };
      } catch (e) {
        console.warn(`⚠ venta abierta ${idVenta} de ${proveedor.nombre} ya no admite cambios de verdad (${shortErr(e)}), se abre una nueva`);
      }
    }
    const orderLines = productos.map(p => [0, 0, { product_id: idPorSku[p.sku], product_uom_qty: parseFloat(p.quantity) || 1 }]);
    const nuevoId = await xmlrpcCallFor(conn, key, 'sale.order', 'create',
      [{ partner_id: proveedor.partner_id, order_line: orderLines, client_order_ref: obsConVendedora }]);
    const [rec] = await xmlrpcCallFor(conn, key, 'sale.order', 'read', [[nuevoId], ['name']]);
    await client.query('UPDATE proveedores SET venta_abierta_id = $1, venta_abierta_nombre = $2 WHERE id = $3', [nuevoId, rec.name, proveedor.id]);
    await client.query('COMMIT');
    return { idVenta: nuevoId, nombreOdoo: rec.name };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Elige cómo mandar la venta según si el proveedor tiene su propia API de
// ventas (venta_api_url + venta_api_key_enc, estilo Temponovo) o no (se crea
// un sale.order directo en su Odoo, estilo Aviv).
function enviarVentaProveedor(proveedor, payload, v) {
  if (proveedor.venta_api_url && proveedor.venta_api_key_enc) {
    return intentarEnviarVentaApi(proveedor, payload, v);
  }
  return odooIntentarVentaDirecta(proveedor, payload, v);
}

const GEOCODE_UA = 'VitrinaTemponovo/1.0 (+https://temponovo.odoo.com)';
async function geocodificar(q) {
  const key = 'geo_' + q.toLowerCase();
  const hit = cacheGet(key); if (hit) return hit;

  let items = [];
  // 1) Photon (komoot) — primera opción, buenos resultados en Chile
  try {
    const d = await httpsGetJson(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=es&limit=5&lat=-33.45&lon=-70.66`,
      { 'User-Agent': GEOCODE_UA, 'Accept': 'application/json' });
    items = (d.features || []).map(f => {
      const p = f.properties || {};
      const l1 = [p.name || p.street, p.housenumber].filter(Boolean).join(' ');
      const comuna = p.district || p.city || p.county || '';
      const l2 = [p.district, p.city || p.county, p.state].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      return { label: [l1, l2].filter(Boolean).join(', '), comuna };
    }).filter(x => x.label);
  } catch (e) { console.warn('⚠ geocodificar (photon):', e.message); }

  // 2) Nominatim (OpenStreetMap) — respaldo si Photon no contestó o no encontró nada
  if (!items.length) {
    try {
      const d = await httpsGetJson(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=5&countrycodes=cl`,
        { 'User-Agent': GEOCODE_UA, 'Accept': 'application/json' });
      items = (Array.isArray(d) ? d : []).map(p => {
        const a = p.address || {};
        const l1 = [a.road, a.house_number].filter(Boolean).join(' ') || (p.display_name || '').split(',')[0];
        const comuna = a.city_district || a.suburb || a.city || a.town || a.municipality || '';
        const l2 = [comuna, a.state].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
        return { label: [l1, l2].filter(Boolean).join(', '), comuna };
      }).filter(x => x.label);
    } catch (e) { console.warn('⚠ geocodificar (nominatim):', e.message); }
  }

  cacheSet(key, items, 10 * 60 * 1000);
  return items;
}
app.get('/api/geocodificar', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.json([]);
    res.json(await geocodificar(q));
  } catch (e) { console.error('❌ /api/geocodificar', e.message); res.json([]); }
});

// ── FOTOS EN ZIP (opcionalmente filtradas por familia) ───────────
app.get('/api/fotos', async (req, res) => {
  try {
    const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    const token  = req.headers['x-client-token'] || req.query.t || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyImgToken(v, token)) return res.status(401).json({ error: 'No autorizado' });

    const familia = (req.query.familia || '').trim().toLowerCase();
    let prods = await productosClienteMulti();
    if (familia) prods = prods.filter(p => famOf(p).toLowerCase() === familia);
    if (!prods.length) return res.status(404).json({ error: 'Sin productos para esa familia' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="temponovo-fotos${familia ? '-' + familia.replace(/[\s/]+/g, '-') : ''}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', e => { console.error('❌ zip', e.message); try { res.end(); } catch {} });
    archive.pipe(res);

    // Agrupa por proveedor — cada Odoo tiene su propia numeración de id, así
    // que hay que leer las imágenes por separado de cada uno (y el nombre
    // del archivo en el zip lleva el código del proveedor, para no pisar
    // fotos de dos proveedores con el mismo sku o id).
    const porProveedor = new Map();
    prods.forEach(p => {
      if (!porProveedor.has(p.proveedorId)) porProveedor.set(p.proveedorId, { proveedorCodigo: p.proveedorCodigo, items: [] });
      porProveedor.get(p.proveedorId).items.push(p);
    });
    for (const [proveedorId, grupo] of porProveedor) {
      const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
      if (!proveedor || proveedor.tipo !== 'odoo') continue;
      const conn = connFor(proveedor);
      const bySku = {}; grupo.items.forEach(p => { bySku[p.id] = p.sku || String(p.id); });
      const ids = grupo.items.map(p => p.id);
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const imgs = await xmlrpcCallFor(conn, 'prov_' + proveedorId, 'product.product', 'read', [chunk, ['id', 'image_512']]);
        imgs.forEach(r => {
          if (!r.image_512) return;
          const name = grupo.proveedorCodigo + '-' + String(bySku[r.id]).replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
          archive.append(Buffer.from(r.image_512, 'base64'), { name });
        });
      }
    }
    await archive.finalize();
  } catch (e) {
    console.error('❌ /api/fotos', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el zip de fotos' });
  }
});

// ── CATÁLOGO EN PDF (por familia/subfamilia, con logo y nombre de la
// vendedora) — un PDF en cuadrícula con foto, nombre y precio de venta,
// solo de lo que tiene stock. Pensado para mandar por WhatsApp.
// Las mismas 15 tipografías que la vendedora puede elegir en su Configuración
// (ver F1_STACK/F2_STACK en index.html) — se bajaron una vez de Google Fonts
// como .woff2 (carpeta /fonts) para poder incrustarlas de verdad en el PDF,
// sin depender de una llamada a internet en cada descarga. La mayoría son
// .woff2; 5 de ellas (marcellus, lato, poppins, bebas-neue, dm-serif-display)
// están en .ttf a propósito — su .woff2 hace que pdfkit/fontkit crashee el
// proceso entero al escribir el PDF (bug de esa versión de fontkit con esos
// archivos puntuales, no atajable con try/catch porque revienta async
// adentro de doc.end()) — verificado uno por uno, ver commit.
const FONTS_DIR = path.join(__dirname, '..', 'fonts');
const FONT_FILES = {
  'Marcellus': 'marcellus.ttf', 'Playfair Display': 'playfair-display.woff2', 'Cormorant Garamond': 'cormorant-garamond.woff2',
  'DM Serif Display': 'dm-serif-display.ttf', 'Lora': 'lora.woff2', 'Abril Fatface': 'abril-fatface.woff2',
  'Bebas Neue': 'bebas-neue.ttf', 'Poppins': 'poppins.ttf', 'Jost': 'jost.woff2', 'Lato': 'lato.ttf',
  'DM Sans': 'dm-sans.woff2', 'Montserrat': 'montserrat.woff2', 'Inter': 'inter.woff2', 'Nunito': 'nunito.woff2',
  'Work Sans': 'work-sans.woff2'
};
function registrarFuenteMarca(doc, nombreFuente, fallback) {
  const archivo = FONT_FILES[nombreFuente];
  if (!archivo) return fallback;
  try {
    const ruta = path.join(FONTS_DIR, archivo);
    if (!fs.existsSync(ruta)) return fallback;
    doc.registerFont(nombreFuente, ruta);
    return nombreFuente;
  } catch (e) { return fallback; }
}
async function generarCatalogoPDF(prods, vendedora, familia, subfamilia) {
  // Imágenes de a bloques, por proveedor (cada Odoo tiene su propia conexión).
  const porProveedor = new Map();
  prods.forEach(p => {
    if (!porProveedor.has(p.proveedorId)) porProveedor.set(p.proveedorId, []);
    porProveedor.get(p.proveedorId).push(p);
  });
  const imgPorId = {};
  for (const [proveedorId, items] of porProveedor) {
    const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
    if (!proveedor || proveedor.tipo !== 'odoo') continue;
    const conn = connFor(proveedor);
    const ids = items.map(p => p.id);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const imgs = await xmlrpcCallFor(conn, 'prov_' + proveedorId, 'product.product', 'read', [chunk, ['id', 'image_256']]);
        imgs.forEach(r => { if (r.image_256) imgPorId[proveedorId + '::' + r.id] = r.image_256; });
      } catch (e) { console.warn('⚠ catalogo-pdf imágenes ' + proveedorId + ':', e.message); }
    }
  }

  const MM = 2.8346;
  const PAGE_W = 210 * MM, PAGE_H = 297 * MM, mg = 8 * MM;
  const COLS = 3, ROWS = 4, PER_PG = COLS * ROWS;
  const headerH = 22 * MM, footerH = 10 * MM;
  const cellW = (PAGE_W - mg * 2) / COLS;
  const cellH = (PAGE_H - mg * 2 - headerH - footerH) / ROWS;
  const imgAreaH = cellH * 0.62;

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  // Mismos colores y tipografías que eligió en su Configuración — para que
  // el PDF se sienta "la misma marca", no una plantilla genérica.
  const hdr = /^#[0-9a-f]{6}$/i.test(vendedora.hdr || '') ? vendedora.hdr : '#191b1e';
  const F1 = registrarFuenteMarca(doc, vendedora.f1, 'Helvetica-Bold'); // títulos/nombre de producto
  const F2 = registrarFuenteMarca(doc, vendedora.f2, 'Helvetica');      // texto/precio

  const fecha = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const titulo = subfamilia ? familia + ' · ' + subfamilia : familia;
  let logoBuf = null;
  if (vendedora.logo && vendedora.logo.startsWith('data:')) {
    try { logoBuf = Buffer.from(vendedora.logo.split(',')[1] || '', 'base64'); } catch (e) {}
  }

  function drawHeader() {
    doc.addPage();
    const top = 5 * MM;
    if (logoBuf) {
      try { doc.image(logoBuf, mg, top, { fit: [40 * MM, 14 * MM] }); } catch (e) {}
    }
    doc.fontSize(9).fillColor('#555555').font(F2)
      .text((vendedora.nombre || '').toUpperCase(), mg, top + 15 * MM, { width: 90 * MM, lineBreak: false });
    doc.fontSize(16).fillColor(hdr).font(F1)
      .text(titulo, mg, top + 3 * MM, { width: PAGE_W - mg * 2, align: 'right' });
    doc.moveTo(mg, top + headerH - 3 * MM).lineTo(PAGE_W - mg, top + headerH - 3 * MM)
      .strokeColor(hdr).lineWidth(0.5 * MM).stroke();
  }
  function drawFooter() {
    const fy = PAGE_H - mg - footerH + 3 * MM;
    doc.moveTo(mg, fy).lineTo(PAGE_W - mg, fy).strokeColor('#dddddd').lineWidth(0.15 * MM).stroke();
    doc.fontSize(8).fillColor('#888888').font(F2)
      .text(fecha, mg, fy + 2 * MM, { width: PAGE_W - mg * 2, align: 'center' });
  }

  const ordenados = [...prods].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  let idx = 0;
  for (const p of ordenados) {
    if (idx === 0 || idx >= PER_PG) { if (idx > 0) drawFooter(); drawHeader(); idx = 0; }
    const col = idx % COLS, row = Math.floor(idx / COLS);
    const x = mg + col * cellW, y = 5 * MM + headerH + row * cellH;

    const b64 = imgPorId[p.proveedorId + '::' + p.id];
    if (b64) {
      try { doc.image(Buffer.from(b64, 'base64'), x + 2 * MM, y, { fit: [cellW - 4 * MM, imgAreaH], align: 'center', valign: 'center' }); }
      catch (e) { doc.rect(x, y, cellW, imgAreaH).fill('#f5f5f5'); }
    } else {
      doc.rect(x, y, cellW, imgAreaH).fill('#f5f5f5');
    }

    const infoY = y + imgAreaH + 2 * MM;
    doc.fontSize(9).fillColor('#191b1e').font(F1)
      .text(p.nombre || '', x, infoY, { width: cellW, align: 'center', height: 8 * MM, ellipsis: true });
    doc.fontSize(9).fillColor(hdr).font(F2)
      .text('$' + Math.round(p.precioVenta || 0).toLocaleString('es-CL'), x, infoY + 7 * MM, { width: cellW, align: 'center' });

    idx++;
  }
  if (idx > 0) drawFooter();
  doc.end();
  return new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
}

app.get('/api/catalogo-pdf', async (req, res) => {
  try {
    const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    const token  = req.headers['x-client-token'] || req.query.t || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyImgToken(v, token)) return res.status(401).json({ error: 'No autorizado' });

    const familia = (req.query.familia || '').trim();
    const subfamilia = (req.query.subfamilia || '').trim();
    if (!familia) return res.status(400).json({ error: 'Falta la familia' });

    let prods = await catalogoConPrecioGlobal(true);
    const categorias = v.categorias || [];
    if (categorias.length) prods = prods.filter(p => categorias.includes(famOf(p)));
    prods = prods.filter(p => {
      if (p.stock <= 0) return false;
      const fs = famSub(p);
      return fs.fam === familia && (!subfamilia || fs.sub === subfamilia);
    });
    if (!prods.length) return res.status(404).json({ error: 'No hay productos con stock en esa categoría' });

    const cfg0 = await getConfig();
    const cfg = await readCfgDb(v, cfg0.partner_id);

    const buffer = await generarCatalogoPDF(prods, {
      nombre: cfg.nombre || v.nombre, logo: cfg.logo || '',
      hdr: cfg.hdr || '#191b1e', f1: cfg.f1 || 'Marcellus', f2: cfg.f2 || 'Jost'
    }, familia, subfamilia);
    const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const nombreArchivo = 'catalogo-' + slug(familia) + (subfamilia ? '-' + slug(subfamilia) : '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.send(buffer);
  } catch (e) {
    console.error('❌ /api/catalogo-pdf', e.message);
    res.status(500).json({ error: 'No se pudo generar el PDF' });
  }
});

// ════════════════════════════════════════════════════════════════
// VENTAS — se envían al instante a Odoo vía la API de ventas de Temponovo
// (POST /sale/create la primera vez, POST /sale/update mientras la venta
// siga abierta). Si la API rechaza el /sale/update (p.ej. la venta ya fue
// pickeada), se abre una venta nueva automáticamente.
// ════════════════════════════════════════════════════════════════
app.post('/api/pedido', requireClient, async (req, res) => {
  try {
    const { productos, nombreVenta, direccion, comuna, entrega, telefono, email, nota, metodoPago } = req.body?.data || {};
    if (!productos?.length) return res.status(400).json({ error: 'Sin productos' });

    // Catálogo combinado — sirve para el precio/categoría por línea y para
    // saber a qué proveedor pertenece cada producto (si una línea no trae
    // proveedorId, ej. una pestaña vieja abierta durante el deploy, se
    // resuelve por sku contra este catálogo como compatibilidad). Usa
    // catalogoConPrecioGlobal(true) — mismo precio para cualquier vendedora,
    // y un producto marcado no-disponible directamente no aparece acá (no
    // se puede comprar aunque alguien tenga la pestaña vieja abierta).
    let catalogo = [];
    try { catalogo = await catalogoConPrecioGlobal(true); } catch (e) { console.warn('⚠ precio pedido:', e.message); }
    const porPid = {}; catalogo.forEach(p => { porPid[p.proveedorId + '::' + p.sku] = p; });
    const primeroPorSku = {}; catalogo.forEach(p => { if (!primeroPorSku[p.sku]) primeroPorSku[p.sku] = p; });
    // % vigente AHORA — se graba el monto ya calculado en cada línea (no el
    // %) para que lo ya ganado no cambie si el admin lo ajusta después.
    const comisionPct = parseFloat(req.vendedora.comision) || 0;

    // Agrupa el carrito por proveedor — de acá sale el split real.
    const grupos = new Map(); // proveedorId -> [{sku, quantity}]
    for (const p of productos) {
      const fallback = primeroPorSku[p.sku];
      const proveedorId = p.proveedorId || (fallback ? fallback.proveedorId : null);
      if (!proveedorId) return res.status(400).json({ error: 'No se pudo identificar el proveedor del producto "' + p.sku + '" — refrescá la página e intentá de nuevo.' });
      if (!grupos.has(proveedorId)) grupos.set(proveedorId, []);
      grupos.get(proveedorId).push(p);
    }

    const entregaFinal = entrega === 'retiro' ? 'retiro' : 'despacho';
    const notaFinal = [nombreVenta, telefono, email, nota, metodoPago ? 'Método: ' + metodoPago : ''].filter(Boolean).join(' | ');
    const grupoId = crypto.randomUUID();
    const resultados = [];

    for (const [proveedorId, lineas] of grupos) {
      let proveedor = null;
      try { proveedor = await getProveedorActivo(proveedorId); } catch {}

      // Carga datos nuevos de BD y calcula snapshot inmutable de cada línea
      // Fase 2: costo, precio_pvp, iva%, comisión con cascada (producto → categoría → vendedora)
      let total = 0, utilidadTotal = 0, comisionTotal = 0;
      const productosConDetalle = [];

      for (const l of lineas) {
        const info = porPid[proveedorId + '::' + l.sku] || primeroPorSku[l.sku];
        const categoria = info ? famOf(info) : '';
        const qty = parseFloat(l.quantity) || 1;

        // Obtén valores de BD para nuevo sistema (Fase 2)
        let producto_bd = null;
        try {
          const { rows } = await sql`SELECT costo, precio_pvp, iva_porcentaje, comision_vendedora_override FROM catalogo_productos WHERE sku = ${l.sku.toUpperCase()}`;
          producto_bd = rows?.[0];
        } catch (e) { console.warn('⚠ Fallo lectura producto en BD:', l.sku, e.message); }

        // Obtén comisión override de categoría
        let categoria_bd = null;
        if (categoria) {
          try {
            const { rows } = await sql`SELECT comision_override FROM categoria_multiplicador WHERE familia = ${categoria}`;
            categoria_bd = rows?.[0];
          } catch (e) { console.warn('⚠ Fallo lectura categoría en BD:', categoria, e.message); }
        }

        // Usa valores nuevos si existen, sino fallback a old system
        const costo_unitario = producto_bd?.costo != null ? parseFloat(producto_bd.costo) : (info?.precio || 0);
        const precio_pvp = producto_bd?.precio_pvp != null ? parseFloat(producto_bd.precio_pvp) : (info?.precioVenta || 0);
        const iva_porcentaje = producto_bd?.iva_porcentaje != null ? parseFloat(producto_bd.iva_porcentaje) : 19;

        // Cascada de comisión: producto → categoría → vendedora
        let comision_porcentaje = comisionPct; // default vendedora
        if (producto_bd?.comision_vendedora_override != null) {
          comision_porcentaje = parseFloat(producto_bd.comision_vendedora_override);
        } else if (categoria_bd?.comision_override != null) {
          comision_porcentaje = parseFloat(categoria_bd.comision_override);
        }

        // Calcula snapshot de línea
        const calculos = calcularLinea({
          cantidad: qty,
          costo_unitario,
          precio_pvp,
          iva_porcentaje,
          comision_porcentaje
        });

        total += calculos.total_linea;
        comisionTotal += calculos.comision_monto;
        utilidadTotal += calculos.utilidad_vitrina;

        // Graba snapshot completo en el JSON
        productosConDetalle.push({
          sku: l.sku,
          quantity: qty,
          categoria,
          ...calculos // spread de base_imponible, monto_iva, margen_bruto, comision_monto, utilidad_vitrina, total_linea, etc.
        });
      }

      let idVenta = null, nombreOdoo = null, errorMsg = null;
      if (!proveedor) {
        errorMsg = 'Proveedor no disponible';
      } else {
        try {
          const r = await enviarVentaProveedor(proveedor, {
            productos: productosConDetalle, observacion: notaFinal,
            tipoVenta: entregaFinal === 'retiro' ? 'Retiro' : 'Despacho'
          }, req.vendedora);
          idVenta = r.idVenta; nombreOdoo = r.nombreOdoo;
        } catch (e) { errorMsg = shortErr(e); console.error('❌ envío a proveedor ' + (proveedor?.codigo || proveedorId), e.message); }
      }

      resultados.push({
        proveedorId, proveedorNombre: proveedor ? proveedor.nombre : ('proveedor #' + proveedorId),
        estado: (idVenta && !errorMsg) ? 'enviada' : 'error',
        idVenta, nombreOdoo, errorMsg, productosConDetalle, total, comisionTotal
      });
    }

    // Una fila en ventas_pendientes por proveedor, todas con el mismo grupo_id.
    for (const r of resultados) {
      await sql`
        INSERT INTO ventas_pendientes
          (vendedora_id, productos, nombre_venta, telefono, email, direccion, comuna, entrega, nota, total, comision, estado, odoo_order_id, odoo_venta_nombre, error_msg, consolidado_at, grupo_id, proveedor_id)
        VALUES
          (${req.vendedora.id}, ${JSON.stringify(r.productosConDetalle)}, ${nombreVenta || ''},
           ${telefono || ''}, ${email || ''}, ${entregaFinal === 'retiro' ? '' : (direccion || '')}, ${comuna || ''}, ${entregaFinal}, ${notaFinal}, ${Math.round(r.total)}, ${Math.round(r.comisionTotal)},
           ${r.estado}, ${r.idVenta}, ${r.nombreOdoo}, ${r.errorMsg}, ${r.estado === 'enviada' ? new Date() : null}, ${grupoId}, ${r.proveedorId})`;
    }

    // orden_secuencia: una sola vez por grupo_id (no por fila — con N filas
    // por pedido, contar filas al vuelo como antes desalinearía el número).
    // MAX(orden_secuencia)+1 en vez de COUNT(DISTINCT grupo_id): las ventas
    // de antes del split no tienen grupo_id (quedarían sin contar) pero SÍ
    // tienen orden_secuencia gracias al backfill de ensureDb() — así el
    // número sigue la numeración histórica de la vendedora sin chocar.
    const { rows: seqRows } = await sql`SELECT COALESCE(MAX(orden_secuencia), 0)::int AS n FROM ventas_pendientes WHERE vendedora_id = ${req.vendedora.id}`;
    const secuencia = seqRows[0].n + 1;
    await sql`UPDATE ventas_pendientes SET orden_secuencia = ${secuencia} WHERE grupo_id = ${grupoId}`;
    const numero = numeroVenta(req.vendedora.codigo, secuencia);

    const fallidos = resultados.filter(r => r.estado === 'error');
    if (fallidos.length) {
      return res.status(502).json({
        error: 'Tu venta quedó guardada (N° ' + numero + '), pero no pudimos terminar de procesarla con: ' + fallidos.map(r => r.proveedorNombre).join(', ') + '. La estamos reintentando — te avisamos apenas quede lista.',
        orderId: grupoId, pending: true
      });
    }
    res.json({
      ok: true, orderId: grupoId, numero, seguimiento: 'recibido',
      message: resultados.length > 1
        ? `Venta recibida — se separó en ${resultados.length} envíos (${resultados.map(r => r.proveedorNombre).join(', ')})`
        : 'Venta recibida'
    });
  } catch (e) { console.error('❌ /api/pedido', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// Un pedido de cliente puede tener varias filas en ventas_pendientes (una
// por proveedor, mismo grupo_id) desde el split automático. Acá se agrupan
// de vuelta en un solo objeto por pedido, con un "envios[]" por proveedor —
// pero también se replican los campos de siempre (estado/seguimiento/
// lineas...) a nivel superior tomando el primer envío, para que un pedido
// de un solo proveedor (el 99% de los casos hoy) se siga viendo exactamente
// igual que antes sin que el frontend tenga que mirar "envios" para nada.
function pedidoEstadoGeneral(envios) {
  if (envios.some(e => e.estado === 'error')) return 'error';
  if (envios.every(e => e.estado === 'cancelada')) return 'cancelada';
  return 'enviada';
}
app.get('/api/pedidos', requireClient, async (req, res) => {
  try {
    const { rows } = await sql`
      SELECT vp.*, pr.nombre AS proveedor_nombre
      FROM ventas_pendientes vp
      LEFT JOIN proveedores pr ON pr.id = vp.proveedor_id
      WHERE vp.vendedora_id = ${req.vendedora.id}
      ORDER BY vp.created_at DESC LIMIT 400`;

    // Filas de antes del split (sin grupo_id) quedan cada una como su propio
    // pedido de un solo envío — se agrupan por su propio id para no mezclarlas.
    const grupos = new Map();
    rows.forEach(o => {
      const key = o.grupo_id || ('legacy_' + o.id);
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key).push(o);
    });

    const pedidos = [...grupos.values()].map(envios => {
      envios.sort((a, b) => (a.proveedor_nombre || '').localeCompare(b.proveedor_nombre || ''));
      const primero = envios[0];
      const total = envios.reduce((s, o) => s + parseFloat(o.total || 0), 0);
      // Comisión ganada — solo cuenta lo que efectivamente se envió (no lo
      // que quedó en error/cancelado, aunque el pedido haya tenido otros
      // envíos que sí salieron bien).
      const comision = envios.filter(o => o.estado === 'enviada').reduce((s, o) => s + parseFloat(o.comision || 0), 0);
      const estadoGeneral = pedidoEstadoGeneral(envios);
      // orden_secuencia puede faltar en filas viejas (previas a este cambio) — se usa el id como respaldo.
      const numero = numeroVenta(req.vendedora.codigo, primero.orden_secuencia || primero.id);
      const envioAObjeto = o => ({
        proveedor: o.proveedor_nombre || 'Temponovo',
        estado: o.estado,
        nota: o.estado === 'error' ? '⚠ Estamos terminando de procesar esta venta.'
          : o.estado === 'cancelada' ? '✕ Esta venta fue cancelada.' : (o.nota || ''),
        seguimiento: o.seguimiento || 'recibido',
        seguimientoLabel: SEGUIMIENTO_LABEL[o.seguimiento] || SEGUIMIENTO_LABEL.recibido,
        seguimientoPaso: Math.max(0, SEGUIMIENTO_ORDEN.indexOf(o.seguimiento || 'recibido')),
        seguimientoAt: o.seguimiento_at,
        lineas: (o.productos || []).map(p => ({ sku: p.sku, categoria: p.categoria || '', cantidad: p.quantity, total: parseFloat(p.total || 0) }))
      });
      const primerEnvio = envioAObjeto(primero);
      return {
        id: primero.grupo_id || primero.id,
        nombre: numero,
        fecha: primero.created_at,
        total, neto: total, comision,
        entrega: primero.entrega || 'despacho',
        ref: primero.nombre_venta || '',
        // compat: mismos campos de siempre, a nivel superior (del primer/único envío)
        estado: estadoGeneral,
        nota: primerEnvio.nota,
        seguimiento: primerEnvio.seguimiento,
        seguimientoLabel: primerEnvio.seguimientoLabel,
        seguimientoPaso: primerEnvio.seguimientoPaso,
        seguimientoAt: primerEnvio.seguimientoAt,
        lineas: envios.flatMap(o => envioAObjeto(o).lineas),
        // nuevo: el detalle por proveedor, para cuando el pedido se separó en más de uno
        envios: envios.map(envioAObjeto)
      };
    });
    pedidos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    res.json(pedidos.slice(0, 200));
  } catch (e) { console.error('❌ /api/pedidos', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// ── CONFIG DE LA VENDEDORA (persistente, multi-dispositivo) ─────
app.get('/api/config', requireClient, async (req, res) => {
  try { res.json(await readCfgDb(req.vendedora, req.partnerId)); }
  catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.post('/api/config', requireClient, async (req, res) => {
  try {
    const cfg = req.body?.data || {};
    if (JSON.stringify(cfg).length > 300000) return res.status(413).json({ error: 'Configuración demasiado grande (logo muy pesado)' });
    await writeCfgDb(req.vendedora, cfg);
    // Limpia el caché de su vitrina pública (las dos variantes: completa y
    // solo-favoritos) — si no, un cambio recién guardado (ej. marcar un
    // favorito para compartirlo al toque) tarda hasta 10 min en verse.
    const slug = slugOf(req.vendedora.codigo);
    delete cache['pub_' + slug]; delete cache['pub_' + slug + '_fav'];
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── VITRINA PÚBLICA (link compartible, solo lectura) ─────────────
app.get('/api/public/:slug/config', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Vitrina no encontrada' });
    const cfg = await readCfgDb({ id: c.id, codigo: c.code }, c.partnerId);
    const { nombre, slogan, logo, hdr, fondo, f1, f2, radius, welcome, tags, tagMap } = cfg;
    res.json({ nombre: nombre || c.name, slogan, logo, hdr, fondo, f1, f2, radius, welcome, tags, tagMap });
  } catch (e) { console.error('❌ /api/public/config', e.message); res.status(500).json({ error: 'No se pudo cargar la vitrina' }); }
});

app.get('/api/public/:slug/productos', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Vitrina no encontrada' });
    const soloFavoritos = req.query.favoritos === '1';
    const cacheKey = 'pub_' + req.params.slug + (soloFavoritos ? '_fav' : '');
    const hit = cacheGet(cacheKey); if (hit) return res.json(hit);
    const cfg = await readCfgDb({ id: c.id, codigo: c.code }, c.partnerId);
    const hFams = new Set(cfg.hiddenFams || []);
    const hSkus = new Set((cfg.hiddenSkus || []).map(x => x.toUpperCase()));
    // Favoritos: selección personal de la vendedora (misma config que logo/
    // colores) — el link "compartir favoritos" es esta misma vitrina
    // pública con ?favoritos=1, filtrada a solo esos productos.
    const favoritos = new Set(cfg.favoritos || []);
    let prods = await catalogoConPrecioGlobal(true);
    if ((c.categorias || []).length) prods = prods.filter(p => c.categorias.includes(famOf(p)));
    let result = prods
      .filter(p => p.stock > 0)
      .filter(p => !hFams.has(famOf(p)))
      .filter(p => !hSkus.has((p.sku || '').toUpperCase()))
      .map(p => ({
        id: p.id, proveedorId: p.proveedorId, sku: p.sku, nombre: p.nombre, descripcion: p.descripcion,
        categoria: p.categoria, atributos: p.atributos, metal: p.metal || '', piedra: p.piedra || '', medida: p.medida || '', info: p.info || [],
        precioVenta: p.precioVenta
      }));
    if (soloFavoritos) result = result.filter(p => favoritos.has(p.proveedorId + '::' + p.sku));
    cacheSet(cacheKey, result, VENDEDORA_TTL_MS);
    res.json(result);
  } catch (e) { console.error('❌ /api/public/productos', e.message); res.status(500).json({ error: 'No se pudo cargar el catálogo' }); }
});

// Un producto puntual, para el link "compartir este producto" (botón en la
// ficha). A propósito NO aplica los mismos filtros que el catálogo general
// (stock>0, ocultos, categorías de la vendedora) — si la vendedora decidió
// compartir ESTE producto, tiene que abrir sí o sí, así se haya quedado sin
// stock justo en ese momento o esté oculto del catálogo general.
app.get('/api/public/:slug/producto/:proveedorId/:id', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Vitrina no encontrada' });
    const proveedorId = parseInt(req.params.proveedorId);
    const id = parseInt(req.params.id);
    if (!proveedorId || !id) return res.status(400).json({ error: 'Producto inválido' });
    // Bypasea stock/ocultos-de-la-vendedora a propósito (ver comentario
    // arriba) — pero SÍ respeta "no disponible" del catálogo global: si el
    // admin lo retiró de la venta, el link compartido tampoco debe abrirlo.
    const prods = await catalogoConPrecioGlobal(true);
    const p = prods.find(x => x.proveedorId === proveedorId && x.id === id);
    if (!p) return res.status(404).json({ error: 'Este producto ya no está disponible' });
    res.json({
      id: p.id, proveedorId: p.proveedorId, sku: p.sku, nombre: p.nombre, descripcion: p.descripcion,
      categoria: p.categoria, atributos: p.atributos, metal: p.metal || '', piedra: p.piedra || '', medida: p.medida || '', info: p.info || [],
      stock: p.stock,
      precioVenta: p.precioVenta
    });
  } catch (e) { console.error('❌ /api/public/producto', e.message); res.status(500).json({ error: 'No se pudo cargar el producto' }); }
});

// Fotos adicionales de un producto puntual — perezoso, se llama solo al
// abrir su ficha (ver fetchImagenesExtra).
app.get('/api/productos/:proveedorId/:id/imagenes', async (req, res) => {
  try {
    const { v, error } = await authenticateVendedora(req);
    if (error) return res.status(401).json({ error });
    const proveedorId = parseInt(req.params.proveedorId);
    const id = parseInt(req.params.id);
    if (!proveedorId || !id) return res.status(400).json({ error: 'ID inválido' });
    const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
    if (!proveedor) return res.json({ imagenes: [] });
    res.json({ imagenes: await fetchImagenesExtra(proveedor, id) });
  } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las fotos' }); }
});

app.get('/api/public/:slug/productos/:proveedorId/:id/imagenes', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Vitrina no encontrada' });
    const proveedorId = parseInt(req.params.proveedorId);
    const id = parseInt(req.params.id);
    if (!proveedorId || !id) return res.status(400).json({ error: 'ID inválido' });
    const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
    if (!proveedor) return res.json({ imagenes: [] });
    res.json({ imagenes: await fetchImagenesExtra(proveedor, id) });
  } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las fotos' }); }
});

app.get('/api/public/:slug/imagen/:proveedorId/:id', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).send('No encontrada');
    const proveedorId = parseInt(req.params.proveedorId);
    const id = parseInt(req.params.id);
    if (!proveedorId || !id) return res.status(400).send('ID inválido');
    const field = req.query.s === 'g' ? 'image_1024' : 'image_256';
    const key = 'img_' + proveedorId + '_' + field + '_' + id;
    let b64 = cacheGet(key);
    if (!b64) {
      try {
        const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
        if (proveedor && proveedor.tipo === 'odoo') {
          const conn = connFor(proveedor);
          const prods = await xmlrpcCallFor(conn, 'prov_' + proveedorId, 'product.product', 'read', [[id], [field]]);
          b64 = prods && prods[0] ? prods[0][field] : null;
          if (b64) cacheSet(key, b64, 2 * 60 * 60 * 1000);
        }
      } catch (e) { console.warn('⚠ /api/public/imagen ' + proveedorId + '/' + id + ':', e.message); }
    }
    if (!b64) return res.status(404).send('Sin imagen');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400');
    res.send(Buffer.from(b64, 'base64'));
  } catch (e) { console.error('❌ /api/public/imagen', e.message); res.status(500).send('No se pudo cargar la imagen'); }
});

app.get('/api/public/:slug/imagen-extra/:proveedorId/:imgId', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).send('No encontrada');
    const proveedorId = parseInt(req.params.proveedorId);
    const imgId = parseInt(req.params.imgId);
    if (!proveedorId || !imgId) return res.status(400).send('ID inválido');
    const field = req.query.s === 'g' ? 'image_1024' : 'image_256';
    const key = 'imgx_' + proveedorId + '_' + field + '_' + imgId;
    let b64 = cacheGet(key);
    if (!b64) {
      try {
        const proveedor = await getProveedorActivo(proveedorId).catch(() => null);
        if (proveedor && proveedor.tipo === 'odoo') {
          const conn = connFor(proveedor);
          const imgs = await xmlrpcCallFor(conn, 'prov_' + proveedorId, 'product.image', 'read', [[imgId], [field]]);
          b64 = imgs && imgs[0] ? imgs[0][field] : null;
          if (b64) cacheSet(key, b64, 2 * 60 * 60 * 1000);
        }
      } catch (e) { console.warn('⚠ imagen-extra ' + proveedorId + '/' + imgId + ':', e.message); }
    }
    if (!b64) return res.status(404).send('Sin imagen');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400');
    res.send(Buffer.from(b64, 'base64'));
  } catch (e) { console.error('❌ /api/public/imagen-extra', e.message); res.status(500).send('No se pudo cargar la imagen'); }
});

// ════════════════════════════════════════════════════════════════
// ACADEMIA — la vendedora ve los cursos publicados y sus lecciones
// (solo lectura). El contenido lo crea el admin.
// ════════════════════════════════════════════════════════════════
app.get('/api/academia', requireClient, async (_req, res) => {
  try {
    const { rows: cursos } = await sql`
      SELECT id, titulo, descripcion, categoria, portada, orden
      FROM academia_cursos WHERE publicado = true
      ORDER BY categoria, orden, id`;
    if (!cursos.length) return res.json([]);
    const ids = cursos.map(c => c.id);
    const { rows: lecciones } = await sql`
      SELECT id, curso_id, titulo, tipo, video_url, cuerpo, imagen, sku_ref, orden
      FROM academia_lecciones WHERE curso_id = ANY(${ids})
      ORDER BY orden, id`;
    const byCurso = {};
    lecciones.forEach(l => {
      (byCurso[l.curso_id] = byCurso[l.curso_id] || []).push({
        id: l.id, titulo: l.titulo, tipo: l.tipo,
        videoUrl: l.tipo === 'video' ? embedVideoUrl(l.video_url) : '',
        cuerpo: l.cuerpo || '', imagen: l.imagen || '', skuRef: l.sku_ref || ''
      });
    });
    res.json(cursos.map(c => ({
      id: c.id, titulo: c.titulo, descripcion: c.descripcion,
      categoria: c.categoria, portada: c.portada,
      lecciones: byCurso[c.id] || []
    })));
  } catch (e) { console.error('❌ /api/academia', e.message); res.status(500).json({ error: shortErr(e) }); }
});

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
const mailer = (nodemailer && process.env.SMTP_HOST) ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: (process.env.SMTP_PORT || '587') === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

const contactHits = {};
app.post('/api/contacto', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    contactHits[ip] = (contactHits[ip] || []).filter(t => now - t < 3600000);
    if (contactHits[ip].length >= 5) return res.status(429).json({ error: 'Demasiados envíos, intenta más tarde' });

    const { nombre, telefono, email, ciudad, mensaje, web } = req.body?.data || {};
    if (web) return res.json({ ok: true });
    if (!nombre || !telefono) return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    contactHits[ip].push(now);

    const texto = [
      'Nueva solicitud desde la Vitrina — ¿Quieres vender con nosotros?', '',
      'Nombre:   ' + nombre, 'WhatsApp: ' + telefono, 'Email:    ' + (email || '—'), 'Ciudad:   ' + (ciudad || '—'),
      '', 'Mensaje:', mensaje || '—'
    ].join('\n');

    if (!mailer || !CONTACT_EMAIL) {
      console.warn('⚠ SMTP no configurado. Contacto recibido:', texto);
      return res.json({ ok: true, fallback: true });
    }
    await mailer.sendMail({
      from: `"Vitrina" <${process.env.SMTP_USER}>`, to: CONTACT_EMAIL, replyTo: email || undefined,
      subject: '✨ Nueva vendedora interesada: ' + nombre, text: texto
    });
    res.json({ ok: true });
  } catch (e) { console.error('❌ /api/contacto', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// ── PERFIL ─────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  try {
    const { v, error } = await authenticateVendedora(req);
    if (error) return res.status(401).json({ error });
    res.json({
      name: v.nombre, comision: parseFloat(v.comision) || 0,
      sucursales: v.sucursales || [], publicSlug: slugOf(v.codigo), imgToken: imgToken(v)
    });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD || !ADMIN_SECRET) {
    return res.status(500).json({ error: 'Falta ADMIN_PASSWORD y/o ADMIN_SECRET en las variables de entorno del servidor' });
  }
  const key = 'admin:' + clientIp(req);
  if (isBlocked(key, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.' });
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    registerFailure(key, 15 * 60 * 1000);
    return res.status(401).json({ error: 'Clave incorrecta' });
  }
  res.json({ token: makeAdminToken() });
});

app.get('/api/admin/categorias', requireAdmin, async (req, res) => {
  try {
    const prods = await productosClienteMulti();
    res.json([...new Set(prods.map(p => famOf(p)))].sort());
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── Configuración de la empresa (una sola, global) ──
app.get('/api/admin/config', requireAdmin, async (_req, res) => {
  try { res.json(await getConfig()); }
  catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.put('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const { nombre, partnerId } = req.body || {};
    if (!nombre || !partnerId) return res.status(400).json({ error: 'Nombre y Partner ID son obligatorios' });
    const { rows } = await sql`
      UPDATE configuracion SET nombre = ${nombre}, partner_id = ${partnerId}, updated_at = now()
      WHERE id = 1 RETURNING *`;
    Object.keys(cache).filter(k => k.startsWith('cat_') || k.startsWith('pub_') || k.startsWith('pl_')).forEach(k => delete cache[k]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── Vendedoras ──
app.get('/api/admin/vendedoras', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await sql`SELECT id, codigo, nombre, email, rut, categorias, sucursales, activo, created_at FROM vendedoras ORDER BY nombre`;
    res.json(rows); // nunca se devuelve clave_hash
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const { rows: catRows } = await sql`SELECT COUNT(DISTINCT familia) as total FROM categoria_multiplicador`;
    const { rows: prodRows } = await sql`SELECT COUNT(*) as total FROM catalogo_productos`;
    const { rows: margenRows } = await sql`SELECT COALESCE(AVG((precio_pvp - costo) / NULLIF(costo, 0) * 100), 0) as promedio FROM catalogo_productos WHERE costo IS NOT NULL AND precio_pvp IS NOT NULL AND costo > 0`;
    const margenVal = margenRows[0]?.promedio;
    res.json({
      categorias_totales: parseInt(catRows[0]?.total || 0),
      productos_totales: parseInt(prodRows[0]?.total || 0),
      margen_promedio: margenVal ? parseFloat(String(margenVal)) : 0
    });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
// Logo de cada vendedora (vive en su config visual, guardada en Postgres) —
// para mostrarlo como miniatura en la lista de Admin. { CODIGO: dataURL|url }
app.get('/api/admin/vendedoras/logos', requireAdmin, async (_req, res) => {
  try {
    const cfg0 = await getConfig();
    const { rows } = await sql`SELECT id, codigo FROM vendedoras WHERE activo = true`;
    const out = {};
    await Promise.all(rows.map(async r => {
      try { const cfg = await readCfgDb(r, cfg0.partner_id); if (cfg.logo) out[r.codigo] = cfg.logo; }
      catch (e) { console.warn('⚠ logo de ' + r.codigo + ':', e.message); }
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.post('/api/admin/vendedoras', requireAdmin, async (req, res) => {
  try {
    const { codigo, clave, nombre, email, rut, categorias, sucursales } = req.body || {};
    if (!codigo || !clave || !nombre) return res.status(400).json({ error: 'Código, clave y nombre son obligatorios' });
    const hash = hashPassword(clave);
    const { rows } = await sql`
      INSERT INTO vendedoras (codigo, clave_hash, nombre, email, rut, categorias, sucursales)
      VALUES (${String(codigo).toUpperCase()}, ${hash}, ${nombre}, ${email || ''}, ${rut || ''},
              ${JSON.stringify(categorias || [])}, ${JSON.stringify(sucursales || [])})
      RETURNING id, codigo, nombre, email, rut, categorias, sucursales, activo, created_at`;
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message || '').includes('duplicate key')) return res.status(409).json({ error: 'Ese código de usuario ya existe' });
    res.status(500).json({ error: shortErr(e) });
  }
});
app.put('/api/admin/vendedoras/:id', requireAdmin, async (req, res) => {
  try {
    const { nombre, clave, email, rut, categorias, sucursales, activo } = req.body || {};
    const claveHash = clave ? hashPassword(clave) : null;
    const { rows } = await sql`
      UPDATE vendedoras SET
        nombre = COALESCE(${nombre}, nombre),
        clave_hash = COALESCE(${claveHash}, clave_hash),
        email = COALESCE(${email}, email),
        rut = COALESCE(${rut}, rut),
        categorias = COALESCE(${categorias ? JSON.stringify(categorias) : null}, categorias),
        sucursales = COALESCE(${sucursales ? JSON.stringify(sucursales) : null}, sucursales),
        activo = COALESCE(${activo}, activo)
      WHERE id = ${req.params.id}
      RETURNING id, codigo, nombre, email, rut, categorias, sucursales, activo, created_at`;
    if (!rows.length) return res.status(404).json({ error: 'Vendedora no encontrada' });
    delete cache['cat_' + rows[0].codigo];
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.delete('/api/admin/vendedoras/:id', requireAdmin, async (req, res) => {
  try { await sql`DELETE FROM vendedoras WHERE id = ${req.params.id}`; res.json({ ok: true }); }
  catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'Esta vendedora tiene ventas registradas y no se puede eliminar. Desactívala en su lugar (el interruptor de Estado).' });
    res.status(500).json({ error: shortErr(e) });
  }
});

// ════════════════════════════════════════════════════════════════
// PROVEEDORES (fase 2 del portal multi-proveedor)
// ════════════════════════════════════════════════════════════════
// Fase 2 es solo el CRUD: alta/edición/borrado de proveedores y probar que
// sus credenciales de Odoo funcionan. Todavía NO se usa esto para el
// catálogo ni para armar ventas (eso es una fase siguiente) — un proveedor
// nuevo que se agregue acá no aparece todavía en la vitrina de nadie.
function proveedorPublico(p) {
  return {
    id: p.id, codigo: p.codigo, nombre: p.nombre, tipo: p.tipo, activo: p.activo,
    partnerId: p.partner_id, odooUrl: p.odoo_url, odooDb: p.odoo_db, odooUser: p.odoo_user,
    odooPasswordSet: !!p.odoo_password_enc,
    ventaApiUrl: p.venta_api_url, ventaApiKeySet: !!p.venta_api_key_enc, ventaVendorEmail: p.venta_vendor_email,
    ventaAbiertaNombre: p.venta_abierta_nombre, categoriasFiltro: p.categorias_filtro || [], orden: p.orden
  };
  // nunca se incluyen odoo_password_enc / venta_api_key_enc, ni descifrados
}
app.get('/api/admin/proveedores', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM proveedores ORDER BY orden, id`;
    res.json(rows.map(proveedorPublico));
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.post('/api/admin/proveedores', requireAdmin, async (req, res) => {
  try {
    const { codigo, nombre, tipo, partnerId, odooUrl, odooDb, odooUser, odooPassword,
      ventaApiUrl, ventaApiKey, ventaVendorEmail, categoriasFiltro } = req.body || {};
    if (!codigo || !nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
    const t = tipo === 'manual' ? 'manual' : 'odoo';
    const { rows } = await sql`
      INSERT INTO proveedores
        (codigo, nombre, tipo, partner_id, odoo_url, odoo_db, odoo_user, odoo_password_enc,
         venta_api_url, venta_api_key_enc, venta_vendor_email, categorias_filtro)
      VALUES (${String(codigo).toLowerCase().trim()}, ${nombre}, ${t}, ${partnerId || null},
        ${odooUrl || null}, ${odooDb || null}, ${odooUser || null}, ${odooPassword ? encryptCred(odooPassword) : null},
        ${ventaApiUrl || null}, ${ventaApiKey ? encryptCred(ventaApiKey) : null}, ${ventaVendorEmail || null},
        ${JSON.stringify(categoriasFiltro || [])})
      RETURNING *`;
    res.json(proveedorPublico(rows[0]));
  } catch (e) {
    if (String(e.message || '').includes('duplicate key')) return res.status(409).json({ error: 'Ese código de proveedor ya existe' });
    res.status(500).json({ error: shortErr(e) });
  }
});
app.put('/api/admin/proveedores/:id', requireAdmin, async (req, res) => {
  try {
    const { nombre, tipo, activo, partnerId, odooUrl, odooDb, odooUser, odooPassword,
      ventaApiUrl, ventaApiKey, ventaVendorEmail, categoriasFiltro, orden } = req.body || {};
    const t = tipo && ['odoo', 'manual'].includes(tipo) ? tipo : null;
    const { rows } = await sql`
      UPDATE proveedores SET
        nombre = COALESCE(${nombre}, nombre),
        tipo = COALESCE(${t}, tipo),
        activo = COALESCE(${activo}, activo),
        partner_id = COALESCE(${partnerId}, partner_id),
        odoo_url = COALESCE(${odooUrl}, odoo_url),
        odoo_db = COALESCE(${odooDb}, odoo_db),
        odoo_user = COALESCE(${odooUser}, odoo_user),
        odoo_password_enc = COALESCE(${odooPassword ? encryptCred(odooPassword) : null}, odoo_password_enc),
        venta_api_url = COALESCE(${ventaApiUrl}, venta_api_url),
        venta_api_key_enc = COALESCE(${ventaApiKey ? encryptCred(ventaApiKey) : null}, venta_api_key_enc),
        venta_vendor_email = COALESCE(${ventaVendorEmail}, venta_vendor_email),
        categorias_filtro = COALESCE(${categoriasFiltro ? JSON.stringify(categoriasFiltro) : null}, categorias_filtro),
        orden = COALESCE(${orden}, orden),
        updated_at = now()
      WHERE id = ${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(proveedorPublico(rows[0]));
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.delete('/api/admin/proveedores/:id', requireAdmin, async (req, res) => {
  try { await sql`DELETE FROM proveedores WHERE id = ${req.params.id}`; res.json({ ok: true }); }
  catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'Este proveedor tiene ventas registradas y no se puede eliminar. Desactívalo en su lugar.' });
    res.status(500).json({ error: shortErr(e) });
  }
});
// Prueba las credenciales de Odoo de un proveedor con una llamada aislada
// (no toca getUID/xmlrpcCall globales, que hasta la fase siguiente siguen
// siendo solo para el Odoo de Temponovo).
app.post('/api/admin/proveedores/:id/probar', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM proveedores WHERE id = ${req.params.id}`;
    const p = rows[0]; if (!p) return res.status(404).json({ error: 'Proveedor no encontrado' });
    if (p.tipo !== 'odoo') return res.status(400).json({ error: 'Este proveedor no usa Odoo, no hay conexión que probar' });
    if (!p.odoo_url || !p.odoo_db || !p.odoo_user || !p.odoo_password_enc) {
      return res.status(400).json({ error: 'Falta completar URL, base de datos, usuario o clave de Odoo' });
    }
    let password;
    try { password = decryptCred(p.odoo_password_enc); } catch (e) { return res.status(500).json({ error: e.message }); }
    const client = xmlrpc.createSecureClient({ host: new URL(p.odoo_url).hostname, port: 443, path: '/xmlrpc/2/common' });
    const uid = await new Promise((resolve, reject) => {
      client.methodCall('authenticate', [p.odoo_db, p.odoo_user, password, {}], (err, uid) => err ? reject(err) : resolve(uid));
    });
    // OJO: nunca devolver 401 acá — el frontend interpreta CUALQUIER 401 como
    // que la sesión de admin expiró y desloguea, tapando el error real.
    if (!uid) return res.status(400).json({ error: 'Odoo rechazó las credenciales (usuario, clave o base de datos incorrectos)' });
    res.json({ ok: true, uid });
  } catch (e) { res.status(502).json({ error: 'No se pudo conectar: ' + shortErr(e) }); }
});

// LEGACY: la "venta abierta" única en "configuracion" ya no la usa ningún
// flujo real desde el split por proveedor (cada proveedor tiene la suya en
// "proveedores" — ver el endpoint de abajo). Se deja para no romper la
// pestaña Configuración vieja, pero no hace nada útil hoy.
app.post('/api/admin/cerrar-venta', requireAdmin, async (_req, res) => {
  try {
    await sql`UPDATE configuracion SET venta_abierta_id = NULL, venta_abierta_nombre = NULL WHERE id = 1`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
// La "venta abierta" de UN proveedor es compartida por todas las vendedoras
// que le venden (todas facturan al mismo partner de ese proveedor).
// Cerrarla a mano fuerza que el próximo pedido de cualquier vendedora abra
// una venta nueva en ese proveedor.
app.post('/api/admin/proveedores/:id/cerrar-venta', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`UPDATE proveedores SET venta_abierta_id = NULL, venta_abierta_nombre = NULL WHERE id = ${req.params.id} RETURNING id`;
    if (!rows.length) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── LISTA DE PRECIOS GLOBAL (Admin → Productos) ───────────────────
// Reemplaza el "precios fijos por vendedora" de arriba — un solo precio de
// venta para cualquier cliente de cualquier vendedora (ver
// catalogoConPrecioGlobal). "Variantes" cuenta cuántos SKU comparten mismo
// proveedor+nombre (mismo diseño, ej. distintas tallas de un anillo).
// Descarga optimizada para Excel: obtiene catálogo con timeout corto
// Forzar recarga completa del catálogo (limpiar todas las cachés)
app.post('/api/admin/catalogo/forzar-recarga', requireAdmin, async (_req, res) => {
  try {
    limpiarCacheCatalogoPrecios();
    Object.keys(cache).filter(k => k.startsWith('productos_')).forEach(k => delete cache[k]);
    res.json({ ok: true, mensaje: 'Catálogo recargado, caché limpiado' });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// Descargar catálogo como Excel
app.get('/api/admin/catalogo/excel-descargar', requireAdmin, async (_req, res) => {
  try {
    // Crear tabla si no existe
    await sql`CREATE TABLE IF NOT EXISTS catalogo_productos (
      sku TEXT PRIMARY KEY,
      precio NUMERIC,
      disponible BOOLEAN NOT NULL DEFAULT true,
      costo NUMERIC DEFAULT NULL,
      precio_pvp NUMERIC DEFAULT NULL,
      iva_porcentaje NUMERIC DEFAULT 19,
      comision_vendedora_override NUMERIC DEFAULT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;

    // Obtener productos de Odoo (sin calcular precio)
    // Mismo método que la vitrina: sin timeout, que tarde lo que sea necesario
    let prods = [];
    let fuente = 'desconocido';
    try {
      const startTime = Date.now();
      console.log('📥 Iniciando descarga de catálogo desde Odoo...');
      prods = await productosClienteMulti();
      const elapsed = Date.now() - startTime;
      if (prods && prods.length > 0) {
        fuente = 'odoo (' + prods.length + ' productos en ' + Math.round(elapsed/1000) + 's)';
        console.log('✅ Catálogo de Odoo completado:', prods.length, 'productos en', (elapsed/1000).toFixed(1), 'segundos');
      } else {
        console.warn('⚠ productosClienteMulti devolvió lista vacía, usando BD local');
        const { rows: local } = await sql`SELECT * FROM catalogo_productos ORDER BY sku`;
        prods = local.map(r => ({ sku: r.sku, precio: 0, barcode: '' }));
        fuente = 'bd local (' + prods.length + ' productos)';
        console.warn('⚠ Usando', prods.length, 'productos de BD local como fallback');
      }
    } catch (e) {
      console.error('❌ Error trayendo catálogo de Odoo:', e.message);
      const { rows: local } = await sql`SELECT * FROM catalogo_productos ORDER BY sku`;
      prods = local.map(r => ({ sku: r.sku, precio: 0, barcode: '' }));
      fuente = 'bd local (fallback por error: ' + e.message + ') (' + prods.length + ' productos)';
      console.warn('⚠ Fallback a BD local:', prods.length, 'productos, error:', e.message);
    }

    // Obtén multiplicadores por categoría
    const { rows: multMap } = await sql`SELECT familia, multiplicador FROM categoria_multiplicador`;
    const multByFamilia = {};
    multMap.forEach(m => { multByFamilia[m.familia] = m.multiplicador || 2; });

    // Obtén datos guardados en BD (costo, PVP, IVA, comisión)
    const { rows: catalogoBd } = await sql`
      SELECT sku, costo, precio_pvp, iva_porcentaje, comision_vendedora_override, disponible
      FROM catalogo_productos
    `;
    const porSku = {};
    catalogoBd.forEach(p => { porSku[p.sku.toUpperCase()] = p; });

    // Construir Excel
    const excel = (prods || []).map(p => {
      const bdData = porSku[p.sku.toUpperCase()];
      const familia = famOf(p);
      const multiplicador = multByFamilia[familia] || 2;

      // Costo es el precio de Odoo (asumiendo que incluye IVA)
      const costoConIva = p.precio || 0;
      const iva = bdData?.iva_porcentaje || 19;

      // Costo sin IVA
      const costo = costoConIva > 0 ? Math.round((costoConIva / (1 + iva / 100)) * 100) / 100 : 0;

      // PVP sugerido = (costo sin IVA) * multiplicador (default 2)
      const pvpSugerido = costo > 0 ? Math.round(costo * multiplicador) : 0;
      const pvp = bdData?.precio_pvp || pvpSugerido; // Si ya está grabado, usa ese

      // Margen bruto (en pesos, no porcentaje)
      const margenBruto = pvp > 0 ? pvp - costo : 0;

      // Rangos
      const comisionMinima = margenBruto > 0 ? 5 : 0;
      const comisionMaxima = margenBruto > 0 ? 50 : 0;

      return {
        'Categoría': familia || '',
        'Código de barra': p.barcode || '',
        'Código': p.sku || '',
        'Costo': costo > 0 ? Math.round(costo * 100) / 100 : '',
        'Precio PVP': pvp > 0 ? Math.round(pvp * 100) / 100 : '',
        'IVA %': iva,
        'Disponible': bdData?.disponible !== false ? 'Sí' : 'No',
        'Margen Bruto $': margenBruto > 0 ? Math.round(margenBruto * 100) / 100 : '',
        'Comisión mín. %': comisionMinima,
        'Comisión máx. %': comisionMaxima,
        'Comisión % (editable)': bdData?.comision_vendedora_override || ''
      };
    });

    res.json(excel);
  } catch (e) {
    console.error('❌ /catalogo/excel-descargar FATAL:', e.message);
    res.json([]); // Devolver array vacío, no 504
  }
});
// GET /api/admin/catalogo — catálogo con todos los campos
app.get('/api/admin/catalogo', requireAdmin, async (_req, res) => {
  try {
    const prods = await catalogoConPrecioGlobal(false);
    // Obtén los nuevos campos (Fase 2) en un solo lookup
    const { rows: catalogoBd } = await sql`SELECT sku, costo, precio_pvp, iva_porcentaje, comision_vendedora_override FROM catalogo_productos`;
    const porSku = {};
    catalogoBd.forEach(p => { porSku[p.sku] = p; });
    const porGrupo = {};
    prods.forEach(p => { const k = p.proveedorId + '::' + p.nombre; porGrupo[k] = (porGrupo[k] || 0) + 1; });
    res.json(prods.map(p => {
      const bdData = porSku[p.sku.toUpperCase()];
      const margenBruto = bdData && bdData.precio_pvp ? (bdData.precio_pvp / (1 + (bdData.iva_porcentaje || 19) / 100)) - bdData.costo : null;
      const margenBrutoPct = margenBruto && bdData?.precio_pvp ? Math.round(margenBruto / (bdData.precio_pvp / (1 + (bdData.iva_porcentaje || 19) / 100)) * 10000) / 100 : null;
      return {
        proveedorId: p.proveedorId, proveedor: p.proveedorCodigo, sku: p.sku, nombre: p.nombre,
        categoria: famOf(p), stock: p.stock, disponible: p.disponible,
        precioFijo: p.precioFijo, precioVenta: p.precioVenta,
        // Fase 2: nuevos campos
        costo: bdData?.costo, precio_pvp: bdData?.precio_pvp, iva_porcentaje: bdData?.iva_porcentaje || 19,
        comision_vendedora_override: bdData?.comision_vendedora_override,
        margenBruto, margenBrutoPct,
        variantes: porGrupo[p.proveedorId + '::' + p.nombre]
      };
    }));
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.put('/api/admin/catalogo/:sku', requireAdmin, async (req, res) => {
  try {
    const sku = String(req.params.sku || '').trim().toUpperCase();
    if (!sku) return res.status(400).json({ error: 'SKU inválido' });
    const precioNum = req.body?.precio != null && req.body.precio !== '' ? parseFloat(req.body.precio) : null;
    const disponible = req.body?.disponible !== false;
    // Fase 2: nuevos campos
    const costo = req.body?.costo != null && req.body.costo !== '' ? parseFloat(req.body.costo) : null;
    const precio_pvp = req.body?.precio_pvp != null && req.body.precio_pvp !== '' ? parseFloat(req.body.precio_pvp) : null;
    const iva_porcentaje = req.body?.iva_porcentaje != null ? parseFloat(req.body.iva_porcentaje) : 19;
    const comision_vendedora_override = req.body?.comision_vendedora_override != null && req.body.comision_vendedora_override !== '' ? parseFloat(req.body.comision_vendedora_override) : null;

    await sql`
      INSERT INTO catalogo_productos (sku, precio, disponible, costo, precio_pvp, iva_porcentaje, comision_vendedora_override, updated_at)
      VALUES (${sku}, ${precioNum > 0 ? precioNum : null}, ${disponible}, ${costo}, ${precio_pvp}, ${iva_porcentaje}, ${comision_vendedora_override}, now())
      ON CONFLICT (sku) DO UPDATE SET
        precio = ${precioNum > 0 ? precioNum : null},
        disponible = ${disponible},
        costo = ${costo},
        precio_pvp = ${precio_pvp},
        iva_porcentaje = ${iva_porcentaje},
        comision_vendedora_override = ${comision_vendedora_override},
        updated_at = now()`;
    limpiarCacheCatalogoPrecios();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
// Carga masiva por Excel — mismo patrón que producto-info: se parsea en el
// navegador con la librería XLSX y se manda como JSON (no hay parser de
// .xlsx en el servidor).
app.post('/api/admin/catalogo/excel', requireAdmin, async (req, res) => {
  try {
    const { filas } = req.body?.data || {};
    if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: 'No hay filas para cargar' });
    const limpias = filas
      .map(f => ({
        sku: String(f?.sku || '').trim().toUpperCase(),
        precio: parseFloat(f?.precio),
        disponible: f?.disponible !== false,
        // Fase 2: nuevos campos
        costo: f?.costo != null ? parseFloat(f.costo) : null,
        precio_pvp: f?.precio_pvp != null ? parseFloat(f.precio_pvp) : null,
        iva_porcentaje: f?.iva_porcentaje != null ? parseFloat(f.iva_porcentaje) : 19,
        comision_vendedora_override: f?.comision_vendedora_override != null ? parseFloat(f.comision_vendedora_override) : null
      }))
      .filter(f => f.sku);
    if (!limpias.length) return res.status(400).json({ error: 'Ninguna fila tenía un código de producto reconocible' });
    // Optimización: batch insert/update en una sola query (UNNEST) en vez de loop
    const skus = limpias.map(f => f.sku);
    const precios = limpias.map(f => f.precio > 0 ? f.precio : null);
    const disponibles = limpias.map(f => f.disponible);
    const costos = limpias.map(f => f.costo);
    const precios_pvp = limpias.map(f => f.precio_pvp);
    const ivas = limpias.map(f => f.iva_porcentaje);
    const comisiones = limpias.map(f => f.comision_vendedora_override);
    await sql`
      INSERT INTO catalogo_productos AS t (sku, precio, disponible, costo, precio_pvp, iva_porcentaje, comision_vendedora_override, updated_at)
      SELECT * FROM UNNEST(${skus}::text[], ${precios}::numeric[], ${disponibles}::boolean[], ${costos}::numeric[], ${precios_pvp}::numeric[], ${ivas}::numeric[], ${comisiones}::numeric[]) AS x(sku, precio, disponible, costo, precio_pvp, iva_porcentaje, comision_vendedora_override)
      ON CONFLICT (sku) DO UPDATE SET
        precio = EXCLUDED.precio,
        disponible = EXCLUDED.disponible,
        costo = EXCLUDED.costo,
        precio_pvp = EXCLUDED.precio_pvp,
        iva_porcentaje = EXCLUDED.iva_porcentaje,
        comision_vendedora_override = EXCLUDED.comision_vendedora_override,
        updated_at = now()`;
    limpiarCacheCatalogoPrecios();
    res.json({ ok: true, cargados: limpias.length });
  } catch (e) { console.error('❌ /api/admin/catalogo/excel', e.message); res.status(500).json({ error: shortErr(e) }); }
});
// Multiplicador por categoría — el precio por defecto para lo que no tiene
// precio fijo cargado arriba.
app.get('/api/admin/categorias-multiplicador', requireAdmin, async (_req, res) => {
  try {
    const prods = await productosClienteMulti();
    const familias = [...new Set(prods.map(p => famOf(p)))].sort();
    const { rows } = await sql`SELECT familia, multiplicador FROM categoria_multiplicador`;
    const map = {}; rows.forEach(r => { map[r.familia] = r; });
    res.json(familias.map(f => ({
      familia: f,
      multiplicador: map[f] ? parseFloat(map[f].multiplicador) || MULT_DEFAULT : MULT_DEFAULT
    })));
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.put('/api/admin/categorias-multiplicador/:familia', requireAdmin, async (req, res) => {
  try {
    const familia = decodeURIComponent(req.params.familia);
    const multiplicador = parseFloat(req.body?.multiplicador);
    if (!(multiplicador > 0)) return res.status(400).json({ error: 'Multiplicador inválido' });
    await sql`
      INSERT INTO categoria_multiplicador (familia, multiplicador, updated_at)
      VALUES (${familia}, ${multiplicador}, now())
      ON CONFLICT (familia) DO UPDATE SET
        multiplicador = ${multiplicador},
        updated_at = now()`;
    limpiarCacheCatalogoPrecios();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
// Ícono/nombre a mostrar por categoría — público (sin datos sensibles), lo
// consume tanto la app de la vendedora como la vitrina pública para pintar
// los mismos pills en los dos lados.
app.get('/api/categorias-display', async (_req, res) => {
  try {
    const hit = cacheGet('categorias_display'); if (hit) return res.json(hit);
    const { rows } = await sql`SELECT familia, icono, nombre FROM categoria_multiplicador WHERE icono != '' OR nombre != ''`;
    const map = {};
    rows.forEach(r => { map[r.familia] = { icono: r.icono || '', nombre: r.nombre || '' }; });
    cacheSet('categorias_display', map, 5 * 60 * 1000);
    res.json(map);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── INFO LIBRE DE PRODUCTO (Excel del admin) ─────────────────────
// Limpia el caché para que la ficha muestre lo nuevo de inmediato.
function limpiarCacheProductoInfo() {
  Object.keys(cache).filter(k => k === 'prod_info' || k.startsWith('cat_') || k.startsWith('pub_'))
    .forEach(k => delete cache[k]);
}
// Resumen: cuántos SKU tienen info y qué columnas se han usado.
app.get('/api/admin/producto-info', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await sql`SELECT sku, campos FROM producto_info ORDER BY sku`;
    const columnas = new Set();
    rows.forEach(r => Object.keys(r.campos || {}).forEach(k => columnas.add(k)));
    res.json({ total: rows.length, columnas: [...columnas], skus: rows.map(r => r.sku) });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
// Sube info libre. body.data = { modo: 'sumar'|'reemplazar', filas: [ {sku, barcode, campos:{...}}, ... ] }
// - 'sumar': actualiza/inserta cada SKU que venga (mantiene los demás).
// - 'reemplazar': borra TODO lo anterior y deja solo lo que viene.
// - Cada fila puede traer "sku" (Código de Odoo) o, si no lo tiene a mano,
//   "barcode" (código de barra) — en ese caso se resuelve el SKU real
//   buscando el barcode en el catálogo. Si no matchea con ningún producto,
//   la fila se descarta y se cuenta en "sinMatch".
app.post('/api/admin/producto-info', requireAdmin, async (req, res) => {
  try {
    const { modo, filas } = req.body?.data || {};
    if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: 'No hay filas para cargar' });

    let porBarcode = null;
    async function skuPorBarcode(barcode) {
      if (!porBarcode) {
        porBarcode = {};
        try {
          (await productosClienteMulti()).forEach(p => { if (p.barcode) porBarcode[String(p.barcode).trim()] = (p.sku || '').toUpperCase(); });
        } catch (e) { console.warn('⚠ producto-info: no se pudo leer el catálogo para resolver por barcode', e.message); }
      }
      return porBarcode[String(barcode).trim()] || null;
    }

    const limpias = [];
    let sinMatch = 0;
    for (const f of filas) {
      let sku = String(f?.sku || '').trim().toUpperCase();
      const barcode = String(f?.barcode || '').trim();
      if (!sku && barcode) sku = await skuPorBarcode(barcode) || '';
      if (!sku) { if (barcode) sinMatch++; continue; }
      const campos = {};
      Object.entries(f.campos || {}).forEach(([k, v]) => {
        const key = String(k).trim();
        const val = String(v ?? '').trim();
        if (key && val) campos[key] = val;
      });
      limpias.push({ sku, campos });
    }
    if (!limpias.length) return res.status(400).json({ error: 'Ninguna fila tenía un Código o Código de barra reconocible' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (modo === 'reemplazar') await client.query('DELETE FROM producto_info');
      for (const { sku, campos } of limpias) {
        await client.query(
          `INSERT INTO producto_info (sku, campos, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (sku) DO UPDATE SET campos = $2, updated_at = now()`,
          [sku, JSON.stringify(campos)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally { client.release(); }

    limpiarCacheProductoInfo();
    res.json({ ok: true, cargados: limpias.length, sinMatch, modo: modo === 'reemplazar' ? 'reemplazar' : 'sumar' });
  } catch (e) { console.error('❌ /api/admin/producto-info', e.message); res.status(500).json({ error: shortErr(e) }); }
});
// Borra toda la info libre de producto.
app.delete('/api/admin/producto-info', requireAdmin, async (_req, res) => {
  try {
    await sql`DELETE FROM producto_info`;
    limpiarCacheProductoInfo();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── Ventas + reintentos (la API de Temponovo ya las crea al instante;
//    esto es solo para las que fallaron y quedaron con estado 'error') ──
app.get('/api/admin/ventas', requireAdmin, async (req, res) => {
  try {
    const estado = req.query.estado;
    const fechaDesde = req.query.fecha_desde;
    const fechaHasta = req.query.fecha_hasta;
    const pedidoFiltro = req.query.pedido;
    const seguimiento = req.query.seguimiento;
    // COALESCE(orden_secuencia, id): las filas nuevas (post-split) ya traen
    // orden_secuencia calculado una vez por grupo_id (así dos envíos del
    // mismo pedido comparten el mismo número de venta); las filas viejas
    // (antes de este cambio) no lo tienen, usan su propio id de respaldo —
    // mismo criterio que en GET /api/pedidos.
    let rows = [];
    if (estado || fechaDesde || fechaHasta) {
      const { rows: filteredRows } = await sql`
        SELECT vp.*, v.nombre AS vendedora_nombre, v.codigo AS vendedora_codigo,
               pr.nombre AS proveedor_nombre,
               COALESCE(vp.orden_secuencia, vp.id) AS secuencia
        FROM ventas_pendientes vp JOIN vendedoras v ON v.id = vp.vendedora_id
        LEFT JOIN proveedores pr ON pr.id = vp.proveedor_id
        WHERE (${estado ? sql`vp.estado = ${estado}` : sql`1=1`})
          AND (${fechaDesde ? sql`DATE(vp.created_at) >= ${fechaDesde}` : sql`1=1`})
          AND (${fechaHasta ? sql`DATE(vp.created_at) <= ${fechaHasta}` : sql`1=1`})
        ORDER BY vp.created_at DESC LIMIT 500`;
      rows = filteredRows;
    } else {
      const { rows: allRows } = await sql`
        SELECT vp.*, v.nombre AS vendedora_nombre, v.codigo AS vendedora_codigo,
               pr.nombre AS proveedor_nombre,
               COALESCE(vp.orden_secuencia, vp.id) AS secuencia
        FROM ventas_pendientes vp JOIN vendedoras v ON v.id = vp.vendedora_id
        LEFT JOIN proveedores pr ON pr.id = vp.proveedor_id
        ORDER BY vp.created_at DESC LIMIT 500`;
      rows = allRows;
    }
    // Cuenta cuántas filas de este resultado comparten grupo_id — sirve para
    // que el admin vea "esta venta es parte de un pedido con otro proveedor".
    const porGrupo = {};
    rows.forEach(r => { if (r.grupo_id) porGrupo[r.grupo_id] = (porGrupo[r.grupo_id] || 0) + 1; });
    const list = (seguimiento ? rows.filter(r => (r.seguimiento || 'recibido') === seguimiento) : rows)
      .map(r => ({
        ...r, numero_venta: numeroVenta(r.vendedora_codigo, r.secuencia),
        proveedor_nombre: r.proveedor_nombre || 'Temponovo',
        otros_proveedores_mismo_pedido: r.grupo_id && porGrupo[r.grupo_id] > 1
      }))
      .filter(r => !pedidoFiltro || r.numero_venta.toUpperCase().includes(pedidoFiltro.toUpperCase()));
    res.json(list);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// Cambia el avance logístico de una venta (lo hace solo el admin, a mano).
// La vendedora y la vitrina lo leen después por /api/pedidos, usando el
// mismo id interno — nunca hablan con Odoo para saber esto.
app.put('/api/admin/ventas/:id/seguimiento', requireAdmin, async (req, res) => {
  try {
    const estado = req.body?.estado;
    if (!SEGUIMIENTO_ORDEN.includes(estado)) {
      return res.status(400).json({ error: 'Estado de seguimiento inválido. Usa: ' + SEGUIMIENTO_ORDEN.join(', ') });
    }
    const { rows } = await sql`
      UPDATE ventas_pendientes SET seguimiento = ${estado}, seguimiento_at = now()
      WHERE id = ${req.params.id} RETURNING id, seguimiento, seguimiento_at`;
    if (!rows.length) return res.status(404).json({ error: 'Venta no encontrada' });
    res.json({ ok: true, id: rows[0].id, seguimiento: rows[0].seguimiento, seguimientoAt: rows[0].seguimiento_at });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.post('/api/admin/ventas/:id/reintentar', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM ventas_pendientes WHERE id = ${req.params.id}`;
    const venta = rows[0]; if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    // Por defecto solo se reintentan las que quedaron con error. Pero a veces una
    // venta quedó "enviada" sin serlo de verdad (ej. la API aceptó el /sale/update
    // aunque la venta ya estaba cancelada en Odoo) — para esos casos el admin puede
    // forzar un reenvío explícito con ?force=1.
    if (venta.estado === 'enviada' && req.query.force !== '1') {
      return res.status(400).json({ error: 'Esta venta ya fue enviada a Odoo. Si de verdad no llegó (por ejemplo, cayó en una venta cancelada), reenvíala con "force".' });
    }
    if (venta.estado === 'cancelada' && req.query.force !== '1') {
      return res.status(400).json({ error: 'Esta venta fue cancelada. Si quieres mandarla de todas formas, reenvíala con "force".' });
    }
    const { rows: vrows } = await sql`SELECT * FROM vendedoras WHERE id = ${venta.vendedora_id}`;
    const v = vrows[0]; if (!v) return res.status(404).json({ error: 'Vendedora no encontrada' });

    try {
      const proveedor = await getProveedorDeVenta(venta);
      const r = await enviarVentaProveedor(proveedor, {
        productos: venta.productos, observacion: venta.nota,
        tipoVenta: venta.entrega === 'retiro' ? 'Retiro' : 'Despacho'
      }, v);
      await sql`UPDATE ventas_pendientes SET estado = 'enviada', odoo_order_id = ${r.idVenta}, odoo_venta_nombre = ${r.nombreOdoo}, error_msg = NULL, consolidado_at = now() WHERE id = ${venta.id}`;
      res.json({ ok: true, idVenta: r.idVenta, nombreOdoo: r.nombreOdoo });
    } catch (e) {
      const msg = shortErr(e);
      await sql`UPDATE ventas_pendientes SET error_msg = ${msg} WHERE id = ${venta.id}`;
      res.status(502).json({ error: msg });
    }
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// Cancela una venta con error en vez de seguir reintentándola (ej. un
// producto que ya no existe). Queda el registro para historial/reporte,
// pero sale de la cola de "reintentar todas" y no cuenta como venta real.
app.post('/api/admin/ventas/:id/cancelar', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT estado FROM ventas_pendientes WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Venta no encontrada' });
    if (rows[0].estado !== 'error') return res.status(400).json({ error: 'Solo se pueden cancelar ventas con error. Esta ya fue enviada a Odoo.' });
    const motivo = (req.body && String(req.body.motivo || '').trim()) || null;
    await sql`UPDATE ventas_pendientes SET estado = 'cancelada', error_msg = ${motivo} WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.post('/api/admin/reintentar-todas', requireAdmin, async (req, res) => {
  try {
    const { rows: fallidas } = await sql`SELECT * FROM ventas_pendientes WHERE estado = 'error'`;
    if (!fallidas.length) return res.status(400).json({ error: 'No hay ventas con error para reintentar' });
    let enviadas = 0, conError = 0;
    for (const venta of fallidas) {
      try {
        const { rows: vrows } = await sql`SELECT * FROM vendedoras WHERE id = ${venta.vendedora_id}`;
        const v = vrows[0];
        if (!v) { conError++; continue; }
        const proveedor = await getProveedorDeVenta(venta);
        const r = await enviarVentaProveedor(proveedor, {
          productos: venta.productos, observacion: venta.nota,
          tipoVenta: venta.entrega === 'retiro' ? 'Retiro' : 'Despacho'
        }, v);
        await sql`UPDATE ventas_pendientes SET estado = 'enviada', odoo_order_id = ${r.idVenta}, odoo_venta_nombre = ${r.nombreOdoo}, error_msg = NULL, consolidado_at = now() WHERE id = ${venta.id}`;
        enviadas++;
      } catch (e) {
        await sql`UPDATE ventas_pendientes SET error_msg = ${shortErr(e)} WHERE id = ${venta.id}`;
        conError++;
      }
    }
    res.json({ ok: true, enviadas, conError });
  } catch (e) { console.error('❌ /api/admin/reintentar-todas', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (opcionales, filtran por fecha de creación).
// "por categoría" depende de que la venta se haya hecho DESPUÉS de que
// empezamos a guardar la categoría/total por línea — las ventas viejas no
// tienen ese dato y no aparecen ahí (sí en el total por vendedora).
app.get('/api/admin/reporte', requireAdmin, async (req, res) => {
  try {
    const desde = req.query.desde ? new Date(req.query.desde + 'T00:00:00') : null;
    const hastaBase = req.query.hasta ? new Date(req.query.hasta + 'T00:00:00') : null;
    const hasta = hastaBase ? new Date(hastaBase.getTime() + 24 * 3600 * 1000) : null; // exclusivo: incluye todo el día "hasta"

    const { rows: porVendedora } = await sql`
      SELECT v.id AS vendedora_id, v.nombre AS vendedora_nombre, v.codigo,
             COUNT(vp.id) FILTER (WHERE vp.estado <> 'cancelada') AS ventas,
             COALESCE(SUM(vp.total) FILTER (WHERE vp.estado <> 'cancelada'), 0) AS total,
             COUNT(vp.id) FILTER (WHERE vp.estado = 'error') AS con_error,
             COUNT(vp.id) FILTER (WHERE vp.estado = 'cancelada') AS canceladas
      FROM vendedoras v
      LEFT JOIN ventas_pendientes vp ON vp.vendedora_id = v.id
        AND (${desde}::timestamptz IS NULL OR vp.created_at >= ${desde})
        AND (${hasta}::timestamptz IS NULL OR vp.created_at < ${hasta})
      GROUP BY v.id, v.nombre, v.codigo
      ORDER BY v.nombre`;

    const { rows: porMes } = await sql`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes,
             COUNT(*)::int AS ventas, COALESCE(SUM(total), 0) AS total
      FROM ventas_pendientes
      WHERE estado <> 'cancelada'
        AND (${desde}::timestamptz IS NULL OR created_at >= ${desde})
        AND (${hasta}::timestamptz IS NULL OR created_at < ${hasta})
      GROUP BY 1 ORDER BY 1 DESC`;

    const { rows: porCategoria } = await sql`
      SELECT COALESCE(NULLIF(linea->>'categoria', ''), 'Sin categoría') AS categoria,
             COUNT(DISTINCT vp.id)::int AS ventas,
             COALESCE(SUM((linea->>'total')::numeric), 0) AS total
      FROM ventas_pendientes vp, jsonb_array_elements(vp.productos) AS linea
      WHERE vp.estado <> 'cancelada'
        AND (${desde}::timestamptz IS NULL OR vp.created_at >= ${desde})
        AND (${hasta}::timestamptz IS NULL OR vp.created_at < ${hasta})
      GROUP BY 1 ORDER BY total DESC`;

    res.json({ porVendedora, porMes, porCategoria });
  } catch (e) { console.error('❌ /api/admin/reporte', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// ════════════════════════════════════════════════════════════════
// ADMIN · ACADEMIA — crear/editar cursos y lecciones
// ════════════════════════════════════════════════════════════════
// Lista todos los cursos (publicados o no) con sus lecciones.
app.get('/api/admin/academia', requireAdmin, async (_req, res) => {
  try {
    const { rows: cursos } = await sql`
      SELECT * FROM academia_cursos ORDER BY categoria, orden, id`;
    const { rows: lecciones } = await sql`
      SELECT * FROM academia_lecciones ORDER BY orden, id`;
    const byCurso = {};
    lecciones.forEach(l => { (byCurso[l.curso_id] = byCurso[l.curso_id] || []).push(l); });
    res.json(cursos.map(c => ({ ...c, lecciones: byCurso[c.id] || [] })));
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.post('/api/admin/academia/cursos', requireAdmin, async (req, res) => {
  try {
    const { titulo, descripcion, categoria, portada, orden, publicado } = req.body || {};
    if (!titulo) return res.status(400).json({ error: 'El título es obligatorio' });
    const cat = ['vender', 'producto'].includes(categoria) ? categoria : 'vender';
    const { rows } = await sql`
      INSERT INTO academia_cursos (titulo, descripcion, categoria, portada, orden, publicado)
      VALUES (${titulo}, ${descripcion || ''}, ${cat}, ${portada || ''}, ${orden || 0}, ${publicado !== false})
      RETURNING *`;
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.put('/api/admin/academia/cursos/:id', requireAdmin, async (req, res) => {
  try {
    const { titulo, descripcion, categoria, portada, orden, publicado } = req.body || {};
    const cat = categoria && ['vender', 'producto'].includes(categoria) ? categoria : null;
    const { rows } = await sql`
      UPDATE academia_cursos SET
        titulo = COALESCE(${titulo}, titulo),
        descripcion = COALESCE(${descripcion}, descripcion),
        categoria = COALESCE(${cat}, categoria),
        portada = COALESCE(${portada}, portada),
        orden = COALESCE(${orden}, orden),
        publicado = COALESCE(${typeof publicado === 'boolean' ? publicado : null}, publicado)
      WHERE id = ${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: 'Curso no encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.delete('/api/admin/academia/cursos/:id', requireAdmin, async (req, res) => {
  try { await sql`DELETE FROM academia_cursos WHERE id = ${req.params.id}`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.post('/api/admin/academia/lecciones', requireAdmin, async (req, res) => {
  try {
    const { curso_id, titulo, tipo, video_url, cuerpo, imagen, sku_ref, orden } = req.body || {};
    if (!curso_id || !titulo) return res.status(400).json({ error: 'Curso y título son obligatorios' });
    const t = ['video', 'texto', 'imagen'].includes(tipo) ? tipo : 'video';
    const { rows } = await sql`
      INSERT INTO academia_lecciones (curso_id, titulo, tipo, video_url, cuerpo, imagen, sku_ref, orden)
      VALUES (${curso_id}, ${titulo}, ${t}, ${video_url || ''}, ${cuerpo || ''}, ${imagen || ''}, ${(sku_ref || '').toUpperCase()}, ${orden || 0})
      RETURNING *`;
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.put('/api/admin/academia/lecciones/:id', requireAdmin, async (req, res) => {
  try {
    const { titulo, tipo, video_url, cuerpo, imagen, sku_ref, orden } = req.body || {};
    const t = tipo && ['video', 'texto', 'imagen'].includes(tipo) ? tipo : null;
    const { rows } = await sql`
      UPDATE academia_lecciones SET
        titulo = COALESCE(${titulo}, titulo),
        tipo = COALESCE(${t}, tipo),
        video_url = COALESCE(${video_url}, video_url),
        cuerpo = COALESCE(${cuerpo}, cuerpo),
        imagen = COALESCE(${imagen}, imagen),
        sku_ref = COALESCE(${sku_ref !== undefined ? String(sku_ref).toUpperCase() : null}, sku_ref),
        orden = COALESCE(${orden}, orden)
      WHERE id = ${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: 'Lección no encontrada' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.delete('/api/admin/academia/lecciones/:id', requireAdmin, async (req, res) => {
  try { await sql`DELETE FROM academia_lecciones WHERE id = ${req.params.id}`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.get('/health', async (_req, res) => {
  let dbOk = false;
  try { await sql`SELECT 1`; dbOk = true; } catch {}
  // Lista de proveedores sin exponer credenciales — solo si están seteadas o
  // no. Sirve para verificar en staging que la migración automática del
  // proveedor "temponovo" (fase 0 del portal multi-proveedor) corrió bien.
  let proveedores = [];
  try {
    const { rows } = await sql`SELECT codigo, nombre, tipo, activo,
      (odoo_password_enc IS NOT NULL) AS odoo_password_set,
      (venta_api_key_enc IS NOT NULL) AS venta_api_key_set
      FROM proveedores ORDER BY orden, id`;
    proveedores = rows;
  } catch {}
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    config: {
      odooUrl: ODOO_URL, odooDb: ODOO_DB, userSet: !!ODOO_USER, passwordSet: !!ODOO_PASS,
      adminPasswordSet: !!ADMIN_PASSWORD, adminSecretSet: !!ADMIN_SECRET, credentialsKeySet: !!CREDENTIALS_KEY,
      tempoApiKeySet: !!TEMPO_API_KEY, tempoApiUrl: TEMPO_API_URL, db: dbOk
    },
    proveedores
  });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Temponovo Vitrina API en puerto ${PORT}`));
}
