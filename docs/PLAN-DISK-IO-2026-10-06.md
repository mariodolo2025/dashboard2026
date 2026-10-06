# Plan definitivo — Web Upgrade y la base del dashboard (6-oct-2026)

## Estado — 6-oct-2026, ejecutado (Mario: "continúa con las soluciones")

| Paso | Estado | Prueba |
|---|---|---|
| C. Vigilante | En marcha desde 6-oct 04:16 UTC (commit b1f4b6b) | 9/9 respuestas del motor del sync resueltas OK; marcó en rojo 3 fallas reales (Xero perdido por la caída, dolo draft, eventos > 16 días) |
| B. Archivado | Ciclo nuevo exportando (60 páginas de 1.000 filas por hora) | 134.568 filas exportadas en 2 corridas; página vacía 0,15 ms (antes: tabla entera hasta el corte) |
| A. Visitas en enteros | En uso por el panel (commit 8004244) | 1.499.678 filas iguales en 1.399 grupos; salida JSON idéntica en 7 ventanas; desde lanzamiento 3,18 s de base (antes > 120 s); 3,06-3,37 s con un sync corriendo |
| A.7 Caché y su job | Borrados | `web_upgrade_perf_cache`, su función y el job ya no existen |
| D. Small | Hecho por Mario | `shared_buffers` 512 MB |

Pendiente: OK de Mario para cortar la doble escritura y borrar `web_upgrade_sessions_daily`
(623 MB, mismo contenido que la tabla nueva). Observación de 14 días.

---

Plan original (6-oct, antes de ejecutar). Todo lo de abajo se midió con lecturas livianas
(catálogo, historial de cron, logs de Supabase) y **una** consulta de prueba de 30 días.

---

## 1. Por qué vuelve siempre

Cinco arreglos al mismo problema, y en cada uno dije que no volvía:

| Fecha | Qué se hizo | Por qué no alcanzó |
|---|---|---|
| 3-ago | Tabla "slim" para no leer 151 MB por apertura | Movió la lectura, no la achicó |
| 7-ago | Resúmenes diarios: 30 días de 10-47 s a ~1 s | Los conteos de **visitantes únicos** siguieron leyendo la tabla grande de sesiones |
| 17-ago | Caché + mover el sync de horario | Pasó el costo a un proceso de fondo que nadie miraba |
| 31-ago | Caché "una ventana por corrida" + archivado automático | El archivado se trabó **ese mismo día** y nadie se enteró |
| 3-sep | Ventanas pesadas una vez por día | Las ventanas siguieron creciendo un día por día |

En ninguno se arregló la causa. Quedaron cuatro problemas estructurales:

1. **Un cálculo que cuesta más cada día.** Contar visitantes únicos "desde el lanzamiento"
   lee todas las sesiones desde el 23-jul. Medido hoy, un solo conteo de 30 días tarda
   **12,4 s en frío y 4,3 s en caliente**, y el panel hace ~10 de esos. De las 224.909 filas
   leídas, **175.127 obligaron a ir a la tabla además del índice**, porque la limpieza
   automática de Postgres no llega a marcar las filas nuevas. Cada fila guarda además el id
   del visitante como texto de 36 caracteres y el nombre del módulo como texto de hasta 45.
2. **Procesos de fondo que fallan en silencio y reintentan sin freno.** El caché reintentó
   la misma ventana 127 veces el 5-oct. El archivado devuelve error cada hora desde el 31-ago
   y el cron dice "Succeeded" porque solo dispara el pedido.
3. **Ninguna alarma.** 20 h de caída y 5 semanas de archivado roto, sin aviso.
4. **Base chica.** Era Nano (0,5 GB). Ahora es Micro (1 GB). Pesa 3,46 GB, y Web Upgrade
   ocupa 2,77 GB de eso.

**Solución definitiva = sacar las cuatro causas, no otro parche.**

---

## 2. Plan

### Paso A — Que el cálculo sea barato de raíz, y borrar el caché

1. **Visitantes como número, módulos como código.** Tabla diccionario
   `web_upgrade_visitors (visitor_id int, attribution_id text unique)` y
   `web_upgrade_scopes (scope_id smallint, scope text)`. La tabla de sesiones pasa a
   `(environment smallint, scope_id smallint, d date, visitor_id int)`: unos 70 bytes por
   fila contando su índice, contra ~450 hoy (tabla + 2 índices). De 623 MB a ~100 MB
   (estimado), que entra en la memoria de Micro. Contar números distintos es mucho más rápido que comparar textos con
   reglas de idioma (la base usa `en_US`).
2. **Un solo índice**, en el orden en que se lee (entorno, módulo, día, visitante). Hoy hay
   dos de ~200 MB cada uno.
3. **Limpieza automática agresiva en esa tabla** (`autovacuum_vacuum_insert_scale_factor`
   bajo), para que el índice alcance solo y no haga falta ir a la tabla.
4. **Migración por tandas**, en horario tranquilo: copiar 1,4 M filas a la tabla nueva,
   cambiar los triggers que la llenan (`web_upgrade_rollup_apply` / `_retract` /
   `_daily_reconcile`) y la función del panel. La tabla vieja se guarda hasta validar.
5. **Prueba de igualdad antes de cambiar:** el panel nuevo y el viejo, campo por campo, para
   6 ventanas (ayer, 7 d, 30 d, 90 d, desde lanzamiento, rango custom) y los dos entornos.
   Iguales al número o no se publica. Mismo protocolo que el de la portada en septiembre.
6. **Criterio de éxito medido:** cualquier ventana en ≤ 5 s **en frío**, con un sync
   corriendo en paralelo. Si no lo cumple, no sigo al punto 7 y te traigo los números.
7. **Borrar el caché y su job** (`web_upgrade_perf_cache`, `web_upgrade_perf_cache_refresh_tick`,
   job `web-upgrade-cache-refresh`). El panel calcula al abrir. **Sin proceso de fondo no hay
   nada que pueda quedar reintentando.**

### Paso B — Que la tabla de eventos deje de crecer

1. Arreglar la lectura del archivado: avanzar por fecha dentro de cada entorno con el índice
   que ya existe `(environment, event_timestamp)`, en vez de recorrer por id. La última
   página termina enseguida.
2. Borrar los ~940 mil eventos de más de 14 días **de a 20 mil por hora** (~2 días), siempre
   después de que el archivo en Storage tenga exactamente esas filas (la función ya lo
   controla). El borrado pasa por `wu_events_purge_batch`, que no descuenta los resúmenes.
3. Verificado que nadie lee eventos crudos para reportes (solo el archivado y la
   reconciliación del slim). `web_upgrade_p1_performance` ya no existe: el panel la llama y
   recibe error, que trata como "sin datos". Pendiente: sacar esa llamada del panel.
4. El espacio queda libre para reusar dentro de la tabla; el archivo en disco no baja sin
   reescribir la tabla (`VACUUM FULL`), y eso **no** es necesario para frenar el crecimiento.

### Paso C — Ningún proceso automático vuelve a fallar en silencio

1. **Vigilante:** una función liviana que cada 15 min lee el resultado **real** de cada job:
   `cron.job_run_details` para los jobs SQL y la respuesta HTTP (`net._http_response`) para
   los que llaman funciones, que es lo que hoy dice "Succeeded" aunque la función dé 500.
   Solo lee unas pocas filas recientes; no toca tablas grandes.
2. **3 fallos seguidos = rojo en Connections**, con nombre del job, desde cuándo y el error.
3. **Freno automático:** los jobs marcados como opcionales (archivado y cualquier precálculo)
   se **pausan solos** al tercer fallo. Los syncs de negocio no se pausan; solo avisan.
4. **Regla para todo job nuevo** (la escribo en el CLAUDE.md del repo): trabajo acotado por
   corrida, recuerda sus fallos y no repite el mismo intento, y su resultado lo ve el vigilante.
5. Pendiente de decisión tuya: aviso también por **email** (Gmail con OAuth, como en CF-GC).

### Paso D — Margen (decisión tuya)

- **Small, ~US$5/mes más:** 2 GB de memoria y el doble de disco base. Con A y B hechos, lo
  que se lee seguido entra en memoria y casi no gasta disco. El plan no depende de esto.
  Mi opinión: conviene como seguro barato.

---

## 3. Cómo sabemos que quedó resuelto (no "debería")

- Al terminar cada paso: números medidos antes y después, no estimados.
- **Observación de 14 días** antes de darlo por cerrado: cero fallos de jobs en el
  vigilante, panel de Web Upgrade ≤ 5 s en cualquier ventana, tamaño de la base plano o
  bajando. Te mando el reporte al día 14.
- Lo que sí puedo garantizar: este mecanismo exacto no puede repetirse, porque el job deja de
  existir. Lo que no puedo garantizar es que nunca falle otra cosa. Para eso está el Paso C:
  si algo falla, lo ves en menos de una hora y se frena solo, en vez de 20 horas o 5 semanas.

## 4. Orden y riesgo

| Orden | Paso | Riesgo | Corte para el usuario |
|---|---|---|---|
| 1 | C (vigilante) | Bajo: solo lee | Ninguno |
| 2 | B (archivado + borrado gradual) | Medio: borra datos ya archivados | Ninguno |
| 3 | A (tabla de sesiones nueva) | Medio: cambia la fuente del panel | Ninguno si pasa la prueba de igualdad |
| 4 | A.7 (borrar caché y job) | Bajo, después de A.6 | Ninguno |

El vigilante va primero para que el resto del trabajo ya quede vigilado.

## 5. Mientras tanto
- Job del caché **apagado**. El panel calcula en vivo; 7 y 30 días cargan, "desde el
  lanzamiento" puede fallar hasta el Paso A.
- Los syncs de la madrugada del 6-oct fallaron por la caída (kickoff 04:00, Xero 05:00,
  dolo-balance-monthly-draft 00:05). El kickoff de las 13:00 debería ponerse al día; lo reviso.
