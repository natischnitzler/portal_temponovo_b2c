const express  = require('express');
const xmlrpc   = require('xmlrpc');
const cors     = require('cors');
const archiver = require('archiver');
const crypto   = require('crypto');
const { sql }  = require('./db');
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
    // Email de la vendedora (se manda como vendor_email a la API de ventas) y
    // la "venta abierta" en Odoo donde se van agregando sus próximos pedidos,
    // hasta que la API la rechace (ya pickeada) y haya que abrir una nueva.
    await sql`ALTER TABLE vendedoras ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`;
    await sql`ALTER TABLE vendedoras ADD COLUMN IF NOT EXISTS venta_abierta_id INTEGER`;
    await sql`ALTER TABLE vendedoras ADD COLUMN IF NOT EXISTS venta_abierta_nombre TEXT`;
    // Nombre de la venta en Odoo (ej. "S06819") y detalle del error si la API falló.
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS odoo_venta_nombre TEXT`;
    await sql`ALTER TABLE ventas_pendientes ADD COLUMN IF NOT EXISTS error_msg TEXT`;
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'cambia-esto-en-vercel';
function makeAdminToken() {
  const exp = Date.now() + 12 * 3600 * 1000; // 12 horas
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyAdminToken(token) {
  if (!token || !token.includes('.')) return false;
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
  return { code: v.codigo, partnerId: cfg.partner_id, name: v.nombre, multiplicador: parseFloat(v.multiplicador) || 2, categorias: v.categorias || [] };
}

// ── MIDDLEWARE: ACCESO DE VENDEDORA (código + clave) ─────────────
async function requireClient(req, res, next) {
  try {
    const codigo = (req.headers['x-client-code'] || '').toUpperCase();
    const clave  = req.headers['x-client-pass'] || '';
    if (!codigo || !clave) return res.status(401).json({ error: 'Faltan credenciales' });
    const v = await getVendedora(codigo);
    if (!v || !v.activo) return res.status(401).json({ error: 'Usuario no reconocido' });
    if (!verifyPassword(clave, v.clave_hash)) return res.status(401).json({ error: 'Clave incorrecta' });
    const cfg = await getConfig();
    if (!cfg.partner_id) return res.status(500).json({ error: 'Falta configurar el Partner ID de Odoo (Panel de Admin → Configuración)' });
    req.vendedora = v; req.config = cfg;
    req.partnerId = cfg.partner_id; req.clientName = v.nombre; req.multiplicador = parseFloat(v.multiplicador) || 2;
    next();
  } catch (e) { console.error('❌ requireClient', e.message); res.status(500).json({ error: shortErr(e) }); }
}

// ── LINK PÚBLICO + CONFIG (guardada en Odoo, por vendedora) ──────
async function readCfg(code, partnerId) {
  const hit = cacheGet('cfg_' + code); if (hit !== null) return hit;
  const name = 'vitrina-cfg-' + code;
  const ids = await xmlrpcCall('ir.attachment', 'search',
    [[['name', '=', name], ['res_model', '=', 'res.partner'], ['res_id', '=', partnerId]]], { limit: 1 });
  let cfg = {};
  if (ids.length) {
    const rec = await xmlrpcCall('ir.attachment', 'read', [ids, ['datas']]);
    try { cfg = JSON.parse(Buffer.from(rec[0].datas, 'base64').toString('utf8')) || {}; } catch {}
  }
  cacheSet('cfg_' + code, cfg, 5 * 60 * 1000);
  return cfg;
}
async function writeCfg(code, partnerId, cfg) {
  const name = 'vitrina-cfg-' + code;
  const datas = Buffer.from(JSON.stringify(cfg)).toString('base64');
  const ids = await xmlrpcCall('ir.attachment', 'search',
    [[['name', '=', name], ['res_model', '=', 'res.partner'], ['res_id', '=', partnerId]]], { limit: 1 });
  if (ids.length) await xmlrpcCall('ir.attachment', 'write', [ids, { datas }]);
  else await xmlrpcCall('ir.attachment', 'create', [{
    name, res_model: 'res.partner', res_id: partnerId, type: 'binary', datas, mimetype: 'application/json'
  }]);
  cacheSet('cfg_' + code, cfg, 5 * 60 * 1000);
}
function famOf(categoria) {
  const parts = (categoria || '').split('/').map(x => x.trim()).filter(x => x && x.toLowerCase() !== 'all');
  return parts[0] || 'Otros';
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
    const codigo = (req.headers['x-client-code'] || '').toUpperCase();
    const clave  = req.headers['x-client-pass'] || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyPassword(clave, v.clave_hash)) return res.status(401).json({ error: 'Cliente no reconocido' });
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
// GET /api/imagen/:id?c=CODIGO&p=CLAVE&s=g   → image_1024 (detalle / probar)
app.get('/api/imagen/:id', async (req, res) => {
  try {
    const codigo = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    const clave  = req.headers['x-client-pass']  || req.query.p || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyPassword(clave, v.clave_hash)) return res.status(401).send('No autorizado');
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
    res.status(500).send(e.message);
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
// Intenta agregar la venta a la "venta abierta" de la vendedora; si esa venta
// ya no admite cambios (por ejemplo porque ya fue pickeada/despachada y la
// API tira error), abre una venta nueva automáticamente y la deja como la
// nueva "venta abierta" de esa vendedora.
async function intentarEnviarVenta({ productos, observacion, tipoVenta }, v) {
  const productosApi = (productos || []).map(p => ({ sku: p.sku, quantity: parseFloat(p.quantity) || 1 }));
  if (v.venta_abierta_id) {
    try {
      const r = await tempoAgregarProductos(v.venta_abierta_id, productosApi);
      return { idVenta: v.venta_abierta_id, nombreOdoo: r.Nombre || v.venta_abierta_nombre };
    } catch (e) {
      console.warn(`⚠ venta abierta ${v.venta_abierta_id} de ${v.codigo} ya no admite cambios (${shortErr(e)}), se abre una nueva`);
    }
  }
  const r = await tempoCrearVenta({ vendorEmail: v.email, observacion, tipoVenta, productos: productosApi });
  await sql`UPDATE vendedoras SET venta_abierta_id = ${r.Id_Venta}, venta_abierta_nombre = ${r.Nombre} WHERE id = ${v.id}`;
  return { idVenta: r.Id_Venta, nombreOdoo: r.Nombre };
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
    const clave  = req.headers['x-client-pass']  || req.query.p || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyPassword(clave, v.clave_hash)) return res.status(401).json({ error: 'No autorizado' });

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
    if (!res.headersSent) res.status(500).json({ error: shortErr(e) });
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
    const precioBySku = {}; prods.forEach(p => { precioBySku[p.sku] = p.precio; });
    const mult = req.multiplicador || 2;
    let total = 0;
    productos.forEach(p => { total += (precioBySku[p.sku] || 0) * mult * (parseFloat(p.quantity) || 1); });

    const entregaFinal = entrega === 'retiro' ? 'retiro' : 'despacho';
    const notaFinal = [nombreVenta, telefono, email, nota, metodoPago ? 'Método: ' + metodoPago : ''].filter(Boolean).join(' | ');

    let idVenta = null, nombreOdoo = null, errorMsg = null;
    try {
      const r = await intentarEnviarVenta({
        productos, observacion: notaFinal,
        tipoVenta: entregaFinal === 'retiro' ? 'Retiro' : 'Despacho'
      }, req.vendedora);
      idVenta = r.idVenta; nombreOdoo = r.nombreOdoo;
    } catch (e) { errorMsg = shortErr(e); console.error('❌ envío a API Temponovo', e.message); }

    const estado = (idVenta && !errorMsg) ? 'enviada' : 'error';
    const { rows } = await sql`
      INSERT INTO ventas_pendientes
        (vendedora_id, productos, nombre_venta, telefono, email, direccion, comuna, entrega, nota, total, estado, odoo_order_id, odoo_venta_nombre, error_msg, consolidado_at)
      VALUES
        (${req.vendedora.id}, ${JSON.stringify(productos)}, ${nombreVenta || ''},
         ${telefono || ''}, ${email || ''}, ${entregaFinal === 'retiro' ? '' : (direccion || '')}, ${comuna || ''}, ${entregaFinal}, ${notaFinal}, ${Math.round(total)},
         ${estado}, ${idVenta}, ${nombreOdoo}, ${errorMsg}, ${estado === 'enviada' ? new Date() : null})
      RETURNING id`;

    if (errorMsg) {
      return res.status(502).json({
        error: 'La venta quedó guardada, pero no se pudo enviar a Odoo todavía: ' + errorMsg,
        orderId: rows[0].id, pending: true
      });
    }
    res.json({ ok: true, orderId: rows[0].id, ventaOdoo: nombreOdoo, message: 'Venta enviada a Odoo (' + nombreOdoo + ')' });
  } catch (e) { console.error('❌ /api/pedido', e.message); res.status(500).json({ error: shortErr(e) }); }
});

app.get('/api/pedidos', requireClient, async (req, res) => {
  try {
    const { rows } = await sql`
      SELECT * FROM ventas_pendientes WHERE vendedora_id = ${req.vendedora.id} ORDER BY created_at DESC LIMIT 200`;
    res.json(rows.map(o => ({
      id: o.id,
      nombre: o.odoo_venta_nombre || ('V' + String(o.id).padStart(6, '0')),
      fecha: o.created_at,
      estado: o.estado, // 'enviada' | 'error'
      total: parseFloat(o.total || 0),
      neto: parseFloat(o.total || 0),
      nota: o.estado === 'error' && o.error_msg ? ('⚠ No se pudo enviar: ' + o.error_msg) : (o.nota || ''),
      ref: o.nombre_venta || '',
      entrega: o.entrega || 'despacho',
      lineas: (o.productos || []).map(p => ({ sku: p.sku, categoria: '', cantidad: p.quantity, total: 0 }))
    })));
  } catch (e) { console.error('❌ /api/pedidos', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// ── CONFIG DE LA VENDEDORA (persistente, multi-dispositivo) ─────
app.get('/api/config', requireClient, async (req, res) => {
  try { res.json(await readCfg(req.vendedora.codigo, req.partnerId)); }
  catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.post('/api/config', requireClient, async (req, res) => {
  try {
    const cfg = req.body?.data || {};
    if (JSON.stringify(cfg).length > 300000) return res.status(413).json({ error: 'Configuración demasiado grande (logo muy pesado)' });
    await writeCfg(req.vendedora.codigo, req.partnerId, cfg);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── VITRINA PÚBLICA (link compartible, solo lectura) ─────────────
app.get('/api/public/:slug/config', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Vitrina no encontrada' });
    const cfg = await readCfg(c.code, c.partnerId);
    const { nombre, slogan, logo, hdr, fondo, f1, f2, radius, welcome, tags, tagMap } = cfg;
    res.json({ nombre: nombre || c.name, slogan, logo, hdr, fondo, f1, f2, radius, welcome, tags, tagMap });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.get('/api/public/:slug/productos', async (req, res) => {
  try {
    const c = await publicClienteBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Vitrina no encontrada' });
    const hit = cacheGet('pub_' + req.params.slug); if (hit) return res.json(hit);
    const cfg = await readCfg(c.code, c.partnerId);
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
        categoria: p.categoria, atributos: p.atributos,
        precioVenta: ov[p.sku] > 0 ? Math.round(ov[p.sku]) : Math.round(p.precio * mult)
      }));
    cacheSet('pub_' + req.params.slug, result, 10 * 60 * 1000);
    res.json(result);
  } catch (e) { console.error('❌ /api/public/productos', e.message); res.status(500).json({ error: shortErr(e) }); }
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
  } catch (e) { res.status(500).send(shortErr(e)); }
});

// ── QUIERO VENDER — formulario público → correo ─────────────────
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
    const codigo = (req.headers['x-client-code'] || '').toUpperCase();
    const clave  = req.headers['x-client-pass'] || '';
    const v = await getVendedora(codigo);
    if (!v || !v.activo || !verifyPassword(clave, v.clave_hash)) return res.status(401).json({ error: 'Cliente no reconocido' });
    res.json({ name: v.nombre, multiplicador: parseFloat(v.multiplicador) || 2, sucursales: v.sucursales || [], publicSlug: slugOf(v.codigo) });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'Falta ADMIN_PASSWORD en las variables de entorno del servidor' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Clave incorrecta' });
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
    const { rows } = await sql`SELECT id, codigo, nombre, email, multiplicador, categorias, sucursales, activo, created_at, venta_abierta_id, venta_abierta_nombre FROM vendedoras ORDER BY nombre`;
    res.json(rows); // nunca se devuelve clave_hash
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
      RETURNING id, codigo, nombre, email, multiplicador, categorias, sucursales, activo, created_at, venta_abierta_id, venta_abierta_nombre`;
    if (!rows.length) return res.status(404).json({ error: 'Vendedora no encontrada' });
    delete cache['cat_' + rows[0].codigo]; // refresca catálogo si cambió multiplicador/categorías
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.delete('/api/admin/vendedoras/:id', requireAdmin, async (req, res) => {
  try { await sql`DELETE FROM vendedoras WHERE id = ${req.params.id}`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// La "venta abierta" es donde se van agregando los próximos pedidos de la
// vendedora vía /sale/update. Cerrarla fuerza que el próximo pedido abra
// una venta nueva en Odoo con /sale/create.
app.post('/api/admin/vendedoras/:id/cerrar-venta', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`UPDATE vendedoras SET venta_abierta_id = NULL, venta_abierta_nombre = NULL WHERE id = ${req.params.id} RETURNING id`;
    if (!rows.length) return res.status(404).json({ error: 'Vendedora no encontrada' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

// ── Precios fijos por vendedora (Excel) — se guardan como "overrides" en
// su misma configuración visual (vitrina-cfg-<codigo>), igual que antes ──
app.get('/api/admin/vendedoras/:id/precios/base', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM vendedoras WHERE id = ${req.params.id}`;
    const v = rows[0]; if (!v) return res.status(404).json({ error: 'Vendedora no encontrada' });
    const cfg0 = await getConfig();
    if (!cfg0.partner_id) return res.status(400).json({ error: 'Falta configurar el Partner ID en Configuración' });
    let prods = await productosCliente({ partnerId: cfg0.partner_id });
    const categorias = v.categorias || [];
    if (categorias.length) prods = prods.filter(p => categorias.includes(famOf(p.categoria)));
    const cfg = await readCfg(v.codigo, cfg0.partner_id);
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
    const cfg = await readCfg(v.codigo, cfg0.partner_id);
    cfg.overrides = { ...(cfg.overrides || {}) };
    let n = 0;
    Object.entries(precios).forEach(([sku, precio]) => {
      const pr = parseFloat(precio);
      if (sku && pr > 0) { cfg.overrides[String(sku).toUpperCase()] = Math.round(pr); n++; }
    });
    await writeCfg(v.codigo, cfg0.partner_id, cfg);
    delete cache['cat_' + v.codigo]; delete cache['pub_' + slugOf(v.codigo)];
    res.json({ ok: true, actualizados: n });
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});
app.delete('/api/admin/vendedoras/:id/precios', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM vendedoras WHERE id = ${req.params.id}`;
    const v = rows[0]; if (!v) return res.status(404).json({ error: 'Vendedora no encontrada' });
    const cfg0 = await getConfig();
    const cfg = await readCfg(v.codigo, cfg0.partner_id);
    cfg.overrides = {};
    await writeCfg(v.codigo, cfg0.partner_id, cfg);
    delete cache['cat_' + v.codigo]; delete cache['pub_' + slugOf(v.codigo)];
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
          SELECT vp.*, v.nombre AS vendedora_nombre, v.codigo AS vendedora_codigo
          FROM ventas_pendientes vp JOIN vendedoras v ON v.id = vp.vendedora_id
          WHERE vp.estado = ${estado} ORDER BY vp.created_at DESC`
      : await sql`
          SELECT vp.*, v.nombre AS vendedora_nombre, v.codigo AS vendedora_codigo
          FROM ventas_pendientes vp JOIN vendedoras v ON v.id = vp.vendedora_id
          ORDER BY vp.created_at DESC LIMIT 500`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.post('/api/admin/ventas/:id/reintentar', requireAdmin, async (req, res) => {
  try {
    const { rows } = await sql`SELECT * FROM ventas_pendientes WHERE id = ${req.params.id}`;
    const venta = rows[0]; if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    if (venta.estado === 'enviada') return res.status(400).json({ error: 'Esta venta ya fue enviada a Odoo' });
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

app.get('/api/admin/reporte', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await sql`
      SELECT v.id AS vendedora_id, v.nombre AS vendedora_nombre, v.codigo,
             COUNT(vp.id) AS ventas, COALESCE(SUM(vp.total), 0) AS total,
             COUNT(vp.id) FILTER (WHERE vp.estado = 'error') AS con_error
      FROM vendedoras v
      LEFT JOIN ventas_pendientes vp ON vp.vendedora_id = v.id
      GROUP BY v.id, v.nombre, v.codigo
      ORDER BY v.nombre`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: shortErr(e) }); }
});

app.get('/health', async (_req, res) => {
  let dbOk = false;
  try { await sql`SELECT 1`; dbOk = true; } catch {}
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    config: {
      odooUrl: ODOO_URL, odooDb: ODOO_DB, userSet: !!ODOO_USER, passwordSet: !!ODOO_PASS,
      adminPasswordSet: !!ADMIN_PASSWORD, tempoApiKeySet: !!TEMPO_API_KEY, tempoApiUrl: TEMPO_API_URL, db: dbOk
    }
  });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Temponovo Vitrina API en puerto ${PORT}`));
}
