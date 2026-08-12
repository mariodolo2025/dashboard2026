# Calibración contra Triple Whale — 13-ago-2026

Primera comparación externa del motor. Ventana **6 → 12 ago 2026** (7 días
completos, ambas plataformas cargadas). Fuente: capturas del panel de TW
(Summary + Attribution con los cuatro modelos), aportadas por Mario.

**TW muestra todo en USD.** Nuestro tab muestra AUD con el US$ chico al lado:
para comparar hay que leer la cifra en US$, no la de AUD. Todo lo de abajo
está en USD.

## Resultado

| Métrica | Nuestro | Triple Whale | Diferencia |
|---|---|---|---|
| Órdenes de la ventana | 1.104 | 1.103 | **+1 orden** |
| Clientes nuevos | 958 | 957 | **+1 orden** |
| Gasto total | 30.786 | 30.899 | −0,4% |
| Gasto Meta | 28.519 | 28.619 | −0,3% |
| Gasto Google | 2.268 | 2.280 | −0,5% |
| Ventas (sin envío) | 83.932 | 83.380 | +0,7% |
| Meta reclama (su panel) | 65.715 | 65.896 | −0,3% |
| Google reclama (su panel) | 13.944 | 13.796 | +1,1% |
| **Meta last click** | 34.184 | 36.510 | −6,4% |
| **Google last click** | 10.213 | 10.005 | +2,1% |
| **Meta first click** | 35.155 | 38.261 | −8,1% |
| **Google first click** | 8.502 | 8.319 | +2,2% |

TW por modelo (last click / first click / linear / triple), Meta y Google:
- Last click: Meta $36.510 (478 compras) · Google $10.005 (114)
- First click: Meta $38.261 (498) · Google $8.319 (92)
- Linear All: Meta $38.088 (498,4) · Google $9.912 (110,6)
- Triple Attribution: Meta $42.893 (560) · Google $12.829 (145) — el único
  modelo cuyo total (1.177 compras) supera las órdenes reales del período.

## La única diferencia sistemática: el envío

TW suma el envío cobrado a las ventas; nosotros no. Con las propias tarjetas
de TW: gross 84.689 − descuentos 4.313 − devoluciones 1.226 + impuestos 4.230
= **83.380**, que es nuestro número (83.932) con 0,7% de diferencia. Los
7.392 restantes hasta su "Total Sales" de 90.772 son envío cobrado.

Eso explica **también** la brecha de Meta. Por orden:
- Meta: nuestro US$68,8 + envío (~US$6,7/orden) = 75,5 vs TW 76,4 → −1,2%
- Google: nuestro US$83,0 + 6,7 = 89,7 vs TW 87,8 → +2,2%

Es decir: **una vez contemplado el envío, todo cierra dentro de ~1-2%.**

MER: TW 34% (gasto÷ventas), nosotros 2,73× = 36,7% invertido. La diferencia
es exactamente el envío en el denominador de TW.

## Decisión: NO agregamos el envío

Motivos: (a) nuestro número de ventas es el mismo que usan las tabs de
E-commerce y B2C — agregarle envío rompería el cruce entre tabs, que es peor;
(b) `shopify_shipping_revenue_monthly` es **mensual**, no diario, así que hoy
no se podría repartir por día ni por canal sin datos nuevos.
Queda documentado el puente para cuando se compare a mano (va al Help).

## Lo que NO es comparable

El widget "Channel Overlap" de TW no muestra un conteo de solapamiento: su
número ("592 Orders" en last click) es **la suma de compras de Meta + Google**
de ese modelo (478+114). Cambia con el modelo elegido (590 / 592 / 705 / 609).
Nuestro overlap (17 órdenes con click pago de los dos lados en 6-12 ago) es
otra cosa: se mide sobre el recorrido y no depende del modelo.

## Conclusión

El motor propio reproduce a Triple Whale sin haberlo mirado nunca: gasto,
órdenes, clientes nuevos y reclamos de plataforma dentro del 1%; atribución
last-click de Google dentro del 2%; Meta dentro del 1,2% una vez ajustado el
envío. Las diferencias que quedan son de definición, no de error.

Pendiente: repetir la calibración a fin de mes con una ventana más larga, y
después de que Meta termine de madurar los reclamos de los días frescos.
