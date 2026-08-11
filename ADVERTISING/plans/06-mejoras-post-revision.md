# Plan 6 — Mejoras surgidas de la revisión con Mario (11-ago-2026)

**Estado: EN EJECUCIÓN (go de Mario 11-ago, "trabaja entonces").**
Capa de datos COMPLETA el 11-ago: 4 migraciones aplicadas y verificadas
(tablas de planning + order_name + dashboard v3 + incrementality RPC), sync
v2 desplegado (función versión 3), backfill de nombres 31-jul→11-ago (1.709
órdenes). Revisión adversaria de 3 lentes ANTES de aplicar: 11 hallazgos,
5 corregidos en el SQL, 2 preexistentes del sync chipeados aparte
(task_6ccc8cce: auth + watermark hardening). UI en curso.

---

## Bloque A — Legibilidad (primero, es lo que más le molesta)

### A1. Agrandar la letra de todo el tab
Mario, 11-ago: "todo esta sumamente chico". Subir la escala tipográfica
completa: stat cards (valor y sub), tablas, headers, tooltips del chart.
Referencia: que quede al nivel del resto del dashboard, no más chico.
Criterio de aceptación: OK visual de Mario, no un número de px.

### A2. Tooltips por categoría en "Where the sales came from"
Un tooltip por bucket explicando: qué es, de dónde sale el dato (referrer /
UTM / tag del feed), y la advertencia que corresponda. Contenido ya validado
en la charla del 11-ago:
- **Direct** ≠ orgánico: es *ausencia de rastro*. Mezcla URL escrita/marcador
  con apps que borran el origen (WhatsApp, IG in-app browser, mails). Parte de
  lo que reclama Meta y no reconocemos cae acá. Sub-dato medido 6→9-ago: de 84
  first-click direct, 56 sin referrer, 27 con referrer de nuestro propio sitio
  (recuperables mirando más atrás en el recorrido), 1 ruido shopify.com.
- **Google mixed (pre 6-ago)**: pago y orgánico indistinguibles (sin UTMs).
- **Google Shopping (proxy)**: tag del feed, mezcla listados gratuitos.
- **No journey captured yet**: Shopify tarda 2-3 días en armar el recorrido.
- **Meta (paid) / Google * (paid)**: last click no directo; subcuenta
  (view-through y cross-device invisibles).
- Resto (email, social organic, referrals, other search, other tagged): fuente
  del referrer/UTM correspondiente.

## Bloque B — KPIs que faltan

### B1. ROAS y CPA por canal (doble vara)
En las tarjetas de canal: ROAS panel (claims/spend) y ROAS tienda
(store-recognised/spend), CPA y NC-CPA (costo por cliente nuevo). Necesita
agregar orders y new-customer orders por canal al RPC (dato ya existe:
customer_order_index en shopify_order_attribution).

### B2. Gráfico piso/techo por campaña ("the verdict chart")
Mockup mostrado a Mario el 11-ago y APROBADO. Pidió sumar Meta. Diseño:
- Una fila por campaña paga **de ambos canales** (Meta campañas + Google);
  barra horizontal desde **piso** (ROAS tienda, last click) hasta **techo**
  (ROAS panel). Punto para first click.
- **Dos líneas verticales** (de la planilla de Juan, "Ecommerce Unit
  Economics July2026", recibida 11-ago): **equilibrio 1,42×** (= 1/CM1%,
  CM1 70,6%) y **objetivo 2,77×** (MER para 20% de margen operativo).
  Debajo de 1,42 pierde plata; entre ambas gana sin llegar a la meta.
- Semáforo: piso > objetivo = verde; techo < equilibrio = rojo; el resto =
  ámbar con matiz ("above breakeven, below target" vs "floor below breakeven").
- Marca va con flecha fuera de escala + nota de cosecha, no comparable.
- Nota fija: ventana limpia arranca 6-ago-2026 (UTM gate); shopping proxy
  infla el piso hasta el tagueo limpio; reclamos de días recientes todavía
  maduran (Meta re-lee 30 días).
- Los valores 1,42/2,77 son de julio-2026: refrescar mensual desde la
  planilla (o v2: calcular CM1 en el dashboard con datos de costos propios).
- Primera lectura 6-10 ago: Meta 1,16→2,27 (barra entera bajo el objetivo);
  non-brand 1,2→2,8; shopping 1,6→2,8.
- Contexto que lo hace urgente: la planilla trae plan de escala a A$233k/mes
  Meta y A$20k/mes Google (hoja Simulators §4).

### B3. Bloque de incrementalidad "Is Google adding sales?"
- Serie mensual bolsa-google ÷ resto-tienda, 13 meses.
- Banda del contrafáctico en **ventanas de 10 días** (no meses: 326 ventanas
  sin gasto dan mediana 28,1% / p75 31,4% / máx 62,3% — la banda mensual
  subestima el ruido, error ya cometido y corregido el 11-ago).
- Lectura del experimento del recorte de marca (6-ago, $375→$50/día):
  1-5 ago gasto pleno = 30,9% (= baseline); 6-10 ago recortado = 51,8%
  (+46% la bolsa, 2/3 orgánico). Lectura preliminar: cosecha. Veredicto
  serio: 31-ago. Confirmado con Mario: sin promos internas en 7-10 ago
  (solo recambio de contenido de Kieran).

### B4. Simulador de presupuesto ("Scale plan", fórmulas de Juan tal cual)
Pedido de Mario 11-ago: replicar la hoja Simulators §4 de la planilla en el
tab, sin cambiar la lógica. Fórmulas VERIFICADAS reproduciendo la fila 1,38×
de la planilla al dólar:
- venta_necesaria = (ganancia_deseada + fijos + gasto) / CM1%
- ordenes = venta_necesaria / ingreso_por_orden
- clientes_nuevos = ordenes × pct_primera_compra
- cac_objetivo = gasto / clientes_nuevos ; mer_objetivo = venta / gasto
- guardrails de Juan: CAC vs $20,93 (3x LTV:CAC) y $55,07 (CM1/orden);
  MER vs 1,42×.
Controles del usuario: ganancia mensual aceptada + gasto propuesto (y el
split Meta/Google como referencia, no como fórmula).
Lo que agrega el tab sobre el Excel: **seguimiento diario del plan** —
trayectoria exigida vs realidad MTD (venta, órdenes, CAC, MER), el chequeo
"the row is fiction" de Juan hecho automático y a tiempo.
Inputs externos (refresh mensual desde la planilla, tabla de config con
fecha de vigencia): CM1% 70,6 · fijos $48.559 · ingreso/orden $77,99 ·
pct nuevos 92,4%. v2: CM1 calculado en el dashboard desde Costs.
Ubicación: sección "Scale plan" en Leadership, debajo del piso/techo.
Superficie propia (antipatrón: nada de toggles).

## Bloque C — Bloques nuevos estilo TW

### C1. Channel Overlap
Solo-Meta / ambos / solo-Google (órdenes con click pago de cada lado en el
mismo recorrido). Dato ya en el motor (overlapOrders); falta el desglose
por lado y el gráfico.

### C2. Live Orders
Últimas órdenes con hora, monto y canales del recorrido (iconos estilo TW).
**Bloqueante de datos:** guardamos order_id interno, no el nombre visible
(PSD#65185). Falta: columna order_name en shopify_order_attribution, campo
`name` en el query GraphQL del sync, backfill one-shot. Regla de backfill:
arrancar `from` un día antes (ventana UTC vs día Brisbane).

## Bloque D — Ayuda

### D1. Botón Help con SOPs
Panel (superficie separada, NO toggle de info en la misma vista — antipatrón
de Mario) con procedimientos cortos:
- Cómo leer piso/techo y qué decisión tomar en cada caso.
- Cómo comparar el tab contra Meta Ads Manager (una cuenta por vez, moneda
  nativa, misma ventana de atribución, y que Meta re-escribe los últimos días).
- Cómo comparar contra el panel de Google (click date vs order date).
- Carga mensual del CSV de Google (Report editor → parser → verificación).
- Qué mirar si el MER tiene un hueco (día sin gasto cargado, no un cero).
- Qué significa "double counting" y por qué no es mentira de nadie.
- Cuándo desconfiar: caída de journey coverage, buckets 'other' creciendo.

## Ajustes menores detectados en la revisión visual (11-ago)
- La tabla "By campaign" de las vistas Meta/Google necesita la misma nota fija
  que el verdict chart ("platform claims for recent days still mature"): Mario
  leyó el 10-ago (CSV parcial de esa mañana: gasto $159 de ~$700, claims
  atrasados por el lag de conversión) y la tienda "ganándole" a Google parecía
  un bug. En días cerrados la dirección es la normal.

## Fuera del tab (recordatorios)
- E-commerce tab: adoptar la convención AUD (US$) — pedido de Mario 10-ago.
- Kieran: mail del test de UTM en un anuncio (redactado, sin enviar).
- Google Ads API: guía pasos 2-4 + token de developer (espera a Google).

---

## Inputs pendientes de Mario
1. ~~ROAS de equilibrio~~ RESUELTO 11-ago: planilla de Juan recibida como
   xlsx ("PESADO_58_5_-_Ecommerce_Unit_Economics_July2026_FINAL VERSION").
   Equilibrio 1,42× / objetivo 2,77× (julio 2026). Bases: planilla en USD y
   suma envío cobrado; el tab en AUD sin envío — diferencias de un dígito %,
   no cambian veredictos.
2. ~~OK visual del mockup piso/techo~~ RESUELTO 11-ago: aprobado, con
   extensión a campañas de Meta.
3. Orden de ejecución de los bloques cuando dé el go.
