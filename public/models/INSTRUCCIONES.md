# Cómo agregar tu personaje Mixamo

## Opción rápida — Personaje de demo (5 minutos)

1. Descargá el archivo de demo de Three.js (ya tiene walk + idle):
   https://threejs.org/examples/models/gltf/Soldier.glb

2. Renombrá el archivo a `character.glb`

3. Copialo a esta carpeta (`public/models/`)

4. ¡Listo! Reiniciá el servidor y vas a ver el personaje animado.

---

## Opción premium — Tu personaje Mixamo real

### Paso 1 — Crear personaje
1. Andá a https://www.mixamo.com (cuenta Adobe gratuita)
2. Elegí un personaje que te guste (recomiendo "Y Bot" o "X Bot" para empezar)

### Paso 2 — Agregar animaciones
3. Busca la animación **"Breathing Idle"** → Apply
4. Descargá: Formato **FBX**, Skin: **With Skin**, 30fps
5. Repetí con la animación **"Walking"** pero esta vez sin skin:
   - Skin: **Without Skin**, porque ya la descargamos

### Paso 3 — Convertir a GLB
**Opción A (más fácil):** usá un conversor online
- Andá a https://products3d.com/fbx-to-gltf
- Subí el .fbx con skin → descargá como .glb
- Renombralo a `character.glb` y ponelo acá

**Opción B (con Blender — para combinar walk + idle):**
1. Abrí Blender
2. File → Import → FBX → importá el personaje con idle
3. File → Import → FBX → importá el walking (solo animación)
4. File → Export → glTF 2.0 (.glb)
   - En opciones: activá "Include Animations"
5. Guardá como `character.glb` acá

### Nota sobre los nombres de animaciones
El juego busca automáticamente animaciones que contengan:
- "idle" o "stand" o "breath" → para cuando el personaje está quieto
- "walk" o "walking" o "run" → para cuando camina

Mixamo suele nombrar las animaciones con prefijos como "mixamo.com" lo cual también es detectado.

---

## Sin archivo (fallback automático)

Si no ponés ningún archivo, el juego genera automáticamente un personaje 3D
con los colores que elegiste (estilo Roblox / low-poly). ¡También se ve muy bien!
