# Handover — 2026-07-28

> Estado: **todo deployado y verificado**. Prod = `ui-redesign` → Vercel (`be0d779` en adelante, READY).
> Rama de trabajo `feat/unleashed-sales-api`. Cron reactivado.
> Handovers anteriores: [`HANDOVER-WEB-UPGRADE.md`](HANDOVER-WEB-UPGRADE.md) (ese panel, sigue vigente).

## 1. Qué pasó hoy, en una línea

Mario quería buscar un SKU y ver sus ventas de Shopify. Auditando el tab AIM 2026 para
entender por qué no podía, apareció que **el sync venía destruyendo 34.317 unidades de
demanda 2026, tres veces por día**. Se arregló el sync, se recuperó la data, se corrigieron
los KPIs, y recién después se construyó lo que pedía.

## 2. El incidente (lo más importante)

`aim2026-sync-unleashed` pedía las órdenes a Unleashed con `maxPages = 30` (× 200 = **6.000
órdenes**) y devolvía el array truncado **sin avisar**, después de haber puesto en cero
`demand_history` y borrado `demand_detail` de toda la ventana. La ventana real tiene ~16.000
órdenes. Cada corrida vaciaba 3 meses y los rellenaba con lo que entraba.

Detalle completo, alcance y verificación: [`FIX-DEMAND-GAP.md`](FIX-DEMAND-GAP.md).

**Cómo quedó** — el sync ahora sigue el patrón de `unleashed-sales-sync`:

- watermark en `aim2026_sales_sync_state` + `modifiedSince` → una corrida tarda **~4s** (antes 75-138s)
- cada orden se reemplaza por su `Guid`; **ninguna ventana se borra**
- `demand_history` dejó de acumular: se recalcula desde `demand_detail` con
  `aim2026_rebuild_demand_history(periods)`. Correrlo dos veces da lo mismo, por construcción
- `unleashedGetAll` **lanza error** si la API reporta más páginas de las que trajo, y no adivina
  cuando una página viene sin metadata de paginación
- una sola pasada cubre los cuatro estados (antes 4 llamadas)
- `customer_type` sale del endpoint **Customers**, no de `order.CustomerType` (que Unleashed no manda)

**Recuperado**, contra `unleashed_sales_lines` como testigo independiente:

| Mes | Antes | Ahora | Cobertura |
|---|---|---|---|
| 2026-01 | 12.004 | 15.114 | 100,0% |
| 2026-02 | 9.477 | 14.760 | 100,0% |
| 2026-03 | 6.215 | 10.076 | 100,0% |
| 2026-04 | 6.876 | 10.864 | 100,0% |
| 2026-05 | 1.102 | 12.457 | 101,9% |
| 2026-06 | 4.906 | 12.211 | 105,4% |
| 2026-07 | 6.122 | 6.221 | 102,2% |

Mayo–julio dan arriba de 100% porque el testigo es un export congelado y esos meses siguieron
moviéndose en Unleashed. `component_usage` también estaba roto (abril y mayo en cero por el
mismo truncado en assemblies): recuperado a 7.281 y 7.364.

**Backups** (previos a tocar nada, no borrar sin avisar):
`aim2026_demand_detail_bkp_20260728`, `aim2026_demand_history_bkp_20260728`,
`aim2026_demand_detail_bkp_ene_abr_20260728`, `aim2026_demand_history_bkp_ene_abr_20260728`.

## 3. AIM 2026 — qué se corrigió

La auditoría completa (26 hallazgos) está en [`AUDIT-AIM2026-TAB.md`](AUDIT-AIM2026-TAB.md).
Lo aplicado hasta ahora:

**Cero vs sin dato.** El código trataba tres placeholders como valores: `daysOfCover = 999`
sin demanda, costo NULL → 0, y `> 0 ? valor : '—'` en la tabla. Ahora `daysOfCover`,
`turnover`, `marginPercent` y `gmroi` son `null` cuando no se pueden medir, y ese `null` viaja
hasta la celda.

| | Antes | Ahora |
|---|---|---|
| Centinela 999 | 564 SKUs | 0 |
| OVERSTOCK con stock cero | 491 | 0 |
| Items at Risk | 0 (falso) | 300 reales |
| Margen 100% falso | 59 | 0 |

Promedios sobre lo medible (`avgMeasured` saltea nulls): turnover **6,01** (392 filas), GMROI
**18,42** (200), margen **61,35%** (410), cover **212d** (510).

**Filtros que recalculan de verdad.** `aim2026-calc-kpis-v2` acepta `warehouse` y `channel`:

- **warehouse** — restringe la demanda **y el stock** contra el que se mide cover/ROP/sug. qty.
  Antes el dropdown "WH Demand" solo agregaba una columna informativa mientras el motor
  consultaba `warehouse = 'All'` hardcodeado.
- **channel** — `b2c` / `b2b` o un `customer_type` exacto. Como `demand_history` no tiene
  columna de canal, un filtro de canal reconstruye la demanda desde `demand_detail`.

Dos decisiones deliberadas: con filtro de canal **no se cuenta component usage** (armar un
producto no es una venta y no tiene canal), y **un query con filtro nunca escribe el caché**.
Un SKU sin demanda en el canal filtrado muestra status `NO DEMAND`, que se dibuja como "—":
el stock no es por canal, así que no hay veredicto de stock que dar.

**Otros**: sparkline de Inventory Value se dibujaba al revés (una caída del 18% se veía como
suba); el CSV exporta celda vacía en vez de 0; el detalle de SKU dejó de decir "Below target"
sobre un dato inexistente.

## 4. B2C Sales Explorer (tab nuevo)

Escribís un SKU y ves sus ventas de Shopify. Multi-selección con chips, presets
(Yesterday / Last week / 30 / 90 días / 12 meses) o rango propio, barras por día/semana/mes,
curva de tendencia on/off, y la selección **persiste** en localStorage.

Muestra: units, net sales, orders — cada uno contra el período anterior equivalente —, precio
real por unidad, descuentos, devoluciones, serie temporal, países y últimas ventas.

**Moneda, importante**: `shopify_sales_lines.net_native` está en **43 monedas** (AUD, USD, JPY,
KRW…). Sumar esa columna no significa nada. Todo convierte `net_usd` a AUD con
`currency_exchange_rates` (tasa por mes), la misma que usa el resto del dashboard.

RPCs: `shopify_sku_list` (buscador), `shopify_sku_stats_multi(skus[], from, to, granularity)`
(toda la pantalla en un round trip), `usd_to_aud_rate(date)`.

El panel vive en `B2CSalesPanel.tsx` y se reusa: clickear un SKU en la tabla de productos de
**Web Upgrade** abre el mismo panel como popup (`SkuSalesDialog`), con su propia fecha para no
mover el rango del tab.

El tab **AIM** viejo (`InventoryReorderDashboard`) salió del menú. El modal sigue montado y
alcanzable con `activeModal = 'aim'`: restaurarlo es una línea.

## 5. Cómo retomar

```bash
cd "C:/PROYECTS/AIM 2026" && git checkout feat/unleashed-sales-api && git pull
```

**Deploy**: `npm run build` → commit → `git checkout ui-redesign` → `git merge --no-ff` →
`git push` → Vercel deploya solo. Edge functions: `npm run sb -- functions deploy <nombre>`.

**Typecheck de una edge function** (Deno): copiar el archivo sacando el import de
`edge-runtime.d.ts` y correr `deno check` sobre la copia — ese import arrastra tipos de
`npm:openai` que no resuelven sin `node_modules`.

**Validación visual**: harness descartable `src/xdev.tsx` + `xdev.html`, `preview_start` con
`aim2026-dev`, navegar a `/xdev.html` y leer el DOM con `javascript_tool`. Los screenshots del
pane **no funcionan** y los eventos sintéticos sobre componentes Radix tampoco. Borrar el
harness antes de commitear.

**Backfill de un mes de ventas** (el sync ya arreglado, acotado):

```bash
curl -X POST "https://teewkafclgpfpczftvah.supabase.co/functions/v1/aim2026-sync-unleashed" \
  -H "Authorization: Bearer <anon>" -H "Content-Type: application/json" \
  -d '{"step":"sales","salesStartDate":"2026-05-01","salesEndDate":"2026-05-31"}'
```

Meses pesados hay que partirlos en trozos de ~10 días o se pasan del límite de compute.

## 6. Reglas que no se pueden romper

1. **Nada de centinelas.** Un dato que no se puede medir es `null`, nunca 999 ni 0. Ese fue el
   patrón detrás de la mitad de los 26 hallazgos.
2. **Ningún fetch parcial se escribe.** `unleashedGetAll` falla antes que devolver de menos.
   Nunca volver a borrar una ventana antes de tener los datos que la reemplazan.
3. **`demand_history` es derivada.** Se recalcula desde `demand_detail`; no volver a acumular
   con `existing + nuevo`.
4. **Nunca sumar `net_native` de Shopify.** Son 43 monedas.
5. **La UI va en inglés.** Labels, headers, tooltips, estados vacíos.
6. **Proponer antes de actuar** en cualquier cosa que escriba datos.

## 7. Pendientes

De la auditoría, sin tocar todavía:

1. **Inventory Value** — sigue siendo el snapshot del 2026-07-07 y sigue ignorando el filtro,
   al lado de una tabla que sí se filtra. Es la card más visible del tab.
2. **"Never synced"** — `recalcKPIsForDateRange` pisa `lastSyncAt` a null en cada recálculo.
3. **Tres contadores distintos** de productos: 1538 (params ∪ SOH), 1531 (caché), 1362 (sin
   assembled). El header usa uno y las cards otro.
4. **El strip de Stock Valuation cuenta doble el stock en tránsito** (+195.120 AUD): reimplementa
   la fórmula sin el dedup de China contra Container/DHL.
5. **El CSV valúa China con FX 1.54 y el snapshot no** — divergencia de 2,84×.
6. **`Sug. Qty` resta dos veces** las unidades en tránsito.
7. **El cron no llama a `aim2026-calc-kpis-v2`**, así que el caché de KPIs sigue congelado en el
   2026-07-07 para las vistas que lo usan (rangos > 11 meses).
8. **287 SKUs sin costo** — Mario dijo "lo vemos después". Son los que dejan turnover, GMROI,
   margen y valuación sin poder medirse.
