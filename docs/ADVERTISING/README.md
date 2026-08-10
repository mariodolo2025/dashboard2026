# Advertising — medición propia de Meta vs Google

**Qué es.** Un mini Triple Whale hecho en casa: mide la publicidad desde las
órdenes reales de la tienda, con una sola vara para todos los canales, y pone
al lado lo que cada plataforma **dice** que vendió. Nace porque Meta y Google se
adjudican las mismas ventas y cada sector se calificaba con el boletín de su
propia plataforma.

**Cómo leer cualquier número de acá.** Nuestra medición **subcuenta** (no ve al
que vio el anuncio sin clickear, ni al que compró desde otro dispositivo); las
plataformas **sobrecuentan** (se pisan entre sí). La verdad está entre las dos.
El MER (ventas ÷ gasto total) no depende de ninguna atribución: es el árbitro.

---

## Estado al 2026-08-10

| Bloque | Estado |
|---|---|
| 1 · Captura de atribución | **En producción.** 59k órdenes con su recorrido completo, 13 meses, se actualiza sola 3×/día |
| 2 · Gasto y reclamos | **En producción.** Meta por API (cuenta + campaña, 13 meses); Google cargado del export de la cuenta (25-jun → 10-ago) |
| 3 · Motor | **En producción.** Buckets, last-click no-directo, first click, MER, overlap, claimed-vs-actual |
| 4 · Tab | **Conectado a datos reales.** Falta la validación visual de Mario |
| 5 · IA, pixel propio | v2, no empezado |

**Rama de trabajo:** `feat/advertising-tab` (sin mergear a `main`).

---

## La carpeta

```
README.md      ← este archivo: estado, decisiones, mapa
SPEC.md        ← el diseño: principios, bloques, límites honestos. LEER PRIMERO
plans/         ← los 5 planes de implementación, tarea por tarea
context/       ← los dos handovers originales (teoría + hechos verificados)
data/          ← exports crudos (el CSV de Google que alimentó la carga)
```

---

## Dónde vive cada cosa (fuera de esta carpeta)

**Base de datos** (proyecto Supabase `teewkafclgpfpczftvah`)

| Objeto | Qué guarda |
|---|---|
| `shopify_order_attribution` | Una fila por orden: resumen del recorrido, primera y última visita, nº de compra del cliente |
| `shopify_order_journey_moments` | Una fila por visita — la materia prima cruda de todos los modelos |
| `meta_ads_campaign_daily` | Gasto y reclamos de Meta por campaña por día (moneda nativa) |
| `google_ads_daily` | Gasto y reclamos de Google por campaña por día (AUD) |
| `ad_spend_unified` (vista) | Una sola serie de gasto en AUD, las dos plataformas |
| `advertising_order_channels` (vista) | Canal de cada orden: primera visita y último no-directo |
| `advertising_bucket()` | **El clasificador.** Única fuente de verdad de la taxonomía |
| `advertising_dashboard(from, to)` | El RPC que alimenta el tab entero |

**Funciones edge:** `shopify-attribution-sync` · `meta-ads-campaign-sync` ·
`google-ads-load` (escritura manual, exige sesión real)

**Orquestador** (`sync-orchestrate`, 3×/día): pasos `Shopify attribution` y
`Meta campaigns`.

**Frontend:** `src/components/AdvertisingTab.tsx` +
`src/components/advertising/{types.ts, mockData.ts, GoogleSpendForm.tsx}`.
`types.ts` es **el contrato** con el RPC: cambiar un campo ahí obliga a cambiar
el RPC.

**Migraciones:** `supabase/migrations/2026080[89]*`, `202608101*` — cada una con
su doc explicando qué, por qué y cómo se verificó.

**Script:** `scripts/parse-google-ads-csv.js` — convierte el export de Google
Ads en SQL. Falla ruidosamente si aparece una campaña que no sabe mapear.

---

## Decisiones cerradas (no relitigar sin motivo nuevo)

1. **Los importes llevan impuesto incluido** (Mario, 10-ago): así se pueden
   comparar con Triple Whale. Ojo: el B2C Sales Explorer va sin impuesto a
   propósito — para el 9-ago son $18.048 vs $17.196, la diferencia es el GST
   metido en el precio australiano.
2. **Last click = último origen NO directo** del recorrido, igual que Shopify
   Analytics. La última visita cruda (que puede ser "directo") queda como
   modelo secundario.
3. **Antes del 6-ago-2026, Google pago y orgánico son indistinguibles** (no
   había UTMs): ese tramo va al bucket `google-mixto-pre`, jamás a "orgánico".
4. **El día de las ventas es el de Brisbane**; el de los eventos del Web
   Upgrade es UTC. Decidido, no unificar.
5. **Sin dato es null, nunca cero.** Un día sin gasto cargado no calcula MER:
   deja un hueco en el gráfico.
6. **Shopping es un proxy.** Se detecta por el tag del feed
   (`product_sync/sag_organic`), que mezcla listados gratuitos. El tagueo
   limpio espera al 31-ago **y a un test de click controlado** (agregar un
   sufijo a URLs que ya traen UTM genera parámetros duplicados).
7. **Toda vista nueva lleva `security_invoker = on`.** Sin eso saltea los
   permisos de las tablas de abajo (agujero real encontrado el 9-ago).

---

## Pendientes

**De terceros**
1. **Token de Google Ads API** — trámite con Google. Cuando llegue, el sync
   automático reemplaza la carga manual sin tocar nada más.
2. **Kieran: test de plantilla UTM en UN anuncio.** Hoy ~4-5% de los clicks
   pagos de Meta llegan sin ID de campaña, y un 2-5% con el literal
   `{{campaign_name}}` (macro mal puesta, en todos los meses). El texto del
   mail está en el historial de la sesión del 10-ago.

**Nuestros**
3. Validación visual del tab con Mario.
4. Conciliación manual contra Shopify Analytics (±2%): ShopifyQL no expone
   dimensiones UTM, así que se hace a ojo contra "Sales attributed to marketing".
5. Ventanas de 12 meses tardan ~15 s (30 días: 0,4 s). Si molesta, el patrón de
   rollups diarios ya está probado en Web Upgrade.
6. El tab de E-commerce debería mostrar USD entre paréntesis como el resto.

**v2 (documentado en SPEC.md §6)**
Panel de IA estilo Moby · pixel propio con ventanas 1-28 días · métricas de
cliente nuevo (NC-ROAS, NCPA) · estilo "Sonar" (devolverle datos a las
plataformas — es escribir hacia afuera, otra liga de riesgo).

---

## Operaciones que se repiten

**Cargar gasto de Google a mano** (hasta que llegue la API)

1. Google Ads → **Campaigns → Insights & reports → Report editor → Custom →
   Table**. Filas: `Day` + `Campaign`. Columnas: `Cost`, `Conversions`,
   `Conv. value`. Rango deseado → descargar `.csv`.
   (El segmento "Day" de la tabla de Campaigns está deshabilitado en esta
   cuenta; el Report editor no tiene esa limitación.)
2. `node scripts/parse-google-ads-csv.js <export.csv> salida.sql` — imprime
   totales y campañas vistas; el SQL que genera es idempotente.
3. Aplicar el SQL. Verificar contra los totales que muestra el panel de Google.

**O**, para un día suelto: el formulario dentro del tab (vista Google), que
Juan puede usar con su propio login.

**Rehacer la captura de un período** (si algo se ve raro)
`shopify-attribution-sync` con `{ "backfill": { "from": "...", "to": "..." } }`.
Es idempotente. **Arrancar un día antes** del día Brisbane que querés: la
ventana filtra por UTC.
