# Hueco de demanda 2026 — causa y plan de arreglo

> 2026-07-28 · Diagnóstico verificado contra la DB de producción (`teewkafclgpfpczftvah`).
>
> **RESUELTO el 2026-07-28.** El plan de abajo se ejecutó, con una diferencia: en vez de parchear
> el sync se lo migró al patrón incremental de `unleashed-sales-sync` (watermark + upsert por
> Guid + `demand_history` derivada), porque el diseño de borrar-y-rellenar no podía dejar de
> romperse. Enero–julio recuperados: **35.001 unidades**, los cuatro meses viejos al 100,0% de
> la fuente independiente. Resultado y verificación en §2 de [`HANDOVER.md`](HANDOVER.md).

## Causa

El sync de ventas le pide las órdenes a Unleashed con un tope duro de páginas, y **borra los datos antes de traerlos**.

- `aim2026-sync-unleashed/index.ts:368` → `maxPages = 30`, y `:398` pide de a 200. Techo: **6.000 órdenes**.
- `:104` `while (hasMore && page <= maxPages)` y `:120` `return allItems`: si hay más páginas, devuelve el array recortado **sin avisar** — no lanza error, no escribe en `errors[]`, el log queda en `success`.
- `:388-395` pone en cero `quantity_sold`/`revenue` de todo el período, y `:593-600` borra las filas de `aim2026_demand_detail` — **ambos antes del fetch**.
- Resultado: se vacía la ventana entera y se rellena sólo con lo que entró en las 6.000 órdenes. La ventana real tiene ~16.000.

Prueba: `select count(distinct order_number) from aim2026_demand_detail where type='sale' and status='Completed' and order_date >= '2026-05-01'` → **5.990**, pegado al techo.

Las otras tres pasadas (Placed, Parked, Backordered) usan el mismo código pero traen 6, 14 y 31 órdenes: no llegan al tope y no pierden nada. La única variable es el tope.

Segundo defecto, aparte: enero–abril los escribió la rama de sync completo (`:376`, `maxPages = 80` sobre 12 meses) el 2026-07-06. Esas filas tienen `order_number` NULL en el 100% de los casos y también están truncadas.

## Alcance

Comparación contra `unleashed_sales_lines`, status `Completed`, excluyendo líneas sin `product_code` (envío, redondeo, descuento) que el sync descarta bien.

| período | SKUs afectados | unidades faltantes | ¿sigue pasando? |
|---|---|---|---|
| 2026-01 | 103 de 411 (16 en cero) | 3.111 | No. Congelado y roto |
| 2026-02 | 169 de 419 (50 en cero) | 5.284 | No. Congelado y roto |
| 2026-03 | 217 de 371 (77 en cero) | 3.864 | No. Congelado y roto |
| 2026-04 | 254 de 375 (89 en cero) | 3.993 | No. Congelado y roto |
| 2026-05 | 290 de 301 (233 en cero) | 11.166 | **Sí.** Se re-borra 3×/día |
| 2026-06 | 294 de 383 (120 en cero) | 6.892 | **Sí.** Se re-borra 3×/día |
| 2026-07 | 1 de 273 | 7 | No. Sano (100,5%) |

**Total faltante 2026: 34.317 unidades.**

Junio no tiene corte limpio: del 15 al 21 la cobertura va de 0,4% a 20%, el 22 sube a 89,2%, del 23 al 30 está al 100%. Ese bloque bueno sobrevive sólo porque cae dentro de las últimas 6.000 órdenes, y ese piso avanza ~1 día por día.

`aim2026_demand_history` (fila canónica `warehouse='All'`): mayo 1.102 u / $30.325,08 con 224 de 298 filas en cero; junio 4.906 / $233.827,62 con 141 de 415 en cero; julio 6.122 / $352.121,62 con 38 en cero.

Crons activos: jobid 5 `sync-refresh-kickoff`, `0 3,10,20 * * *`. Última corrida del paso de ventas: 2026-07-27 20:09 UTC.

**Plazo duro:** el 2026-08-01 la ventana pasa a arrancar el 2026-06-01. Ese día se borra todo junio —incluido el bloque sano del 23 al 30— y se rellena con lo poco que entre. Junio queda peor que hoy y después se congela así.

## Hallazgo nuevo (review del fix, 2026-07-28): el mismo bug en Assemblies

`syncAssemblies` usa el mismo `unleashedGetAll` con `maxPages = 15` (= 3.000 assemblies) y también está truncando **hoy**:

- `aim2026_demand_detail` type `component_usage` desde 2026-04-01: junio 1.105 + julio 1.895 = **exactamente 3.000** (15 × 200), la firma del truncado.
- `aim2026_demand_history` warehouse `All`, `component_usage`: marzo 5.950 → **abril 0, mayo 0** → junio 2.751, julio 5.100.

O sea: **abril y mayo perdieron todo el component_usage**. Es daño aparte del de ventas y necesita su propio backfill. El cap se subió a 150 en el mismo deploy, porque si no el nuevo throw haría fallar el paso de assemblies en cada corrida.

## Arreglo

### Parte 1 — parar la hemorragia

Todo en `supabase/functions/aim2026-sync-unleashed/index.ts`.

1. **`unleashedGetAll` (93-121).** Si el bucle corta por `maxPages` y quedaban páginas, tiene que **fallar**, no devolver datos incompletos. Regla: nunca devolver un resultado parcial que el llamador no pueda distinguir de uno completo. Este es el cambio central.
2. **`syncSalesOrders` (362-380).** Subir el techo: ~150 páginas (30.000 órdenes) para la ventana incremental, y lo mismo en la rama de sync completo de `:376`.
3. **`syncSalesOrders` (386-395 y 593-600).** Invertir el orden: primero traer todo, y sólo si el fetch vino completo, hacer el cero-out y el borrado. Si falla, no se toca nada y la corrida se marca fallida.
4. **`:604-605`.** El error de inserción hoy sólo va a `console.error`. Cualquier lote fallido tiene que marcar la corrida como fallida.
5. **Acotar el cero-out.** Hoy `:393` es `.gte(period_date, startStr)` **sin techo**. Agregarle fecha final.
6. **Rango explícito por body.** Hoy la ventana se calcula sola desde `now()` (`:367`). Permitir pasar desde/hasta por request, sin cambiar el default.

### Parte 2 — recuperar lo perdido

**No se copia de `unleashed_sales_lines`.** Verificado por qué:
- Las unidades coinciden (julio: 6.089 vs 6.122 = 100,5%).
- **El dinero no.** `sub_total` está en otra base de moneda que el `amount` que escribe el sync (`quantity × UnitPrice`, `:433`). Julio 01-27: $459.183,60 vs $351.648,39 — ratio 1,306 global y 1,380 línea por línea. Copiar de ahí infla el revenue ~30%.
- Esa tabla tampoco tiene `order_number` (`order_guid` es NULL en las filas `source='frozen'`).

**El plan correcto es re-correr el mismo sync ya arreglado, acotado a los meses dañados**, contra la API de Unleashed (`SalesOrders`), que es de donde salen todas las filas sanas. Una pasada por mayo, una por junio, y después una por enero–abril (paso aparte, aprobado por separado: son ~25.000 filas históricas).

Orden dentro de cada rango, igual que `sync-orchestrate/index.ts:37-40`: `Completed` con `isFirstSalesStatus: true`, después `Placed`, `Backordered`, `Parked`.

### Doble conteo — la parte crítica

- `aim2026_demand_detail` es **idempotente**: borra por `(type, period_date, status)` y reinserta (`:593-600`). Correrlo 10 veces da lo mismo que 1.
- `aim2026_demand_history` **NO lo es**: `:518` hace `existing.quantity_sold + newQty`, **acumula**. Lo único que evita el doble conteo es el cero-out de `:388-395`, que sólo corre si la request trae `isFirstSalesStatus: true`.

Tres garantías obligatorias:
1. El cero-out acotado al mismo rango del backfill (hoy sin techo: un backfill de mayo pondría en cero junio y julio y no los rellenaría).
2. Ninguna tanda sin `isFirstSalesStatus: true` en la primera de las cuatro pasadas.
3. Nada se escribe si el fetch no vino completo.

## Riesgos

- **Doble conteo en `demand_history`** — el principal. Mitigado por las tres garantías de arriba.
- **Cero-out sin techo** — podría vaciar julio, que hoy está sano al 100%.
- **El cron sigue corriendo** — si se hace el backfill sin pausar jobid 5, esa misma noche se vuelve a borrar todo.
- **La ventana rueda el 2026-08-01** — plazo duro.
- **Disponibilidad histórica en Unleashed** — el backfill asume que la API todavía devuelve órdenes de mayo. Hay evidencia indirecta (sobreviven 121 órdenes de mayo, la más vieja del 2026-05-11), pero no está probado. **Correr una prueba en seco antes de tocar nada.**
- **Tiempo de ejecución** — 150 páginas seriadas con timeout de 55s (`:82`) puede pasarse del presupuesto de la Edge Function. Medir; si no entra, partir en rangos más chicos.

**Backup obligatorio antes de cualquier escritura:** copia completa de `aim2026_demand_detail` y `aim2026_demand_history` para `period_date >= 2026-01-01`, a tablas con fecha en el nombre. `unleashed_sales_lines` no se toca: queda como testigo independiente.

## Verificación (todas read-only, antes y después)

1. **Cobertura mensual.** Esperado: mayo y junio entre 99% y 101%. Hoy 9,0% y 42,4%.
2. **Tope no saturado.** `count(distinct order_number)` para `>= 2026-05-01` claramente arriba de 6.000 (~16.000). Hoy 5.990.
3. **Junio día por día.** Todos los días 99-101%. Hoy el 15 da 0,4%.
4. **`demand_history` sin ceros masivos.** Mayo ~12.223 u, junio ~11.580, filas en cero bajando de 224 y 141 a un puñado. **Julio debe seguir en 6.122 / $352.121,62 — si julio se movió, algo se rompió.**
5. **Sin doble conteo.** Correr la 4, correr el backfill de nuevo, volver a correr la 4. Números idénticos.
6. **El SKU del incidente.** `PF02BR58-BBK-HY` junio: `dd_jun = 3`, `dh_jun ≠ 0`. Hoy 0 y 0.
7. **El truncado ya no es silencioso.** Correr a propósito con `maxPages` chico: la corrida debe **fallar**, el log quedar distinto de `success`, y las tablas **no cambiar**. Hoy ese escenario registra `success` mientras borra 40 días.
