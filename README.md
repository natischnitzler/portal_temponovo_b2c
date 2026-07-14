# Temponovo · Vitrina de Relojes

Portal para revendedoras: entran con su código y clave, ven los relojes en
grande, arman pedidos, y esos pedidos quedan **pendientes** hasta que el
administrador los junta ("consolida") en una sola venta en Odoo por Empresa.

## Estructura del negocio

- **Empresa** — quien realmente le compra a Temponovo en Odoo (tiene un
  `partnerId`). Ej: "Empresa Tali".
- **Vendedora** — una persona que usa la Vitrina para vender. Pertenece a una
  Empresa, tiene su propio usuario/clave, su propio multiplicador de precio y
  sus propias categorías habilitadas. Varias vendedoras pueden pertenecer a
  la misma Empresa.
- **Venta pendiente** — cada pedido que hace una vendedora queda guardado
  como pendiente, asociado a su Empresa. El administrador las revisa y las
  **consolida**: se juntan todas las ventas pendientes de una Empresa en un
  solo pedido en Odoo, a nombre del `partnerId` de esa Empresa.

Todo esto se administra desde el **Panel de Admin** (`/admin`), con su
propia clave — ahí se crean/editan Empresas y Vendedoras, se ven las ventas
pendientes y se consolidan.

## Configuración

### 1. Variables de entorno (Vercel → Settings → Environment Variables)

| Variable         | Valor                                                          |
|-------------------|----------------------------------------------------------------|
| `ODOO_URL`        | `https://temponovo.odoo.com` (valor por defecto)               |
| `ODOO_DB`         | Nombre de la base de datos Odoo de Temponovo                   |
| `ODOO_USER`       | Email del usuario admin de Odoo                                |
| `ODOO_PASSWORD`   | Contraseña o API key del admin                                 |
| `CATEGORIAS`      | Opcional. Categorías a mostrar separadas por `\|`.              |
| `ADMIN_PASSWORD`  | Clave para entrar al Panel de Admin (`/admin`)                 |
| `ADMIN_SECRET`    | Cualquier texto largo al azar (firma las sesiones de admin)    |
| `POSTGRES_URL`    | La inyecta Vercel solo al conectar la base de datos (ver abajo)|

### 2. Base de datos (obligatorio)

1. Vercel → tu proyecto → **Storage** → **Create Database** → **Postgres**
   (o Neon, es el mismo motor).
2. Conéctala a este proyecto — Vercel agrega `POSTGRES_URL` solo.
3. Listo. Las tablas (`empresas`, `vendedoras`, `ventas_pendientes`) se
   crean solas la primera vez que el sitio recibe una visita — no hay que
   correr nada a mano (`schema.sql` queda solo como referencia).

### 3. Primeras Empresas y Vendedoras

Desde el Panel de Admin (`/admin`) creas la Empresa (nombre + `partnerId` de
Odoo) y luego las Vendedoras dentro de ella (usuario, clave, nombre,
multiplicador, categorías que vende).

Si ya tenías clientas en el antiguo `clientes.csv`, el admin tiene un botón
**"Importar clientes.csv"** que las migra automáticamente: crea una Empresa
por cada una (con su mismo `partnerId`) y una Vendedora con clave temporal
(se muestra una sola vez — anótala y pásasela a cada una para que después la
cambie).

### 4. Despliegue

```bash
npm i -g vercel
vercel --prod
```

## Endpoints API

| Método | Ruta                          | Descripción                                        |
|--------|-------------------------------|-----------------------------------------------------|
| GET    | /api/me                       | Perfil de la vendedora (requiere código + clave)    |
| GET    | /api/productos                | Catálogo con precio y sugerido                       |
| GET    | /api/imagen/:id                | Imagen del producto                                  |
| POST   | /api/pedido                    | Crea una venta **pendiente** (no toca Odoo todavía)  |
| GET    | /api/pedidos                   | Historial de ventas de la vendedora (pendientes + consolidadas) |
| GET    | /api/config · POST /api/config | Personalización de la vitrina (logo, colores, etc.) |
| POST   | /api/admin/login                | Login del panel de admin                             |
| GET/POST/PUT/DELETE /api/admin/empresas     | CRUD de Empresas                       |
| GET/POST/PUT/DELETE /api/admin/vendedoras   | CRUD de Vendedoras                     |
| GET    | /api/admin/ventas               | Ventas pendientes/consolidadas, filtrables por empresa |
| POST   | /api/admin/consolidar/:empresaId | Junta las ventas pendientes de una Empresa en un pedido de Odoo |
| GET    | /api/admin/reporte               | Ventas por vendedora/empresa                          |
| GET    | /health                          | Health check (incluye si la base de datos conecta)   |

## Notas técnicas

- Las contraseñas de las vendedoras se guardan **hasheadas** (nunca en texto
  plano), con `crypto.scrypt` de Node — no se necesita ninguna librería
  extra.
- La sesión del admin es un token firmado (HMAC) con expiración de 12 horas,
  sin necesitar una tabla de sesiones.
- La personalización visual (logo, colores, tipografía, etiquetas) de cada
  vendedora se sigue guardando como antes, como un archivo adjunto en el
  partner de Odoo — no se movió a la base de datos nueva.
- El catálogo se cachea 30 min y se puede limpiar con
  `DELETE /api/productos/cache` (ahora requiere sesión de admin).
