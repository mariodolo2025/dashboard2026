# Handover — Medición de efectividad de ads (Meta vs Google) y campaña Compatibility Guide

**Para:** sesión de trabajo sobre dashboard2026.dolo.au
**Fecha:** 2026-08-07
**Estado:** la campaña de Meta a la Compatibility Guide está **diseñada y en pausa**. No se implementa hasta resolver cómo medimos Meta vs Google. Este documento junta la teoría, los hechos y las conclusiones para desarrollar después la parte de medición del dashboard. **No contiene instrucciones técnicas a propósito** — es el "qué" y el "por qué"; el "cómo" se decide con este material en la mano.

---

## 1. El problema de fondo

Meta Ads y Google Ads los manejan sectores independientes, y cada uno mide sus resultados con el panel de su propia plataforma. Eso tiene dos fallas estructurales:

1. **Las dos plataformas se atribuyen la misma orden.** Un cliente ve un ad en Instagram, días después busca la marca en Google y compra: Meta lo cuenta y Google también. La suma de lo que declaran ambos paneles es mayor que las ventas reales. No hay forma de decidir presupuesto entre canales mirando los paneles.
2. **Cada sector se califica con el boletín que imprime su propia plataforma.** No existe hoy una medición propia, del lado de la tienda, contra la cual contrastar lo que cada plataforma declara.

## 2. Teoría: las piezas de una medición propia

### Last click por UTM
Cada ad sale con etiquetas UTM en el link (`utm_source`, `utm_campaign`, `utm_content`). Cuando alguien clickea, aterriza en la tienda con la etiqueta puesta; si esa sesión (o una posterior en el mismo dispositivo) termina en compra, la orden queda marcada con el último UTM visto. La venta se acredita al último link clickeado.

- **Virtud:** se mide 100% en la tienda propia, con la misma vara para todos los canales. No depende de lo que Meta o Google declaren.
- **Defecto:** sobreacredita a lo que "cierra" (típicamente la búsqueda de marca en Google, que suele ser el último paso) y subacredita a lo que "inicia" el interés (típicamente Meta). **No sirve crudo para comparar un sector contra el otro.**

### First click como complemento
Guardando también el primer UTM de cada visitante (no solo el último), cada sector obtiene dos métricas: "ventas que inicié" y "ventas que cerré". Meta domina la primera, Google la segunda. Esa foto doble es mucho más justa que cualquiera de las dos sola, y es barata: mismo mecanismo, dos registros.

### MER como árbitro
MER = ventas netas totales ÷ gasto publicitario total (Meta + Google juntos). No depende de ninguna atribución, no se puede discutir ni inflar. Es el número con el que se juzga si la inversión publicitaria **en conjunto** rinde, y el árbitro cuando los canales se contradicen.

### Brand vs non-brand (Google)
La búsqueda de marca ("pesado") **cosecha** demanda que ya existía — muchas veces creada por Meta o por el orgánico. Shopping y non-brand **generan** demanda. Son cosas distintas y se juzgan distinto: brand es defensa (no se mide por revenue incremental), scale campaigns sí se miden por incremental. Mezclarlas en un solo bucket "google" infla artificialmente al canal. Juan ya separó esto (ver §4).

### Qué hace Triple Whale y qué es replicable
TW = (a) UTMs en todos los ads, (b) un pixel first-party en la tienda que arma el recorrido de cada visitante y lo une con la orden, (c) gasto por API de cada plataforma, (d) modelos de atribución a elección (last click, first click, lineal, por plataforma) con ventanas de 1–28 días.

**Replicable con infraestructura propia (~80% del valor):** last click + first click por UTM, gasto por API, MER, vistas por canal. La tienda ya escribe atributos en la orden (`_pesado_source` funciona en producción); extender ese mecanismo a UTMs es el mismo patrón.

**No replicable, y por qué (el ~20%):**
1. **View-through** (vio el ad, no clickeó, compró después): sin click no hay UTM; el único que sabe que esa persona vio el ad es la plataforma. Estructuralmente imposible de medir de forma independiente — TW también depende de los datos de views que Meta/Google reportan.
2. **Cross-device** (clickeó en el teléfono, compró en la desktop): requiere un identificador presente en ambas sesiones. El join por email es construible y barato; el matching anónimo es un producto de ingeniería en sí mismo.
3. **Multi-touch duradero**: requiere cookies que sobrevivan semanas; los navegadores las degradan (Safari borra cookies de JavaScript a ~7 días) y las protecciones se endurecen cada año. Construible, pero con mantenimiento perpetuo.

**Regla de lectura:** la medición propia por UTM **subcuenta** (pierde view-through y cross-device), las plataformas **sobrecuentan** (se pisan entre sí). La verdad queda acotada entre ambas, con el MER como árbitro.

### Individualidad por sector
La medición por UTM es individual por naturaleza: separa cada orden por canal. Cada sector necesita su vista propia (sus campañas, su gasto, sus órdenes medidas en tienda, y al lado lo que su plataforma declara — la brecha es el sobreclamo). La vista blended (MER, doble conteo, totales) es la de dirección. **Prerequisito de gobernancia, no técnico: una convención de UTM única y obligatoria para los dos sectores.** Si cada equipo etiqueta como quiere, ninguna vista lo salva.

## 3. Estado actual de la medición (hechos)

- **dashboard2026 → E-commerce → Ads by spend:** muestra ads de Meta con ROAS/CTR/costo por compra **según Meta** (datos de la plataforma, no medición propia). Promedio de la cuenta: ~$46.93 por compra (junio–julio).
- **dashboard2026 → Web Upgrade → Modules:** funnel de la guía (views → model selected → add) **sin segmentar por fuente de tráfico**. No distingue pago de orgánico.
- **Atribución de módulos:** last-touch vía `_pesado_source` en la orden. Es piso, no techo (quien usa la guía y compra días después desde otra página no acredita a la guía).
- **B2C Sales Explorer:** ventas totales por SKU. PSD-HD-BR54: ~91 órdenes/día (909 en 10 días, 27 jul–5 ago), ~65% US, barras diarias oscilando ~75–105 solas, y en plena curva de lanzamiento del 2.0 (+208% vs período anterior). Inservible para detectar una campaña chica; solo confirma tendencia a 3–4 semanas.
- **Google Ads (cambios de Juan, email 6-ago):** brand search recortado 374→50 AUD/día (definida como defensa); Shopping AU 170/día desde el 2-ago; non-brand 345/día solo Australia (US removido: tomaba 57% del budget con 46% de las conversiones a igual AOV); **UTM agregado a brand y non-brand — Shopify ya distingue brand / non-brand / Shopping** (antes un solo bucket "google"); congelamiento de cambios hasta el 31-ago para no resetear el learning; checkpoint el 17, review el 31.
- **Meta:** sin convención UTM equivalente confirmada. A verificar con Kieran.

## 4. Evaluación de los cambios de Juan

En general correctos: la separación brand/non-brand con UTM, la clasificación defensa vs escala, el congelamiento para leer limpio, y el recorte de US en non-brand (su costo por conversión da ~1.5× el de Australia con sus propios números) son consistentes con la teoría de §2. Dos flags:

1. **El recorte de brand es violento (−87% de una)** sobre una campaña que él mismo define como defensa. La lectura correcta del experimento exige mirar **tráfico de marca total (pago + orgánico) y conversiones totales**, no el panel de Google, más el impression share de competidores en términos de marca. Si al 17-ago el orgánico no absorbió el recorte, restituir rápido.
2. **"Revenue incremental" para juzgar Shopping y non-brand a fin de mes: definir el baseline antes del 31**, no después de ver los números.

## 5. Por qué la campaña de Meta quedó en pausa

La campaña (guion, hooks, 4 ad sets, mockups — archivos 1 a 4 de esta carpeta) está lista para el equipo de marketing. Se pausa porque **compartiría cañería con el experimento de Juan**: la guía convierte 5.67% de las sesiones con tráfico caliente, o sea que en el mejor caso ~94 de cada 100 personas que traiga el ad **no compran en esa sesión**. Una parte vuelve días después buscando "pesado" en Google — exactamente los contadores (orgánico de marca, conversiones de marca) que Juan mira hasta el 31-ago para juzgar su recorte. Y a la inversa: con la defensa de marca en $50/día, demanda creada por Meta puede cosecharla un competidor. Corriendo simultáneos, cada experimento es el factor de confusión del otro. Ventana natural para el test de Meta: después del review del 31-ago.

## 6. Qué necesita poder responder la futura vista de medición

Sin prescribir implementación, la vista tiene que poder contestar:

1. ¿Cuánto vendió cada campaña/ad set/ad group **medido en la tienda** (last click UTM), y cuánto declara cada plataforma? (la brecha por canal)
2. ¿Qué inició cada canal y qué cerró? (first click vs last click)
3. ¿El gasto publicitario total rinde? (MER, serie temporal)
4. ¿Brand y non-brand de Google, por separado?
5. ¿El funnel de la guía, separado pago vs orgánico? (resuelve la dilución del add rate cuando corra la campaña)
6. ¿Las series diarias contra su rango esperado pre-campaña? (incrementalidad visual)

## 7. Baselines para juzgar la campaña cuando corra (con fuente)

| Métrica | Valor | Fuente |
|---|---|---|
| Costo por compra promedio cuenta Meta | ~$46.93 | handover original (jun–jul) |
| Views de la guía | ~357/día | handover: 4,646 en 13 días |
| Conversión de la guía (tráfico caliente) | 5.67% | handover |
| Add rate global guía (click/pick) | 16.8% Breville | tabla 23 jul–5 ago |
| Add rate por modelo target | Touch Impress 23.3% · Bambino Plus 22.7% · Oracle 22.3% · Oracle Touch 22.0% | tabla 23 jul–5 ago, alias combinados |
| Picks/día modelos target | Touch Impress ~17 · Bambino Plus ~15 · Oracle+Touch ~23 | tabla 23 jul–5 ago ÷14 |
| BR54 ventas totales | ~91 órdenes/día (~29/día AU) | Sales Explorer 27 jul–5 ago ÷10 |
| Breville como % de picks de la guía | ~81% | tabla 23 jul–5 ago |

Criterios ya definidos para el test: éxito = costo por compra cercano a ~$47–60; fracaso = ~2× ($90+) con gasto suficiente (~$500/ad set, criterio de trabajo). El add rate de tráfico pago se considera aceptable arriba de ~15% (baseline caliente 17–23%).

## 8. Decisión pendiente: construir vs comprar

- **Construir**: cubre §6 completo con el stack propio (el mecanismo de atributos en la orden ya existe con `_pesado_source`). No cubre view-through, cross-device anónimo ni multi-touch duradero (§2).
- **Comprar (Triple Whale / Northbeam / Elevar)**: cubre además el 20% restante, con costo mensual y dependencia de un tercero.
- La decisión depende de cuánto pesa ese 20% para la discusión Meta vs Google. Con ~85% del revenue pasando por Meta (handover original), el view-through no es despreciable — pero la pregunta operativa de corto plazo (qué sector rinde, con qué vara) se responde con la versión propia.

## 9. Archivos de esta carpeta

1. `1-guion-video.md` — guion maestro + hooks por modelo (interno, actualizado con datos 23 jul–5 ago)
2. `2-mockup-feed.png` / `3-mockup-story.png` — mockups del ad (Bambino Plus)
3. `4-adset-scripts-marketing.md` — brief en inglés para el equipo de marketing (4 ad sets, en pausa)
4. `5-handover-medicion-ads.md` — este documento
