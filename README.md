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
  Odoo por la API: el primer pedido de **cualquier** vendedora abre una
  venta nueva (`POST /sale/create`) y los siguientes — de esa misma
  vendedora o de cualquier otra, ya que todas facturan al mismo partner —
  se van agregando a esa misma venta (`POST /sale/update`) mientras Odoo lo
  permita. En cuanto la API rechaza el `/sale/update` (por ejemplo porque la
  venta ya fue pickeada/despachada), el portal abre sola una venta nueva
  para el próximo pedido. Si el envío falla por completo (sin conexión,
  etc.), el pedido queda guardado con estado **"Con error"** y se puede
  reintentar desde el Panel de Admin → **Ventas**.

### Seguimiento logístico de cada venta

Cada pedido tiene un **id interno** propio (el mismo que se le muestra a la
vendedora como número de venta) y un estado de **seguimiento**, totalmente
aparte de si ya llegó o no a Odoo:

`recibido` → `preparando` → `en_transito` → `entregado`

Este estado lo cambia **solo el admin**, desde el Panel de Admin → **Ventas**
(un selector por fila). La vendedora lo ve reflejado al instante en
**Mis Ventas**, siempre consultando por ese mismo id interno — la vitrina
nunca necesita saber nada de Odoo para mostrar el seguimiento.

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
| `TEMPONOVO_VENDOR_EMAIL` | Opcional. Email que se manda como `vendor_email` en cada venta. Si no se pone, se usa `ODOO_USER`. Todas las ventas se crean con este remitente (el de la cuenta admin) — **nunca** con el email de cada vendedora. |
| `CATEGORIAS`         | Opcional. Categorías a mostrar separadas por `\|`.              |
| `ADMIN_PASSWORD`     | Clave para entrar al Panel de Admin (`/admin`)                 |
| `ADMIN_SECRET`       | Cualquier texto largo al azar (firma las sesiones de admin **y** los tokens de imagen de las vendedoras — ver nota) |
| `POSTGRES_URL`       | La inyecta Vercel solo al conectar la base de datos (ver abajo)|
| `PGSSL_INSECURE`     | Opcional. Poner en `1` solo si tu Postgres usa un certificado autofirmado y necesitas desactivar la verificación TLS. Por defecto se verifica. |
| `CREDENTIALS_KEY`    | **Obligatoria.** Clave de 32 bytes en base64 (generarla una vez con `openssl rand -base64 32`) — cifra las credenciales de cada proveedor (Odoo/API de ventas) que se guarden en la base de datos. Ver nota abajo. |

Nota: XML-RPC (`ODOO_*`) se sigue usando solo para leer catálogo, stock,
imágenes y precios de lista — **nunca** para crear ventas. Las ventas
siempre pasan por `TEMPONOVO_API_URL` / `TEMPONOVO_API_KEY`.

Importante: `ADMIN_SECRET` es **obligatorio** — a diferencia de otras
variables, no tiene un valor por defecto. Si falta, tanto el login de admin
como la carga de imágenes en la vitrina de las vendedoras dejan de
funcionar (a propósito: antes había un valor por defecto conocido en el
código fuente, lo que permitía forjar sesiones de admin si alguien olvidaba
configurarlo).

### Portal multi-proveedor (en construcción)

El portal está migrando de un solo proveedor (Temponovo) a soportar varios
proveedores conectados desde el Panel de Admin (empezando por Aviv), cada
uno con su propia conexión a Odoo (o cargado a mano si no tiene Odoo). Es un
cambio grande que se entrega por fases:

- ✅ **Fase 0 (ya en este código)**: existe la tabla `proveedores` en la base
  de datos, y al arrancar por primera vez con `CREDENTIALS_KEY` configurada,
  el backend migra automáticamente la configuración actual de Temponovo
  (`ODOO_*`/`TEMPONOVO_*`/el Partner ID de Configuración) a la primera fila
  de esa tabla, con las credenciales cifradas. Todavía **no cambia nada** en
  el funcionamiento del portal — se puede verificar en `GET /health`, que
  ahora incluye la lista de proveedores y si sus credenciales quedaron
  seteadas. Si `CREDENTIALS_KEY` no está configurada, esta migración
  simplemente no corre todavía (se reintenta sola en el próximo request en
  cuanto se configure) — el resto del portal sigue funcionando igual que
  antes con las variables de entorno de siempre.
- ✅ **Fase 1 (ya en este código)**: la config visual y los precios fijos de
  cada vendedora se movieron de un adjunto de Odoo a Postgres
  (`vendedora_config`), con backfill automático de lectura única — ver nota
  en "Notas técnicas" más abajo. Tampoco cambia nada visible: cada vendedora
  sigue viendo su misma vitrina, logo y precios de siempre.
- ✅ **Fase 2 (ya en este código)**: la pestaña "Info productos" del Panel de
  Admin pasó a llamarse **Proveedores** — ahí se pueden agregar, editar,
  activar/desactivar y eliminar proveedores (Odoo o "Manual", sin Odoo), y
  probar que las credenciales de un proveedor Odoo funcionan ("Probar
  conexión") antes de guardar. El Excel de información adicional de
  producto (con código de barra) sigue ahí mismo, como sub-sección. **Ojo:**
  agregar un proveedor acá todavía no hace nada más — no aparece en ninguna
  vitrina ni se puede vender hasta la fase siguiente, que conecta el
  catálogo de verdad.
- ✅ **Fase 3+4 (ya en este código)**: el catálogo de todos los proveedores
  activos se junta en uno solo (`/api/productos`, `/api/public/:slug/productos`),
  cada producto queda etiquetado con su proveedor (las imágenes van por
  `/api/imagen/:proveedorId/:id` — el id de Odoo no es único entre
  proveedores). Si el carrito de una vendedora mezcla productos de más de un
  proveedor, `/api/pedido` lo separa solo en una venta por proveedor
  (compartiendo el mismo N° de pedido) — con dos caminos según el proveedor:
  los que tienen API de ventas propia (como Temponovo) siguen igual; los que
  no (como Aviv) se venden creando un `sale.order` estándar directo en su
  Odoo por XML-RPC. "Mis Ventas" y Admin → Ventas muestran cuándo un pedido
  se separó en varios envíos.
- ⏳ Pendiente (fase 5, menor urgencia): pantalla de catálogo y gestión
  manual de ventas para un proveedor sin Odoo (`tipo='manual'`) — hoy se
  puede crear ese tipo de proveedor pero no aporta productos todavía.
- ✅ **Selector de talla (anillos) y galería de fotos (ya en este código)**:
  al abrir la ficha de un anillo que tiene otras tallas del mismo diseño
  (mismo proveedor, categoría, nombre sin el sufijo de talla, metal y
  piedra) con stock, aparece "¿Cuál es tu talla?" para cambiar entre ellas
  sin salir de la ficha — cada talla sigue siendo un producto (SKU)
  distinto para el carrito y los favoritos. Si el producto tiene fotos
  adicionales cargadas en Odoo (modelo `product.image`, más allá de la
  imagen principal), se muestran como miniaturas debajo de la foto grande.
  No se implementó video: no se encontró un campo de video en el Odoo de
  ningún proveedor actual.

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

También en Configuración puedes ver la **venta abierta** (la única, compartida
por todas las vendedoras) y forzar que se cierre si quieres que el próximo
pedido de cualquiera abra una venta nueva en Odoo.

### 4. Despliegue

```bash
npm i -g vercel
vercel --prod
```

## Endpoints API

| Método | Ruta                          | Descripción                                        |
|--------|-------------------------------|-----------------------------------------------------|
| GET    | /api/me                       | Perfil de la vendedora (requiere código + clave)    |
| GET    | /api/productos                | Catálogo combinado de todos los proveedores activos, con precio y sugerido |
| GET    | /api/imagen/:proveedorId/:id   | Imagen del producto (el id de Odoo no es único entre proveedores) |
| GET    | /api/imagen-extra/:proveedorId/:imgId | Foto adicional del producto (galería, modelo `product.image` de Odoo) |
| POST   | /api/pedido                    | Crea la venta — si el carrito mezcla proveedores, la separa sola en una por cada uno |
| GET    | /api/pedidos                   | Historial de ventas de la vendedora                  |
| GET    | /api/config · POST /api/config | Personalización de la vitrina (logo, colores, etc.) — de cada vendedora |
| POST   | /api/admin/login                | Login del panel de admin                             |
| GET/PUT /api/admin/config       | Nombre y Partner ID de la empresa (una sola)        |
| GET/POST/PUT/DELETE /api/admin/vendedoras   | CRUD de Vendedoras                     |
| GET/POST/PUT/DELETE /api/admin/proveedores  | CRUD de Proveedores — catálogo y ventas ya conectados |
| POST   | /api/admin/proveedores/:id/probar | Prueba la conexión Odoo de un proveedor |
| POST   | /api/admin/cerrar-venta          | Cierra la única venta abierta (compartida por todas)  |
| GET    | /api/admin/vendedoras/:id/precios/base | Excel base de precios (para descargar)          |
| POST   | /api/admin/vendedoras/:id/precios      | Sube precios fijos {sku: precio}                |
| DELETE | /api/admin/vendedoras/:id/precios      | Quita todos los precios fijos                   |
| GET    | /api/admin/ventas               | Ventas, filtrables por estado (enviada/error)        |
| POST   | /api/admin/ventas/:id/reintentar | Reintenta el envío a Odoo de una venta con error     |
| PUT    | /api/admin/ventas/:id/seguimiento | Cambia el avance logístico de una venta: recibido → preparando → en_transito → entregado |
| POST   | /api/admin/reintentar-todas      | Reintenta todas las ventas con error                 |
| GET    | /api/admin/reporte               | Ventas por vendedora                                  |
| GET    | /health                          | Health check (incluye si la base de datos conecta)   |

## Notas técnicas

- Las contraseñas de las vendedoras se guardan **hasheadas** (nunca en texto
  plano), con `crypto.scrypt` de Node — no se necesita ninguna librería
  extra.
- La sesión del admin es un token firmado (HMAC) con expiración de 12 horas,
  sin necesitar una tabla de sesiones.
- Las imágenes del catálogo (`<img src>`) nunca llevan la clave real de la
  vendedora en la URL — usan un token derivado de su `clave_hash`, que deja
  de servir solo con cambiarle la clave.
- El login de admin y el de vendedoras bloquean por 10-15 minutos tras
  varios intentos fallidos seguidos (fuerza bruta), sin afectar a quien ya
  tiene la clave correcta.
- Eliminar una vendedora con ventas registradas está bloqueado (para no
  perder ese historial) — hay que desactivarla en su lugar desde el
  interruptor de Estado.
- La personalización visual (logo, colores, tipografía, etiquetas) **y los
  precios fijos** de cada vendedora se guardan en Postgres (tabla
  `vendedora_config`). Antes vivían como un archivo adjunto en el partner de
  Odoo (`vitrina-cfg-<código>`) — la primera vez que se pide la config de
  cada vendedora después de este cambio, se trae una única vez de ese
  adjunto viejo y se guarda ya en la base de datos; de ahí en más nunca más
  se vuelve a tocar Odoo por esto. No hace falta correr ninguna migración a
  mano — pasa solo, por vendedora, la primera vez que entra o que el admin
  la abre en el Panel.
- La venta abierta es una sola fila (`configuracion`, id=1) protegida con
  `SELECT ... FOR UPDATE` mientras dura la llamada a la API: si dos
  vendedoras mandan un pedido casi al mismo tiempo, el segundo espera a que
  termine el primero, para que nunca se abran dos ventas nuevas en paralelo
  por accidente.
- El catálogo se cachea 30 min y se puede limpiar con
  `DELETE /api/productos/cache` (requiere sesión de admin).
- Ya no existe la importación de `clientes.csv` ni el concepto de varias
  Empresas: el portal es para una sola empresa, configurada en
  `/admin` → Configuración. El archivo `clientes.csv` no se usa más y se
  puede borrar del proyecto.

