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
  partner_id INTEGER,            -- ID del partner en Odoo al que se le factura
  updated_at TIMESTAMPTZ DEFAULT now(),
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS vendedoras (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,     -- usuario con el que entra a la vitrina
  clave_hash TEXT NOT NULL,        -- nunca se guarda la clave en texto plano
  nombre TEXT NOT NULL,
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
  nota TEXT,
  total NUMERIC DEFAULT 0,
  estado TEXT DEFAULT 'pendiente', -- 'pendiente' | 'consolidada'
  odoo_order_id INTEGER,           -- se completa al consolidar
  created_at TIMESTAMPTZ DEFAULT now(),
  consolidado_at TIMESTAMPTZ
);
