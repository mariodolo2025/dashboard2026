# Plan 7 — Rediseño de la pantalla principal (auditoría A vs B)

**Estado: EJECUTADO el 13-ago-2026** (go de Mario). Pasos 1 a 7 hechos:
- RPC v4 aditiva (`ead7555`): blended.orders + newCustomerRevenue por canal →
  habilita NC-ROAS, AOV y % de clientes nuevos.
- Reestructura del tab (`286b084`): 5 workspaces con rail izquierdo, 4 tarjetas
  en vez de 6, comparación contra el período anterior, cajón Data health con el
  formulario de Google adentro, prosa metodológica movida al Help, clave cruda
  `google-mixto-pre` arreglada, tabla única Meta+Google con filtro.

Verificado sin browser (el preview exige login de Mario): typecheck y build en
verde; contrato completo presente en las dos llamadas que hace la pantalla
(actual + previa de igual largo, 30/30 días); las 4 tarjetas leen `blended.*`
directo, sin filtrar días — el defecto fatal de (B) no se replicó; ningún bucket
del channelMix cae fuera del mapa de etiquetas.

**Pendiente: validación visual de Mario** y borrar la pastilla "Advertising 2"
de `src/App.tsx` antes del merge.

Origen: Mario pidió a ChatGPT una segunda versión del tab (11-ago) porque la
nuestra "no tiene la mejor distribucion, es confuso... basado en TW pero
adaptado a nosotros y simple". Auditoría read-only de las dos el 13-ago:
4 revisores por lente + 12 hallazgos graves verificados uno a uno por un
escéptico independiente (12 confirmados, 0 refutados).

- **(A)** `src/components/AdvertisingTab.tsx` — la nuestra, en la rama.
- **(B)** `src/components/Advertising2Tab.tsx` + `.css` — la de ChatGPT,
  sin trackear, con pastilla "Advertising 2" en `src/App.tsx` (sin commitear).

---

## Veredicto

**Mario tiene razón en el ORDEN, no en el contenido.** (A) tiene todo lo
acordado y aprobado (piso/techo, Live Orders, overlap, Help, simulador), pero
la vista Leadership es una columna única de 9 bloques, ~14 tarjetas, 4
gráficos y 4 tablas — casi 3.000 px de scroll donde todo pesa igual. Y le
falta lo que TW tiene en todas partes: **comparación contra el período
anterior**.

**(B) ordena mejor la pantalla y muestra números equivocados.** No se puede
usar para decidir plata tal como está.

## Los 6 defectos de dato de (B) (verificados)

1. **El titular "Net sales" borra los días sin gasto completo** — incluidos
   TODOS los anteriores al 25-jun-2026 (Google no gastaba). Con "12 months"
   seleccionado, la tarjeta muestra ~7 semanas de ventas bajo el rótulo
   "ventas netas". No coincide con TW, ni con E-commerce, ni con (A).
2. **Las 4 tarjetas de arriba usan dos denominadores distintos**: MER, ventas
   y gasto sobre días completos; CAC sobre la ventana entera.
3. **Los "+X%" comparan ventanas de distinta cantidad de días** y lo llaman
   crecimiento.
4. **La línea de MER cruza el 25-jun sin marca** → se lee como caída de
   performance cuando es Google entrando al divisor. Y la "Decision queue"
   pide cargar gasto de Google de días en que Google no existía.
5. **Los nombres de canal salen crudos** ("google mixto pre", "google shopping
   proxy"): su mapa usa claves que la base nunca devuelve (`google-brand-paid`,
   `google-mixed`…), 5 de 14 coinciden. Con eso **se pierden las dos
   advertencias obligatorias**: pre-6-ago pago/orgánico indistinguibles, y
   Shopping mezcla listados gratis.
6. **El planificador toma el gasto de la ventana elegida como gasto mensual**:
   con "12 months" compara un año de gasto contra un mes de costos fijos.

Además, en (B) **no aparece en ningún lado** el aviso de que los reclamos de
plataforma de los días frescos todavía maduran, con el comparador prendido.

## Lo que (B) hace mejor (lo que hay que robarle)

1. **Cinco espacios de trabajo** con una pregunta cada uno, en barra lateral
   (Overview / Campaigns / Attribution / Incrementality / Planning).
2. **Comparación contra el período anterior**, con el % debajo de cada tarjeta.
3. **Cajón "Data health"** con los diagnósticos de medición + el formulario de
   carga manual de Google adentro.
4. **Cuatro tarjetas arriba en vez de seis**, con el objetivo al lado del MER.
5. Menor: tabla única Meta+Google con filtro y buscador; carga diferida de
   incrementalidad; la nota de overlap ("'ambos' no prueba causalidad").

## Lo que (A) hace mal (aceptado)

- Fila de 6 tarjetas donde 2 son diagnósticos de medición (double counting,
  overlap), no resultados de negocio.
- El MER grande sin el 1,42 y el 2,77 al lado, aunque vienen en el mismo
  payload y aparecen recién 2 pantallas más abajo.
- Sin comparación período anterior en ninguna parte.
- 46 párrafos de prosa, buena parte defendiendo metodología en pantalla.
- Cosas de ingeniero visibles: p25/p75, tipo de cambio con 4 decimales, aviso
  de que la consulta tarda 15s.
- Tarjeta "Verdict" cuyo valor es "serious verdict 31 Aug" — no es un número.
- **Mismo bug que (B), en un solo lugar**: la tabla "Google by bucket" imprime
  la clave cruda `google-mixto-pre` en vez del texto en inglés (el cartel de
  arriba sí lo explica).
- El formulario de carga de Google está al fondo de la vista Google, mezclado
  con el análisis.
- Meta y Google en vistas separadas: no se pueden comparar campañas de los dos
  canales sin saltar.

## Orden de trabajo propuesto

Sobre (A). (B) se conserva como referencia visual, no se mergea.

1. Fila de arriba a **4 tarjetas**: MER, Ventas netas, Gasto, CAC de cliente
   nuevo — todas de la base tal cual, sin filtrar días. Double counting y
   overlap bajan a atribución.
2. **1,42 y 2,77 dentro de la tarjeta de MER** + línea punteada de objetivo en
   el gráfico diario.
3. **Comparación con el período anterior**: segunda llamada a la misma RPC con
   la ventana corrida; % debajo de cada tarjeta. Siempre prendido (nada de
   toggles), desactivado solo arriba de 92 días. **Cuidado**: comparar ventanas
   de igual cantidad de días — el error de (B).
4. **Cajón lateral "Data health"**: días incompletos, sin recorrido, sin
   clasificar + el formulario de carga de Google.
5. **Subir la letra** (A1 del Plan 6, sigue pendiente de validación) y sacar la
   prosa metodológica de la pantalla principal — ya vive en el Help.
6. Arreglar la clave cruda en "Google by bucket".
7. Recién después: evaluar la navegación en 5 espacios y la tabla única
   Meta+Google **al lado** del gráfico piso/techo, no en su lugar.

**Antes de cualquier merge:** borrar la pastilla "Advertising 2" de
`src/App.tsx`, para que nadie del equipo lea números de ahí.

## Ganador bloque por bloque

| Bloque | Gana | Por qué |
|---|---|---|
| Fila de KPIs | (A) con formato de (B) | Formato de (B) mejor, números de (B) mal |
| Gráfico diario | (A) | Marca los días solo-Meta; (B) no. Falta la línea de objetivo |
| Calificación de campañas | (A) | Piso/techo visual vs tabla de 7 columnas en 10px |
| Tabla única Meta+Google | (B) | Idea nueva y buena, portarla |
| Mix de canales | (A) por goleada | (B) pierde las advertencias obligatorias |
| Overlap | (A) por poco | (B) sin importes y en 8px; su nota está bien escrita |
| Live Orders | (A) sin rival | (B) no la tiene |
| Incrementalidad | (A) | Banda del contrafáctico dibujada; (B) la reduce a texto |
| Simulador | (A) | (B) confunde gasto de ventana con gasto mensual |
| Data health + carga | (B) | La mejor decisión de (B) |
| Help / SOPs | (A) sin rival | (B) no tiene Help |
| Navegación | (B) | 5 espacios vs scroll único: resuelve la queja de Mario |
| Tamaño de letra | (A) | (A) ≥13px; (B) usa 10/8/7px en contenido real |
| Encaje con el dashboard | (A) | (B) trae 1.403 líneas de CSS propio, sin modo oscuro |
