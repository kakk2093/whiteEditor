<!-- Этот файл генерирует редактор whiteEditor и перезаписывает при запуске. Свои заметки пишите в CLAUDE.md. -->

# Проект demo (whiteEditor)

Игра на three.js, которая собирается в редакторе whiteEditor. Весь проект — текстовые файлы в этой папке;
их можно править руками или агентом, редактор подхватывает изменения с диска без перезагрузки.

## Структура

| Путь | Что это |
|---|---|
| `scenes/<имя>.json` | Сцены (уровни) |
| `materials/<имя>.json` | Материалы |
| `prefabs/<имя>.json` | Префабы |
| `scripts/**/*.ts` | Код: модели, собранные кодом, и поведения объектов |
| `assets/` | Файлы: модели, текстуры, звук |

Имена файлов сцен, материалов и префабов — только латиница, цифры, `_` и `-`.

## Проверка

Из корня whiteEditor (на две папки выше):

```bash
npm run check -- demo
```

Команда проверяет все сцены и префабы (неизвестные компоненты и поля, типы значений, ссылки на материалы,
модели, поведения и префабы) и типы скриптов. Браузер для этого не нужен. Запускайте её после каждой правки файлов.

## Сцена

```json
{
  "version": 3,
  "environment": { "fog": true, "fogColor": "#0b4a5c" },
  "entities": [
    {
      "name": "Floor",
      "scale": [20, 1, 20],
      "components": [{ "type": "mesh", "shape": "plane", "material": "Concrete" }]
    },
    {
      "name": "Lamp",
      "position": [0, 3, 0],
      "components": [{ "type": "light", "kind": "point", "intensity": 10 }],
      "children": [
        { "name": "Shade", "components": [{ "type": "mesh", "shape": "cylinder" }] }
      ]
    }
  ]
}
```

Объект сцены (entity) — пустой контейнер, как GameObject в Unity; всё, что он рисует и делает, дают компоненты.

| Поле | Значение | По умолчанию |
|---|---|---|
| `name` | имя, по нему объект ищут в коде | `"GameObject"` |
| `id` | любая строка, уникальная в сцене; можно не писать — редактор создаст | — |
| `active` | `false` скрывает объект вместе с детьми | `true` |
| `prefab` | имя префаба: объект — его экземпляр (см. «Префаб») | — |
| `position` | `[x, y, z]`, метры, относительно родителя | `[0, 0, 0]` |
| `rotation` | `[x, y, z]`, градусы, углы Эйлера XYZ | `[0, 0, 0]` |
| `scale` | `[x, y, z]` | `[1, 1, 1]` |
| `components` | список компонентов, не больше одного каждого типа (кроме `script`) | `[]` |
| `children` | дочерние объекты | `[]` |

Любое поле со значением по умолчанию можно не писать. Ось Y — вверх. Свет и камера смотрят вдоль своей
локальной оси −Z, направление задаётся поворотом объекта.

### `environment` — настройки сцены

| Поле | Значение | По умолчанию |
|---|---|---|
| `background` | цвет `"#rrggbb"` | `"#222222"` |
| `ambientColor` | цвет `"#rrggbb"` | `"#ffffff"` |
| `ambientIntensity` | число (от 0) | `1` |
| `fog` | `true` / `false` | `false` |
| `fogColor` | цвет `"#rrggbb"` | `"#222222"` |
| `fogNear` | число (от 0) | `5` |
| `fogFar` | число (от 0) | `50` |

## Компоненты

Компонент — объект с полем `type` и своими полями.

### `mesh` — Mesh

| Поле | Значение | По умолчанию |
|---|---|---|
| `shape` | `"box"` \| `"sphere"` \| `"cylinder"` \| `"capsule"` \| `"plane"` | `"box"` |
| `material` | имя ассета (material) или `""` | `""` |
| `castShadow` | `true` / `false` | `true` |
| `receiveShadow` | `true` / `false` | `true` |

### `light` — Light

| Поле | Значение | По умолчанию |
|---|---|---|
| `kind` | `"directional"` \| `"point"` \| `"spot"` | `"directional"` |
| `color` | цвет `"#rrggbb"` | `"#ffffff"` |
| `intensity` | число (от 0) | `3` |
| `castShadow` | `true` / `false` | `false` |
| `range` | число (от 0) | `0` |
| `angle` | число (от 1 до 89) | `30` |
| `shadowSize` | число (от 1) | `10` |

### `camera` — Camera

| Поле | Значение | По умолчанию |
|---|---|---|
| `fov` | число (от 1 до 179) | `60` |
| `near` | число (от 0.001) | `0.1` |
| `far` | число (от 1) | `1000` |

### `model` — модель, собранная кодом

```json
{ "type": "model", "model": "stairs", "params": { "steps": 8 } }
```

`model` — имя из `defineModel` в `scripts/`; `params` — параметры этой модели (можно не писать).

### `script` — поведение объекта

```json
{ "type": "script", "script": "spin", "params": { "speed": 90 } }
```

`script` — имя из `defineBehavior` в `scripts/`; `params` — параметры этого поведения (можно не писать).
У объекта может быть несколько компонентов `script`, но каждое поведение — не больше одного раза.
Поведения работают только в режиме Play (и в игре), в обычном режиме редактора сцена неподвижна.

## Материал

`materials/Wood.json`; имя файла без расширения — это имя материала, на которое ссылается `mesh.material`.

| Поле | Значение | По умолчанию |
|---|---|---|
| `color` | цвет `"#rrggbb"` | `"#cccccc"` |
| `roughness` | число (от 0 до 1) | `0.8` |
| `metalness` | число (от 0 до 1) | `0` |
| `emissive` | цвет `"#rrggbb"` | `"#000000"` |
| `emissiveIntensity` | число (от 0) | `1` |
| `opacity` | число (от 0 до 1) | `1` |

## Префаб

Префаб — объект вместе с детьми, сохранённый для повторного использования: `prefabs/Workplace.json`.

```json
{
  "version": 3,
  "root": {
    "name": "Workplace",
    "children": [
      { "name": "Desk", "scale": [1.6, 0.05, 0.7], "position": [0, 0.75, 0], "components": [{ "type": "mesh" }] },
      { "name": "Lamp", "position": [0.6, 0.8, 0], "components": [{ "type": "light", "kind": "point" }] }
    ]
  }
}
```

`root` — обычный объект сцены. Его `position` не используется, а `rotation` и `scale` получает новый
экземпляр при создании в редакторе.

Экземпляр в сцене — объект с полем `prefab`. У него свои `name`, `active`, `position`, `rotation` и `scale`;
компоненты и дети берутся из файла префаба, собственных `components` и `children` у экземпляра быть не должно:

```json
{ "name": "Workplace (2)", "prefab": "Workplace", "position": [3, 0, 0], "rotation": [0, 90, 0] }
```

Правка файла префаба меняет все его экземпляры во всех сценах. Внутри префаба могут стоять экземпляры
других префабов, но префаб не может содержать сам себя.

## Скрипты

Каждый `defineModel`, экспортированный из любого файла в `scripts/`, появляется в редакторе в панели Project.

```ts
import * as THREE from "three";
import { defineModel } from "white-engine";

export const pillar = defineModel({
    name: "pillar",
    label: "Pillar",
    params: {
        height: { type: "number", default: 3, min: 0.1, step: 0.1 },
        color: { type: "color", default: "#bbbbbb" },
    },
    create: (p) => {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.2, p.height, 16),
            new THREE.MeshStandardMaterial({ color: p.color })
        );
        mesh.position.y = p.height / 2;
        return mesh;
    },
});
```

Типы параметров: `number`, `color`, `boolean`, `string`, `select` (с `options`). `create` вызывается заново
при каждом изменении параметра и должен вернуть `THREE.Object3D`.

### Поведения

Каждый `defineBehavior`, экспортированный из любого файла в `scripts/`, можно повесить на объект компонентом
`script` (в редакторе — Add Component). Поведение запускается кнопкой Play.

```ts
import { defineBehavior } from "white-engine";

export const bob = defineBehavior({
    name: "bob",
    label: "Bob",
    params: {
        height: { type: "number", default: 0.3, min: 0, step: 0.05 },
        period: { type: "number", default: 2, min: 0.1, step: 0.1 },
    },
    // Один раз при запуске; то, что вернули, потом лежит в self.state
    start: (self) => ({ baseY: self.object.position.y }),
    // Каждый кадр, dt — секунды с прошлого кадра
    update: (self) => {
        const phase = (self.time / self.params.period) * Math.PI * 2;
        self.object.position.y = self.state.baseY + Math.sin(phase) * self.params.height;
    },
});
```

| Поле `self` | Что это |
|---|---|
| `object` | `THREE.Object3D` объекта, на котором висит поведение: его двигают, вращают, масштабируют |
| `params` | параметры из компонента (с подставленными значениями по умолчанию) |
| `state` | то, что вернул `start` |
| `root` | корень запущенной сцены, например `self.root.getObjectByName("Door")` |
| `registry` | материалы, модели и префабы проекта |
| `time` | секунды с момента запуска |

`start` и `update` можно не писать. Углы в three.js — в радианах (`THREE.MathUtils.degToRad`). Поведения
неактивных объектов (`active: false`) не запускаются. Если поведение бросило исключение, оно останавливается,
остальные продолжают работать; сообщение видно в строке статуса редактора.
Поведения работают на копии сцены: то, что они сделали с объектами в Play, после Stop исчезает.
Параметры поведения можно менять в Inspector прямо во время Play; при Stop редактор спросит, оставить ли правки.

## Как работать

- Расстановку объектов, свет и материалы меняйте в файлах `scenes/` и `materials/`; открытый редактор
  покажет результат сразу. Если в редакторе есть несохранённые правки той же сцены, он не станет
  перезагружать её сам, а сообщит об этом в строке статуса.
- Формы, которые проще вычислить, чем собрать из примитивов, описывайте кодом через `defineModel`.
- Движение и логику объектов описывайте поведениями через `defineBehavior` и вешайте их компонентом `script`.
- После правок запускайте `npm run check -- demo`.
