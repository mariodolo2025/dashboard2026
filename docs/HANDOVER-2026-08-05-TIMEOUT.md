# Handover — 2026-08-05 · el timeout del dashboard

> **Estado: diagnosticado, nada tocado.** Mario pidió análisis sin cambios.
> Nada de lo de abajo está aplicado. Ninguna migración, ningún deploy.
> Contexto de la sesión anterior: [`HANDOVER-2026-08-04.md`](HANDOVER-2026-08-04.md).

---

## ⚡ Addendum 2026-08-17 — reapareció, segunda auditoría, fix aplicado

El 7-ago otra sesión reescribió `web_upgrade_performance` sobre rollups diarios
(30 días: 10-47 s → ~1 s). El 17-ago a las ~06:15 de Brisbane el error volvió.
La segunda auditoría cerró la causa con evidencia distinta a la del 5-ago:

- **La RPC está sana**: 0,57 s caliente / 4,8 s fría con la base ociosa.
- **El choque es de calendario**: el cron de kickoff (`0 3,10,20` UTC) largaba
  una corrida a las **06:00 de Brisbane** que terminó 20:00:01→20:22:07 UTC —
  exactamente cuando Mario abre el dashboard. Pasos pesados de esa corrida:
  Unleashed sales 99,5 s, assemblies 71 s, Meta creatives 61 s.
- **La base se duplicó en 12 días**: 632 MB → **1.151 MB** contra 224 MB de
  caché. Eventos ~15-18k/día (la barra sigue emitiendo por página: 4-5,6k/día);
  tablas de atribución del agente de Advertising +70 MB;
  `web_upgrade_sessions_daily` 141 MB.

**Aplicado** (migración `20260816202800_dashboard_rpc_timeout_50s`):

1. Kickoff movido de 20:00 UTC → **18:00 UTC (04:00 Brisbane)**: la corrida
   termina ~04:25, antes de que se abra el dashboard. Las de 03:00 y 10:00 UTC
   (13:00 y 20:00 Brisbane) quedan igual.
2. `statement_timeout` de ambas RPC: 25 s → **50 s**. Un choque residual pasa a
   ser una carga lenta, no un error.

**Sigue abierto y sigue siendo la decisión de fondo** (§7 abajo, con los datos
del 5-ago que ya apuntaban acá): purgar/archivar `upgrade_events` cruda
(429 MB que nadie lee), el tamaño de la instancia, y el theme emitiendo la
vista de la barra por página en vez de por sesión.

Lo que sigue es el diagnóstico original del 5-ago, sin editar.

---

## 1. El síntoma

`canceling statement due to statement timeout` (Postgres 57014), intermitente,
durante el 5-ago. A veces la pantalla carga, a veces no. Sin patrón obvio para
el usuario.

---

## 2. Quién falla y por qué es intermitente

Dos RPC, las dos con techo propio de **25 s** (`SET statement_timeout TO '25s'`
en la definición de la función, que le gana a los 8 s del rol `authenticated`):

| RPC | Promedio | Máximo registrado | Techo |
|---|---|---|---|
| `ecommerce_dashboard` | 1,9 s | **23,3 s** | 25 s |
| `web_upgrade_performance` | 3,7–4,7 s | **22,1 s** | 25 s |

El máximo está a un pelo del techo. Por eso falla a veces: la misma consulta,
con los mismos parámetros, tarda entre 2 y 23 segundos según lo que más esté
pasando en la instancia en ese momento.

`shopify_sku_stats_multi` **no** tiene techo propio, así que muere a los 8 s del
rol — pero hoy corre en 774 ms de promedio y 2,8 s de máximo. No es el problema
(fue el problema el 31-jul y se arregló; ver handover anterior, §5).

---

## 3. La causa: el volumen de eventos se duplicó

Medido hoy contra lo que dejamos ayer:

| Consulta | 4-ago | 5-ago |
|---|---|---|
| Web Upgrade · 7 días | 1,1 s | **3,9 s** |
| Web Upgrade · 30 días | 4,3 s | **9,4 s** |
| E-commerce · año fiscal | ~1,6 s | 3,0 s |

Se duplicó en 24 horas porque se duplicó la tabla:

| Período | Eventos/día |
|---|---|
| 24–29 jul | ~11.500 |
| 30 jul – 4 ago | ~21.000 |
| 4-ago | **25.796** |

`upgrade_events` pasó de 157.994 filas (151 MB) a **213.166 filas (205 MB)**.
El espejo `upgrade_events_slim`, de 41 MB a **78 MB**.

**El salto arranca el 30 de julio**, el mismo día del cambio de theme. Los dos
eventos nuevos de la barra de compatibilidad explican casi todo:

| Evento | 4-ago |
|---|---|
| `compatibility_bar_view` | 9.028 |
| `compatibility_button_view` | 3.454 |
| Todo lo demás | 13.314 |

Desde el 30-jul, **74.360 de 173.576 eventos (42,8%)** son esos dos. Se emiten en
cada página del sitio, y son vistas, no clicks: 9.028 vistas de barra contra 144
clicks.

Ojo con la lectura fácil: el resto del sitio **también** creció (`machine_finder_view`
pasó de ~5.300 a 6.031/día). O sea, sacar la barra baja el volumen ~43%, no lo
devuelve al nivel del 29-jul.

---

## 4. Por qué el mismo query varía 10×

La instancia es chica:

| Parámetro | Valor |
|---|---|
| `shared_buffers` | 224 MB |
| `work_mem` | 2,1 MB |
| `max_parallel_workers_per_gather` | 1 |
| Tamaño de la base | 632 MB |

El orquestador corre 3× por día y tarda ~20 minutos (`sync_runs`). Durante esa
ventana escribe en masa mientras el dashboard lee, y compiten por el mismo disco.
Ahí es cuando 2 s se convierten en 23 s.

Dato relevante para no repetir un intento fallido: **el 4-ago se probó subir
`work_mem` a 48 MB y empeoró** (22–26 s). Y agregar un índice sargable sobre el
timestamp también empeoró (8,1 s → 13,4 s) porque perdió el scan paralelo. Ambos
revertidos. No volver por ese camino sin medir.

---

## 5. Carga que se agregó ayer y no debería estar

En `ecommerce_dashboard`, el bloque `adsCoverage`:

```sql
'adsCoverage', (select jsonb_build_object(
    'from', min(x.date), 'to', max(x.date),
    'daysInRange', count(distinct x.date) filter (where x.date between p_from and p_to))
  from ecommerce_meta_daily_ads x),
```

Sin filtro de fecha: escanea las 35.644 filas completas en cada llamada. El
`min(g.first_ever)` del bloque `ads` hace un segundo recorrido completo (fue
deliberado — calcularlo dentro del rango marcaba todos los avisos como nuevos).
Es carga fija, no crece con el rango, pero está de más.

---

## 6. Esto empeora solo

Al ritmo actual (~25k eventos/día) y con los datos arrancando el 23-jul, hoy un
rango de "30 días" ya es **toda la tabla**. En 4 a 6 semanas un rango de 30 días
va a cruzar los 25 s sin necesidad de que el sync esté corriendo.

---

## 7. Opciones, con lo que cuesta cada una

Ninguna está aplicada. Ordenadas por relación impacto/riesgo, **no** por
facilidad.

### A. Una vista por sesión en vez de una por página (theme)

La barra emite una vista cada vez que se renderiza, o sea en cada página. Emitir
una por sesión baja ~43% del volumen **y arregla la métrica**: el CTR "por sesión
expuesta" es lo que se quiere saber, no "por página cargada". Hoy el 1,24% de CTR
móvil está inflado a la baja porque el denominador cuenta la misma sesión muchas
veces.

Requiere Codex (es theme). Es la única opción que mejora el dato en vez de sólo
achicarlo.

⚠️ **Rompe la comparabilidad con lo medido entre el 30-jul y hoy.** Si se aplica,
el CTR de la barra antes y después no se compara sin recalcular.

### B. Sacar el escaneo completo de `adsCoverage`

Barato, sin riesgo, sin pérdida. Recorta carga fija de `ecommerce_dashboard`.
No mueve la aguja del Web Upgrade.

### C. Retención sobre `upgrade_events`

La tabla cruda pesa 205 MB y **en operación normal no la lee nadie**: el panel
lee el espejo `upgrade_events_slim`. Verificado — la única función que la toca es
`upgrade_events_slim_reconcile()`, y la única que escribe es la edge
`upgrade-events-ingest`.

Purgar o archivar filas viejas baja el peso de la base, el trabajo de autovacuum
y el backup.

⚠️ **Tiene un costo real**: el slim espeja 7 claves del payload. Lo que se purgue
deja de poder alimentar una métrica nueva sobre datos históricos. Es una decisión
de Mario, no técnica. Alternativa sin pérdida: vaciar sólo la columna `payload` de
las filas viejas, o moverlas a una tabla de archivo.

⚠️ El beneficio sobre el timeout probablemente sea **menor** de lo que parece: si
nadie lee esa tabla, sus páginas ya no ocupan caché. No esperar que esto sólo
resuelva el problema.

### D. Subir la instancia

Resuelve todo hoy y no arregla nada de fondo. Cuesta plata por mes. Vale como
compra de tiempo si A y B no alcanzan.

### ❌ Lo que NO hay que hacer

**Matar `compatibility_bar_view`.** Es lo primero que se le ocurre a cualquiera y
es un error: destruye la medición del CTR de la barra móvil, que es justo el
hallazgo pendiente #3 del handover anterior (1,24% móvil vs 3,24% desktop) y una
de las restricciones centrales del brief de la campaña de Meta
([`HANDOVER-META-COMPATIBILITY-CAMPAIGN.md`](HANDOVER-META-COMPATIBILITY-CAMPAIGN.md),
§3). La opción A logra la misma reducción sin perder la métrica.

---

## 8. Lo que falta medir antes de decidir

El diagnóstico de **por qué** creció está cerrado con evidencia. **Cuál palanca
conviene, no.** Antes de tocar nada:

1. Dónde se van los 9,4 s de `web_upgrade_performance` a 30 días — `EXPLAIN
   (ANALYZE, BUFFERS)` sobre el cuerpo, no sobre la llamada. Sospecha principal:
   los `count(distinct)` de sesiones haciendo spill a disco con 2,1 MB de
   `work_mem`. Sin confirmarlo, subir work_mem es adivinar (y ya falló una vez).
2. Si el pico de 23 s coincide con las ventanas del orquestador (03:00 / 10:00 /
   20:00 UTC). Se cruza `sync_runs.started_at` contra cuándo Mario ve el error.
3. Cuánto de los 9,4 s es el rango y cuánto es carga fija de la RPC.

---

## 9. Cómo reproducir el diagnóstico

```sql
-- las RPC más lentas, con su varianza
select round(mean_exec_time) prom, round(max_exec_time) max, calls,
       coalesce((regexp_match(query,'public\."?([a-z0-9_]+)"?\s*\('))[1],'?') fn
from pg_stat_statements
where query like '%pgrst%' and mean_exec_time > 500
order by max_exec_time desc limit 10;

-- volumen diario de eventos
select d, count(*) from upgrade_events_slim
where d >= current_date - 12 group by 1 order by 1 desc;

-- qué evento creció
select action,
       count(*) filter (where d = current_date - 1) ayer,
       round(count(*) filter (where d between current_date-8 and current_date-2)/7.0) prom_previo
from upgrade_events_slim where d >= current_date - 8
group by 1 order by ayer desc limit 16;

-- tiempo real de la RPC hoy
explain (analyze, timing off, costs off)
select web_upgrade_performance(current_date-30, current_date, 'production');
```

---

## 10. Corrección al reporte del chat

Al reportar esto por chat sugerí como primer paso "cortar el evento de vista de
la barra". **Está mal** y quedó corregido en §7: eso destruye el CTR de la barra
móvil. La versión correcta es la opción A — una vista por sesión, no por página.
