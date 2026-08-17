# Auditoría — la demanda de AIM 2026 no es demanda

> ## ✅ RESUELTO — 18-ago-2026
>
> Aplicado y verificado en producción (`d850c69` en `ui-redesign`, edge function
> `aim2026-calc-kpis-v2` desplegada, caché de KPIs recalculado).
>
> | PSD-HD-BR54 | Antes | Ahora |
> |---|---|---|
> | Demand | 5.828 | **1.200** |
> | Open (columna nueva) | — | **345** |
> | ROP | 15.107 | **2.633** |
> | Sug. Qty | **12.276** | **0** |
> | Cover | 29 d | **139 d** |
> | Estado | LOW STOCK | **OK** |
>
> Julio ahora reporta **788** y agosto **1.612** — 2.400 contra las 2.427 de
> Unleashed y las 2.357 de Shopify. El tab decía "comprá 12.276 unidades" de un
> producto con 139 días de cobertura.
>
> También aplicado: la orden fantasma SO-00020333 borrada (respaldo en
> `aim2026_demand_detail_bkp_so20333`), y la vista de control
> `aim2026_demand_sanity` (§10.4).
>
> **Sigue abierto**: el sync no propaga bajas (§8.1) y las filas se imputan por
> fecha de pedido, no de despacho (§9).

**Fecha:** 18-ago-2026 · **Estado inicial: auditado, nada modificado.**
**Disparador:** PSD-HD-BR54 vendió 2.357 unidades según Shopify y 2.427 según
Unleashed. AIM 2026 muestra **5.828** de demanda y un pico de **4.606 en julio**,
un mes en el que el producto se lanzó recién el día 23.

---

## 1. Veredicto

Las ventas están bien. **La demanda está mal.** No es un error de sincronización
ni de redondeo: es que el sistema llama "demanda" a algo que no lo es.

| Fuente | Unidades PSD-HD-BR54 |
|---|---|
| Shopify (B2C explorer) | 2.357 |
| Unleashed (Unit Sales Enquiry) | 2.427 |
| `aim2026_demand_history` (lo vendido) | **2.381** ✓ |
| **Lo que AIM muestra como demanda** | **5.828** ✗ |

Las tres primeras coinciden. La cuarta se construye con otra fórmula.

---

## 2. La fórmula

`aim2026-calc-kpis-v2/index.ts:587`:

```js
const base = m.quantity + m.componentUsage + m.placed + m.backordered;
return demandMode === "estimatedDemandParked" ? base + m.parked : base;
```

Demanda = vendido **+ órdenes colocadas y no despachadas** + backorders
(+ parked en modo estimado).

Julio de PSD-HD-BR54, desglosado:

| Componente | Unidades |
|---|---|
| Vendido y despachado (`Completed`) | 787 |
| Uso como componente | 1 |
| **Órdenes `Placed` sin despachar** | **3.701** |
| Backordered | 37 |
| Parked | 80 |
| **Total mostrado** | **4.606** |

El 80% de la "demanda" de julio nunca salió del depósito.

---

## 3. Qué son esas 3.701 unidades

Tres órdenes. Una sola explica casi todo:

| Orden | Cliente | Unidades | Depósito | Fecha |
|---|---|---|---|---|
| **SO-00020333** | **Dolo ENT** | **3.500** | China-W | 29-jul |
| SO-00020201 | Pesado Korea LTD | 200 | China-W | 6-jul |
| — | resto | 1 | | |

**`Dolo ENT` es la propia empresa.** Unleashed la muestra como
"DOLO ENT PTY LTD" en el encabezado. Una orden de venta de Dolo ENT a Dolo ENT
desde el depósito de China es **el contenedor que viaja de China a Australia**.
Es stock cambiando de estante, no un cliente comprando.

El sistema la lee como demanda futura, la suma al mes de julio, y con eso
calcula el punto de reposición y la cantidad sugerida a comprar.

---

## 4. La segunda capa: el histórico tampoco está limpio

Peor que lo anterior, porque no se ve.

| Cliente | Estado | Unidades | Desde |
|---|---|---|---|
| Pesado Korea LTD | **Completed** | **21.599** | ene-2025 |
| Pesado Korea LTD | Placed | 5.545 | may-2026 |
| Dolo ENT | Completed | 563 | abr-2025 |
| Dolo ENT | Placed | 5.280 | jul-2026 |

Las 21.599 unidades enviadas al nodo de Korea están marcadas `Completed`, así
que **ya entraron en `aim2026_demand_history`** — la tabla que arriba figura
como correcta. Están contadas como venta desde hace 19 meses.

Y cuando SO-00020333 se despache, sus 3.500 unidades pasarán de `Placed` a
`Completed` y contaminarán el histórico igual.

⚠️ **Korea es una decisión de negocio, no técnica.** Si el nodo de Korea no
reporta sus ventas a Unleashed (sólo 96 unidades salieron del depósito
"Pesado Korea"), entonces el envío a Korea es el único registro que existe de
esa demanda, y excluirlo la borraría. Hay que decidir qué representa. Dolo ENT,
en cambio, es inequívocamente interno.

---

## 5. Alcance

No es un SKU. Desde el 1-jun-2026:

| Medida | Valor |
|---|---|
| SKUs con pendientes sumados a su demanda | **160** |
| SKUs donde lo pendiente **supera** lo vendido | **62** |
| Unidades vendidas de verdad | 26.686 |
| Unidades pendientes sumadas como demanda | **12.502** |
| De esas, movimientos internos | **7.224** |

Los más deformados:

| SKU | Vendido | Sumado sin vender | % inventado |
|---|---|---|---|
| 58Puckprotector-kit | 36 | 554 | **94%** |
| EP-18g | 304 | 741 | 71% |
| PSD-HD-LM | 277 | 657 | 70% |
| EP-20g | 316 | 719 | 69% |
| PSD-HD-BR54 | 2.381 | 4.040 | 63% |

---

## 6. Por qué importa: se compra con estos números

Para PSD-HD-BR54 el tab muestra hoy **ROP 15.107** y **Sug. Qty 12.276**, con
`LOW STOCK` y 29 días de cobertura. Esos tres valores salen de la demanda
inflada. Con la demanda real (~1.600/mes contra los ~2.900/mes que asume), la
cantidad sugerida sale cerca del doble de lo que corresponde.

Es el peor lugar donde puede estar un error: el número que se usa para decidir
cuánto dinero poner en un contenedor.

---

## 7. Por qué no se detectó antes

Tres puntos, sin adorno:

1. **La fórmula viene del commit inicial** (`f9aa3b3`, 5-mar-2026). No se
   introdujo en las sesiones recientes.
2. **La auditoría del 28-jul revisó el tab y levantó 26 hallazgos, y este no
   estaba.** Se revisó que `null`, `0` y `999` no se confundieran, y se
   corrigió eso. No se revisó qué significaba cada estado de orden. Ese es el
   fallo: se auditó la aritmética, no la semántica.
3. **La corrección del sync del 28-jul se validó contra el total de ventas de
   Unleashed y cerró al 100%.** La validación era correcta y por eso no
   levantó nada: el error no está en el sync, está en lo que se suma después.
   Se dio por bueno el resto del recorrido porque una parte cerraba.

El patrón: se validó cada pieza contra su propia fuente y ninguna contra la
pregunta de negocio — *¿este número puede usarse para comprar?* Un producto
lanzado el 23 de julio con 4.606 unidades de demanda en julio se detecta
mirando la pantalla, no corriendo una consulta.

---

## 8. Correcciones tras la revisión de Mario (18-ago)

Dos cosas que este documento decía mal:

1. **Korea es un cliente, no un movimiento interno.** Decisión ya tomada y
   repetida: vender a Pesado Korea es vender mercadería. Las 21.599 unidades
   de §4 **no son contaminación**. Se retira ese punto.
2. **Dolo ENT fue un error puntual, no un patrón.** Daniel cargó SO-00020333
   como ejemplo para evaluar un 3PL a EE.UU. y la orden quedó viva. Ya la
   borró en Unleashed.

Con eso, el problema deja de ser *quién compra* y queda uno solo: **se mezcla
lo que ya salió del depósito con lo que todavía no salió.**

Sin Dolo ENT, desde el 1-jun-2026:

| | Unidades |
|---|---|
| Despachado | 26.593 |
| Sumado a la demanda sin despacharse | **11.908** |
| Inflado | **31%** |

Que Korea sea cliente legítimo no cambia nada acá: una orden suya en `Placed`
sigue siendo una orden **no despachada**, y sumarla al mes de la fecha de
pedido sigue estando mal.

### 8.1 Hallazgo nuevo: el sync no propaga las bajas

Verificado el 17-ago con el sync ya terminado (paso "Unleashed sales" en `ok`,
1.174 filas): **SO-00020333 sigue entera en la base** — 10 líneas, 5.280
unidades, `created_at` del 6-ago sin tocar.

`syncSalesOrders` pide a Unleashed las órdenes modificadas, borra las líneas de
**esas** órdenes por `order_guid` y las reescribe. Una orden eliminada no viene
en el feed, así que sus líneas no se borran nunca.

Es el costo del arreglo del 28-jul: se dejó de borrar por ventana de fechas
—que era lo que destruía demanda— y con eso se perdió la capacidad de reflejar
una baja. **No se documentó como riesgo en su momento.** Aplica a cualquier
orden que se borre en Unleashed de ahora en más.

### 8.2 `allocated` no sirve como atajo

Se verificó si el stock reservado ya representa lo pendiente. No:

| Depósito | Stock | Allocated | Pendiente en demand_detail |
|---|---|---|---|
| Main Warehouse | 5.572 | 65 | 108 |
| China-W | 3.983 | 387 | 3.932 |

Unleashed sólo reserva lo que existe físicamente. Las 3.500 de SO-00020333
nunca llegaron a `allocated`. **Los dos números no se solapan de forma
predecible**, así que ninguna fórmula puede combinarlos a ciegas.

---

## 9. La solución propuesta

Una sola regla:

> **Demanda = lo que salió del depósito. Nada más.**

Todo lo derivado —ROP, cobertura, turnover, GMROI, cantidad sugerida— se
calcula sobre eso y sólo eso.

Lo pendiente **no desaparece**: pasa a una columna propia, al lado, que no se
promedia ni se proyecta ni se multiplica por el lead time. Es un dato para
mirar al armar la compra, no un ingrediente del cálculo.

| Hoy | Propuesto |
|---|---|
| `Demand` = despachado + colocado + backorder (+ parked) | `Demand` = despachado |
| — | `Open` = colocado + backorder, columna aparte |
| Parked adentro en modo estimado | Parked afuera (es una cotización) |

**Efecto en PSD-HD-BR54**: la demanda pasa de **5.828 a 2.381** (−59%), que es
lo que dicen Unleashed y Shopify. ROP y cantidad sugerida bajan en proporción
parecida, y el stock de seguridad baja además por su cuenta, porque desaparece
el pico de 3.500 que disparaba la desviación.

### Por qué esta y no otra

- **Un número, un significado.** Si el tab dice 787 en julio, cierra con
  Unleashed y con Shopify. Hoy no cierra con nada y por eso no se le puede
  creer.
- **Un mes cerrado deja de cambiar.** Hoy julio se mueve cada vez que una
  orden vieja cambia de estado.
- **Una orden grande deja de deformar el promedio.** Un pedido de 3.500
  unidades es un evento, no un ritmo mensual.
- **No hace falta marcar clientes internos.** Korea queda adentro por ser
  cliente; Dolo ENT queda afuera solo, porque su orden nunca se despachó.
- **Hace innecesario el parche urgente**: la orden fantasma de Daniel deja de
  afectar la demanda sin que nadie la toque. Conviene borrarla igual —sigue
  apareciendo en Open y en el stock reservado— pero deja de ser una urgencia.

### Lo que esta solución NO resuelve (y hay que decirlo)

**La fecha sigue siendo la del pedido, no la del despacho.** `demand_detail`
guarda `order_date`; Unleashed tiene `CompletedDate` y no se está trayendo. Un
pedido B2B colocado en julio y despachado en agosto se va a seguir imputando a
julio.

En B2C da casi igual (se despacha el mismo día). En B2B puede correr semanas.
Es una mejora de segundo orden: requiere agregar la columna al sync y
recargar. **Se puede hacer después, y conviene hacerlo, pero no bloquea lo
anterior.**

---

## 10. Plan de aplicación

1. **Cambiar la fórmula** (`aim2026-calc-kpis-v2/index.ts:587`) a sólo
   despachado, y exponer los pendientes por separado.
2. **Columna `Open` en la tabla** y en el modal de demanda, separada de la
   barra de consumo.
3. **Borrar la orden fantasma** SO-00020333 (10 líneas), ya eliminada en
   Unleashed.
4. **Una prueba automática que no se pueda saltear:** para cada SKU, la
   demanda de un mes cerrado no puede superar las unidades despachadas según
   Unleashed. Un producto lanzado a mitad de mes tiene que poder desmentirse
   solo.
5. **Después, cuando haya aire:** traer `CompletedDate` y bucketear por fecha
   de despacho.

**Verificación obligatoria antes de dar nada por bueno:** PSD-HD-BR54 tiene que
mostrar **787 en julio y 1.594 en agosto**, el gráfico no puede tener barra
antes del 23-jul, y el total del rango tiene que dar **2.381** contra las 2.427
de Unleashed y las 2.357 de Shopify.

---

## 9. Severidad

**Alta, y es la más alta de las abiertas.** Por encima de los timeouts.

- No hay pérdida ni corrupción de datos: el detalle está entero y trazable, con
  cliente, orden, estado y depósito en cada fila. Todo es reconstruible.
- No afecta las ventas ni Shopify ni la contabilidad.
- **Sí afecta toda decisión de compra tomada mirando este tab**, y afecta a 160
  SKUs, con 62 en los que el número mostrado es mayoritariamente inventado.
- Lleva así desde marzo de 2026 como mínimo. Los envíos a Korea contaminan el
  histórico desde enero de 2025.

**Hasta que se arregle: no usar Demand, ROP, Cover ni Sug. Qty del tab AIM 2026
para decidir una compra.** Las columnas de stock (SOH, Container, Available) no
están afectadas.
