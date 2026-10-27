# Plan de acción — detalle de cuentas de Xero (Freight & Courier, Rates & Taxes)

Fecha: 27-oct-2026 · Estado: **plan, nada ejecutado** · Pedido por Mario, para revisión de
un auditor externo antes de tocar nada.

## 1. El problema hoy

El dashboard parte dos cuentas de Xero ("vigiladas") en subcategorías por proveedor: Freight
& Courier (inbound / outbound B2C AU / B2C USA / B2B…) y Rates & Taxes. Para eso guarda las
líneas de facturas de proveedores y movimientos bancarios en `xero_account_lines`, y
`parse-xero-costs` reparte cada mes y lo cuadra contra el total del P&L (`xero_pl_monthly`).

**Medido el 27-oct-2026 (líneas guardadas vs P&L de Xero, AUD):**

| Cuenta | Jul | Ago | Sep | Oct (parcial) |
|---|---|---|---|---|
| Freight & Courier — P&L | 91.137 | 94.666 | 115.793 | 110.103 |
| Freight & Courier — líneas | 97.047 (+6,5%) | 100.016 (+5,7%) | 98.751 (**−14,7%**) | 117.505 (+6,7%) |
| Rates & Taxes — P&L | 5.482 | 129.839 | 24.980 | — |
| Rates & Taxes — líneas | 5.482 (0%) | 125.083 (−3,7%) | 18.382 (**−26,4%**) | — |

`xero_pl_monthly` coincide al centavo con Xero en jul y ago (verificado con la API de Xero el
27-oct), así que el error está en las líneas, no en el total.

**Evidencia:**
- **GST adentro de las líneas:** Australia Post sep = 55.460,19 en la base vs 50.418,35 en el
  P&L = exactamente × 1,10. En jul, ago y oct las líneas superan al P&L en 6-7%.
- **Documentos perdidos:** dos facturas de Diamond Freight del 7-sep (S00063312/A A$3.308,50;
  S00063312/B US$4.700 = A$6.513,36), cargadas a la cuenta 425 en Xero, no están en la base
  (hallado por otra sesión, MRD, 26/27-oct; Diamond tiene otras 76 líneas que sí llegaron).
- Faltante sin identificar en Freight sep: ~A$12,6k después de restar GST y sumar Diamond.

**Efecto en pantalla:** cuando las líneas superan al P&L, `parse-xero-costs` las achica
proporcionalmente (el total queda bien, los repartos no). Cuando quedan cortas, la diferencia
va a "Freight & Courier — Unclassified", que el perfil "Mario Analysis" excluye: By Channel
muestra el flete de septiembre ~A$17k corto. Nadie se entera hasta que Mario controla.

## 2. Causas raíz (verificadas en el código, `supabase/functions/xero-sync/index.ts`)

| # | Causa | Dónde | Desde |
|---|---|---|---|
| A | **Lectura truncada en silencio.** `syncDetailIncremental` pide como máximo 2 páginas (200) de facturas ACCPAY y 2 de movimientos bancarios modificados desde la última corrida, y después mueve la marca (`since: runStart`) **aunque hayan quedado documentos sin leer**. Las facturas ACCPAY incluyen las "Stock Journal" automáticas (~7.500 en sep), así que el tope se llena casi a diario. Lo que queda afuera no se vuelve a leer nunca. La función responde 200: el vigilante no lo ve. | líneas ~486-543 | 8-jul-2026 (commit 4f76b1c) |
| B | **GST incluido.** `net_amount = toAUD(line.LineAmount, …)` sin restar `TaxAmount` cuando el documento es `LineAmountTypes = Inclusive`. | mismo paso | 7/8-jul-2026 |
| C | **Documentos anulados o re-imputados nunca se borran.** Si una factura se anula (`VOIDED/DELETED`) o se pasa a otra cuenta, el paso la saltea, pero la línea vieja queda en la tabla para siempre. | mismo paso | 8-jul-2026 |
| D | **El reparto tapa el error.** Escalar hacia abajo esconde el GST; "Unclassified" excluido por perfil esconde el faltante. | `parse-xero-costs` ~276-290 | 7-jul-2026 |
| E | **Nada controla.** No hay un chequeo que compare líneas vs P&L todos los días. | — | — |

## 3. Problemas anteriores que se "arreglaron" y volvieron

| Fecha | Problema | Arreglo que se hizo | Qué pasó después |
|---|---|---|---|
| may→28-jul | Sync de demanda cortaba en 30 páginas y borraba la ventana antes de rellenar: destruyó 34.317 u | Watermark + reemplazo por Guid; demanda derivada | Funcionó. Mismo patrón (lectura parcial tomada como completa) reapareció en otros syncs |
| 3-ago | Upsert por lotes con columnas distintas pisó con NULL 753 costos | Regla: todas las filas con mismas columnas | No volvió en ese sync |
| 8-jul | `xero_account_lines` leída con tope de 1.000 filas de PostgREST | Paginado | El mismo tope volvió el 7-sep en `ddp-sync` (57 "huérfanos" falsos de ZONOS) |
| 8-jul | Sync incremental del detalle de Xero (2 páginas/día) | — (es el diseño) | **Es la causa A de hoy**: pierde documentos desde julio |
| jul | P&L de Xero: segunda ventana (cierre de FY) da HTTP 400 | Se saltea "best-effort" | Sigue abierto |
| 28-sep | `xero_pl_monthly` difería de Xero en los meses de 31 días | No se arregló | Al 27-oct jul y ago coinciden: no se sabe por qué; puede volver |
| ago→28-sep | Portada y By Channel daban 500 al cargar | 4 arreglos sucesivos (cada uno movía el cuello) | Resuelto 28-sep con 1 RPC + registro de cargas |
| 3-ago→3-sep | Panel Web Upgrade lento | 5 arreglos (tabla slim, resúmenes, caché, tick, escalonado) | Caída de la base 5/6-oct; resuelto de raíz el 6-oct |
| 31-ago→6-oct | Archivado de eventos trabado, 500 cada hora, "Succeeded" en el cron | — (nadie lo vio 5 semanas) | Arreglado 6-oct + vigilante |
| jul / sep | Cambios del contador en Xero (Shopify a "Pesado sales"; Meta como factura mensual del mes anterior) | Se detectaron tarde, por Mario | Detectado a mano cada vez |

**Patrones comunes:**
1. **Lecturas parciales tomadas como completas** (topes de páginas, 1.000 filas, timeouts) sin señal de error.
2. **Arreglos validados una sola vez**, el día del cambio, y dados por terminados sin un criterio medido en el tiempo.
3. **Cálculos que esconden el error** (escalar al total, "Unclassified" excluido, "Succeeded" del cron).
4. **Cambios del lado de Xero o del contador** que nadie detecta automáticamente.
5. **Diseño sin medir el volumen real** (200 docs/día "alcanza").

## 4. Plan de acción propuesto

| Paso | Qué | Prueba de aceptación |
|---|---|---|
| P1 | Lectura completa con presupuesto de tiempo: paginar hasta agotar; la marca avanza sólo hasta el último documento procesado (por `UpdatedDateUTC`); si se corta, responde "parcial" (no 200 limpio) y la corrida siguiente retoma. | Forzar tope de 1 página: al día siguiente se recupera todo; dos corridas seguidas no reducen nada |
| P2 | Monto neto sin GST: `LineAmount − TaxAmount` si `Inclusive` (como ya hace el paso `meta_bills`). | Australia Post sep = 50.418,35 |
| P3 | Al leer un documento modificado: borrar sus líneas guardadas que ya no correspondan (anulado, borrado, cambiado de cuenta). Guardar el id del documento. | Caso de prueba con un documento anulado en el historial |
| P4 | Re-bajar jul-oct-2026 de las dos cuentas vigiladas (paso de una vez, reanudable). | Líneas vs P&L ±1% por mes y cuenta |
| P5 | Chequeo diario en el vigilante (`ops_watchdog`): líneas vs P&L por mes y cuenta, rojo si fuera de ±1%, con el monto. | Rojo visible si se rompe; verde si cuadra |
| P6 | Decidir qué muestra By Channel con un faltante: hoy "Unclassified" excluido = invisible. Propuesta: mostrarlo como fila "Sin conciliar" con el monto. | Decisión de Mario |
| P7 | Muestra documento a documento: todas las facturas de couriers de sep y oct en Xero vs la base. | 0 faltantes |

## 5. Criterio de efectividad (fijado antes de ejecutar)

- Al terminar: líneas vs P&L dentro de ±1% en jul, ago, sep y oct, para las dos cuentas; 0
  facturas de couriers faltantes en la muestra; Australia Post sep = 50.418,35.
- Durante 30 días: el chequeo diario en verde sin excepciones.
- 27-nov-2026: cierre de octubre (con las facturas que llegan en noviembre) dentro de ±1%.
  Si algún mes queda fuera sin explicación, **el arreglo falló**, diga lo que diga el autor.

## 6. Límites conocidos

- **Asientos manuales**: la app de Xero no tiene permiso para leerlos (scopes granulares:
  `accounting.reports.profitandloss.read`, `accounting.banktransactions.read`,
  `accounting.invoices.read`, `accounting.settings.read`; el endpoint Journals es de pago). Si
  existen, el chequeo los muestra como diferencia; no se pueden atribuir sin el export
  "Account Transactions" de Xero.
- No hay permiso de contactos: los filtros por proveedor van por id (como en `meta_bills`).
- Límites de la API de Xero (60 llamadas/min, 5.000/día) y el volumen de Stock Journals.
- La cadena de syncs no es transaccional: un corte a mitad deja datos parciales hasta la
  corrida siguiente.

## 7. Preguntas para el auditor

1. ¿Las causas A-E explican toda la evidencia? ¿Falta alguna?
2. ¿El plan P1-P7 cierra las causas, o vuelve a tratar síntomas?
3. ¿El criterio de efectividad es medible e independiente del autor? ¿Qué le falta?
4. ¿Qué otros syncs del proyecto tienen el mismo patrón (lectura parcial tomada como completa,
   marca que avanza igual, montos con impuestos) y van a fallar igual?
5. ¿Qué cambiarías para que el próximo problema de este tipo se detecte solo, antes de que
   Mario lo vea?
