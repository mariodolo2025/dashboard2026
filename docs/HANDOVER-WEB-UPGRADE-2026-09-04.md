# Handover — Web Upgrade tab (2026-09-04)

Para la ventana nueva: leer esto + la memoria persistente (`web-upgrade-tracking`,
`aim2026-db-limits`) antes de tocar nada.

## Qué es
`src/components/WebUpgradeTab.tsx` — panel v2.1 que mide el rediseño web
(lanzado **23-jul-2026**, theme app = chinatest). Vistas: **Daily brief /
Modules / Products / Blocks (legacy)**. Los reward tiers (free shipping $100 /
10% off $200 / 15% off $300, carts → bought) viven en **Products** y en Blocks.

## Arquitectura de datos
- `upgrade_events` (eventos crudos del theme) → rollups incrementales.
- El tab llama al RPC `web_upgrade_performance(p_from, p_to, environment)` que
  **lee `web_upgrade_perf_cache`** (cache por combo from/to/env). El cómputo
  real es `web_upgrade_performance_live(...)` (lento: 5-113 s según ventana).
- Cache older than **24 h = miss** (el reader lo rechaza).
- Eventos en **día UTC**; ventas en día Brisbane. Decidido: NO unificar.
- Universos: `production` vs `all`. Baseline pre-launch **congelado**.

## Infra montada en la ventana anterior (sep 2026)
- **Tick de refresco**: `web_upgrade_perf_cache_refresh_tick()` — pg_cron job 12,
  cada 10 min, UN combo stale por tick, advisory lock `wu_cache_refresh`.
  Staleness escalonada: combos livianos 6 h; el pesado (launch→today, ~54 s de
  cómputo) 24 h (migración `20260903070000_wu_tick_tiered_staleness.sql`).
- **Timeout de usuario**: rol `authenticated` = 15 s (antes 8). `anon` sigue 3 s.
- **Retention/archivado**: edge fn `wu-events-archive` modo auto `{auto:true}`,
  máquina `wu_archive_state` (idle→export 5 páginas a Storage bucket
  `wu-archive`→purge con `p_max_id` = cursor exportado). pg_cron job 14, hourly.
- **Invariante crítico**: `wu_events_purge_batch` setea
  `app.web_upgrade_rollup_skip='1'` antes de borrar. Un DELETE pelado sobre
  `upgrade_events` DESCUENTA los rollups. Nunca borrar sin ese flag.
- bar_view fix vivo desde 12-ago (no es pendiente).

## Pendientes conocidos
1. Verificar que el ciclo de archivado avanza (job 14: export/purge alternando;
   mirar `wu_archive_state` y el bucket).
2. `session_id` vs `attribution_id` — cambio de contrato del theme, coordinar
   con Codex antes de tocar.
3. Partitioning / índices de `upgrade_events` (review Codex, sin urgencia).
4. Portada aggregate endpoint — despriorizado.

## Gotchas operativos
- Base de 1 GB: los cómputos pesados saturan; consultas de usuario tienen 15 s.
- MCP execute_sql: timeout default ~8 s — prefijar
  `set statement_timeout to 'X';` en el mismo request para queries largas.
- Deploy: Vercel prod = rama **ui-redesign**; edge functions se deployan a mano
  (`npm run sb`). El checkout principal está en `feat/advertising-tab`
  (lo usa la ventana de Advertising) — para tocar UI del Web Upgrade, crear
  worktree propio o coordinar rama primero.
- Dev servers ocupados: 5173 (ventana Advertising, checkout principal), 5174
  (worktree `eager-williams-959b54`, launch config `aim2026-worktree`).
- Regla dura de UI: todo KPI/columna con `title=` (fuente, ventana, universo,
  moneda) antes de dar por terminada una pantalla.

## Compatibility P2 (agregado 2026-09-05)

La guía de compatibilidad se reemplazó por **P2** el 4-sep-2026. Se mide aparte de V3.
Spec de origen: `C:\PROYECTS\PESADO NEW WEBSITE\docs\COMPATIBILITY_P2_ANALYTICS_DASHBOARD_HANDOVER.md`.

- **Identidad**: evento P2 ⇔ `payload.context = 'compatibility_p2'`. Línea P2 ⇔
  `pesado_source = compatibility_guide` ∧ `pesado_parent_product = compatibility-guide-p2`
  (context null tolerado sólo ahí, reportado en `dataQuality`).
- **Fechas fijas**: órdenes desde 4-sep; visitas (`flow_id`) desde 5-sep 08:18 AEST
  (`2026-09-04T22:18:09Z`). Ratios por visita usan órdenes con `order_date >= 2026-09-05`.
- **Migración** `20260905090000_compatibility_p2_analytics.sql` (aplicada por MCP):
  tabla `web_upgrade_p2_events` (trigger `upgrade_events_p2_trg`, AFTER INSERT/UPDATE,
  exception-safe, sin DELETE → sobrevive la purga), columnas
  `upgrade_order_attribution.pesado_flow_id/pesado_context`, RPC
  `web_upgrade_p2_performance(p_from, p_to, p_environment)`.
- **Sync**: `shopify-sales-sync` extrae `_pesado_flow_id` y `_pesado_context`
  (deployado 5-sep). Backfill 4–5 sep vía `net.http_post` con el token del cron.
- **Tab**: `View: Compatibility guide` (vista `compat`). En Modules/Daily brief la
  entrada "Compatibility Guide" del RPC principal se reemplaza por `p2.module` cuando la
  ventana llega al 4-sep; sin RPC P2 → la Guía sale del ranking y se avisa
  "P2 Analytics not deployed". V3 sólo en Module blocks (legacy), sin link.
- **Verificado**: orden `7394064335155` con el mismo `flow_id` en eventos, línea y RPC.
- **Pixel**: el Custom Pixel `Pesado Upgrade Analytics` de Shopify arma la lista de
  campos del payload (41 desde el 5-sep). Si un campo nuevo del theme no llega a
  `upgrade_events.payload`, mirar ahí primero — la ingesta no filtra nada.
- **Pendiente**: `MODULE_IMG['Compatibility Guide']` (`/wu/guide.jpg`) sigue siendo la
  captura de V3. El diff P1 sin commitear lee `upgrade_events` crudo (14 días): le cabe
  el mismo patrón de tabla propia.
