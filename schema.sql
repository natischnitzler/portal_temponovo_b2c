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
  multiplicador NUMERIC DEFAULT 2,
  categorias JSONB DEFAULT '[]',   -- [] = todas las categorías; si no, lista blanca de familias
  sucursales JSONB DEFAULT '[]',
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ventas_pendientes (
  id SERIAL PRIMARY KEY,
  vendedora_id INTEGER NOT NULL REFERENCES vendedoras(id) ON DELETE CASCADE,
  productos JSONB NOT NULL,        -- [{sku, quantity}, ...]
  nombre_venta TEXT,
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  comuna TEXT,
  entrega TEXT DEFAULT 'despacho', -- 'despacho' | 'retiro'
  nota TEXT,
  total NUMERIC DEFAULT 0,
  estado TEXT DEFAULT 'error',     -- 'enviada' (llegó a Odoo por la API) | 'error' (falló, hay que reintentar)
  odoo_order_id INTEGER,           -- Id_Venta devuelto por la API (POST /sale/create o /sale/update)
  odoo_venta_nombre TEXT,          -- Nombre de la venta en Odoo (ej. "S06819")
  error_msg TEXT,                  -- detalle del error si estado = 'error'
  seguimiento TEXT NOT NULL DEFAULT 'recibido', -- avance logístico: 'recibido'|'preparando'|'en_transito'|'entregado' — lo cambia solo el admin, la vitrina nunca sabe de Odoo
  seguimiento_at TIMESTAMPTZ DEFAULT now(),     -- cuándo cambió por última vez el seguimiento
  created_at TIMESTAMPTZ DEFAULT now(),
  consolidado_at TIMESTAMPTZ       -- momento en que quedó 'enviada' (se mantiene el nombre de columna por compatibilidad)
);
