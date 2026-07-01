# Temponovo · Vitrina de Relojes

Portal para revendedoras: entran con su código, ven los relojes en grande,
abren la ficha con características, **prueban el reloj en la muñeca** de su
clienta (cámara o foto) y hacen pedidos que llegan directo a Odoo.

## Módulos

- **Vitrina** — grilla de relojes con foto grande, búsqueda y filtro por categoría.
  Cada reloj abre su ficha: foto en alta, atributos (color, correa, etc.),
  descripción, tu precio y precio sugerido.
- **Probar** — cámara o foto de la muñeca + el reloj encima; se mueve con un
  dedo, se agranda con dos, se puede girar y capturar la imagen para enviarla
  a la clienta.
- **Pedido** — carrito + ingreso rápido por código con autocompletado.
  Al enviar se crea y confirma la venta en Odoo.
- **Historial** — pedidos anteriores con estado y total.
- **Modo vitrina** (ícono del ojo) — oculta precio mayorista, stock y botones
  de compra: la revendedora puede pasarle el teléfono a su clienta y mostrar
  solo el precio sugerido.

## Configuración

### 1. Variables de entorno (Vercel → Settings → Environment Variables)

| Variable        | Valor                                                    |
|-----------------|----------------------------------------------------------|
| `ODOO_URL`      | `https://temponovo.odoo.com` (es el valor por defecto)   |
| `ODOO_DB`       | Nombre de la base de datos Odoo de Temponovo             |
| `ODOO_USER`     | Email del usuario admin de Odoo                          |
| `ODOO_PASSWORD` | Contraseña o API key del admin                           |
| `CATEGORIAS`    | Opcional. Categorías a mostrar separadas por `\|`. Ej: `Relojes / Hombre\|Relojes / Mujer`. Vacío = todos los productos vendibles. |

### 2. Clientas (`clientes.csv`)

```
codigo,nombre,partnerId,multiplicador,sucursales
CAROLINA,Carolina Cereceda,827,2,"Santiago"
```

- **codigo** → lo que escribe la clienta para entrar
- **partnerId** → ID del partner en Odoo
- **multiplicador** → precio sugerido = tu precio × multiplicador (ej: 2)
- **sucursales** → separadas por coma, entre comillas si son varias

El precio "tu precio" sale de la **pricelist** asignada al partner en Odoo,
así que cada clienta ve su precio real.

### 3. Despliegue

```bash
npm i -g vercel
vercel --prod
```

## Endpoints API

| Método | Ruta                    | Descripción                                 |
|--------|-------------------------|---------------------------------------------|
| GET    | /api/me                 | Perfil de la clienta (auth check)           |
| GET    | /api/productos          | Catálogo con atributos, precio y sugerido   |
| GET    | /api/imagen/:id         | Imagen 256px (grilla). `?s=g` → 1024px      |
| DELETE | /api/productos/cache    | Forzar recarga del catálogo                 |
| POST   | /api/pedido             | Crear y confirmar pedido en Odoo            |
| GET    | /api/pedidos            | Historial de pedidos                        |
| GET    | /health                 | Health check                                |

## Notas técnicas

- Al probar el reloj sobre una **foto**, la imagen del producto se mezcla con
  `multiply`, así el fondo blanco de la foto de Odoo desaparece solo. Con
  cámara en vivo se muestra normal.
- Las imágenes se sirven una a una con caché (7200 s navegador / 24 h CDN),
  el catálogo se cachea 30 min y se puede limpiar con el endpoint de caché.
