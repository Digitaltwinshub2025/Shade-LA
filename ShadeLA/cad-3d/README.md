## ShadeLa CAD-3D Dashboard

Next.js 16 приложение для интерактивного выбора участка города на карте (Kadmapper/Cesium), экспорта DXF и просмотра 3D-масcинга зданий в браузере в стиле Rhino.

Основной рабочий экран — `/dashboard`.

- **Снизу** — Kadmapper (Cesium 2D карта).
- **Сверху слева** — Rhino 3D View (three.js, масcинг зданий).
- **Сверху справа** — Grasshopper Controls (пока пустой, место под UI).

При выборе AOI на карте и нажатии `Export DXF`:

- на бэкенде вызывается `/api/export-dxf` и формируется **полный DXF** всех зданий в bbox;
- одновременно `/api/osm` возвращает OSM-здания; в Rhino-панели строится 3D-город (топ-3000 самых высоких зданий) с нормализованным масштабом, серыми объёмами и управлением камерой (зум + орбита мышью).

---

## Установка и запуск

```bash
npm install

npm run dev
```

По умолчанию приложение поднимается на:

- http://localhost:3000 — полноэкранная карта Kadmapper
- http://localhost:3000/dashboard — трёхпанельный дашборд

---

## Переменные окружения

Создай файл `.env.local` в корне проекта:

```env
NEXT_PUBLIC_CESIUM_ION_TOKEN=...          # токен Cesium Ion
NEXT_PUBLIC_CESIUM_BASE_URL=/cesium       # путь до статики Cesium
NEXT_PUBLIC_MAPTILER_KEY=...              # ключ MapTiler (фоновые тайлы)

NEXT_PUBLIC_RHINO_COMPUTE_URL=http://localhost:6500/
```

- `NEXT_PUBLIC_RHINO_COMPUTE_URL` — адрес твоего сервера Rhino.Compute.
- токены Cesium / MapTiler должны быть валидными, иначе фоновые карты не загрузятся.

После изменения `.env.local` перезапусти `npm run dev`.

---

## Использование `/dashboard`

1. Открой http://localhost:3000/dashboard.
2. В нижней панели (Kadmapper):
   - зажми левую кнопку мыши и выдели прямоугольный AOI;
   - отпусти кнопку — в AOI подтянутся OSM-здания.
3. Нажми `Export DXF`:
   - в браузере скачается DXF-файл с полной застройкой;
   - в верхней левой панели появится 3D-масcинг зданий.

### Управление камерой (Rhino 3D View)

- **Зум** — колесо мыши над Rhino-панелью.
- **Орбита** — зажать левую кнопку мыши над Rhino-панелью и двигать мышь.

Текущая реализация рисует только здания. DXF-файл может содержать больше геометрии (например, дороги), но в трёхмерном viewer’е отображается именно массинг OSM-зданий.

---

## Технологии

- Next.js 16 (App Router)
- React 19
- Cesium (Kadmapper)
- Three.js (Rhino 3D View)
- Overpass API + osmtogeojson (OSM-здания)
- Rhino.Compute (готово к интеграции через `compute-rhino3d`)
