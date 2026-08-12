# ¿Nos sirve algo tipo "Sonar Optimize"? — diagnóstico del pixel de Meta

13-ago-2026. Consultado con la Graph API v21.0 desde la base (pg_net, el token
nunca salió de Supabase). Responde a la pregunta de Mario sobre si conviene
construir un enriquecimiento de eventos hacia Meta.

## Respuesta corta: NO hay hueco que llenar

La promesa principal de Sonar es *"asegurate de que Meta capture cada conversión
aunque el pixel del navegador no dispare"*. Medido: **el pixel ya captura el
100%**.

Comparación hora por hora, 12-ago 08:00 → 13-ago 08:00 Brisbane (24 h):

| | |
|---|---|
| Horas comparadas | 24 |
| Horas con coincidencia EXACTA | **22** |
| Horas con diferencia | 2 (las dos últimas) |

Las dos que difieren (06:00 y 07:00 del 13) son las que **nuestro** sync de
atribución todavía no había levantado — el pixel tenía 6 y 4 compras, nosotros
0. No es pérdida del pixel: es lag nuestro. En las otras 22 horas la diferencia
es cero, compra por compra.

Total: pixel 160 vs nuestras 150 órdenes = 107%, y esos 10 de más son
exactamente las 2 horas de lag.

Casi seguro es porque la integración nativa de Shopify con Meta ya manda los
eventos desde el servidor. No hace falta que construyamos eso.

## Diagnósticos propios de Meta: los dos pasan

`GET /{pixel}/da_checks` → `pixel_has_low_event_source_match_rate: passed` ·
`pixel_missing_param_in_events: passed`.

## Lo que sí encontramos: cuatro pixels, tres muertos

| Pixel | Último disparo | Emparejamiento automático |
|---|---|---|
| `293778170429758` "Pesado USA" | **vivo** (11-ago 23:59) | **apagado** |
| `1891855991277079` "Pesado Precision Coffee Tools's pixel" | 15-jun-2026 | encendido, **campos completos** (em, fn, ln, ge, ph, ct, st, zp, db, country, external_id) |
| `3283957481658749` "Ads Pixel for Shopify Facebook Ad" | 11-sep-2025 | encendido (em, fn, ln) |
| `1268393420178977` "Pesado Precision Coffee Tools - Pixel" | **nunca disparó** | apagado |

El pixel mejor configurado está dormido; el que trabaja tiene esa función
apagada.

**Riesgo de campañas apuntando a un pixel muerto: descartado.** Los 120 ad sets
activos (66 en la cuenta AU + 54 en la US) apuntan **todos** al mismo pixel
vivo. Ninguno quedó colgado de uno muerto.

## Lo que NO se pudo medir por API

El puntaje de **Event Match Quality** no está expuesto en estos endpoints
(`/stats`, `/da_checks`). Solo se ve en la pantalla de Events Manager. Por eso
NO se puede afirmar que el emparejamiento sea pobre: `enable_automatic_matching
= false` gobierna el emparejamiento del **navegador**, y si Shopify manda los
eventos desde el servidor los datos del cliente pueden viajar igual.

## Recomendación

1. **No construir un Sonar propio.** Sería resolver un problema que no tenemos,
   con los tres riesgos ya documentados: duplicar conversiones si el evento de
   servidor y el de navegador no comparten `event_id`; pasar a escribir hacia
   afuera sobre campañas que gastan A$5-6k/día; y ensuciar la vara de medición
   (Meta reclamaría más por un motivo técnico, no comercial, justo en la fecha
   de activación).
2. **Mirar una sola pantalla**: Events Manager → pixel "Pesado USA" → puntaje de
   Event Match Quality. Si está bien, no hay nada que hacer. Si está bajo, se
   sube prendiendo el emparejamiento avanzado — un interruptor, no un proyecto.
3. **Limpiar los 3 pixels muertos** (o dejarlos, no hacen daño: ninguna campaña
   los usa). Prioridad baja.

## Limitación

Una sola ventana de 24 h — es lo máximo que devuelve el endpoint de stats.
Señal fuerte, pero un día. Repetir si alguna vez se sospecha pérdida de eventos.
