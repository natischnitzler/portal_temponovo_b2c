// db.js — conexión a Postgres (Neon / Vercel Postgres / cualquier proveedor estándar).
// Lee la cadena de conexión que Vercel inyecta automáticamente al conectar una base
// de datos desde el dashboard (Storage → Postgres → Connect to Project).
const { Pool } = require('pg');

const connectionString =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  '';

if (!connectionString) {
  console.warn('⚠ No hay POSTGRES_URL/DATABASE_URL configurada — conecta una base de datos en Vercel → Storage.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : undefined
});

// Tagged template mínimo, compatible con el mismo patrón `sql\`SELECT ...${x}...\``
// que usa @vercel/postgres, pero corriendo sobre pg (que sí sigue mantenido).
function sql(strings, ...values) {
  let text = strings[0];
  const params = [];
  values.forEach((v, i) => {
    params.push(v);
    text += `$${i + 1}` + strings[i + 1];
  });
  return pool.query(text, params);
}

module.exports = { sql, pool };
