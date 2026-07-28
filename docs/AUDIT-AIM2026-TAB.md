# Auditoría — tab AIM 2026

> **Índice:** la parte 1 es la auditoría general de la pantalla. La **parte 2 (al final)** responde
> las dos preguntas concretas de Mario: el selector WH Demand y el filtro por canal.
>
> **Estado 2026-07-28** — resueltos: 1 (parcial: el costo sigue faltando, pero ya no se reporta
> como cero medido), 4, 5, 8, 11, 19, 26, y las dos preguntas de la parte 2 (warehouse y canal
> ahora recalculan de verdad). Siguen abiertos: 2, 3, 6, 7, 9, 10, 12, 13, 14, 15, 16, 17, 18,
> 20, 21, 22, 23, 24, 25. Ver §7 de [`HANDOVER.md`](HANDOVER.md).

> Fecha: **2026-07-28** · Estado observado: rama `feat/unleashed-sales-api`, filtro `psd-hd-d` activo, rango `Jun 2026 – Jul 2026`.
> Método: 5 auditores en paralelo sobre el código + verificación adversarial + queries read-only contra la DB de producción.
> **Solo diagnóstico. No hay fixes aplicados ni propuestos.**

## Resumen

- **El número grande de la pantalla (AUD 1.69M) no describe lo que hay debajo.** Es del 2026-07-07 (21 días viejo), es de toda la empresa (ignora el filtro activo) y se calcula con otra fórmula que la barra STOCK VALUATION. Card, strip y CSV son cuatro definiciones distintas de la misma plata; ninguna reconcilia con otra.
- **Falta costo en el maestro de productos y eso rompe la valuación y tres KPIs a la vez.** 54 SKUs con `product_cost_china` NULL y 233 en cero: 58 SKUs con stock (47.060 unidades) valen $0 en toda superficie, y su Turnover/GMROI se fuerzan a 0. PSD-HD-DL es uno de ellos — de ahí el "$0" y los "—" de la fila.
- **Los promedios (AVG TURNOVER / GMROI / COVERAGE) están diluidos por ceros y por un centinela.** 77% de las filas tienen turnover 0 "porque no se pudo medir" y se promedian igual: 1.92 vs 8.36 real. AVG COVERAGE 450d es en su mayoría el valor inventado 999.
- **ITEMS AT RISK está estructuralmente subestimado.** 491 SKUs con stock cero quedan clasificados OVERSTOCK por ese mismo centinela 999 y por definición no pueden entrar nunca en el conteo de riesgo.
- **"Never synced" es falso y tapa el problema real.** La etiqueta se pisa a null en cada recálculo por rango; el auto-sync 3x/día nunca llama a calc-kpis-v2, así que el caché y la valuación quedan congelados desde el 7 de julio sin ninguna señal en pantalla.
- **Los tres contadores de productos (1538 / 1531 / 1362) miden universos distintos** y el margen/GMROI negativos se dibujan como "—", indistinguibles de "sin datos".

## Hallazgos

| # | Qué se ve | Qué pasa realmente | Tipo | Sev. | Archivo:línea |
|---|---|---|---|---|---|
| 1 | STOCK VALUATION todo en $0; Turn./Margin/GMROI en "—" | `product_cost_china` es NULL → landedCost 0 → todo multiplica a 0. 58 SKUs / 47.060 unidades valen $0 en toda la app | falta data | Alta | calc-kpis-v2:129, :808-810, :822-826 |
| 2 | INVENTORY VALUE AUD 1.69M sobre un strip de $0 para "1 product" | Es la única card que ignora `filteredOverrides`; las otras 5 sí se filtran | UI engañosa | Alta | KPISummaryCards.tsx:223-238; AIM2026Dashboard.tsx:397-415 |
| 3 | Esa misma 1.69M al lado de una tabla del 27-jul | La card sale de un snapshot del 2026-07-07; las filas se recalculan contra SOH del 2026-07-27. Irreconciliables por construcción | bug | Alta | api.ts:610-613; AIM2026Dashboard.tsx:262-271 |
| 4 | ITEMS AT RISK = 0 | `daysOfCover = 999` cuando no hay demanda → 491 SKUs con stock 0 quedan OVERSTOCK y no pueden entrar nunca en el filtro CRITICAL/LOW STOCK | bug | Alta | calc-kpis-v2:805, :555-561; api.ts:615-617 |
| 5 | AVG TURNOVER / GMROI / COVERAGE | Promedian ceros "no medibles" y el centinela 999 sobre TODAS las filas. Turnover 1.92 vs 8.36; Coverage 450d vs 66d | bug | Alta | AIM2026Dashboard.tsx:403-411; api.ts:629-634 |
| 6 | Total del strip vs total del snapshot | El strip reimplementa la fórmula sin el dedup de China in-transit: +195.120 AUD (+16,9%) cuando no hay filtro | bug | Alta | AIM2026Dashboard.tsx:387; calc-kpis-v2:929-932 |
| 7 | Margin "—" con Demand 61 | El loader de `aim2026_demand_detail` no pide la columna `amount`; los 1.606,50 AUD de las órdenes Placed existen en la DB y se descartan | bug | Alta | calc-kpis-v2:277-281, :812-819 |
| 8 | 59 SKUs con Margin 100.0% en verde | Costo 0 con precio de venta > 0 → margen exactamente 100%, y entran al numerador y denominador de AVG MARGIN | bug | Alta | calc-kpis-v2:816-818; api.ts:620 |
| 9 | "Never synced" en header y footer | Todo recálculo por rango setea `lastSyncAt: null`. El caché real tiene 21 días. Además el auto-sync nunca ejecuta calc-kpis-v2 | bug | Alta | api.ts:768; AIM2026Dashboard.tsx:898-899; sync-orchestrate:25-63 |
| 10 | "1538 products" / "of 1 products" / "excluding 176 assembled" | Tres poblaciones: 1538 (params ∪ SOH), 1531 (caché) y 1362 (sin assembled). El denominador de las cards es 1362, el del header 1538 | bug | Media | api.ts:635 y :767; AIM2026Dashboard.tsx:413, :971 |
| 11 | Celdas Margin/GMROI en "—" | 20 filas con margen negativo y 17 con GMROI negativo se dibujan igual que "sin dato": los SKUs que venden bajo costo son invisibles | UI engañosa | Media | InventoryTable.tsx:711-713, :733 |
| 12 | CSV de China / On Production | El CSV multiplica el costo por FX 1.54 y usa China bruto; el snapshot no aplica FX y usa China neto → divergencia 2,84× | bug | Media | aim2026-get-dashboard:487, :560; calc-kpis-v2:807, :932 |
| 13 | Diálogo: "China valued at FOB cost × exchange rate" | El código valúa a FOB × 1, sin FX. El texto de ayuda describe un método que no se ejecuta | UI engañosa | Media | StockValuationDialog.tsx:40, :180-181 |
| 14 | Chip "Jun 2026 – Jul 2026" | Solo gobierna columnas derivadas de demanda. Stock, valuación y contadores lo ignoran; y al cruzar 11 meses cambia el vintage del stock sin avisar | UI engañosa | Media | calc-kpis-v2:139-195 vs :215-216; AIM2026Dashboard.tsx:228 |
| 15 | Búsqueda sin resultados | Las 5 cards filtradas vuelven a valores globales con la tabla vacía y el strip desmontado | bug | Media | AIM2026Dashboard.tsx:397-398 |
| 16 | Demand "61" | 10 de uso de componentes + 51 de dos órdenes Placed en un solo mes, presentado como run-rate mensual recurrente | UI engañosa | Media | calc-kpis-v2:492, :773 |
| 17 | Filas adyacentes con Demand comparable | El promedio divide por buckets que EXISTEN, no por meses del rango: 256 SKUs se promedian sobre 2 meses y 213 sobre 1, sin distinción en la UI | UI engañosa | Media | calc-kpis-v2:500-508 |
| 18 | (latente) Rangos menores a 30 días | Demand cambia de tabla y pasa a tasa diaria mientras Cover/ROP/Turnover siguen en promedio mensual; `Math.round` deja en "—" toda la cola larga | bug | Media | calc-kpis-v2:644, :862-864 |
| 19 | Sparkline de INVENTORY VALUE subiendo | Se dibuja en orden cronológico inverso: una caída real de 18% se ve como una suba | bug | Media | aim2026-get-dashboard:192-194; KPISummaryCards.tsx:238 |
| 20 | Sug. Qty | Resta China Y Container/DHL (doble descuento) mientras la valuación, en la misma función, los deduplica. El tooltip omite el término China | bug | Baja | calc-kpis-v2:790-798 vs :929; types.ts:379 |
| 21 | ABC "C" | Se recalcula sobre la ventana de fechas; ~564 SKUs sin demanda en el rango caen a la clase guardada. La columna mezcla dos criterios | UI engañosa | Baja | calc-kpis-v2:689-694, :828 |
| 22 | Subtítulo "USD 1.10M" | Tasa 1.54 hardcodeada con un comentario que promete leerla de config; ninguna pantalla permite editarla | bug | Baja | api.ts:622-627, :755, :810 |
| 23 | Strip sin bucket Pesado Korea | El Total del strip suma 5 buckets, el snapshot 6. Hoy Korea = 0, así que la diferencia es latente | bug | Baja | AIM2026Dashboard.tsx:384-392 |
| 24 | Flechas de tendencia junto a Turnover/Margin/Demand | Siempre "stable": ninguna ruta de producción emite up/down, pero el tooltip afirma "Stable" como medición | UI engañosa | Baja | api.ts:630/633; calc-kpis-v2:516-519 |
| 25 | SOH China "—" | Es 0 real, pero hay 51 unidades allocated → available −51, sin ninguna señal en las columnas por defecto | UI engañosa | Baja | InventoryTable.tsx:386-390; calc-kpis-v2:859-860 |
| 26 | "0.0 times per period" en AVG TURNOVER | El valor está anualizado (×12); tres superficies declaran tres unidades distintas | UI engañosa | Baja | KPISummaryCards.tsx:261-262; calc-kpis-v2:821; types.ts:387 |

## Detalle

**1 — Costo faltante colapsa valuación y ratios**
```ts
// calc-kpis-v2:129
productCostChina: Number(row.product_cost_china) || 0,
// :808-810
const landedCostAUD = params.productCostChina * (1 + config.freightRate + ...);
// :822-823
const avgInventoryValue = mainWH.quantity * landedCostAUD;
const turnover = avgInventoryValue > 0 ? annualCOGS / avgInventoryValue : 0;
```
Root cause: `Number(null) || 0` convierte "costo no cargado" en "costo cero", indistinguible de "no vale nada". PSD-HD-DL tiene `product_cost_china = NULL`, 790 unidades en Main WH y 200 en Container → strip $0 y guardas `> 0` que devuelven 0 en turnover y GMROI. Nota algebraica: turnover no depende del costo (61×12/790 = 0.93 sería computable sin costo alguno); se anula sólo por el denominador. DB: 54 NULL + 233 en cero sobre 1538; 58 SKUs con stock, 47.060 unidades a $0.

**2 — INVENTORY VALUE es la única card sin filtro**
```tsx
// KPISummaryCards.tsx:223-229
const fo = filteredOverrides;
const itemsAtRisk = fo?.itemsAtRisk ?? data.itemsAtRisk; ... // seis valores, ninguno de inventario
// :236-238
value={formatCurrencyAUD(data.totalInventoryValueAUD)}
```
Root cause: `filteredKPIOverrides` (AIM2026Dashboard.tsx:397-415) no produce clave de inventario. Con la búsqueda activa el override existe (por eso "of 1 products"), pero la card sigue global. El comportamiento global es deliberado (comentario en :262), el defecto es que nada en la card indica que su población difiere de sus cinco vecinas.

**3 — La card describe otro día que la tabla**
```ts
// api.ts:610-613
const latestValuation = valuationHistory[0];
const totalInventoryValue = latestValuation ? latestValuation.totalInventory : rows.reduce(...)
// AIM2026Dashboard.tsx:267-269 — se arrastra intacta en cada recálculo
```
Root cause: la última fila de `aim2026_stock_valuation_history` es 2026-07-07 (total 1.691.052) porque ningún cálculo completo corrió desde entonces; las filas de la tabla usan SOH del 2026-07-27. Recalculando el snapshot con SOH de hoy da 1.155.500 → la card está +46,3% alto contra la fórmula oficial y +25,2% contra el propio total del strip.

**4 — El centinela 999 fabrica OVERSTOCK y vacía ITEMS AT RISK**
```ts
// calc-kpis-v2:805
const daysOfCover = avgDailyDemand > 0 ? mainWH.quantity / avgDailyDemand : 999;
// :555-561
if (daysOfCover > 180) return "OVERSTOCK";
```
Root cause: 999 significa "sin demanda", no "999 días". DB: 564 filas con 999, de las cuales 491 tienen stock 0 → clasificadas OVERSTOCK. `api.ts:615-617` cuenta riesgo sólo sobre CRITICAL|LOW STOCK, así que esas 491 son inalcanzables por definición. Además la columna Cover imprime "999d" en violeta como si fuera medido (InventoryTable.tsx:674-676). En la ventana Jun–Jul sólo 469 de 1538 SKUs tienen bucket de demanda, así que ~1069 filas caerían en el centinela.

**5 — Promedios sobre poblaciones no medibles y asimétricas**
```ts
// AIM2026Dashboard.tsx:403-411
const withSellingPrice = filteredData.filter((r) => (r.avgSellingPrice ?? 0) > 0);
...
avgTurnover: filteredData.reduce((s, r) => s + r.turnover, 0) / n,
avgGMROI: filteredData.reduce((s, r) => s + r.gmroi, 0) / n,
```
Root cause: Margin excluye las filas sin precio (941 de 1531), pero Turnover y GMROI dividen por las 1531 incluyendo 1180 y 1185 ceros estructurales. Efecto: turnover 1.92 vs 8.36 real (4,35× subestimado), GMROI 2.22 vs 10.51, coverage 450d vs 66d. En el estado observado, AVG MARGIN imprime "0.0%" que es el fallback de conjunto vacío (`: 0` en :406) — la misma data que la tabla dibuja como "—".

**6 — El strip duplica el stock en tránsito**
```ts
// AIM2026Dashboard.tsx:387
china += r.sohChina * (r.productCostChina || 0);   // China BRUTO
// calc-kpis-v2:929-932 (fórmula oficial)
const netChinaQty = Math.max(0, chinaWH.quantity - containerWH.quantity - dhlWH.quantity);
totalValuationChina += netChinaQty * params.productCostChina;
```
Root cause: las unidades embarcadas siguen contadas en el SOH de China; el snapshot las neta, el strip no. Reproducido sobre SOH del 27-jul: 426.518 (bruto) vs 231.397 (neto) → strip 1.350.620 vs snapshot 1.155.500, delta 195.120 (+16,9%). No se ve en la fila observada sólo porque ese SKU tiene costo 0 y China 0.

**7 — La revenue de las órdenes Placed se descarta en el loader**
```ts
// calc-kpis-v2:277-281
.select("sku, period_date, status, quantity, customer_type")   // falta `amount`
// :812-814
const totalQtySold = demandMonths.reduce((s, m) => s + m.quantity, 0);
const avgSellingPrice = totalQtySold > 0 ? demandStats.totalRevenue / totalQtySold : 0;
```
Root cause: Demand suma `quantity + componentUsage + placed + backordered` (:492), pero ASP divide sólo por `quantity` (facturado). PSD-HD-DL tiene `amount = 1606.5` sobre las 51 unidades Placed (ASP 31,50) en `aim2026_demand_detail` — el dato está en la DB y el `select` no lo pide. GMROI hereda el error en :825, multiplicando una demanda que incluye componentes y Placed por un margen unitario derivado sólo de lo facturado. 590 de 1531 filas tienen ASP 0.

**8 — Costo 0 con precio > 0 produce margen exacto de 100%**
```ts
// calc-kpis-v2:816-818
const marginPercent = avgSellingPrice > 0 ? ((avgSellingPrice - landedCostAUD) / avgSellingPrice) * 100 : 0;
```
Root cause: con `landedCostAUD = 0` el resultado es exactamente 100. DB: 59 filas con costo 0 y ASP > 0, y exactamente 59 filas con marginPercent = 100.0. Todas pasan el filtro `avgSellingPrice > 0` de api.ts:620, así que empujan AVG MARGIN hacia arriba y en la tabla se ven como "100.0%" en verde.

**9 — "Never synced" y el auto-sync que no recalcula**
```ts
// api.ts:767-769 (recalcKPIsForDateRange)
totalProducts: rows.length,
lastSyncAt: null,
inventoryValueHistory: [],
// AIM2026Dashboard.tsx:898-899
if (!kpiSummary?.lastSyncAt) return 'Never synced';
```
Root cause doble: (a) el merge de :263-271 rescata sólo los tres campos de inventario, así que `lastSyncAt: null` sobrevive siempre en el rango por defecto (30 días); (b) `sync-orchestrate/index.ts:25-63` tiene 16 pasos y ninguno es `aim2026-calc-kpis-v2` — los únicos llamadores son manuales (api.ts:276, :304, :491, vía SettingsPanel). DB: `max(calculated_at)` = 2026-07-07 03:10Z mientras `max(aim2026_sync_log.synced_at)` = 2026-07-27 20:12Z. Aparte, cuando sí se renderiza, "last sync" es `kpiData[0]?.calculated_at` (api.ts:636) — el timestamp del primer SKU alfabético, no un tiempo de sync; `aim2026_sync_log` no lo lee nadie en el frontend.

**10 — Tres poblaciones de producto**
```ts
// calc-kpis-v2:705 — universo del recálculo
const allSKUs = new Set([...skuParams.keys(), ...sohMap.keys()]);   // 1538
// api.ts:635 (caché) y :767 (recálculo) — mismo nombre, distinto universo
totalProducts: rows.length,
```
Root cause: el header/footer usan 1538 (params ∪ SOH), el caché tiene 1531, y el denominador de las KPI cards usa 1362 porque `showAssembledProducts` arranca en false (AIM2026Dashboard.tsx:142, filtro en :337-338). Cruzar el umbral de 11 meses cambia el conteo en 7 productos. PSD-HD-DL sólo es visible porque está en `sku_parameters` y no en el caché.

**11 — Márgenes negativos escondidos detrás de "—"**
```tsx
// InventoryTable.tsx:711-713
{row.original.marginPercent > 0 ? `${row.original.marginPercent.toFixed(1)}%` : '—'}
// :733
{row.original.gmroi > 100 ? '>100' : row.original.gmroi > 0 ? row.original.gmroi.toFixed(1) : '—'}
```
Root cause: el test es `> 0`, no un chequeo de null. 20 filas con margen negativo y 17 con GMROI negativo se ven igual que "sin costo cargado", y la rama roja de `getMarginColor` (:50) es inalcanzable. Esas filas sí siguen dentro del denominador de AVG MARGIN.

**12 — El CSV valúa China con otro costo**
```ts
// aim2026-get-dashboard:487, :560, :575
const useFOB = warehouseKey === "china" || warehouseKey === "onProduction";
const unitCost = useFOB ? costChina * exchangeRate : landedAUD;
valuationMethod: useFOB ? "FOB × Exchange Rate" : "Landed Cost AUD"
```
Root cause: contradice `calc-kpis-v2:807` (`*** LANDED COST — NO FX conversion — costs are already AUD ***`) y :932, que usan `productCostChina` crudo. Sumado a que el CSV usa China bruto (sin el dedup de :929), el total de China del CSV hoy da ~656.838 contra 231.397 de la fórmula oficial: 2,84×. El proveedor del SKU se llama "WINKIN 2025 (AUD)", lo que apunta a que el camino con FX es el equivocado. Además el CSV rotula la columna `Cost China (USD)` (StockValuationDialog.tsx:96) sobre un valor que el backend declara AUD.

**13 — El texto de ayuda describe un método que no corre**
```tsx
// StockValuationDialog.tsx:180-181
"Main WH is valued at landed cost (AUD), while China/Production locations are valued at FOB cost × exchange rate."
```
Root cause: las barras muestran FOB × 1; el texto afirma FOB × 1.54. Quien reconcilie contra Unleashed siguiendo ese texto concluirá que el dashboard sub-reporta China un 54%.

**14 — El chip de fechas gobierna menos de lo que parece**
```ts
// calc-kpis-v2:215-216 — sólo la demanda está ventaneada
.gte("period_date", startDate) .lte("period_date", endDate)
// :143-163 loadTodaySOH — "hoy o el último snapshot", sin rango
```
Root cause: SOH, valuación y los tres contadores ignoran el chip; Cover mezcla stock de hoy con tasa de demanda Jun–Jul (790 ÷ (61/30) = 388,5 → 389d). Y al superar 11 meses (AIM2026Dashboard.tsx:228) la app sirve el caché del 7-jul, cambiando también las cantidades de stock — el usuario creyó ampliar sólo una ventana de demanda. Esa rama tampoco refresca `setValuation`/`setValuationHistory` (:231-238), así que el diálogo de valuación puede abrir vacío o con datos del rango anterior.

**15 — Búsqueda sin coincidencias revierte a global**
```ts
// AIM2026Dashboard.tsx:397-398
if (filteredData.length === 0 || filteredData.length === skuData.length) return null;
```
Root cause: con null, las cinco cards caen a los valores globales (at_risk 644, coverage 450d, turnover 1.92) con la tabla vacía debajo. Nota: la segunda condición (`=== skuData.length`) es código muerto — con assembled excluidos por defecto, filteredData nunca llega a 1538.

**16 — Demand 61 no es una tasa de venta recurrente**
```ts
// calc-kpis-v2:492
const base = m.quantity + m.componentUsage + m.placed + m.backordered;
// :773
const avgDailyDemand = demandStats.avgMonthly / 30;
```
Root cause: DB para este SKU: un solo bucket 2026-07, `quantity_sold = 0`, `component_usage = 10`, más dos líneas `sale/Placed` (50 el 06-jul + 1 el 15-jul). El 61 es una compra puntual + consumo de componentes tratado como run-rate mensual, y de ahí salen Cover 389d y ROP 92. La composición está documentada en el tooltip (types.ts:371), no en la fila.

**17 — El denominador del promedio de demanda varía por fila**
```ts
// calc-kpis-v2:500-508
avg = totalWeight > 0 ? weightedSum / totalWeight : sum / totalQuantities.length;
```
Root cause: `months` sólo contiene filas devueltas por la query; los meses sin registro no existen (modelo disperso, no error de cálculo). En Jun–Jul: 415 SKUs tienen bucket de junio, 310 de julio, 469 distintos — o sea 256 filas promedian sobre 2 meses y 213 sobre 1, en la misma vista y sin distintivo.

**18 — Modo diario bajo 30 días (latente)**
```ts
// calc-kpis-v2:644, :862-864
const useDailyMode = totalRangeDays < 30;
projectedDemand: useDailyMode ? Math.round((dailyDemandMap.get(sku) ?? 0) / totalRangeDays) : Math.round(demandStats.avgMonthly),
```
Root cause: sólo la celda Demand cambia de fuente (`aim2026_demand_detail` por `order_date`) y de unidad; Cover, ROP, Target, Turnover y GMROI siguen leyendo `demandStats.avgMonthly`. Ejemplo en este SKU con 10-jul..20-jul: Demand mostraría "—" (round(1/11) = 0) al lado de un Cover de 389d. Ese `Math.round` deja en 0 a todo SKU bajo 1 unidad/día. El tooltip tampoco cambia (InventoryTable.tsx:322-323 pasa siempre `kpiKey="projectedDemand"`).

**19 — Sparkline al revés**
```ts
// aim2026-get-dashboard:192-194
.order("snapshot_date", { ascending: false })
// KPISummaryCards.tsx:238 — se pasa crudo; el Sparkline mapea índice→x en :17-19
```
Root cause: índice 0 es el dato más nuevo (1.691.052, el mínimo) y el índice 9 el más viejo (2.064.490, el máximo) → una caída del 18% se dibuja como suba. Los otros dos consumidores sí invierten (`[...history].reverse()` en StockValuationDialog.tsx:283 y StockValuationPanel.tsx:269). El eje x además es equiespaciado sobre snapshots irregulares (huecos de 1, 3 y 7 días), así que la pendiente tampoco es una tasa.

**20 — Sug. Qty resta dos veces las unidades en tránsito**
```ts
// calc-kpis-v2:790-798
const pipeline = containerWH.quantity + dhlWH.quantity + onProdWH.quantity;
... Math.max(0, targetStockLevel - mainWH.quantity - chinaWH.quantity - pipeline)
```
Root cause: la valuación en la misma función neta China contra Container/DHL (:929) porque son las mismas unidades físicas; el cálculo de reposición las resta dos veces. Cualquier SKU con China > 0 y Container/DHL > 0 tiene Sug. Qty subestimada hasta en `min(china, container+dhl)`, pudiendo suprimir una recompra necesaria. Aparte, el tooltip documenta `max(0, Target − SOH − Pipeline)` (types.ts:379), sin el término China.

**21 — ABC depende de la ventana elegida**
```ts
// calc-kpis-v2:689-694 arma skuRevenues iterando sólo demandMap; :828
const abcClass = abcMap.get(sku) ?? params.abcClass ?? "C";
```
Root cause: "C" acá significa "sin revenue dentro del rango", no "SKU de bajo valor". ~564 SKUs sin fila de demanda en la ventana ni siquiera entran al universo de comparación y caen a la clase guardada (969 de 1538 la tienen) o a "C" literal. La columna mezcla clases recalculadas y clases viejas sin distinguirlas; el tooltip (types.ts:399) no menciona que el universo es el rango.

**22 — Tasa 1.54 hardcodeada**
```ts
// api.ts:622-623
// Use exchange rate from config if available, else default 1.54
const exchangeRate = 1.54;
```
Root cause: el comentario promete lo que la línea siguiente contradice, en las tres rutas (:622, :755, :810). Hoy coincide con el valor de `aim2026_cost_config` (1.54) así que el número es correcto; ninguna pantalla del AIM permite editarlo (SettingsPanel no contiene la palabra "exchange"), así que sólo diverge si alguien lo cambia en la DB.

**23 — Falta Pesado Korea en el strip**
```ts
// AIM2026Dashboard.tsx:392
const total = mainWH + china + container + dhl + onProduction;   // 5 buckets
// calc-kpis-v2:936 — el snapshot suma un sexto
totalValuationKorea += koreaWH.quantity * landedCostAUD;
```
Root cause: por definición el Total del strip no puede igualar al del diálogo. Impacto hoy: 0 AUD (Korea = 0 en todos los snapshots recientes). El "DHL $0" observado es correcto: no hay filas de DHL el 27-jul.

**24 — Flechas de tendencia siempre "stable"**
```ts
// calc-kpis-v2:516-519
let trend: "up"|"down"|"stable" = "stable";   // sólo se reasigna si totalQuantities.length >= 6
// api.ts:630/633 — literal 'stable' en las tres rutas
```
Root cause: ninguna ruta de producción puede emitir up/down (el único no-'stable' del repo está en mock-data.ts:117), pero el tooltip de TrendIndicator afirma "Stable" como hecho medido. Además las flechas de Turnover/Margin se leen de `data`, no del override filtrado (KPISummaryCards.tsx:264, :283).

**25 — SOH China 0 con 51 unidades allocated**
```tsx
// InventoryTable.tsx:386-390 + :27 → formatNum(0) === '—'
// calc-kpis-v2:859-860
allocatedChina: chinaWH.allocated, availableChina: chinaWH.available,
```
Root cause: el dato no falta — China-W realmente tiene quantity 0, allocated 51, available −51 el 27-jul. Las columnas Allocated/Available están detrás de `filters.showAllocation`, y `projectionUtils.ts:164` clampea el negativo con `Math.max(0, ...)`, así que nada en la vista por defecto señala disponibilidad negativa.

**26 — Unidad de Turnover inconsistente**
```tsx
// KPISummaryCards.tsx:261-262
value={avgTurnover.toFixed(1)} subtitle="times per period"
// calc-kpis-v2:821
const annualCOGS = demandStats.avgMonthly * 12 * landedCostAUD;   // anualizado
```
Root cause: el valor es anual; la card dice "per period", el tooltip (types.ts:387) dice "per YEAR (annualized)" y SKUDetailDialog.tsx:391 dice "Times/period". Tres superficies, tres unidades. Ese mismo diálogo pinta el 0 por costo faltante en rojo con el sub-label "Below target" (SKUDetailDialog.tsx:393-399), emitiendo un juicio sobre un dato inexistente.

## Pendiente de confirmar

1. **¿Los 287 SKUs sin costo son datos faltantes o productos que legítimamente no tienen costo?** Los 58 con stock son los que valen. Query: `select sku, product_cost_china, supplier from aim2026_sku_parameters where product_cost_china is null or product_cost_china = 0 order by sku;` cruzado con SOH del último snapshot.
2. **Criterio tuyo: qué debe mostrar Cover cuando no hay demanda.** Hoy es el literal 999 (calc-kpis-v2:805) y arrastra Status, ITEMS AT RISK y AVG COVERAGE. Definir si es "sin datos" (null / "—") o si el umbral OVERSTOCK debe exigir demanda > 0.
3. **Criterio tuyo: China / On Production se valúan FOB × 1.54 o en AUD directo.** Hoy el snapshot dice AUD directo y el CSV dice × 1.54. El proveedor de PSD-HD-DL se llama "WINKIN 2025 (AUD)" pero eso no prueba que todos lo sean. Query: `select distinct supplier from aim2026_sku_parameters;` para ver cuántos proveedores están denominados en USD.
4. **¿Las 51 unidades allocated en China-W son las mismas 51 de las órdenes Placed?** Las cantidades coinciden (50+1 vs 51) pero no hay clave que una `aim2026_demand_detail` con `aim2026_soh_snapshots.allocated`. Confirmar comparando los números de orden de las dos líneas Placed contra las asignaciones en Unleashed.
5. **¿El promedio de demanda debe dividir por meses del rango o por meses con datos?** Cambia el valor de 256 filas en la vista Jun–Jul. Requiere tu criterio, no una query.
6. **Hipótesis del redondeo de Demand:** en la ruta ponderada por rango puede haber filas con `projectedDemand = 0` pero Cover finito y ROP > 0 (efecto sin causa visible). En el caché no ocurre (0 filas con `projectedDemand = 0 AND 0 < daysOfCover < 999`). Confirmar corriendo el recálculo Jun–Jul y contando filas con esa condición.
7. **Assembled 176 vs 175:** los 176 de `aim2026_assembled_products` están todos en `sku_parameters`, pero sólo 175 en `aim2026_kpi_cache`. En la ruta caché el chip "excluding 176 assembled" queda desfasado en 1. Query: `select sku from aim2026_assembled_products except select sku from aim2026_kpi_cache;`
8. **¿Existen hoy las bodegas Pesado Korea y DHL?** Si están discontinuadas, el bucket faltante del strip es irrelevante; si no, es un agujero futuro. Query: `select distinct warehouse from aim2026_soh_snapshots where snapshot_date = '2026-07-27';`

---

# Parte 2 — Las dos preguntas de Mario (2026-07-28)

## A — WH Demand no cambia la tabla

El selector **no es un filtro**: no recalcula nada ni excluye filas. Lo único que hace en la grilla es **agregar una columna extra** (verde, a la izquierda de ROP) con el total de ese warehouse para el SKU. Demand, ABC, SOH, Container, ROP, Sug. Qty, Cover, Turnover, Margin y Status vienen de otro cálculo que consulta siempre `warehouse = 'All'`, así que estructuralmente no pueden moverse. No es un bug de renderizado: es un control que parece filtro y nunca lo fue.

- Único consumo en la tabla: `InventoryTable.tsx:481-515` — `if (warehouseDemandFilter) { ... cols.push({ id: 'warehouseDemand', accessorFn: (row) => warehouseDemandMap?.get(row.sku) ?? 0 ... }) }`. No filtra `data`, no excluye filas, no dispara recálculo. Los otros dos consumidores de `warehouseDemandMap` son `AIM2026ExportCSVDialog.tsx:109-112` (columna extra en el CSV) y `RealInboundStockDialog.tsx:614-615` (ahí sí alimenta el China daily demand, o sea el selector cambia números **en otro diálogo**).
- El KPI engine está clavado al agregado combinado: `aim2026-calc-kpis-v2/index.ts:211` `.eq("warehouse", "All")`, y `:279` `.select("sku, period_date, status, quantity, customer_type")` — ni siquiera selecciona `warehouse`. Verificado contra la función **desplegada** (v19, ACTIVE, idéntica al repo).
- El efecto de recálculo del front no recibe ningún identificador de warehouse: `AIM2026Dashboard.tsx:283`, deps = `[dateRange.from, dateRange.to, filters.demandMode, loading, needsFirstSync]`.
- La columna extra tampoco es comparable con Demand: `aim2026-get-dashboard/index.ts:748` `.neq("warehouse","All")` y `:765` suman **el total crudo del período**, mientras Demand es un **promedio mensual ponderado** (`calc-kpis-v2:496-510`). Ej. Jun–Jul 2026: PSD-HD-54 mostraría 3.751 en la columna WH contra ≈1.904 en Demand.
- Caso PSD-HD-DL concreto: `aim2026_demand_detail` devuelve exactamente 2 grupos — `(2026-07-01, component_usage, Completed, Main Warehouse, 10 u)` y `(2026-07-01, sale, Placed, China-W, 51 u)` = 61. Pero `aim2026_demand_history` sólo tiene filas `All` y `Main Warehouse` con 10 u; **no hay fila China-W**, porque las filas por warehouse sólo llevan ventas Completed + component usage, nunca Placed/Backordered/Parked. O sea: el 84% de la demanda de ese SKU es una orden China-W que no vive en ningún bucket de warehouse, y eligiendo "China-W" el SKU muestra "—".
- La aritmética confirma que lo que se ve es el cálculo combinado: 61/30 = 2,0333/día × 45 días de lead time + safety 0 → ROP 92 ✓; 790/2,0333 = 388,5 → Cover 389d ✓ → `calcStatus(>180)` = OVERSTOCK ✓ (`calc-kpis-v2:784`, `:805`, `:554-561`).
- **Para que el selector signifique lo que Mario espera habría que recalcular por warehouse**: Demand (y su split B2B/B2C), avgDailyDemand, ROP, Sug. Qty, Days of Cover, Turnover y Status — más definir contra qué stock se mide Cover/Sug. Qty, porque hoy están cableados al SOH de Main Warehouse (`calc-kpis-v2:796-805`).

## B — No se puede discriminar el canal

El número de Demand es **ciego al canal**: incluye todo (Shopify + wholesale + component usage) y no existe ningún filtro por canal en la pantalla. El botón "B2B / B2C split" **no filtra**: parte la misma cifra total en dos columnas usando un ratio, y ROP / Sug. Qty / Cover siguen siendo all-channel. Sí existe una superficie de canal: al **clickear el número de Demand** se abre el `DemandHistoryDialog`, con toggle B2B/B2C por mes y pills "B2B 12M / B2C 12M". Esa superficie **responde bien hasta 2026-02 y responde mal desde 2026-04**, porque el dato de canal dejó de cargarse.

Realidad de la DB (queries read-only sobre `teewkafclgpfpczftvah`):

- La única columna que identifica canal es **`aim2026_demand_detail.customer_type`**. `aim2026_demand_history` (que aporta la base de Demand) **no tiene columna de canal**: id, period_date, sku, quantity_sold, revenue, component_usage, created_at, warehouse.
- Poblado de `customer_type` en filas `type='sale'` (blank / typed): 2025-11 → 1 / 7.446 · 2025-12 → 1 / 8.707 · 2026-01 → 3 / 7.772 · 2026-02 → 0 / 6.031 · **2026-03 → 528 / 4.412** · **2026-04 → 6.320 / 32** · **2026-05 → 263 / 0** · **2026-06 → 3.521 / 0** · **2026-07 → 5.516 / 0**. En los últimos 12 meses: 41.999 de 144.168 unidades sin canal (29,1%).
- Las filas `component_usage` están en blanco **por diseño** y quedan fuera de todo cálculo de canal (`.eq("type","sale")`), así que no cuentan como daño.
- Blank se clasifica silenciosamente como **B2B** (`calc-kpis-v2:256-259`, misma lógica en `get-dashboard:358-361`). No hay categoría "desconocido".
- Causa raíz: `aim2026-sync-unleashed/index.ts:426` `const customerType = String(order.CustomerType ?? "").trim();` — lee el campo del **objeto orden**, que el payload de SalesOrders de Unleashed no trae (los datos de cliente vienen anidados en `order.Customer`). El sibling que sí funciona pagina el endpoint **Customers**: `unleashed-sales-sync/index.ts:87-91`.
- **`unleashed_sales_lines` sí está limpio**: `customer_type` poblado en 99,86% desde 2024-07-01 hasta hoy (Web 163.042 filas, AUS Wholesale 14.530, ITL Wholesale 3.856, Australia 928, etc.; sólo 249 blanks). Shopify = `'Web'`.
- Extra: `fetchDemandChannelSplit` (`api.ts:1356`) es código muerto sin llamador, y su handler filtra `.eq("status","completed")` en minúscula contra datos capitalizados (`Completed`, 82.409 filas) → siempre devolvería vacío.

Composición exacta de las 3 unidades de **PF02BR58-BBK-HY**:

- `aim2026_demand_detail`: 3 filas en 2026-07, todas `sale / Completed / Main Warehouse`, 1 unidad cada una — órdenes PsdLLCPSD#59491 (07-01, $150,70), #62638 (07-23, $150,70), #62876 (07-25, $117,40). `customer_type = ''` en las tres.
- `unleashed_sales_lines`: esas mismas tres órdenes están tipadas **`'Web'`** (source `api`). **Mario tiene razón: 3/3 Shopify, 0 B2B.** Hoy tanto las columnas split de la tabla como el diálogo mostrarían B2B 3 / B2C 0 — exactamente al revés.
- Además faltan 3 ventas Shopify de junio del mismo SKU (06-01 $233,53, 06-03 $158,69, 06-16 $214,20) que nunca llegaron a las tablas AIM. Es parte de un hueco mayor: junio 2026 tiene **121 de 384 SKUs con demanda 0 registrada (7.637 unidades sin registrar)**.

**Factibilidad:** sí es factible un corte por canal para toda la ventana 2024-07 → hoy usando `unleashed_sales_lines.customer_type`; no lo es hoy con `aim2026_demand_detail` tal como está, porque el canal está vacío justo en la ventana de planificación (2026-04 en adelante).

## Qué falta decidir (parte 2)

1. Qué debe significar el selector "WH Demand": ¿un filtro real que recalcula ROP / Sug. Qty / Cover / Status por warehouse, o una columna informativa que se renombra para que no parezca filtro?
2. Si se recalcula por warehouse: contra qué stock se mide Cover y Sug. Qty (hoy siempre Main Warehouse), y qué se hace con órdenes Placed/Backordered/Parked de China-W que hoy no pertenecen a ningún bucket.
3. Si el canal debe ser un **filtro** que cambia los números de planificación, o sólo una **vista** (split/drill-down) que discrimine sin alterar ROP/Cover.
4. Cómo clasificar el bucket `'Australia'` (928 filas, facturación directa): hoy cae en B2B.
5. Qué mostrar para el período con canal vacío (2026-04 en adelante) hasta que se corrija: ¿"sin dato" explícito en lugar del actual default a B2B?
6. Si el hueco de junio 2026 (121 SKUs / 7.637 unidades sin demanda registrada) se trata como incidente aparte y con qué prioridad — afecta el baseline antes incluso de la pregunta de canal.
