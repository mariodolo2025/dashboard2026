# Diseño — Tab Advertising (Triple Whale propio)

> Estado: **spec v2, revisada adversarialmente, nada construido**. Fecha: 2026-08-08.
> Contexto obligatorio: [`GOOGLE VS META/5-handover-medicion-ads.md`](GOOGLE%20VS%20META/5-handover-medicion-ads.md)
> y [`GOOGLE VS META/HANDOVER_atribucion_meta_vs_google.md`](GOOGLE%20VS%20META/HANDOVER_atribucion_meta_vs_google.md) —
> ahí viven la teoría, los hechos verificados y la taxonomía UTM vigente. Esta spec no los repite.
> v2 = v1 + correcciones de una revisión adversarial (3 revisores + refutadores contra la
> tienda y la base vivas). Hallazgos al final (§10).

## 1. Resumen simple

La medición de publicidad de la empresa, en nuestra base, con nuestra vara.
Meta y Google se reclaman las mismas ventas; hoy cada sector se califica con el
boletín que imprime su propia plataforma. Este tab mide desde la tienda: qué
orden trajo cada canal (el recorrido completo del comprador), cuánto gastó cada
plataforma, y quién reclama de más. MER como árbitro. Ni Kieran ni Juan
discuten contra el panel del otro — discuten contra la tienda.

## 2. Principios (no negociables)

0. **No romper lo existente.** Este proyecto crea SOLO tablas nuevas
   (`shopify_order_attribution`, `shopify_order_journey_moments`,
   `meta_ads_campaign_daily`, `google_ads_daily`); las tablas y funciones
   actuales se tocan cero — solo lecturas (ventas para el MER, meta_ads_daily
   por cuenta). El orquestador gana un paso nuevo sin modificar los que corren.
   Nada de lo que hoy funciona puede dejar de funcionar por este proyecto,
   salvo pedido expreso de Mario. Misma base de Supabase (separarla rompería
   los cruces con ventas), compartimentado en tablas propias.
1. **Una sola vara.** Todos los canales medidos igual, desde las órdenes reales.
2. **No creerle a nadie.** Lo que cada plataforma declara se muestra AL LADO de
   lo que la tienda le reconoce — la brecha es información, no error.
3. **Regla de lectura, visible en el tab:** nuestra medición **subcuenta** (no
   ve al que vio el ad sin clickear), las plataformas **sobrecuentan** (se
   pisan entre sí). La verdad queda acotada entre ambas; el MER no depende de
   ninguna atribución y arbitra.
4. **Materia prima cruda, para siempre.** Se guarda el recorrido COMPLETO
   (todos los momentos, no un resumen); buckets y modelos se computan al leer.
   Cambiar un modelo nunca requiere re-sincronizar.
5. **Cada métrica con su definición visible** (tooltips como en Web Upgrade), y
   ningún bloque se publica sin pasar su test de aceptación (§9).

## 3. Verificaciones previas (contra la tienda y la base reales)

- `customerJourneySummary` funciona en nuestra tienda: `firstVisit` y
  `lastVisit` con UTMs completos, `daysToConversion`, `customerOrderIndex`
  (número de compra del cliente — habilita CAC), y la conexión **`moments`
  paginada con el recorrido completo** (verificado: PSD#64981 devolvió sus 3
  visitas). Ejemplo real: PSD#64984 (8-ago), primera visita
  `google/cpc/brand-search`, última `facebook/paid` — journey cross-canal.
- ⚠️ `lastVisit` es la última visita **literal, direct incluido**: ~15–20% de
  las órdenes cierran en direct con un canal real antes (medido en vivo). Por
  eso el modelo principal se computa desde `moments` (§Bloque 3), no desde el
  resumen first/last.
- ⚠️ `meta_ads_daily` es por **cuenta**/día — no tiene campañas. El detalle por
  campaña de Meta es trabajo nuevo (§Bloque 2), no algo que "ya está".
- ⚠️ El histórico Meta tiene un tramo (jul-2025 hasta fecha a determinar en el
  backfill) con `utm_campaign = "{{campaign_name}}"` literal (macro sin
  expandir): el análisis por campaña de Meta solo vale desde que llegan IDs;
  el bucket "Meta pago" sí cubre los 13 meses (source/medium siempre vinieron).

## 4. Los 4 bloques

### Bloque 1 — Captura de atribución
Paso nuevo del sync (patrón DB-first por orden, como `shopify-sales-sync`, en
el orquestador 3×/día) que guarda por orden el journey COMPLETO de Shopify:

```
shopify_order_attribution        -- una fila por orden (el resumen)
  order_id (pk) · order_date · ready · moments_count · days_to_conversion
  customer_order_index           -- 1 = primera compra del cliente (CAC)
  first_* / last_*               -- source, referrer, landing, utm_source/medium/campaign/content/term
  synced_at

shopify_order_journey_moments    -- una fila por visita del recorrido
  order_id · seq · occurred_at · source · referrer · landing
  utm_source · utm_medium · utm_campaign · utm_content · utm_term
```

- Crudo: exactamente lo que Shopify devuelve, sin interpretación. Los moments
  son lo que hace cumplible el Principio 4 (un resumen first/last no permite
  recomputar modelos: verificado con journeys de 3+ visitas).
- **Retry explícito de `ready=false`** (el journey tarda en procesarse y esa
  transición NO toca el `updated_at` de la orden — verificado): cada ciclo se
  re-consultan las filas `ready=false` con order_date ≤ 7 días, por ID. Pasados
  7 días sin journey, la orden queda como bucket "sin journey" (contada aparte
  del drift de etiquetas del §7). `ready=true` con journey vacío (existe:
  PSD#38390) es estado final, no reintento.
- **Backfill**: desde 6-ago hacia atrás en tandas hasta cubrir 13 meses
  (~58k órdenes, GraphQL paginado, horario valle). El período pre-6-ago se
  captura igual (crudo) — su interpretación la limita el date-gate del Bloque 3.

### Bloque 2 — Gasto y reclamos por plataforma
Lo que cada plataforma gastó y lo que dice haber vendido.

- **Meta nivel cuenta: ya está** (`meta_ads_daily`). Ojo semántica real:
  guarda **moneda nativa por fila** (cuenta US en USD, cuenta AU ya en AUD,
  columna `currency`); al leer se convierte a AUD SOLO lo USD — nunca doble
  conversión (trampa ya sufrida y documentada en el proyecto).
- **Meta nivel campaña: trabajo nuevo.** `meta_ads_campaign_daily`
  (date, account_id, campaign_id, campaign_name, currency, spend,
  claimed_purchases, claimed_value) vía Insights `level=campaign`, con backfill
  del período comparable. El `campaign_id` cruza contra el `utm_campaign` de
  los journeys (Meta manda el ID numérico). `ecommerce_meta_daily_ads` no
  sirve de sustituto: tiene campaign_NAME texto (no ID), arranca en mar-2026 y
  no tiene currency por fila.
- **Google: `google_ads_daily`** (date, campaign **enum cerrado:
  `brand-search` | `non-brand` | `shopping`** — no texto libre, validado en el
  formulario —, spend_aud, claimed_conversions, **claimed_value_aud**, source
  `manual|api`, updated_by/updated_at). Nace con carga manual en el tab y se
  reemplaza por la API de Google Ads cuando el developer token esté aprobado —
  **el trámite arranca ya, en paralelo**. Reglas de carga: por campaña por día;
  qué se copia del panel: costo y "Conv. value" por fecha de conversión; días
  sin cargar = **null, nunca 0** (regla dura del proyecto) y el MER de ese día
  se marca incompleto en vez de calcularse con gasto parcial.
- Vista SQL `ad_spend_unified` sobre las tres para el motor.

### Bloque 3 — Motor de atribución
SQL sobre la materia prima, todo recomputable al leer:

- **Buckets**: `advertising_bucket(utm_source, utm_medium, utm_campaign,
  referrer, order_date)` → Meta pago · Google brand · Google non-brand ·
  Google Shopping (proxy `product_sync/sag_organic` hasta el tagueo limpio) ·
  Google orgánico · social orgánico · email · direct · **google mixto
  (pre-6-ago)** · otros. Normaliza `fb|facebook|ig` y trata el literal
  `{{campaign_name}}`. **Date-gate obligatorio (regla dura del handover): antes
  del 6-ago-2026 el referrer google NO se desglosa** — era un solo bucket con
  pago adentro (brand corría a 374 AUD/día sin tags); etiquetarlo "orgánico"
  contaminaría justo la serie que juzga la canibalización del recorte.
- **Last click (modelo principal)** = último momento **no-directo** del
  journey, computado desde `moments` — la misma definición que usa Shopify
  Analytics, y por eso conciliable contra sus reportes. La "última visita
  cruda" (direct incluido) queda disponible como modelo secundario, con su
  divergencia medida, no negada.
- **First click** = primer momento. Cada canal: "ventas que inicié" / "que cerré".
- **MER** = ventas netas ÷ (gasto Meta + Google), serie diaria. Numerador
  **exacto**: el mismo "Net sales ex tax, AUD" del tab E-commerce
  (`shopify_sales_by_variant.net_aud`, todos los canales de venta), día
  Brisbane. Denominador: gasto por día de la cuenta publicitaria; el desfase
  horario spend-vs-orden se acepta y se documenta en el tooltip. Días con
  gasto incompleto (Google sin cargar) → MER null ese día.
- **Overlap** = journeys con touchpoints de AMBAS plataformas pagas en
  cualquier momento del recorrido (definición del handover, posible gracias a
  `moments`), contado y listado.
- **Claimed vs actual** por campaña: Meta por `campaign_id`; Google por el
  enum de campaña ↔ bucket (shopping cruza contra el bucket proxy, con su
  impureza de free listings documentada en el tooltip).

### Bloque 4 — El tab
Dos alturas, sin toggles (superficies separadas):

- **Vista dirección (blended):** MER serie diaria · gasto total vs ventas
  totales · doble conteo (suma de claims vs ventas reales) · overlap ·
  **CAC blended** = gasto total ÷ órdenes con `customer_order_index = 1`.
- **Vista por canal:** campañas, gasto, ventas reconocidas (last click
  no-directo) y las iniciadas (first click), lo que su panel reclama, y la
  brecha. Google desglosado brand / non-brand / Shopping — **solo desde el
  6-ago** — contra su referencia histórica correctamente rotulada: "bucket
  google total (pago sin tag + orgánico), ~USD 2,1k/día jul-2026, convertido a
  AUD, con campañas activas" (no es "baseline orgánico"; el baseline orgánico
  real se computa post-6-ago cuando haya ventana suficiente).
- Series diarias contra baseline pre-campaña (incrementalidad visual).
- Contador de **órdenes sin clasificar** y de **órdenes sin journey** (drift
  de etiquetas y huecos de captura, separados).
- Definición de cada métrica en tooltip. Fechas: día Brisbane.

## 5. Identidad y memoria del visitante

- **v1:** la memoria la pone Shopify — cookie first-party puesta por servidor
  (sobrevive meses, no los ~7 días de las cookies JS) y su journey une visitas
  pasadas con la orden (`daysToConversion` 1–13 en la muestra viva).
- **v2 (pixel propio):** cada visita grabada server-side (patrón
  `upgrade_events`); la cookie solo lleva el ID de visitante. Cookie borrada =
  visitante nuevo hasta que aparece una llave durable (email de compra, login,
  newsletter, click de Klaviyo) y se une retroactivamente. Así lo hace TW.
- **Límite honesto, en el tab:** view-through y cross-device anónimo no los
  mide nadie por fuera de las plataformas. Por eso la regla de lectura del §2.

## 6. Fuera de alcance (v1)

- Capa IA — v2, sobre el motor verificado.
- Pixel propio y multi-touch con ventanas — v2 (los `moments` de v1 ya dejan
  la materia prima lista).
- La planilla profit/CAC/MER objetivo de Juan — proyecto aparte.
- Tagueo limpio de Shopping — después del 31-ago Y con **test de click
  controlado previo**: las URLs del feed ya traen UTM propio y agregar un
  suffix genera parámetros duplicados con comportamiento no documentado en
  Shopify (regla del handover §6.5, no solo el learning period).

## 7. Gobernancia (prerequisito no técnico, con dueños)

- Convención UTM única, escrita y versionada en el repo (los valores
  `brand-search`, `non-brand`, `cpc`, `facebook/paid` son un contrato:
  cambiarlos parte los buckets; ya pasó una vez — el tramo
  `{{campaign_name}}` de 2025).
- **Paso 0 del proceso (dueño: Mario):** confirmar con Kieran la convención
  Meta vigente y el compromiso de no tocarla, ANTES del backfill.
- **Carga de gasto Google (dueño: Juan):** cadencia definida (diaria o cada
  2-3 días); el tab muestra hasta qué día hay datos.
- El contador de "sin clasificar" del Bloque 4 es la alarma de drift.

## 8. Proceso de construcción (método del video + lo nuestro)

0. Gobernancia: convención Meta confirmada con Kieran (Mario).
1. **Spec + diagrama de entidades** (este documento) → OK de Mario.
2. **Maqueta estática del tab completo con números falsos** → OK visual de
   Mario y Juan ANTES de construir cañería.
3. Bloque 1 (captura + backfill) → aceptación §9.
4. Bloque 2 (gasto: manual Google + campañas Meta + trámite API) → aceptación §9.
5. Bloque 3 (motor) → aceptación §9.
6. Bloque 4: conectar la maqueta a datos reales, una vista por vez.
7. Backlog v2 documentado al cierre (API Google, pixel, ventanas, IA).

Regla: **nunca conectar dos piezas nuevas a la vez.**

**Reglas de implementación (fijadas con Mario, 2026-08-08):**
- Mismo repo (el tab comparte dashboard, auth y deploy); rama nueva
  `feat/advertising-tab`, separada del trabajo en curso.
- **CSV donde se puede, API donde el CSV no existe:** el gasto histórico de
  Meta (export por campaña/día del Ads Manager) y de Google se cargan por CSV
  (patrón `ecommerce-load-csv` ya probado). El recorrido por orden NO existe
  en ningún export de Shopify — solo por API, y es un backfill de UNA sola
  vez, paginado, en horario valle.
- **Incremental por diseño:** sync por marca de agua (updated_at por orden,
  como el de ventas); en operación normal se leen ~600 órdenes/día, jamás la
  historia completa. Tablas angostas con índice por fecha; si el volumen
  algún día lo pide, el patrón de rollups diarios ya está probado en Web
  Upgrade.

## 9. Tests de aceptación (ejecutables, no vibes)

- **Bloque 1:** para una muestra de N órdenes, la tabla reproduce exactamente
  lo que devuelve la API (spot-check automatizado); contador de ready=false
  envejecidos = 0 tras el período de retry.
- **Bloque 3 / last click:** conciliación contra el reporte de Shopify
  Analytics **"Total sales by referrer"** (y "Sales attributed to marketing"),
  mismo rango de fechas, tolerancia definida antes de mirar (±2%); la
  divergencia del modelo secundario (última visita cruda) se publica como
  número, no se esconde.
- **MER:** reproducible a mano desde el tab E-commerce (mismo numerador) y la
  suma de gasto visible.
- **Criterio final:** la discusión Meta vs Google se hace mirando este tab;
  un mes nuevo no requiere trabajo manual salvo la carga de Google (hasta la
  API).

## 10. Revisión adversarial (2026-08-08) — hallazgos incorporados

3 revisores (consistencia con handovers / factibilidad técnica / calidad de
spec) + refutadores independientes, contra la tienda y la base vivas. Los 3
graves confirmados, ninguno refutado, todos corregidos arriba:

1. **Meta por campaña no existía**: `meta_ads_daily` es por cuenta/día; el
   "cruza directo" de la v1 era falso. → `meta_ads_campaign_daily` como
   trabajo nuevo (Bloque 2).
2. **El "last click" de la v1 no era el de Shopify Analytics**: `lastVisit`
   incluye direct (~15-20% de las órdenes) y con solo first/last el último
   no-directo es irreconstruible. → captura de `moments` completos + modelo
   principal = último no-directo (Bloques 1 y 3).
3. **La regla dura pre-6-ago se había caído**: el backfill habría etiquetado
   clicks pagos de Google como "orgánico". → date-gate + bucket "google mixto
   (pre-6-ago)" (Bloque 3).

Menores incorporados: baseline $2,1k re-rotulado (es el bucket google TOTAL,
en USD, con campañas activas); moneda nativa por fila en meta_ads_daily; enum
cerrado para campañas de Google y mapeo de Shopping al proxy; test de click
para el tagueo de Shopping; tramo `{{campaign_name}}` del histórico Meta;
retry explícito de ready=false (updated_at no sirve — verificado); fórmula
exacta del MER con días incompletos en null; overlap momento-based;
`customer_order_index` para CAC; gobernancia con dueños y paso 0.
