const express  = require('express');
const xmlrpc   = require('xmlrpc');
const cors     = require('cors');
const archiver = require('archiver');
const crypto   = require('crypto');
const { sql, pool } = require('./db');
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

// ── CACHÉ EN MEMORIA ─────────────────────────────────────────────
function shortErr(e) {
  const msg = (e && e.message) || String(e);
  const lines = msg.split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length > 1 ? lines[lines.length - 1] : msg;
}
const cache = {};
function cacheGet(k) { const e = cache[k]; if (!e) return null; if (Date.now() - e.ts > e.ttl) { delete cache[k]; return null; } return e.data; }
function cacheSet(k, d, ttl) { cache[k] = { data: d, ts: Date.now(), ttl }; }

// ── SEGUIMIENTO LOGÍSTICO DE VENTAS ──────────────────────────────
// Único estado por el que pasa cada venta, en orden. Lo cambia solo el
// admin (Panel de Admin → Ventas). La vitrina de la vendedora solo lee
// este valor por el id interno de la venta — nunca toca Odoo para esto.
const SEGUIMIENTO_ORDEN = ['recibido', 'preparando', 'en_transito', 'entregado'];
const SEGUIMIENTO_LABEL = { recibido: 'Recibido', preparando: 'Preparando', en_transito: 'En tránsito', entregado: 'Entregado' };

// ── NÚMERO DE VENTA (interno, nunca es el de Odoo) ───────────────
// Cada vendedora tiene su propio correlativo, partiendo en 1, con la
// inicial de su código adelante — ej. la vendedora "CAROLINA" ve sus
// ventas como C00001, C00002, C00003... El correlativo se calcula al
// vuelo (cuántas ventas de ESA vendedora tienen id <= esta), así que no
// hace falta guardar ni mantener ningún contador aparte.
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
  const cfg = await getConfig();
  if (!cfg.partner_id) return null;
  return { id: v.id, code: v.codigo, partnerId: cfg.partner_id, name: v.nombre, multiplicador: parseFloat(v.multiplicador) || 2, categorias: v.categorias || [] };
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
    const cfg = await getConfig();
    if (!cfg.partner_id) return res.status(500).json({ error: 'Falta configurar el Partner ID de Odoo (Panel de Admin → Configuración)' });
    req.vendedora = v; req.config = cfg;
    req.partnerId = cfg.partner_id; req.clientName = v.nombre; req.multiplicador = parseFloat(v.multiplicador) || 2;
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
function famOf(categoria) {
  const parts = (categoria || '').split('/').map(x => x.trim()).filter(x => x && x.toLowerCase() !== 'all');
  return parts[0] || 'Otros';
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

async function productosCliente(cliente) {
  let prods = await fetchProductos();
  const plId = await getPricelistId(cliente.partnerId);
  if (plId && prods.length) {
    try {
      const ids = prods.map(p => p.id);
      const precios = await xmlrpcCall('product.pricelist', 'get_products_price',
        [[plId], ids, ids.map(() => 1), new Date().toISOString().slice(0, 10)]);
      prods = prods.map(p => ({ ...p, precio: parseFloat(precios[p.id] || p.precio) }));
    } catch (e) { console.warn('⚠ pricelist:', e.message); }
  }
  // Adjunta la info libre del Excel (si existe para ese SKU)
  try {
    const infoMap = await getProductoInfoMap();
    prods = prods.map(p => {
      const campos = infoMap[(p.sku || '').toUpperCase()];
      return campos ? { ...p, info: infoToList(campos) } : p;
    });
  } catch (e) { console.warn('⚠ merge producto_info:', e.message); }
  return prods;
}

// ── PRICELIST DEL CLIENTE ────────────────────────────────────────
async function getPricelistId(partnerId) {
  const cached = cacheGet('pl_' + partnerId); if (cached !== null) return cached;
  const r = await xmlrpcCall('res.partner', 'read', [[partnerId], ['property_product_pricelist']]);
  const pl = r[0]?.property_product_pricelist;
  const plId = Array.isArray(pl) ? pl[0] : null;
  cacheSet('pl_' + partnerId, plId, 3600000); return plId;
}

// ── FETCH RELOJES BASE ───────────────────────────────────────────
async function fetchProductos() {
  const cached = cacheGet('productos'); if (cached) return cached;

  const domain = [['sale_ok', '=', true], ['active', '=', true]];
  if (CATEGORIAS_OK.length) {
    const categIds = await xmlrpcCall('product.category', 'search', [[['complete_name', 'in', CATEGORIAS_OK]]]);
    if (categIds.length) domain.push(['categ_id', 'in', categIds]);
  }

  const prodIds = await xmlrpcCall('product.product', 'search', [domain]);
  if (!prodIds.length) return [];

  const result = [];
  for (let i = 0; i < prodIds.length; i += 200) {
    const chunk = prodIds.slice(i, i + 200);
    const prods = await xmlrpcCall('product.product', 'read', [chunk, [
      'id', 'default_code', 'name', 'list_price', 'categ_id',
      'barcode', 'qty_available',
      'product_template_attribute_value_ids', 'product_tmpl_id'
    ]]);

    const tmplIds = [...new Set(prods.map(p => Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id))];
    let tmplMap = {};
    if (tmplIds.length) {
      const tmpls = await xmlrpcCall('product.template', 'read', [tmplIds, ['id', 'description_sale']]);
      tmpls.forEach(t => { tmplMap[t.id] = t; });
    }

    const attrValIds = [...new Set(prods.flatMap(p => p.product_template_attribute_value_ids || []))];
    let attrMap = {};
    if (attrValIds.length) {
      const attrVals = await xmlrpcCall('product.template.attribute.value', 'read',
        [attrValIds, ['id', 'name', 'attribute_id']]);
      attrVals.forEach(v => {
        const attrName = Array.isArray(v.attribute_id) ? v.attribute_id[1] : '';
        attrMap[v.id] = { attr: attrName, val: v.name || '' };
      });
    }

    prods.forEach(p => {
      const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
      const tmpl = tmplMap[tmplId] || {};
      const atributos = (p.product_template_attribute_value_ids || [])
        .map(id => attrMap[id]).filter(Boolean);
      result.push({
        id: p.id,
        sku: p.default_code || '',
        nombre: p.name || '',
        descripcion: tmpl.description_sale || '',
        precio: parseFloat(p.list_price || 0),
        categoria: Array.isArray(p.categ_id) ? p.categ_id[1] : '',
        atributos,
        barcode: p.barcode || '',
        stock: parseFloat(p.qty_available || 0)
      });
    });
  }
  cacheSet('productos', result, 30 * 60 * 1000);
  return result;
}

// ════════════════════════════════════════════════════════════════
// VITRINA — catálogo con precio del cliente + precio sugerido
// ════════════════════════════════════════════════════════════════
app.get('/api/productos', async (req, res) => {
  try {
    const { v, error } = await authenticateVendedora(req);
    if (error) return res.status(401).json({ error });
    const cfg = await getConfig();
    if (!cfg.partner_id) return res.status(500).json({ error: 'Falta configurar el Partner ID de Odoo (Panel de Admin → Configuración)' });

    const cached = cacheGet('cat_' + v.codigo); if (cached) return res.json(cached);

    let prods = await productosCliente({ partnerId: cfg.partner_id });
    const categorias = v.categorias || [];
    if (categorias.length) prods = prods.filter(p => categorias.includes(famOf(p.categoria)));

    const mult = parseFloat(v.multiplicador) || 2;
    const result = prods.map(p => ({ ...p, precioSugerido: Math.round(p.precio * mult) }));

    cacheSet('cat_' + v.codigo, result, 15 * 60 * 1000);
    res.json(result);
  } catch (e) { console.error('❌ /api/productos', e.message); res.status(500).json({ error: shortErr(e) }); }
});

app.delete('/api/productos/cache', requireAdmin, (_req, res) => {
  Object.keys(cache).filter(k => k.startsWith('productos') || k.startsWith('cat_') || k.startsWith('img_'))
    .forEach(k => delete cache[k]);
  res.json({ ok: true });
});

// ── IMAGEN INDIVIDUAL (miniatura o grande) ───────────────────────
// GET /api/imagen/:id?c=CODIGO&t=TOKEN&s=g   → image_1024 (detalle / probar)
// Usa el token de imagen (ver imgToken), nunca la clave real — un <img src>
// no puede mandar headers, y una clave en la URL queda en logs/historial.
app.get('/api/imagen/:id', async (req, res) => {
  try {
    const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    const token  = req.headers['x-client-token'] || req.query.t || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyImgToken(v, token)) return res.status(401).send('No autorizado');
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send('ID inválido');
    const field = req.query.s === 'g' ? 'image_1024' : 'image_256';

    const key = 'img_' + field + '_' + id;
    let b64 = cacheGet(key);
    if (!b64) {
      const prods = await xmlrpcCall('product.product', 'read', [[id], [field]]);
      b64 = prods && prods[0] ? prods[0][field] : null;
      if (b64) cacheSet(key, b64, 2 * 60 * 60 * 1000);
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
    console.error('❌ /api/imagen/' + req.params.id, e.message);
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

// ── CLIENTE DE LA API DE VENTAS TEMPONOVO ────────────────────────
function tempoApiCall(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    if (!TEMPO_API_KEY) return reject(new Error('Falta TEMPONOVO_API_KEY en las variables de entorno del servidor'));
    let url;
    try { url = new URL(TEMPO_API_URL + path); } catch { return reject(new Error('TEMPONOVO_API_URL inválida')); }
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'Authorization': TEMPO_API_KEY,
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
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado llamando a la API de Temponovo')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function tempoCrearVenta({ vendorEmail, observacion, tipoVenta, productos }) {
  const r = await tempoApiCall('POST', '/sale/create', {
    body: { data: {
      vendor_email: vendorEmail || undefined,
      tempo_observation: observacion || '',
      tempo_type_sale: tipoVenta || '',
      productos
    } }
  });
  const d = (r && r.data) || r || {};
  if (!d.Id_Venta) throw new Error('La API de Temponovo no devolvió Id_Venta');
  return d; // { Id_Venta, Nombre }
}
async function tempoAgregarProductos(idVenta, productos) {
  const r = await tempoApiCall('POST', '/sale/update', {
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
async function tempoConsultarVenta(idVenta) {
  const r = await tempoApiCall('GET', '/api/sale', { headers: { Idventa: String(idVenta) } });
  return (r && r.data) || r || {};
}
// Devuelve los SKU que se intentaron agregar pero que NO aparecen en la
// venta al releerla — esos son los que en realidad no quedaron guardados.
function productosFaltantes(productosEnviados, ventaInfo) {
  const lineas = (ventaInfo && ventaInfo.Productos) || [];
  const skusEnVenta = new Set(lineas.map(l => String(l.Sku || l.sku || '').toUpperCase()));
  return productosEnviados.filter(p => !skusEnVenta.has(String(p.sku).toUpperCase()));
}
// Intenta agregar la venta a la ÚNICA "venta abierta" global (compartida por
// todas las vendedoras, porque todas facturan al mismo partner). Si esa
// venta ya no admite cambios de verdad (aunque la API haya respondido
// "éxito"), abre una venta nueva automáticamente.
//
// Usa un lock a nivel de fila (SELECT ... FOR UPDATE) sobre "configuracion"
// mientras dura la llamada a la API, para que si dos vendedoras mandan un
// pedido casi al mismo tiempo, el segundo espere a que termine el primero
// en vez de leer el mismo estado viejo y terminar abriendo 2 ventas nuevas.
async function intentarEnviarVenta({ productos, observacion, tipoVenta }, v) {
  const productosApi = (productos || []).map(p => ({ sku: p.sku, quantity: parseFloat(p.quantity) || 1 }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT venta_abierta_id, venta_abierta_nombre FROM configuracion WHERE id = 1 FOR UPDATE');
    let idVenta = rows[0]?.venta_abierta_id || null;
    let nombreOdoo = rows[0]?.venta_abierta_nombre || null;

    if (idVenta) {
      try {
        await tempoAgregarProductos(idVenta, productosApi);
        const info = await tempoConsultarVenta(idVenta);
        const faltan = productosFaltantes(productosApi, info);
        if (faltan.length) {
          throw new Error('La venta no reflejó los productos agregados (' + faltan.map(p => p.sku).join(', ') + ') — probablemente está bloqueada, facturada o cancelada en Odoo');
        }
        await client.query('COMMIT');
        return { idVenta, nombreOdoo: info.Nombre || nombreOdoo };
      } catch (e) {
        console.warn(`⚠ venta abierta ${idVenta} ya no admite cambios de verdad (${shortErr(e)}), se abre una nueva`);
      }
    }
    const obsConVendedora = `Vendedora: ${v.nombre} (${v.codigo})` + (observacion ? ' | ' + observacion : '');
    const r = await tempoCrearVenta({ vendorEmail: TEMPO_VENDOR_EMAIL, observacion: obsConVendedora, tipoVenta, productos: productosApi });
    await client.query('UPDATE configuracion SET venta_abierta_id = $1, venta_abierta_nombre = $2 WHERE id = 1', [r.Id_Venta, r.Nombre]);
    await client.query('COMMIT');
    return { idVenta: r.Id_Venta, nombreOdoo: r.Nombre };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
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
    let prods = await fetchProductos();
    if (familia) prods = prods.filter(p => famOf(p.categoria).toLowerCase() === familia);
    if (!prods.length) return res.status(404).json({ error: 'Sin productos para esa familia' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="temponovo-fotos${familia ? '-' + familia.replace(/[\s/]+/g, '-') : ''}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', e => { console.error('❌ zip', e.message); try { res.end(); } catch {} });
    archive.pipe(res);

    const ids = prods.map(p => p.id);
    const bySku = {}; prods.forEach(p => { bySku[p.id] = p.sku || String(p.id); });
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const imgs = await xmlrpcCall('product.product', 'read', [chunk, ['id', 'image_512']]);
      imgs.forEach(r => {
        if (!r.image_512) return;
        const name = String(bySku[r.id]).replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
        archive.append(Buffer.from(r.image_512, 'base64'), { name });
      });
    }
    await archive.finalize();
  } catch (e) {
    console.error('❌ /api/fotos', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el zip de fotos' });
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

    // total estimado — solo para mostrar en "Mis Ventas"/reporte local, no se manda a Odoo
    let prods = [];
    try { prods = await productosCliente({ partnerId: req.partnerId }); } catch (e) { console.warn('⚠ precio pedido:', e.message); }
    const bySku = {}; prods.forEach(p => { bySku[p.sku] = p; });
    const mult = req.multiplicador || 2;
    // Se guarda categoría y total POR LÍNEA (no solo el sku/cantidad que pide
    // Odoo) para poder reportar después por tipo de producto sin tener que
    // volver a leer el catálogo — que puede haber cambiado o perdido ese SKU.
    let total = 0;
    const productosConDetalle = productos.map(p => {
      const info = bySku[p.sku];
      const qty = parseFloat(p.quantity) || 1;
      const lineaTotal = Math.round((info ? info.precio : 0) * mult * qty);
      total += lineaTotal;
      return { sku: p.sku, quantity: qty, categoria: info ? famOf(info.categoria) : '', total: lineaTotal };
    });

    const entregaFinal = entrega === 'retiro' ? 'retiro' : 'despacho';
    const notaFinal = [nombreVenta, telefono, email, nota, metodoPago ? 'Método: ' + metodoPago : ''].filter(Boolean).join(' | ');

    let idVenta = null, nombreOdoo = null, errorMsg = null;
    try {
      const r = await intentarEnviarVenta({
        productos: productosConDetalle, observacion: notaFinal,
        tipoVenta: entregaFinal === 'retiro' ? 'Retiro' : 'Despacho'
      }, req.vendedora);
      idVenta = r.idVenta; nombreOdoo = r.nombreOdoo;
    } catch (e) { errorMsg = shortErr(e); console.error('❌ envío a API Temponovo', e.message); }

    const estado = (idVenta && !errorMsg) ? 'enviada' : 'error';
    const { rows } = await sql`
      INSERT INTO ventas_pendientes
        (vendedora_id, productos, nombre_venta, telefono, email, direccion, comuna, entrega, nota, total, estado, odoo_order_id, odoo_venta_nombre, error_msg, consolidado_at)
      VALUES
        (${req.vendedora.id}, ${JSON.stringify(productosConDetalle)}, ${nombreVenta || ''},
         ${telefono || ''}, ${email || ''}, ${entregaFinal === 'retiro' ? '' : (direccion || '')}, ${comuna || ''}, ${entregaFinal}, ${notaFinal}, ${Math.round(total)},
         ${estado}, ${idVenta}, ${nombreOdoo}, ${errorMsg}, ${estado === 'enviada' ? new Date() : null})
      RETURNING id`;

    if (errorMsg) {
      const { rows: seqRows } = await sql`
        SELECT COUNT(*)::int AS n FROM ventas_pendientes WHERE vendedora_id = ${req.vendedora.id} AND id <= ${rows[0].id}`;
      return res.status(502).json({
        error: 'Tu venta quedó guardada (N° ' + numeroVenta(req.vendedora.codigo, seqRows[0].n) + '), pero no pudimos terminar de procesarla todavía. La estamos reintentando — te avisamos apenas quede lista.',
        orderId: rows[0].id, pending: true
      });
    }
    const { rows: seqRowsOk } = await sql`
      SELECT COUNT(*)::int AS n FROM ventas_pendientes WHERE vendedora_id = ${req.vendedora.id} AND id <= ${rows[0].id}`;
    res.json({ ok: true, orderId: rows[0].id, numero: numeroVenta(req.vendedora.codigo, seqRowsOk[0].n), seguimiento: 'recibido', message: 'Venta recibida' });
  } catch (e) { console.error('❌ /api/pedido', e.message); res.status(500).json({ error: shortErr(e) }); }
});

app.get('/api/pedidos', requireClient, async (req, res) => {
  try {
    const { rows } = await sql`
      SELECT *, ROW_NUMBER() OVER (ORDER BY id)::int AS secuencia
      FROM ventas_pendientes WHERE vendedora_id = ${req.vendedora.id}
      ORDER BY created_at DESC LIMIT 200`;
    res.json(rows.map(o => ({
      id: o.id,
      nombre: numeroVenta(req.vendedora.codigo, o.secuencia),
      fecha: o.created_at,
      estado: o.estado, // 'enviada' | 'error' | 'cancelada'
      total: parseFloat(o.total || 0),
      neto: parseFloat(o.total || 0),
      nota: o.estado === 'error' ? '⚠ Estamos terminando de procesar esta venta.'
        : o.estado === 'cancelada' ? '✕ Esta venta fue cancelada.' : (o.nota || ''),
      ref: o.nombre_venta || '',
      entrega: o.entrega || 'despacho',
      seguimiento: o.seguimiento || 'recibido',
      seguimientoLabel: SEGUIMIENTO_LABEL[o.seguimiento] || SEGUIMIENTO_LABEL.recibido,
      seguimientoPaso: Math.max(0, SEGUIMIENTO_ORDEN.indexOf(o.seguimiento || 'recibido')),
      seguimientoAt: o.seguimiento_at,
      lineas: (o.productos || []).map(p => ({ sku: p.sku, categoria: p.categoria || '', cantidad: p.quantity, total: parseFloat(p.total || 0) }))
    })));
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
    const hit = cacheGet('pub_' + req.params.slug); if (hit) return res.json(hit);
    const cfg = await readCfgDb({ id: c.id, codigo: c.code }, c.partnerId);
    const mult = parseFloat(cfg.mult) || c.multiplicador || 2;
    const ov = cfg.overrides || {};
    const hFams = new Set(cfg.hiddenFams || []);
    const hSkus = new Set((cfg.hiddenSkus || []).map(x => x.toUpperCase()));
    let prods = await productosCliente(c);
    if ((c.categorias || []).length) prods = prods.filter(p => c.categorias.includes(famOf(p.categoria)));
    const result = prods
      .filter(p => p.stock > 0)
      .filter(p => !hFams.has(famOf(p.categoria)))
      .filter(p => !hSkus.has((p.sku || '').toUpperCase()))
      .map(p => ({
        id: p.id, sku: p.sku, nombre: p.nombre, descripcion: p.descripcion,
        categoria: p.categoria, atributos: p.atributos, info: p.info || [],
        precioVenta: ov[p.sku] > 0 ? Math.round(ov[p.sku]) : Math.round(p.precio * mult)
      }));
    cacheSet('pub_' + req.params.slug, result, 10 * 60 * 1000);
    res.json(result);
  } catch (e) { console.error('❌ /api/public/productos', e.message); res.status(500).json({ error: 'No se pudo cargar el catálogo' }); }
});

app.get('/api/public/:slug/imagen/:id', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).send('No encontrada');
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send('ID inválido');
    const field = req.query.s === 'g' ? 'image_1024' : 'image_256';
    const key = 'img_' + field + '_' + id;
    let b64 = cacheGet(key);
    if (!b64) {
      const prods = await xmlrpcCall('product.product', 'read', [[id], [field]]);
      b64 = prods && prods[0] ? prods[0][field] : null;
      if (b64) cacheSet(key, b64, 2 * 60 * 60 * 1000);
    }
    if (!b64) return res.status(404).send('Sin imagen');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400');
    res.send(Buffer.from(b64, 'base64'));
  } catch (e) { console.error('❌ /api/public/imagen', e.message); res.status(500).send('No se pudo cargar la imagen'); }
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
      name: v.nombre, multiplicador: parseFloat(v.multiplicador) || 2, sucursales: v.sucursales || [],
      publicSlug: slugOf(v.codigo), imgToken: imgToken(v)
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
    const prods = await fetchProductos();
    res.json([...new Set(prods.map(p => famOf(p.categoria)))].sort());
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
    const { rows } = await sql`SELECT id, codigo, nombre, email, multiplicador, categorias, sucursales, activo, created_at FROM vendedoras ORDER BY nombre`;
    res.json(rows); // nunca se devuelve clave_hash
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
    const { codigo, clave, nombre, email, multiplicador, categorias, sucursales } = req.body || {};
    if (!codigo || !clave || !nombre) return res.status(400).json({ error: 'Código, clave y nombre son obligatorios' });
    const hash = hashPassword(clave);
    const { rows } = await sql`
      INSERT INTO vendedoras (codigo, clave_hash, nombre, email, multiplicador, categorias, sucursales)
      VALUES (${String(codigo).toUpperCase()}, ${hash}, ${nombre}, ${email || ''}, ${multiplicador || 2},
              ${JSON.stringify(categorias || [])}, ${JSON.stringify(sucursales || [])})
      RETURNING id, codigo, nombre, email, multiplicador, categorias, sucursales, activo, created_at`;
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message || '').includes('duplicate key')) return res.status(409).json({ error: 'Ese código de usuario ya existe' });
    res.status(500).json({ error: shortErr(e) });
  }
});
app.put('/api/admin/vendedoras/:id', requireAdmin, async (req, res) => {
  try {
    const { nombre, clave, email, multiplicador, categorias, sucursales, activo } = req.body || {};
    const claveHash = clave ? hashPassword(clave) : null;
    const { rows } = await sql`
      UPDATE vendedoras SET
        nombre = COALESCE(${nombre}, nombre),
        clave_hash = COALESCE(${claveHash}, clave_hash),
        email = COALESCE(${email}, email),
        multiplicador = COALESCE(${multiplicador}, multiplicador),
        categorias = COALESCE(${categorias ? JSON.stringify(categorias) : null}, categorias),
        sucursales = COALESCE(${sucursales ? JSON.stringify(sucursales) : null}, sucursales),
        activo = COALESCE(${activo}, activo)
      WHERE id = ${req.params.id}
      RETURNING id, codigo, nombre, email, multiplicador, categorias, sucursales, activo, created_at`;
    if (!rows.length) return res.status(404).json({ error: 'Vendedora no encontrada' });
    delete cache['cat_' + rows[0].codigo]; // refresca catálogo si cambió multiplicador/categorías
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
    if (!uid) return res.status(401).json({ error: 'Odoo rechazó las credenciales (usuario, clave o base de datos incorrectos)' });
    res.json({ ok: true, uid });
  } catch (e) { res.status(502).json({ error: 'No se pudo conectar: ' + shortErr(e) }); }
});

// La "venta abierta" es UNA sola, compartida por todas las vendedoras (todas
// facturan al mismo partner). Cerrarla a mano fuerza que el próximo pedido de
// CUALQUIER vendedora abra una venta nueva en Odoo con /sale/create.
app.post('/api/admin/cerrar-venta', requireAdmin, async (_req, res) => {
  try {
    await sql`UPDATE configuracion SET venta_abierta_id = NULL, venta_abierta_nombre = NULL WHERE id = 1`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── Precios fijos por vendedora (Excel) — se guardan como "overrides" en
// su misma configuración visual (vendedora_config en Postgres) ──
app.get('/api/admin/vendedoras/:id/precios/base', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM vendedoras WHERE id = ${req.params.id}`;
    const v = rows[0]; if (!v) return res.status(404).json({ error: 'Vendedora no encontrada' });
    const cfg0 = await getConfig();
    if (!cfg0.partner_id) return res.status(400).json({ error: 'Falta configurar el Partner ID en Configuración' });
    let prods = await productosCliente({ partnerId: cfg0.partner_id });
    const categorias = v.categorias || [];
    if (categorias.length) prods = prods.filter(p => categorias.includes(famOf(p.categoria)));
    const cfg = await readCfgDb(v, cfg0.partner_id);
    const ov = cfg.overrides || {};
    const mult = parseFloat(v.multiplicador) || 2;
    res.json(prods.map(p => ({
      sku: p.sku, nombre: p.nombre,
      precioVenta: ov[p.sku] > 0 ? Math.round(ov[p.sku]) : Math.round(p.precio * mult)
    })));
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.post('/api/admin/vendedoras/:id/precios', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM vendedoras WHERE id = ${req.params.id}`;
    const v = rows[0]; if (!v) return res.status(404).json({ error: 'Vendedora no encontrada' });
    const cfg0 = await getConfig();
    const precios = req.body?.data || {};
    if (!precios || typeof precios !== 'object') return res.status(400).json({ error: 'Formato inválido' });
    const cfg = await readCfgDb(v, cfg0.partner_id);
    cfg.overrides = { ...(cfg.overrides || {}) };
    let n = 0;
    Object.entries(precios).forEach(([sku, precio]) => {
      const pr = parseFloat(precio);
      if (sku && pr > 0) { cfg.overrides[String(sku).toUpperCase()] = Math.round(pr); n++; }
    });
    await writeCfgDb(v, cfg);
    delete cache['cat_' + v.codigo]; delete cache['pub_' + slugOf(v.codigo)];
    res.json({ ok: true, actualizados: n });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.delete('/api/admin/vendedoras/:id/precios', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM vendedoras WHERE id = ${req.params.id}`;
    const v = rows[0]; if (!v) return res.status(404).json({ error: 'Vendedora no encontrada' });
    const cfg0 = await getConfig();
    const cfg = await readCfgDb(v, cfg0.partner_id);
    cfg.overrides = {};
    await writeCfgDb(v, cfg);
    delete cache['cat_' + v.codigo]; delete cache['pub_' + slugOf(v.codigo)];
    res.json({ ok: true });
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
          (await fetchProductos()).forEach(p => { if (p.barcode) porBarcode[String(p.barcode).trim()] = (p.sku || '').toUpperCase(); });
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
    const { rows } = estado
      ? await sql`
          SELECT vp.*, v.nombre AS vendedora_nombre, v.codigo AS vendedora_codigo,
                 ROW_NUMBER() OVER (PARTITION BY vp.vendedora_id ORDER BY vp.id)::int AS secuencia
          FROM ventas_pendientes vp JOIN vendedoras v ON v.id = vp.vendedora_id
          WHERE vp.estado = ${estado} ORDER BY vp.created_at DESC`
      : await sql`
          SELECT vp.*, v.nombre AS vendedora_nombre, v.codigo AS vendedora_codigo,
                 ROW_NUMBER() OVER (PARTITION BY vp.vendedora_id ORDER BY vp.id)::int AS secuencia
          FROM ventas_pendientes vp JOIN vendedoras v ON v.id = vp.vendedora_id
          ORDER BY vp.created_at DESC LIMIT 500`;
    const seguimiento = req.query.seguimiento;
    const list = (seguimiento ? rows.filter(r => (r.seguimiento || 'recibido') === seguimiento) : rows)
      .map(r => ({ ...r, numero_venta: numeroVenta(r.vendedora_codigo, r.secuencia) }));
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
      const r = await intentarEnviarVenta({
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
        const r = await intentarEnviarVenta({
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
