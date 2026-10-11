import { componentDefs } from '../src/engine/components'
import { environmentFields } from '../src/engine/environment'
import { builtinEffects, lookFields } from '../src/engine/look'
import { materialFields } from '../src/engine/materials'
import type { ParamDef } from '../src/engine/Registry'
import { builtinSurfaces } from '../src/engine/surface'

// Text of AGENTS.md that is written into every project: how an AI agent (or a human) edits the project
// as files. The field tables come from the engine definitions, so they cannot drift from the editor.

function describe(def: ParamDef) {
  switch (def.type) {
    case 'number': {
      const range = [def.min !== undefined ? `от ${def.min}` : '', def.max !== undefined ? `до ${def.max}` : '']
        .filter(Boolean)
        .join(' ')
      return `число${range ? ` (${range})` : ''}`
    }
    case 'color':
      return 'цвет `"#rrggbb"`'
    case 'colors':
      return 'список цветов `["#rrggbb", ...]`, не больше 32'
    case 'boolean':
      return '`true` / `false`'
    case 'string':
      return 'строка'
    case 'select':
      return def.options.map((o) => `\`"${o}"\``).join(' \\| ')
    case 'asset':
      return `имя ассета (${def.kind}) или \`""\``
  }
}

// "only with kind: spot" for a field that matters only next to certain values of other fields
function condition(def: ParamDef) {
  const parts = Object.entries(def.when ?? {}).map(
    ([key, allowed]) => `\`${key}\`: ${allowed.map((v) => `\`${JSON.stringify(v)}\``).join(' или ')}`
  )
  return parts.length > 0 ? `; действует только при ${parts.join(' и ')}` : ''
}

function table(defs: Record<string, ParamDef>) {
  const rows = Object.entries(defs).map(
    ([key, def]) => `| \`${key}\` | ${describe(def)}${condition(def)} | \`${JSON.stringify(def.default)}\` |`
  )
  return ['| Поле | Значение | По умолчанию |', '|---|---|---|', ...rows].join('\n')
}

export function agentDocs(project: string) {
  const components = Object.entries(componentDefs)
    .filter(([, def]) => !def.source)
    .map(([type, def]) => `### \`${type}\` — ${def.label}\n\n${table(def.fields)}`)
    .join('\n\n')

  const effects = builtinEffects
    .map((def) => `### \`${def.name}\` — ${def.label ?? def.name}\n\n${table(def.params ?? {})}`)
    .join('\n\n')

  const surfaces = builtinSurfaces
    .map((def) => `### \`${def.name}\` — ${def.label ?? def.name}\n\n${def.params ? table(def.params) : 'Параметров нет.'}`)
    .join('\n\n')

  return `<!-- Этот файл генерирует редактор whiteEditor и перезаписывает при запуске. Свои заметки пишите в CLAUDE.md. -->

# Проект ${project} (whiteEditor)

Игра на three.js, которая собирается в редакторе whiteEditor. Весь проект — текстовые файлы в этой папке;
их можно править руками или агентом, редактор подхватывает изменения с диска без перезагрузки.

## Структура

| Путь | Что это |
|---|---|
| \`scenes/<имя>.json\` | Сцены (уровни) |
| \`materials/<имя>.json\` | Материалы |
| \`prefabs/<имя>.json\` | Префабы |
| \`looks/<имя>.json\` | Стили рендера (Look): пиксели, поверхности (дрожание вершин, toon-свет), контуры, палитра и другие экранные эффекты |
| \`scripts/**/*.ts\` | Код: модели, собранные кодом, поведения объектов, свои экранные эффекты и поверхности |
| \`assets/\` | Файлы: модели, текстуры, звук |

Имена файлов сцен, материалов, префабов и стилей — только латиница, цифры, \`_\` и \`-\`.

## Проверка

Из корня whiteEditor (на две папки выше):

\`\`\`bash
npm run check -- ${project}
\`\`\`

Команда проверяет все сцены, префабы и стили (неизвестные компоненты, эффекты, поверхности и поля, типы значений, ссылки
на материалы, модели, поведения, префабы и стили) и типы скриптов. Браузер для этого не нужен. Запускайте её после каждой правки файлов.

## Сборка игры

\`\`\`bash
npm run build:game -- ${project} [сцена]
\`\`\`

Собирает игру в \`build/\` этой папки: \`index.html\` и \`game.js\`, открывается в браузере прямо с диска.
Игра стартует с указанной сцены (по умолчанию \`main\`, иначе первой по алфавиту) и смотрит через её камеру —
без активного объекта с компонентом \`camera\` на экране ничего не будет. Папку \`build/\` руками не правят.

## Сцена

\`\`\`json
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
\`\`\`

Объект сцены (entity) — пустой контейнер, как GameObject в Unity; всё, что он рисует и делает, дают компоненты.

| Поле | Значение | По умолчанию |
|---|---|---|
| \`name\` | имя, по нему объект ищут в коде | \`"GameObject"\` |
| \`id\` | любая строка, уникальная в сцене; можно не писать — редактор создаст | — |
| \`active\` | \`false\` скрывает объект вместе с детьми | \`true\` |
| \`prefab\` | имя префаба: объект — его экземпляр (см. «Префаб») | — |
| \`overrides\` | только у экземпляра: что он меняет внутри префаба (см. «Префаб») | — |
| \`position\` | \`[x, y, z]\`, метры, относительно родителя | \`[0, 0, 0]\` |
| \`rotation\` | \`[x, y, z]\`, градусы, углы Эйлера XYZ | \`[0, 0, 0]\` |
| \`scale\` | \`[x, y, z]\` | \`[1, 1, 1]\` |
| \`components\` | список компонентов, не больше одного каждого типа (кроме \`script\`) | \`[]\` |
| \`children\` | дочерние объекты | \`[]\` |

Любое поле со значением по умолчанию можно не писать. Ось Y — вверх. Свет и камера смотрят вдоль своей
локальной оси −Z, направление задаётся поворотом объекта.

### \`environment\` — настройки сцены

${table(environmentFields)}

## Компоненты

Компонент — объект с полем \`type\` и своими полями.

${components}

### \`model\` — модель, собранная кодом

\`\`\`json
{ "type": "model", "model": "stairs", "params": { "steps": 8 } }
\`\`\`

\`model\` — имя из \`defineModel\` в \`scripts/\`; \`params\` — параметры этой модели (можно не писать).

### \`script\` — поведение объекта

\`\`\`json
{ "type": "script", "script": "spin", "params": { "speed": 90 } }
\`\`\`

\`script\` — имя из \`defineBehavior\` в \`scripts/\`; \`params\` — параметры этого поведения (можно не писать).
У объекта может быть несколько компонентов \`script\`, но каждое поведение — не больше одного раза.
Поведения работают только в режиме Play (и в игре), в обычном режиме редактора сцена неподвижна.

## Материал

\`materials/Wood.json\`; имя файла без расширения — это имя материала, на которое ссылается \`mesh.material\`.

${table(materialFields)}

## Look — стиль рендера

\`looks/PixelArt.json\`; имя файла без расширения — имя стиля. Сцена выбирает стиль полем \`look\` в
\`environment\`; редактор, Play и собранная игра рисуют через него одним и тем же кодом.

\`\`\`json
{
  "pixelSize": 3,
  "surfaces": [
    { "surface": "toon", "steps": 3 }
  ],
  "effects": [
    { "effect": "outline", "lineColor": "#0a1a24" },
    { "effect": "palette", "levels": 6, "dither": 0.25 },
    { "effect": "grade", "contrast": 1.1 }
  ]
}
\`\`\`

${table(lookFields)}

\`pixelSize\` — во сколько раз уменьшается картинка перед увеличением «жёсткими» пикселями; 1 — полный размер.

\`surfaces\` — поверхности: добавки к материалам всех объектов сцены (куда встают вершины, как ложится свет) —
то, чего нельзя сделать с готовой картинкой. Запись — имя в \`surface\` и параметры, остальное как у эффектов.

\`effects\` — экранные эффекты, применяются по порядку сверху вниз. Запись — имя эффекта в \`effect\` и его
параметры; \`"enabled": false\` выключает эффект, не удаляя. Один эффект в списке — один раз.

\`extends\` — имя другого стиля, на котором построен этот: он получает его настройки, поверхности и эффекты,
а свои пишет поверх. Эффект (поверхность) с тем же именем остаётся на месте базового и получает новые
параметры, новый — добавляется в конец:

\`\`\`json
{ "extends": "PixelArt", "effects": [{ "effect": "palette", "levels": 4 }, { "effect": "vignette" }] }
\`\`\`

### Встроенные эффекты

${effects}

\`palette\` с непустым \`colors\` заменяет каждый пиксель ближайшим цветом из списка (\`levels\` тогда не
действует); с пустым — оставляет \`levels\` ступеней на канал. \`dither\` в обоих случаях прячет границы узором.

Толщина контура и \`resolution\` считаются в пикселях уменьшенной картинки (после \`pixelSize\`).

### Встроенные поверхности

${surfaces}

\`vertexSnap\` — дрожание вершин в духе PS1: вершины встают только на сетку пикселей уменьшенной картинки, поэтому
заметно вместе с \`pixelSize\` больше 1. \`toon\` делит свет на \`steps\` ровных полос от 0 до \`range\`; если
картинка стала слишком тёмной или вся в одной полосе — подбирайте \`range\` под яркость света в сцене.
\`flat\` освещает каждый треугольник как плоскую грань.

## Префаб

Префаб — объект вместе с детьми, сохранённый для повторного использования: \`prefabs/Workplace.json\`.

\`\`\`json
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
\`\`\`

\`root\` — обычный объект сцены. Его \`position\` не используется, а \`rotation\` и \`scale\` получает новый
экземпляр при создании в редакторе.

Экземпляр в сцене — объект с полем \`prefab\`. У него свои \`name\`, \`active\`, \`position\`, \`rotation\` и \`scale\`;
компоненты и дети берутся из файла префаба, собственных \`components\` и \`children\` у экземпляра быть не должно:

\`\`\`json
{ "name": "Workplace (2)", "prefab": "Workplace", "position": [3, 0, 0], "rotation": [0, 90, 0] }
\`\`\`

### Переопределения в экземпляре

Экземпляр может изменить то, что даёт префаб, только для себя — полем \`overrides\`. Ключ — путь из имён от
корня префаба (\`"Desk"\`, \`"Desk/Lamp"\`); \`"."\` — сам корень. Значение — что заменить:

\`\`\`json
{
  "name": "Workplace (2)",
  "prefab": "Workplace",
  "position": [3, 0, 0],
  "overrides": {
    "Desk": { "scale": [2, 0.05, 0.7], "components": { "mesh": { "material": "Wood" } } },
    "Lamp": { "active": false },
    ".": { "components": { "script:spin": { "params": { "speed": 30 } } } }
  }
}
\`\`\`

| Поле | Что это |
|---|---|
| \`active\`, \`position\`, \`rotation\`, \`scale\` | заменяют значения объекта из префаба; у корня (\`"."\`) их нет — это поля самого экземпляра |
| \`components\` | по ключу компонента (\`"mesh"\`, \`"light"\`, для поведений \`"script:<имя>"\`) — поля, которые заменить; \`params\` заменяются по одному параметру |

Переопределить можно только то, что в префабе есть: добавить или убрать объект или компонент, переименовать
объект в экземпляре нельзя — это делается в файле префаба. Путь может уходить внутрь экземпляра другого
префаба, стоящего в этом (\`"Shelf/Box"\`). Если в префабе объект переименовали или убрали, \`check\` сообщит,
что по такому пути ничего нет. Имена соседних объектов в префабе должны различаться, и в них не должно быть \`/\`.

Правка файла префаба меняет все его экземпляры во всех сценах (кроме того, что экземпляр переопределил). Внутри префаба могут стоять экземпляры
других префабов, но префаб не может содержать сам себя.

## Скрипты

Каждый \`defineModel\`, экспортированный из любого файла в \`scripts/\`, появляется в редакторе в панели Project.

\`\`\`ts
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
\`\`\`

Типы параметров: \`number\`, \`color\`, \`colors\` (список цветов), \`boolean\`, \`string\`, \`select\` (с \`options\`). \`create\` вызывается заново
при каждом изменении параметра и должен вернуть \`THREE.Object3D\`.

### Свои экранные эффекты

Каждый \`defineEffect\`, экспортированный из любого файла в \`scripts/\`, можно добавить в Look по имени.
Эффект с именем встроенного заменяет его.

\`\`\`ts
import { defineEffect } from "white-engine";

export const scanlines = defineEffect({
    name: "scanlines",
    label: "Scanlines",
    params: {
        strength: { type: "number", default: 0.25, min: 0, max: 1, step: 0.05 },
    },
    shader: \`
vec4 effect(vec2 uv, vec4 color) {
    float line = step(0.5, fract(uv.y * resolution.y / 2.0));
    return vec4(color.rgb * (1.0 - strength * line), color.a);
}\`,
});
\`\`\`

\`shader\` — код GLSL, который определяет \`vec4 effect(vec2 uv, vec4 color)\`: \`uv\` — место на экране
от 0 до 1, \`color\` — картинка в этой точке после предыдущих эффектов (линейный RGB). Каждый параметр —
uniform с тем же именем: \`number\` → \`float\`, \`boolean\` → \`bool\`, \`color\` → \`vec3\`, \`select\` → \`int\`
(номер варианта), \`colors\` → массив \`vec3 имя[32]\` и \`int имяCount\` (сколько цветов задано). Параметр нельзя называть \`uv\`, \`color\` и именами из таблицы ниже.

| В шейдере | Что это |
|---|---|
| \`texel(uv)\` | картинка в другой точке |
| \`depthAt(uv)\` | расстояние от камеры в метрах; нужно \`inputs: ["depth"]\` в определении |
| \`normalAt(uv)\` | направление поверхности относительно камеры; нужно \`inputs: ["normal"]\` |
| \`resolution\` | размер картинки в пикселях (\`vec2\`) |
| \`time\` | секунды |
| \`toSRGB(c)\`, \`toLinear(c)\` | перевод цвета между линейным и sRGB |

Ошибка в шейдере видна в консоли браузера; команда \`check\` шейдеры не компилирует.

### Свои поверхности

Каждый \`defineSurface\`, экспортированный из любого файла в \`scripts/\`, можно добавить в Look по имени
(список \`surfaces\`). Поверхность с именем встроенной заменяет её.

\`\`\`ts
import { defineSurface } from "white-engine";

export const sway = defineSurface({
    name: "sway",
    label: "Sway",
    params: {
        amount: { type: "number", default: 0.02, min: 0, max: 0.2, step: 0.005 },
    },
    vertex: \`
vec4 surfaceVertex(vec4 clip) {
    return clip + vec4(sin(time * 2.0 + clip.y) * amount * clip.w, 0.0, 0.0, 0.0);
}\`,
});
\`\`\`

| Поле | Что это |
|---|---|
| \`vertex\` | GLSL, определяет \`vec4 surfaceVertex(vec4 clip)\`: \`clip\` — место вершины на экране в clip-координатах (\`clip.xy / clip.w\` — от −1 до 1); вернуть новое |
| \`fragment\` | GLSL, определяет \`vec3 surfaceColor(vec3 color, vec3 albedo)\`: \`color\` — освещённый цвет пикселя (линейный RGB), \`albedo\` — цвет самого материала; вернуть новый цвет |
| \`defines\` | переключатели шейдеров three.js, например \`["FLAT_SHADED"]\` |

Все три поля необязательны. Параметры — uniform'ы с теми же именами, как у эффектов; ещё доступны
\`resolution\` (размер картинки в пикселях) и \`time\` (секунды), в \`vertex\` — атрибуты и матрицы three.js
(\`position\`, \`normal\`, \`modelMatrix\`, \`viewMatrix\`…). Поверхности одного стиля попадают в один шейдер:
вспомогательным функциям давайте свои имена. Поверхность действует на материалы проекта и на стандартные
материалы three.js в моделях из кода (\`MeshStandardMaterial\`, \`MeshBasicMaterial\` и подобные); свой
\`ShaderMaterial\` она не трогает. Тени от сдвинутых вершин не сдвигаются.

### Поведения

Каждый \`defineBehavior\`, экспортированный из любого файла в \`scripts/\`, можно повесить на объект компонентом
\`script\` (в редакторе — Add Component). Поведение запускается кнопкой Play.

\`\`\`ts
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
\`\`\`

| Поле \`self\` | Что это |
|---|---|
| \`object\` | \`THREE.Object3D\` объекта, на котором висит поведение: его двигают, вращают, масштабируют |
| \`params\` | параметры из компонента (с подставленными значениями по умолчанию) |
| \`state\` | то, что вернул \`start\` |
| \`root\` | корень запущенной сцены, например \`self.root.getObjectByName("Door")\` |
| \`registry\` | материалы, модели и префабы проекта |
| \`input\` | клавиатура и мышь, см. ниже |
| \`time\` | секунды с момента запуска |

Ввод (\`self.input\`). Клавиши называются по \`KeyboardEvent.code\`: \`"KeyW"\`, \`"Space"\`, \`"ArrowLeft"\`,
\`"ShiftLeft"\`, \`"Digit1"\`. Кнопки мыши: 0 — левая, 1 — средняя, 2 — правая.

| Вызов | Что возвращает |
|---|---|
| \`key(code)\` | \`true\`, пока клавиша зажата |
| \`keyPressed(code)\` / \`keyReleased(code)\` | \`true\` только в том кадре, когда клавишу нажали / отпустили |
| \`axis(minus, plus)\` | \`-1\`, \`0\` или \`1\` по двум клавишам: \`axis("KeyA", "KeyD")\` |
| \`mouseButton(n)\`, \`mousePressed(n)\`, \`mouseReleased(n)\` | то же для кнопок мыши, по умолчанию левая |
| \`mouseX\`, \`mouseY\` | положение мыши на экране игры: от −1 до 1 слева направо и снизу вверх |
| \`mouseDX\`, \`mouseDY\` | сдвиг мыши с прошлого кадра в пикселях |

\`\`\`ts
update: (self, dt) => {
    self.object.position.x += self.input.axis("KeyA", "KeyD") * self.params.speed * dt;
    if (self.input.keyPressed("Space")) self.state.jumping = true;
},
\`\`\`

В редакторе Play стартует в виде Game: камера сцены, ввод идёт поведениям. В виде Scene (камера редактора,
выбор и гизмо) клавиши и мышь управляют редактором и до поведений не доходят.

\`start\` и \`update\` можно не писать. Углы в three.js — в радианах (\`THREE.MathUtils.degToRad\`). Поведения
неактивных объектов (\`active: false\`) не запускаются. Если поведение бросило исключение, оно останавливается,
остальные продолжают работать; сообщение видно в строке статуса редактора.
Поведения работают на копии сцены: то, что они сделали с объектами в Play, после Stop исчезает.
Параметры поведения можно менять в Inspector прямо во время Play; при Stop редактор спросит, оставить ли правки.

## Как работать

- Расстановку объектов, свет и материалы меняйте в файлах \`scenes/\` и \`materials/\`; открытый редактор
  покажет результат сразу. Если в редакторе есть несохранённые правки той же сцены, он не станет
  перезагружать её сам, а сообщит об этом в строке статуса.
- Формы, которые проще вычислить, чем собрать из примитивов, описывайте кодом через \`defineModel\`.
- Внешний вид игры целиком (пиксели, контуры, палитра, фильтры) задаётся стилем в \`looks/\`; свой фильтр —
  \`defineEffect\` в \`scripts/\`, своя добавка к материалам — \`defineSurface\`.
- Движение и логику объектов описывайте поведениями через \`defineBehavior\` и вешайте их компонентом \`script\`.
- После правок запускайте \`npm run check -- ${project}\`.
`
}
