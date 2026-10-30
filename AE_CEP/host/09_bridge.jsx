/* ============================================================================
 *  09_bridge.jsx —— CEP 面板的宿主桥接层（逻辑层不动，只是把它包成 JSON API）
 *  ---------------------------------------------------------------------------
 *  为什么要有这个文件：
 *    CEP 面板是 HTML 界面（跑在 Chromium 里），它拿不到 AE 的对象；
 *    AE 的对象只有 ExtendScript 能碰。两边靠 CSInterface.evalScript() 通信，
 *    传的都是**字符串**。所以这里做一层「动作名 + JSON 参数 → JSON 结果」的封装：
 *
 *        JS 侧：  cs.evalScript('SB.invoke("preview", "{\\"text\\":\\"...\\"}")')
 *        JSX 侧： SB.invoke(action, argsJson)  →  返回 JSON 字符串
 *
 *  设计约定（改这个文件前先看这几条）：
 *
 *   1) 这里是**纯逻辑**，不碰任何界面。01~06、08 那几个模块原样复用，一行都不用改。
 *      ScriptUI 版面板（AE/src/07_ui.jsx）和 CEP 版面板共用同一套逻辑层。
 *   2) 参数里的图层一律用「合成里的图层编号（1 起）」，不要用下拉框下标 ——
 *      合成一变，下拉框下标就对不上了。
 *   3) 长任务（生成 / 同步 / 搜索）的进度不会回调到 JS（evalScript 是同步阻塞的），
 *      改成写进 BR.state.log，JS 那边定时调 "log" 动作取走。
 *      但**逐层的长动作**（同步样式 / 重建）不能只靠这个：动作还在跑的时候，
 *      面板来取 log 的调用只会排队。所以那两个动作另外把进度写进一个临时文件
 *      （见下面的 progWrite），面板用 cep.fs.readFile 直接读，能实时看到 N/M。
 *   4) 需要用户确认的地方（合成要不要加长、重建要不要继续）**不在宿主里弹窗**：
 *      ExtendScript 的 confirm() 是模态的，在 CEP 里弹出来会卡在 AE 主窗口后面，
 *      用户根本看不见。改成返回 needConfirm，让 JS 用 HTML 弹，拿到答案再调一次。
 *   5) 一切 ExtendScript 的老规矩照旧：ES3 语法、没有原生 JSON（用 SB.JSON）。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var L = root.Lrc;
    var LY = root.Layers;
    var ST = root.Style;
    var ON = root.Online;
    var PR = root.Preset;

    var BR = {};
    root.Bridge = BR;

    BR.build = "dev";

    /** 「构建 v1.0.0(2026-09-20)」这一串的唯一拼法，面板和自检报告共用 */
    BR.versionLine = function () {
        return "v" + SB.VERSION + "(" + SB.VERSION_DATE + ")";
    };

    /* 面板这边跨调用要记住的东西。
     * 为什么能跨 evalScript 调用存活：CEP 扩展的 ExtendScript 引擎在面板生命周期内
     * 一直活着，evalScript 每次都跑在同一个引擎里，所以这个对象自然还在。
     * （注意：**不要**为此去写 #targetengine —— 那会把宿主切到另一个引擎，反而让
     *  evalScript 看不到 SB，见 bootstrap 里的说明。） */
    BR.state = {
        songs: [],          // 搜索结果
        current: null,      // 当前歌曲
        original: "",
        translated: "",
        files: [],          // 扫描到的歌词文件
        presetItems: [],    // 下拉框里的预设（内置 + .ffx）
        log: []             // 进度消息，等 JS 来取
    };

    /* ---------------------------------------------------------------- 小工具 */

    function num(v, def) {
        try { return U.toNumber(v, def); } catch (e) { return def; }
    }

    /** 写一条进度。JS 那边在跑长任务时会定时来取 */
    function push(msg) {
        try {
            BR.state.log.push(String(msg));
            if (BR.state.log.length > 300) { BR.state.log.shift(); }
        } catch (e) { }
    }

    /* ------------------------------------------------------- 进度文件（长动作用）
     *
     * 为什么光有 push() 不够：
     *   evalScript 是**串行**的。长动作（同步样式 / 重建）还在 AE 主线程上跑的时候，
     *   面板再调 "log" 只会排队，等长动作结束才一起返回 —— 状态栏就一直停在
     *   「正在重建 0……」，看着像卡死。排队的几十次调用还会在结束后集中执行，
     *   面板又要再卡一下。
     *
     * 所以长动作的进度改走**文件**：每处理完一层就写一次 "r 3/10"（r=重建，s=同步），
     * 面板用 cep.fs.readFile 直接读。cep.fs 走的是 CEP 自己的原生层，不排 AE 主线程
     * 的队，所以长动作进行中也能读到。
     *
     * 内容故意只用 ASCII：文件编码在 ExtendScript / CEP 两边不一定一致，中文写进去
     * 可能读成乱码；面板拿到数字再自己查表拼句子（T("正在重建 %1/%2……")）。
     */
    function progPath() {
        var dir = "";
        try { dir = Folder.temp.fsName; } catch (e) { dir = ""; }
        return dir + "/LyricSubtitleTool_progress.txt";
    }

    function progWrite(done, total, kind) {
        try {
            var f = new File(progPath());
            if (!f.open("w")) { return; }
            try { f.write(String(kind || "r") + " " + done + "/" + total); } catch (eW) { }
            f.close();
        } catch (e) { }
    }

    function progClear() {
        try {
            var f = new File(progPath());
            if (f.exists) { f.remove(); }
        } catch (e) { }
    }

    function compByIndex(i) {
        var list = LY.listComps();
        if (i >= 0 && i < list.length) { return list[i].comp; }
        var ai = app.project ? app.project.activeItem : null;
        return (ai && ai instanceof CompItem) ? ai : null;
    }

    function textLayers(comp) {
        var out = [];
        if (!comp) { return out; }
        var list = LY.listTextLayers(comp);
        for (var i = 0; i < list.length; i++) {
            out.push({ index: list[i].index, name: list[i].name });
        }
        return out;
    }

    /**
     * 时间轴里当前选中的图层。
     *
     * comp.selectedLayers 在部分版本/部分场景下会返回空（比如合成不是当前活动的、
     * 或者焦点不在时间轴上），所以加了逐层查 .selected 的兜底 ——
     * 「取当前选中图层」这个按钮一直报「没选中」，根源就是少了这两条路。
     */
    function selectedLayers(comp) {
        var out = [];
        if (!comp) { return out; }
        var i, L;
        try {
            var sl = comp.selectedLayers;
            if (sl && sl.length > 0) {
                for (i = 0; i < sl.length; i++) { if (sl[i]) { out.push(sl[i]); } }
                if (out.length > 0) { return out; }
            }
        } catch (e1) { out = []; }
        try {
            for (i = 1; i <= comp.numLayers; i++) {
                L = comp.layer(i);
                if (L && L.selected) { out.push(L); }
            }
        } catch (e2) { }
        return out;
    }

    /** 合成在列表里的下标（面板要拿它去同步下拉框） */
    function compIndexOf(comp) {
        try {
            var list = LY.listComps();
            for (var i = 0; i < list.length; i++) {
                if (list[i].comp === comp) { return i; }
            }
        } catch (e) { }
        return -1;
    }

    /** 解析 + 建帧，两处（预览 / 生成）共用 */
    function buildFrames(a) {
        var text = String(a.text || "");
        if (U.trim(text) === "") {
            return { error: SB.M("歌词内容是空的（先打开文件 / 扫描文件夹 / 粘贴一段进来）") };
        }
        var fo = L.defaultFrameOptions();
        var f = a.frame || {};
        fo.defaultDuration = num(f.defaultDur, 2);
        fo.gap = num(f.gap, 0.02);
        fo.minDuration = num(f.minDur, 0.3);
        fo.maxDuration = num(f.maxDur, 0);
        fo.startOffset = num(f.offset, 0);
        fo.leadIn = num(f.leadIn, 0);
        fo.leadOut = num(f.leadOut, 0);
        fo.mergeTolerance = num(f.mergeTol, 0.02);
        fo.untimedMode = "mergePrev";
        fo.bilingualLayout = (f.biLayout === "sameLine") ? "sameLine" : "stack";
        fo.bilingualOrder = (f.biOrder === "BA") ? "BA" : "AB";
        /* 「双语图层」下拉 + 老的「每行单独建层」勾选项都能触发拆层，
         * 两条路合到一起给底层，前端爱用哪个用哪个。 */
        fo.splitLines = (f.biLayer === "split") || !!f.splitLines;
        /* 面板上的「套用 .ass 里的字幕样式」：关掉就完全按面板的排版样式走 */
        fo.useStyle = (a.assStyle !== false);

        var parsed;
        if (a.hasTrans && U.trim(String(a.translated || "")) !== "") {
            parsed = L.pairBilingual(text, a.translated, { matchTolerance: num(a.matchTol, 0.6) });
        } else {
            /* parseAuto 而不是 parse：同一段文本可能是 SRT / ASS / VTT，
             * 认出来就走那边的解析器，认不出来（LRC / 纯文本）才回头走 LRC。 */
            parsed = L.parseAuto(text, { group: "A" });
        }
        var frames = L.buildFrames(parsed, fo);
        if (!frames || frames.length === 0) {
            return { error: SB.M("没有解析出任何字幕行：LRC 要有 [00:12.34] 这种时间码，SRT / VTT 要有 00:00:01,000 --> 00:00:03,000，ASS 要有 Dialogue: 行。") };
        }
        return { parsed: parsed, frames: frames };
    }

    function readLyricFile(path, name, enc) {
        var r = null;
        try { r = U.readTextAuto(path, enc); }
        catch (e) { return { ok: false, error: SB.M("读取异常：%1", e.toString()) }; }
        if (!r.ok || U.trim(r.text) === "") {
            return { ok: false, error: SB.M("这个文件的编码识别不了（%1）。请在「编码」里手动选 GBK / GB2312 / BIG5 再试一次。", (r ? r.encoding : "?")) };
        }
        var out = { ok: true, text: r.text, name: name, encoding: r.encoding,
            lines: r.text.split("\n").length };

        /* 顺手认一下格式，好让状态栏告诉用户「这是 SRT / ASS」。
         * 扩展名优先（用户选的文件名是最可靠的信号），认不出再看内容。
         * LRC / 纯文本就不回报了 —— 那是常态，报了只是噪音。 */
        if (root.Sub) {
            var fmt = root.Sub.formatOfName(name);
            if (!fmt) { fmt = root.Sub.detect(r.text); }
            if (fmt === "srt" || fmt === "ass" || fmt === "vtt") {
                out.format = fmt;
                out.formatLabel = root.Sub.FORMAT_LABELS[fmt] || fmt;
            }
        }
        return out;
    }

    /** 把图层的「肉眼可见样式」摘成一行文本，用来在日志里当前后对比的证据 */
    function readStyleBrief(layer) {
        var out = { ok: false, text: SB.M("（读不到）") };
        try {
            var td = layer.property(LY.MATCH.TEXT_PROPERTIES)
                .property(LY.MATCH.TEXT_DOCUMENT).value;
            var col = td.fillColor;
            out.ok = true;
            out.color = "[" + col[0].toFixed(2) + "," + col[1].toFixed(2) + "," + col[2].toFixed(2) + "]";
            out.text = SB.M("字号%1 字体%2 填充%3 %4", td.fontSize, td.font, out.color, (td.applyStroke ? SB.M("描边%1", td.strokeWidth) : SB.M("无描边")));
        } catch (e) { return out; }
        try {
            var tf = layer.property(LY.MATCH.TRANSFORM);
            var sc = tf.property(LY.MATCH.SCALE).value;
            out.text += SB.M(" 缩放[%1,%2]", Math.round(sc[0]), Math.round(sc[1]));
        } catch (e2) { }
        return out;
    }

    /* ---------------------------------------------------------------- 动作表 */

    var API = {};

    /* --- 环境与列表 --- */

    API.hello = function () {
        var v = "";
        try { v = app.version + " / build " + app.buildNumber; } catch (e) { v = "?"; }
        return {
            ok: true, build: BR.build, ae: v, engine: "ExtendScript " + $.version,
            version: SB.VERSION, versionDate: SB.VERSION_DATE,
            /* 进度文件的绝对路径 —— 面板要拿它去轮询，自己拼不出来
             * （Folder.temp 在 mac 上是 /var/folders/… 这种随机目录）。 */
            prog: progPath()
        };
    };

    /**
     * 面板切界面语言时同步过来。
     *
     * 为什么宿主也要记一份语言：日志和错误信息是在**宿主里拼好再返回**的
     * （evalScript 传的是字符串，前端没法逐句再翻一遍），所以 SB.lang 一改，
     * 后面生成的提示才会跟着变语言。前端在启动和每次切换时都会调一次。
     */
    API.setLang = function (a) {
        /* 语言代码由 SB.normalizeLang 认（zh / zh-Hant / en / ja），认不出就退回 zh。
         * 宿主这边也回一句「挂上了哪几张表」，面板排查「切了没反应」时能直接看。 */
        var l = SB.setLang((a && a.lang) ? a.lang : "zh");
        var out = { ok: true, lang: l, version: SB.VERSION, versionDate: SB.VERSION_DATE };
        try {
            var li = SB.langInfo();
            out.lang = li.lang;
            out.tables = li.tables;
        } catch (eL) { }
        return out;
    };

    /** 设置页的「打开插件文件夹」：定位到扩展自己的目录（看日志 / 换版本都方便） */
    API.openExtFolder = function () {
        var p = "";
        try { p = new File($.fileName).parent.parent.fsName; } catch (e0) { p = ""; }
        if (!p) { try { p = Folder.userData.fsName; } catch (e1) { p = ""; } }
        if (!p) { return { ok: false, error: SB.M("定位不到扩展目录") }; }
        var opened = false;
        try { opened = Folder(p).execute(); } catch (e2) { opened = false; }
        if (!opened) { return { ok: false, error: SB.M("打开文件夹失败：%1", p), path: p }; }
        return { ok: true, path: p };
    };

    API.comps = function () {
        var list = LY.listComps();
        var out = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var c = list[i].comp;
            out.push({
                name: list[i].name, width: c.width, height: c.height,
                fps: c.frameRate, duration: c.duration, layers: c.numLayers
            });
        }
        var active = 0;
        var ai = app.project ? app.project.activeItem : null;
        for (i = 0; i < list.length; i++) { if (list[i].comp === ai) { active = i; } }
        return { ok: true, comps: out, active: active };
    };

    API.fonts = function () {
        var fonts = LY.listFonts();
        var items = [{ label: SB.M("（保持图层原字体）"), ps: "" }];
        var i;
        if (fonts.length === 0) {
            /* AE 2023 的 app.fonts 不可用，退化成常见字体清单 */
            for (i = 0; i < LY.FALLBACK_FONTS.length; i++) {
                items.push({ label: LY.FALLBACK_FONTS[i] + SB.M("（常见字体，未必已安装）"), ps: LY.FALLBACK_FONTS[i] });
            }
            return { ok: true, fonts: items, fallback: true };
        }
        for (i = 0; i < fonts.length; i++) {
            items.push({ label: fonts[i].label, ps: fonts[i].ps });
        }
        return { ok: true, fonts: items, fallback: false };
    };

    /**
     * 文字图层清单。
     *
     * 不带参数：列出合成里所有文字图层（下拉框用）。
     * 带 selectedOnly：取时间轴里当前选中的那一个，返回 index / name。
     *   下拉框选中的合成跟「正在看的合成」可能不是一个，所以这里先看下拉框那个，
     *   它没选中就退到 app.project.activeItem —— 并且把下标放在 compIndex 里
     *   带回去，让面板把下拉框同步过去，省得用户以为没生效。
     */
    API.textLayers = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: false, error: SB.M("还没选到合成。") }; }

        var sel = selectedLayers(comp);
        var useComp = comp;
        if (a.selectedOnly && sel.length === 0) {
            var ai = app.project ? app.project.activeItem : null;
            if (ai && ai instanceof CompItem && ai !== comp) {
                var s2 = selectedLayers(ai);
                if (s2.length > 0) { sel = s2; useComp = ai; }
            }
        }

        var res = { ok: true, layers: textLayers(useComp), compIndex: compIndexOf(useComp) };
        res.selectedCount = sel.length;
        if (sel.length > 0) {
            res.index = sel[0].index;
            res.name = sel[0].name;
            res.isText = (sel[0] instanceof TextLayer);
            if (sel.length > 1) { res.more = sel.length - 1; }
        }

        if (a.selectedOnly) {
            if (sel.length === 0) {
                return {
                    ok: false, compIndex: res.compIndex,
                    error: SB.M("在合成「%1」里没读到选中的图层。\n确认一下：点一下时间轴里的图层名字，再点这个按钮；\n合成要处在打开/激活状态（选中状态跟合成是绑在一起的）。", comp.name)
                };
            }
            if (a.textOnly && !res.isText) {
                return {
                    ok: false, compIndex: res.compIndex, index: res.index,
                    error: SB.M("选中的第 %1 层「%2」不是文字图层。", res.index, res.name)
                };
            }
        }
        return res;
    };

    /**
     * 双语分组扫描：给「样式同步」页用。
     *
     * 用户最常遇到的坑是「应用完之后所有字幕叠在同一个位置」—— 因为参考层的位置
     * 被原样抄给了每一层，而双语拆层生成出来的原文/译文本来是靠 Y 错位分开的。
     * 所以点「应用」之前先扫一遍，把「同组 / 另一组」各有多少层摊在界面上，
     * 让用户知道勾了之后会发生什么。
     */
    API.pairs = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: false, error: SB.M("还没选到合成。") }; }
        var ref = null;
        try { ref = comp.layer(a.refIndex); } catch (eR) { ref = null; }
        if (!ref) { return { ok: false, error: SB.M("先选一个参考图层。") }; }

        var spec = U.parseIndexSpec(String(a.spec || ""), comp.numLayers);
        if (!spec || spec.error) { return { ok: false, error: SB.M("图层号有误：%1", (spec ? spec.error : SB.M("空"))) }; }

        var g = LY.scanGroups(comp, spec.list, ref);
        var scripts = [];
        for (var k in g.scripts) {
            if (g.scripts.hasOwnProperty(k)) { scripts.push(NAME_OF_SCRIPT(k) + " " + g.scripts[k]); }
        }
        var refScript = LY.detectScript(LY.getLayerText(ref));
        var tag = LY.readPairTag(ref);

        return {
            ok: true,
            total: g.total, same: g.same, other: g.other, tagged: g.tagged,
            refScript: NAME_OF_SCRIPT(refScript),
            refTagged: !!tag,
            refSub: tag ? tag.s : 0,
            scripts: scripts.join("、"),
            sampleSame: g.sampleSame, sampleOther: g.sampleOther
        };
    };

    function NAME_OF_SCRIPT(k) {
        return ({
            ja: SB.M("日文"), zh: SB.M("中文"), ko: SB.M("韩文"), ru: SB.M("西里尔"), en: SB.M("拉丁"),
            mixed: SB.M("混排"), other: SB.M("其它")
        })[k] || k;
    }

    API.indexHint = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: true, text: SB.M("（还没选到合成）") }; }
        var total = comp.numLayers;
        var spec = U.parseIndexSpec(String(a.spec || ""), total);
        if (!spec || spec.error) {
            return { ok: true, text: SB.M("本合成共 %1 层；图层号还没填对（%2）", total, (spec ? spec.error : SB.M("空"))), total: total };
        }
        if (!spec.list || spec.list.length === 0) {
            return { ok: true, text: SB.M("本合成共 %1 层；还没指定任何图层", total), total: total };
        }
        var inList = {}, i;
        for (i = 0; i < spec.list.length; i++) { inList[spec.list[i]] = true; }
        var missed = [];
        for (i = 1; i <= total; i++) { if (!inList[i]) { missed.push(i); } }
        var t = SB.M("本合成「%1」共 %2 层；本次覆盖 %3 个（%4）", comp.name, total, spec.list.length, U.formatIndexList(spec.list));
        t += missed.length > 0
            ? SB.M("；还有 %1 层没覆盖（%2）", missed.length, U.formatIndexList(missed))
            : SB.M("；已覆盖全部图层");
        return { ok: true, text: t, total: total, list: spec.list, missed: missed };
    };

    /**
     * 编码下拉 + 图层颜色（标签）下拉的数据源。
     *
     * 这里返回的是 {value, label} 而不是字符串列表，原因是「value 必须跨语言不变」：
     * 编码的 value 用 ASCII id（auto / utf8 / gbk…），切到英文时只是 label 变了，
     * 面板回传的 value 还是同一个，normalizeEncoding 不会因为语言切换而错位。
     * 标签色的 value 就是下标，label 是名字 —— 名字在英文下要走 SB.TList 翻。
     */
    API.encodings = function () {
        var enc = [], i;
        for (i = 0; i < U.ENCODINGS.length; i++) {
            enc.push({ value: U.ENCODINGS[i], label: SB.M(U.ENCODING_LABELS[i]) });
        }
        return { ok: true, encodings: enc, labels: SB.TList(LY.LABELS) };
    };

    /* --- 歌词读取 --- */

    /**
     * 「打开歌词文件…」。
     *
     * 过滤器里除了 .lrc / .txt 还要列 .srt / .ass / .ssa / .vtt：
     * 这三个格式都自带「开始 → 结束」时间码，导入进来直接就能对时间轴。
     * 末尾那个 *lrc* 是给「文件名里带 lrc 但没有扩展名」的文件留的门
     * （详见 02_util 里 sniffLyricsFile 的注释）。
     */
    API.openFile = function (a) {
        var filter = SB.M("歌词/字幕 (*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt):*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt;*lrc*")
            + "," + SB.M("全部文件 (*.*):*.*");
        var f = null;
        try { f = File.openDialog(SB.M("选择歌词/字幕文件（.lrc / .srt / .ass / .vtt / .txt，或文件名里带 lrc 的文件）"), filter); }
        catch (eF) { f = File.openDialog(SB.M("选择歌词/字幕文件（已列出全部文件）")); }
        if (!f) { return { ok: false, cancelled: true }; }
        var r = readLyricFile(f.fsName, f.name, a.encoding);
        r.dir = f.parent ? f.parent.fsName : "";
        return r;
    };

    API.scanFolder = function (a) {
        var start = null;
        if (a.lastDir) { try { start = new Folder(a.lastDir); } catch (e0) { start = null; } }
        var folder = Folder.selectDialog(SB.M("选择存放歌词的文件夹（会自动找出里面的歌词文件）"), start);
        if (!folder) { return { ok: false, cancelled: true }; }
        var all = folder.getFiles();
        var hits = [];
        for (var i = 0; i < all.length; i++) {
            var it = all[i];
            if (!(it instanceof File)) { continue; }
            if (it.name.charAt(0) === ".") { continue; }
            var byName = U.looksLikeLyricsName(it.name);
            var byContent = U.sniffLyricsFile(it.fsName);
            if (byName || byContent) {
                hits.push({ path: it.fsName, name: it.name, lrc: byContent, size: it.length });
            }
        }
        hits.sort(function (x, y) {
            if (x.lrc === y.lrc) { return x.name < y.name ? -1 : 1; }
            return x.lrc ? -1 : 1;
        });
        BR.state.files = hits;
        return { ok: true, files: hits, dir: folder.fsName };
    };

    API.loadFile = function (a) {
        var idx = a.index;
        if (!(idx >= 0) || idx >= BR.state.files.length) {
            return { ok: false, error: SB.M("还没有扫描结果，先点「扫描文件夹…」") };
        }
        var info = BR.state.files[idx];
        return readLyricFile(info.path, info.name, a.encoding);
    };

    API.paste = function () {
        var txt = "";
        try {
            if ($.os.indexOf("Windows") >= 0) {
                txt = system.callSystem("powershell -NoProfile -Command \"Get-Clipboard -Raw\"");
            } else {
                txt = system.callSystem("/usr/bin/pbpaste");
            }
        } catch (e) { txt = ""; }
        if (txt === null || txt === undefined || U.trim(txt) === "") {
            return { ok: false, error: SB.M("剪贴板是空的，或者读取失败。可以直接在文本框里粘贴（Ctrl+V）。") };
        }
        return { ok: true, text: txt, name: SB.M("剪贴板"), encoding: SB.M("按系统编码") };
    };

    /* --- 预览 --- */

    API.preview = function (a) {
        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: r.error }; }

        var frames = r.frames;
        var limit = Math.min(frames.length, 600);
        var list = [];
        var sentenceCount = 0;   // 原始「句」数（同一时间码算一句）
        var splitSentences = 0;  // 其中被拆成多个图层的句数
        for (var i = 0; i < frames.length; i++) {
            if (frames[i].sub === 0) {
                sentenceCount++;
                if (frames[i].subCount > 1) { splitSentences++; }
            }
        }
        for (i = 0; i < limit; i++) {
            var fr = frames[i];
            var t = U.formatTimecode(fr.start, false) + "\u2192" + U.formatTimecode(fr.end, false);
            var txt = String(fr.text).replace(/\r/g, " | ");
            if (txt.length > 60) { txt = txt.substring(0, 60) + "\u2026"; }
            list.push({
                i: i + 1, time: t, text: txt,
                /* 双语拆层时给列表加个「原 / 译」角标，肉眼一眼能核对顺序 */
                role: (fr.subCount > 1) ? ((fr.role === "B") ? SB.M("译") : SB.M("原")) : "",
                indent: (fr.subCount > 1 && fr.sub > 0) ? 1 : 0
            });
        }

        var st = L.stats(frames);
        var multi = L.countMultiLineFrames(frames);
        var info = SB.M("%1 个图层", frames.length);
        if (limit < frames.length) { info += SB.M("（列表只显示前 %1 条）", limit); }
        if (splitSentences > 0) {
            info += SB.M("（%1 句，其中 %2 句拆成了多个图层）", sentenceCount, splitSentences);
        } else {
            info += SB.M("（共 %1 句）", sentenceCount);
        }
        info += "；" + U.formatTimecode(st.first, false) + " ~ " + U.formatTimecode(st.last, false);
        info += SB.M("；单条 %1s ~ %2s", st.shortest.toFixed(2), st.longest.toFixed(2));
        if (multi > 0) { info += SB.M("；%1 条为多行（双语）", multi); }
        if (r.parsed && r.parsed.warnings && r.parsed.warnings.length > 0) {
            info += "；" + r.parsed.warnings.join("，");
        }
        if (r.parsed && r.parsed.meta && r.parsed.meta.ti) { info += SB.M("；标题：%1", r.parsed.meta.ti); }

        return { ok: true, list: list, info: info, count: frames.length,
            first: frames[0].text, last: frames[frames.length - 1].text };
    };

    /* --- 生成 --- */

    API.generate = function (a) {
        if (!app.project) { return { ok: false, error: SB.M("请先新建或打开一个项目。") }; }

        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: SB.M("歌词还没解析成功：%1", r.error) }; }

        var comp = compByIndex(a.compIndex);
        if (!comp && a.autoComp) {
            var est = (r.frames.length > 0) ? (r.frames[r.frames.length - 1].end + 2) : 60;
            comp = LY.createComp({
                name: (r.parsed && r.parsed.meta && r.parsed.meta.ti)
                    ? SB.M("字幕_%1", r.parsed.meta.ti) : SB.M("字幕合成"),
                duration: est
            });
            push(SB.M("已自动新建合成：%1", comp.name));
        }
        if (!comp) { return { ok: false, error: SB.M("没有可用的目标合成（在「② 目标合成」里选一个，或勾上自动新建）。") }; }

        var need = r.frames[r.frames.length - 1].end;
        if (need > comp.duration + 0.05 && a.extend === undefined) {
            return {
                ok: false, needConfirm: {
                    kind: "extend", comp: comp.name, need: need,
                    current: comp.duration, want: Math.ceil(need + 1)
                }
            };
        }
        if (need > comp.duration + 0.05 && a.extend === true) {
            comp.duration = Math.ceil(need + 1);
            push(SB.M("合成已加长到 %1 秒", Math.ceil(need + 1)));
        }

        push(SB.M("正在生成 %1 个图层……", r.frames.length));

        var lo = LY.defaultOptions();
        var y = a.layer || {};
        lo.fontSize = num(y.fontSize, 60);
        lo.fontPostScript = y.font || "";
        lo.fillColor = y.fill || [1, 1, 1];
        lo.applyStroke = !!y.strokeOn;
        lo.strokeColor = y.strokeColor || [0, 0, 0];
        lo.strokeWidth = num(y.strokeWidth, 2);
        lo.justification = y.justify || "center";
        lo.targetX = num(y.posX, 960);
        lo.targetY = num(y.posY, 900);
        lo.autoCenter = !!y.autoCenter;
        lo.vertical = !!y.vertical;
        lo.verticalDirection = y.verticalDir || "rtl";
        lo.leadingRatio = num(y.leadingRatio, 0);
        lo.verticalLeadingRatio = num(y.vLeadingRatio, 1.0);
        lo.tracking = num(y.tracking, 0);
        lo.layerNameMode = y.layerName || "text";
        lo.labelIndex = num(y.labelIndex, 0);
        lo.lineStep = num(y.lineStep, 0);
        lo.reverse = !!y.reverse;

        var tpl = null;
        if (a.tplIndex > 0) {
            try {
                var cand = comp.layer(a.tplIndex);
                if (cand instanceof TextLayer) { tpl = cand; }
            } catch (eT) { tpl = null; }
        }

        var layers = null, tplRep = null;
        if (tpl) {
            push(SB.M("正在以模板复制 %1 个图层……", r.frames.length));
            var tr = LY.createFromTemplate(comp, tpl, r.frames, {
                reverse: lo.reverse,
                layerNameMode: a.tplRename ? lo.layerNameMode : null,
                hideTemplate: !!a.tplHide,
                lineStep: lo.lineStep,
                remapMode: a.remapMode || "scale",
                onProgress: function (done, total) {
                    if (done > 0 && done % 10 !== 0 && done < total) { return; }
                    push(SB.M("正在复制 %1/%2……", done, total));
                }
            });
            layers = tr.layers;
            tplRep = tr.report;
        } else {
            layers = LY.createTextLayers(comp, r.frames, lo);
        }

        try { comp.openInViewer(); } catch (eV) { }
        try { for (var i = 0; i < layers.length; i++) { layers[i].selected = true; } } catch (eSel) { }

        var msg = SB.M("已在「%1」生成 %2 个文字图层", comp.name, layers.length);
        /* 双语拆层时图层数会比句数多，不说清楚容易被当成生成错了 */
        var sent = 0, dual = 0;
        for (var si = 0; si < r.frames.length; si++) {
            if (r.frames[si].sub === 0) {
                sent++;
                if (r.frames[si].subCount > 1) { dual++; }
            }
        }
        if (dual > 0) {
            msg += SB.M("（%1 句，其中 %2 句拆成了原文/译文两个图层）", sent, dual);
        }
        if (tpl) {
            msg += SB.M("（复制自模板「%1」", tpl.name);
            if (tplRep && tplRep.remapped > 0) { msg += SB.M("，关键帧对时 %1 个", tplRep.remapped); }
            msg += "）";
        }
        if (lo.reverse) { msg += SB.M("（倒序：最后一句在最上层）"); }
        if (tplRep && tplRep.errors && tplRep.errors.length > 0) {
            msg += SB.M("；有 %1 条报错：%2", tplRep.errors.length, tplRep.errors[0]);
        }

        /* 预设要在打包成预合成之前套 */
        if (a.presetOnGen && layers.length > 0) {
            var choice = BR.state.presetItems[a.presetIndex];
            if (choice) {
                push(SB.M("正在套用预设 0/%1……", layers.length));
                var pctx = { errors: [], notes: [] };
                var pres = PR.applyToLayers(layers, choice, { clearAnimators: false }, pctx);
                msg += SB.M("，并套用预设「%1」（%2/%3）", choice.name, pres.ok, pres.total);
                if (pctx.errors.length > 0) {
                    msg += SB.M("，有 %1 条报错：%2", pctx.errors.length, pctx.errors[0]);
                }
            }
        }

        if (a.precompose && layers.length > 0) {
            var pc = LY.precompose(comp, layers, SB.M("字幕"));
            if (pc) { msg += SB.M("，并已打包为预合成「%1」", pc.name); }
        }
        push(msg);
        return { ok: true, msg: msg, layers: layers.length };
    };

    /* --- 动画预设 --- */

    API.presets = function (a) {
        BR.state.presetItems = [];
        var items = [];
        var i;
        for (i = 0; i < PR.BUILTIN.length; i++) {
            BR.state.presetItems.push({
                kind: "builtin", id: PR.BUILTIN[i].id,
                name: SB.T(PR.BUILTIN[i].name), tip: SB.T(PR.BUILTIN[i].tip)
            });
            items.push({ name: SB.T(PR.BUILTIN[i].name), tip: SB.T(PR.BUILTIN[i].tip) || "" });
        }
        var dirs = PR.defaultDirs();
        if (a.presetDir) { dirs.push(a.presetDir); }
        var ffx = PR.scanFFX(dirs, 2);
        for (i = 0; i < ffx.length; i++) {
            BR.state.presetItems.push({ kind: "ffx", path: ffx[i].path, name: "[ffx] " + ffx[i].name, tip: ffx[i].path });
            items.push({ name: "[ffx] " + ffx[i].name, tip: ffx[i].path });
        }
        return {
            ok: true, items: items, dirs: dirs,
            info: SB.M("内置预设 %1 个，扫到 .ffx %2 个。扫描目录：%3", PR.BUILTIN.length, ffx.length, dirs.join(" / "))
        };
    };

    API.applyPreset = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: false, error: SB.M("请先选择一个合成。") }; }
        var choice = BR.state.presetItems[a.presetIndex];
        if (!choice || (choice.kind === "builtin" && !choice.id)) {
            return { ok: false, error: SB.M("先在下拉框里选一个预设。") };
        }
        var layers = [], i;
        if (a.scope === "sel") {
            for (i = 1; i <= comp.numLayers; i++) {
                var L0 = comp.layer(i);
                if (L0.selected) { layers.push(L0); }
            }
        } else {
            for (i = 1; i <= comp.numLayers; i++) {
                var t = comp.layer(i);
                if (t instanceof TextLayer) { layers.push(t); }
            }
        }
        if (layers.length === 0) {
            return { ok: false, error: (a.scope === "sel")
                ? SB.M("当前合成里没有选中的图层（在时间轴里选中要套用的图层再来）。")
                : SB.M("这个合成里没有文字图层。") };
        }
        if (choice.kind === "ffx" && !PR.canApplyPreset(layers[0])) {
            return { ok: false, error: SB.M("这个 AE 版本的脚本接口没有 layer.applyPreset（需要 CC 2014+），只能用内置预设。") };
        }
        var ctx = { errors: [], notes: [] };
        var res = PR.applyToLayers(layers, choice, {
            clearAnimators: a.clear !== false,
            onProgress: function (done, total) {
                if (done % 5 === 0 || done === total) { push(SB.M("正在套用预设 %1/%2……", done, total)); }
            }
        }, ctx);
        var msg = SB.M("预设「%1」→ %2/%3 个图层", choice.name, res.ok, res.total);
        return { ok: true, msg: msg, errors: ctx.errors, canUndo: true };
    };

    API.presetProbe = function () {
        return { ok: true, text: PR.probeSupport() };
    };

    API.pickPresetDir = function () {
        var d = Folder.selectDialog(SB.M("选一个放 .ffx 预设的文件夹"));
        if (!d) { return { ok: false, cancelled: true }; }
        return { ok: true, dir: d.fsName };
    };

    /* --- 样式同步 --- */

    API.style = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: false, error: SB.M("请先选择一个合成。") }; }
        var ref = null;
        try { ref = comp.layer(a.refIndex); } catch (eR) { ref = null; }
        if (!ref) { return { ok: false, error: SB.M("请先选择参考图层。") }; }

        var spec = U.parseIndexSpec(String(a.spec || ""), comp.numLayers);
        if (!spec || spec.error) { return { ok: false, error: SB.M("图层号有误：%1", (spec ? spec.error : SB.M("空"))) }; }

        var o = ST.defaultOptions();
        var c = a.copy || {};
        o.textStyle = c.textStyle !== false;
        o.keepText = !c.copyText;
        o.transform = c.transform !== false;
        o.effects = c.effects !== false;
        o.masks = !!c.masks;
        o.textAnimators = c.animators !== false;
        o.layerProps = c.layerProps !== false;
        o.keyframes = c.keyframes !== false;
        o.keyframeInterpolation = c.ease !== false;
        o.keyframeEase = c.ease !== false;
        o.expressions = c.expressions !== false;
        o.values = c.values !== false;
        o.skipRef = c.skipRef !== false;
        o.onlyTextLayers = c.onlyText !== false;

        /* ---- 双语图层 ---- */
        var bi = a.bi || {};
        o.biScope = bi.scope || "all";
        o.biPos = bi.pos || "follow";
        o.biStep = num(bi.step, 0);
        if (bi.ref2Index) {
            try { o.refLayer2 = comp.layer(bi.ref2Index); } catch (eR2) { o.refLayer2 = null; }
            if (o.refLayer2 === ref) { o.refLayer2 = null; }
        }
        o.remapMode = a.remapMode || "scale";
        o.remapKeys = (o.remapMode !== "none");
        o.onProgress = function (done, total, name) {
            if (done > 0 && done % 5 !== 0 && done < total) { return; }
            push(SB.M("正在同步 %1/%2%3……", done, total, (name ? SB.M("（%1）", name) : "")));
        };

        /* 找一个会被改到的图层，留作「同步前」证据 */
        var sampleIdx = 0, sampleBefore = null, i0;
        for (i0 = 0; i0 < spec.list.length; i0++) {
            var cand = null;
            try { cand = comp.layer(spec.list[i0]); } catch (eL0) { cand = null; }
            if (!cand || cand === ref) { continue; }
            if (o.onlyTextLayers && !(cand instanceof TextLayer)) { continue; }
            sampleIdx = spec.list[i0];
            sampleBefore = readStyleBrief(cand);
            break;
        }

        /* 先盘一下参考层到底有什么可给的 */
        var inv = { fx: 0, an: 0, mk: 0, fxNames: [] };
        try {
            var fxG = ref.property(LY.MATCH.EFFECTS);
            inv.fx = fxG.numProperties;
            for (var fxi = 1; fxi <= inv.fx && fxi <= 8; fxi++) {
                var fxName = "";
                try { fxName = fxG.property(fxi).name; } catch (eFN) { fxName = "?"; }
                inv.fxNames.push(fxName);
            }
        } catch (eInv1) { }
        try {
            inv.an = ref.property(LY.MATCH.TEXT_PROPERTIES)
                .property(LY.MATCH.TEXT_ANIMATORS).numProperties;
        } catch (eInv2) { }
        try { inv.mk = ref.property(LY.MATCH.MASKS).numProperties; } catch (eInv3) { }
        inv.layerStyles = ST.countLayerStyles(ref);

        push(SB.M("正在同步 0/%1……", spec.list.length));
        progWrite(0, spec.list.length, "s");
        /* 逐层把进度写进文件：面板那边正在阻塞等着，只有文件通道读得到（见 progWrite 的注释） */
        o.onProgress = function (done, total) { progWrite(done, total, "s"); };
        var report = ST.applyToLayers(comp, ref, spec.list, o);
        progClear();

        var sampleAfter = null;
        if (sampleIdx > 0) {
            try { sampleAfter = readStyleBrief(comp.layer(sampleIdx)); } catch (eS0) { sampleAfter = null; }
        }

        var lines = [];
        var covered = {}, ci;
        for (ci = 0; ci < spec.list.length; ci++) { covered[spec.list[ci]] = true; }
        var missedIdx = [];
        for (ci = 1; ci <= comp.numLayers; ci++) { if (!covered[ci]) { missedIdx.push(ci); } }

        lines.push(SB.M("本合成共 %1 层；图层号指定 %2 个（%3）", comp.numLayers, spec.list.length, U.formatIndexList(spec.list)));
        if (missedIdx.length > 0) {
            lines.push(SB.M("⚠ 有 %1 层不在图层号里，没被处理：%2　（要全部就点「全部」按钮）", missedIdx.length, U.formatIndexList(missedIdx)));
        } else {
            lines.push(SB.M("已覆盖全部图层"));
        }
        lines.push(SB.M("参考层 #%1「%2」自带：效果 %3 个%4、文字动画器 %5 个、蒙版 %6 个",
            ref.index, ref.name, inv.fx,
            (inv.fxNames.length > 0 ? ("（" + inv.fxNames.join("、") +
                (inv.fx > inv.fxNames.length ? "…" : "") + "）") : ""),
            inv.an, inv.mk));
        lines.push(SB.M("实际写入：%1 个图层", report.layers));
        if (report.skipped > 0) { lines.push(SB.M("跳过：%1 个（非文字图层 / 参考图层本身 / 锁定）", report.skipped)); }

        /* 双语分组的结果要写在明面上：不然「原文译文叠在一起」这种问题，
         * 用户只看「写入 N 个图层」是看不出来的。 */
        if (o.biScope !== "all" || o.biPos !== "follow") {
            var gg = report.groups || { same: 0, other: 0 };
            lines.push(SB.M("双语分组：与参考层同组 %1 层、另一组 %2 层%3", gg.same, gg.other,
                (o.biScope === "all" ? "" : SB.M("（本次只处理「%1」，跳过 %2 层）",
                    (o.biScope === "same" ? SB.M("与参考层同组") : SB.M("另一组")), report.scopeSkipped))));
            if (o.biPos === "stagger" && report.staggered > 0) {
                lines.push(SB.M("已按组内行号错开：%1 层（行距 %2）", report.staggered, (o.biStep > 0 ? (o.biStep + "px") : SB.M("自动"))));
            }
            if (o.biPos === "keep") { lines.push(SB.M("位置未改动（保留各自原来的 X/Y）")); }
            if (o.refLayer2) {
                lines.push(SB.M("另一组用的是第二个参考层 #%1「%2」", o.refLayer2.index, o.refLayer2.name));
            }
        } else if ((report.groups.same + report.groups.other) > 0 &&
                   report.groups.same > 0 && report.groups.other > 0) {
            var stepHint = o.biStep > 0 ? (o.biStep + "px") : SB.M("自动");
            lines.push(SB.M("⚠ 认出双语两组（同组 %1 层 / 另一组 %2 层），但「双语位置」还是「照抄参考层」——两组的 Y 会变成同一个值、叠在一起。要分开就把该项改成「保留上下错位」（行距 %3），或给「另一组用」指定第二个参考层。", report.groups.same, report.groups.other, stepHint));
        }

        if (inv.fx > 0 && report.effects === 0) {
            lines.push(SB.M("⚠ 参考层有 %1 个效果，却一个都没复制过去 —— %2", inv.fx,
                (o.effects ? SB.M("看下面有没有报错（多半是 addProperty 失败了）") : SB.M("因为「效果」这个选项没勾选"))));
        }
        if (inv.an > 0 && report.animators === 0) {
            lines.push(SB.M("⚠ 参考层有 %1 个文字动画器，却一个都没复制过去 —— %2", inv.an,
                (o.textAnimators ? SB.M("看下面有没有报错") : SB.M("因为「文字动画器」这个选项没勾选"))));
        }
        if (inv.mk > 0 && report.masks === 0) {
            lines.push(SB.M("⚠ 参考层有 %1 个蒙版，却一个都没复制过去 —— %2", inv.mk,
                (o.masks ? SB.M("看下面有没有报错") : SB.M("因为「蒙版」这个选项默认不勾，要就勾上"))));
        }
        if (inv.layerStyles > 0) {
            lines.push(SB.M("⚠ 参考层还有 %1 个「图层样式」（投影 / 描边 / 外发光 / 斜面…）：逐个属性深拷贝对图层样式不好使，这一块同步不了，不是漏了。", inv.layerStyles));
            lines.push(SB.M("　要连图层样式一起搬：选中参考层 → 菜单「动画 > 将动画预设另存为」存成 .ffx，再到「歌词导入」页 ⑥ 里选它套过去。"));
        }
        lines.push(SB.M("属性项：%1，效果：%2，蒙版：%3，文字动画器：%4，文字样式项：%5，关键帧对时：%6 个%7",
            report.props, report.effects, report.masks, report.animators, report.textStyles, report.remapped,
            (report.ms > 0 ? SB.M("（耗时 %1 秒）", (report.ms / 1000).toFixed(1)) : "")));

        if (sampleIdx > 0 && sampleBefore && sampleAfter && sampleBefore.ok && sampleAfter.ok) {
            var same = (sampleBefore.text === sampleAfter.text);
            lines.push((same ? "⚠ " : "✓ ") + SB.M("第 %1 层实测：%2  →  %3", sampleIdx, sampleBefore.text, sampleAfter.text));
            if (same) {
                lines.push(SB.M("　（前后完全一样 —— 要么本来就同款样式，要么这次真的没写进去，看下面有没有报错）"));
            }
        }
        if (report.errors && report.errors.length > 0) {
            lines.push(SB.M("—— 有 %1 条提示 ——", report.errors.length));
            for (var i = 0; i < Math.min(report.errors.length, 8); i++) {
                lines.push("· " + report.errors[i]);
            }
        }
        push(SB.M("样式同步完成：%1 个图层", report.layers));
        return { ok: true, lines: lines };
    };

    /** 以参考图层重建（Ctrl+D 式）—— 需要 JS 那边先确认一次 */
    API.rebuild = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: false, error: SB.M("请先选择一个合成。") }; }
        var ref = null;
        try { ref = comp.layer(a.refIndex); } catch (eR) { ref = null; }
        if (!ref) { return { ok: false, error: SB.M("请先选择参考图层。") }; }
        if (!(ref instanceof TextLayer)) { return { ok: false, error: SB.M("参考图层必须是文字图层。") }; }

        var spec = U.parseIndexSpec(String(a.spec || ""), comp.numLayers);
        if (!spec || spec.error) { return { ok: false, error: SB.M("图层号有误：%1", (spec ? spec.error : SB.M("空"))) }; }

        /* 先收集 Layer 对象：删层会让编号失效，绝不能边删边按编号取 */
        var targets = [], names = [], i;
        for (i = 0; i < spec.list.length; i++) {
            var Lx = null;
            try { Lx = comp.layer(spec.list[i]); } catch (eL) { }
            if (!Lx || Lx === ref) { continue; }
            if (a.onlyText !== false && !(Lx instanceof TextLayer)) { continue; }
            targets.push(Lx);
            if (names.length < 4) { names.push("#" + Lx.index + " " + Lx.name); }
        }
        if (targets.length === 0) {
            return { ok: false, error: SB.M("没有可重建的目标图层（参考层本身会被跳过）。") };
        }
        if (!a.confirmed) {
            return {
                ok: false, needConfirm: {
                    kind: "rebuild", ref: ref.name, count: targets.length,
                    names: names, more: targets.length > 4
                }
            };
        }

        var mode = a.remapMode || "scale";
        push(SB.M("正在重建 0/%1……", targets.length));
        progWrite(0, targets.length, "r");
        var rep = ST.rebuildFromReference(comp, ref, targets, {
            remapMode: mode,
            onProgress: function (done, total) {
                /* 文件：每层都写，面板能实时看到 1/10、2/10……
                 * 日志：每 5 层记一条就够，免得 BR.state.log 塞满。 */
                progWrite(done, total, "r");
                if (done > 0 && done % 5 !== 0 && done < total) { return; }
                push(SB.M("正在重建 %1/%2……", done, total));
            }
        });
        progClear();

        var lines = [];
        lines.push(SB.M("以参考图层「%1」重建：%2/%3 个图层", ref.name, rep.ok, rep.total));
        lines.push(SB.M("关键帧对时：%1 个（%2）", rep.remapped,
            (mode === "scale" ? SB.M("缩放到每层入点出点") : (mode === "shift" ? SB.M("整体平移") : SB.M("不处理")))));
        if (rep.skipped > 0) { lines.push(SB.M("跳过：%1 个", rep.skipped)); }
        if (rep.errors && rep.errors.length > 0) {
            lines.push(SB.M("—— 有 %1 条报错 ——", rep.errors.length));
            for (var j = 0; j < Math.min(rep.errors.length, 6); j++) { lines.push("· " + rep.errors[j]); }
        } else {
            lines.push(SB.M("文字与入点出点已写回。可 Ctrl+Z 撤销。"));
        }
        push(SB.M("重建完成：%1 个图层", rep.ok));
        return { ok: true, lines: lines };
    };

    API.styleTextOnly = function (a) {
        var comp = compByIndex(a.compIndex);
        if (!comp) { return { ok: false, error: SB.M("请先选择一个合成。") }; }
        var ref = null;
        try { ref = comp.layer(a.refIndex); } catch (eR) { ref = null; }
        if (!ref) { return { ok: false, error: SB.M("请先选择参考图层。") }; }
        var spec = U.parseIndexSpec(String(a.spec || ""), comp.numLayers);
        if (!spec || spec.error) { return { ok: false, error: SB.M("图层号有误：%1", (spec ? spec.error : SB.M("空"))) }; }
        var rep = ST.applyTextStyleOnly(comp, ref, spec.list);
        return {
            ok: true, lines: [SB.M("只同步文字样式：处理 %1 个图层，样式项 %2 个；跳过 %3 个。", rep.layers, rep.textStyles, rep.skipped)]
        };
    };

    /* --- 在线歌词 --- */

    API.search = function (a) {
        var kw = U.trim(String(a.keyword || ""));
        if (kw === "") { return { ok: false, error: SB.M("请先输入歌名、歌手，或者直接粘贴歌曲链接 / 歌曲 ID。") }; }
        ON.onProgress = push;
        var t0 = new Date().getTime();
        var res = null;
        try { res = ON.search(a.platform === "qq" ? "qq" : "netease", kw); }
        catch (e) { ON.onProgress = null; return { ok: false, error: e.toString() }; }
        var ms = new Date().getTime() - t0;
        ON.onProgress = null;
        if (!res.ok) { return { ok: false, error: res.error, ms: ms }; }

        BR.state.songs = res.songs || [];
        var items = [];
        for (var i = 0; i < BR.state.songs.length; i++) {
            var s = BR.state.songs[i];
            var dur = s.duration > 0
                ? (" " + Math.floor(s.duration / 60) + ":" + U.pad(s.duration % 60, 2)) : "";
            items.push((i + 1) + ". " + s.name + " - " + s.singer +
                (s.album ? "《" + s.album + "》" : "") + dur);
        }
        return {
            ok: true, items: items,
            info: SB.M("找到 %1 首（用时 %2 ms，通道：%3）", BR.state.songs.length, ms, (ON.lastTransport || SB.M("无")))
        };
    };

    API.fetch = function (a) {
        var s = BR.state.songs[a.index];
        if (!s) { return { ok: false, error: SB.M("请先在列表里选一首歌。") }; }
        ON.onProgress = push;
        var res = null;
        try { res = ON.fetchLyrics(s); }
        catch (e) { ON.onProgress = null; return { ok: false, error: e.toString() }; }
        ON.onProgress = null;
        if (!res.ok) { return { ok: false, error: res.error }; }

        BR.state.current = s;
        BR.state.original = res.original || "";
        BR.state.translated = res.translated || "";
        var out = [];
        out.push("【" + s.name + " - " + s.singer + "】");
        out.push(SB.M("歌词通道：%1    原文 %2 行，译文 %3 行", (ON.lastTransport || ""),
            BR.state.original.split("\n").length,
            (U.trim(BR.state.translated) === "" ? 0 : BR.state.translated.split("\n").length)));
        out.push("");
        out.push(SB.M("—— 原文 ——"));
        out.push(U.trim(BR.state.original));
        if (U.trim(BR.state.translated) !== "") {
            out.push("");
            out.push(SB.M("—— 译文 ——"));
            out.push(U.trim(BR.state.translated));
        }
        return {
            ok: true, text: out.join("\n"),
            original: BR.state.original, translated: BR.state.translated
        };
    };

    /** 把上次取到的歌词原文/译文再给一次（「载入歌词导入页」用，不用重新联网） */
    API.lastLyrics = function () {
        if (!BR.state.current) {
            return { ok: false, error: SB.M("还没有获取到歌词，请先点「获取歌词（含译文）」。") };
        }
        return {
            ok: true,
            original: BR.state.original,
            translated: BR.state.translated,
            name: BR.state.current.name
        };
    };

    /* --- 关于 / 自检 --- */

    API.selfTest = function () {
        var lines = [];
        lines.push(SB.M("=== 版本 ==="));
        lines.push(SB.M("构建 %1", BR.versionLine()));
        lines.push(SB.M("面板时间戳：%1（CEP 版）", BR.build));
        try { lines.push(SB.M("AE 版本：%1 / build %2", app.version, app.buildNumber)); }
        catch (e) { lines.push(SB.M("AE 版本：读取失败")); }
        try { lines.push(SB.M("脚本引擎：%1  ExtendScript %2", $.engineName, $.version)); } catch (e2) { }
        try { lines.push(SB.M("系统：%1", $.os)); } catch (e3) { }

        lines.push("");
        lines.push(SB.M("=== 图层模块 ==="));
        try {
            var logs = LY.selfTest();
            for (var i = 0; i < logs.length; i++) { lines.push("· " + logs[i]); }
        } catch (e4) { lines.push(SB.M("· 自检失败：%1", e4.toString())); }

        lines.push("");
        lines.push(SB.M("=== 在线歌词通道 ==="));
        try { lines.push("· " + ON.probeTransport().note); }
        catch (e5) { lines.push(SB.M("· 检测失败：%1", e5.toString())); }

        lines.push("");
        lines.push(SB.M("=== 解析器自测 ==="));
        try {
            var p = L.parse("[00:01.00]甲\n[00:01.00]乙\n[00:03.00]丙"); // i18n-allow 自测用的假歌词数据
            var f = L.buildFrames(p, { gap: 0 });
            lines.push(SB.M("· LRC 解析：%1 行 → %2 帧（期望 2 帧）", p.items.length, f.length));
            lines.push(SB.M("· 第 1 帧内容：%1", f[0].text.replace(/\r/g, " | ")));
            var spec = U.parseIndexSpec("1-3,7", 10);
            lines.push(SB.M("· 图层号解析 1-3,7 → %1", U.formatIndexList(spec.list)));
        } catch (e6) { lines.push(SB.M("· 自检失败：%1", e6.toString())); }

        return { ok: true, lines: lines, text: lines.join("\n") };
    };

    API.probeOnline = function (a) {
        var kw = U.trim(String(a.keyword || "")) || "海阔天空"; // i18n-allow 默认搜索关键词（歌名）
        var lines = [];
        try { lines = ON.probeOnline(kw); }
        catch (e) { lines = [SB.M("体检本身出错：%1", e.toString())]; }
        var head = [SB.M("构建 %1", BR.versionLine()), SB.M("面板时间戳：%1（CEP 版）", BR.build), ""];
        return { ok: true, lines: head.concat(lines), text: head.concat(lines).join("\n") };
    };

    /** JS 那边定时来取进度消息（取完就清空） */
    API.log = function () {
        var out = BR.state.log;
        BR.state.log = [];
        return { ok: true, lines: out };
    };

    /* ---------------------------------------------------------------- 入口 */

    /**
     * CEP 面板的唯一入口。
     * @param {String} action  动作名
     * @param {String} argsJson  JSON 字符串（JS 那边做过转义，到这里是干净的 JSON）
     * @return {String} JSON 字符串
     */
    BR.invoke = function (action, argsJson) {
        var a = {};
        try { a = SB.JSON.parse(argsJson || "{}") || {}; } catch (e) { a = {}; }

        var fn = API[action];
        if (!fn) {
            return SB.JSON.stringify({ ok: false, error: SB.M("未知指令：%1", action) });
        }
        var out = null;
        try {
            out = fn(a);
        } catch (e) {
            var detail = "";
            try { detail = (e && e.description) ? e.description : String(e); } catch (e2) { detail = SB.M("未知错误"); }
            try { if (e && e.line !== undefined) { detail += SB.M("（第 %1 行）", e.line); } } catch (e3) { }
            out = { ok: false, error: detail };
        }
        if (!out) { out = { ok: false, error: SB.M("（动作没有返回值）") }; }
        try {
            return SB.JSON.stringify(out);
        } catch (eS) {
            return "{\"ok\":false,\"error\":\"" + SB.M("结果序列化失败") + "\"}";
        }
    };

    root.Bridge = BR;

    /* 短别名：面板那边写的是 SB.invoke(...)，跟 SB.Bridge.invoke 是同一个函数。
     * 两个都挂着 —— 只挂 Bridge.invoke 的话，面板每次 evalScript 都会因为
     * 「SB.invoke 不是函数」拿到 "EvalScript error."，表现就是所有按钮都报
     * 「返回内容不是合法 JSON」。 */
    root.invoke = BR.invoke;
})();
