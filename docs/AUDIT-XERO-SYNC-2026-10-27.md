# Auditoría externa — plan de detalle de cuentas de Xero (PLAN-XERO-DETAIL-SYNC-2026-10-27)

Fecha: 27-oct-2026 · Alcance: sólo lectura (código, base vía SQL read-only, Xero vía MCP read-only).
No se modificó nada. Montos en AUD salvo indicación.

## Veredicto

**Proceder con cambios, no como está escrito.** Las causas A y B están confirmadas con documentos
concretos. Pero al plan le faltan cuatro cosas que, tal como está, lo harían fallar o lo harían
"pasar" sin estar bien:
1. El P&L que se usa como referencia (`xero_pl_monthly`) va a volver a estar mal desde el
   **2-nov**: pierde el día 31 cuando el mes en curso tiene 30 días.
2. Quedan **A$18.118 en movimientos de fin de mes** sin identificar. Pueden ser asientos manuales.
3. El diseño sólo incremental no ve los documentos que salen del filtro: re-fechados, re-imputados
   o borrados.
4. El criterio de ±1% esconde exactamente los errores encontrados.

## 1. Verificación de la evidencia

### 1.1 Números de la sección 1 del plan: confirmados

Recalculados con SQL sobre `xero_account_lines` vs `xero_pl_monthly`. Coinciden al centavo con el
plan:

| Cuenta | Jul | Ago | Sep | Oct |
|---|---|---|---|---|
| F&C P&L / líneas | 91.136,66 / 97.047,45 | 94.665,50 / 100.016,39 | 115.792,92 / 98.750,59 | 110.102,58 / 117.505,09 |
| R&T P&L / líneas | 5.481,83 / 5.481,83 | 129.838,62 / 125.083,09 | 24.980,17 / 18.382,17 | 0 / — |

El P&L de Xero (MCP, accrual) da lo mismo para ago y sep: F&C 94.665,50 y 115.792,92; R&T
129.838,62 y 24.980,17. Volumen de facturas ACCPAY por fecha de factura (MCP):

| Mes | Facturas ACCPAY |
|---|---|
| Jul | 4.591 |
| Ago | 5.200 |
| Sep | 7.528 |
| Oct (1-27) | 6.256 |

Sólo el 7-sep tuvo 637. Casi todas son contacto "Stock Journal", A$0, `Journal-PsdLLCPSD#…`. Un
tope de 200 por día queda por debajo del promedio diario desde agosto, y el volumen crece con
Pesado.

### 1.2 Septiembre, cuadrado documento a documento

Partí sep en tres ventanas con el P&L de Xero por rango y comparé con las líneas de la base:

| Ventana | P&L | Líneas (bruto) | Explicación | Residuo |
|---|---|---|---|---|
| 1–7 sep | 65.918,67 | 61.171,66 | − GST (AusPost 5.041,84; UPS 5,88; TFM 27,13) + **faltan** Diamond S00063312/A 3.308,50 y S00063312/B US$4.700 = 6.513,36 | **0,00** |
| 8–15 sep | 11.548,26 | 11.709,17 | − GST (Diamond S00063244/B 91,49; TFM 69,42) | **0,00** |
| 16–30 sep | 38.325,99 | 25.869,76 | − GST estimado ~156,6 + **falta** Mavam LLC "duties" 23-sep US$621 = 874,67 + **30-sep sin identificar 11.737,00** | ~1 (redondeo del GST estimado) |

- **Rates & Taxes sep (−6.598,00):** el faltante completo son dos facturas del ATO del 12-sep,
  "Andrea IAS" 4.998 y "Zoe IAS" 1.600, cuenta 465. Se pagaron el **22-oct**: se modificaron y aun
  así no entraron. Eso confirma que lo que queda afuera no se recupera ni con una modificación
  posterior.
- **El "faltante sin identificar ~A$12,6k" del plan** es en realidad Mavam 874,67 (factura que se
  saltó la lectura) más **un único importe de 11.737,00 fechado 30-sep**.
  - El P&L de ese día da 12.584,86 y la base sólo tiene ZONOS 847,86.
  - No es factura de ninguno de los 17 proveedores que revisé.
  - No hay movimiento bancario sin conciliar ese día.

### 1.3 Julio y agosto

- **Faltan 5 facturas de julio:** DHL PFIAU00024764, 24786, 29603 y 33493, y One Freight
  INV501776. Suman A$1.136,25 netos. Tres son del 2-3 jul: **la primera corrida incremental (8-jul)
  ya salió truncada**.
- **Falta 1 factura de agosto:** DHL PFIAU00077177, 26-ago, 143,85.
- **Agosto R&T (−4.755,53):** es exactamente el P&L de R&T del **31-ago**. No hay factura del ATO
  ni de QRO en agosto. Sin identificar.
- **31-ago F&C:** el P&L da 1.887,53 contra 288,15 bruto en la base. Quedan ~1.625,58 sin
  identificar.
- **Las tres BAS de 29.201 en agosto (20, 21 y 24-ago) son reales:** el P&L diario coincide en
  cada día. No son filas viejas.

### 1.4 Causas A–E

| Causa | Estado | Evidencia |
|---|---|---|
| A — lectura truncada | **Confirmada** | `xero-sync/index.ts:486` y `:511` (`page <= 2`). `:541-545`: la marca pasa a `runStart` sin condición. `:546`: devuelve `done: true` siempre. Hay 11 documentos faltantes identificados, con número (5 en jul, 1 en ago, 5 en sep). |
| B — GST incluido | **Confirmada, y es más amplia que lo descrito** | `:502` y `:526` usan `toAUD(line.LineAmount, …)` sin restar impuesto. Afecta **también a los movimientos bancarios**: AusPost jul y ago no son facturas sino Spend Money con GST. UPS, TFM y One Freight también lo traen; el 31-jul y el 29-sep cuadran exacto al dividir por 1,1. También afecta facturas en USD: Diamond S00063146/C está guardada a 3.810,27 contra 3.463,88 neto en Xero. |
| C — anulados/re-imputados no se borran | **Confirmada en código, no observada en datos** | `:491`/`:516` saltean DELETED/VOIDED sin borrar. Además `:480` (`Date>boundary` del lado de Xero) y `:493`/`:518` hacen invisible un documento re-fechado a antes del límite. No encontré filas viejas en lo que muestreé. |
| D — el reparto tapa el error | **Confirmada** | `parse-xero-costs/index.ts:276-290`. |
| E — nada controla | **Confirmada** | El vigilante sólo mira el código HTTP (`20261006120000_ops_watchdog.sql:139-142`) y `last_sync.ok`. Ese campo se escribe `true` siempre que no haya excepción (`xero-sync/index.ts:677-681`), así que la Xero sale verde las 14 últimas corridas. |

- **Conversión de moneda: correcta.** `LineAmount / CurrencyRate` da lo mismo que la base de Xero:
  S00063312/B 4.700/0,721594 = 6.513,36 y S00063244/A = 868,49. El neto tiene que calcularse
  **antes** de convertir: (LineAmount − TaxAmount)/rate. Se guardan decimales sin redondear (ej.
  612,2402417304431); hay que redondear cada línea a 2 decimales o el cuadre al centavo no cierra.
- **Historial cargado desde CSV (hasta 30-jun-2026): no tiene el problema del GST.** Jul-2025 a
  jun-2026 cuadran a 0,00, **salvo mayo-2026 (+1.862,59)**. El P&L de mayo está bien: 83.060,53 del
  1 al 30 más 957,72 del 31 = 84.018,25. Es deriva: algo cambió en Xero después de exportar el CSV
  (7-jul) y nada vuelve a leer ese tramo.

**Lo que no pude confirmar:**
- Qué son los tres importes de fin de mes: 31-ago R&T 4.755,53; 31-ago F&C ~1.625,58; 30-sep F&C
  11.737,00. La MCP sólo lista movimientos bancarios sin conciliar y no revisé las ~7.500 facturas
  por mes de contactos desconocidos.
- El orden por defecto que usa Xero al paginar.
- Si la lectura de movimientos bancarios perdió documentos fuera de 1-15 sep (en esa ventana está
  completa).

## 2. Causas que faltan o están mal descritas

- **F. El P&L de referencia pierde el día 31 (va a volver el 2-nov).**
  - Dónde: `xero-sync/index.ts:177-186`. Pide `toDate = fin del mes en curso` con `periods=11`.
    `parseHeaderCell` (`:103-112`) ignora el día del encabezado.
  - La memoria del 28-sep registró que `xero_pl_monthly` difería **exactamente en los meses de 31
    días**. Hoy coincide porque octubre tiene 31.
  - Mecanismo (inferido, no medido): Xero arma las columnas anteriores con el mismo día del mes que
    `toDate`.
  - Predicción: desde la corrida del 2-nov (hora Brisbane) jul, ago y oct pierden su día 31. En
    feb-2027 todos los meses pierden del 29 al 31.
  - Exposición: 31-jul F&C 6.775,05; 31-ago F&C 1.887,53 y R&T 4.755,53.
  - Consecuencia: el control P5 del plan compararía contra un total equivocado durante toda su
    ventana de 30 días. Esto va primero.
- **G. Movimientos de fin de mes que ningún paso lee.** Suman A$18.118 en ago-sep. Si son asientos
  manuales, P1-P4 no los arreglan y Sep F&C no entra en ±1% por construcción.
  - La sección 6 del plan dice que no hay permiso para leerlos. **Hay solución:** los scopes
    granulares de Xero incluyen `accounting.manualjournals.read`, distinto del endpoint Journals,
    que es de pago ([Apideck](https://www.apideck.com/blog/xero-scopes),
    [Xero devblog](https://devblog.xero.com/upcoming-changes-to-xero-accounting-api-scopes-705c5a9621a0)).
    Hay que pedirlo y re-autorizar. Verificar contra la doc oficial antes.
- **H. Notas de crédito de proveedores (ACCPAYCREDIT): nunca se leen.** Están en el endpoint
  `CreditNotes`, no en `Invoices`, y el P&L sí las incluye. No vi ninguna en los gaps de hoy; es un
  agujero latente.
- **I. El dominio CSV deriva y su cargador es destructivo.**
  - Mayo +1.862,59 sin reproceso posible.
  - `xero-load-transactions/index.ts:145-148` borra **todas** las líneas de la cuenta, también las
    `source='api'`.
  - Es la herramienta "natural" para P4. Si se usa como está, borra jul-oct y la marca ya pasó:
    nunca se recuperan.
- **J. Si renombran la cuenta, el paso no hace nada y no avisa.** Las cuentas vigiladas van por
  nombre; si no encuentra códigos devuelve `{lines:0, done:true}` (`xero-sync/index.ts:472`). Los
  códigos reales son 425 (F&C) y 465 (R&T).
- **K. El lector pagina sin orden.** `parse-xero-costs/index.ts:165-179` usa `.range()` sin
  `.order()`. F&C tiene **885 líneas** hoy y pasa de 1.000 en ~3 meses. Desde ahí la paginación de
  PostgREST sin clave única puede duplicar u omitir filas. `xero-account-detail/index.ts:65` ordena
  por `journal_date` (no es único): mismo riesgo en los bordes de página.
- **L. Lo deployado no es lo commiteado.**
  - `xero-sync/index.ts` tiene cambios sin commit (incluye `syncMetaBills`).
  - `_shared/doloXeroToken.ts` está **untracked**.
  - El HEAD de git usa el manejo viejo de tokens (tabla `xero_oauth_tokens`), con refresh token
    rotativo. Re-deployar desde git cambia de almacén de tokens y puede romper la conexión.
- **M. Código muerto que falla en silencio.**
  - `syncInvoices` (`:402`, `:407-409`) filtra por `Contact.Name`, que Xero rechaza por
    HighVolumeException (`:557-559`), y se traga el error con `catch { break; }`: devuelve 0 líneas
    "con éxito".
  - `syncBankTransactions` (`:271-341`) pagina por número de página sobre un conjunto que cambia
    mientras se lee; puede saltear registros.
- **Sobre If-Modified-Since + paginación:**
  - El código no se apoya en ningún orden: lee 2 páginas y mueve la marca igual.
  - Aunque leyera todo, paginar por número sobre un conjunto que cambia, con orden no especificado,
    puede saltear documentos.
  - P1 tiene que fijar `order=UpdatedDateUTC ASC` y avanzar la marca por el último documento leído,
    sin depender del número de página.
  - `pageSize` hasta 1.000 está disponible en Invoices según Xero
    ([devblog](https://devblog.xero.com/conquer-data-overload-mastering-paging-in-the-xero-api-03ceacfeb184)).
    Verificar en la doc oficial.

## 3. Evaluación de P1–P7 y cambios propuestos

**En una frase:** el plan arregla el incremental, pero sigue sin un mecanismo que **re-compruebe
el pasado**. Un sistema que sólo lee novedades no puede ver lo que dejó de estar en su filtro, ni
lo que perdió antes del arreglo.

| Paso | Juicio | Cambio concreto |
|---|---|---|
| **P0 (nuevo, primero)** | Falta | Pedir el P&L **mes por mes**: `fromDate` = día 1, `toDate` = último día, 13 llamadas. Validar que cada respuesta corresponde a ese mes; si falta uno, error. Prueba: el 2-nov, los 13 meses al centavo contra el P&L de la MCP de Xero. |
| P1 | Bien orientado, subespecificado | **Lectura por marca:** `If-Modified-Since = W − 5 min`, `order=UpdatedDateUTC ASC`, `pageSize` máximo. Se pagina hasta una página corta o hasta agotar el presupuesto (~100 s). Después de **cada** página se guarda W = mayor `UpdatedDateUTC` procesado.<br>**Empates:** si una página llena tiene todo en el mismo segundo, se sigue paginando con el mismo W en vez de avanzar.<br>**Señal de corte:** si se corta, responde `partial:true` con el pendiente estimado y `last_sync.ok=false`.<br>**Volumen:** probar excluir "Stock Journal" del lado de Xero (`Contact.ContactID!=Guid(...)`). Si da HighVolumeException, presupuestar ~700 facturas por día. |
| P2 | Correcto pero incompleto | Aplicarlo a **los dos caminos** (bancario y facturas): `net = (LineAmount − (Inclusive ? TaxAmount : 0)) / CurrencyRate`, redondeado a 2 decimales. Guardar `tax_amount`, `gross`, `line_amount_types`. La prueba no es "AusPost = 50.418,35": **toda línea muestreada = neto en moneda base de Xero, al centavo**. |
| P3 | Necesario, no alcanza solo | Agregar columnas `document_id`, `document_type`, `contact_id`, `updated_date_utc`. **Reemplazo por documento:** al leer un documento se borran sus líneas que ya no están, **sin filtro de fecha**. Cubre anulado, borrado, re-imputado y re-fechado antes del límite. Probar en la Demo Company de Xero, no en producción. |
| **P3b (nuevo)** | Falta | **Cuadre nocturno acotado** de los últimos 3 meses cerrados más el actual, por cuenta:<br>1. Si \|líneas − P&L\| > A$1, el mes queda "sucio".<br>2. Se relee ese mes: facturas por `ContactIDs` de los proveedores conocidos (pocas páginas) y movimientos bancarios por rango de fecha. Se carga en staging y se intercambia en una sola RPC, sólo si la lectura terminó entera.<br>3. Si sigue sucio, se leen los asientos manuales del mes (scope nuevo).<br>4. Si sigue sucio, rojo con el monto.<br>Es lo que hace que un error viejo se cure solo. |
| P4 | Correcto en intención | Desde el **1-jul**: la primera corrida ya perdió documentos. Staging + intercambio atómico, nunca borrar antes de tener la lectura completa.<br>**Antes de P4:** arreglar `xero-load-transactions` para que reemplace sólo `source='csv'` y el rango de fechas del archivo.<br>**Validación:** un export "Account Transactions" jul-oct que Mario baja una vez de Xero; es la única fuente que incluye asientos manuales. |
| P5 | Necesario, mal calibrado | Registrar en `ops_jobs` como chequeo de datos. **Tolerancia absoluta A$1 por cuenta y mes cerrado** (cerrado = desde el día 15 del mes siguiente); el mes en curso sólo amarillo.<br>Agregar: antigüedad de la marca > 26 h = rojo; 3 corridas `partial` seguidas = rojo.<br>Requiere P0; si no, da rojo falso. |
| P6 | Decisión de Mario, con un piso | Lo que no puede ser es invisible. Reemplazar el escalado proporcional por una fila explícita **"Over-captured"** (negativa). Fila **"Sin conciliar"** que ningún perfil pueda excluir, con monto y tooltip (fuente, mes, moneda). Con P2 hecho, cualquier exceso es señal de bug. |
| P7 | Bien, pero no una sola vez | Hacerlo con una **ruta independiente del código del autor**: la MCP de Xero (otra app, otro token), mensual, sobre todos los proveedores que alguna vez tuvieron líneas vigiladas. Para movimientos bancarios hace falta el export: la MCP sólo da los no conciliados. |
| Agregar | — | Cuentas vigiladas por **código** (425/465), con error si faltan.<br>`.order('journal_line_id')` en los dos lectores.<br>Borrar `syncInvoices`/`syncBankTransactions` o hacer que fallen fuerte.<br>Commitear lo deployado (incluido `doloXeroToken.ts`) antes de tocar nada.<br>Notas de crédito (`CreditNotes` ACCPAYCREDIT) en el mismo flujo. |

## 4. Criterio de efectividad: fallas y versión mejorada

**Fallas del criterio actual:**

- **±1% es demasiado laxo y esconde lo encontrado.** Mavam (874,67) es el 0,76% de F&C sep: pasa.
  Los DHL/One Freight de julio (1.136,25) son el 1,25%: casi pasan. En R&T de meses chicos el 1% son
  A$55. El historial CSV cuadra a **0,00**, así que el estándar alcanzable es al centavo.
- **No hay plan para lo inexplicable.** Si los 11.737,00 del 30-sep son un asiento manual, el
  criterio falla siempre o el autor lo exime a mano. Ninguna de las dos es independiente.
- **"30 días verde" no prueba nada si el control nunca demostró que puede ponerse rojo.**
- **La referencia está rota justo en la ventana.** El P&L va a estar mal del 2 al 30-nov (causa
  F).
- **Falta el "quién".** Sin una verificación por una ruta ajena al código del autor, el autor se
  evalúa a sí mismo.

**Versión propuesta (fijada antes de ejecutar):**

1. **Referencia verificada:** `xero_pl_monthly` = P&L de Xero vía MCP, al centavo, en los 13
   meses. Se mide el **2-nov**, el **1-dic** y el **1-mar-2027** (mes de 28 días).
2. **Meses cerrados** (jul, ago, sep; oct desde el 15-nov; nov desde el 15-dic): \|líneas − P&L\|
   ≤ **A$1,00** por cuenta y mes, o bien el residuo = suma de asientos manuales listados (ID, fecha,
   monto). Ningún residuo sin documento.
3. **Historial CSV** jul-2025 a jun-2026: sigue en 0,00. Mayo explicado o re-cargado.
4. **Línea a línea:** 20 líneas al azar más todas las de AusPost, Diamond, DHL, Mavam, ATO y QRO de
   jul-oct = neto en moneda base de Xero, al centavo.
5. **Documentos:** presentes los 11 identificados en esta auditoría.

   | Documento | Fecha | Proveedor |
   |---|---|---|
   | S00063312/A | 7-sep | Diamond |
   | S00063312/B | 7-sep | Diamond |
   | duties | 23-sep | Mavam LLC |
   | Andrea IAS | 12-sep | ATO |
   | Zoe IAS | 12-sep | ATO |
   | PFIAU00024764 | 3-jul | DHL |
   | PFIAU00024786 | 3-jul | DHL |
   | PFIAU00029603 | 13-jul | DHL |
   | PFIAU00033493 | 20-jul | DHL |
   | INV501776 | 2-jul | One Freight |
   | PFIAU00077177 | 26-ago | DHL |

   Además, 0 faltantes en la muestra MCP mensual (jul-nov) de los proveedores con líneas vigiladas.
6. **Pruebas negativas, antes de declarar terminado:**
   - Con tope forzado de 1 página: la corrida responde `partial`, el vigilante pasa a amarillo y
     después a rojo, y las corridas siguientes recuperan todo sin pérdida.
   - Una fila borrada a mano en una copia: el cuadre se pone rojo en un ciclo y lo repara.
   - Un documento anulado o re-imputado en la Demo Company desaparece de la base.
7. **En el tiempo:** 30 días con el cuadre de meses cerrados en verde, ninguna racha de 3
   `partial`, marca siempre < 26 h.
8. **Quién controla:** el vigilante (automático) y una verificación mensual MCP hecha por otra
   sesión o agente, no por el autor. Se guarda como `docs/XERO-RECON-YYYY-MM.md`.
9. **Qué cuenta como falla:** cualquier mes cerrado fuera de A$1 sin documento; cualquier corrida
   parcial que no se recupere en 24 h; cualquiera de los documentos de la lista ausente. En ese caso
   el arreglo falló.

## 5. Otros syncs con el mismo patrón

| Archivo:línea | Patrón | Severidad | Consecuencia |
|---|---|---|---|
| `ddp-sync/index.ts:472,484,487,523` | ZONOS: tope de 100 páginas × 50 = 5.000 sin marcar truncado. `!res.ok → break` y `!data → break` tampoco marcan. Después reconstruye `ddp_zonos_unmatched` desde la lectura parcial y responde `success:true`. | **Alta** (el corte por error ya ocurre hoy; el tope se activa en corridas de ventana completa: desde el 1-ago hay ≥8.891 órdenes ZONOS) | Duties/taxes no se refrescan. La lista de "sin match" se achica y parece resuelta. |
| `xero-load-transactions/index.ts:145-148` | Reemplazo total por cuenta: borra también `source='api'`. | **Alta** si se usa | Borra jul-oct y no hay forma de que vuelvan. |
| `ddp-sync/index.ts:7,137` | Las órdenes canceladas o test se saltean, pero si ya estaban guardadas no se borran ("Rows are never deleted"). | Media | Envíos DDP fantasma en conteos y costos por orden. |
| `unleashed-sales-sync/index.ts:75-83,94,109,113,241` | Si se corta guarda la marca (bien), pero **re-empieza desde la página 1** y relee Products y Customers enteros en cada corrida. 6 de las últimas 12 corridas fueron parciales; 1 se cortó por timeout de 150 s (26-oct). | Media | Al crecer el volumen se traba y nadie avisa: el parcial es "warn" y el vigilante no lo eleva (ver abajo). |
| `sync-orchestrate/index.ts:244-252` + chequeo `sync-steps` del vigilante | Parcial = warn. `sync-steps` sólo alerta con "error" 3 corridas seguidas. | Media | Un paso que queda parcial para siempre nunca se pone rojo. |
| `parse-xero-costs/index.ts:165-179`; `xero-account-detail/index.ts:65` | `.range()` sin orden por clave única. | Media (latente, ~3 meses) | Duplica u omite líneas cuando pasan de 1.000. |
| `xero-sync/index.ts:617-624` (`syncMetaBills`) | Borra los meses que no vinieron en la respuesta. | Media-baja | Una respuesta vacía (contacto fusionado o cambiado) vacía la tabla sin avisar. |
| `xero-sync/index.ts:402,407-409` (`syncInvoices`, manual) | Filtro rechazado por Xero y error tragado. | Media si alguien lo corre | 0 líneas "con éxito". |
| `ddp-sync/index.ts:111`, `shopify-sales-sync/index.ts:98-99`, `dashboard-data/index.ts:222` | Si falta el tipo de cambio del mes usa 1,54 fijo (el real va de 1,40 a 1,44). | Media-baja | Error silencioso de 7-10%; contradice "null, nunca 0 ni 999". |
| `ddp-sync/index.ts:130` | Loop de Shopify sin presupuesto de tiempo; en corrida completa la ventana crece desde `DDP_START`. | Baja-media | Viola la regla 1 del CLAUDE.md; falla fuerte a los 150 s. |
| `shopify-sales-sync/index.ts:137,344` | Tope de 80 páginas: responde HTTP 200 con `success:false`. La marca sí es correcta (`updated_at asc`, último procesado). Además, 11 errores 500 en 14 días ("ON CONFLICT … a second time"): la misma orden aparece dos veces en el lote. | Baja | Señal débil. Es el patrón de referencia correcto para P1. |
| `shopify-attribution-sync/index.ts:24,176,243` | Tope de 25 páginas, `partial`, marca ordenada por UPDATED_AT. | Baja | Correcto; sólo invisible si queda en warn para siempre. |
| `meta-ads-sync.ts:22,93`, `meta-ads-campaign-sync.ts:17,81`, `meta-ads-country-sync.ts:22` | Ventana fija de 30/30/14 días; upsert, nunca borra. | Baja | Revisiones más viejas que la ventana no entran. |
| `aim2026-sync-unleashed/index.ts:175-181` | Falla fuerte si la lectura se trunca. | — | Patrón correcto, sirve de referencia. |

**Hallazgo lateral, no investigado:** Dinamarca (mercado DDP activo) tiene **0 matches de ZONOS
para órdenes desde ~9-sep**: ~138 órdenes en 7 semanas, último match el 24-sep. Puede tener una
causa legítima (DK fuera de ZONOS), pero nada lo avisó. Es exactamente la clase de problema que
describe la pregunta 5.

## 6. Cambios sistémicos recomendados

1. **Contrato de cuadre por sync financiero.** Cada sync declara un total externo de referencia y
   un chequeo SQL, en `ops_jobs` como `kind='reconciliation'`, con tolerancia absoluta y el monto en
   el mensaje:
   - Xero: líneas vs P&L.
   - Shopify: líneas vs totales de órdenes.
   - Unleashed: órdenes y monto por mes.
   - ZONOS: tasa de match por mercado (habría detectado DK).
   - Meta: diario vs total de la cuenta.

   El vigilante actual sólo ve si el job contestó, no si el dato es correcto.
2. **El vigilante lee el cuerpo de la respuesta, no sólo el código.** `net._http_response.content`
   ya está disponible.
   - `success:false` = falla.
   - `partial:true` = warn.
   - 3 parciales seguidos = rojo ("no progresa").
   - Guardar marca antes/después por corrida: marca quieta 26 h = rojo; marca que avanzó en una
     corrida truncada = rojo (estado imposible).
3. **Reglas nuevas en el CLAUDE.md del repo**, al lado de las 4 que ya hay:
   - La marca sólo avanza hasta el último registro procesado, nunca a la hora de inicio.
   - Todo tope de páginas marca `partial`.
   - Nada de valores de reserva silenciosos (`?? 1.54`, `catch { break; }`).
   - Todo `.range()` lleva `.order()` por clave única.
   - Lo borrado o re-imputado en el origen se propaga, reemplazando por documento o por ventana.
   - Todo sync incremental tiene un cuadre periódico de los últimos N meses.
4. **Lint de 50 líneas antes de cada deploy** (script node, no CI externo). Marca `page <= N` sin
   flag parcial, `catch {` vacío o con `break`, `?? 1.54`, `.range(` sin `.order(`, y
   `since: runStart`.
5. **Detección de cambios del contador o de Xero:**
   - Semanal: contactos nuevos en cuentas vigiladas.
   - Cuentas vigiladas existentes por código.
   - Cuentas nuevas del P&L con más de A$1k.
   - Facturas de Meta presentes por mes.
   - Reparto Sales / Pesado sales.
6. **Auditoría mensual independiente programada.** Una tarea agendada (otra sesión, no el autor)
   corre P0 y P7 con la MCP y deja un .md fechado; si falla, rojo.
7. **Aviso activo** (email, pendiente según memoria). Sin aviso, el punto rojo depende de que Mario
   mire.
8. **Lo deployado = lo commiteado.** Cada función devuelve su SHA de git y el vigilante lo muestra.

## 7. Riesgos y límites de esta auditoría

- No identifiqué los tres importes de fin de mes: 31-ago R&T 4.755,53; 31-ago F&C ~1.625,58; 30-sep
  F&C 11.737,00.
  - Descarté que sean facturas de 17 proveedores conocidos (AusPost ×2, Diamond, DHL ×3, UPS, TFM,
    One Freight, StarTrack, ZONOS, shipmonk, Hoon Choi, Mavam ×2, ATO, QRO).
  - No revisé facturas de contactos desconocidos (~7.500 por mes) ni movimientos bancarios
    conciliados: la MCP no los expone.
- La causa F (día 31) es una inferencia. Se apoya en la memoria del 28-sep, el código y que hoy
  cuadre. No la reproduje; la prueba es comparar el 2-nov.
- El GST de 16-30 sep es estimado (dividir por 1,1 las líneas de couriers locales). El residuo es
  ~A$1.
- No verifiqué el orden por defecto de Xero ni `pageSize` en la doc oficial; las fuentes son el
  devblog de Xero y terceros.
- Revisé los otros syncs por patrón, no línea por línea. Pueden quedar casos no listados.
- La lista de documentos faltantes sale de un muestreo por proveedor. Puede haber más.
