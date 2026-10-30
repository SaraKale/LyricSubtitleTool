/* ============================================================================
 *  04_layers.jsx —— 文字图层生成 / 排版 / 竖排
 *  ---------------------------------------------------------------------------
 *  这一层开始真正碰 AE 的 API 了。
 *
 *  关键点：
 *   · 文字内容走 layer.property("ADBE Text Document").value → 改 → setValue
 *   · 图层名 = 歌词文本
 *   · 自动居中用 sourceRectAtTime 算包围盒，避免老脚本「文字居左/没居中」的问题
 *   · 竖排：AE 24.2+ 用 TextDocument.lineOrientation（原生竖排）；
 *           AE 2023 及更早没有这个属性，降级为「每个字后面插换行」的伪竖排
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var LY = {};

    LY.MATCH = {
        TEXT_PROPERTIES: "ADBE Text Properties",
        TEXT_DOCUMENT: "ADBE Text Document",
        TRANSFORM: "ADBE Transform Group",
        POSITION: "ADBE Position",
        SCALE: "ADBE Scale",
        ROTATION: "ADBE Rotate Z",
        OPACITY: "ADBE Opacity",
        ANCHOR: "ADBE Anchor Point",
        EFFECTS: "ADBE Effect Parade",
        MASKS: "ADBE Mask Parade",
        TEXT_ANIMATORS: "ADBE Text Animators",
        TEXT_MORE_OPTIONS: "ADBE Text More Options"
    };

    /* 标签色清单是**数据**：显示名由桥接层用 SB.TList() 现翻（09_bridge 的
     * API.encodings）。在这里翻不动 —— 它按 index 用，翻的是显示层，
     * 而且模块只在加载时求值一次，用户切语言时切不动。 */
    /* i18n-allow */
    LY.LABELS = [
        "无", "红", "黄", "蓝绿", "蓝", "紫", "品红", "橙",
        "绿", "蓝绿2", "深黄", "棕", "深绿", "深蓝", "深紫", "深红", "水绿"
    ];
    /* i18n-allow-end */

    /* ------------------------------------------------------------------ 合成 */

    LY.listComps = function () {
        var out = [];
        if (!app.project) { return out; }
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) {
                out.push({ index: i, id: item.id, name: item.name, comp: item });
            }
        }
        return out;
    };

    LY.createComp = function (opts) {
        var o = opts || {};
        if (!app.project) {
            app.newProject();
        }
        var comp = app.project.items.addComp(
            o.name || SB.M("字幕合成"),
            Math.round(o.width || 1920),
            Math.round(o.height || 1080),
            1,
            o.duration || 60,
            o.frameRate || 30
        );
        try { comp.openInViewer(); } catch (e) { }
        return comp;
    };

    /** 根据字幕总时长推算合适的合成时长 */
    LY.suggestDuration = function (frames, fallback) {
        if (!frames || frames.length === 0) { return fallback || 60; }
        return Math.max(fallback || 60, frames[frames.length - 1].end + 2);
    };

    /* ------------------------------------------------------------------ 字体 */

    LY.FALLBACK_FONTS = [
        "MicrosoftYaHei", "Microsoft YaHei", "SimHei", "SimSun", "KaiTi", "FangSong",
        "SourceHanSansSC-Regular", "NotoSansCJKsc-Regular", "Arial", "TimesNewRomanPSMT"
    ];

    /**
     * app.fonts 这个 API 在 AE 2023 上根本不存在（实测 app.fonts === undefined）。
     * 所以字体列表只能「能读就读、读不到就返回空」，由调用方降级到常见字体清单。
     */
    LY.fontsAvailable = function () {
        try { return (app.fonts !== undefined && app.fonts !== null); } catch (e) { return false; }
    };

    /**
     * 列出系统字体。app.fonts.allFonts 在字体多的机器上会慢，所以只在用户点
     * 「刷新字体」时调用。读不到就返回空数组（调用方要能接受空）。
     */
    LY.listFonts = function () {
        var out = [];
        var all = null;
        try { all = app.fonts.allFonts; } catch (e) { all = null; }
        if (!all) { return out; }
        try {
            for (var i = 0; i < all.length; i++) {
                var f = all[i];
                out.push({
                    ps: f.postScriptName,
                    family: f.familyName,
                    style: f.styleName,
                    label: f.familyName + "  " + f.styleName
                });
            }
        } catch (e2) { }

        out.sort(function (a, b) {
            if (a.family === b.family) { return a.style < b.style ? -1 : 1; }
            return a.family < b.family ? -1 : 1;
        });
        return out;
    };

    /**
     * 找可用字体的降级策略：
     *   1) app.fonts 能读 → 从里面挑中文字体
     *   2) 读不到 → 挨个把候选名字写进一个临时文字图层试，用「写进去还读得回来吗」
     *      来判断字体是否真的存在（AE 对不存在的字体名会静默回退）
     *   3) 都不行 → 返回空串，表示「别动字体，用图层原来的字体」
     * 返回空串是安全的：applyTextToLayer 只有在 fontPostScript 非空时才会改字体。
     */
    LY.guessChineseFont = function () {
        var fonts = LY.listFonts();
        var prefers = ["MicrosoftYaHei", "Microsoft YaHei", "SimHei", "SimSun",
            "SourceHanSansSC", "SourceHanSansCN", "NotoSansCJKsc", "HiraginoSansGB"];
        var i, j;
        for (i = 0; i < prefers.length; i++) {
            for (j = 0; j < fonts.length; j++) {
                if (fonts[j].ps === prefers[i]) { return fonts[j].ps; }
            }
        }
        for (i = 0; i < fonts.length; i++) {
            if (/Hei|Song|Kai|YaHei|Ming|Gothic|Sans/i.test(fonts[i].ps)) { return fonts[i].ps; }
        }
        if (fonts.length > 0) { return fonts[0].ps; }
        return "";
    };

    /**
     * 试探某个字体名在系统里是否真实可用。
     * 做法：建一个临时文字图层，把字体名写进去再读回来；AE 找不到字体时会回退成
     * 别的字体名，读回来的值就对不上了。
     */
    LY.probeFont = function (comp, fontName) {
        if (!comp || !fontName) { return false; }
        var layer = null;
        try {
            layer = comp.layers.addText("字"); // i18n-allow 探测用字符（量字体名回读），不是界面文案
            var prop = layer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
            var td = prop.value;
            td.font = fontName;
            prop.setValue(td);
            return (prop.value.font === fontName);
        } catch (e) {
            return false;
        } finally {
            try { if (layer) { layer.remove(); } } catch (e2) { }
        }
    };

    /* ------------------------------------------------------------------ 图层查询 */

    LY.listTextLayers = function (comp) {
        var out = [];
        if (!comp) { return out; }
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (layer instanceof TextLayer) {
                out.push({ index: i, name: layer.name, layer: layer });
            }
        }
        return out;
    };

    LY.listAllLayers = function (comp) {
        var out = [];
        if (!comp) { return out; }
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            var kind = SB.M("其它");
            if (layer instanceof TextLayer) { kind = SB.M("文字"); }
            else if (layer instanceof ShapeLayer) { kind = SB.M("形状"); }
            else if (layer instanceof CameraLayer) { kind = SB.M("摄像机"); }
            else if (layer instanceof LightLayer) { kind = SB.M("灯光"); }
            else if (layer instanceof AVLayer) { kind = SB.M("素材"); }
            out.push({ index: i, name: layer.name, kind: kind, layer: layer });
        }
        return out;
    };

    /* ------------------------------------------------------------------ 竖排 */

    LY._nativeVerticalCache = null;

    /** 当前 AE 版本是否支持原生竖排（AE 24.2 / 2024 起） */
    LY.supportsNativeVertical = function (textDocument) {
        if (LY._nativeVerticalCache !== null) { return LY._nativeVerticalCache; }
        var ok = false;
        try {
            if (textDocument && textDocument.lineOrientation !== undefined) { ok = true; }
        } catch (e) { ok = false; }
        if (!ok) {
            try { ok = (typeof LineOrientation !== "undefined" && LineOrientation !== null); }
            catch (e2) { ok = false; }
        }
        LY._nativeVerticalCache = ok;
        return ok;
    };

    /** 给 TextDocument 设置原生竖排方向 */
    LY.applyNativeVertical = function (textDocument, direction) {
        try {
            var rtl = (direction !== "ltr");
            if (rtl) {
                textDocument.lineOrientation = LineOrientation.VERTICAL_RIGHT_TO_LEFT;
            } else {
                textDocument.lineOrientation = LineOrientation.VERTICAL_LEFT_TO_RIGHT;
            }
            return true;
        } catch (e) {
            return false;
        }
    };

    /**
     * 伪竖排：把每个字后面插一个换行，中英混排时把连续的英文/数字当作一个整体
     * （相当于日文的「縦中横」），这样 "hello世界" 会排成两格：
     *     hello
     *     世
     *     界
     */
    LY.toVerticalText = function (text) {
        var lines = String(text).split("\r");
        var cells = [];
        for (var li = 0; li < lines.length; li++) {
            var s = lines[li];
            var buf = "";
            for (var i = 0; i < s.length; i++) {
                var ch = s.charAt(i);
                var code = s.charCodeAt(i);
                var isLatin = (code >= 0x30 && code <= 0x39) ||
                    (code >= 0x41 && code <= 0x5A) ||
                    (code >= 0x61 && code <= 0x7A);
                if (isLatin) {
                    buf += ch;
                    continue;
                }
                if (buf !== "") { cells.push(buf); buf = ""; }
                if (ch === " " || ch === "\t") { continue; }
                cells.push(ch);
            }
            if (buf !== "") { cells.push(buf); }
        }
        return cells.join("\r");
    };

    /* ------------------------------------------------------------------ 文本样式写入 */

    LY.justificationEnum = function (key) {
        try {
            if (key === "left") { return ParagraphJustification.LEFT_JUSTIFY; }
            if (key === "right") { return ParagraphJustification.RIGHT_JUSTIFY; }
            if (key === "center") { return ParagraphJustification.CENTER_JUSTIFY; }
        } catch (e) { }
        return null;
    };

    /* ------------------------------------------------------------------ 生成图层 */

    LY.defaultOptions = function () {
        return {
            fontPostScript: "",
            fontSize: 60,
            fillColor: [1, 1, 1],
            applyStroke: false,
            strokeColor: [0, 0, 0],
            strokeWidth: 2,
            justification: "center",
            targetX: 960,
            targetY: 900,
            autoCenter: true,
            vertical: false,
            verticalDirection: "rtl",
            leadingRatio: 0,       // 0 = 自动行距
            verticalLeadingRatio: 1.0,
            tracking: 0,
            layerNameMode: "text", // text | index | index+text
            labelIndex: 0,
            lineStep: 0,           // 双语拆层时每行的垂直间距(px)；0 = 自动（字号 × 1.25）
            tagPairs: true,        // 拆层时把「组内第几行」写进图层备注（样式同步要靠它认分组）
            reverse: false         // true = 倒序导入（最后一句排在最上层）
        };
    };

    /**
     * 「双语拆层」用的一组工具。
     *
     * 背景：一句原文 + 一句译文如果合成一个图层，两层天生有换行，天生上下排。
     * 拆成两个图层之后就没有换行了 —— 两个图层各自独立，Position 完全一样，
     * 结果就是严丝合缝地叠在一起，画面上只看得见下面那层。
     * 所以拆层必须自己算垂直错位，把整组当成一个「块」整体居中：
     *
     *     ┌ sub = 0（原文，y = 中心 - step/2）
     *     └ sub = 1（译文，y = 中心 + step/2）
     *
     * AE 的 Y 轴向下为正，所以「sub 越小越靠上」，跟不拆层时用换行排出来的
     * 先后顺序完全一致。
     */
    LY.subStep = function (o) {
        var opts = o || LY.defaultOptions();
        return (opts.lineStep > 0) ? opts.lineStep : (opts.fontSize * 1.25);
    };

    /** 这一帧该落在哪个 Y（没参与拆层的帧直接返回 targetY，行为跟以前一模一样） */
    LY.frameY = function (frame, opts) {
        var o = opts || LY.defaultOptions();
        if (!frame || !(frame.subCount > 1)) { return o.targetY; }
        var step = LY.subStep(o);
        var sub = (frame.sub === undefined || frame.sub === null) ? 0 : frame.sub;
        return o.targetY + (sub - (frame.subCount - 1) / 2) * step;
    };

    /**
     * 把一个已有图层整体往下挪 dy 像素（模板图层复制出来的副本用它错位）。
     *
     * 有关键帧时不能只 setValue —— 那样会把整段位移动画压成一个静态值。
     * 这里逐个关键帧加偏移，动画形状保持不变。
     */
    LY.shiftLayerY = function (layer, dy) {
        if (!layer || !dy) { return false; }
        try {
            var p = layer.property(LY.MATCH.TRANSFORM).property(LY.MATCH.POSITION);
            var i, v;
            var n = 0;
            try { n = p.numKeys; } catch (e0) { n = 0; }
            if (n > 0) {
                for (i = 1; i <= n; i++) {
                    v = p.keyValue(i);
                    if (v.length > 2) {
                        p.setValueAtKey(i, [v[0], v[1] + dy, v[2]]);
                    } else {
                        p.setValueAtKey(i, [v[0], v[1] + dy]);
                    }
                }
                return true;
            }
            v = p.value;
            if (v.length > 2) { p.setValue([v[0], v[1] + dy, v[2]]); }
            else { p.setValue([v[0], v[1] + dy]); }
            return true;
        } catch (e) {
            return false;
        }
    };

    /** 模板副本该往下挪多少（只看 frame 里的同组序号，不管模板本身在哪） */
    LY.subShiftY = function (frame, opts, fallbackFontSize) {
        var o = opts || LY.defaultOptions();
        if (!frame || !(frame.subCount > 1)) { return 0; }
        var step = o.lineStep;
        if (!(step > 0)) {
            var fs = (fallbackFontSize && fallbackFontSize > 0) ? fallbackFontSize : (o.fontSize || 60);
            step = fs * 1.25;
        }
        var sub = (frame.sub === undefined || frame.sub === null) ? 0 : frame.sub;
        return (sub - (frame.subCount - 1) / 2) * step;
    };

    /* ============================================================ 双语分组识别
     *
     * 「各占一个图层」生成出来的是一原文一译文成对的两层。之后做**样式同步**时，
     * 如果照抄参考层的位置，这两层会被压到同一个点上、完全重叠 —— 所以同步那一步
     * 必须知道「这一层是组里的第几行」。
     *
     * 麻烦在于：样式同步是**事后**操作，手上只有一堆图层，当初那批帧数据早没了。
     * 所以生成时把配对信息写进 layer.comment（AE 自带的一段备注文本，不参与渲染、
     * 也不影响导出），同步时再读回来。
     *
     * 对**不是本脚本生成**的图层（手搓的、别处导进来的）没有标记，这时退到
     * 「看文字像哪种语言」：日文一定带假名、中文只有汉字，这两类分得极干净。
     */

    /**
     * 一段文字主要用哪种文字体系。
     * 返回 ja 日文 / zh 中文 / ko 韩文 / ru 西里尔 / en 拉丁 / mixed 混排 / other。
     *
     * 关键判据：**假名是日文的身份证**。日文几乎必然夹带平假名或片假名，
     * 而中文里一个假名都没有 —— 所以「有假名 → 日文」这一条就能把日/中分开，
     * 剩下的汉字谁多谁少都无所谓（日译中、中译日同理）。
     */
    LY.detectScript = function (text) {
        var s = String(text || "");
        if (s === "") { return "other"; }
        var kana = 0, han = 0, hangul = 0, cyr = 0, latin = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c >= 0x3040 && c <= 0x30FF) { kana++; }        // 平假名 + 片假名
            else if (c >= 0x4E00 && c <= 0x9FFF) { han++; }     // CJK 汉字（中日韩共用）
            else if (c >= 0xAC00 && c <= 0xD7AF) { hangul++; }  // 谚文
            else if (c >= 0x0400 && c <= 0x04FF) { cyr++; }     // 西里尔
            else if ((c >= 0x0041 && c <= 0x007A) || (c >= 0x00C0 && c <= 0x024F)) { latin++; }
        }
        if (kana > 0) { return "ja"; }
        if (hangul > 0) { return "ko"; }
        if (cyr > 0) { return "ru"; }
        if (han > 0) { return (latin > han) ? "mixed" : "zh"; }
        if (latin > 0) { return "en"; }
        return "other";
    };

    /** 生成时打在图层上的配对标记（没参与拆层的帧返回 null，不写备注） */
    LY.pairTag = function (frame) {
        if (!frame || !(frame.subCount > 1)) { return null; }
        return {
            v: 1,
            p: (frame.pairId === undefined || frame.pairId === null) ? frame.index : frame.pairId,
            s: (frame.sub === undefined || frame.sub === null) ? 0 : frame.sub,
            c: (frame.subCount === undefined || frame.subCount === null) ? 1 : frame.subCount,
            g: frame.srcGroup || ""
        };
    };

    /**
     * 把配对标记写进图层备注。
     * 用户自己写的备注**不会被冲掉** —— 标记只是追加在后面的 `[ST]{...}` 尾巴。
     */
    LY.writePairTag = function (layer, frame) {
        var tag = LY.pairTag(frame);
        if (!layer || !tag) { return false; }
        try {
            var old = String(layer.comment || "");
            var i = old.indexOf("[ST]");
            if (i >= 0) { old = old.substring(0, i); }   // 换掉上一次的标记
            layer.comment = old + "[ST]" + SB.JSON.stringify(tag);
            return true;
        } catch (e) { return false; }
    };

    /** 读回来。不是本脚本写的备注一律返回 null（用户的备注不动它） */
    LY.readPairTag = function (layer) {
        try {
            var c = String(layer.comment || "");
            var i = c.indexOf("[ST]");
            if (i < 0) { return null; }
            var t = SB.JSON.parse(c.substring(i + 4));
            return (t && t.v === 1) ? t : null;
        } catch (e) { return null; }
    };

    /**
     * 一个图层**相对于参考层**的角色：跟参考层是不是同一组（同一行）。
     *
     *   ① 有 [ST] 标记 → 直接比组内序号，100% 准
     *   ② 没标记     → 比文字体系：和参考层同种文字的算「同一组」
     *
     * sub 是「组内的第几行」，样式同步要拿它算错位：sub 0 在上、sub 1 在下。
     */
    LY.roleOf = function (layer, refLayer) {
        var script = LY.detectScript(LY.getLayerText(layer));
        var refScript = LY.detectScript(LY.getLayerText(refLayer));
        var tag = LY.readPairTag(layer);
        var refTag = LY.readPairTag(refLayer);
        var refSub = refTag ? refTag.s : 0;

        if (tag) {
            return {
                tagged: true, script: script,
                sub: tag.s, subCount: tag.c, group: tag.g,
                sameAsRef: (tag.s === refSub), refSub: refSub
            };
        }
        var same = (script === refScript);
        return {
            tagged: false, script: script,
            sub: same ? 0 : 1, subCount: 2, group: "",
            sameAsRef: same, refSub: 0
        };
    };

    /**
     * 扫一批图层，统计「跟参考层同组 / 另一组」各有多少层。
     * 给界面用：让用户点之前就知道会选中哪些。
     * @returns { total, same, other, tagged, scripts:{ja:n,…}, sampleSame:[], sampleOther:[] }
     */
    LY.scanGroups = function (comp, indices, refLayer) {
        var out = {
            total: 0, same: 0, other: 0, tagged: 0,
            scripts: {}, sampleSame: [], sampleOther: []
        };
        if (!comp || !indices || !refLayer) { return out; }
        for (var i = 0; i < indices.length; i++) {
            var layer = safe(function () { return comp.layer(indices[i]); }, null);
            if (!layer) { continue; }
            if (layer === refLayer) { continue; }
            var role = LY.roleOf(layer, refLayer);
            out.total++;
            if (role.tagged) { out.tagged++; }
            out.scripts[role.script] = (out.scripts[role.script] || 0) + 1;
            if (role.sameAsRef) {
                out.same++;
                if (out.sampleSame.length < 3) { out.sampleSame.push(layer.name); }
            } else {
                out.other++;
                if (out.sampleOther.length < 3) { out.sampleOther.push(layer.name); }
            }
        }
        return out;
    };

    function safe(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    LY.buildLayerName = function (frame, opts) {
        var name = String(frame.text).replace(/\r/g, " / ");
        if (opts.layerNameMode === "index") { return U.pad(frame.index + 1, 3); }
        if (opts.layerNameMode === "index+text") { return U.pad(frame.index + 1, 3) + " " + name; }
        return name;
    };

    /**
     * 把「逐条样式」盖到面板设置上，得到这一帧真正要用的样式。
     *
     * 逐条样式目前只有一个来源：ASS 的样式表（SB.Sub 解析出来的那组字段）。
     * 盖的顺序是「面板设置打底 → 文件里的样式覆盖」，所以只有文件里**写了**
     * 的字段才会生效，没写的（比如没写描边）还是听面板的。
     */
    LY.mergeStyle = function (opts, override) {
        var o = opts || LY.defaultOptions();
        if (!override) { return o; }
        var out = {};
        var k;
        for (k in o) {
            if (o.hasOwnProperty && o.hasOwnProperty(k)) { out[k] = o[k]; }
        }
        for (k in override) {
            if (override.hasOwnProperty && override.hasOwnProperty(k)) { out[k] = override[k]; }
        }
        return out;
    };

    /** 把一帧字幕写进已有的文字图层（不新建图层） */
    LY.applyTextToLayer = function (layer, frame, opts) {
        var o = LY.mergeStyle(opts, frame.style);
        var prop = layer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);

        var nativeVertical = (o.vertical && LY.supportsNativeVertical(prop.value));
        var text = frame.text;
        if (o.vertical && !nativeVertical) {
            text = LY.toVerticalText(text);
        }

        /* ---------------------------------------------------------------- 第 1 遍
         * AE 的坑（实测 AE 2023 / 23.5）：
         *   把 text 和 fontSize 放在同一个 TextDocument 里一次 setValue，
         *   AE 以「文本变了」为准，把同一次提交里的字符属性全部丢掉 ——
         *   读回来 fontSize 会变回默认的 112。
         *   改成「只发文本」+「再发一次样式」两次提交就完全正常。
         *   顺带：只有纯样式（font + fontSize）一次提交是没问题的，
         *   所以第 2 遍可以把样式一把写完。
         */
        var tdocText = prop.value;
        tdocText.text = text;
        prop.setValue(tdocText);

        /* ---------------------------------------------------------------- 第 2 遍 */
        var td = prop.value;

        if (o.fontPostScript) {
            try { td.font = o.fontPostScript; } catch (e) { }
        }
        td.fontSize = o.fontSize;

        if (o.fillColor) {
            td.applyFill = true;
            td.fillColor = [o.fillColor[0], o.fillColor[1], o.fillColor[2]];
        }
        if (o.applyStroke) {
            td.applyStroke = true;
            td.strokeColor = [o.strokeColor[0], o.strokeColor[1], o.strokeColor[2]];
            td.strokeWidth = o.strokeWidth;
            td.strokeOverFill = false;
        } else {
            td.applyStroke = false;
        }

        /* 粗体 / 斜体：只有 ASS 样式里明确写了才动（undefined = 听天由命，
         * 不碰图层本来的设置）；AE 里是「伪粗体 / 伪斜体」，不换字族。 */
        if (o.fauxBold !== undefined && o.fauxBold !== null) {
            try { td.fauxBold = !!o.fauxBold; } catch (eB) { }
        }
        if (o.fauxItalic !== undefined && o.fauxItalic !== null) {
            try { td.fauxItalic = !!o.fauxItalic; } catch (eI) { }
        }

        var just = LY.justificationEnum(o.justification);
        if (just !== null) {
            try { td.justification = just; } catch (e2) { }
        }

        if (o.tracking) {
            try { td.tracking = o.tracking; } catch (e3) { }
        }

        var ratio = o.vertical ? o.verticalLeadingRatio : o.leadingRatio;
        if (ratio && ratio > 0) {
            td.autoLeading = false;
            td.leading = o.fontSize * ratio;
        } else {
            td.autoLeading = true;
        }

        if (o.vertical && nativeVertical) {
            LY.applyNativeVertical(td, o.verticalDirection);
        }

        prop.setValue(td);

        /* ---------------------------------------------------------------- 第 3 遍
         * 兜底校验：个别情况（图层是从别处复制来的、字体回退、AE 版本差异）
         * 字号还是会被吃掉。读回来比一下，不对就只补一次字号 ——
         * 只动 fontSize、不动 text，所以不会再把文本弄脏。
         */
        var fontSizeOk = true;
        try {
            var back = prop.value;
            if (Math.abs(back.fontSize - o.fontSize) > 0.01) {
                fontSizeOk = false;
                back.fontSize = o.fontSize;
                prop.setValue(back);
                try {
                    fontSizeOk = (Math.abs(prop.value.fontSize - o.fontSize) <= 0.01);
                } catch (e8) { fontSizeOk = false; }
            }
        } catch (e9) { fontSizeOk = false; }

        return { nativeVertical: nativeVertical, fontSizeOk: fontSizeOk };
    };

    /**
     * 用 sourceRectAtTime 把图层包围盒的中心对齐到 (cx, cy)。
     * 这一步是整个脚本「文字自动居中」的关键 —— 老脚本常常只设了 Position 的
     * 数值，结果多行/竖排文字会偏到一边。
     */
    LY.centerAt = function (layer, cx, cy, atTime) {
        var t = (atTime === undefined || atTime === null) ? layer.inPoint : atTime;
        var rect = null;
        try {
            rect = layer.sourceRectAtTime(t, false);
        } catch (e) {
            rect = null;
        }
        if (!rect) { return false; }
        var pos = layer.property(LY.MATCH.TRANSFORM).property(LY.MATCH.POSITION);
        var nx = cx - (rect.left + rect.width / 2);
        var ny = cy - (rect.top + rect.height / 2);
        try {
            pos.setValue([nx, ny]);
            return true;
        } catch (e2) {
            return false;
        }
    };

    LY.makeOneLayer = function (comp, frame, opts) {
        var o = opts || LY.defaultOptions();
        var layer = comp.layers.addText("");

        // 时间：先 startTime 再 outPoint；直接设 inPoint 容易因为越界报错
        try { layer.startTime = frame.start; } catch (e2) { }
        try { layer.outPoint = frame.end; } catch (e3) {
            try { layer.outPoint = comp.duration; } catch (e4) { }
        }

        LY.applyTextToLayer(layer, frame, o);

        /* 图层改名必须放在「写文本」之后！
         * AE 的文字图层默认会跟着文本自动命名，如果先改名再写文本，
         * 文本会把名字覆盖掉（实测：先改名为 "001 第一句"，写完文本后名字变成
         * "第一句"）。所以顺序是：先写文本，再改名字 —— 改过名之后 AE 就不再
         * 跟着文本自动改了。
         */
        try { layer.name = LY.buildLayerName(frame, o); } catch (e0) { }

        if (o.labelIndex && o.labelIndex > 0) {
            try { layer.label = o.labelIndex; } catch (e1) { }
        }

        /* 双语拆层的配对标记：写进备注，供以后「样式同步」认分组。
         * 只有真的参与了拆层的帧才会写（subCount > 1），普通帧不动备注。 */
        if (o.tagPairs !== false) { LY.writePairTag(layer, frame); }

        if (o.autoCenter) {
            LY.centerAt(layer, o.targetX, LY.frameY(frame, o), frame.start + 0.01);
        } else {
            var posY = LY.frameY(frame, o);
            var pos = layer.property(LY.MATCH.TRANSFORM).property(LY.MATCH.POSITION);
            try { pos.setValue([o.targetX, posY]); } catch (e5) { }
        }

        return layer;
    };

    /* ------------------------------------------------------------------ 模板图层 */

    /** 读一个文字图层的纯文本（读不到就返回空串，不抛） */
    LY.getLayerText = function (layer) {
        try {
            var p = layer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
            return String(p.value.text);
        } catch (e) { return ""; }
    };

    /**
     * 只改文字内容，**不动任何样式**。
     *
     * 和 applyTextToLayer 的区别：那个会顺手写字体/字号/颜色（新建图层时用），
     * 这个只提交 text 一个字段。模板图层（Ctrl+D 式复制）走的就是这条：
     * 复制过来的图层必须原封不动保留参考层的字体、描边、图层样式、效果、动画器。
     */
    LY.setLayerTextOnly = function (layer, text) {
        try {
            var p = layer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
            var td = p.value;
            td.text = String(text);
            p.setValue(td);
            return true;
        } catch (e) { return false; }
    };

    /**
     * 读图层的字号（读不到返回 0）。模板图层复制出来的副本要靠它算双语行距 ——
     * 模板自带的字号是多少就按多少排，别用面板上的默认值，不然会明显偏。
     */
    LY.fontSizeOf = function (layer) {
        try {
            var p = layer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
            return p.value.fontSize;
        } catch (e) { return 0; }
    };

    /**
     * 以「模板图层」为样板批量生成字幕图层 —— 也就是用户说的 Ctrl+C / Ctrl+V。
     *
     * 为什么这条路比「样式同步」靠谱得多：
     *   duplicate() 是 **AE 自己**在复制，走的是内部实现，不受脚本 API 的限制。
     *   图层样式（投影/描边/外发光）、效果、文字动画器、蒙版、表达式、关键帧
     *   —— 全都原样带过去，包括脚本接口读都读不到的图层样式。
     *   而「样式同步」是一个属性一个属性地抄，AE 没开放的东西就必然抄不到。
     *
     * 复制完要做两件事：
     *   ① 把每句歌词写进去（只改 text，其它一律不动）
     *   ② 关键帧对时：复制过来的帧还在模板的绝对时间点上，
     *      要重映射到这一层自己的入点/出点（交给 ST.remapLayerKeys）
     *
     * @param comp     目标合成
     * @param template 模板图层（Layer 对象）
     * @param frames   解析好的字幕帧
     * @param opts     { reverse, layerNameMode, hideTemplate, remapMode, onProgress }
     * @returns { layers: [...], report: {...} }
     */
    LY.createFromTemplate = function (comp, template, frames, opts) {
        var o = opts || {};
        var report = { total: 0, ok: 0, remapped: 0, errors: [] };
        var created = [];
        if (!comp || !template || !frames || frames.length === 0) { return { layers: created, report: report }; }

        var mode = o.remapMode === undefined ? "scale" : o.remapMode;
        var STx = root.Style;

        /* 模板的时间范围（关键帧要从这里映射出去） */
        var tplIn = 0, tplOut = comp.duration;
        try { tplIn = template.inPoint; } catch (e0) { }
        try { tplOut = template.outPoint; } catch (e1) { }

        /* 这里**不能**照抄 createTextLayers 的顺序逻辑。
         * addText 是「后建的排在最上面」，而 duplicate() 是「副本紧跟在模板上方」——
         * 也就是**先复制的排在最上面**，正好相反。
         * 为了避免在这个细节上猜错，复制完统一用 moveToBeginning() 显式排一次序。 */
        var order = [];
        var i;
        for (i = 0; i < frames.length; i++) { order.push(i); }

        function progress(done, total) {
            if (typeof o.onProgress === "function") {
                try { o.onProgress(done, total); } catch (eP) { }
            }
        }

        app.beginUndoGroup(SB.M("以模板图层生成字幕"));
        try {
            for (var k = 0; k < order.length; k++) {
                var frame = frames[order[k]];
                if (U.trim(frame.text) === "") { continue; }
                report.total++;

                var dup = null;
                try { dup = template.duplicate(); } catch (eD) {
                    report.errors.push(SB.M("第 %1 句复制失败：%2", frame.index + 1, eD.toString()));
                    continue;
                }
                if (!dup) { continue; }

                /* ① 只写文字，样式一个都不碰 */
                LY.setLayerTextOnly(dup, frame.text);

                /* ② 对时：先落到这一句的时间范围 */
                try { dup.inPoint = frame.start; } catch (eI) { }
                try { dup.outPoint = frame.end; } catch (eO) {
                    try { dup.outPoint = comp.duration; } catch (eO2) { }
                }

                /* ②b 双语拆层的错位：把整组当成一块整体居中（见 LY.subStep 的说明）。
                 *    模板可能带着位移动画，所以走 shiftLayerY 的「逐关键帧加偏移」，
                 *    不能简单 setValue —— 那会把动画压成一个静态位置。 */
                if (frame.subCount > 1) {
                    LY.shiftLayerY(dup, LY.subShiftY(frame, o, LY.fontSizeOf(dup)));
                }

                /* ③ 关键帧重映射：模板的 [tplIn, tplOut] → 这一句的 [start, end] */
                if (mode !== "none" && STx) {
                    var rm = STx.remapLayerKeys(dup, tplIn, tplOut, frame.start, frame.end, mode);
                    report.remapped += rm.keys;
                }

                /* ④ 改名（必须放在写文本之后，否则会被文本自动命名覆盖） */
                try {
                    if (o.layerNameMode) {
                        dup.name = LY.buildLayerName(frame, { layerNameMode: o.layerNameMode });
                    }
                } catch (eN) { }

                /* ⑤ 双语分组标记（跟 makeOneLayer 那条路保持一致） */
                if (o.tagPairs !== false) { LY.writePairTag(dup, frame); }

                created.push(dup);
                report.ok++;
                progress(report.ok, frames.length);
            }

            if (o.hideTemplate) {
                try { template.enabled = false; } catch (eH) { }
            }
        } catch (e) {
            report.errors.push(SB.M("生成中断：%1", e.toString()));
        } finally {
            app.endUndoGroup();
        }

        /* 显式排序，不依赖 duplicate() 的插入位置。
         * moveToBeginning() 把图层顶到最上层，所以**后调的排在上面**：
         *   正序（第一句在最上层）：倒着遍历 → created[0] 最后顶上去
         *   倒序（最后一句在最上层）：正着遍历 → created[n-1] 最后顶上去
         * created 数组本身始终是「按时间先后」，外面选中/打包都方便。 */
        try {
            if (o.reverse) {
                for (var a = 0; a < created.length; a++) {
                    try { created[a].moveToBeginning(); } catch (eMA) { }
                }
            } else {
                for (var b = created.length - 1; b >= 0; b--) {
                    try { created[b].moveToBeginning(); } catch (eMB) { }
                }
            }
        } catch (eSort) { }

        return { layers: created, report: report };
    };

    /**
     * 批量生成字幕图层。
     * 注意：addText 每次都插在图层栈最上面，所以这里倒序生成，
     * 生成完后图层顺序刚好是「时间从早到晚」。
     */
    LY.createTextLayers = function (comp, frames, opts) {
        var o = opts || LY.defaultOptions();
        var created = [];
        if (!comp || !frames || frames.length === 0) { return created; }

        /* 建图层的顺序决定了谁在上面：AE 里**后建的图层排在上面**。
         *   正序（默认）：从最后一句往回建 → 第一句最后建 → 第一句在最上层。
         *   倒序（reverse）：从第一句往后建 → 最后一句最后建 → 最后一句在最上层。 */
        var order = [];
        var i;
        if (o.reverse) {
            for (i = 0; i < frames.length; i++) { order.push(i); }
        } else {
            for (i = frames.length - 1; i >= 0; i--) { order.push(i); }
        }

        app.beginUndoGroup(SB.M("生成字幕图层"));
        try {
            for (var k = 0; k < order.length; k++) {
                var frame = frames[order[k]];
                if (U.trim(frame.text) === "") { continue; }
                created.push(LY.makeOneLayer(comp, frame, o));
            }
        } finally {
            app.endUndoGroup();
        }

        /* created 统一按时间先后排（第一句在前），外面按顺序选中/打包都方便 */
        if (!o.reverse) { created.reverse(); }
        return created;
    };

    /** 把新生成的图层打包成预合成 */
    LY.precompose = function (comp, layers, name) {
        if (!layers || layers.length === 0) { return null; }
        var indices = [];
        for (var i = 0; i < layers.length; i++) { indices.push(layers[i].index); }
        try {
            return comp.layers.precompose(indices, name || SB.M("字幕"), true);
        } catch (e) {
            return null;
        }
    };

    /* ------------------------------------------------------------------ 简单自检 */

    LY.selfTest = function () {
        var log = [];
        try { log.push(SB.M("AE 版本：%1（build %2）", app.version, app.buildNumber)); }
        catch (e0) { log.push(SB.M("AE 版本：%1", SB.M("读取失败"))); }
        try {
            log.push(SB.M("项目：%1", (app.project ? (app.project.file ? app.project.file.fsName : SB.M("未保存项目")) : SB.M("无项目"))));
        } catch (e1) { log.push(SB.M("项目：%1", SB.M("读取失败"))); }

        var td = null;
        if (!app.project) {
            log.push(SB.M("TextDocument 读取：跳过（当前没有打开的项目）"));
        } else {
            try {
                var tmp = app.project.items.addComp("__sb_probe", 100, 100, 1, 1, 25);
                var tl = tmp.layers.addText("测"); // i18n-allow 探测用字符，不是界面文案
                td = tl.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT).value;
                tmp.remove();
                log.push(SB.M("TextDocument 读取：正常"));
            } catch (e) {
                log.push(SB.M("TextDocument 读取：失败 %1", e.toString()));
            }
        }
        log.push(SB.M("原生竖排 lineOrientation：%1", (LY.supportsNativeVertical(td) ? SB.M("支持（AE 2024+）") : SB.M("不支持 → 使用换行降级方案"))));
        if (LY.fontsAvailable()) {
            log.push(SB.M("系统字体数量：%1", (function () {
                try { return app.fonts.allFonts.length; } catch (e) { return SB.M("读取失败"); }
            })()));
        } else {
            log.push(SB.M("系统字体数量：app.fonts 不可用（AE 2023 没有这个 API）→ 字体下拉框会退化成常见字体清单，不指定字体时保留图层原字体"));
        }
        log.push(SB.M("自动挑到的中文字体：%1", (function () {
            var g = LY.guessChineseFont();
            return g === "" ? SB.M("（没挑到，将保留原字体）") : g;
        })()));

        return log;
    };

    root.Layers = LY;
})();
