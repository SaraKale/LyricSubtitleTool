/* ============================================================================
 *  08_preset.jsx —— 动画预设（内置预设 + 外部 .ffx）
 *  ---------------------------------------------------------------------------
 *  为什么要有这一块
 *  ----------------
 *  「从一个图层把样式/动画深拷贝到另一个图层」这条路有两个死穴：
 *    1) 图层样式（投影 / 描边 / 外发光 / 斜面）AE 的脚本接口不开放，读不到也写不了；
 *    2) 用 addProperty 新建的「文字动画器」默认是**空壳** —— 里面既没有动画器属性
 *       也没有范围选择器，而「递归复制已存在的属性」对空壳一律失效，
 *       结果是复制出 45 个叫「动画器」的空壳，界面上有、动画没有。
 *
 *  参考 P9 字幕脚本的做法：**不拷贝，改为重建**。
 *  P9 自带一份 动画预置.xml（15 套手写预设），生成图层时照着预设现场搭
 *  「文字动画器 + 范围选择器 + 关键帧」。本模块走同一条路，但用两条腿：
 *
 *    A) 内置预设   —— 脚本 addProperty 现场搭，开箱即用，不需要任何外部文件
 *    B) .ffx 预设  —— layer.applyPreset(File(...))，一步到位
 *                     .ffx 是 AE 自己的格式，**能把图层样式 / 效果 / 动画器
 *                     一起带走**，不受脚本接口限制 —— 这是要同步「图层样式」
 *                     的唯一可行办法。
 *
 *  关键 matchName（都是从 AE 里实测过的）
 *  ------------------------------------
 *    文字动画器      ADBE Text Animator
 *    动画器属性组    ADBE Text Animator Properties
 *    选择器组        ADBE Text Selectors
 *    范围选择器      ADBE Text Selector
 *    Start/End/Offset  ADBE Text Percent Start / Percent End / Percent Offset
 *    动画器属性      ADBE Text Opacity / Position 3D / Scale 3D / Rotation /
 *                    ADBE Text Blur / Skew / Fill Hue / Character Offset …
 *    关键帧插值      6012 = 线性， 6013 = 贝塞尔， 6014 = 保持
 *
 *  时间归一化：预设里的关键帧时间都写成 0~1（相对于这一句的时长），
 *              套用时再按每个图层自己的 inPoint/outPoint 换算。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var PR = {};

    var MN = {
        TEXTPROPS: "ADBE Text Properties",
        ANIMATORS: "ADBE Text Animators",
        ANIMATOR: "ADBE Text Animator",
        ANIM_PROPS: "ADBE Text Animator Properties",
        SELECTORS: "ADBE Text Selectors",
        SELECTOR: "ADBE Text Selector",
        P_START: "ADBE Text Percent Start",
        P_END: "ADBE Text Percent End",
        P_OFFSET: "ADBE Text Percent Offset",
        SMOOTH: "ADBE Text Selector Smoothness",
        TRANSFORM: "ADBE Transform Group"
    };

    var LINEAR = 6012, BEZIER = 6013, HOLD = 6014;

    /* ------------------------------------------------------------------ 工具 */

    function newCtx() { return { errors: [], notes: [], done: 0 }; }

    function clearKeys(p) {
        try {
            var guard = 0;
            while (p.numKeys > 0 && guard < 500) { p.removeKey(p.numKeys); guard++; }
        } catch (e) { }
    }

    /** 按 0~1 归一化时间打关键帧 */
    function setKeys(p, keys, inPt, dur, ctx, label) {
        clearKeys(p);
        for (var i = 0; i < keys.length; i++) {
            var t = inPt + keys[i][0] * dur;
            var v = keys[i][1];
            try {
                p.setValueAtTime(t, v);
            } catch (e1) {
                if (ctx) { ctx.errors.push(SB.M("打关键帧失败：%1 @%2（%3）", label, i, e1.toString())); }
                return;
            }
            try { p.setInterpolationTypeAtKey(i + 1, BEZIER, BEZIER); } catch (e2) { }
        }
    }

    /**
     * 取（或建）一个子属性。
     * 注意：AE 里 addProperty 造出来的容器（动画器、选择器…）默认都是空的，
     * 所以这里必须先「找」，找不到才「建」，不能直接假设它已经存在。
     */
    function ensureAdd(group, mn, ctx, what) {
        var p = null;
        try { p = group.property(mn); } catch (e0) { p = null; }
        if (p) { return p; }
        try { p = group.addProperty(mn); } catch (e1) { p = null; }
        if (!p && ctx) { ctx.errors.push(SB.M("无法添加%1：%2", (what || SB.M("属性")), mn)); }
        return p;
    }

    /* ------------------------------------------------------- 内置预设定义表 */

    /*
     * 结构：
     *   transform : [{ mn, keys:[[t0,v0],[t1,v1]…] }]   图层级（变换）关键帧
     *   animators : [{
     *       name,
     *       props   : [{ mn, v }]                        动画器属性（静态值）
     *       propKeys: [{ mn, keys:[[t,v]…] }]            动画器属性（自带关键帧）
     *       range   : { start, end, offset, smooth }     每个可以是数字或 [[t,v]…]
     *   }]
     *
     * 「逐字」效果的原理：动画器属性施加在**被选中**的字符上。
     * 让「未出场」的字符处于选中状态（被偏移/透明/模糊），
     * 再把 Start 从 0 推到 100 —— 字符陆续离开选区，就回到正常样子，看着像逐字入场。
     */
    /* 下面这些 name / tip 是**数据**，在桥接层用 SB.T() 现翻
     * （09_bridge 的 API.presets：SB.T(PR.BUILTIN[i].name)）。
     * 在这里翻会被「模块只在加载时求值一次」卡住，用户切语言时切不动。 */
    /* i18n-allow */
    PR.BUILTIN = [
        { id: "", name: "（不使用预设）", tip: "只生成/保留图层本身，不加动画" },

        {
            id: "fadeLine", name: "整句淡入淡出",
            tip: "整句一起淡入、淡出（图层不透明度）",
            transform: [
                { mn: "ADBE Opacity", keys: [[0, 0], [0.15, 100], [0.85, 100], [1, 0]] }
            ]
        },
        {
            id: "blurLine", name: "整句模糊出入",
            tip: "整句从模糊变清晰，再变模糊（文字动画器 → 模糊）",
            animators: [{
                name: "模糊出入",
                propKeys: [{ mn: "ADBE Text Blur", keys: [[0, 60], [0.25, 0], [0.75, 0], [1, 60]] }],
                range: { start: 0, end: 100 }
            }]
        },
        {
            id: "typewriter", name: "逐字淡入（打字机）",
            tip: "一个字一个字亮出来",
            animators: [{
                name: "逐字淡入",
                props: [{ mn: "ADBE Text Opacity", v: 0 }],
                range: { start: [[0, 0], [1, 100]], end: 100 }
            }]
        },
        {
            id: "charUp", name: "逐字上划淡入",
            tip: "字从下方 60px 处逐个滑上来并淡入",
            animators: [{
                name: "逐字上划",
                props: [
                    { mn: "ADBE Text Opacity", v: 0 },
                    { mn: "ADBE Text Position 3D", v: [0, 60, 0] }
                ],
                range: { start: [[0, 0], [1, 100]], end: 100, smooth: 0 }
            }]
        },
        {
            id: "charBlur", name: "逐字模糊入",
            tip: "字从模糊逐个变清晰",
            animators: [{
                name: "逐字模糊",
                props: [
                    { mn: "ADBE Text Opacity", v: 0 },
                    { mn: "ADBE Text Blur", v: 40 }
                ],
                range: { start: [[0, 0], [1, 100]], end: 100 }
            }]
        },
        {
            id: "charScale", name: "逐字缩放弹入",
            tip: "字从 10% 大小逐个弹到正常",
            animators: [{
                name: "逐字缩放",
                props: [
                    { mn: "ADBE Text Opacity", v: 0 },
                    { mn: "ADBE Text Scale 3D", v: [10, 10, 100] }
                ],
                range: { start: [[0, 0], [1, 100]], end: 100 }
            }]
        },
        {
            id: "charRotate", name: "逐字旋转入",
            tip: "字从 -90° 逐个转正",
            animators: [{
                name: "逐字旋转",
                props: [
                    { mn: "ADBE Text Opacity", v: 0 },
                    { mn: "ADBE Text Rotation", v: -90 }
                ],
                range: { start: [[0, 0], [1, 100]], end: 100 }
            }]
        },
        {
            id: "charDown3D", name: "逐字下落入（带纵深）",
            tip: "字从上方 + 远处（Z 轴 -400）逐个落位",
            animators: [{
                name: "逐字下落",
                props: [
                    { mn: "ADBE Text Opacity", v: 0 },
                    { mn: "ADBE Text Position 3D", v: [0, -120, -400] }
                ],
                range: { start: [[0, 0], [1, 100]], end: 100 }
            }]
        }
    ];
    /* i18n-allow-end */

    PR.findBuiltin = function (id) {
        if (!id) { return null; }
        for (var i = 1; i < PR.BUILTIN.length; i++) {
            if (PR.BUILTIN[i].id === id) { return PR.BUILTIN[i]; }
        }
        return null;
    };

    /* ---------------------------------------------------------- 内置：套用 */

    PR.clearAnimators = function (layer, ctx) {
        var n = 0;
        try {
            var tp = layer.property(MN.TEXTPROPS);
            var ag = tp ? tp.property(MN.ANIMATORS) : null;
            if (!ag) { return 0; }
            var guard = 0;
            while (ag.numProperties > 0 && guard < 50) {
                ag.property(ag.numProperties).remove();
                n++; guard++;
            }
        } catch (e) {
            if (ctx) { ctx.errors.push(SB.M("清除已有动画器失败：%1", e.toString())); }
        }
        return n;
    };

    function buildAnimator(layer, ad, inPt, dur, ctx) {
        var tp = layer.property(MN.TEXTPROPS);
        if (!tp) {
            ctx.errors.push(SB.M("「%1」不是文字图层，套不了文字动画器", layer.name));
            return 0;
        }
        var ag = tp.property(MN.ANIMATORS);
        if (!ag) {
            ctx.errors.push(SB.M("「%1」找不到「文字 → 动画器」组", layer.name));
            return 0;
        }

        var anim = null;
        try { anim = ag.addProperty(MN.ANIMATOR); } catch (e0) { anim = null; }
        if (!anim) {
            ctx.errors.push(SB.M("addProperty(ADBE Text Animator) 失败（%1）", e0));
            return 0;
        }
        try { anim.name = ad.name ? SB.M(ad.name) : SB.M("动画器"); } catch (eN) { }

        /* --- 动画器属性 --- */
        var apg = anim.property(MN.ANIM_PROPS);
        var i;
        if (ad.props && apg) {
            for (i = 0; i < ad.props.length; i++) {
                var pd = ad.props[i];
                var p = ensureAdd(apg, pd.mn, ctx, SB.M("动画器属性"));
                if (!p) { continue; }
                try { p.setValue(pd.v); } catch (e1) {
                    ctx.errors.push(SB.M("动画器属性赋值失败：%1（%2）", pd.mn, e1.toString()));
                }
            }
        }
        if (ad.propKeys && apg) {
            for (i = 0; i < ad.propKeys.length; i++) {
                var kd = ad.propKeys[i];
                var kp = ensureAdd(apg, kd.mn, ctx, SB.M("动画器属性"));
                if (!kp) { continue; }
                setKeys(kp, kd.keys, inPt, dur, ctx, kd.mn);
            }
        }

        /* --- 范围选择器 --- */
        if (ad.range) {
            var sg = anim.property(MN.SELECTORS);
            var sel = null;
            if (sg) {
                if (sg.numProperties > 0) {
                    sel = sg.property(1);       /* 新建的动画器有时自带一个空选择器 */
                } else {
                    try { sel = sg.addProperty(MN.SELECTOR); } catch (eS) { sel = null; }
                }
            }
            if (!sel) {
                ctx.errors.push(SB.M("无法取到/新建范围选择器"));
            } else {
                setRangeProp(sel, MN.P_START, ad.range.start, inPt, dur, ctx);
                setRangeProp(sel, MN.P_END, ad.range.end, inPt, dur, ctx);
                if (ad.range.offset !== undefined && ad.range.offset !== null) {
                    setRangeProp(sel, MN.P_OFFSET, ad.range.offset, inPt, dur, ctx);
                }
                if (ad.range.smooth !== undefined && ad.range.smooth !== null) {
                    var sp = null;
                    try { sp = sel.property(MN.SMOOTH); } catch (eSm) { }
                    if (sp) { try { sp.setValue(ad.range.smooth); } catch (eSm2) { } }
                }
            }
        }
        return 1;
    }

    function setRangeProp(sel, mn, spec, inPt, dur, ctx) {
        if (spec === undefined || spec === null) { return; }
        var p = null;
        try { p = sel.property(mn); } catch (e0) { p = null; }
        if (!p) { try { p = sel.addProperty(mn); } catch (e1) { p = null; } }
        if (!p) { ctx.errors.push(SB.M("范围选择器里找不到 %1", mn)); return; }
        if (typeof spec === "number") {
            try { p.setValue(spec); } catch (e2) {
                ctx.errors.push(SB.M("范围选择器赋值失败：%1（%2）", mn, e2.toString()));
            }
        } else {
            setKeys(p, spec, inPt, dur, ctx, mn);
        }
    }

    /**
     * 给一个图层套内置预设。
     * opts: { clearAnimators:bool, fallbackDur:number }
     */
    PR.applyBuiltin = function (layer, id, opts, ctx) {
        opts = opts || {};
        ctx = ctx || newCtx();
        var def = PR.findBuiltin(id);
        if (!def) { return 0; }

        var dur = 0;
        try { dur = layer.outPoint - layer.inPoint; } catch (e0) { dur = 0; }
        if (!(dur > 0.01)) { dur = opts.fallbackDur || 2; }
        var inPt = 0;
        try { inPt = layer.inPoint; } catch (e1) { inPt = 0; }

        var n = 0;
        var i;

        if (opts.clearAnimators) { PR.clearAnimators(layer, ctx); }

        if (def.transform) {
            var tg = layer.property(MN.TRANSFORM);
            for (i = 0; i < def.transform.length; i++) {
                var td = def.transform[i];
                var p = tg ? tg.property(td.mn) : null;
                if (!p) {
                    ctx.errors.push(SB.M("「%1」找不到变换属性 %2", layer.name, td.mn));
                    continue;
                }
                setKeys(p, td.keys, inPt, dur, ctx, td.mn);
                n++;
            }
        }

        if (def.animators) {
            for (i = 0; i < def.animators.length; i++) {
                n += buildAnimator(layer, def.animators[i], inPt, dur, ctx);
            }
        }
        return n;
    };

    /* ------------------------------------------------------- 外部 .ffx 预设 */

    /** 插件本体所在目录（ScriptUI Panels 里那个 jsx 的目录） */
    PR.scriptDir = function () {
        try {
            var f = new File($.fileName);
            return f.parent.fsName;
        } catch (e) { return ""; }
    };

    /** AE 自带的预设目录（Presets），可能不存在，调用方要判空 */
    PR.appPresetsDir = function () {
        try {
            var d = Folder.appPackage + "/Presets";
            var f = new Folder(d);
            return f.exists ? f.fsName : "";
        } catch (e) { return ""; }
    };

    PR.defaultDirs = function () {
        var out = [];
        var sd = PR.scriptDir();
        if (sd) {
            out.push(sd + "/预设"); // i18n-allow 目录名（要跟 ScriptUI Panels 下的实际文件夹对上），不是界面文案
            out.push(sd + "/Presets");
        }
        var ap = PR.appPresetsDir();
        if (ap) { out.push(ap); }
        return out;
    };

    /** 扫 .ffx。dirs 为空时用默认目录。maxDepth 控制递归层数。 */
    PR.scanFFX = function (dirs, maxDepth) {
        var out = [];
        if (!dirs || dirs.length === 0) { dirs = PR.defaultDirs(); }
        if (maxDepth === undefined || maxDepth === null) { maxDepth = 2; }
        var i, j, k;
        for (i = 0; i < dirs.length; i++) {
            var dir = dirs[i];
            if (!dir) { continue; }
            var folder = new Folder(dir);
            if (!folder.exists) { continue; }
            scanOne(folder, out, maxDepth, 0);
        }
        /* 去重（同名同路径只留一个） */
        var seen = {};
        var uniq = [];
        for (k = 0; k < out.length; k++) {
            var key = out[k].path.toLowerCase();
            if (seen[key]) { continue; }
            seen[key] = true;
            uniq.push(out[k]);
        }
        uniq.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
        return uniq;
    };

    function scanOne(folder, out, maxDepth, depth) {
        var files = null;
        try { files = folder.getFiles(); } catch (e) { return; }
        if (!files) { return; }
        var i;
        for (i = 0; i < files.length; i++) {
            var f = files[i];
            var name = "";
            try { name = f.name; } catch (eN) { continue; }
            if (f instanceof Folder) {
                if (depth + 1 < maxDepth) { scanOne(f, out, maxDepth, depth + 1); }
                continue;
            }
            if (/\.ffx$/i.test(name)) {
                out.push({ name: name.replace(/\.ffx$/i, ""), path: f.fsName });
            }
        }
    }

    /** 这套 AE 支不支持 applyPreset */
    PR.canApplyPreset = function (layer) {
        return (layer && typeof layer.applyPreset === "function");
    };

    PR.applyPresetFile = function (layer, path, ctx) {
        ctx = ctx || newCtx();
        try {
            var f = new File(path);
            if (!f.exists) {
                ctx.errors.push(SB.M("预设文件不存在：%1", path));
                return false;
            }
            if (!PR.canApplyPreset(layer)) {
                ctx.errors.push(SB.M("这个 AE 版本的脚本接口没有 layer.applyPreset（需要 CC 2014+）"));
                return false;
            }
            layer.applyPreset(f);
            return true;
        } catch (e) {
            ctx.errors.push(SB.M("套用 .ffx 失败：%1", e.toString()));
            return false;
        }
    };

    /* ------------------------------------------------------------ 批量套用 */

    /**
     * choice: { kind:"" | "builtin" | "ffx", id:"", path:"" }
     * opts  : { clearAnimators:bool, fallbackDur:number, onProgress:function(done,total,name) }
     * 返回 { total, ok, errors, notes }
     */
    PR.applyToLayers = function (layers, choice, opts, ctx) {
        opts = opts || {};
        ctx = ctx || newCtx();
        var total = layers ? layers.length : 0;
        var ok = 0;
        app.beginUndoGroup(SB.M("套用动画预设"));
        try {
            for (var i = 0; i < total; i++) {
                var layer = layers[i];
                if (!layer) { continue; }
                try {
                    if (choice && choice.kind === "ffx" && choice.path) {
                        if (PR.applyPresetFile(layer, choice.path, ctx)) { ok++; }
                    } else if (choice && choice.kind === "builtin" && choice.id) {
                        if (PR.applyBuiltin(layer, choice.id, opts, ctx) > 0) { ok++; }
                    }
                } catch (eL) {
                    ctx.errors.push(SB.M("第 %1 层「%2」失败：%3", (i + 1), layer.name, eL.toString()));
                }
                if (opts.onProgress) {
                    try { opts.onProgress(i + 1, total, layer.name); } catch (eP) { }
                }
            }
        } finally {
            app.endUndoGroup();
        }
        return { total: total, ok: ok, errors: ctx.errors, notes: ctx.notes };
    };

    /* ---------------------------------------------------------------- 体检 */

    /**
     * 实机探测：这个 AE 到底支持哪些动画器属性 / 能不能 applyPreset。
     * 会临时建一个合成和文字图层，测完删掉。
     */
    PR.probeSupport = function () {
        var lines = [];
        var comp = null;
        try {
            comp = app.project.items.addComp("__sb_preset_probe", 640, 360, 1, 3, 25);
            var layer = comp.layers.addText("测"); // i18n-allow 探测用字符，不是界面文案
            layer.name = SB.M("探针");

            lines.push(SB.M("图层 applyPreset：%1", (PR.canApplyPreset(layer) ? SB.M("✔ 可用") : SB.M("✘ 不可用"))));

            var tp = layer.property(MN.TEXTPROPS);
            lines.push(SB.M("文字属性组：%1", (tp ? "✔" : "✘")));
            var ag = tp ? tp.property(MN.ANIMATORS) : null;
            lines.push(SB.M("动画器组：%1", (ag ? "✔" : "✘")));

            var anim = null;
            try { anim = ag.addProperty(MN.ANIMATOR); } catch (e0) { }
            lines.push("addProperty(ADBE Text Animator)：" + (anim ? "✔" : "✘"));
            if (!anim) { return lines.join("\n"); }

            var apg = anim.property(MN.ANIM_PROPS);
            lines.push(SB.M("动画器属性组：%1", (apg ? SB.M("✔（新建时已有 %1 项）", apg.numProperties) : "✘")));
            var sg = anim.property(MN.SELECTORS);
            lines.push(SB.M("选择器组：%1", (sg ? SB.M("✔（新建时已有 %1 项）", sg.numProperties) : "✘")));

            var want = [
                "ADBE Text Opacity", "ADBE Text Position 3D", "ADBE Text Scale 3D",
                "ADBE Text Rotation", "ADBE Text Blur", "ADBE Text Skew",
                "ADBE Text Fill Hue", "ADBE Text Character Offset", "ADBE Text Tracking Amount"
            ];
            var okList = [], badList = [];
            for (var i = 0; i < want.length; i++) {
                var ok = false;
                try {
                    var p = apg.property(want[i]);
                    if (!p) { p = apg.addProperty(want[i]); }
                    ok = !!p;
                } catch (e1) { ok = false; }
                if (ok) { okList.push(want[i]); } else { badList.push(want[i]); }
            }
            lines.push("");
            lines.push(SB.M("动画器属性可添加（%1）：%2", okList.length, okList.join("、")));
            if (badList.length > 0) { lines.push(SB.M("添加失败（%1）：%2", badList.length, badList.join("、"))); }

            var sel = null;
            if (sg) {
                sel = (sg.numProperties > 0) ? sg.property(1) : null;
                if (!sel) { try { sel = sg.addProperty(MN.SELECTOR); } catch (e2) { }
                }
            }
            lines.push(SB.M("范围选择器：%1", (sel ? "✔" : "✘")));
            if (sel) {
                var selOK = [], selBad = [];
                var swant = [MN.P_START, MN.P_END, MN.P_OFFSET, MN.SMOOTH];
                for (var j = 0; j < swant.length; j++) {
                    var okS = false;
                    try {
                        var sp = sel.property(swant[j]);
                        if (!sp) { sp = sel.addProperty(swant[j]); }
                        okS = !!sp;
                    } catch (e3) { okS = false; }
                    if (okS) { selOK.push(swant[j]); } else { selBad.push(swant[j]); }
                }
                lines.push(SB.M("选择器属性可读写（%1）：%2", selOK.length, selOK.join("、")));
                if (selBad.length > 0) { lines.push(SB.M("选择器属性失败（%1）：%2", selBad.length, selBad.join("、"))); }
            }

            /* 图层样式到底能不能读 */
            var ls = -1;
            try {
                var g = layer.property("ADBE Layer Styles");
                if (g && typeof g.numProperties === "number") { ls = g.numProperties; }
            } catch (e4) { }
            lines.push("");
            lines.push(SB.M("图层样式组 ADBE Layer Styles：%1", (ls >= 0 ? SB.M("✔ 可读到（当前 %1 项）", ls) : SB.M("✘ 读不到"))));
        } catch (eTop) {
            lines.push(SB.M("体检整体失败：%1", eTop.toString()));
        } finally {
            try { if (comp) { comp.remove(); } } catch (eR) { }
        }
        return lines.join("\n");
    };

    root.Preset = PR;
})();
