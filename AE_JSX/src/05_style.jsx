/* ============================================================================
 *  05_style.jsx —— 参考图层「样式 / 效果 / 关键帧」批量同步
 *  ---------------------------------------------------------------------------
 *  核心是一个递归的属性深拷贝：
 *      属性组  → 递归子属性
 *      普通属性 → 关键帧（含插值、缓动、空间切线）或静态值 + 表达式
 *
 *  能复制的：
 *    · 文字样式（字体/字号/填充/描边/行距/字距/对齐…）—— 保留各自文本
 *    · 变换（锚点/位置/缩放/旋转/不透明度/倾斜）含关键帧
 *    · 效果（特效栈）+ 每个参数的参数关键帧
 *    · 表达式
 *    · 蒙版（含蒙版路径关键帧、模式、反转、羽化）
 *    · 文字动画器（含选择器与关键帧）
 *    · 图层属性（混合模式 / 3D 图层 / 运动模糊 / 折叠变换 / 自动定向）
 *
 *  不能复制的（AE 脚本的硬限制，只能手动）：
 *    · 图层样式（Layer Styles，如投影/外发光）
 *    · 内容识别填充、Roto 笔刷
 *    · 父级关系（不同合成里索引含义不同，不能盲抄）
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var LY = root.Layers;
    var ST = {};

    ST.TEXT_STYLE_KEYS = [
        "font", "fontSize", "fontFamily", "fontStyle",
        "fillColor", "applyFill",
        "strokeColor", "applyStroke", "strokeWidth", "strokeOverFill", "lineJoin", "miterLimit",
        "tracking", "leading", "autoLeading",
        "justification",
        "fauxBold", "fauxItalic", "allCaps", "smallCaps",
        "baselineShift", "horizontalScale", "verticalScale",
        "tsume", "ligatures", "noBreak", "digitSet",
        "spaceBefore", "spaceAfter", "firstLineIndent", "leftMargin", "rightMargin",
        "baselineDirection", "composerEngine"
    ];

    ST.defaultOptions = function () {
        return {
            textStyle: true,
            keepText: true,
            transform: true,
            transformParts: {
                anchor: false, position: true, scale: true, rotation: true,
                opacity: true, skew: false, orientation: true
            },
            keyframes: true,
            keyframeInterpolation: true,
            keyframeEase: true,
            values: true,
            expressions: true,
            effects: true,
            replaceEffects: true,
            masks: false,
            replaceMasks: true,
            textAnimators: true,
            layerProps: true,
            skipRef: true,
            onlyTextLayers: true,
            /* 关键帧对时：抄过去的关键帧原本是**绝对时间**，
             * 必须重映射到目标图层自己的入点/出点，否则动画会落在可见范围之外。 */
            remapKeys: true,
            remapMode: "scale",   // scale | shift | none

            /* ---- 双语图层（「各占一个图层」生成出来的成对图层）----
             * 默认全部照抄，那就跟以前一样：成对的原文/译文会被压到同一个点上重叠。
             * 想要「原文一层、译文一层各就各位」，用下面三个。 */
            biScope: "all",       // all | same（只跟参考层同组）| other（只另一组）
            biPos: "follow",      // follow（照抄，会重叠）| stagger（保留上下错位）| keep（完全不动位置）
            biStep: 0,            // stagger 用的行距(px)；0 = 自动（字号 × 1.25）
            refLayer2: null       // 另一组用第二个参考层（可为 null）
        };
    };

    /* ------------------------------------------------------------------ 基础工具 */

    function safe(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    /* 属性维度不一致之类的问题会批量报错，只留前若干条，避免刷屏 */
    var MAX_ERRORS = 25;
    function addError(ctx, message) {
        if (ctx.errors.length < MAX_ERRORS) {
            ctx.errors.push(message);
        } else if (ctx.errors.length === MAX_ERRORS) {
            ctx.errors.push(SB.M("…… 还有更多错误已省略"));
        }
    }

    function propType(p) {
        return safe(function () { return p.propertyType; }, -1);
    }

    function clearKeys(p) {
        var guard = 0;
        try {
            while (p.numKeys > 0 && guard < 5000) {
                p.removeKey(p.numKeys);
                guard++;
            }
        } catch (e) { }
    }

    function isGroupType(t) {
        if (typeof PropertyType === "undefined") {
            return t === 2 || t === 3;
        }
        return t === PropertyType.INDEXED_GROUP || t === PropertyType.NAMED_GROUP;
    }

    function isPropertyType(t) {
        if (typeof PropertyType === "undefined") { return t === 1; }
        return t === PropertyType.PROPERTY;
    }

    /* ------------------------------------------------------------------ 递归深拷贝 */

    ST.copyGroup = function (srcGroup, dstGroup, opts, ctx) {
        var n = 0;
        var count = safe(function () { return srcGroup.numProperties; }, 0);
        for (var i = 1; i <= count; i++) {
            var sp = safe(function () { return srcGroup.property(i); }, null);
            if (!sp) { continue; }

            var dp = safe(function () { return dstGroup.property(i); }, null);
            var mn = "";
            if (!dp) {
                // 顺序对不上时按 matchName 找
                mn = safe(function () { return sp.matchName; }, "");
                if (mn) { dp = safe(function () { return dstGroup.property(mn); }, null); }
            }
            if (!dp && ctx.addMissing) {
                /* 目标里**根本没有**这个子属性 —— 脚本新建的「文字动画器」就是这种情况：
                 * 建出来是空的，没有动画器属性、也没有选择器，只按索引/matchName 找的话
                 * 一个都找不到，复制出来就是个空壳（界面上有「动画器」，但完全没动画）。
                 * 所以这里允许调用方补一个 addMissing：缺就 addProperty 加出来。 */
                dp = safe(function () { return ctx.addMissing(dstGroup, sp); }, null);
            }
            if (!dp) { continue; }

            n += ST.copyProperty(sp, dp, opts, ctx);
        }
        return n;
    };

    ST.copyProperty = function (sp, dp, opts, ctx) {
        if (!sp || !dp) { return 0; }
        var t = propType(sp);
        if (t < 0) { return 0; }

        if (isGroupType(t)) { return ST.copyGroup(sp, dp, opts, ctx); }
        if (!isPropertyType(t)) { return 0; }

        var matchName = safe(function () { return sp.matchName; }, "");

        // 源文本永远不在这里复制，否则字幕会被参考图层的文字覆盖
        if (matchName === LY.MATCH.TEXT_DOCUMENT) { return 0; }
        if (ctx.skip[matchName]) { return 0; }

        var did = 0;

        /* ---- 关键帧 ---- */
        var numKeys = safe(function () { return sp.numKeys; }, 0);
        if (opts.keyframes && numKeys > 0) {
            try {
                clearKeys(dp);
                var k;
                for (k = 1; k <= numKeys; k++) {
                    var kt = sp.keyTime(k);
                    var kv = sp.keyValue(k);
                    dp.setValueAtTime(kt, kv);
                }
                // 插值 / 缓动：按 keyTime 找目标上的对应帧
                for (k = 1; k <= numKeys; k++) {
                    var t2 = sp.keyTime(k);
                    var di = safe(function () { return dp.nearestKeyIndex(t2); }, k);
                    if (!di) { continue; }

                    if (opts.keyframeInterpolation) {
                        safe(function () {
                            dp.setInterpolationTypeAtKey(di, sp.keyInInterpolationType(k), sp.keyOutInterpolationType(k));
                        });
                    }
                    if (opts.keyframeEase) {
                        safe(function () {
                            dp.setTemporalEaseAtKey(di, sp.keyInTemporalEase(k), sp.keyOutTemporalEase(k));
                        });
                    }
                    var spatial = safe(function () { return sp.isSpatial; }, false);
                    if (spatial && opts.keyframeEase) {
                        safe(function () {
                            dp.setSpatialTangentsAtKey(di, sp.keyInSpatialTangent(k), sp.keyOutSpatialTangent(k));
                        });
                    }
                }
                did = 1;
            } catch (e) {
                addError(ctx, SB.M("关键帧复制失败（%1）：%2", (matchName || "unknown"), e.toString()));
            }
        } else if (opts.values) {
            /* ---- 静态值 ---- */
            try {
                var dstKeys = safe(function () { return dp.numKeys; }, 0);
                var sv = sp.value;
                if (dstKeys === 0 && ST.samePropValue(safe(function () { return dp.value; }, null), sv)) {
                    /* 目标没关键帧、值又已经一样 —— 省一次写入。
                     * 45 层 × 十几个属性，省下来的这些都是实打实的等待时间。 */
                } else {
                    clearKeys(dp);
                    dp.setValue(sv);
                    did = 1;
                }
            } catch (e2) {
                // 维度不一致（例如 3D 位置拷到 2D 图层）时会抛错，忽略即可
            }
        }

        /* ---- 表达式 ----
         * 只在「源和目标真的不一样」时才写。以前是无差别 dp.expression = ""，
         * 45 层 × 十几个属性就是几百次无谓写入，每一次 AE 都要过一遍表达式引擎
         * —— 这是同步时面板卡住好几秒的主要开销之一。 */
        if (opts.expressions) {
            try {
                var expr = safe(function () { return sp.expression; }, "");
                if (expr === null || expr === undefined) { expr = ""; }
                var dstExpr = safe(function () { return dp.expression; }, "");
                if (dstExpr === null || dstExpr === undefined) { dstExpr = ""; }
                if (expr !== dstExpr) {
                    dp.expression = expr;
                    if (expr !== "") {
                        dp.expressionEnabled = safe(function () { return sp.expressionEnabled; }, true);
                    }
                }
            } catch (e3) { }
        }

        return did;
    };

    /* ------------------------------------------------------------------ 文字样式 */

    /**
     * 文字样式是用户最想同步的一块，也**最容易静默失败**：
     * 以前外面套的是 safe()，一抛错连个痕都不留，日志还挺好看（属性项 630、
     * 动画器 45 一个不少），界面上就是「一点变化都没有」—— 用户报的就是这个。
     * 所以现在改成三道保险：
     *   ① 拿不到源/目标的「源文本」属性 → 明确记一条错误，不再悄悄跳过
     *   ② 某个字段写不进去 → 把字段名记下来
     *   ③ 写完回读校验：AE 有个老毛病，一次 setValue 里同时写多个字段时
     *      字号 / 字体 / 填充色可能被丢掉，所以发现没写进去就单独再补一次
     */
    ST.copyTextStyle = function (refLayer, tgtLayer, opts, ctx) {
        var sp = safe(function () {
            return refLayer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
        }, null);
        var dp = safe(function () {
            return tgtLayer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
        }, null);
        if (!sp || !dp) {
            addError(ctx, SB.M("文字样式整块跳过：读不到%1的「源文本」属性（这个图层不是文字图层？）", (!sp ? SB.M("参考层") : SB.M("目标层"))));
            return 0;
        }

        var s = sp.value;
        var d = dp.value;
        var copied = 0;

        for (var i = 0; i < ST.TEXT_STYLE_KEYS.length; i++) {
            var key = ST.TEXT_STYLE_KEYS[i];
            var v = undefined;
            try { v = s[key]; } catch (e) { v = undefined; }
            if (v === undefined || v === null) { continue; }
            try {
                d[key] = v;
                copied++;
            } catch (e2) {
                /* AE 里 fontFamily / fontStyle / fauxBold / fauxItalic / allCaps /
                 * smallCaps 是**只读**的，脚本写不了。这是 AE 的限制不是 bug，
                 * 逐条报错会把真正的错误淹掉（实测 45 层直接刷出 26 条同样的提示），
                 * 所以只记「哪些字段被跳过」，最后汇总成一行。 */
                ctx.softSkips[key] = true;
            }
        }

        if (opts.keepText === false) { d.text = s.text; }

        try {
            dp.setValue(d);
        } catch (e3) {
            addError(ctx, SB.M("文字样式 setValue 失败：%1", e3.toString()));
            return 0;
        }

        ST.verifyTextStyle(sp, dp, ctx);
        return copied;
    };

    /**
     * 把参考层的文字样式一次性抽成「键-值」表。
     *
     * 为什么：以前每层都要重新读一遍 sp.value —— 45 层就是 45 次 TextDocument 拷贝
     * 加上千次属性读取，这是同步要跑 11 秒的大头之一。抽一次，后面层层套用。
     */
    ST.buildTextStyleCache = function (refLayer) {
        var cache = { ok: false, items: [], text: "" };
        var sp = safe(function () {
            return refLayer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
        }, null);
        if (!sp) { return cache; }
        var s = safe(function () { return sp.value; }, null);
        if (!s) { return cache; }
        cache.ok = true;
        cache.text = safe(function () { return s.text; }, "");
        for (var i = 0; i < ST.TEXT_STYLE_KEYS.length; i++) {
            var key = ST.TEXT_STYLE_KEYS[i];
            var v = safe(function () { return s[key]; }, undefined);
            if (v === undefined || v === null) { continue; }
            cache.items.push({ key: key, val: v });
        }
        return cache;
    };

    /** 把缓存套到目标层（保留目标自己的文字） */
    ST.applyTextStyleCache = function (cache, tgtLayer, opts, ctx) {
        if (!cache || !cache.ok) { return 0; }
        var dp = safe(function () {
            return tgtLayer.property(LY.MATCH.TEXT_PROPERTIES).property(LY.MATCH.TEXT_DOCUMENT);
        }, null);
        if (!dp) {
            addError(ctx, SB.M("文字样式：读不到目标层的「源文本」属性（不是文字图层？）"));
            return 0;
        }
        var d = safe(function () { return dp.value; }, null);
        if (!d) { return 0; }

        var written = 0;
        for (var i = 0; i < cache.items.length; i++) {
            var it = cache.items[i];
            try {
                d[it.key] = it.val;
                written++;
            } catch (e) {
                ctx.softSkips[it.key] = true;
            }
        }
        if (opts.keepText === false) { d.text = cache.text; }

        try {
            dp.setValue(d);
        } catch (e2) {
            addError(ctx, SB.M("文字样式 setValue 失败：%1", e2.toString()));
            return 0;
        }
        ST.verifyTextStyleCache(cache, dp);
        return written;
    };

    /** 写完回读：字号 / 字体 / 填充色没生效就单独再写一遍（AE 一次 setValue 会丢字段的老毛病） */
    ST.verifyTextStyleCache = function (cache, dp) {
        var back = safe(function () { return dp.value; }, null);
        if (!back) { return; }
        var miss = [];
        for (var i = 0; i < cache.items.length; i++) {
            var it = cache.items[i];
            if (it.key !== "fontSize" && it.key !== "font" && it.key !== "fillColor") { continue; }
            try {
                if (ST.samePropValue(back[it.key], it.val)) { continue; }
                miss.push(it);
            } catch (e) { }
        }
        if (miss.length === 0) { return; }
        try {
            var d = dp.value;
            for (var j = 0; j < miss.length; j++) { d[miss[j].key] = miss[j].val; }
            dp.setValue(d);
        } catch (e2) { }
    };

    /** 两个属性值是不是已经一样（数组要逐元素比，Point 之类比不了就当作不一样） */
    ST.samePropValue = function (a, b) {
        try {
            if (a === b) { return true; }
            if (a === null || a === undefined || b === null || b === undefined) { return false; }
            if (typeof a === "number" || typeof a === "boolean" || typeof a === "string") {
                return String(a) === String(b);
            }
            if (typeof a.length === "number" && typeof b.length === "number") {
                if (a.length !== b.length) { return false; }
                for (var i = 0; i < a.length; i++) {
                    var x = a[i], y = b[i];
                    if (typeof x === "number" && typeof y === "number") {
                        if (Math.abs(x - y) > 0.0005) { return false; }
                    } else if (String(x) !== String(y)) { return false; }
                }
                return true;
            }
        } catch (e) { }
        return false;
    };

    /**
     * 写完回读，关键字段没生效就单独再写一遍。
     * AE 的已知毛病：一次 setValue 里同时改多个字段时，字号 / 字体有时会被丢掉。
     */
    ST.verifyTextStyle = function (sp, dp, ctx) {
        var s = safe(function () { return sp.value; }, null);
        var back = safe(function () { return dp.value; }, null);
        if (!s || !back) { return; }

        var miss = [];
        try {
            if (Math.abs(back.fontSize - s.fontSize) > 0.001) { miss.push("fontSize"); }
        } catch (eF) { }
        try {
            if (String(s.font) !== "" && String(back.font) !== String(s.font)) { miss.push("font"); }
        } catch (eN) { }
        try {
            var bc = back.fillColor, sc = s.fillColor;
            if (bc && sc && (Math.abs(bc[0] - sc[0]) > 0.002 ||
                Math.abs(bc[1] - sc[1]) > 0.002 || Math.abs(bc[2] - sc[2]) > 0.002)) {
                miss.push("fillColor");
            }
        } catch (eC) { }
        if (miss.length === 0) { return; }

        try {
            var d = dp.value;
            for (var i = 0; i < miss.length; i++) { d[miss[i]] = s[miss[i]]; }
            dp.setValue(d);
        } catch (e) {
            addError(ctx, SB.M("文字样式写完回读对不上（%1），补写也失败：%2", miss.join("/"), e.toString()));
        }
    };

    /* ------------------------------------------------------------------ 效果 */

    ST.copyEffects = function (refLayer, tgtLayer, opts, ctx) {
        var src = safe(function () { return refLayer.property(LY.MATCH.EFFECTS); }, null);
        var dst = safe(function () { return tgtLayer.property(LY.MATCH.EFFECTS); }, null);
        if (!src || !dst) {
            /* 以前这里是静默 return 0：日志上「效果：0」，界面上一个效果都没加，
             * 用户完全无从判断是「参考层本来就没效果」还是「没复制过去」。必须说话。 */
            addError(ctx, SB.M("效果整块跳过：读不到%1的效果组（ADBE Effect Parade）", (!src ? SB.M("参考层") : SB.M("目标层"))));
            return 0;
        }

        if (opts.replaceEffects) {
            for (var d = dst.numProperties; d >= 1; d--) {
                safe(function () { dst.property(d).remove(); });
            }
        }

        var added = 0;
        for (var i = 1; i <= src.numProperties; i++) {
            var sp = safe(function () { return src.property(i); }, null);
            if (!sp) { continue; }
            var mn = safe(function () { return sp.matchName; }, "");
            var dp = safe(function () { return dst.addProperty(mn); }, null);
            if (!dp) {
                ctx.errors.push(SB.M("无法添加效果：%1", safe(function () { return sp.name; }, mn)));
                continue;
            }
            safe(function () { dp.name = sp.name; });
            ST.copyProperty(sp, dp, opts, ctx);
            added++;
        }
        return added;
    };

    /* ------------------------------------------------------------------ 蒙版 */

    ST.copyMasks = function (refLayer, tgtLayer, opts, ctx) {
        var src = safe(function () { return refLayer.property(LY.MATCH.MASKS); }, null);
        var dst = safe(function () { return tgtLayer.property(LY.MATCH.MASKS); }, null);
        if (!src || !dst) { return 0; }

        if (opts.replaceMasks) {
            for (var d = dst.numProperties; d >= 1; d--) {
                safe(function () { dst.property(d).remove(); });
            }
        }

        var added = 0;
        for (var i = 1; i <= src.numProperties; i++) {
            var sp = safe(function () { return src.property(i); }, null);
            if (!sp) { continue; }
            var dp = safe(function () { return dst.addProperty("ADBE Mask Atom"); }, null);
            if (!dp) { continue; }

            safe(function () { dp.maskMode = sp.maskMode; });
            safe(function () { dp.inverted = sp.inverted; });
            safe(function () { dp.maskFeatherFalloff = sp.maskFeatherFalloff; });
            safe(function () { dp.maskMotionBlur = sp.maskMotionBlur; });
            ST.copyProperty(sp, dp, opts, ctx);
            added++;
        }
        return added;
    };

    /* ------------------------------------------------------------------ 文字动画器 */

    ST.copyTextAnimators = function (refLayer, tgtLayer, opts, ctx) {
        var srcRoot = safe(function () { return refLayer.property(LY.MATCH.TEXT_PROPERTIES); }, null);
        var dstRoot = safe(function () { return tgtLayer.property(LY.MATCH.TEXT_PROPERTIES); }, null);
        if (!srcRoot || !dstRoot) { return 0; }
        var src = safe(function () { return srcRoot.property(LY.MATCH.TEXT_ANIMATORS); }, null);
        var dst = safe(function () { return dstRoot.property(LY.MATCH.TEXT_ANIMATORS); }, null);
        if (!src || !dst) { return 0; }

        for (var d = dst.numProperties; d >= 1; d--) {
            safe(function () { dst.property(d).remove(); });
        }

        var added = 0;
        for (var i = 1; i <= src.numProperties; i++) {
            var sp = safe(function () { return src.property(i); }, null);
            if (!sp) { continue; }
            var dp = safe(function () { return dst.addProperty("ADBE Text Animator"); }, null);
            if (!dp) {
                addError(ctx, SB.M("文字动画器加不进去（ADBE Text Animator）"));
                continue;
            }
            safe(function () { dp.name = sp.name; });

            /* 关键：脚本 addProperty 建出来的动画器是**空的** —— 没有「动画器属性」、
             * 也没有「范围选择器」。所以必须带一个 addMissing，让递归复制时
             * 能把这些子属性一个个 addProperty 加出来（不透明度 / 位置 / 缩放 …，
             * 以及范围选择器本身和它的 Start / End / Offset / 高级）。
             * 少了这一步，复制过去的就是个空壳：图层上多了个「动画器」，
             * 但一点动画都没有 —— 用户说的「Transporter 预设没应用过去」就是它。 */
            var sub = {
                skip: ctx.skip,
                errors: ctx.errors,
                softSkips: ctx.softSkips,
                addMissing: function (parent, srcProp) {
                    var smn = safe(function () { return srcProp.matchName; }, "");
                    if (!smn) { return null; }
                    var np = safe(function () { return parent.addProperty(smn); }, null);
                    if (np) {
                        safe(function () { np.name = srcProp.name; });
                        return np;
                    }
                    addError(ctx, SB.M("动画器子属性加不进去：%1（%2）", safe(function () { return srcProp.name; }, smn), smn));
                    return null;
                }
            };

            // 动画器自己的属性 / 选择器都是子组，递归复制
            ST.copyProperty(sp, dp, opts, sub);
            added++;
        }
        return added;
    };

    /* ------------------------------------------------------------------ 图层属性 */

    ST.copyLayerProps = function (refLayer, tgtLayer, opts, ctx) {
        var n = 0;
        function cp(getter, setter) {
            var v = safe(getter, undefined);
            if (v === undefined) { return; }
            var done = safe(function () { setter(v); return true; }, false);
            if (done) { n++; }
        }
        cp(function () { return refLayer.blendingMode; }, function (v) { tgtLayer.blendingMode = v; });
        cp(function () { return refLayer.threeDLayer; }, function (v) { tgtLayer.threeDLayer = v; });
        cp(function () { return refLayer.motionBlur; }, function (v) { tgtLayer.motionBlur = v; });
        cp(function () { return refLayer.collapseTransformation; }, function (v) { tgtLayer.collapseTransformation = v; });
        cp(function () { return refLayer.autoOrient; }, function (v) { tgtLayer.autoOrient = v; });
        cp(function () { return refLayer.frameBlending; }, function (v) { tgtLayer.frameBlending = v; });
        cp(function () { return refLayer.label; }, function (v) { tgtLayer.label = v; });
        return n;
    };

    /* ------------------------------------------------------------------ 图层样式 */

    /**
     * 探一下「图层样式」（投影 / 描边 / 外发光 / 斜面…）有几个。
     *
     * 必须说清楚：AE 的脚本接口**根本没开放图层样式** —— 它既不在「效果」组里、
     * 也不在变换里，读不到也写不了。用户把描边做在「图层样式 → 描边」上，
     * 然后发现同步过去没有描边，就是这个原因，不是脚本漏了。
     * 探得到就把数量报出来，好让提示说得有凭有据。返回 -1 = 探不到。
     */
    ST.countLayerStyles = function (layer) {
        try {
            var g = layer.property("ADBE Layer Styles");
            if (g && typeof g.numProperties === "number") { return g.numProperties; }
        } catch (e) { }
        return -1;
    };

    /* ================================================================== 关键帧对时 */

    /**
     * 为什么需要这一段：
     *
     * 复制关键帧时抄的是**绝对时间**。参考图层（比如第 5 层）的效果关键帧在
     * 3.0s / 3.5s / 4.0s，抄到第 1 层（入点 120s）上还是在 3.0s / 3.5s / 4.0s ——
     * 于是动画全落在这一层可见范围之外，看上去就是「效果复制过去了但没反应」
     * 或者「动画出现在错误的时间点上」。
     *
     * 用户要的是：动画应该跟着**每个文字图层自己的入点/出点**走。
     * 所以抄完之后要把关键帧的时间重映射过去：
     *   scale（默认）：按「参考层时长」缩放到「目标层时长」—— 长短句都能对齐
     *   shift        ：整体平移，保持原来的节奏长度
     *   none         ：不动（旧行为）
     */
    function remapTime(t, srcIn, srcOut, dstIn, dstOut, mode) {
        if (mode === "shift") { return t + (dstIn - srcIn); }
        var srcDur = srcOut - srcIn;
        if (srcDur <= 0.0001) { return t + (dstIn - srcIn); }
        var ratio = (t - srcIn) / srcDur;
        return dstIn + ratio * (dstOut - dstIn);
    }

    /** 把单个属性上的关键帧时间整体重映射，返回搬动的关键帧个数 */
    ST.remapPropertyKeys = function (p, srcIn, srcOut, dstIn, dstOut, mode) {
        if (!p || mode === "none") { return 0; }
        var numKeys = safe(function () { return p.numKeys; }, 0);
        if (numKeys < 1) { return 0; }

        /* 先把所有帧连同插值/缓动**全部读出来**再重写 ——
         * 一边删一边读的话索引会乱，缓动也会丢。 */
        var recs = [];
        for (var k = 1; k <= numKeys; k++) {
            var rec = { t: 0, v: null };
            try { rec.t = p.keyTime(k); } catch (e0) { continue; }
            try { rec.v = p.keyValue(k); } catch (e1) { continue; }
            try { rec.inType = p.keyInInterpolationType(k); } catch (e2) { }
            try { rec.outType = p.keyOutInterpolationType(k); } catch (e3) { }
            try { rec.inEase = p.keyInTemporalEase(k); } catch (e4) { }
            try { rec.outEase = p.keyOutTemporalEase(k); } catch (e5) { }
            try { rec.spatial = p.isSpatial; } catch (e6) { rec.spatial = false; }
            if (rec.spatial) {
                try { rec.inTan = p.keyInSpatialTangent(k); } catch (e7) { }
                try { rec.outTan = p.keyOutSpatialTangent(k); } catch (e8) { }
            }
            recs.push(rec);
        }
        if (recs.length === 0) { return 0; }

        /* 两种模式都是单调递增的，所以删完重建后帧序号仍然一一对应 */
        clearKeys(p);
        for (var j = 0; j < recs.length; j++) {
            try { p.setValueAtTime(remapTime(recs[j].t, srcIn, srcOut, dstIn, dstOut, mode), recs[j].v); }
            catch (eSet) { }
        }
        for (var m = 0; m < recs.length; m++) {
            var nt = remapTime(recs[m].t, srcIn, srcOut, dstIn, dstOut, mode);
            var di = safe(function () { return p.nearestKeyIndex(nt); }, 0);
            if (!di || di < 1) { continue; }
            if (recs[m].inType !== undefined && recs[m].outType !== undefined) {
                safe(function () { p.setInterpolationTypeAtKey(di, recs[m].inType, recs[m].outType); });
            }
            if (recs[m].inEase !== undefined && recs[m].outEase !== undefined) {
                safe(function () { p.setTemporalEaseAtKey(di, recs[m].inEase, recs[m].outEase); });
            }
            if (recs[m].spatial && recs[m].inTan !== undefined && recs[m].outTan !== undefined) {
                safe(function () { p.setSpatialTangentsAtKey(di, recs[m].inTan, recs[m].outTan); });
            }
        }
        return recs.length;
    };

    /** 递归重映射一个属性组（变换 / 文字属性 / 效果 / 蒙版 …） */
    ST.remapGroupKeys = function (group, srcIn, srcOut, dstIn, dstOut, mode) {
        var n = 0;
        if (!group || mode === "none") { return 0; }
        var count = safe(function () { return group.numProperties; }, 0);
        for (var i = 1; i <= count; i++) {
            var p = safe(function () { return group.property(i); }, null);
            if (!p) { continue; }
            var t = propType(p);
            if (isGroupType(t)) {
                n += ST.remapGroupKeys(p, srcIn, srcOut, dstIn, dstOut, mode);
            } else if (isPropertyType(t)) {
                n += ST.remapPropertyKeys(p, srcIn, srcOut, dstIn, dstOut, mode);
            }
        }
        return n;
    };

    /**
     * 把整个图层上的关键帧从 [srcIn, srcOut] 重映射到 [dstIn, dstOut]。
     * 覆盖 变换 / 文字属性（含动画器）/ 效果 / 蒙版。
     * 返回 { keys: 搬了多少个关键帧, groups: 进了几个组 }
     */
    ST.remapLayerKeys = function (layer, srcIn, srcOut, dstIn, dstOut, mode) {
        var out = { keys: 0, groups: 0 };
        if (!layer || mode === "none") { return out; }
        var names = [LY.MATCH.TRANSFORM, LY.MATCH.TEXT_PROPERTIES,
            LY.MATCH.EFFECTS, LY.MATCH.MASKS];
        for (var i = 0; i < names.length; i++) {
            var g = safe(function () { return layer.property(names[i]); }, null);
            if (!g) { continue; }
            out.groups++;
            out.keys += ST.remapGroupKeys(g, srcIn, srcOut, dstIn, dstOut, mode);
        }
        return out;
    };

    /* ------------------------------------------------------------------ 主流程 */

    function buildContext(opts) {
        var skip = {};
        skip[LY.MATCH.TEXT_DOCUMENT] = true;
        skip[LY.MATCH.EFFECTS] = true;
        skip[LY.MATCH.MASKS] = true;
        skip[LY.MATCH.TEXT_ANIMATORS] = true;

        var parts = opts.transformParts || {};
        if (parts.anchor === false) { skip["ADBE Anchor Point"] = true; }
        if (parts.position === false) { skip["ADBE Position"] = true; }
        if (parts.scale === false) { skip["ADBE Scale"] = true; }
        if (parts.rotation === false) { skip["ADBE Rotate Z"] = true; }
        if (parts.opacity === false) { skip["ADBE Opacity"] = true; }
        if (parts.skew === false) { skip["ADBE Skew"] = true; }
        if (parts.orientation === false) {
            skip["ADBE Orientation"] = true;
            skip["ADBE Rotate X"] = true;
            skip["ADBE Rotate Y"] = true;
        }

        return { skip: skip, errors: [], softSkips: {}, styleCache: null };
    }

    ST.applyToLayer = function (refLayer, tgtLayer, opts, ctx, report, slot) {
        if (opts.textStyle) {
            /* 这里**不能**再用 safe() 包：一抛错就无声无息，日志好看但界面没变化。
             * 必须记一条错误，用户才知道「文字样式这块根本没跑」。
             * 另外参考层的文字样式只抽一次（45 层各读一遍是同步慢的大头）。
             *
             * slot 用来分开「主参考层」和「第二参考层」两份缓存 ——
             * 双语另一组用的是另一份样式，不能共用一个 cache 串味。 */
            var ck = "styleCache" + (slot || "");
            try {
                if (!ctx[ck]) { ctx[ck] = ST.buildTextStyleCache(refLayer); }
                if (!ctx[ck].ok) {
                    addError(ctx, SB.M("文字样式整块跳过：读不到参考层的「源文本」属性（参考层不是文字图层？）"));
                } else {
                    report.textStyles += ST.applyTextStyleCache(ctx[ck], tgtLayer, opts, ctx);
                }
            } catch (eTS) {
                addError(ctx, SB.M("文字样式同步失败（整块跳过）：%1", eTS.toString()));
            }
            // 文字「更多选项」等（不含动画器，动画器单独处理）
            var srcText = safe(function () { return refLayer.property(LY.MATCH.TEXT_PROPERTIES); }, null);
            var dstText = safe(function () { return tgtLayer.property(LY.MATCH.TEXT_PROPERTIES); }, null);
            if (srcText && dstText) {
                report.props += ST.copyGroup(srcText, dstText, opts, ctx);
            }
        }
        if (opts.transform) {
            var srcTf = safe(function () { return refLayer.property(LY.MATCH.TRANSFORM); }, null);
            var dstTf = safe(function () { return tgtLayer.property(LY.MATCH.TRANSFORM); }, null);
            if (srcTf && dstTf) {
                report.props += ST.copyGroup(srcTf, dstTf, opts, ctx);
            }
        }
        if (opts.effects) {
            report.effects += ST.copyEffects(refLayer, tgtLayer, opts, ctx);
        }
        if (opts.masks) {
            report.masks += ST.copyMasks(refLayer, tgtLayer, opts, ctx);
        }
        if (opts.textAnimators && (tgtLayer instanceof TextLayer)) {
            report.animators += ST.copyTextAnimators(refLayer, tgtLayer, opts, ctx);
        }
        if (opts.layerProps) {
            report.props += ST.copyLayerProps(refLayer, tgtLayer, opts, ctx);
        }
    };

    /**
     * 把参考图层的样式批量应用到指定图层号上。
     * @param comp          目标合成
     * @param refLayer      参考图层（Layer 对象）
     * @param targetIndices 图层号数组，如 [1,2,3,7,9]
     * @param opts          见 defaultOptions()
     */
    ST.applyToLayers = function (comp, refLayer, targetIndices, opts) {
        var o = ST.defaultOptions();
        if (opts) {
            for (var k in opts) {
                if (opts.hasOwnProperty && opts.hasOwnProperty(k)) { o[k] = opts[k]; }
            }
        }

        var report = {
            layers: 0, skipped: 0, props: 0, effects: 0, masks: 0,
            animators: 0, textStyles: 0, errors: [], layerNames: [], ms: 0, softSkips: [],
            remapped: 0, scopeSkipped: 0, staggered: 0, groups: { same: 0, other: 0 }
        };
        if (!comp || !refLayer || !targetIndices || targetIndices.length === 0) {
            return report;
        }

        /* ---------------------------------------------------------- 双语分组
         *
         * 「各占一个图层」生成出来的是原文/译文成对的两层。如果这一步照抄参考层
         * 的位置，两层会被压到同一个点上完全重叠 —— 用户看到的就是「所有字幕
         * 跑到一起了」。所以要先把每层的「角色」认出来：
         *   ① 图层备注里的 [ST] 标记（本脚本生成时写的）→ 直接读组内序号
         *   ② 没标记 → 比文字体系（日文带假名 / 中文只有汉字，分得很干净）
         */
        var biScope = o.biScope || "all";
        var biPos = o.biPos || "follow";
        var ref2 = o.refLayer2 || null;

        /* 「完全不动位置」最省事的做法是直接把 Position 加进跳过名单 ——
         * 位置压根不参与复制，比「抄完再改回去」稳（后者遇到关键帧还得逐帧还原）。 */
        if (biPos === "keep" && o.transformParts) { o.transformParts.position = false; }

        var baseSub = 0;
        try { baseSub = LY.roleOf(refLayer, refLayer).sub; } catch (eR0) { }

        var ctx = buildContext(o);

        /**
         * 进度回调。
         *
         * 为什么要：同步是**同步阻塞**的，主线程占满期间 ScriptUI 不重绘，
         * 面板看上去就是「卡死」，等 AE 缓过来窗口还可能被推到后面（用户看到的就是
         * 「面板卡了一会儿又消失了，得点任务栏才回来」）。加个回调让界面能
         * 一层层报进度，至少面板不会像死了一样。
         */
        function progress(done, total, name) {
            if (typeof o.onProgress !== "function") { return; }
            try { o.onProgress(done, total, name); } catch (eP) { }
        }

        var t0 = (new Date()).getTime();
        app.beginUndoGroup(SB.M("同步字幕样式"));
        try {
            for (var i = 0; i < targetIndices.length; i++) {
                var idx = targetIndices[i];
                var layer = safe(function () { return comp.layer(idx); }, null);
                if (!layer) { report.skipped++; continue; }
                if (o.skipRef && (layer === refLayer || (ref2 && layer === ref2))) {
                    report.skipped++; continue;
                }
                if (o.onlyTextLayers && !(layer instanceof TextLayer)) { report.skipped++; continue; }

                /* 双语分组：先认角色，再决定「要不要处理」「用哪个参考层」 */
                var role = null;
                try { role = LY.roleOf(layer, refLayer); } catch (eR1) { role = null; }
                if (role) {
                    if (role.sameAsRef) { report.groups.same++; } else { report.groups.other++; }
                }
                if (role && biScope === "same" && !role.sameAsRef) {
                    report.scopeSkipped++; continue;
                }
                if (role && biScope === "other" && role.sameAsRef) {
                    report.scopeSkipped++; continue;
                }
                var useRef = refLayer, slot = "";
                if (ref2 && role && !role.sameAsRef) { useRef = ref2; slot = "2"; }

                /* 锁定的图层 AE 一律拒绝写入，而每一次拒绝都会被 safe() 吞掉，
                 * 结果就是「日志很好看、界面没变化」。这里明说一句。 */
                if (safe(function () { return layer.locked; }, false)) {
                    report.skipped++;
                    addError(ctx, SB.M("第 %1 层「%2」是锁定状态，AE 不允许改，已跳过", idx, layer.name));
                    continue;
                }

                progress(i, targetIndices.length, "#" + idx + " " + layer.name);
                ST.applyToLayer(useRef, layer, o, ctx, report, slot);

                /* 双语错位：抄完位置之后，按「组内第几行」把这一层挪回它该在的高度。
                 *
                 * 只有在**没有第二参考层**时才需要做 —— 有 ref2 的话，那一组的位置
                 * 本来就该跟着 ref2 走（ref2 自己就摆在译文该在的位置上），再挪就错了。
                 * step 为 0 时按字号 × 1.25 自动算，跟生成时那条规则保持一致。 */
                if (biPos === "stagger" && !slot && role && role.sub !== baseSub) {
                    var stepPx = o.biStep;
                    if (!(stepPx > 0)) {
                        var fs = LY.fontSizeOf(layer);
                        stepPx = (fs > 0 ? fs : (o.fontSize || 60)) * 1.25;
                    }
                    if (LY.shiftLayerY(layer, (role.sub - baseSub) * stepPx)) {
                        report.staggered++;
                    }
                }

                /* 关键帧对时：抄过来的帧还在参考层的绝对时间点上，
                 * 得搬到这一层自己的入点/出点之间，否则动画看不见。 */
                if (o.remapKeys && o.remapMode !== "none") {
                    var rm = ST.remapLayerKeys(layer,
                        safe(function () { return useRef.inPoint; }, 0),
                        safe(function () { return useRef.outPoint; }, comp.duration),
                        safe(function () { return layer.inPoint; }, 0),
                        safe(function () { return layer.outPoint; }, comp.duration),
                        o.remapMode);
                    report.remapped += rm.keys;
                }

                report.layers++;
                report.layerNames.push("#" + idx + " " + layer.name);
            }
        } catch (e) {
            report.errors.push(SB.M("同步过程出错：%1", e.toString()));
        } finally {
            app.endUndoGroup();
        }
        report.ms = (new Date()).getTime() - t0;
        progress(targetIndices.length, targetIndices.length, "");

        for (var j = 0; j < ctx.errors.length; j++) {
            report.errors.push(ctx.errors[j]);
        }

        /* AE 的只读字段（fontFamily / fontStyle / fauxBold / fauxItalic / allCaps /
         * smallCaps …）每层都写不进去，逐层报错就是几百条重复信息。汇总成一行。 */
        var soft = [];
        for (var sk in ctx.softSkips) {
            if (ctx.softSkips.hasOwnProperty(sk)) { soft.push(sk); }
        }
        if (soft.length > 0) {
            report.softSkips = soft;
            report.errors.push(SB.M("（说明）这些文字样式字段 AE 不允许脚本改（只读），已跳过：%1", soft.join("、")));
        }
        return report;
    };

    /**
     * 「以参考图层重建」—— 用户说的 Ctrl+C / Ctrl+V。
     *
     * 和 applyToLayers（逐属性抄）的区别：这里是 refLayer.duplicate()，
     * 由 AE 自己在内部复制，**图层样式、效果、动画器、蒙版、表达式全都带得走**，
     * 包括脚本 API 读不到的图层样式。抄完只做三件事：
     *   ① 把目标层原来的文字写回去（只改 text，其它不动）
     *   ② 沿用目标层原来的入点/出点
     *   ③ 关键帧从参考层的时间范围重映射到目标层的时间范围
     * 然后放到目标层原来的位置，删掉旧的目标层。整个操作在一个撤销组里，Ctrl+Z 可撤。
     *
     * @param comp     目标合成
     * @param refLayer 参考图层
     * @param targets  要被替换的 Layer 对象数组（注意是对象不是编号，删层会让编号失效）
     * @param opts     { remapMode, keepName, onProgress }
     */
    ST.rebuildFromReference = function (comp, refLayer, targets, opts) {
        var o = opts || {};
        var mode = o.remapMode === undefined ? "scale" : o.remapMode;
        var report = { total: 0, ok: 0, remapped: 0, skipped: 0, errors: [] };
        if (!comp || !refLayer || !targets || targets.length === 0) { return report; }

        var rIn = 0, rOut = comp.duration;
        try { rIn = refLayer.inPoint; } catch (e0) { }
        try { rOut = refLayer.outPoint; } catch (e1) { }

        function progress(done, total) {
            if (typeof o.onProgress === "function") {
                try { o.onProgress(done, total); } catch (eP) { }
            }
        }

        app.beginUndoGroup(SB.M("以参考图层重建"));
        try {
            for (var i = 0; i < targets.length; i++) {
                var tgt = targets[i];
                report.total++;
                if (!tgt) { report.skipped++; continue; }
                if (tgt === refLayer) { report.skipped++; continue; }

                var oldText = LY.getLayerText(tgt);
                var oldName = "";
                try { oldName = tgt.name; } catch (eN) { }
                var tIn = 0, tOut = comp.duration;
                try { tIn = tgt.inPoint; } catch (e2) { }
                try { tOut = tgt.outPoint; } catch (e3) { }
                var wasLocked = false;
                try { wasLocked = tgt.locked; } catch (eL) { }
                if (wasLocked) { try { tgt.locked = false; } catch (eL2) { } }

                var dup = null;
                try { dup = refLayer.duplicate(); } catch (eD) {
                    report.errors.push(SB.M("「%1」复制失败：%2", oldName, eD.toString()));
                    report.skipped++;
                    continue;
                }

                /* ① 文字写回去（只改 text，保留参考层的字体/描边/样式） */
                if (oldText !== "") { LY.setLayerTextOnly(dup, oldText); }

                /* ② 沿用原来的入点出点 */
                try { dup.inPoint = tIn; } catch (eI) { }
                try { dup.outPoint = tOut; } catch (eO) { }

                /* ③ 关键帧对时 */
                if (mode !== "none") {
                    var rm = ST.remapLayerKeys(dup, rIn, rOut, tIn, tOut, mode);
                    report.remapped += rm.keys;
                }

                /* 放到原来那一层的位置，再删掉旧的 */
                try {
                    if (typeof dup.moveBefore === "function") { dup.moveBefore(tgt); }
                } catch (eM) { }
                try { dup.name = oldName === "" ? dup.name : oldName; } catch (eN2) { }
                try { tgt.remove(); } catch (eR) {
                    report.errors.push(SB.M("「%1」旧图层删除失败：%2", oldName, eR.toString()));
                }

                report.ok++;
                progress(report.ok, targets.length);
            }
        } catch (e) {
            report.errors.push(SB.M("重建中断：%1", e.toString()));
        } finally {
            app.endUndoGroup();
        }
        return report;
    };

    /** 只把「文字样式」套到一批图层上（保留各自文本），常用于字幕生成后统一字体 */
    ST.applyTextStyleOnly = function (comp, refLayer, targetIndices) {
        var o = ST.defaultOptions();
        o.transform = false;
        o.effects = false;
        o.masks = false;
        o.textAnimators = false;
        o.layerProps = false;
        o.values = false;
        o.keyframes = false;
        o.expressions = false;
        return ST.applyToLayers(comp, refLayer, targetIndices, o);
    };

    root.Style = ST;
})();
