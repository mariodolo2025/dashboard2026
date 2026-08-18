# Auditoría de seguridad — 18-ago-2026

El auditor de Supabase devolvió **115 hallazgos**. La lista sola no sirve: la
mayoría es higiene. Lo que se hizo acá fue separar lo que **de verdad se podía
leer o hacer desde afuera** —probándolo con la clave pública que viaja dentro
del JavaScript del sitio— de lo que es deuda técnica.

## Resumen

| | Estado |
|---|---|
| Agujeros reales encontrados | **2** |
| Cerrados y verificados | **2** |
| Higiene pendiente | 4 frentes (ver §4) |

---

## 1. CERRADO — registro de usuarios abierto

**El más grave, y no estaba en la lista del auditor.**

Cadena verificada eslabón por eslabón:

| Eslabón | Estado que tenía |
|---|---|
| `disable_signup` | `false` — cualquiera podía crear cuenta |
| `mailer_autoconfirm` | `true` — la cuenta quedaba activa sin confirmar mail |
| Restricción de dominio | **ninguna**. El trigger `handle_new_user` inserta el perfil con rol `common` sin mirar el dominio; el cartel "solo usuarios invitados, correos @dolo.com.au" del login es texto, no una regla |
| Qué alcanza un `authenticated` | EXECUTE sobre `ecommerce_dashboard`, `advertising_dashboard`, `advertising_incrementality`, `web_upgrade_performance`, `shopify_sku_stats`, `growth_forecast_report` — el negocio entero |

Es decir: abrir el código de la web → sacar la clave pública → crear cuenta →
entrar sin confirmar nada → leer todo el dashboard.

**NO se probó creando una cuenta** (no se crean cuentas en sistemas del cliente).
La configuración es la prueba, y cada eslabón se verificó por separado.

**Aplicado** (Management API, `PATCH /config/auth`, con OK explícito de Mario):
`disable_signup: true`.

**Verificado desde afuera** con la clave pública:

```
POST /auth/v1/signup
→ 422 {"error_code":"signup_disabled","msg":"Signups not allowed for this instance"}
```

Los 6 usuarios existentes (todos `@dolo.com.au`) quedaron intactos. El alta
sigue disponible por el camino previsto: las edge functions `invite-user` y
`create-user`, ambas ACTIVE.

## 2. CERRADO — 218.000 filas de negocio legibles por cualquiera

Migración `20260818100000_close_public_read_on_backups.sql`.

Probado contra el endpoint REST público con la clave del bundle. Devolvían datos:

| Objeto | Filas |
|---|---|
| `aim2026_demand_detail_bkp_20260728` | 139.786 |
| `aim2026_demand_detail_bkp_ene_abr_20260728` | 54.580 |
| `aim2026_demand_history_bkp_20260728` | 17.481 |
| `aim2026_demand_history_bkp_ene_abr_20260728` | 3.340 |
| `aim2026_sku_parameters_bkp_20260804` | 1.539 |
| `upgrade_events_archive_20260722` | 422 |
| `sales_audit_snapshot_20260724` | 391 |
| `aim2026_skus_without_cost` (vista) | 207 |
| `aim2026_demand_sanity` (vista) | devolvía filas |
| `aim2026_demand_detail_bkp_so20333` | 10 |

Contenido: demanda por SKU y período, parámetros de costo por SKU, auditoría de
ventas. Qué vende la empresa, cuánto y a qué costo.

**Cerrado con dos mecanismos a propósito**: RLS activado sin políticas (el
default pasa a ser "cero filas" para cualquier llamada de PostgREST, así que un
permiso otorgado por error en el futuro no vuelve a abrir esto) y permisos
revocados a `anon` y `authenticated`. Las dos vistas no admiten RLS: llevan
`security_invoker = on`, la regla que este proyecto adoptó tras la fuga de
`ad_spend_unified` el 9-ago.

**Re-probado con la misma clave: los diez responden `42501 permission denied`.**

Seguro por construcción, verificado tres veces: ninguna referencia en `src/` ni
en `supabase/functions/`, ninguna función de la base los menciona en su cuerpo,
y `postgres` y `service_role` tienen `bypassrls` — los syncs no se enteran.

**Los respaldos no se borraron.** Existen porque un incidente destruyó demanda
una vez; borrarlos es otra decisión con su propio riesgo.

## 3. APLICADO por Mario en el panel

| Ajuste | Antes | Ahora |
|---|---|---|
| Bloqueo de contraseñas filtradas | apagado | **encendido** |
| Largo mínimo de contraseña | 6 | **8** |
| Vida del código/enlace por mail | 86.400 s (24 h) | **3.600 s (1 h)** |

## 4. Pendiente

**a) 22 funciones ejecutables por `anon`.** `ecommerce_dashboard`,
`web_upgrade_performance_live`, `shopify_sku_stats`, `create_user_with_role`,
entre otras. Con el registro cerrado el riesgo baja mucho, pero `anon` no
debería poder ejecutarlas: hay que revocar y dejar solo `authenticated`.
**Excepción a revisar antes:** `handle_new_user` es un trigger y probablemente
deba quedar como está.

**b) 19 funciones sin `search_path` fijo.** Vector clásico de escalada. Todas
las funciones nuevas del proyecto ya lo fijan; es el arrastre viejo. Mecánico.

**c) Postgres con parches pendientes.** `supabase-postgres-17.4.1.074`.
Requiere reinicio: agendar fuera de los horarios de sync (03:00 / 10:00 / 18:00
UTC).

**d) 34 casos de "RLS activo sin políticas".** En su mayoría correctos a
propósito (tablas que solo tocan los syncs), pero hay que confirmarlo tabla por
tabla en vez de asumirlo.

## Lección

El auditor automático no encontró el agujero más grande. Listó 115 cosas y el
registro abierto no estaba entre ellas, porque para la herramienta es una
opción de configuración válida. Lo que lo encontró fue preguntar *"¿qué puede
hacer alguien de afuera, ahora, con lo que ya es público?"* y probarlo.
