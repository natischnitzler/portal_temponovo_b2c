const express = require('express');
const xmlrpc  = require('xmlrpc');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIGURACIÓN ODOO TEMPONOVO ─────────────────────────────────
const ODOO_URL  = process.env.ODOO_URL  || 'https://temponovo.odoo.com';
// En Odoo SaaS (*.odoo.com) la base suele llamarse igual que el subdominio
const DB_GUESS  = new URL(ODOO_URL).hostname.split('.')[0];
const ODOO_DB   = process.env.ODOO_DB   || DB_GUESS;
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASS = process.env.ODOO_PASSWORD || '';

// Filtro opcional de categorías (complete_name separadas por "|")
// Ej: CATEGORIAS="Relojes / Hombre|Relojes / Mujer"
const CATEGORIAS_OK = (process.env.CATEGORIAS || '')
  .split('|').map(s => s.trim()).filter(Boolean);

// ── CLIENTES DESDE CSV ───────────────────────────────────────────
function loadClientes() {
  const file = path.join(__dirname, '..', 'clientes.csv');
  if (!fs.existsSync(file)) { console.warn('⚠ No se encontró clientes.csv'); return {}; }
  const raw = fs.readFileSync(file, 'utf8');
  const sep = raw.split(/\r?\n/)[0].includes(';') ? ';' : ',';
  function parseLine(line) {
    const f = []; let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === sep && !inQ) { f.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    f.push(cur.trim()); return f;
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const p = parseLine(lines[i]);
    if (p.length < 3) continue;
    const codigo        = (p[0] || '').trim().toUpperCase();
    const nombre        = (p[1] || '').trim();
    const partnerId     = parseInt(p[2] || '0', 10);
    const multiplicador = parseFloat(p[3] || '2');
    const sucRaw        = (p[4] || '').replace(/^"|"$/g, '').trim();
    const sucursales    = sucRaw ? sucRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (codigo && partnerId) result[codigo] = { partnerId, name: nombre, multiplicador, sucursales };
  }
  console.log('✅ Clientes:', Object.keys(result).join(', '));
  return result;
}
const CLIENTES = loadClientes();
function getCliente(code) { return CLIENTES[(code || '').toUpperCase()] || null; }

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
// Acorta los tracebacks de Odoo al error real (última línea)
function shortErr(e) {
  const msg = (e && e.message) || String(e);
  const lines = msg.split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length > 1 ? lines[lines.length - 1] : msg;
}

const cache = {};
function cacheGet(k) { const e = cache[k]; if (!e) return null; if (Date.now() - e.ts > e.ttl) { delete cache[k]; return null; } return e.data; }
function cacheSet(k, d, ttl) { cache[k] = { data: d, ts: Date.now(), ttl }; }

// ── MIDDLEWARE ───────────────────────────────────────────────────
function requireClient(req, res, next) {
  const code = (req.headers['x-client-code'] || '').toUpperCase();
  const c = getCliente(code);
  if (!c) return res.status(401).json({ error: 'Cliente no reconocido' });
  req.partnerId = c.partnerId; req.clientName = c.name; req.multiplicador = c.multiplicador || 2;
  next();
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

    // Descripción desde el template
    const tmplIds = [...new Set(prods.map(p => Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id))];
    let tmplMap = {};
    if (tmplIds.length) {
      const tmpls = await xmlrpcCall('product.template', 'read', [tmplIds, ['id', 'description_sale']]);
      tmpls.forEach(t => { tmplMap[t.id] = t; });
    }

    // Atributos con nombre ("Color: Dorado", "Correa: Cuero"...)
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
        atributos,                                   // [{attr:'Color', val:'Dorado'}, ...]
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
    const code = (req.headers['x-client-code'] || '').toUpperCase();
    const cliente = getCliente(code);
    if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });

    const cached = cacheGet('cat_' + code); if (cached) return res.json(cached);

    let prods = await fetchProductos();

    // Precio según pricelist del cliente
    const plId = await getPricelistId(cliente.partnerId);
    if (plId && prods.length) {
      try {
        const ids = prods.map(p => p.id);
        const precios = await xmlrpcCall('product.pricelist', 'get_products_price',
          [[plId], ids, ids.map(() => 1), new Date().toISOString().slice(0, 10)]);
        prods = prods.map(p => ({ ...p, precio: parseFloat(precios[p.id] || p.precio) }));
      } catch (e) { console.warn('⚠ pricelist:', e.message); }
    }

    const mult = cliente.multiplicador || 2;
    const result = prods.map(p => ({
      ...p,
      precioSugerido: Math.round(p.precio * mult)
    }));

    cacheSet('cat_' + code, result, 15 * 60 * 1000);
    res.json(result);
  } catch (e) { console.error('❌ /api/productos', e.message); res.status(500).json({ error: shortErr(e) }); }
});

app.delete('/api/productos/cache', (_req, res) => {
  Object.keys(cache).filter(k => k.startsWith('productos') || k.startsWith('cat_') || k.startsWith('img_'))
    .forEach(k => delete cache[k]);
  res.json({ ok: true });
});

// ── IMAGEN INDIVIDUAL (miniatura o grande) ───────────────────────
// GET /api/imagen/:id?c=CODIGO&s=g   → image_1024 (detalle / probar)
// GET /api/imagen/:id?c=CODIGO       → image_256  (grilla)
app.get('/api/imagen/:id', async (req, res) => {
  try {
    const code = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    if (!getCliente(code)) return res.status(401).send('No autorizado');
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

// ── FOTOS EN ZIP (opcionalmente filtradas por familia) ───────────
// GET /api/fotos?c=CODIGO&familia=Relojes
app.get('/api/fotos', async (req, res) => {
  try {
    const code = (req.headers['x-client-code'] || req.query.c || '').toUpperCase();
    if (!getCliente(code)) return res.status(401).json({ error: 'No autorizado' });

    const familia = (req.query.familia || '').trim().toLowerCase();
    let prods = await fetchProductos();
    if (familia) {
      prods = prods.filter(p => {
        const parts = (p.categoria || '').split('/').map(x => x.trim()).filter(x => x && x.toLowerCase() !== 'all');
        return (parts[0] || '').toLowerCase() === familia;
      });
    }
    if (!prods.length) return res.status(404).json({ error: 'Sin productos para esa familia' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="temponovo-fotos${familia ? '-' + familia.replace(/[\s/]+/g, '-') : ''}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', e => { console.error('❌ zip', e.message); try { res.end(); } catch {} });
    archive.pipe(res);

    // Traer imágenes en tandas para no reventar memoria ni tiempos
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
// PEDIDOS — crear venta + historial
// ════════════════════════════════════════════════════════════════
app.post('/api/pedido', requireClient, async (req, res) => {
  try {
    const { productos, sucursal, nota } = req.body?.data || {};
    if (!productos?.length) return res.status(400).json({ error: 'Sin productos' });
    const skus = productos.map(p => p.sku);
    const prodRecs = await xmlrpcCall('product.product', 'search_read',
      [[['default_code', 'in', skus], ['active', '=', true]]], { fields: ['id', 'default_code'] });
    const skuToId = {};
    prodRecs.forEach(p => { skuToId[p.default_code] = p.id; });
    const orderLines = productos.filter(p => skuToId[p.sku])
      .map(p => [0, 0, { product_id: skuToId[p.sku], product_uom_qty: p.quantity, name: p.sku }]);
    if (!orderLines.length) return res.status(400).json({ error: 'Ningún SKU reconocido' });
    const orderId = await xmlrpcCall('sale.order', 'create', [{
      partner_id: req.partnerId,
      note: [sucursal, nota].filter(Boolean).join(' | '),
      order_line: orderLines
    }]);
    await xmlrpcCall('sale.order', 'action_confirm', [[orderId]]);
    res.json({ ok: true, orderId, message: 'Pedido creado en Odoo' });
  } catch (e) { console.error('❌ /api/pedido', e.message); res.status(500).json({ error: shortErr(e) }); }
});

app.get('/api/pedidos', requireClient, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');
    const ids = await xmlrpcCall('sale.order', 'search', [[
      ['partner_id', '=', req.partnerId],
      ['state', 'in', ['sale', 'done', 'cancel']]
    ]], { order: 'date_order desc', limit });
    if (!ids.length) return res.json([]);
    const orders = await xmlrpcCall('sale.order', 'read',
      [ids, ['name', 'date_order', 'state', 'amount_total', 'amount_untaxed', 'note']]);
    res.json(orders.map(o => ({
      id: o.id, nombre: o.name, fecha: o.date_order, estado: o.state,
      total: parseFloat(o.amount_total || 0), neto: parseFloat(o.amount_untaxed || 0), nota: o.note || ''
    })));
  } catch (e) { console.error('❌ /api/pedidos', e.message); res.status(500).json({ error: shortErr(e) }); }
});

// ── PERFIL ───────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const code = (req.headers['x-client-code'] || '').toUpperCase();
  const c = getCliente(code);
  if (!c) return res.status(401).json({ error: 'Cliente no reconocido' });
  res.json({ name: c.name, partnerId: c.partnerId, multiplicador: c.multiplicador || 2, sucursales: c.sucursales || [] });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  ts: new Date().toISOString(),
  config: {
    odooUrl: ODOO_URL,
    odooDb: ODOO_DB,
    userSet: !!ODOO_USER,
    passwordSet: !!ODOO_PASS,
    clientes: Object.keys(CLIENTES).length
  }
}));

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Temponovo Vitrina API en puerto ${PORT}`));
}
