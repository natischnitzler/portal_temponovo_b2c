-- Esquema de la base de datos de Vitrina.
-- No hace falta correr esto a mano: el backend crea estas tablas solo
-- (CREATE TABLE IF NOT EXISTS) la primera vez que recibe una request.
-- Se deja aquí solo como referencia para entender la estructura.
--
-- Hay UNA sola empresa (la que compra en Odoo). Sus datos (nombre y
-- Partner ID) viven en la tabla "configuracion", que siempre tiene una
-- única fila (id = 1). Ya no existe una tabla "empresas" con varias filas.

CREATE TABLE IF NOT EXISTS configuracion (
  id INTEGER PRIMARY KEY DEFAULT 1,
  nombre TEXT NOT NULL DEFAULT '',
  partner_id INTEGER,             -- ID del partner en Odoo al que se le factura
  venta_abierta_id INTEGER,       -- Id_Venta en Odoo — UNA sola, compartida por todas las vendedoras
  venta_abierta_nombre TEXT,      -- Nombre de esa venta (ej. "S06819"), solo para mostrar
  updated_at TIMESTAMPTZ DEFAULT now(),
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS vendedoras (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,     -- usuario con el que entra a la vitrina
  clave_hash TEXT NOT NULL,        -- nunca se guarda la clave en texto plano
  nombre TEXT NOT NULL,
  email TEXT DEFAULT '',           -- solo dato de referencia (no se usa para autenticar contra la API)
  multiplicador NUMERIC DEFAULT 2, -- histórico, sin uso: el precio de venta ya no es por vendedora (ver catalogo_productos/categoria_multiplicador)
  comision NUMERIC DEFAULT 0,      -- % que se lleva la vendedora sobre la ganancia (precio de venta − costo) de cada venta
  categorias JSONB DEFAULT '[]',   -- [] = todas las categorías; si no, lista blanca de familias
  sucursales JSONB DEFAULT '[]',
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Lista de precios global: el mismo precio de venta para cualquier
-- vendedora. "disponible=false" saca el producto de TODAS las vitrinas (de
-- cada vendedora y de la pública) — es curación de catálogo a nivel
-- empresa, no el "ocultar" que cada vendedora ya tiene para su propia
-- vitrina (eso vive en vendedora_config, aparte).
CREATE TABLE IF NOT EXISTS catalogo_productos (
  sku TEXT PRIMARY KEY,
  precio NUMERIC,                  -- precio fijo; NULL = usa el multiplicador de su categoría
  disponible BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Multiplicador por categoría (familia) — el precio de venta por defecto
-- (costo del proveedor × este número) para lo que no tiene precio fijo en
-- catalogo_productos. Sin fila para una categoría, se usa el default (×2).
CREATE TABLE IF NOT EXISTS categoria_multiplicador (
  familia TEXT PRIMARY KEY,
  multiplicador NUMERIC NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Proveedores del catálogo (Temponovo, Aviv, futuros). Cada uno tiene su
-- propia conexión a Odoo (o es 'manual', sin Odoo) y su propio partner_id /
-- venta abierta — reemplaza la configuración global única de más arriba.
-- odoo_password_enc / venta_api_key_enc están cifrados con CREDENTIALS_KEY
-- (AES-256-GCM) — nunca se guardan ni se devuelven en texto plano.
-- Fase 0: la tabla existe y se siembra automáticamente con "temponovo" desde
-- las variables de entorno existentes; el resto del código todavía no lee
-- de acá (eso llega en una fase siguiente).
CREATE TABLE IF NOT EXISTS proveedores (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,      -- slug inmutable, ej. 'temponovo', 'aviv'
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'odoo', -- 'odoo' | 'manual'
  activo BOOLEAN DEFAULT true,
  partner_id INTEGER,                -- solo tipo='odoo'
  odoo_url TEXT, odoo_db TEXT, odoo_user TEXT, odoo_password_enc TEXT,
  venta_api_url TEXT, venta_api_key_enc TEXT, venta_vendor_email TEXT,
  venta_abierta_id INTEGER, venta_abierta_nombre TEXT,
  categorias_filtro JSONB DEFAULT '[]',
  orden INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ventas_pendientes (
  id SERIAL PRIMARY KEY,
  -- RESTRICT (no CASCADE): una vendedora con ventas registradas no se puede
  -- borrar, para no perder historial con valor contable. Se desactiva en
  -- cambio (columna "activo" en vendedoras).
  vendedora_id INTEGER NOT NULL REFERENCES vendedoras(id) ON DELETE RESTRICT,
  productos JSONB NOT NULL,        -- [{sku, quantity, categoria, total, costo, comision}, ...] — por línea, para reportar sin volver a leer el catálogo; costo/comision grabados al momento de la venta (no se recalculan después)
  nombre_venta TEXT,
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  comuna TEXT,
  entrega TEXT DEFAULT 'despacho', -- 'despacho' | 'retiro'
  nota TEXT,
  total NUMERIC DEFAULT 0,
  comision NUMERIC DEFAULT 0,      -- suma de la comisión de todas las líneas, grabada al momento de la venta
  estado TEXT DEFAULT 'error',     -- 'enviada' (llegó a Odoo por la API) | 'error' (falló, hay que reintentar) | 'cancelada' (el admin la canceló)
  odoo_order_id INTEGER,           -- Id_Venta devuelto por la API (POST /sale/create o /sale/update)
  odoo_venta_nombre TEXT,          -- Nombre de la venta en Odoo (ej. "S06819")
  error_msg TEXT,                  -- detalle del error si estado = 'error', o motivo si estado = 'cancelada'
  seguimiento TEXT NOT NULL DEFAULT 'recibido', -- avance logístico: 'recibido'|'preparando'|'en_transito'|'entregado' — lo cambia solo el admin, la vitrina nunca sabe de Odoo
  seguimiento_at TIMESTAMPTZ DEFAULT now(),     -- cuándo cambió por última vez el seguimiento
  -- Portal multi-proveedor (fase 0 — columnas creadas pero todavía sin usar
  -- en ningún flujo; todo sigue siendo un solo proveedor "temponovo" hasta
  -- que se complete el split real de ventas):
  grupo_id UUID,                   -- comparte valor entre las N filas de UN pedido, cuando se separe por proveedor
  proveedor_id INTEGER REFERENCES proveedores(id),
  orden_secuencia INTEGER,         -- número de pedido del cliente, calculado una vez por grupo_id
  estado_manual TEXT,              -- solo si el proveedor es tipo 'manual' (sin Odoo)
  created_at TIMESTAMPTZ DEFAULT now(),
  consolidado_at TIMESTAMPTZ       -- momento en que quedó 'enviada' (se mantiene el nombre de columna por compatibilidad)
);

-- Información libre de producto, cargada por el admin desde un Excel.
-- Odoo aporta código/precio/stock/foto; esto aporta la info comercial que
-- Odoo no tiene, con columnas 100% libres. Una fila por SKU (o resuelta por
-- código de barra al subir el Excel), "campos" es un JSON
-- { "Título de columna": "valor" } tal como venía en el Excel.
CREATE TABLE IF NOT EXISTS producto_info (
  sku TEXT PRIMARY KEY,
  campos JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);
