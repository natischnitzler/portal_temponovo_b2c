# Temponovo · Vitrina de Relojes

Portal para revendedoras: entran con su código y clave, ven los relojes en
grande, arman pedidos, y esos pedidos se envían **al instante** a Odoo a
través de la API de ventas de Temponovo (no XML-RPC directo).

## Estructura del negocio

- **La empresa** — es una sola: quien realmente le compra a Temponovo en
  Odoo (tiene un `partnerId`). Su nombre y su Partner ID se configuran una
  sola vez desde el Panel de Admin → **Configuración**.
- **Vendedora** — una persona que usa la Vitrina para vender. Tiene su
  propio usuario/clave, su propio multiplicador de precio, sus propias
  categorías habilitadas y, si quiere, precios fijos por producto.
- **Venta** — cada pedido que hace una vendedora se envía de inmediato a
  Odoo por la API: el primer pedido de una "tanda" abre una venta nueva
  (`POST /sale/create`) y los siguientes se van agregando a esa misma venta
  (`POST /sale/update`) mientras Odoo lo permita. En cuanto la API rechaza
  el `/sale/update` (por ejemplo porque la venta ya fue pickeada/despachada),
  el portal abre sola una venta nueva para el próximo pedido. Si el envío
  falla por completo (sin conexión, etc.), el pedido queda guardado con
  estado **"Con error"** y se puede reintentar desde el Panel de Admin →
  **Ventas**.

Todo esto se administra desde el **Panel de Admin** (`/admin`), con su
propia clave — ahí se configura la empresa, se crean/editan Vendedoras
(incluyendo sus precios fijos en Excel), se ven las ventas y se reintentan
las que hayan fallado.

## Configuración

### 1. Variables de entorno (Vercel → Settings → Environment Variables)

| Variable            | Valor                                                          |
|-----------------------|----------------------------------------------------------------|
| `ODOO_URL`           | `https://temponovo.odoo.com` (valor por defecto) — solo para leer catálogo/stock/imágenes por XML-RPC |
| `ODOO_DB`            | Nombre de la base de datos Odoo de Temponovo                   |
| `ODOO_USER`          | Email del usuario admin de Odoo (para XML-RPC de catálogo)     |
| `ODOO_PASSWORD`      | Contraseña o API key del admin (para XML-RPC de catálogo)      |
| `TEMPONOVO_API_URL`  | `https://cmcorpcl-temponovo.odoo.com` (valor por defecto) — API de ventas |
| `TEMPONOVO_API_KEY`  | API key entregada por Temponovo para crear/editar ventas       |
| `CATEGORIAS`         | Opcional. Categorías a mostrar separadas por `\|`.              |
| `ADMIN_PASSWORD`     | Clave para entrar al Panel de Admin (`/admin`)                 |
| `ADMIN_SECRET`       | Cualquier texto largo al azar (firma las sesiones de admin)    |
| `POSTGRES_URL`       | La inyecta Vercel solo al conectar la base de datos (ver abajo)|

Nota: XML-RPC (`ODOO_*`) se sigue usando solo para leer catálogo, stock,
imágenes y precios de lista — **nunca** para crear ventas. Las ventas
siempre pasan por `TEMPONOVO_API_URL` / `TEMPONOVO_API_KEY`.

### 2. Base de datos (obligatorio)

1. Vercel → tu proyecto → **Storage** → **Create Database** → **Postgres**
   (o Neon, es el mismo motor).
2. Conéctala a este proyecto — Vercel agrega `POSTGRES_URL` solo.
3. Listo. Las tablas (`configuracion`, `vendedoras`, `ventas_pendientes`)
   y sus columnas nuevas se crean/actualizan solas la primera vez que el
   sitio recibe una visita — no hay que correr nada a mano (`schema.sql`
   queda solo como referencia).

### 3. Primera configuración y Vendedoras

Desde el Panel de Admin (`/admin` → **Configuración**) pones el nombre de
tu empresa y el `partnerId` de Odoo al que se le facturan todas las
ventas. Después, desde **Vendedoras**, creas cada vendedora (usuario,
clave, nombre, email para `vendor_email`, multiplicador, categorías que
vende). Ahí mismo puedes:

- **Descargar precios** — baja un Excel con el código, nombre y precio de
  venta actual de cada producto para esa vendedora.
- **Subir precios** — sube ese mismo Excel editado (o cualquier Excel con
  columnas de código y precio) para fijar precios de venta específicos por
  producto, que mandan por sobre el multiplicador.
- **Quitar precios fijos** — vuelve todo al cálculo por multiplicador.
- **Cerrar venta abierta** — si quieres forzar que el próximo pedido de esa
  vendedora abra una venta nueva en Odoo en vez de sumarse a la actual.

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
| POST   | /api/pedido                    | Crea/agrega la venta en Odoo vía la API de ventas (al instante) |
| GET    | /api/pedidos                   | Historial de ventas de la vendedora                  |
| GET    | /api/config · POST /api/config | Personalización de la vitrina (logo, colores, etc.) — de cada vendedora |
| POST   | /api/admin/login                | Login del panel de admin                             |
| GET/PUT /api/admin/config       | Nombre y Partner ID de la empresa (una sola)        |
| GET/POST/PUT/DELETE /api/admin/vendedoras   | CRUD de Vendedoras                     |
| POST   | /api/admin/vendedoras/:id/cerrar-venta | Cierra la venta abierta de esa vendedora        |
| GET    | /api/admin/vendedoras/:id/precios/base | Excel base de precios (para descargar)          |
| POST   | /api/admin/vendedoras/:id/precios      | Sube precios fijos {sku: precio}                |
| DELETE | /api/admin/vendedoras/:id/precios      | Quita todos los precios fijos                   |
| GET    | /api/admin/ventas               | Ventas, filtrables por estado (enviada/error)        |
| POST   | /api/admin/ventas/:id/reintentar | Reintenta el envío a Odoo de una venta con error     |
| POST   | /api/admin/reintentar-todas      | Reintenta todas las ventas con error                 |
| GET    | /api/admin/reporte               | Ventas por vendedora                                  |
| GET    | /health                          | Health check (incluye si la base de datos conecta)   |

## Notas técnicas

- Las contraseñas de las vendedoras se guardan **hasheadas** (nunca en texto
  plano), con `crypto.scrypt` de Node — no se necesita ninguna librería
  extra.
- La sesión del admin es un token firmado (HMAC) con expiración de 12 horas,
  sin necesitar una tabla de sesiones.
- La personalización visual (logo, colores, tipografía, etiquetas) **y los
  precios fijos** de cada vendedora se guardan como antes, como un archivo
  adjunto en el partner de Odoo (`vitrina-cfg-<código>`) — no se movieron a
  la base de datos nueva.
- El catálogo se cachea 30 min y se puede limpiar con
  `DELETE /api/productos/cache` (requiere sesión de admin).
- Ya no existe la importación de `clientes.csv` ni el concepto de varias
  Empresas: el portal es para una sola empresa, configurada en
  `/admin` → Configuración. El archivo `clientes.csv` no se usa más y se
  puede borrar del proyecto.

