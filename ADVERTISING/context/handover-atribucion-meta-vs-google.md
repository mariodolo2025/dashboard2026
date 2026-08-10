# Handover — Atribución Meta vs Google Ads (Pesado 58.5 / Shopify)

Fecha: 2026-08-07. Fuente: análisis sobre Shopify Admin (store Pesado 58.5, pesado585.com, moneda USD), export "Total sales by referrer" 2025-07-01 → 2026-08-06, y email de Juan Cruz Murugarren del 6-ago-2026. Este documento es contexto e información: no contiene instrucciones de implementación.

---

## 1. El conflicto

Kieran corre Meta Ads hace ~1 año. Juan Cruz arrancó Google Ads recientemente. Ambos reclaman las mismas adquisiciones porque cada plataforma mide con su propio pixel, su propio modelo de atribución y sus propias ventanas de conversión (incluyendo view-through). Los paneles de Meta y de Google no son comparables entre sí ni suman contra la realidad: la misma orden puede ser reclamada por los dos. La única vara común disponible es la atribución de Shopify sobre las órdenes reales.

## 2. Teoría mínima de atribución (lo que hay que entender)

Shopify atribuye cada orden según el customer journey del comprador: referrer de la visita (de qué sitio vino) y parámetros UTM de la URL de aterrizaje, con lógica last-click (el último origen no-directo antes de comprar). El reporte "Total sales by referrer" agrupa por referrer: todo lo que viene de google.com cae en un solo bucket "google", sea búsqueda orgánica o click de anuncio. La única forma de que Shopify distinga pago de orgánico es que el anuncio llegue con UTMs en la URL. Meta siempre los tuvo (`utm_source=facebook|fb|ig`, `utm_medium=paid`); Google Ads no los tuvo hasta el 6-ago-2026.

Referencia de industria: herramientas como Triple Whale resuelven esto forzando UTMs en todas las campañas, capturando clicks con pixel first-party, trayendo el gasto desde las APIs de Meta/Google, y aplicando modelos de atribución propios sobre esos datos — misma vara para todas las plataformas, sin creerle al panel de ninguna. Ese es el concepto a replicar: la parte de atribución ya está resuelta con los UTMs; lo que falta cruzar es el gasto.

Limitación conocida de last-click: castiga el upper-funnel (prospecting de Meta que genera demanda que después convierte por búsqueda o directo). Sirve para comparar plataformas con la misma vara, no como verdad absoluta de incrementalidad. La incrementalidad real se lee contra baselines (sección 6).

## 3. Hechos verificados — histórico 13 meses (jul-2025 → 6-ago-2026)

Totales del store: 58.503 órdenes / USD 5.03M.

| Bucket | Órdenes | Total sales USD | Identificable |
|---|---|---|---|
| Meta pago (utm facebook/fb/ig + paid) | 25.902 | 1.97M | Sí, orden por orden |
| Referrer "google" (mezcla orgánico + ads) | 8.579 | 791k | No separable pre-6-ago |
| Social orgánico (referrer social sin UTM) | 3.038 | 239k | Sí |
| Resto (direct, email, otros buscadores, etc.) | — | ~2.0M | Parcial |

Verificaciones que sostienen esto:

- De las 8.579 órdenes "google", solo 83 (~1%) traían algún UTM, y ninguno era de Google Ads. Cero `utm_source=google` con medium pago en todo el período.
- Muestra de 550 órdenes a nivel API (1-jul → 6-ago-2026): las ~130 órdenes google-referred eran patrón orgánico puro (sourceType=SEO, referrer google.com, sin UTMs); cero gclid/gbraid/gad_source; `marketingEvent` null en las 1.100 visitas. Meta pago = ~53% de las órdenes de la muestra.
- No existe canal de ventas "Google & YouTube" operando como sales channel (solo Online Store, Shop, Draft Orders).
- Nota técnica: la API de Shopify normaliza `landingPage` (sin query string), así que el gclid de auto-tagging no es observable. Por eso los UTMs son la única marca confiable.

Baseline del bucket google: ~USD 60–70k/mes estable durante todo el año, previo a cualquier campaña de Google. Es mayormente SEO. Jul-2026 corrió a ~$2.1k/día, igual que jun-2026 — sin lift visible del bucket pese a campañas activas (falta confirmar desde cuándo corrían brand/non-brand a presupuesto pleno; ver pendientes).

## 4. Setup actual de Google Ads (email de Juan Cruz, 6-ago-2026)

| Campaña | Budget AUD/día | Estado | Nota de Juan |
|---|---|---|---|
| Brand search | 50 (era 374) | Recortada | "Defensa": capturar oportunidades de usuarios que ya buscan la marca |
| Shopping AU | 170 | Live desde 2-ago | "Scale": se juzga por revenue incremental, primer mes completo |
| Non-brand search | 345 | AU only (US removido) | US tomaba 57% del budget y devolvía 46% de las conversiones a mismo AOV. "Scale" |

Reglas que fijó: nada se toca hasta el 31-ago (learning period). Checkpoint 17-ago, review completo 31-ago. UTM tracking agregado a brand y non-brand solamente; Shopping quedó sin UTM propio.

## 5. Instrumentación vigente desde el 6-ago-2026 (verificada con órdenes reales)

Taxonomía de buckets sobre atribución last-click de Shopify:

- `google / cpc / brand-search` → Google Ads brand. Primeras órdenes: 3 / $336 (6-7 ago).
- `google / cpc / non-brand` → Google Ads non-brand. Primeras órdenes: 3 / $210.
- `google / product_sync / sag_organic` → proxy de Shopping AU. Es el tag del feed del canal Google & YouTube, no un UTM de campaña; mezcla free listings, pero el baseline histórico de ese tag era ~5 órdenes en 13 meses y saltó a 6 órdenes / $430 en 4 días coincidiendo con Shopping live — en la práctica hoy captura la campaña de Shopping.
- Referrer google sin UTM → Google orgánico (SEO).
- `facebook|fb|ig / paid` → Meta pago (con utm_campaign = campaign ID de Meta).
- Resto: social orgánico, email/Klaviyo, direct, otros buscadores.

Regla dura: los datos pre-6-ago NO sirven para comparar Google pago vs orgánico (todo era un solo bucket). El período comparable arranca el 6-ago-2026. Primeros ~2 días: ~USD 980 entre los tres buckets pagos de Google contra ~AUD 565/día de gasto — muestra estadísticamente insignificante y en learning period; no concluir nada.

## 6. Lo que falta ver (las preguntas que la data tiene que responder)

1. **Incrementalidad de Google**: ¿el bucket google TOTAL (pago + orgánico) sube por encima del baseline de ~$2.1k/día con las campañas activas? Si el pago crece pero el total no, las campañas capturan demanda que llegaba igual por orgánico.
2. **Canibalización de brand search**: con el recorte 374→50, ¿el orgánico google sube (recupera lo que brand capturaba) o el total cae (brand era defensa real, como sostiene Juan)? Este es el experimento en curso más informativo.
3. **ROAS por campaña con la misma vara**: revenue de cada bucket de Shopify contra los budgets del email (50/170/345 AUD/día). Ojo moneda: store en USD, budgets en AUD — definir conversión. Para Meta, mismo cálculo con su spend.
4. **Claimed vs actual**: lo que el panel de cada plataforma reclama vs lo que Shopify le reconoce por last-click. La brecha y el overlap (journeys con touchpoints de ambas plataformas: se observaron 6 en 500 órdenes) son el corazón del conflicto Kieran/Juan.
5. **Fechas clave**: checkpoint 17-ago, review 31-ago. Hasta el 31 no se toca nada en Google Ads; el tagueo limpio de Shopping (hoy proxy vía product_sync) y cualquier campaña/test propio quedan para después del 31 — Shopping usa las URLs del feed que ya traen UTM propio, y agregar un suffix genera parámetros duplicados con resultado no documentado en Shopify: requiere test de click controlado antes de confiar en el reporte.

## 7. Pendientes de datos / verificación

- Fecha exacta de inicio de brand y non-brand a presupuesto pleno (necesaria para leer el "julio plano" como señal de canibalización o descartarlo).
- Serie semanal 2026 exacta del bucket google: el CSV histórico exportado no sirve para esto (colapsa jul-2025 y jul-2026 en las mismas filas semana/mes); hay que tomarla de Shopify Analytics directamente.
- Spend real diario de ambas plataformas (hoy solo se conocen los budgets nominales del email; el gasto efectivo puede diferir).
- Consistencia futura de los valores UTM (los nombres `brand-search`, `non-brand`, medium `cpc` deben mantenerse estables; cualquier cambio parte los buckets).
