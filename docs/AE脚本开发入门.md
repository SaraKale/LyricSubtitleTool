# After Effects 脚本开发入门

写给「完全没写过 AE 脚本」的人。看完这篇你应该能自己写一个批量生成字幕的脚本。

---

## 0. 先搞清楚 ExtendScript 是什么

AE 用的脚本语言叫 **ExtendScript**，本质是 **ECMAScript 3** 加上 Adobe 自己扩的一堆 API。

关键结论（这一条能省你很多时间）：

| 能用 | 不能用 |
| --- | --- |
| `var` / `function` / `for` / `if` / `try` | `let` / `const` / 箭头函数 `=>` |
| `Array` / `Object` / `String` 的基本方法 | 模板字符串 `` `${x}` `` |
| `parseInt` / `parseFloat` / `RegExp` | `class` / 展开运算符 `...` / `?.` / `??` |
| `try/catch`、闭包、原型 | `JSON`（**没内置！**） |
| `Date`、`Math` | `Object.keys` / `Array.isArray` / `Promise` / `async` |

也就是说：**写 2010 年风格的 JavaScript 就对了。**

> `JSON` 缺失是新手最容易踩的坑：AE 脚本调任何网络接口都会撞上它。
> 本项目在 `AE/src/01_json.jsx` 里自己实现了一份解析器。

---

## 1. 第一个脚本：Hello World

新建 `hello.jsx`：

```javascript
// 顶部这两行是"预处理指令"，不是 JS 语法
#target aftereffects
#targetengine "main"

alert("AE 版本：" + app.version);

var comp = app.project.activeItem;
if (comp) {
    var layer = comp.layers.addText("你好，AE");
    layer.name = "第一句字幕";
}
```

**运行方式：**

1. 打开 AE，先随便新建一个合成
2. 菜单 `文件 > 脚本 > 运行脚本文件…`，选中 `hello.jsx`

就这么简单。`alert` 会弹窗，`app` 是全局的 AE 应用对象。

### ExtendScript 的预处理指令

| 指令 | 作用 |
| --- | --- |
| `#target aftereffects` | 声明目标宿主（多宿主脚本用） |
| `#targetengine "main"` | 指定脚本跑在哪个引擎里。**面板脚本建议指定一个独立名字**，这样变量不会和别的脚本打架 |
| `#include "xxx.jsx"` | 在编译期把另一个文件原样插进来（相当于 C 的 include） |
| `#includepath "..."` | 追加 include 的搜索目录 |

`#include` 是**加载时**展开的，路径写相对路径时是相对「当前脚本文件」的。

---

## 2. 脚本的三种存在形态

| 形态 | 放哪 | 运行方式 | 适合 |
| --- | --- | --- | --- |
| 一次性脚本 | 任意位置 | `文件 > 脚本 > 运行脚本文件` | 干完就走的活 |
| **ScriptUI 面板** | `Support Files\Scripts\ScriptUI Panels\` | 重启 AE 后出现在 `窗口` 菜单里，可停靠 | 反复用的工具（**本项目就是这个**） |
| 启动脚本 | `Support Files\Scripts\Startup\` | AE 启动时自动跑 | 全局钩子 |

### 面板脚本的写法套路

```javascript
#targetengine "myPanel"     // 独立引擎，面板状态能保留

(function (thisObj) {
    // 关键：AE 把面板当作 this 传进来；直接运行脚本时 this 不是 Panel
    var win = (thisObj instanceof Panel)
        ? thisObj
        : new Window("palette", "我的面板", undefined, { resizeable: true });

    var btn = win.add("button", undefined, "点我");
    btn.onClick = function () {
        alert("被点了 " + (++count) + " 次");
    };
    var count = 0;

    // 停靠面板要响应尺寸变化
    win.onResizing = win.onResize = function () { this.layout.resize(); };

    if (win instanceof Window) {
        win.center();
        win.show();          // 浮动窗口
    } else {
        win.layout.layout(true);
        win.layout.resize(); // 停靠面板
    }
})(this);
```

**面板最常见的坑**：你在面板里定义的变量，下次重开 AE 时还在（同一个 targetengine），
如果直接 `var x = ...` 可能拿到旧值。用 `if (typeof X === "undefined")` 兜一下，
或者干脆每次进来重建。

---

## 3. 对象模型（最重要的部分）

AE 的 API 是一棵树，记住这条链就够用了：

```
app                              应用
└── project                      当前项目
    └── items                    所有素材/合成
        └── CompItem             合成
            └── layers          图层集合（注意：从 1 开始，且 1 是最上层）
                └── Layer
                    └── property(...)   属性
                        └── .value / .setValue() / 关键帧
```

```javascript
var proj  = app.project;
var comp  = app.project.activeItem;        // 当前合成（可能是 null！）
comp.numLayers                             // 图层数
comp.layer(1)                              // 第 1 层 = 图层栈【最上面】那一层
comp.layers.addText("abc")                 // 新建文字图层，插到最上面
comp.layers.addSolid([1,0,0], "红", 1920, 1080, 1)
comp.layers.addNull()
```

### ⚠️ 图层索引的两个反直觉点

1. **从 1 开始**，不是 0。
2. **`layer(1)` 是最上面那层**，索引越大越靠下。
3. 新建的图层**总是插在第 1 位**（最上面），会把已有的图层往下挤。

> 这就是为什么本项目的字幕脚本在生成图层时是**倒着循环**的：
> 倒序添加之后，时间最早的那条字幕刚好落在最上面，图层顺序 = 时间顺序。

### 图层类型判断

```javascript
if (layer instanceof TextLayer)   { /* 文字 */ }
if (layer instanceof ShapeLayer)  { /* 形状 */ }
if (layer instanceof AVLayer)     { /* 带素材的图层（含文字/形状） */ }
if (layer instanceof CameraLayer) { /* 摄像机 */ }
```

---

## 4. 属性路径：为什么一定要用 matchName

取属性有两种写法：

```javascript
comp.layer(1).property("Position");                        // 按【界面显示名】
comp.layer(1).property("ADBE Transform Group")
              .property("ADBE Position");                  // 按 matchName
```

**永远用 matchName**，原因：

- AE 换成中文界面后，`"Position"` 变成 `"位置"`，按名字写会直接报错
- `property("Transform")` 和 `property("ADBE Transform Group")` 混用容易出错
- 中文系统 + 英文脚本 = 必挂

常用 matchName 速查：

| 界面名 | matchName |
| --- | --- |
| 变换 | `ADBE Transform Group` |
| 位置 | `ADBE Position` |
| 缩放 | `ADBE Scale` |
| 旋转(2D) | `ADBE Rotate Z` |
| 不透明度 | `ADBE Opacity` |
| 锚点 | `ADBE Anchor Point` |
| 文本 | `ADBE Text Properties` |
| 源文本 | `ADBE Text Document` |
| 效果 | `ADBE Effect Parade` |
| 蒙版 | `ADBE Mask Parade` |
| 蒙版路径 | `ADBE Mask Shape` |
| 文字动画器 | `ADBE Text Animators` |

> 想查某个属性的 matchName，选中图层后在 AE 的控制台（或 `ExtendScript Toolkit`）里
> 遍历 `layer.property(i).matchName` 打印出来即可。

### 属性类型

```javascript
prop.propertyType
// PropertyType.PROPERTY       普通属性（有值/能打关键帧）
// PropertyType.INDEXED_GROUP  索引组（按序号取子属性）
// PropertyType.NAMED_GROUP    命名组（效果、变换组）
```

**递归遍历属性树**是很多高级功能的基础（本项目的「样式同步」就是靠它）：

```javascript
function walk(p, depth) {
    var t = p.propertyType;
    if (t === PropertyType.PROPERTY) {
        $.writeln(p.matchName + " = " + p.value);
        return;
    }
    for (var i = 1; i <= p.numProperties; i++) {
        walk(p.property(i), depth + 1);
    }
}
```

---

## 5. 文字图层：TextDocument

文字图层的文字和样式都藏在 **Source Text** 属性里。取值 → 改 → 写回：

```javascript
var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");

var td = prop.value;          // 取出一个 TextDocument 对象
td.text = "新的一行";          // 改内容
td.fontSize = 80;             // 改字号
td.fillColor = [1, 0, 0];     // 填充色，RGB 各自 0~1（不是 0~255！）
td.strokeColor = [0, 0, 0];
td.strokeWidth = 4;
td.applyStroke = true;
td.applyFill = true;
td.justification = ParagraphJustification.CENTER_JUSTIFY;   // 段落对齐
td.font = "MicrosoftYaHei";   // 注意是 PostScript 名，不是"微软雅黑"
td.tracking = 50;             // 字距
td.leading = 100;             // 行距
td.autoLeading = false;       // 关掉自动行距，leading 才生效

prop.setValue(td);            // ★ 一定要写回，否则改动不生效
```

几个必须知道的细节：

- **多行文本用 `\r` 分隔**（不是 `\n`）：
  `td.text = "第一行\r第二行";`
- ⚠️⚠️ **改 `text` 和改字号/颜色不要放在同一次 `setValue` 里！**
  这是实测（AE 2023 / 23.5）踩出来的大坑：

  ```javascript
  // ✗ 错的：一次写完，AE 以「文本变了」为准，fontSize 被丢掉，读回来还是默认的 112
  var td = prop.value;
  td.text = "第一句"; td.fontSize = 80;
  prop.setValue(td);

  // ✓ 对的：先单独提交文本，等它生效，再提交一次样式
  var a = prop.value; a.text = "第一句"; prop.setValue(a);
  var b = prop.value; b.fontSize = 80;  prop.setValue(b);
  ```

  实测对照表（同一个新建文字图层，都想设成 80）：

  | 写法 | 读回来的 fontSize |
  | --- | --- |
  | 只设 `fontSize` | 80 ✅ |
  | `text` + `fontSize` 一次写 | **112** ❌ |
  | `fontSize` + `text` 一次写 | **112** ❌ |
  | 只设 `text`，之后再单独设 `fontSize` | 80 ✅ |
  | 只设 `font` + `fontSize`（不含 text） | 80 ✅ |
  | `addText("文字")` 之后再设 `fontSize` | 80 ✅ |

  规律：**只要同一次提交里带了 `text`，同批的字符属性就会丢**。
  纯样式（font / fontSize / 颜色一起写）是没问题的。
  本项目 `04_layers.jsx` 里就按「文本 → 样式 → 读回校验」三次提交来写。
- **`app.fonts` 不是所有版本都有**。实测 **AE 2023 里 `app.fonts` 是 `undefined`**，
  一访问就 `TypeError: undefined 不是对象`。所以列字体列表必须能降级：

  ```javascript
  var all = null;
  try { all = app.fonts.allFonts; } catch (e) { all = null; }
  if (!all) { /* 退化成内置的常见字体清单，默认「不动字体」 */ }
  ```

  更稳的「某字体到底有没有」的判定方式，是建个临时文字图层写进去再读回来对一下
  （AE 找不到字体会静默回退成别的字体名）。
- **`td.font` 要 PostScript 名**（`"MicrosoftYaHei"`，不是 `"微软雅黑"`）。
  如果拿不到字体列表，最安全的默认值是**空字符串**——即根本不改字体，用图层原来的。
- **`td.value` 读出来的是「第一个字符」的样式**。所以读→改→`setValue` 的语义是
  「把这个样式应用到整段文字」。想做逐字不同样式要用 `characterRange`（AE 24.3+）。
- 改字号/颜色**不会**动 `td.text`；反过来也一样。所以「保留各自文本只同步样式」是可行的
  —— 这也是本项目「样式同步」功能的核心。

### 竖排文字

| AE 版本 | 方案 |
| --- | --- |
| 24.2 (2024) 及以上 | `td.lineOrientation = LineOrientation.VERTICAL_RIGHT_TO_LEFT` |
| 更早（比如 2023） | **没有这个属性**，只能「每个字后面插一个 `\r`」做伪竖排 |

伪竖排要顺手处理一下中英混排——连续的英文/数字应该当成一个整体（日文叫「縦中横」），
别拆成 `h/e/l/l/o` 五格：

```javascript
// "hello世界"  →  "hello\r世\r界"
```

---

## 6. 时间：inPoint / outPoint / startTime

图层有三个时间概念：

| 属性 | 含义 |
| --- | --- |
| `inPoint` | 图层在合成里**开始出现**的时间 |
| `outPoint` | 图层**消失**的时间 |
| `startTime` | 图层内部时间 0 对应到合成的哪个时刻 |

做字幕只要控制 `inPoint` / `outPoint`：

```javascript
var layer = comp.layers.addText("歌词");
layer.startTime = 2.0;    // 让图层的时间轴整体后移 2 秒
layer.inPoint  = 2.0;
layer.outPoint = 4.0;     // 显示 2s ~ 4s
```

**顺序很关键**：先设 `startTime`，再设 `inPoint`，最后 `outPoint`。
如果先设 `inPoint = 10` 而当前 `outPoint` 是 0，AE 会直接抛异常。

更稳的写法：

```javascript
try { layer.startTime = start; } catch (e) {}
try { layer.inPoint  = start; } catch (e) {}
try { layer.outPoint = end;   } catch (e) { layer.outPoint = comp.duration; }
```

> `text` 图层是「生成类图层」，理论上可以超出合成时长，
> 但保险起见还是夹在 `comp.duration` 以内。

---

## 7. 关键帧

```javascript
var pos = layer.property("ADBE Transform Group").property("ADBE Position");

pos.setValueAtTime(1.0, [100, 100]);   // 在 1 秒打一个关键帧
pos.setValueAtTime(2.0, [900, 900]);

pos.numKeys;                  // 关键帧数量
pos.keyTime(1);               // 第 1 个关键帧的时间
pos.keyValue(2);              // 第 2 个关键帧的值
pos.nearestKeyIndex(1.7);     // 找最接近某时间的关键帧索引

// 插值类型
pos.keyInInterpolationType(1);
pos.keyOutInterpolationType(1);
pos.setInterpolationTypeAtKey(1,
    KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);

// 缓动曲线
var easeIn  = pos.keyInTemporalEase(2);    // KeyframeEase 数组
var easeOut = pos.keyOutTemporalEase(2);
pos.setTemporalEaseAtKey(2, easeIn, easeOut);

// 空间切线（位置/锚点这类"空间属性"才有）
if (pos.isSpatial) {
    pos.setSpatialTangentsAtKey(2, pos.keyInSpatialTangent(2), pos.keyOutSpatialTangent(2));
}

// 删关键帧
while (pos.numKeys > 0) { pos.removeKey(pos.numKeys); }
```

**复制关键帧的套路**（本项目「样式同步」用的就是这个）：

```javascript
function copyKeys(src, dst) {
    while (dst.numKeys > 0) { dst.removeKey(dst.numKeys); }   // 先清空
    for (var k = 1; k <= src.numKeys; k++) {
        dst.setValueAtTime(src.keyTime(k), src.keyValue(k));
    }
    // 插值/缓动要第二轮再设，因为第一轮刚把帧建出来
    for (var k2 = 1; k2 <= src.numKeys; k2++) {
        var di = dst.nearestKeyIndex(src.keyTime(k2));
        dst.setInterpolationTypeAtKey(di,
            src.keyInInterpolationType(k2), src.keyOutInterpolationType(k2));
        dst.setTemporalEaseAtKey(di, src.keyInTemporalEase(k2), src.keyOutTemporalEase(k2));
    }
}
```

⚠️ 很多属性是**不能打关键帧**的（比如「源文本」的某些子项、菜单型参数）。
`setValueAtTime` 会抛异常，所以每步都要 `try/catch`，别让一个属性挂掉整个脚本。

---

## 8. 效果 / 蒙版 / 表达式

```javascript
// ---- 效果 ----
var fx = layer.property("ADBE Effect Parade");
var shadow = fx.addProperty("ADBE Drop Shadow");   // 用 matchName 添加
shadow.property("ADBE Drop Shadow-0001").setValue(60);  // 参数也用 matchName
fx.numProperties;                                   // 效果个数
fx.property(1).remove();                            // 删掉第 1 个效果

// ---- 蒙版 ----
var masks = layer.property("ADBE Mask Parade");
var mask = masks.addProperty("ADBE Mask Atom");
mask.maskMode = MaskMode.ADD;
var shape = new Shape();
shape.vertices = [[0,0],[500,0],[500,500],[0,500]];
shape.closed = true;
mask.property("ADBE Mask Shape").setValue(shape);

// ---- 表达式 ----
var rot = layer.property("ADBE Transform Group").property("ADBE Rotate Z");
rot.expression = "wiggle(2, 5)";      // 写入表达式
rot.expressionEnabled = true;         // 打开开关
rot.expression;                       // 读回来
```

> 效果参数的具体 matchName 每个效果都不一样，最省事的办法是在 AE 里选中参数，
> 然后遍历打印 `effect.property(i).matchName`。

---

## 9. ScriptUI 最小知识

ScriptUI 是 ExtendScript 自带的界面库。够用的 API 就这些：

```javascript
var w = new Window("palette", "标题", undefined, { resizeable: true });
w.orientation = "column";
w.alignChildren = ["fill", "top"];

var g = w.add("panel", undefined, "分组标题");
var rowG = g.add("group");            // group 默认横向
var t  = rowG.add("statictext", undefined, "文字");
var e  = rowG.add("edittext", undefined, "默认值");
var d  = rowG.add("dropdownlist", undefined, ["选项A", "选项B"]);
var c  = rowG.add("checkbox", undefined, "勾选");
var b  = rowG.add("button", undefined, "按钮");
var lb = g.add("listbox", undefined, ["行1", "行2"]);
var mt = g.add("edittext", undefined, "", { multiline: true, scrolling: true });
var tabs = w.add("tabbedpanel");
var tab  = tabs.add("tab", undefined, "第一页");

e.text;                       // 读
e.text = "新的";              // 写
d.selection.index;            // 选中项下标
d.selection.text;             // 选中项文字
c.value;                      // true / false
lb.selection.index;           // 列表选中
b.onClick = function () {};   // 事件
d.onChange = function () {};
```

尺寸控制：

```javascript
e.preferredSize = [120, 24];   // 静态建议尺寸
e.characters = 20;             // 按字符数给宽度（比 fixedWidth 好用）
e.alignment = ["fill", "center"];
```

### 取颜色：`$.colorPicker`

ScriptUI 没有颜色选择控件，但 ExtendScript 有系统取色器：

```javascript
var n = $.colorPicker(0xFF0000);   // 返回整数 0xRRGGBB，取消返回 -1
if (n >= 0) {
    var r = ((n >> 16) & 0xFF) / 255;
    var g = ((n >> 8)  & 0xFF) / 255;
    var b = ( n        & 0xFF) / 255;
}
```

---

## 10. 调试

| 手段 | 说明 |
| --- | --- |
| `alert(x)` | 最直接，但会打断流程 |
| `$.writeln(x)` | 输出到 ESTK 控制台；AE 里看不到，需要配 ExtendScript Toolkit / VSCode 调试插件 |
| **写日志文件** | 最可靠：`var f = new File("/tmp/log.txt"); f.open("a"); f.writeln(x); f.close();` |
| `try/catch` + `e.toString()` | 报错信息里带行号，定位很快 |
| 撤销组 | `app.beginUndoGroup("...")` / `app.endUndoGroup()`，出错也能一键撤销 |

```javascript
app.beginUndoGroup("批量生成字幕");
try {
    // ...干活...
} catch (e) {
    alert("出错：" + e.toString() + "（行 " + e.line + "）");
} finally {
    app.endUndoGroup();     // ★ 一定要在 finally 里，否则撤销栈会错乱
}
```

---

## 11. 最容易踩的坑

1. **`app.project` 可能是 null** —— 没打开项目时访问直接报错。先判断。
2. **`activeItem` 可能不是合成** —— 用户可能选中了素材。要 `instanceof CompItem`。
3. **没内置 `JSON`** —— 联网脚本必备自实现。
4. **中文源码要 UTF-8 with BOM** —— 否则 AE 按系统 ANSI 解析，界面全是乱码。
   （VS Code 里"以 UTF-8 with BOM 保存"）
5. **`\r` 才是换行** —— `td.text` 里 `\n` 不换行。
6. **颜色是 0~1 不是 0~255**。
7. **用 matchName 不用中文名**。
8. **新图层总插在最上面**，批量生成要注意顺序（倒序添加）。
9. **`setValue` 前要先删掉目标上的关键帧**，否则静态值写不进去。
10. **`setValue` 之后要 `setValue` 回去** —— 改 `td` 对象本身不会生效，
    必须 `prop.setValue(td)`。
11. **正则在字符类里也不能写裸 `/`** —— 见下面单独一节，这个坑的报错信息完全看不懂。
12. **文字图层的名字要在写完文本之后再改** —— AE 的文字图层会「跟着文本自动命名」，
    如果你先 `layer.name = "001 第一句"` 再写文本，名字会被文本覆盖成 `第一句`。
    顺序反过来（先写文本 → 再改名）就对了，改过名之后 AE 就不再自动跟随。
13. **`text` 和字号别一次 `setValue`** —— 见第 5 节，会被丢掉。
14. **`app.fonts` 在 AE 2023 上是 `undefined`** —— 字体列表必须有降级路径。
15. **ExtendScript 是 ES3：保留字不能当变量名** —— `native` / `class` / `char` / `int` /
    `final` … 拿来当变量名会抛 `SyntaxError: 非法使用保留字`，**而且不给你行号**。
    本项目最惨的一次是把变量命名成 `native`，整个自检脚本直接 SyntaxError。
    现在 `_tools/build_AEJSX.py` 里有自动检查。
16. **命令行跑 AE 时，中文路径会挂** —— 命令是经 `cmd.exe` 传给 `AfterFX.exe` 的，
    这一跳里中文路径很容易变成乱码，AE 就静默什么都不做。调试时先把文件复制到
    `%TEMP%` 下的纯 ASCII 目录再跑。
17. **`$.fileName` 不一定可靠** —— 用 `AfterFX.exe -s "..."` 直接 eval 时，
    它返回的是一个没意义的数字（实测 `"180"`）。别拿它当脚本路径用，
    要么外部注入路径，要么手工写死。
18. **Windows 自带的 `curl.exe` 是精简版** —— 没有编进 zlib，
    一加 `--compressed` 就报 `the installed libcurl version doesn't support this`。
    直接不加这个参数即可（不发 `Accept-Encoding`，服务器也不会回 gzip）。

### ★ 正则字符类里的裸斜杠：一个报错信息完全对不上的坑

这一条值得单独讲，因为它浪费的时间最多。

```javascript
var clean = t.replace(/[^A-Za-z0-9+/=]/g, "");
//                                 ↑ 字符类里这个 / 没转义
```

标准 JS **允许**字符类里出现未转义的 `/`，所以 `node --check` 完全查不出来。
但 ExtendScript 的旧词法分析器会把它当成**正则的结束符**，于是它看到的东西变成了：

```
/[^A-Za-z0-9+/        =]/g, "");       ← 解析成「给正则字面量赋值」
```

于是报出：

```
ReferenceError: 无法显示在分配的左边，因为它为只读
```

直译就是 *"cannot assign to the left-hand side because it is read-only"* ——
**给一个正则字面量赋值**，当然是只读的。行号倒是给的（指向那一行），
但信息跟内容完全对不上，而且：

- 改这一行里所有变量名都没用（试过全改一遍，报错纹丝不动）；
- 只保留到出错行也没用（说明是**编译期**错误，不是运行期）；
- 报错类型是 ReferenceError，看着像运行时，其实是解析器的锅。

**结论：ExtendScript 的正则里，`/` 一律写成 `\/`。**

```javascript
var clean = t.replace(/[^A-Za-z0-9+\/=]/g, "");   // ✓
```

`_tools/check_jsx.py` 和 `_tools/build_AEJSX.py` 里都有这条检查，打包时会直接拦下来。

### 遇到「看不懂的 ExtendScript 报错」怎么办

先用本地检查，成本几乎为零：

```bash
python _tools/check_jsx.py AE/src/*.jsx      # ES3 保留字 + 正则裸斜杠 + UI 句柄
python _tools/build_AEJSX.py                       # 打包时也会跑上面这些检查
```

还是查不出来，就用源码定位器（在 AE 里跑，按语句二分）：

```bash
python _tools/run_ae_selftest.py --script tests/ae_diag.jsx
```

它会算出源码的括号深度表，只挑「括号配平 + 不在注释里 + 以 `;`/`}` 收尾」的位置当切点，
二分找出**第一句加载就炸**的语句并原样打出来。想查别的文件，改脚本里的 `TARGETS` 数组。

外加两个性能提示：

- 大批量操作前 `comp.openInViewer(false)` 或者干脆别开视图，能快很多
- 循环里别反复调 `app.fonts.allFonts`、`listFonts` 这类重活

### sourceRectAtTime：让文字真居中

新手常犯的错是「把 Position 设成 [960, 540] 就以为居中了」。
实际上 Position 定位的是**锚点**，而锚点在文字的左下/中心取决于对齐方式和行数，
多行、竖排的时候会明显偏。

正确做法是读文字的包围盒再反算：

```javascript
var rect = layer.sourceRectAtTime(time, false);
// rect = { top, left, width, height }，坐标是相对图层原点的
var pos = layer.property("ADBE Transform Group").property("ADBE Position");
pos.setValue([
    目标中心X - (rect.left + rect.width  / 2),
    目标中心Y - (rect.top  + rect.height / 2)
]);
```

这样无论是一行、五行、还是伪竖排，都能精确居中。

---

## 12. 速查表

```javascript
// 项目 / 合成
app.project
app.project.activeItem
app.project.items.addComp(name, w, h, pixelAspect, duration, fps)
comp.openInViewer()
comp.duration ; comp.frameRate ; comp.width ; comp.height
comp.layers.precompose([1,2,3], "名字", true)

// 图层
comp.layers.addText("x")
comp.layer(1) ; comp.numLayers
comp.selectedLayers
layer.name ; layer.index ; layer.label ; layer.enabled
layer.inPoint ; layer.outPoint ; layer.startTime
layer.blendingMode ; layer.threeDLayer ; layer.motionBlur
layer.sourceRectAtTime(t, false)
layer.remove()

// 属性
layer.property(matchName)
prop.value ; prop.setValue(v)
prop.isTimeVarying ; prop.numKeys ; prop.expression

// 全局
app.version ; app.buildNumber ; app.beginUndoGroup() ; app.endUndoGroup()
$.os ; $.fileName ; $.engineName
system.callSystem("命令")           // 执行系统命令并拿到 stdout
File / Folder / new File(path).exists
alert() ; confirm() ; prompt()
```

---

## 下一步

想直接看实战，读本项目的源码，从简单的开始：

```
AE/src/01_json.jsx      JSON 解析器（纯逻辑）
AE/src/02_util.jsx      编码识别、时间格式化、图层号解析
AE/src/03_lrc.jsx       LRC 解析 + 时间轴排版（纯逻辑，可单测）
AE/src/04_layers.jsx    ★ 文字图层生成、竖排、自动居中
AE/src/05_style.jsx     ★ 属性树递归深拷贝（样式/效果/关键帧同步）
AE/src/06_online.jsx    ★ 用 curl.exe 做 HTTP 请求
AE/src/07_ui.jsx        ScriptUI 面板
```

另外可以配合读：

- Adobe 官方脚本指南：<https://ae-scripting.docsforadobe.dev/>
- 表达式参考：<https://ae-expressions.docsforadobe.dev/>
