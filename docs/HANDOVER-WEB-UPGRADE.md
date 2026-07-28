# Handover — Web Upgrade performance

> Cubre **solo el panel Web Upgrade**. El estado general del proyecto y el trabajo del
> 2026-07-28 (incidente de demanda, sync incremental, filtros de AIM 2026, B2C Sales Explorer)
> están en [`HANDOVER.md`](HANDOVER.md).
>
> Sesión de este panel: **2026-07-27** · Estado: **deployado y verificado**
> Leer también: `README.md` (sección "Web Upgrade performance") y la memoria `web-upgrade-tracking`.
>
> **Cambio posterior**: la tabla de productos ahora abre un popup con las ventas de Shopify del
> SKU clickeado (`SkuSalesDialog`, mismo panel que el B2C Sales Explorer).

## 1. Dónde está todo ahora

| Cosa | Estado |
|---|---|
| Rama de trabajo | `feat/unleashed-sales-api` (HEAD `25973db`) |
| Producción | merge a `ui-redesign` → Vercel. Último deploy `07eb790` — **READY** |
| RPC `web_upgrade_performance` | parcheada en vivo; migraciones espejo `20260727010000` y `20260728000000` commiteadas |
| Working tree | limpio salvo `tsconfig.app.tsbuildinfo` (ruido, ignorar) y la carpeta `WEB UPGRADE TAB/` sin trackear (handoffs de diseño, no commitear) |

Panel: modal **Web Upgrade** en el dashboard → cuatro vistas en el dropdown.

## 2. Qué se hizo en esta sesión (en orden)

| Commit | Qué |
|---|---|
| `5b0c5d8` | RPC: `storeShare.upgradeOrderRevenue` + `trend[]` con `attributedRevenue`/`storeRevenue` por día |
| `4c2d548` | Rediseño v2: sistema de vistas Daily brief / Modules / Products (+ Module blocks legacy) y modal de contexto de tienda |
| `7441400` | v2.1 del handoff: rail derecho en Daily brief, sparkline con hover por día, tooltips `data-def`, regla de delta por promedio, modal reestructurado |
| `08dc107` `3dd92b2` | Definiciones de columnas de Products (ventana de baseline con ejemplo de SKU; Attributed vs u/wk now) |
| `f1d0090` | Los números derivados cierran contra los redondeos mostrados |
| `423baa0` | **Contrafactual contra el AOV pre-launch** (nuevo campo `storeShare.preLaunchAov`) en vez de contra los compradores sin módulo de hoy |
| `7680a41` | Share de órdenes de tienda dentro de la barra de Orders + denominador en los KPI |
| `e8b20d1` | Sacado el conteo de eventos del KPI Exposed sessions |
| `25973db` | README documenta el panel |

## 3. Cómo retomar

```bash
cd "C:/PROYECTS/AIM 2026" && git checkout feat/unleashed-sales-api && git pull
```

**Flujo de verificación visual** (obligatorio antes de commitear UI): crear un harness descartable `src/xdev.tsx` + `xdev.html` que renderice `<WebUpgradeTab />` sin props, levantar el dev server (`preview_start` con `aim2026-dev`), navegar a `/xdev.html`, chequear el DOM con `javascript_tool` — los screenshots del pane y los hovers sintéticos sobre tooltips de Radix **no** funcionan, hay que leer el DOM. **Borrar el harness antes de commitear.**

**Deploy**: `npm run build` → commit en la rama de trabajo → `git checkout ui-redesign` → `git merge --no-ff` → `git push` → confirmar en Vercel (calcular `Date.now()` antes de usarlo como `since`, o la consulta devuelve 0 engañosamente).

**Parches a la RPC**: nunca `CREATE OR REPLACE` a mano. Se usa `DO $do$ ... pg_get_functiondef ... replace(...) ... execute $do$` con guardas que levantan excepción si el anchor no matchea, y se espeja el mismo bloque en un archivo de `supabase/migrations/`.

## 4. Reglas que no se pueden romper

1. **Nunca regenerar `web_upgrade_baseline`.** Es la foto congelada pre-launch (capturada 22/07 con datos hasta 21/07). Si se pierde, se pierde toda comparación before/after.
2. **La regla de delta de Products es deliberada.** El filtro define la población y el delta de familia es el **promedio** de los porcentajes de sus variantes visibles, no el ratio de sumas. Está así por pedido del handoff de diseño y documentada en el tooltip de la columna. Un revisor va a querer "corregirla" — no.
3. **Todo número derivado se calcula desde los valores mostrados**, no desde los crudos: si en pantalla dice "$104 × 388 órdenes", la cuenta tiene que dar el resultado que se muestra.
4. **Los nombres de `action`/`source` de los eventos y las propiedades `_pesado_*` son contrato con el theme.** Renombrarlos rompe la clasificación por módulo.
5. **Proponer antes de actuar.** Diagnóstico + propuesta, esperar el OK de Mario, y recién ahí implementar-verificar-deployar de corrido.

## 5. Números medidos (ventana 23–28/07/2026)

Para no volver a consultarlos:

- Tienda: ~55% de las órdenes tocan un módulo, ~50% del revenue neto es atribuible.
- **AOV de la tienda antes del launch: $104.01** (29/04 → 21/07, 14,754 órdenes, 1.40 items/orden). Órdenes con módulo hoy: $106.51 y 1.39 items. Sin módulo hoy: $103.41 y 1.22 items.
- Efecto honesto sobre el ticket: **+$973** en la ventana (~$2.51/orden, +3% de AOV).
- **Los items por orden están planos contra pre-launch** (1.39 vs 1.40). El "+14% items" que muestra la tarjeta es contra el grupo sin módulo de hoy, que es un grupo empobrecido por composición (los compradores de varios ítems se auto-seleccionan hacia los módulos).
- Por módulo: Compatibility Guide $4.68/sesión con 5% del tráfico (la mejor por visitante, la peor alimentada); Machine finder 98% del tráfico y 75% del revenue con AOV plano; Compatible Additions rinde 3× mejor en carrito que en PDP; el close de la Guide (22%) está por debajo del rango normal 25–35%.

## 6. Pendientes / decisiones abiertas

1. **Exposed sessions no tiene denominador**: no existe ningún dato de sesiones del sitio en la base (verificado). Para poner "X/total" habría que sincronizar sesiones desde Shopify Analytics — trabajo nuevo de backend, no un ajuste. Sin decisión de Mario.
2. **`PESADO_PROJECT_CONTEXT.md`** (repo de Codex, `C:\PROYECTS\PESADO NEW WEBSITE`) describe el panel en su versión anterior en la §8.1. Sin decidir si lo actualizamos nosotros o lo maneja Codex.
3. **EcommerceTab tiene el date-picker viejo con el bug** que ya se arregló acá (la fecha de inicio no se puede clickear). Chip pendiente `task_da3241e3`.
4. **Ventana del baseline del contrafactual**: se usó la de 84 días para ser consistente con Products. Con los 30 días previos el AOV era $105.22 y el "extra" daría negativo. Mario no eligió explícitamente.
5. Ideas de marketing que salieron del análisis y no están implementadas: llevar tráfico a la Compatibility Guide (menú/PDP), campaña Meta a dueños de Breville, y meter una adición al confirmar el fitment en el Machine finder para levantarle el AOV.
