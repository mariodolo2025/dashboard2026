# Diseño — conteo incremental para el panel Web Upgrade

> Estado: **IMPLEMENTADO el 2026-08-07** — tablas, trigger, backfill y swap de la
> RPC aplicados y verificados (8/8 salidas byte-idénticas; 30 días 10,7–46,7 s → ~1 s).
> Números finales: [`20260807120000_web_upgrade_performance_read_rollups.sql`](../supabase/migrations/20260807120000_web_upgrade_performance_read_rollups.sql).
> Contexto: [`HANDOVER-2026-08-05-TIMEOUT.md`](HANDOVER-2026-08-05-TIMEOUT.md).
> Complementa la opción A (una vista por sesión, en curso con Codex) y la B (aplicada el 7-ago).
> v2 = v1 + correcciones de una revisión adversarial (3 revisores + refutadores
> independientes contra la base real). Hallazgos al final (§10).

## 1. Resumen simple

Hoy, cada vez que se abre el panel, la base cuenta todos los eventos desde cero
(254.000 filas para 30 días: 10–47 segundos, y el techo es 25). La solución:
contar cada día **una sola vez**, guardar los totales diarios en tablas chicas,
y que el panel sume esos totales.

Meta honesta: **30 días pasa de 10–47 s a ~2–3 s**. El piso ya no lo ponen los
eventos (ese costo queda en ~0) sino los bloques de ventas de Shopify, que hoy
cuestan ~1–2 s y no se tocan en este cambio.

El panel no cambia nada: misma pantalla, mismos números. Solo cambia de dónde
los lee la base.

## 2. Los dos tipos de números del panel

| Tipo | Ejemplos | ¿Se puede sumar por día? |
|---|---|---|
| **Conteos** | views, clicks, selects, adds, unlocks, eventos totales | Sí — 30 días = sumar 30 renglones |
| **Personas distintas** | exposedSessions, sessions por módulo, sessions de la barra, bought | No — Juan lunes + Juan martes = 1, no 2 |

Los bloques de ventas (`sales`, `basket`, `prelaunch`, `orderImpact`) leen las
tablas de Shopify, son el piso de ~1–2 s y **no se tocan** (mejora opcional en §9).

## 3. Las tablas nuevas (5)

Todas con clave del día `d` (día UTC, igual que el slim — decisión de calendario
cerrada) y columna `environment` (el RPC filtra `production` / `all`).

```
web_upgrade_daily_counts   (d, environment, module, action, n)
    -- Todos los conteos por acción. `module` toma: los 4 módulos reales,
    -- 'Other', '__bar' (eventos de barra/botón) y '__meta' (contadores
    -- sintéticos: action='__complete_kit' = eventos de la guía con
    -- p_source='compatibility_complete_kit').
    -- REGLA DE LECTURA (obligatoria): totalEvents, modules y trend suman
    -- SOLO module not in ('__bar','__meta'). compatibilityBar lee '__bar';
    -- completeKit lee '__meta'. Sin esta regla, complete-kit se cuenta dos
    -- veces y la barra contamina los módulos (incidente 30-jul, de nuevo).
    -- storage: fillfactor=75 y autovacuum_vacuum_scale_factor=0.05 (la fila
    -- de hoy recibe ~9k updates/día; ver §10.9).

web_upgrade_daily_brand_model (d, environment, brand, model, selects, add_clicks, adds)
    -- byBrand y byModel. Valores CRUDOS de p_brand/p_machine (sin
    -- coalesce/nullif); la normalización a 'Unknown'/'(model not sent)' queda
    -- en el RPC, idéntica a hoy — incluida la distinción NULL vs '' (el RPC
    -- filtra p_brand is not null ANTES de normalizar).
    -- Clave: UNIQUE NULLS NOT DISTINCT (d, environment, brand, model) con
    -- brand/model nullable — un unique común trata los NULL como distintos y
    -- el upsert insertaría una fila nueva por evento, para siempre.
    -- fillfactor/autovacuum como daily_counts.

web_upgrade_daily_variant  (d, environment, variant_id, add_clicks, adds)
    -- byScreen. Se guarda variant_id, NO el sku: el join a shopify_variant_map
    -- queda en el RPC (el mapa puede cambiar; el rollup no debe fosilizarlo).

web_upgrade_daily_rewards  (d, environment, reward_name, unlocks)
    -- reward_name = coalesce(p_reward_name, '?') — igual que el RPC.

web_upgrade_sessions_daily (d, environment, scope, attribution_id)
    -- UNA fila por sesión, por día, por ámbito. Resuelve "personas distintas".
    -- scopes: 'all' | 'module:<module>' | 'bar:mobile:view' | 'bar:mobile:click'
    --         | 'bar:desktop:view' | 'bar:desktop:click' | 'reward:<name>'
    -- PK (d, environment, scope, attribution_id).
    -- Índice de lectura: (environment, scope, d, attribution_id) — `d` en
    -- TERCERA posición, no última: así el scan queda acotado a la ventana
    -- pedida. Con d al final se relee toda la historia del scope en cada
    -- apertura — la misma enfermedad que este diseño viene a curar (§10.4).
    -- El count(distinct) paga un sort chico acotado por ventana; para que no
    -- vaya a disco, el RPC lleva SET work_mem='16MB' EN SU DEFINICIÓN
    -- (per-función; NO confundir con el intento global de 48MB del 4-ago que
    -- empeoró todo y se revirtió).
    -- attribution_id es 'psd-' + 36 chars (formato uuid). Si TODA la historia
    -- matchea '^psd-[0-9a-f-]{36}$', se guarda como uuid (16B, índice ~45%
    -- más chico) y el RPC re-antepone 'psd-' al comparar contra buyer_ids.
    -- Si algún valor no matchea, se queda text y listo.
```

Reglas de derivación — replicadas en un solo lugar, una función
`web_upgrade_rollup_classify(...)` usada por trigger y reconcile:

1. **Primero** se resuelve barra/botón (`compatibility_bar_%`,
   `compatibility_button_%`) → module '__bar' / scopes bar:*. **Después** corre
   el case de módulos del RPC sobre lo que queda. El orden importa: el case
   solo, aplicado literal, clasificaría la barra como 'Compatibility Guide'
   (matchea 'compatibility%') — el RPC no lo sufre porque su WHERE excluye la
   barra antes.
2. Guard de `compatibility_page_view`: cuenta solo si `p_page_path` es vacío
   (historia pre-campo) o contiene `compatibility-guide`.
3. **El classify jamás lanza excepción** (está en el camino del ingest: una
   excepción pierde el evento entero, silenciosamente). Casts con guarda:
   variant solo si `~ '^[0-9]+$'`; reward_name con coalesce; ante payload
   inesperado se degrada a "sin rollup", nunca se aborta.

## 4. Cómo se mantienen

**Camino caliente — trigger.** Hoy: `upgrade_events` → `upgrade_events_slim_trg`
→ `upgrade_events_slim`. Se agrega un trigger AFTER INSERT/UPDATE/DELETE sobre
`upgrade_events_slim` (encadenado; el slim ya tiene `d` y las claves):

- Primera línea del trigger: `if current_setting('app.web_upgrade_rollup_skip',
  true) = '1' then return null` — la llave de apagado transaction-local (§10.3).
- INSERT → upsert `n = n + 1` en counts; `ON CONFLICT DO NOTHING` en sessions.
- DELETE → `n = n - 1`; sessions_daily recalcula esa clave puntual desde el slim.
- UPDATE → delete+insert. Hoy no ocurre en operación normal.

**Invariante de retención:** los rollups de días cerrados son inmutables ante
purges. Si algún día se ejecuta la opción C del handover (retención sobre
`upgrade_events`), debe correr con el GUC de skip activo — si no, el purge
decrementa los rollups a cero y el panel pierde justo la historia que estas
tablas existen para conservar.

**Reparación — reconcile.** `web_upgrade_daily_reconcile(p_from, p_to)`:

1. `LOCK TABLE <las 5 tablas rollup> IN EXCLUSIVE MODE` — una sentencia, orden
   fijo. Sin esto, el rebuild choca con el ingest vivo: una clave nueva
   commiteada entre el DELETE y el INSERT aborta todo por unique_violation, y
   "arreglarlo" con ON CONFLICT pierde o duplica según el interleaving (§10.2).
   Con el lock, los triggers escritores esperan (su fila slim queda sin
   commitear → el snapshot del rebuild no la ve → al soltarse aplican su
   incremento encima: exactly-once). EXCLUSIVE no bloquea SELECT: el panel
   sigue leyendo. El ingest se pausa lo que dura la reconcile.
2. DELETE del rango en las 5 tablas + rebuild set-based desde el slim, misma tx.

**Parche a `upgrade_events_slim_reconcile()`** (misma migración):
- Deshabilitación por transacción, NO por DDL: `set_config('app.web_upgrade_rollup_skip','1',true)`
  al inicio. `ALTER TABLE ... DISABLE TRIGGER` está prohibido acá: en una tx
  bloquea el ingest minutos enteros; en dos, deja huecos silenciosos (§10.3).
- Su upsert gana `where (s.*) is distinct from (excluded.*)` — hoy reescribe
  las 255k filas aunque nada cambie, y cada una dispararía el camino UPDATE
  del trigger nuevo (el más caro).
- Al final encadena `web_upgrade_daily_reconcile` sobre el rango tocado.

## 5. El RPC nuevo

`web_upgrade_performance(p_from, p_to, p_environment)` — **misma firma, mismo
jsonb, el frontend no se toca**. Cambia de dónde lee cada bloque:

| Bloque | Hoy lee | Pasa a leer |
|---|---|---|
| totals (events), modules (counts), compatFunnel, trend (events/día) | slim completo | `daily_counts` con `module not in ('__bar','__meta')` |
| compatibilityBar (views/clicks) | slim (2º scan completo) | `daily_counts` module='__bar' |
| completeKit | slim | `daily_counts` module='__meta' |
| exposedSessions, sessions por módulo/barra/funnel, trend sessions | slim + sorts gigantes | `sessions_daily` |
| byBrand, byModel | slim | `daily_brand_model` |
| byScreen (clicks/adds por variante) | slim | `daily_variant` + join a variant_map |
| rewards (unlocks, sessions, bought) | slim + buyer_ids | `daily_rewards` + `sessions_daily` ∩ buyer_ids |
| sales, basket, prelaunch, storeShare, orderImpact, bySource, byMachine, byFamily | tablas Shopify | **sin cambios** |

Reglas de implementación (no detalles — sin ellas el plan degenera):
- `p_environment='all'` **nunca omite el filtro**: se escribe
  `environment = any(array['production','preview'])` (o desde una lookup). Sin
  igualdad en la columna líder, PG 17 no puede acotar el índice y cada subquery
  cae a scan completo (skip scan es PG 18). El `count(distinct)` absorbe la
  sesión repetida entre environments igual que hoy.
- `SET work_mem = '16MB'` en la definición de la función (ver §3).

**Verificación de igualdad** (criterio de aceptación): salida nueva vs vieja en
≥8 combinaciones: 1/7/30 días × production/all, un rango que arranque **antes
del 23-jul** (§10.6), y un rango que **cruce el 30-jul** (donde una
clasificación errada de la barra divergiría al máximo). Igualdad semántica por
bloque, no md5: arrays con `order by` con empates pueden variar de orden entre
planes sin estar mal — los empates se comparan como conjuntos.

## 6. Backfill y verificación

1. Migración: 5 tablas + índices + classify + trigger + GUC + reconcile +
   parche del slim reconcile.
2. Backfill = `web_upgrade_daily_reconcile((select min(d) from upgrade_events_slim),
   (select max(d) from upgrade_events_slim))` — rango derivado de los DATOS,
   no literal: el slim arranca el **22-jul** (no el 23) y tiene al menos una
   fila con `d` futuro (reloj de cliente adelantado; §10.6). Correrlo fuera de
   pico: el lock del §4 pausa el ingest lo que dure (decenas de segundos).
3. Verificar rollups vs slim ANTES de tocar el RPC: totales por día y por rango
   completo, sobre min(d)..max(d) real. Cero discrepancias o no se avanza.
4. Recién ahí, CREATE OR REPLACE del RPC + igualdad del §5.
5. Medir 1/7/30 días antes/después. Cuando la historia supere ~60 días, repetir
   la medición con ventana chica (1 día) — es el caso que HOY no se puede medir
   (30 días == toda la tabla) y donde el índice mal ordenado sería invisible (§10.4).

## 7. Números esperados (corregidos en revisión)

| | Hoy (7-ago) | Con rollups |
|---|---|---|
| Filas leídas, 30 días | ~254.000 anchas + 4 sorts a disco (~40 MB temp) | ~1.500 totales + ~450–600k filas angostas de sesiones, acotadas por ventana |
| 30 días | 10,7–46,7 s | **~2–3 s** (eventos ~0, piso = bloques de ventas) |
| 7 días | 3,3 s | **~1,5–2 s** |
| Crecimiento | cada evento encarece cada apertura | counts: filas = días × dimensiones (no crece con tráfico). sessions_daily: **~15–20k filas/día** (una por sesión POR SCOPE — no confundir con las ~6–8k sesiones/día), ~600k/mes, ~6,6M/año |

⚠️ sessions_daily a un año ≈ 0,6 GB + índices en una base de 632 MB con 224 MB
de caché. Por eso el "pending v2" de sesiones (rollup mensual o HLL para rangos
>90 días) tiene **gatillo concreto: cuando la historia pase ~90 días**, no
"algún día". Con eso, un rango FY histórico queda en unos pocos segundos —
aceptado: lo histórico puede esperar.

## 8. Compatibilidad y decisiones

- **Exacto, no aproximado.** HLL descartado para el panel de hoy; entra recién
  como estrategia v2 para rangos largos (§7).
- **El slim queda como fuente de verdad** para reconcile y métricas futuras.
  La retención sobre `upgrade_events` crudo (opción C) es otra decisión — pero
  ver el invariante de purge del §4 antes de tocarla.
- **Cambio de Codex (opción A):** sin dependencia. Menos vistas = menos n en
  counts; sessions_daily no cambia (ya era una fila por sesión). Correcto
  antes y después del deploy del theme.
- **d_store** no va en los rollups; si el calendario se revisita, se re-deriva
  del slim con reconcile.

## 9. Mejora opcional barata (misma zona, otra decisión)

`prelaunch` re-agrega en cada apertura una ventana congelada de 84 días sobre
`shopify_sales_lines` (~590 ms medidos). Es constante desde que el baseline se
congeló: materializarla en una fila precalculada recorta uno de los tres scans
de ventas y baja el piso. No es parte de este cambio; queda anotada.

## 10. Revisión adversarial (2026-08-07) — hallazgos incorporados

3 revisores independientes (exactitud / operación / performance) contra la base
real; cada hallazgo grave pasó por un refutador independiente. Los 5 graves
fueron confirmados; ninguno refutado. Todos ya están corregidos arriba:

1. **[exactitud]** La fila sintética `__complete_kit` inflaba totalEvents y
   trend (+395 hoy, ~28/día): eventos reales contados dos veces. → module
   '__meta' + regla de lectura (§3).
2. **[operación]** Reconcile/backfill contra ingest vivo: unique_violation con
   claves frescas (una cada ~4 s en horario activo) o drift silencioso según el
   ON CONFLICT elegido. → LOCK EXCLUSIVE de las 5 tablas (§4).
3. **[operación]** "Deshabilitar el trigger" en el slim reconcile: por DDL
   bloquea el ingest minutos o deja huecos. → GUC transaction-local + guard
   `is distinct from` en su upsert (§4).
4. **[performance]** Índice de sesiones con `d` al final: cada apertura releía
   TODA la historia del scope — el costo volvía a crecer con la edad de la
   tabla. Invisible hoy (30 días == tabla completa). → índice con `d` tercero +
   medición con ventana chica cuando haya historia (§3, §6).
5. **[performance]** Volumen subestimado 2,5×: sessions_daily son ~15–20k
   filas/día (fila por sesión POR SCOPE), no 6–8k; el claim FY de 3–6 s no se
   sostenía. → §7 corregido, gatillo v2 a los ~90 días.

Menores incorporados: barra clasificada antes del case (re-contaminación del
30-jul), backfill desde min(d) real (22-jul + días futuros por reloj de
cliente), NULLS NOT DISTINCT en brand_model, casts con guarda en el classify
(jamás abortar el ingest), `environment = any(...)` para 'all', fillfactor 75 +
autovacuum agresivo en counts, invariante de purge, meta <2s reformulada con el
piso de ventas explícito, prelaunch materializable (§9).
