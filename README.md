# Economic Dashboard

React + TypeScript dashboard: análisis por canal (Unleashed, Shopify, Meta), **AIM 2026** (inventario, demanda, KPIs), costes Xero y e-commerce. Datos centralizados en **Supabase** (Auth, Storage, Postgres, Edge Functions).

## Features

- **Authentication**: login restringido a correos `@dolo.com.au` (Supabase Auth)
- **Multi-source**: Unleashed (CSV/API), Shopify/Meta (API y/o CSV), costes unitarios, P&amp;L Xero (Excel)
- **AIM 2026**: SOH, demanda, BOM, KPIs cacheados, valuación
- **Costs Analysis / By channel**: costes desde Xero (edge `parse-xero-costs`) o entradas manuales legacy
- **Currency**: tipos de cambio en tabla `currency_exchange_rates` donde aplica

---

## Setup

### 1. Supabase

1. Crear proyecto y aplicar migraciones en `supabase/migrations/`.
2. Crear buckets de Storage que uses (ver [Orígenes de datos](#orígenes-de-datos-y-storage) abajo).
3. Variables en el front: copiar `.env.example` → `.env` con `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (no commitear secretos).

### 2. Autenticación

1. **Authentication** → **Providers** → Email.
2. Desactivar signups públicos si solo invitás usuarios.
3. Invitar usuarios `@dolo.com.au`; desplegar `invite-user` si usás flujo de invitación.

### 3. Desarrollo local

```bash
npm install
npm run dev
```

### 4. Build

```bash
npm run build
```

Desplegar el front en tu hosting estático y las **Edge Functions** con Supabase CLI (`supabase functions deploy <nombre>`).

---

## Orígenes de datos y Storage

En la consola de Supabase: **Project → Storage → Buckets**. Las rutas de objeto suelen ser la **raíz del bucket** salvo que subáis carpetas.

### Resumen por área

| Área | Origen |
|------|--------|
| Dashboard “Economic” legacy | CSV en **`csv-files`** + edge `parse-csv-data`; FX en **`currency_exchange_rates`** |
| AIM 2026 (inventario, demanda, KPIs) | CSV en **`aim-csv-files`** o **`csv-files`** (el código prueba ambos); tablas **`aim2026_*`**; sync **Unleashed API** opcional |
| E-commerce (Shopify/Meta en BD) | APIs + credenciales en **`api_credentials`** → tablas **`ecommerce_*`**; CSV opcional en **`ecom`** (`ecommerce-load-csv`) |
| Costes Xero (Costs Analysis) | Excel en **`csv-files`**: `Dolo_Ent_PTY_Ltd_-_Profit_and_Loss_Mario_2026.xlsx` → **`parse-xero-costs`** |
| Coste unitario SKU (AIM / margen) | **`costs.csv`** → `aim2026_sku_parameters` vía **`aim2026-csv-load`** |

### Bucket `aim-csv-files` (principal AIM)

| Archivo | Uso |
|---------|-----|
| `SOHList.csv` | Stock → `aim2026_soh_snapshots`, `aim2026_sku_parameters` |
| `SalesEnquiryList.csv` | Demanda ventas → `aim2026_demand_history` / `aim2026_demand_detail` |
| `ProductionEnquiryList.csv` | Producción y uso de componentes |
| `PurchaseEnquiryList.csv` | Pipeline (Container, DHL, On Production) |
| `costs.csv` | `product_cost_china` por SKU |
| `ProductList.csv` | Lead times (también: `productlist.csv`, `Product List.csv`) |
| **`BOM_*.csv`**, **`BillOfMaterials*.csv`**, o `BillOfMaterialsList.csv` / `bom_cleaned_min.csv` / `BOM.csv` | Ensamblados + componentes → ver [BOM](#bom-bill-of-materials) |

### Bucket `csv-files`

| Archivo / patrón | Uso |
|------------------|-----|
| `SalesEnquiryList.csv` | Unleashed en flujo `parse-csv-data` |
| `costs.csv` | Costes legacy por SKU |
| `old-shopify-sales.csv` | Shopify histórico |
| `2-Mario-for-Danshboard.csv` | Meta / Mario dash |
| Nombre que empiece por **`MARIO Total sales by product variant`** | Shopify actual (detectado con `list()`) |
| **`Dolo_Ent_PTY_Ltd_-_Profit_and_Loss_Mario_2026.xlsx`** | P&amp;L para Xero / Costs |

Los mismos CSV de AIM pueden existir también en **`csv-files`** como respaldo: varias funciones intentan **`aim-csv-files` primero** y luego **`csv-files`**.

### Bucket `ecom` (opcional)

| Archivo | Uso |
|---------|-----|
| `Orders by day MARIO DASH 2026 - … .csv` | Variantes con distinto rango de fechas en el nombre |
| `Mario-dash-2026.csv` | Meta (constante en `ecommerce-load-csv`) |

### APIs y tablas (sin archivo en Storage)

- **Unleashed**: `unleashed_credentials`; funciones de sync, generación de CSV, POs, etc.
- **Shopify / Meta**: `api_credentials` → `ecommerce_shopify_daily`, `ecommerce_meta_daily`, `ecommerce_meta_daily_ads`, `ecommerce_meta_top_ads`, `ecommerce_sync_log`.

---

## BOM (Bill of Materials)

### Origen

Export **CSV desde Unleashed** (u otro origen con el mismo esquema) subido a **`aim-csv-files`** o **`csv-files`**.

**Selección del archivo**: se listan objetos del bucket; se prefieren CSV cuyo nombre empiece por **`bom`** o **`billofmaterials`** (sin distinguir mayúsculas); si hay varios, el **más reciente** por `updated_at`. Si no hay coincidencias, se intentan nombres fijos: `BillOfMaterialsList.csv`, `bom_cleaned_min.csv`, `BOM.csv`.

**Formato**: columnas típicas `*Assembled Product Code`, `Component Product Code`, `*Quantity` (cabeceras con `*` se normalizan al parsear). Filas con ensamblado vacío **heredan** el código de la fila anterior (formato Unleashed).

### Código compartido

La lógica vive en **`supabase/functions/_shared/bom.ts`**:

- `downloadBOMFromBucket`
- `parseBomCsv` (deduplica par `assembly_sku` + `component_sku`)
- `insertBomComponentsBatched` (inserciones en lotes hacia `aim2026_bom_components`)

### Tablas

| Tabla | Contenido |
|-------|-----------|
| **`aim2026_assembled_products`** | Un registro por SKU **ensamblado** (lista para filtros / lógica ROD) |
| **`aim2026_bom_components`** | Una fila por par **assembly_sku → component_sku** con **quantity_per_assembly** |

### Cómo se pueblan

1. **`aim2026-csv-load`** con **`step: "bom"`** (botón **“Reload BOM only”** en Settings → CSV Data Reload): solo actualiza **`aim2026_assembled_products`** y **`aim2026_bom_components`** desde el último CSV BOM en Storage; **no** toca ventas, SOH, producción ni KPIs.
2. **`aim2026-csv-load`** (paso **`production`** o **`all`**): además del BOM, procesa **`ProductionEnquiryList.csv`** (demanda/uso de componentes).
3. **`aim2026-sync-unleashed`**: rellena solo **`aim2026_assembled_products`** desde la API; **no** escribe `aim2026_bom_components`.
4. **`aim2026-get-dashboard`** (`action`: `kpi_cache`): si **`aim2026_assembled_products`** está **vacía**, o si **`aim2026_bom_components`** está **vacía**, descarga el BOM desde Storage, parsea con el mismo módulo compartido y **rellena** lo que falte (así, tras un sync Unleashed que dejó componentes vacíos, el primer load del dashboard puede **backfillear** el BOM desde el CSV). Si las tablas ya tienen datos y subís un BOM nuevo, usá **`step: bom`** o el reload completo con paso production.

El front recibe `assembledProductSKUs` y `bomComponents` en la respuesta del dashboard para detalle de SKU / BOM en UI.

---

## Edge Functions (referencia)

| Función | Rol breve |
|---------|-----------|
| `parse-csv-data` | Dashboard Economic legacy desde `csv-files` |
| `aim2026-csv-load` | Carga AIM desde Storage → tablas `aim2026_*` |
| `aim2026-get-dashboard` | Lecturas AIM + backfill BOM si hace falta |
| `parse-xero-costs` | P&amp;L Xero (xlsx en `csv-files`) |
| `ecommerce-load-csv` | Bucket `ecom` → `ecommerce_*` |
| `ecommerce-sync`, `ecommerce-sync-shopify`, `ecommerce-sync-meta` | APIs → `ecommerce_*` |
| `aim2026-sync-unleashed`, `aim2026-calc-kpis-v2`, etc. | Sync y KPIs |

---

## Cálculos destacados (Economic)

- **Canales**: mezcla Unleashed + Shopify; exclusiones de canales tipo Shopify en Unleashed.
- **ROAS semanal**: Shopify / gasto Meta por semana (lunes inicio).
- **SKUs top**: márgenes usando `costs` / costes cargados.

Lógica principal en `App.tsx` (`channelAnalysis`, `weeklyROAS`, `topSKUs`, etc.).

---

## Manual upload / fallback

Algunas pantallas permiten subir CSV manualmente o abrir Storage desde la UI; el flujo principal AIM pasa por **Settings / Reload** y el bucket **`aim-csv-files`**.

---

## Desarrollo

- Nuevos orígenes: añadir parser en la edge correspondiente, tipos en el cliente y documentar aquí el bucket y nombre de archivo.
- **No** commitear `service_role`, tokens de Supabase ni claves de APIs en el repo.

---

## Deployment

1. Configurar Supabase (migraciones, buckets, secrets de funciones).
2. `npm run build` y desplegar el estático.
3. `supabase functions deploy …` para las funciones que cambien.

Para deploy con CLI hace falta `supabase login` o `SUPABASE_ACCESS_TOKEN` en el entorno (no compartir en chats).
