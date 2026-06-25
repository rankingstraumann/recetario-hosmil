# Checklist — Nueva Institución Recetario Digital

> Documento generado a partir de la experiencia de implementación de ARMADA (Jun 2026).  
> Seguir este orden para evitar los errores detectados durante esa implementación.

---

## FASE 1 — Definición comercial (antes de tocar código)

```
[ ] Nombre oficial de la institución
[ ] Código corto (ej: HOSMIL, UNAB, UDP, UMAYOR, ARMADA)
    → Debe ser una sola palabra en MAYÚSCULAS, sin espacios ni guiones
[ ] Dominio Vercel: recetario-[nombre].vercel.app
[ ] Marcas disponibles: Straumann / Neodent / BLT (o subconjunto)
[ ] Color institucional (hex)
[ ] Subtítulo header (ej: "GROUP CHILE · BLC/BLX · NEODENT · BLT")
[ ] Promotora responsable (nombre, email, WhatsApp)
[ ] ¿Tiene despacho especial? (ej: Chilexpress a domicilio)
[ ] ¿Tiene campo fecha_cirugia? (solo HOSMIL lo tiene actualmente)
[ ] Confirmar descuentos POR FAMILIA (no por marca genérica):
    Straumann BLC/BLX:            __%
    Straumann Rehabilitación:     __%
    Straumann Toma de Impresión:  __%
    Straumann Pilares Prov.:      __%
    Straumann Sobredentadura:     __%
    Straumann Pilares Anatómicos: __%
    BLT (todas las familias):     __%
    Neodent ACQUA:                __%
    Neodent NEOPOROS:             __%
    Neodent Rehabilitación:       __%
    Bases de Titanio:             __%
    Línea de Biomateriales:       __%
    Tapas/Cierres: regla 99% en JS (sin fila en Supabase)
```

---

## FASE 2 — Supabase (ejecutar y verificar antes de tocar frontend)

### 2A. Insertar institución

```sql
INSERT INTO public.instituciones
  (codigo, nombre, dominio, color_primario, subtitulo, marcas)
VALUES (
  'CODIGO',
  'Nombre Oficial',
  'recetario-[nombre].vercel.app',
  '#XXXXXX',
  'GROUP CHILE · ...',
  ARRAY['Straumann', 'Neodent', 'BLT']  -- ajustar según marcas
)
ON CONFLICT (codigo) DO NOTHING;
```

```
[ ] Verificar: SELECT * FROM instituciones WHERE codigo = 'CODIGO';
[ ] Confirmar dominio exacto (debe coincidir con window.location.hostname)
[ ] Confirmar color en hex
[ ] Confirmar array de marcas
```

### 2B. Insertar descuentos (19 familias típicas; ajustar según definición)

```
[ ] Ejecutar INSERT con todas las familias confirmadas
[ ] Verificar conteo: SELECT COUNT(*) FROM descuentos_institucionales
    JOIN instituciones ON ... WHERE codigo = 'NUEVO'
    → Debe coincidir con el número de familias definidas
[ ] Verificar visualmente cada descuento:
    SELECT familia_nombre, (porcentaje*100)::int || '%'
    FROM descuentos_institucionales d
    JOIN instituciones i ON i.id = d.institucion_id
    WHERE i.codigo = 'CODIGO'
    ORDER BY familia_nombre;
[ ] Confirmar que familias de tapas NO tienen fila (van por regla 99% JS)
[ ] Confirmar que otras instituciones NO fueron modificadas
```

### 2C. ⚠️ CRÍTICO — Actualizar trigger `set_institucion_codigo`

**Este paso fue el error principal en ARMADA. Sin él, `institucion_codigo` queda NULL.**

```sql
CREATE OR REPLACE FUNCTION public.set_institucion_codigo()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF    NEW.institucion ILIKE '%HOSMIL%'  THEN NEW.institucion_codigo := 'HOSMIL';
  ELSIF NEW.institucion ILIKE '%UNAB%'    THEN NEW.institucion_codigo := 'UNAB';
  ELSIF NEW.institucion ILIKE '%UDP%'     THEN NEW.institucion_codigo := 'UDP';
  ELSIF NEW.institucion ILIKE '%MAYOR%'   THEN NEW.institucion_codigo := 'UMAYOR';
  ELSIF NEW.institucion ILIKE '%ARMADA%'  THEN NEW.institucion_codigo := 'ARMADA';
  ELSIF NEW.institucion ILIKE '%[NUEVO]%' THEN NEW.institucion_codigo := 'CODIGO';
  -- ↑ AGREGAR NUEVA INSTITUCIÓN AQUÍ ANTES DE ELSE
  ELSE  NEW.institucion_codigo := NULL;
  END IF;
  RETURN NEW;
END;
$$;
```

```
[ ] Agregar ELSIF para la nueva institución ANTES del ELSE final
[ ] Verificar que el patrón ILIKE coincide con el campo 'institucion'
    que envía el frontend (ej: 'Central Odontológica de la Armada')
[ ] Probar el trigger con un UPDATE dummy:
    UPDATE cotizaciones SET institucion = institucion
    WHERE numero = 'CODIGO-...' -- cotización de prueba
    → Verificar que institucion_codigo queda = 'CODIGO'
[ ] Verificar que instituciones anteriores siguen funcionando:
    SELECT DISTINCT institucion_codigo FROM cotizaciones
    WHERE created_at > NOW() - INTERVAL '1 hour';
```

### 2D. Verificar RPCs

```sql
-- Config por dominio (no debe exponer descuentos)
SELECT public.obtener_config_institucion('recetario-[nombre].vercel.app');
→ Debe retornar {codigo, nombre, color, subtitulo, marcas} SIN campo descuento

-- Precio con descuento correcto
SELECT public.calcular_precio_final('CODIGO', 'STRAUMANN — IMPLANTES BLC/BLX', 254660);
→ Verificar precioFinal correcto según descuento definido

-- Carrito completo
SELECT public.calcular_items_cotizacion('CODIGO', '[{...}]'::jsonb);
→ Verificar que NO aparece campo 'descuento' en ningún ítem
```

```
[ ] obtener_config_institucion devuelve datos correctos sin descuentos
[ ] calcular_precio_final devuelve valores correctos para cada familia
[ ] calcular_items_cotizacion procesa carrito sin exponer descuentos
[ ] Probar dominio inválido → debe lanzar error controlado, no null
```

---

## FASE 3 — Frontend (archivo HTML)

### 3A. Crear archivo base

```
[ ] Copiar recetario-[institucion_similar].html como base
    (preferir la más reciente y limpia — actualmente UDP o UNAB)
[ ] Renombrar como: recetario-[nombre].html (todo minúsculas)
```

### 3B. Cambios obligatorios

```
[ ] state.institucionCodigo = 'CODIGO' (valor por defecto)
[ ] initInstitucion() → normalización hostname:
    if (dominio !== 'recetario-[nombre].vercel.app' &&
        dominio.indexOf('recetario-[nombre]') !== -1) {
      dominio = 'recetario-[nombre].vercel.app';
    }
[ ] PATIENT_LINK_BASE = 'https://recetario-[nombre].vercel.app/'
[ ] NICOLE_EMAIL / NICOLE_WSP → promotora correcta
[ ] Color CSS --green (si aplica color institucional distinto)
[ ] theme-color en <meta> → color institucional
[ ] manifest → apuntar a manifest-[nombre].json
[ ] Título <title> → nombre institución
[ ] Meta apple-mobile-web-app-title → nombre corto
[ ] Badge header → '⚓ CODIGO — Nombre Corto' (o ícono apropiado)
[ ] Nombre institución en textos del formulario y mensajes
[ ] Placeholder dirección → ajustar si hay despacho especial
[ ] Nota de despacho (si aplica, ej: Chilexpress)
[ ] Prefijo número cotización: const numero = 'CODIGO-' + ...
[ ] Institución en payload: institucion: 'Nombre Oficial'
```

### 3C. Recalcular precios con descuentos ARMADA (si difieren de la base)

```
[ ] Identificar productos con precioFinal distinto a la institución base
[ ] Recalcular con: int(precioLista * (1 - descuento) + 0.5)
    → Usa esta fórmula (no Python round()) para coincidir con PostgreSQL ROUND()
[ ] Verificar 0 discrepancias: precioFinal HTML == calcular_items_cotizacion
[ ] Especial atención a familias con valores .5 exactos (ej: 243950 * 0.75 = 182962.5)
```

### 3D. Controles automáticos antes de subir

```
[ ] JS válido: node --check archivo.html (o verificar en browser sin errores)
[ ] 0 productos con campo 'descuento'
[ ] 0 discrepancias precioFinal vs Supabase
[ ] Ninguna referencia residual a la institución base (ej: 'UDP', 'UDP Santiago')
[ ] Badge correcto
[ ] Nombre institución correcto en todos los textos
[ ] Número cotización genera prefijo correcto
[ ] Regla 99% cierre intacta
[ ] calcular_items_cotizacion integrado
[ ] Error bloqueante si Supabase falla
[ ] Buscador global con auto-switch de marca
```

---

## FASE 4 — Vercel (nuevo proyecto)

### ⚠️ Errores comunes detectados en ARMADA:

```
[ ] Verificar que GitHub App de Vercel tiene acceso al repo
    → github.com → Settings → Applications → Vercel → Repository access
    → El repo debe aparecer en la lista de repos permitidos

[ ] Al crear proyecto: Framework Preset = 'Other'
[ ] Al crear proyecto: Output Directory → activar Override → escribir '.'
    → Sin esto, Vercel busca carpeta 'public/' y no encuentra los .html

[ ] Project Name = recetario-[nombre] (debe coincidir con el dominio deseado)

[ ] Después de crear el proyecto, verificar que el webhook se creó:
    Settings → Git → Connected repository → webhook activo
    Si no hay webhook: Settings → Git → Deploy Hooks → crear uno y dispararlo

[ ] El primer deploy puede tomar un commit anterior si el archivo
    fue subido DESPUÉS de crear el proyecto → disparar redeploy manual
```

```
[ ] Proyecto Vercel creado con nombre correcto
[ ] Output Directory configurado como '.'
[ ] Primer deploy exitoso (Status: Ready)
[ ] URL de producción accesible: recetario-[nombre].vercel.app/recetario-[nombre].html
[ ] Webhook activo (commits futuros desplegarán automáticamente)
```

---

## FASE 5 — Smoke Test

```
VISUAL
[ ] Página carga sin errores de consola
[ ] Badge/chip institucional correcto
[ ] Color institucional correcto
[ ] Toggle de marcas correcto (Straumann / Neodent / BLT según definición)
[ ] Nombre institución en header
[ ] Campo dirección con texto correcto (despacho si aplica)

BUSCADOR
[ ] Buscar un código Neodent estando en Straumann → auto-switch a Neodent
[ ] Buscar un código Straumann estando en Neodent → auto-switch a Straumann
[ ] Buscar 'implante' → NO hace cambio de marca (múltiples marcas)

PRECIOS (verificar al menos uno por familia)
[ ] Implante Straumann BLC/BLX → precio con descuento correcto
[ ] Implante BLT NC → precio con descuento correcto
[ ] Implante Neodent → precio con descuento correcto
[ ] Base de Titanio → precio con descuento correcto
[ ] Biomaterial → precio con descuento correcto

COTIZACIÓN
[ ] Número generado: CODIGO-YYYYMMDD-HHMMSS
[ ] Regla 99% cierre: agregar implante sin tapa → tapa automática aparece
[ ] Total carrito = total cotización (0 diferencia)
[ ] Generar cotización → link paciente se genera
```

---

## FASE 6 — Validación Supabase

```sql
-- Después de generar cotización de prueba:
SELECT numero, institucion, institucion_codigo, total::integer,
       jsonb_array_length(items) AS n_items, estado
FROM cotizaciones
WHERE numero = 'CODIGO-YYYYMMDD-HHMMSS';

-- Verificar ítems
SELECT item->>'codigo', item->>'precioFinal', item->>'descuento'
FROM cotizaciones, jsonb_array_elements(items) AS item
WHERE numero = 'CODIGO-YYYYMMDD-HHMMSS';
```

```
[ ] institucion_codigo = 'CODIGO' (NO null) ← lo más importante
[ ] institucion = 'Nombre Oficial'
[ ] Total correcto
[ ] Todos los ítems sin campo 'descuento' (debe ser null)
[ ] Tapa automática guardada con precioFinal correcto (si aplica)
[ ] Otras instituciones sin impacto:
    SELECT institucion_codigo, COUNT(*) FROM cotizaciones
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY institucion_codigo;
```

---

## FASE 7 — Cierre y respaldo

```
[ ] Tag en GitHub: stable-[nombre]-produccion (opcional pero recomendado)
[ ] Actualizar memoria del proyecto con nueva institución
[ ] Comunicar a promotora: URL, instrucciones de uso
[ ] Crear usuario admin en Supabase (Authentication → Add user)
[ ] Agregar usuario a admin_perfiles y admin_instituciones_permitidas
[ ] Probar acceso al panel admin con la nueva institución
```

---

## Tabla de referencia — estado actual por institución

| Institución | Código | Dominio | Descuentos | Trigger | Producción |
|---|---|---|---|---|---|
| Hospital Militar | HOSMIL | recetario-hosmil.vercel.app | 5 familias | ✅ | ✅ |
| Univ. Andrés Bello | UNAB | recetario-unab.vercel.app | 19 familias | ✅ | ✅ |
| Univ. Diego Portales | UDP | recetario-udp.vercel.app | 19 familias | ✅ | ✅ |
| Univ. Mayor Santiago | UMAYOR | recetario-umayor.vercel.app | 19 familias | ✅ | ✅ |
| Central Odontológica Armada | ARMADA | recetario-centralodontologica.vercel.app | 19 familias | ✅ | ✅ |

---

## Lecciones aprendidas (ARMADA — Jun 2026)

1. **El trigger es lo más crítico.** `trg_set_institucion_codigo` sobreescribe `institucion_codigo` en cada INSERT. Si la institución nueva no está en el ELSIF, queda NULL aunque el frontend envíe el valor correcto.

2. **Vercel no sincroniza automáticamente si el webhook no está activo.** Al crear un proyecto nuevo, verificar que el webhook de GitHub fue registrado correctamente. Si no, disparar manualmente desde Settings → Deploy Hooks.

3. **Output Directory debe ser `.`** Vercel por defecto busca `public/` y no encuentra los `.html` en la raíz.

4. **El rounding Python ≠ PostgreSQL ROUND().** Para casos exactamente `.5`, Python hace banker's rounding (al par más cercano) y PostgreSQL sube. Usar `int(x + 0.5)` en Python para coincidir con Supabase.

5. **Verificar precios por institución:** si la nueva tiene descuentos distintos a la institución base, recalcular `precioFinal` en el array PRODUCTS para evitar discrepancias carrito vs cotización.

6. **GitHub App de Vercel necesita acceso explícito al repo.** Verificar en GitHub → Settings → Applications → Vercel que el repo está en la lista de repositorios permitidos.
