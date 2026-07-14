# Temponovo · Vitrina de Relojes

Portal para revendedoras: entran con su código y clave, ven los relojes en
grande, arman pedidos, y esos pedidos quedan **pendientes** hasta que el
administrador los junta ("consolida") en una sola venta en Odoo.

## Estructura del negocio

- **La empresa** — es una sola: quien realmente le compra a Temponovo en
  Odoo (tiene un `partnerId`). Su nombre y su Partner ID se configuran una
  sola vez desde el Panel de Admin → **Configuración**.
- **Vendedora** — una persona que usa la Vitrina para vender. Tiene su
  propio usuario/clave, su propio multiplicador de precio y sus propias
  categorías habilitadas.
- **Venta pendiente** — cada pedido que hace una vendedora queda guardado
  como pendiente. El administrador las revisa y las **consolida**: se
  juntan todas las ventas pendientes en un solo pedido en Odoo, a nombre
  del `partnerId` configurado.

Todo esto se administra desde el **Panel de Admin** (`/admin`), con su
propia clave — ahí se configura la empresa, se crean/editan Vendedoras, se
ven las ventas pendientes y se consolidan.

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
3. Listo. Las tablas (`configuracion`, `vendedoras`, `ventas_pendientes`)
   se crean solas la primera vez que el sitio recibe una visita — no hay
   que correr nada a mano (`schema.sql` queda solo como referencia).

### 3. Primera configuración y Vendedoras

Desde el Panel de Admin (`/admin` → **Configuración**) pones el nombre de
tu empresa y el `partnerId` de Odoo al que se le facturan todas las
ventas. Después, desde **Vendedoras**, creas cada vendedora (usuario,
clave, nombre, multiplicador, categorías que vende).

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
| GET    | /api/config · POST /api/config | Personalización de la vitrina (logo, colores, etc.) — de cada vendedora |
| POST   | /api/admin/login                | Login del panel de admin                             |
| GET/PUT /api/admin/config       | Nombre y Partner ID de la empresa (una sola)        |
| GET/POST/PUT/DELETE /api/admin/vendedoras   | CRUD de Vendedoras                     |
| GET    | /api/admin/ventas               | Ventas pendientes/consolidadas, filtrables por estado |
| POST   | /api/admin/consolidar            | Junta TODAS las ventas pendientes en un pedido de Odoo |
| GET    | /api/admin/reporte               | Ventas por vendedora                                  |
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
  `DELETE /api/productos/cache` (requiere sesión de admin).
- Ya no existe la importación de `clientes.csv` ni el concepto de varias
  Empresas: el portal es para una sola empresa, configurada en
  `/admin` → Configuración. El archivo `clientes.csv` no se usa más y se
  puede borrar del proyecto.
