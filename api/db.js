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

// Verifica el certificado TLS del proveedor de Postgres por defecto (Neon,
// Vercel Postgres y similares usan certificados de una CA pública, así que
// esto funciona sin configuración extra). Si alguna vez hace falta conectar
// a un Postgres con certificado autofirmado, se puede desactivar la
// verificación a propósito con PGSSL_INSECURE=1 — nunca por defecto.
const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: process.env.PGSSL_INSECURE !== '1' } : undefined
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
