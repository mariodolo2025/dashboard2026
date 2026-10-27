# Plan de acción v2 — detalle de cuentas de Xero

Fecha: 27-oct-2026 · Estado: **aprobado por Mario el 27-oct-2026; en ejecución** (ver §0)

## 0. Estado de ejecución (27-oct-2026)

| Paso | Estado | Evidencia |
|---|---|---|
| Fase 0–1 (seguridad, P0 P&L mes por mes) | Hecho | 610b179. Mar y may-2026 = Xero al centavo; MRD `xero_costs` = P&L. |
| Fase 2–3 (lectura completa, neto de GST, reemplazo por documento, credit notes, cuentas por código, reread, reconcile nocturno) | Hecho | ab3e6a1. Jul–oct, ambas cuentas = P&L (máx −0,01). 11 documentos de la auditoría presentes. AusPost sep = 50.418,35. Corte forzado (`maxPages=1`) → `partial`, la corrida siguiente retomó y terminó. "all" completo: 17 s. MRD: dependencias iguales, `xero_costs` = P&L jul–oct. |
| P5 vigilante | Hecho | ba28be5. Chequeo "Xero · freight & rates = P&L"; prueba con A$5 de más en agosto + 3 cortes → rojo con ambas razones (revertida). |
| P6 By Channel sin escalado | **Código listo, sin publicar** | Espera validación visual de Mario (login). Hoy sólo may-2026 tiene diferencia: líneas A$1.862,59 por encima del P&L. |
| P7 verificación mensual independiente | Hecho | 556f108 + tarea agendada `xero-monthly-verification` (día 2, 08:00). Primera corrida 2-nov. |
| 4b S1 | Hecho | Ver corrección abajo. Prueba negativa: reemplazo con fila duplicada → error y la orden conserva sus filas. |
| 4b S2 re-lectura jul-2025 → oct-2026 | Hecho | Órdenes por mes = `ordersCount` de Shopify (todas las órdenes, días Brisbane) en los 16 meses. Recuperadas: jul-25 14, ago-25 39, sep-25 31, oct-25 31, nov-25 35, dic-25 133, ene-26 89, feb-26 90, ago-26 3, sep-26 69, oct-26 16+. |
| 4b poda (agregado) | Hecho | 4 órdenes **borradas en Shopify** seguían en la base (ago 2, sep 1, oct 1; A$80,70 neto en total): movidas a `backup.shopify_sales_lines_pruned`. Una re-lectura completa de una ventana poda sólo lo que Shopify ya no devuelve, escrito antes de la lectura, y como máximo 2% de la ventana. |
| 4b S3 cuadre diario | Hecho | Cron `shopify-count-check` 06:40 Brisbane + chequeo "Shopify · orders = Shopify". Prueba: una orden menos → rojo (revertida). |
| 4b S4 tipo de cambio | Hecho | Vista y función usan la última tasa cargada; el card avisa "no USD→AUD rate for this month yet". Vista: mismas columnas, 36 ms vs 33 ms en un mes, dependencias MRD iguales. |

**Corrección a S1.** La causa no son "dos líneas del mismo SKU" en una orden: dentro de una
orden las filas ya se agrupaban por SKU. Es **la misma orden dos veces en una corrida** de más de
una página, cuando Shopify la actualiza mientras se pagina (p. ej. un lote de despachos). Error
real visto el 26-oct 23:30 UTC en el cron rápido. Sumar las dos copias, como decía este plan,
habría duplicado montos; se guarda la versión más nueva de cada orden. El cron rápido (cada 5 min,
ventana de 2 h) explica por qué lo perdido no volvía: la próxima corrida buena ya no veía órdenes
cuyo último cambio había salido de la ventana.
Reemplaza a `PLAN-XERO-DETAIL-SYNC-2026-10-27.md` (v1). Incorpora completa la auditoría externa
`AUDIT-XERO-SYNC-2026-10-27.md`. Donde la v1 y la auditoría difieren, manda la auditoría.

## 1. Qué está mal (verificado por el auditor, documento por documento)

- **Lectura truncada (A):** el paso diario lee 2 páginas y mueve la marca igual. Hay **11
  documentos faltantes** con número (5 en jul, 1 en ago, 5 en sep). La primera corrida, el 8-jul,
  ya salió cortada. Lo perdido no vuelve ni cuando el documento se modifica: las dos facturas del
  ATO de sep se pagaron el 22-oct y siguen afuera.
- **GST adentro (B):** en facturas **y** en pagos directos (AusPost jul/ago, UPS, TFM, One
  Freight), también en facturas en USD.
- **Anulados, re-imputados o re-fechados no se borran (C):** confirmado en el código.
- **El reparto tapa el error (D)** y **nada controla (E):** el vigilante sólo ve el código HTTP y
  `last_sync.ok`, que siempre da `true`.
- **Nuevas:**
  - **F.** El P&L de referencia pierde el día 31 del mes cuando el mes en curso tiene menos días.
    Vuelve el **2-nov**: jul, ago y oct quedan cortos.
  - **G.** A$18.118 de importes de fin de mes sin identificar: 30-sep flete 11.737,00; 31-ago
    R&T 4.755,53 y flete ~1.625,58. Probablemente asientos manuales.
  - **H.** Notas de crédito de proveedores: nunca se leen.
  - **I.** El historial del CSV deriva (mayo +1.862,59) y su cargador **borra también lo que trajo
    la API**.
  - **J.** Si renombran una cuenta vigilada, el paso no hace nada y no avisa.
  - **K.** Los lectores paginan sin orden; F&C pasa de 1.000 líneas en ~3 meses.
  - **L.** Lo desplegado no es lo commiteado (manejo de token de Xero).
  - **M.** Código manual muerto que "funciona" devolviendo 0.

## 2. Por qué esto vuelve siempre

Diez incidentes anteriores (tabla en la v1, §3) tienen el mismo patrón: lecturas parciales
tomadas como completas, arreglos comprobados una sola vez, cálculos que esconden la diferencia,
cambios del contador que nadie detecta y diseños sin medir contra el volumen real. **Este plan no
se apoya en que el código nuevo esté bien: agrega un cuadre que re-comprueba el pasado todas las
noches y una verificación mensual hecha por otro, no por el autor.**

## 3. Restricciones por el MRD (otro proyecto que lee estas tablas)

Aviso del agente del MRD (27-oct), verificado en el catálogo de la base (pg_depend; la vista
`information_schema.view_table_usage` da vacío para el usuario de sólo lectura, por eso se usa el
catálogo):

| Vista MRD | Lee |
|---|---|
| `mrd_v_pl_month` | `xero_pl_monthly` (year, month, section, account_name, amount, **synced_at**) |
| `mrd_v_split_lines_month` | `xero_account_lines` (journal_date, account_name, net_amount, contact_name, reference, description) |
| `mrd_v_shopify_month` | `shopify_sales_lines`, `shopify_sales_by_variant` |
| `mrd_v_brand_month` | `shopify_sales_by_variant` |
| `mrd_v_cost_month`, `mrd_v_unleashed_lines` | `unleashed_sales_lines` |
| `mrd_v_ads_month` | `meta_ads_daily`, `google_ads_daily`, `currency_exchange_rates` |
| `mrd_v_sku_cost` | `aim2026_sku_parameters`, `aim2026_cost_config` |
| `mrd_v_payroll_excl_month` | `payroll_exclusions_monthly` |

Reglas que este plan respeta:
- **No renombrar, no recrear, no borrar** esas tablas ni la vista `shopify_sales_by_variant`. Las
  vistas del MRD están atadas a la tabla física: un renombre las deja leyendo la tabla vieja sin
  error; un `DROP … CASCADE` las borra.
- **Todo "intercambio" (P3b, P4) = `DELETE` + `INSERT` dentro de una sola transacción (RPC), sobre
  la misma tabla.** Nada de tablas staging renombradas.
- **Columnas:** se pueden agregar; no se renombran ni cambian de significado. `net_amount` pasa a
  neto sin GST (aceptado por el MRD). `account_name` sigue con el nombre ('Freight & Courier',
  'Rates & Taxes') aunque el sync filtre por código. `synced_at` se sigue escribiendo.
- **Antes y después de cada cambio de tablas:** (1) la lista de dependencias de arriba idéntica;
  (2) `mrd_dashboard('2026-07-01','2026-10-31')` responde y el costo total de cada mes = P&L de
  Xero.
- P0 antes del 2-nov también por el MRD: toma todos sus costos de `xero_pl_monthly`.

## 4. Plan, en orden

### Fase 0 — Seguridad (antes de tocar nada)
| Paso | Qué | Prueba |
|---|---|---|
| 0.1 | Commitear lo desplegado hoy: `xero-sync` y `_shared/doloXeroToken.ts` (L). | `git` y lo desplegado iguales; cada función devuelve su SHA de git. |
| 0.2 | Arreglar `xero-load-transactions`: reemplaza sólo `source='csv'` y el rango de fechas del archivo (I). | Prueba en una copia: cargar un CSV no borra filas `source='api'`. |

### Fase 1 — Referencia correcta (antes del 2-nov)
| Paso | Qué | Prueba |
|---|---|---|
| P0 | P&L **mes por mes**: 13 llamadas, día 1 al último día; si falta un mes o no corresponde, error. | 2-nov, 1-dic y 1-mar-2027 (mes de 28 días): los 13 meses al centavo contra el P&L de Xero leído por la MCP (otra app, otro token). |

### Fase 2 — Lectura correcta
| Paso | Qué | Prueba |
|---|---|---|
| P1 | Lectura por marca: `order=UpdatedDateUTC ASC`, `pageSize` máximo, `If-Modified-Since` = marca − 5 min. Paginar hasta página corta o hasta ~100 s; guardar la marca después de **cada** página con el mayor `UpdatedDateUTC` procesado; empates en el mismo segundo siguen con la misma marca. Si se corta: `partial:true`, `last_sync.ok=false`, pendiente estimado. Probar excluir "Stock Journal" del lado de Xero; si Xero lo rechaza, presupuestar ~700 facturas por día. | Tope forzado de 1 página: la corrida responde `partial`, el vigilante pasa a amarillo y después a rojo, y las corridas siguientes recuperan todo sin pérdida. |
| P2 | Neto en los dos caminos (facturas y pagos): `(LineAmount − (Inclusive ? TaxAmount : 0)) / CurrencyRate`, redondeado a 2 decimales. Guardar `tax_amount`, bruto y `line_amount_types`. | 20 líneas al azar + todas las de AusPost, Diamond, DHL, Mavam, ATO y QRO de jul-oct = neto en moneda base de Xero, al centavo. |
| P3 | Reemplazo por documento: columnas `document_id`, `document_type`, `contact_id`, `updated_date_utc`. Al leer un documento se borran sus líneas que ya no están, sin filtro de fecha (anulado, borrado, re-imputado, re-fechado). | Documento anulado o re-imputado en la **Demo Company de Xero** (no en producción): desaparece de la base. |
| P3c | Notas de crédito de proveedores (`CreditNotes` ACCPAYCREDIT) en el mismo flujo (H). | Una nota de crédito de prueba en la Demo Company aparece con signo negativo. |
| P3d | Cuentas vigiladas por **código** (425 F&C, 465 R&T), con error si faltan (J). `.order('journal_line_id')` en los dos lectores (K). Borrar `syncInvoices`/`syncBankTransactions` manuales o hacer que fallen fuerte (M). | Renombrar en la Demo Company: el paso da error, no 0. |

### Fase 3 — Reparar el pasado y mantenerlo reparado
| Paso | Qué | Prueba |
|---|---|---|
| P4 | Re-lectura jul-oct-2026 a memoria/tabla auxiliar; reemplazo con `DELETE` + `INSERT` en **una sola transacción** sobre `xero_account_lines`, y sólo si la lectura terminó entera. Nunca borrar antes de tener lo nuevo (regla MRD, §3). | Los 11 documentos de la auditoría presentes; meses cerrados a ≤ A$1 o residuo = asientos manuales listados. |
| P3b | **Cuadre nocturno** de los últimos 3 meses cerrados + el actual, por cuenta: si \|líneas − P&L\| > A$1, el mes queda "sucio" → se relee ese mes (facturas por id de proveedor y pagos por rango) y se reemplaza con `DELETE` + `INSERT` en una transacción → si sigue sucio, se leen los asientos manuales del mes → si sigue sucio, rojo con el monto. | Borrar una línea a mano en una copia: el cuadre se pone rojo en un ciclo y lo repara solo. |
| P3e | Asientos manuales (G): pedir el permiso `accounting.manualjournals.read` (verificar antes en la doc oficial de Xero) y re-autorizar. Mayo-2026 (+1.862,59): explicar o re-cargar. | Los tres importes de fin de mes identificados con su ID de asiento, o el export de Xero los explica. |

### Fase 4 — Que se vea solo
| Paso | Qué | Prueba |
|---|---|---|
| P5 | En el vigilante, chequeo de cuadre: tolerancia **A$1 por cuenta y mes cerrado** (cerrado = desde el día 15 del mes siguiente); mes en curso sólo amarillo. Marca sin moverse > 26 h = rojo; 3 corridas `partial` seguidas = rojo. El vigilante lee el **cuerpo** de la respuesta (`success:false` = falla, `partial` = warn). | Pruebas negativas de P1 y P3b ponen el control en rojo. |
| P6 | By Channel: se elimina el escalado silencioso. Fila **"Over-captured"** (negativa) si sobra y fila **"Unreconciled"** si falta, que ningún perfil puede excluir, con monto y tooltip. | Septiembre muestra la diferencia hasta que se cierre. |
| P7 | **Verificación mensual independiente:** tarea agendada que corre otra sesión/agente (no el autor), con la MCP de Xero: P0 + muestra de documentos de todos los proveedores vigilados; deja `docs/XERO-RECON-AAAA-MM.md`; si falla, rojo. | Primera corrida el 2-nov. |

### Fase 4b — Shopify pierde órdenes (agregado por el aviso del MRD)
Verificado: `shopify-sales-sync/index.ts:296-304` borra las líneas de **todas** las órdenes
re-leídas y recién después hace el upsert por lotes, en llamadas separadas (sin transacción). Si un
lote falla ("ON CONFLICT … a second time": la misma orden trae dos líneas con el mismo SKU y país),
las órdenes ya borradas quedan sin líneas. Base: sep-2026 = 7.110 órdenes distintas (coincide con
lo que midió el MRD); el total de Shopify (7.179) y los 5 números de orden del 3-sep no los
verifiqué yo.

| Paso | Qué | Prueba |
|---|---|---|
| S1 | Agrupar las filas por (`order_id`, `sku`, `country`) antes de escribir (sumar cantidades y montos), y reemplazar cada orden con `DELETE` + `INSERT` en **una transacción** (RPC): si falla, quedan las filas viejas. | Orden de prueba con dos líneas del mismo SKU: entra completa; un fallo forzado no borra nada. |
| S2 | Re-leer dic-2025 a oct-2026 y reponer lo perdido. | Órdenes por mes = `ordersCount` de Shopify para web pagas no canceladas (dic −133, ene −89, feb −90, sep −69, oct −16 hoy). |
| S3 | Cuadre mensual en el vigilante: órdenes por mes vs `ordersCount` de Shopify; rojo si difiere. | Prueba negativa: borrar una orden en una copia → rojo. |
| S4 | Tipo de cambio de reserva: hoy 1,54 fijo en la vista `shopify_sales_by_variant` y en `shopify-sales-sync/index.ts:98-99`. Pasar a la última tasa cargada en `currency_exchange_rates` (hoy oct-2026, 1,4352) y marcarlo como aviso cuando se use. La vista se cambia con `CREATE OR REPLACE VIEW` sin tocar nombre ni columnas (la lee el MRD). | Mes sin tasa → aviso visible; vista con las mismas columnas; dependencias MRD intactas. |

### Fase 5 — Otros syncs con el mismo patrón (plan aparte, con su propia aprobación)
Del informe del auditor, por gravedad: **ZONOS en `ddp-sync`** (alta: corta sin marcar y
reconstruye "sin match" con datos parciales; Dinamarca sin ningún match desde ~9-sep),
`unleashed-sales-sync` (parciales que reempiezan de cero), parcial = warn que nunca escala, `.range()`
sin orden, tipo de cambio de reserva 1,54 silencioso, `syncMetaBills` que vacía meses ante una
respuesta vacía. Más los cambios sistémicos del auditor (§6 del informe): cuadre declarado por cada
sync financiero, reglas nuevas en `CLAUDE.md`, lint antes de cada deploy, detección de cambios del
contador, aviso activo.

## 5. Criterio de efectividad (adoptado tal cual de la auditoría, fijado antes de ejecutar)

1. **Referencia:** `xero_pl_monthly` = P&L de Xero vía MCP, al centavo, en los 13 meses; medido el
   2-nov, el 1-dic y el 1-mar-2027.
2. **Meses cerrados** (jul, ago, sep; oct desde el 15-nov; nov desde el 15-dic): \|líneas − P&L\|
   ≤ A$1,00 por cuenta y mes, o el residuo = suma de asientos manuales listados (ID, fecha,
   monto). Ningún residuo sin documento.
3. **Historial CSV** jul-2025 a jun-2026 sigue en 0,00; mayo explicado o re-cargado.
4. **Línea a línea:** la muestra de P2, al centavo.
5. **Documentos:** presentes los 11 de la auditoría y 0 faltantes en la muestra mensual MCP.
6. **Pruebas negativas** de P1, P3, P3b y P5 hechas y pasadas antes de declarar terminado.
7. **En el tiempo:** 30 días con el cuadre de meses cerrados en verde, ninguna racha de 3
   `partial`, marca siempre < 26 h.
8. **Quién controla:** el vigilante (automático) y la verificación mensual de P7, hecha por otro.
9. **MRD intacto:** después de cada fase, dependencias iguales y `mrd_dashboard` con costo mensual = P&L.
10. **Falla:** cualquier mes cerrado fuera de A$1 sin documento, cualquier corrida parcial que no se
   recupere en 24 h, cualquiera de los 11 documentos ausente. En ese caso el arreglo falló, diga lo
   que diga el autor.

## 6. Decisiones que necesito de Mario

1. **Aprobar el plan** (fases 0-4 y 4b). La fase 5 va aparte.
2. **Permiso de asientos manuales en Xero:** hay que re-autorizar la conexión una vez (abrir un
   link y aceptar). Sin eso, los A$18.118 de fin de mes quedan sólo como "Unreconciled".
3. **Export "Account Transactions" de Xero, jul-oct-2026,** cuentas 425 y 465: una sola vez, para
   validar P4 contra una fuente que incluye todo.
4. **P6:** confirmar que By Channel muestre siempre la fila "Unreconciled" con el monto.
5. **Aviso por email** cuando algo se pone rojo (pendiente desde el 6-oct).

## 7. Límites

- La causa F (día 31) es una inferencia del auditor; se confirma o se descarta el 2-nov.
- La lista de 11 documentos sale de un muestreo por proveedor: puede haber más; el cuadre a A$1
  los obliga a aparecer.
- El orden por defecto de Xero y el `pageSize` se verifican en la doc oficial antes de P1.
