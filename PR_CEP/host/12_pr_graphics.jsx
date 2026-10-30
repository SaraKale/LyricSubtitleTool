/* ============================================================================
 *  ⛔ 已停用（2026-10）—— 面板侧的入口已经关掉了，这段代码目前不会被调用。
 *  ---------------------------------------------------------------------------
 *  为什么停用：PR 自己导出的 .mogrt 内部是 project.prgraphic，文字参数
 *  （TextLayer）**脚本写不进去** —— 剪辑能插进去、条数也对、setValue 不报错，
 *  但屏幕上永远是模板占位符，时间线上每条剪辑的名字也不变。只有 AE 导出的
 *  aegraphic 模板（文字参数叫 Text）才能改。Adobe 也明确说过「字幕升级为图形」
 *  没有 API。
 *
 *  现在面板只有「① 字幕轨道」一条路（写 .srt → createCaptionTrack）。
 *
 *  想恢复：
 *    1) PR_CEP/client/app.js 里把 GFX_ENABLED 改回 true；
 *    2) PR_CEP/client/index.html 里把 <section data-key="gfx"> 那段注释放出来；
 *    3) 重新构建安装。
 *  宿主侧这一整套（母版复制 / 8 种参数形状 / 静默失败验证 / MGT 参数注入）
 *  是完好的，只是没人调它 —— 留着是为了有 aegraphic 模板时能立刻接上。
 * ============================================================================
 *
 *  12_pr_graphics.jsx —— PR 的「图形剪辑」通道（= 在视频轨道上批量造文字图层）
 *  ---------------------------------------------------------------------------
 *  这是对用户那句「PR 是复制粘贴图层，但样式复制不过去，能重建吗」的正面回答：
 *
 *      **能，而且比复制粘贴更省事 —— 用一个母版，脚本替你复制 N 次。**
 *
 *  原理：
 *    PR 里的文字（基本图形 / MOGRT 动态图形模板）是一个「剪辑」，
 *    它的样式和文字内容都存在剪辑的 MGT 组件（Essential Graphics 参数）里。
 *    ExtendScript 拿得到这个组件：
 *
 *        clip.getMGTComponent()            → 组件
 *        comp.properties                   → 参数集合（numItems / [i]）
 *        props.getParamForDisplayName("…")  → 按名字取参数
 *        param.getValue() / setValue(v, true)
 *
 *    而文字参数的 getValue() 返回的是一段 **JSON 字符串**，长这样：
 *        { "textEditValue": "当前文字",
 *          "fontEditValue": "思源黑体",
 *          "fontSizeEditValue": 48,
 *          "fontTextRunLength": [4] }
 *    改 textEditValue 就能换字，同时必须把 fontTextRunLength 同步成新长度。
 *    —— 字体、字号这些字段就躺在同一段 JSON 里，所以**样式是被原样继承的**，
 *    我们只动文字，不碰样式。这就是「重建」的真正含义：
 *    不是重新拼一套样式，而是复用母版那一套。
 *
 *  四种母版来源（面板上四选一）：
 *    mogrt    —— 选一个 .mogrt 文件，用 Sequence.importMGT 放进去
 *    project  —— 项目面板里已有的图形 / MOGRT 素材
 *    track    —— 时间线上已有的某个剪辑（下拉里按「V1 第 2 个」这样挑）
 *    selection—— **时间线上你选中的那个剪辑**（最贴近你原来的 Ctrl+C 习惯：
 *                先在时间线上调好一个满意的文字，选中它，让插件照着复制）
 *
 *  空白序列能不能用？
 *    mogrt / project 能 —— 它们不需要时间线上有任何东西，
 *    importMGT / overwriteClip 直接往空轨道上放第一个剪辑就成了。
 *    track / selection 不能 —— 时间线上什么都没有，自然挑不出母版；
 *    这两种会明确报错并提示改用前两种。
 *
 *  ⚠ 关于「明明选中了却说没选中」：
 *    Sequence.getSelection() 在 PR 里不太可靠（面板抢焦点、刚改完选区等时刻
 *    会返回空数组），而 UXP 那套带 .numItems 的集合形状在 ExtendScript 里并不存在。
 *    所以 G.selectedClip() 先试官方接口，再**自己扫所有轨道的 selected 标记**兜底；
 *    即便如此还拿不到，就自动退回「时间线上第一个带 MGT 的剪辑」并给出提示。
 *    真要不依赖选区，就用 track / mogrt / project 这三种。
 *
 *  批量生成时每条字幕的动作：
 *    插一个母版剪辑 → 挪到目标时间 → 掐到该句的起止 → 改文字
 *  样式、动画、位置全部继承母版，一个字都不用重设。
 *
 *  已知边界（写在代码里免得以后又踩）：
 *    · 只有 AE 导出的 .mogrt 参数能被完整脚本访问；PR 自己「新建文字」出来的
 *      图形剪辑参数暴露得不全（文字参数一般有，颜色有时有有时没有）。
 *      所以「设置字号 / 颜色」在本文件里是**可选**的：参数在就设，不在就跳过并报告，
 *      绝不因为设不了样式就让整批生成失败。
 *    · overwriteClip 是**覆盖式**的：目标轨道上原有的东西会被压掉。
 *      所以默认挑一条空轨道，非空轨道会先警告。
 *    · 插入这件事 PR 各版本支持不一致，而且失败**大多是静默的** ——
 *      不抛异常也不返回 false，就是什么都没发生。所以 insertOne 里
 *      按「参数形状矩阵」逐个试（秒字符串 / ticks 字符串 / Time 对象 × 4 个接口），
 *      每试一次都用「轨道上的剪辑数有没有变多」验证，第一次成功的形状记下来复用。
 *      另外：序列没有音频轨时 aTrackIndex 必须传 -1，传 0 是越界 → 静默失败。
 *      还有：**锁定的轨道也写不进去**，同样不报错，所以失败时会报告轨道锁定状态。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var S = root.Seq;
    var C = root.Cap;

    var G = {};
    root.Gfx = G;

    /* JSON 一律走 01_json.jsx 那份手写实现（SB.JSON）。
     * 新一点的 ExtendScript 引擎其实自带 JSON，但：
     *   ① ES3 兼容检查会拦下 JSON.parse / JSON.stringify 这种写法；
     *   ② 自带那份和手写那份在边界行为上不完全一样，两边混用会出现
     *      「在 AE 里行、在 PR 里不行」这种最难查的问题。
     * 所以这里不留任何「优先用原生」的分支。 */
    function J() { return root.JSON; }

    /* ---------------------------------------------------------------- 文本参数识别 */

    /**
     * 一个参数值是不是「文字参数」的那种结构。是就返回解析后的对象。
     *
     * ⚠ 有些 PR 版本 getValue() 返回的是**对象**，不是 JSON 字符串。
     * 以前这里只认字符串 —— 那种版本下：识别文字参数失败（三级兜底全落空）、
     * 改写也只剩「纯文本」一种写法，最后 setValue 被静默拒绝，
     * 表现就是「插进去了但文字还是模板占位符」。所以对象和字符串都要认。
     * 返回的是**副本**，调用方可以放心改，不会动到宿主里那个活对象。
     */
    function asTextJson(raw) {
        if (raw === null || raw === undefined) { return null; }
        if (typeof raw === "object") {
            if (typeof raw.textEditValue !== "string") { return null; }
            var dup = {};
            for (var k in raw) { try { dup[k] = raw[k]; } catch (eD) { } }
            return dup;
        }
        if (typeof raw !== "string") { return null; }
        var s = U.trim(raw);
        if (s.length < 2 || s.charAt(0) !== "{") { return null; }
        var o = null;
        try { o = J().parse(s); } catch (e) { return null; }
        if (!o) { return null; }
        return (typeof o.textEditValue === "string") ? o : null;
    }

    /* 名字里出现这些词，就更可能是「文字」参数。英文 + 中文都列上，
       因为 PR 的界面语言不同，displayName 也跟着变。
       ⚠ 这是**匹配用的数据**，不是界面文案 —— 翻掉它，中文版 PR 就再也认不出
       文字参数了。所以整块 i18n-allow。 */
    /* i18n-allow */
    var TEXT_HINTS = ["text", "source", "title", "caption", "label", "content", "line",
        "文字", "文本", "源", "标题", "字幕", "内容", "标签"];
    /* i18n-allow-end */

    function looksLikeText(name) {
        var n = String(name).toLowerCase();
        for (var i = 0; i < TEXT_HINTS.length; i++) {
            if (n.indexOf(TEXT_HINTS[i]) >= 0) { return true; }
        }
        return false;
    }

    /* ---------------------------------------------------------------- 参数读写 */

    /**
     * 按名字找一个 MGT 参数。三层兜底：
     *   ① 官方 getParamForDisplayName（界面语言不同，displayName 也不同）
     *   ② 按内部 name 精确比
     *   ③ 按「名字像文字」扫一遍（只在 paramName 本身就找不到时才用）
     * 为什么要有 ②③：中文界面下 displayName 是「文本图层」，
     * 而模板 definition.json 里的 uiName 是 "TextLayer" —— 两边对不上就白找。
     */
    function findParam(mgt, paramName, info) {
        if (!mgt) { return null; }
        var p = null;
        try { p = mgt.properties.getParamForDisplayName(paramName); } catch (e0) { }
        if (p) { if (info) { info.via = "displayName"; } return p; }

        var props = null;
        try { props = mgt.properties; } catch (e1) { return null; }
        if (!props) { return null; }
        var n = 0;
        try { n = props.numItems; } catch (e2) { return null; }

        var i, q;
        for (i = 0; i < n; i++) {
            try { q = props[i]; } catch (e3) { continue; }
            if (!q) { continue; }
            var nm = "", dn = "";
            try { nm = String(q.name); } catch (e4) { }
            try { dn = String(q.displayName); } catch (e5) { }
            if (nm === String(paramName) || dn === String(paramName)) {
                if (info) { info.via = "name"; }
                return q;
            }
        }
        /* ③ 名字都对不上就挑一个「值里带 textEditValue 的」—— 这是文字参数最硬的标志。
         *    用户填错了名字时这样能自动纠正，但**必须报出去**，不能悄悄换掉。 */
        for (i = 0; i < n; i++) {
            try { q = props[i]; } catch (e6) { continue; }
            if (!q) { continue; }
            var v = null;
            try { v = q.getValue(); } catch (e7) { continue; }
            if (asTextJson(v)) { if (info) { info.via = "auto"; } return q; }
        }
        return null;
    }

    /**
     * 列出一个剪辑（或母版剪辑）上的全部 MGT 参数。
     * 返回 { ok, params:[{index,name,displayName,kind,isText,text,preview}] }
     */
    G.paramsOf = function (clip) {
        if (!clip) {
            return { ok: false, error: SB.M("没有可读取的剪辑。请先在时间线上选中一个文字/图形剪辑。") };
        }
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (e) { }
        if (!mgt) {
            return {
                ok: false,
                error: SB.M("选中的这个剪辑没有「基本图形」组件。只有文字、形状、MOGRT 这类图形剪辑才有可脚本修改的参数。")
            };
        }
        var props = null;
        try { props = mgt.properties; } catch (e1) { }
        if (!props) {
            return { ok: false, error: SB.M("拿不到这个剪辑的参数集合（properties）。") };
        }

        var n = 0;
        try { n = props.numItems; } catch (e2) { }
        var out = [];
        for (var i = 0; i < n; i++) {
            var p = null;
            try { p = props[i]; } catch (e3) { continue; }
            if (!p) { continue; }

            var o = { index: i, name: "", displayName: "", kind: "", isText: false, text: "", preview: "" };
            try { o.name = String(p.name); } catch (e4) { }
            try { o.displayName = String(p.displayName); } catch (e5) { }
            if (!o.displayName) { o.displayName = o.name; }

            var v = null;
            try { v = p.getValue(); } catch (e6) { }
            o.kind = (v === null || v === undefined) ? "null" : (typeof v);

            var tj = asTextJson(v);
            if (tj) {
                o.isText = true;
                o.text = String(tj.textEditValue);
                o.preview = o.text.replace(/\r/g, " / ").replace(/\n/g, " / ");
                if (o.preview.length > 40) { o.preview = o.preview.substring(0, 40) + "…"; }
                if (tj.fontEditValue) { o.font = String(tj.fontEditValue); }
                if (tj.fontSizeEditValue) { o.size = tj.fontSizeEditValue; }
            } else if (typeof v === "string") {
                o.preview = (v.length > 40) ? (v.substring(0, 40) + "…") : v;
                o.isText = looksLikeText(o.displayName) || looksLikeText(o.name);
                if (o.isText) { o.text = v; }
            } else if (typeof v === "number") {
                o.preview = String(v);
            }
            out.push(o);
        }
        return { ok: true, params: out, count: out.length };
    };

    /**
     * 自动挑一个「最像文字」的参数。
     * 优先级：值里带 textEditValue 的 JSON > 名字像文字 > 值是非空字符串且名字像文字
     */
    G.autoPickText = function (clip) {
        var r = G.paramsOf(clip);
        if (!r.ok) { return r; }
        var list = r.params;
        var i, best = -1;
        for (i = 0; i < list.length; i++) {
            if (list[i].isText && list[i].kind === "string" && asTextJsonMaybe(list[i])) { best = i; break; }
        }
        if (best < 0) {
            for (i = 0; i < list.length; i++) {
                if (list[i].isText) { best = i; break; }
            }
        }
        if (best < 0) {
            for (i = 0; i < list.length; i++) {
                if (list[i].kind === "string" && looksLikeText(list[i].displayName)) { best = i; break; }
            }
        }
        if (best < 0) {
            return { ok: false, params: list, error: SB.M("没能自动认出文字参数。请手动指定（见下方参数列表）。") };
        }
        return { ok: true, params: list, index: list[best].index, name: list[best].displayName };
    };

    /* paramsOf 里已经把 JSON 解析过了，这里只需要判断「它是不是 JSON 那种」，
       用一个轻量标记避免重复解析 */
    function asTextJsonMaybe(p) { return p.isText === true; }

    /**
     * 探测「字幕剪辑能不能当文字载体」。
     *
     * 想法是：PR 原生字幕既然能建出来，能不能拿它当中转，把文字再灌进图形模板？
     * —— 灌进去那一步正是 PR 原生模板挡路的地方，所以这个绕法本身不通。
     * 但它顺带提出一个**真问题**：字幕剪辑也是 TrackItem，也有 getMGTComponent()。
     * 万一字幕剪辑暴露的参数里有一个能写的文字参数，那就等于多了一条
     * 「不依赖任何 .mogrt」的原生文字通道 —— 值得实测，不值得猜。
     *
     * 不同 PR 版本行为不一样，而且失败是静默的，所以做成探测：
     * 把第一条字幕剪辑的 components / getMGTComponent() / 参数清单全吐出来。
     * 面板「生成字幕轨」之后会自动跑一次，结论直接写进结果框。
     * **纯只读，不改任何东西。**
     */
    G.probeCaptionText = function (seqName) {
        var out = {
            ok: false, tracks: 0, clipsSeen: 0,
            hasMgt: false, params: [], textParam: "", textParamValue: "",
            components: [], note: "", error: ""
        };
        var seq = S.active();
        if (seqName) {
            var b = S.byName(seqName);
            if (b) { seq = b; }
        }
        if (!seq) { out.error = SB.M("没有打开的序列。"); return out; }

        var cols = null;
        try { cols = seq.captionTracks; } catch (e0) { }
        if (!cols) {
            out.error = SB.M("这个版本没有字幕轨集合（captionTracks），探不了。");
            return out;
        }
        var n = 0;
        try { n = cols.numTracks; } catch (e1) { }
        out.tracks = n;

        var clip = null;
        for (var i = 0; i < n; i++) {
            var cs = null;
            try { cs = cols[i].clips; } catch (e2) { }
            if (!cs) { continue; }
            var m = 0;
            try { m = cs.numItems; } catch (e3) { }
            out.clipsSeen += m;
            if (m > 0 && !clip) { try { clip = cs[0]; } catch (e4) { } }
        }
        if (!clip) {
            out.note = SB.M("字幕轨上还没有字幕条 —— 先「生成字幕轨」再来探测。");
            return out;
        }

        /* ① 这个剪辑挂了哪些组件 —— 字幕在 PR 里走哪条管线，看这里最直接 */
        var comps = null;
        try { comps = clip.components; } catch (e5) { }
        if (comps) {
            var cn = 0;
            try { cn = comps.numItems; } catch (e6) { }
            for (var c = 0; c < cn; c++) {
                var cp = null;
                try { cp = comps[c]; } catch (e7) { continue; }
                if (!cp) { continue; }
                var o = { matchName: "", displayName: "" };
                try { o.matchName = String(cp.matchName); } catch (e8) { }
                try { o.displayName = String(cp.displayName); } catch (e9) { }
                out.components.push(o);
            }
        }

        /* ② 有没有「基本图形」组件 */
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (eA) { }
        out.hasMgt = mgt ? true : false;
        if (!mgt) {
            out.note = SB.M("字幕剪辑没有「基本图形」组件 —— 它的文字不走脚本能改的那条管线。");
            return out;
        }

        /* ③ 有的话，参数里有没有能写的文字参数 */
        var pr = G.paramsOf(clip);
        if (pr.ok) { out.params = pr.params; }
        for (var k = 0; k < out.params.length; k++) {
            if (out.params[k].isText) {
                out.textParam = out.params[k].displayName || out.params[k].name;
                out.textParamValue = out.params[k].preview || "";
                break;
            }
        }
        out.ok = true;
        out.note = out.textParam
            ? SB.M("字幕剪辑有基本图形组件，里面还有一个像文字的参数（%1）—— 值得试着往里写。", out.textParam)
            : SB.M("字幕剪辑有基本图形组件，但里面没有像文字的参数。");
        return out;
    };

    /**
     * 把文字写进某个参数。text 里的换行按 newline 转成 PR 认的分隔符。
     * 返回 { ok, mode, error }
     */
    G.setText = function (clip, paramName, text, newline) {
        if (!clip) { return { ok: false, error: SB.M("没有剪辑") }; }
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (e) { }
        if (!mgt) { return { ok: false, error: SB.M("这个剪辑没有基本图形组件") }; }

        var pinfo = {};
        var p = findParam(mgt, paramName, pinfo);
        if (!p) { return { ok: false, error: SB.M("找不到参数：%1", paramName) }; }

        var nl = (newline === "\\n" || newline === "\n") ? "\n" : "\r";
        var t = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").join(nl);

        /* 原始值可能是字符串也可能是对象，两种都要拿住。 */
        var rawObj = null;
        try { rawObj = p.getValue(); } catch (e2) { rawObj = null; }
        var raw = "";
        try { raw = String(rawObj); } catch (e3) { raw = ""; }

        /* 把「可能的写法」按「风险从低到高」排好，逐个试、逐个读回验证。
         *
         * 为什么要手术式（只换一个值、其余字节原样不动）：
         * 文字参数的值是一段 JSON，而 ES3 里没有原生 JSON，用的是手写的
         * SB.JSON —— 重新序列化有可能改变格式（数字写法、转义、字段顺序），
         * PR 对这种字符串是**格式敏感**的，改完可能整段被静默拒绝，
         * 表现就是「插进去了但文字还是模板的占位符」。
         * 只替换 textEditValue 那一段，其他字节一个不动，风险最小。 */
        var modes = [];
        var sRun = "", sOnly = "";
        if (raw.length > 1 && raw.charAt(0) === "{") {
            sRun = patchJsonString(
                patchJsonString(raw, "textEditValue", "\"" + jsonEscape(t) + "\""),
                "fontTextRunLength", "[" + t.length + "]");
            if (sRun) { modes.push({ mode: "surgical+run", val: sRun }); }

            sOnly = patchJsonString(raw, "textEditValue", "\"" + jsonEscape(t) + "\"");
            if (sOnly && sOnly !== sRun) { modes.push({ mode: "surgical", val: sOnly }); }
        }

        var obj = asTextJson(rawObj);
        if (obj) {
            obj.textEditValue = t;
            if (obj.fontTextRunLength !== undefined && obj.fontTextRunLength !== null) {
                obj.fontTextRunLength = [t.length];
            }
            var sRe = "";
            try { sRe = J().stringify(obj); } catch (e4) { sRe = ""; }
            if (sRe && sRe !== sRun && sRe !== sOnly) { modes.push({ mode: "rebuild", val: sRe }); }

            /* 有的版本 setValue 收的是**对象**而不是字符串（Adobe 官方示例
             * 就是直接把 getValue() 拿到的对象改完再传回去）。补一种写法，
             * 免得那种版本下前面几种全被拒、只剩纯文本在硬撑。 */
            var obj2 = asTextJson(rawObj);
            if (obj2) {
                obj2.textEditValue = t;
                if (obj2.fontTextRunLength !== undefined && obj2.fontTextRunLength !== null) {
                    obj2.fontTextRunLength = [t.length];
                }
                modes.push({ mode: "object", val: obj2 });
            }
        }
        modes.push({ mode: "plain", val: t });

        var errs = [];
        for (var m = 0; m < modes.length; m++) {
            var wrote = false;
            try { p.setValue(modes[m].val, true); wrote = true; }
            catch (eA) {
                try { p.setValue(modes[m].val, false); wrote = true; }
                catch (eB) {
                    /* 还有的版本只认单参数签名 —— 三种都试过才算真失败 */
                    try { p.setValue(modes[m].val); wrote = true; }
                    catch (eC) { errs.push(modes[m].mode + ": " + eC); continue; }
                }
            }
            if (!wrote) { errs.push(modes[m].mode + ": " + SB.M("调用没成功")); continue; }

            /* ⚠ setValue 不返回成败，写了没生效是常态 —— 必须读回来确认。
             * 不确认的话就会出现「脚本说成功了，屏幕上还是占位符」这种事。 */
            if (readBackHas(p, t)) { return { ok: true, mode: modes[m].mode, via: String(pinfo.via || "") }; }
            errs.push(modes[m].mode + " → " + SB.M("写了，但读回来没变"));
        }
        /* 失败时把「这个参数现在到底是什么」一起带出去。
         * PR 的写入失败是静默的，没有这段原始值就只能靠猜 ——
         * 用户得再跑一轮、再来回问一次。一次说清楚。 */
        var dump = "";
        if (raw) { dump = raw.length > 200 ? raw.substring(0, 200) + "…" : raw; }
        return {
            ok: false, mode: "", via: String(pinfo.via || ""),
            error: errs.join("；"), raw: dump
        };
    };

    /**
     * 在原始 JSON 字符串里只替换某一个键的值，其余字节一个不动。
     * 找不到那个键、或者值不是合法的 JSON 片段，就返回 ""。
     */
    function patchJsonString(raw, key, newJsonValue) {
        if (!raw) { return ""; }
        var at = raw.indexOf("\"" + key + "\"");
        if (at < 0) { return ""; }
        var colon = raw.indexOf(":", at);
        if (colon < 0) { return ""; }
        var i = colon + 1;
        while (i < raw.length && (raw.charAt(i) === " " || raw.charAt(i) === "\t")) { i++; }
        var start = i, end = -1, c0 = raw.charAt(i);

        if (c0 === "\"") {
            /* 字符串值：扫到配对的引号，跳过 \" 转义 */
            i++;
            while (i < raw.length) {
                var ch = raw.charAt(i);
                if (ch === "\\") { i += 2; continue; }
                if (ch === "\"") { end = i + 1; break; }
                i++;
            }
        } else if (c0 === "[") {
            var depth = 0;
            while (i < raw.length) {
                var c2 = raw.charAt(i);
                if (c2 === "[") { depth++; }
                else if (c2 === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
                i++;
            }
        } else if (c0 === "{") {
            var d2 = 0;
            while (i < raw.length) {
                var c3 = raw.charAt(i);
                if (c3 === "{") { d2++; }
                else if (c3 === "}") { d2--; if (d2 === 0) { end = i + 1; break; } }
                i++;
            }
        } else {
            while (i < raw.length) {
                var c4 = raw.charAt(i);
                if (c4 === "," || c4 === "}" || c4 === "]" || c4 === " " || c4 === "\r" || c4 === "\n") { break; }
                i++;
            }
            end = i;
        }
        if (end < 0 || end <= start) { return ""; }
        return raw.substring(0, start) + newJsonValue + raw.substring(end);
    }

    /** JSON 字符串转义。**非 ASCII 字符原样保留** —— 不要转成 \uXXXX，
     *  PR 收的是真字符，转义写法有的版本认不出来。 */
    function jsonEscape(s) {
        var out = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            var code = s.charCodeAt(i);
            if (c === "\"") { out += "\\\""; }
            else if (c === "\\") { out += "\\\\"; }
            else if (c === "\n") { out += "\\n"; }
            else if (c === "\r") { out += "\\r"; }
            else if (c === "\t") { out += "\\t"; }
            else if (code < 32) { out += " "; }
            else { out += c; }
        }
        return out;
    }

    /** 读回参数值，看新文字到底进去没有（转义形式、去换行形式都比一次） */
    function readBackHas(p, t) {
        var v = null;
        try { v = p.getValue(); } catch (e) { return false; }
        if (v === null || v === undefined) { return false; }
        /* 返回对象时 String(v) 会得到 "[object Object]"，得直接取 textEditValue */
        var s = "";
        if (typeof v === "object") {
            try { s = (typeof v.textEditValue === "string") ? v.textEditValue : String(v); }
            catch (e2) { s = String(v); }
        } else {
            s = String(v);
        }
        if (t.length > 0 && s.indexOf(t) >= 0) { return true; }
        if (s.length > 1 && s.charAt(0) === "{") {
            var o = asTextJson(s);
            if (o && o.textEditValue) {
                if (String(o.textEditValue).indexOf(t) >= 0) { return true; }
                if (String(o.textEditValue).indexOf(jsonEscape(t)) >= 0) { return true; }
            }
        }
        var esc = jsonEscape(t);
        if (esc !== t && s.indexOf(esc) >= 0) { return true; }
        var flat = t.replace(/[\r\n]/g, "");
        if (flat.length > 0 && s.indexOf(flat) >= 0) { return true; }
        return false;
    }

    /** 读回一个参数当前的文字（用于生成后核对） */
    G.getText = function (clip, paramName) {
        if (!clip) { return ""; }
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (e) { return ""; }
        if (!mgt) { return ""; }
        var p = findParam(mgt, paramName);
        if (!p) { return ""; }
        var raw = null;
        try { raw = p.getValue(); } catch (e2) { return ""; }
        var obj = asTextJson(raw);
        if (obj) { return String(obj.textEditValue); }
        return (typeof raw === "string") ? raw : "";
    };

    /** 可选：设数值参数（字号之类）。找不到就返回 ok:false，由调用方决定要不要报。 */
    G.setNumber = function (clip, paramName, value) {
        if (!clip || !paramName) { return { ok: false, skipped: true }; }
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (e) { return { ok: false, skipped: true }; }
        if (!mgt) { return { ok: false, skipped: true }; }
        var p = findParam(mgt, paramName);
        if (!p) { return { ok: false, skipped: true, error: SB.M("找不到参数：%1", paramName) }; }
        try { p.setValue(U.toNumber(value, 0), true); return { ok: true }; }
        catch (e2) { return { ok: false, error: String(e2) }; }
    };

    /** 可选：设颜色参数。PR 的颜色顺序是 (alpha, red, green, blue)。 */
    G.setColor = function (clip, paramName, r, g, b) {
        if (!clip || !paramName) { return { ok: false, skipped: true }; }
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (e) { return { ok: false, skipped: true }; }
        if (!mgt) { return { ok: false, skipped: true }; }
        var p = findParam(mgt, paramName);
        if (!p) { return { ok: false, skipped: true, error: SB.M("找不到参数：%1", paramName) }; }
        try {
            p.setColorValue(255, U.toNumber(r, 255), U.toNumber(g, 255), U.toNumber(b, 255), true);
            return { ok: true };
        } catch (e2) { return { ok: false, error: String(e2) }; }
    };

    /* ---------------------------------------------------------------- 项目面板 / 选中项 */

    /**
     * 项目面板里所有可当模板的项（跳过素材箱）。项目太大时只取前 max 个。
     *
     * 会带上 isSeq —— **序列不能当图形剪辑的母版**（PR 不会把序列放进另一条序列的
     * 轨道上，而且是静默拒绝）。面板据此在列表里标出来，免得用户白挑一个。
     */
    G.projectItems = function (max) {
        if (!max) { max = 400; }
        var out = [];
        function walk(bin, depth) {
            if (out.length >= max) { return; }
            var n = 0;
            try { n = bin.children.numItems; } catch (e) { return; }
            for (var i = 0; i < n && out.length < max; i++) {
                var it = null;
                try { it = bin.children[i]; } catch (e1) { continue; }
                if (!it) { continue; }
                var t = "";
                try { t = String(it.type); } catch (e2) { }
                if (t === "BIN") { walk(it, depth + 1); continue; }
                var o = { name: "", type: t, depth: depth, isSeq: false };
                try { o.name = String(it.name); } catch (e3) { }
                try { if (it.isSequence) { o.isSeq = it.isSequence() ? true : false; } } catch (e4) { }
                out.push(o);
            }
        }
        try { walk(app.project.rootItem, 0); } catch (e5) { }
        return out;
    };

    /** 按名字在项目面板里找项目项（先浅层后深层，重名取先遇到的） */
    G.findProjectItem = function (name) {
        var found = null;
        function walk(bin) {
            if (found) { return; }
            var n = 0;
            try { n = bin.children.numItems; } catch (e) { return; }
            for (var i = 0; i < n && !found; i++) {
                var it = null;
                try { it = bin.children[i]; } catch (e1) { continue; }
                if (!it) { continue; }
                var t = "";
                try { t = String(it.type); } catch (e2) { }
                if (t === "BIN") { walk(it); continue; }
                if (String(it.name) === String(name)) { found = it; return; }
            }
        }
        try { walk(app.project.rootItem); } catch (e3) { }
        return found;
    };

    /**
     * 把一个「选中集合」拆成剪辑数组。
     *
     * 为什么要写这么啰嗦：ExtendScript 的 Sequence.getSelection() 返回的是一个
     * **普通 Array**（.length / [i]），而 UXP 版的 SequenceEditor.getSelection()
     * 返回的才是带 .numItems 的 TrackItemSelection。两种形状在真实环境里都碰到过，
     * 早先只按 .numItems 判空 —— 遇到普通 Array 时 n 是 undefined，
     * 循环判断全落空，最后返回 undefined，症状就是「明明选中了却说没选中」。
     * 所以这里三种形状都认：集合对象 / 数组 / 单个剪辑。
     */
    function selectionToClips(sel) {
        var out = [];
        if (!sel) { return out; }

        /* ① 集合对象（.numItems + [i]） */
        var n = null;
        try { n = sel.numItems; } catch (e0) { n = null; }
        if (typeof n === "number" && n > 0) {
            for (var i = 0; i < n; i++) {
                try { if (sel[i]) { out.push(sel[i]); } } catch (e1) { }
            }
            return out;
        }

        /* ② 普通数组 */
        var len = null;
        try { len = sel.length; } catch (e2) { len = null; }
        if (typeof len === "number") {
            for (var j = 0; j < len; j++) {
                try { if (sel[j]) { out.push(sel[j]); } } catch (e3) { }
            }
            return out;
        }

        /* ③ 单个剪辑对象（有 start/end，或能取到 projectItem） */
        var isClip = false;
        try { if (sel.start !== undefined || sel.projectItem !== undefined) { isClip = true; } }
        catch (e4) { isClip = false; }
        if (isClip) { out.push(sel); }
        return out;
    }

    /** 一个剪辑是不是「选中」状态。PR 里 TrackItem 没有稳定的 selected 属性，
        各版本/各语言下名字不完全一样，所以把可能的写法都试一遍。 */
    function isClipSelected(clip) {
        var names = ["selected", "isSelected", "selectionState"];
        for (var i = 0; i < names.length; i++) {
            var val = undefined;
            try { val = clip[names[i]]; } catch (e) { val = undefined; }
            if (val === true) { return true; }
            if (typeof val === "number" && val > 0) { return true; }
        }
        return false;
    }

    /**
     * 时间线上当前选中的第一个剪辑。
     *
     * 两条路，缺一不可：
     *   A. seq.getSelection() —— 官方接口，但在「面板抢了焦点」「选中状态刚变」
     *      这些时刻经常返回空数组，这是用户实测踩到的坑。
     *   B. 兜底：自己遍历所有轨道上的剪辑，找 selected 标记为真的那个。
     *      慢一点（几十个剪辑无所谓），但不会莫名其妙地说「没选中」。
     */
    G.selectedClip = function (seq) {
        if (!seq) { seq = S.active(); }
        if (!seq) { return null; }

        /* A. 官方接口 */
        var sel = null;
        try { sel = seq.getSelection(); } catch (e) { sel = null; }
        var arr = selectionToClips(sel);
        if (arr.length > 0) { return arr[0]; }

        /* B. 扫轨道 */
        var kinds = ["video", "audio"];
        for (var k = 0; k < kinds.length; k++) {
            var list = [];
            try { list = S.tracks(seq, kinds[k]); } catch (eT) { list = []; }
            for (var t = 0; t < list.length; t++) {
                var track = null;
                try { track = (kinds[k] === "video") ? seq.videoTracks[list[t].index] : seq.audioTracks[list[t].index]; }
                catch (eTr) { continue; }
                if (!track) { continue; }
                var clips = null;
                try { clips = track.clips; } catch (eC) { continue; }
                var n = 0;
                try { n = clips.numItems; } catch (eN) { continue; }
                for (var c = 0; c < n; c++) {
                    var cl = null;
                    try { cl = clips[c]; } catch (eCl) { continue; }
                    if (cl && isClipSelected(cl)) { return cl; }
                }
            }
        }
        return null;
    };

    /**
     * 时间线上所有轨道上的剪辑，摊平成一个列表。
     * 面板的「母版来源 → 时间线上已有的剪辑」下拉就用它 ——
     * 这条路**完全不依赖选中状态**，所以是选区接口失灵时最稳的备选。
     * 返回 [{ vTrack, aTrack, index, name, start, end, hasMGT }]
     */
    G.timelineClips = function (seq, max) {
        if (!seq) { seq = S.active(); }
        if (!seq) { return []; }
        var cap = U.toNumber(max, 200);
        var out = [];

        function scan(kind, idx) {
            var track = null;
            try {
                track = (kind === "video") ? seq.videoTracks[idx] : seq.audioTracks[idx];
            } catch (e0) { return; }
            if (!track) { return; }
            var clips = null;
            try { clips = track.clips; } catch (e1) { return; }
            var n = 0;
            try { n = clips.numItems; } catch (e2) { return; }
            for (var c = 0; c < n; c++) {
                if (out.length >= cap) { return; }
                var cl = null;
                try { cl = clips[c]; } catch (e3) { continue; }
                if (!cl) { continue; }
                var o = {
                    kind: kind,
                    vTrack: (kind === "video") ? idx : -1,
                    aTrack: (kind === "audio") ? idx : -1,
                    index: c,
                    name: "",
                    start: S.secOf(cl.start, 0),
                    end: S.secOf(cl.end, 0),
                    hasMGT: false,
                    hasItem: false,
                    selected: false
                };
                try { o.name = String(cl.name); } catch (e4) { }
                try { o.hasItem = (cl.projectItem) ? true : false; } catch (e5) { }
                try { o.hasMGT = (cl.getMGTComponent && cl.getMGTComponent()) ? true : false; } catch (e6) { }
                o.selected = isClipSelected(cl);
                out.push(o);
            }
        }

        var vt = [];
        try { vt = S.tracks(seq, "video"); } catch (eV) { vt = []; }
        for (var i = 0; i < vt.length; i++) { scan("video", vt[i].index); }

        var at = [];
        try { at = S.tracks(seq, "audio"); } catch (eA) { at = []; }
        for (var j = 0; j < at.length; j++) { scan("audio", at[j].index); }

        return out;
    };

    /** 按「轨道 + 序号」把剪辑对象取回来（面板下拉里选的就是这个坐标） */
    G.clipOnTrack = function (seq, kind, trackIndex, clipIndex) {
        if (!seq) { seq = S.active(); }
        if (!seq) { return null; }
        var track = null;
        try {
            track = (kind === "audio") ? seq.audioTracks[trackIndex] : seq.videoTracks[trackIndex];
        } catch (e) { return null; }
        if (!track) { return null; }
        var clips = null;
        try { clips = track.clips; } catch (e1) { return null; }
        var n = 0;
        try { n = clips.numItems; } catch (e2) { return null; }
        if (!(clipIndex >= 0) || clipIndex >= n) { return null; }
        try { return clips[clipIndex]; } catch (e3) { return null; }
    };

    /**
     * 面板「母版」区一次拿全：
     *   · 当前选中的剪辑（有的话）→ 它的参数列表，可直接当母版
     *   · 时间线上已有的剪辑清单 → 不依赖选中状态也能挑母版
     *   · 项目面板里看起来像图形的项（名字含 mogrt / 图形 / 文字 的排前面）
     */
    G.sources = function () {
        var seq = S.active();
        var out = { ok: true, selection: null, items: [], clips: [], seqEmpty: true, seqName: "" };

        if (seq) {
            try { out.seqName = String(seq.name); } catch (eSN) { }

            var all = G.timelineClips(seq, 200);
            var vCount = 0;
            for (var z = 0; z < all.length; z++) {
                if (all[z].kind === "video") { vCount++; }
            }
            out.seqEmpty = (vCount === 0);
            for (var y = 0; y < all.length; y++) {
                if (all[y].kind === "video") { out.clips.push(all[y]); }
            }
        }

        var clip = G.selectedClip(seq);
        if (clip) {
            var o = { name: "", start: 0, end: 0, hasMGT: false, params: [] };
            try { o.name = String(clip.name); } catch (e) { }
            o.start = S.secOf(clip.start, 0);
            o.end = S.secOf(clip.end, 0);
            var pr = G.paramsOf(clip);
            o.hasMGT = pr.ok ? true : false;
            if (pr.ok) {
                o.params = pr.params;
                var pick = G.autoPickText(clip);
                if (pick.ok) { o.picked = pick.name; }
            } else {
                o.error = pr.error;
            }
            out.selection = o;
        }

        var items = G.projectItems(400);
        var key = ["mogrt", "图形", "文字", "标题", "字幕", "text", "title", "caption", "graphic"];   // i18n-allow：匹配用的数据
        var hot = [], cold = [], bad = [];
        for (var i = 0; i < items.length; i++) {
            var nm = String(items[i].name).toLowerCase();
            var isHot = false;
            for (var k = 0; k < key.length; k++) {
                if (nm.indexOf(key[k]) >= 0) { isHot = true; break; }
            }
            /* 序列排到最后 —— 它当不了母版，别占着列表最前面误导人 */
            if (items[i].isSeq === true) { bad.push(items[i]); }
            else if (isHot) { hot.push(items[i]); }
            else { cold.push(items[i]); }
        }
        var merged = hot.concat(cold).concat(bad);
        var cap = merged.length > 200 ? 200 : merged.length;
        for (var m = 0; m < cap; m++) { out.items.push(merged[m]); }
        out.total = merged.length;
        return out;
    };

    /**
     * 扫一遍「PR 自带 / 系统自带」的 .mogrt，给面板一个下拉用。
     *
     * 为什么要这个：用户实测卡在「项目面板里只有序列，没有能当母版的图形素材」——
     * 其实 Adobe 早就在系统里装了一整套字幕模板（Captions and Subtitles 那一批），
     * 只是没人告诉他去哪儿找，也没人告诉他「序列不能当母版」。
     * 与其让他自己去翻 Program Files，不如一键列出来。
     */
    G.mogrtList = function () {
        if (typeof Folder === "undefined") {
            return { ok: false, error: SB.M("这台宿主没有文件系统接口。") };
        }
        var roots = [];
        function pushRoot(p) {
            if (!p) { return; }
            try {
                var f = new Folder(p);
                if (f.exists) { roots.push(f); }
            } catch (e0) { }
        }
        /* ① Adobe 的公共模板目录：用户下载的、PR 装的都在这儿 */
        try { pushRoot(Folder.userData.fsName + "/Common/Motion Graphics Templates"); } catch (e1) { }
        /* ② PR 安装目录下的 Essential Graphics（自带模板） */
        try {
            var ap = "";
            try { ap = String(app.path.fsName); } catch (eA1) { ap = String(app.path); }
            var cut = ap.lastIndexOf("/");
            if (cut < 0) { cut = ap.lastIndexOf("\\"); }
            if (cut > 0) { pushRoot(ap.substring(0, cut) + "/Essential Graphics"); }
        } catch (e2) { }
        /* ③ 我的文档里的 Adobe 模板 */
        try { pushRoot(Folder.myDocuments.fsName + "/Adobe"); } catch (e3) { }

        var out = [], seen = {};
        function walk(folder, depth) {
            if (out.length >= 400 || depth > 3) { return; }
            var list = null;
            try { list = folder.getFiles(); } catch (e4) { return; }
            if (!list) { return; }
            for (var i = 0; i < list.length; i++) {
                var f = list[i];
                if (f instanceof Folder) { walk(f, depth + 1); continue; }
                var nm = "";
                try { nm = String(f.name); } catch (e5) { continue; }
                if (nm.length <= 6) { continue; }
                if (nm.substring(nm.length - 6).toLowerCase() !== ".mogrt") { continue; }

                var full = "";
                try { full = String(f.fsName); } catch (e6) { continue; }
                var rel = nm;
                for (var r = 0; r < roots.length; r++) {
                    var pre = String(roots[r].fsName);
                    if (full.indexOf(pre) === 0) { rel = full.substring(pre.length + 1); break; }
                }
                var dk = rel.toLowerCase();
                if (seen[dk] === true) { continue; }   /* 两个目录里常有同名模板，去个重 */
                seen[dk] = true;

                /* 字幕 / 标题类的排前面 —— 做歌词字幕时九成用这些 */
                var score = 2;
                var keys = ["subtitle", "caption", "title", "lower third", "字幕", "标题"];   // i18n-allow：匹配用的数据
                for (var k = 0; k < keys.length; k++) {
                    if (dk.indexOf(keys[k]) >= 0) { score = 0; break; }
                }
                out.push({ name: nm.substring(0, nm.length - 6), path: full, rel: rel, score: score });
            }
        }
        for (var r2 = 0; r2 < roots.length; r2++) { walk(roots[r2], 0); }

        out.sort(function (a, b) {
            if (a.score !== b.score) { return a.score - b.score; }
            return (a.rel < b.rel) ? -1 : ((a.rel > b.rel) ? 1 : 0);
        });
        return { ok: true, items: out, roots: roots.length };
    };

    /* ---------------------------------------------------------------- 插入 / 定位 */

    /**
     * 给轨道拍快照。**数量（n）和键（keys）都要记**。
     *
     * 为什么不能只看键：剪辑的 name / start 在个别情况下读不出来（都是 undefined），
     * 那时所有键会撞成同一个字符串，新插进去的剪辑会被误判成「早就有了」。
     * 「轨道上的剪辑数有没有变多」才是可靠的判据。
     */
    function snapshot(seq, vTrack) {
        var out = { ok: false, n: 0, keys: [], idx: [] };
        var track = null;
        try { track = seq.videoTracks[vTrack]; } catch (e) { return out; }
        if (!track) { return out; }
        var clips = null;
        try { clips = track.clips; } catch (e1) { return out; }
        var n = 0;
        try { n = clips.numItems; } catch (e2) { return out; }
        out.ok = true;
        out.n = n;
        for (var i = 0; i < n; i++) {
            var c = null;
            try { c = clips[i]; } catch (e3) { continue; }
            if (!c) { continue; }
            out.keys.push(clipKey(c));
            out.idx.push(i);
        }
        return out;
    }

    /** 一个剪辑的「身份」。优先 nodeId，没有就用 名字@入点 凑一个够用的。 */
    function clipKey(c) {
        var key = "";
        try { key = String(c.nodeId); } catch (e0) { key = ""; }
        if (key === "" || key === "undefined" || key === "null") {
            var nm = "";
            try { nm = String(c.name); } catch (e1) { }
            key = nm + "@" + S.secOf(c.start, -1);
        }
        return key;
    }

    /**
     * 拿「插入后」的快照和「插入前」的比。返回 { clip, grew, note }。
     *
     * 判据是**剪辑数变多了**，不是「有没有一个没见过的时间戳」——
     * 只要数量涨了就说明插进去了，然后再去把新增的那个挑出来给调用方用。
     * 挑不出来也没关系（键可能撞），退回「轨道上最后一个」，反正数量已经确认了。
     */
    function pickNew(seq, vTrack, before) {
        if (!before || !before.ok) { return { clip: null, grew: false, note: SB.M("插入前没拍到轨道快照") }; }
        var after = snapshot(seq, vTrack);
        if (!after.ok) { return { clip: null, grew: false, note: SB.M("插入后拍不到轨道快照") }; }
        if (after.n <= before.n) { return { clip: null, grew: false, note: "" }; }

        var clips = null;
        try { clips = seq.videoTracks[vTrack].clips; } catch (e0) { clips = null; }
        if (!clips) { return { clip: null, grew: true, note: "" }; }

        var seen = {}, i;
        for (i = 0; i < before.keys.length; i++) { seen[before.keys[i]] = true; }
        for (i = 0; i < after.keys.length; i++) {
            if (seen[after.keys[i]]) { continue; }
            var c = null;
            try { c = clips[after.idx[i]]; } catch (e1) { c = null; }
            if (c) { return { clip: c, grew: true, note: "" }; }
        }
        /* 数量涨了但键全撞了（name / start 读不出来时会这样）→ 取轨道最后一个 */
        var last = null;
        try { last = clips[after.n - 1]; } catch (e2) { last = null; }
        return { clip: last, grew: true, note: SB.M("（剪辑的键有重复，取的是轨道最后一个）") };
    }

    /**
     * 插入的「参数形状」矩阵。
     *
     * 为什么要列这么多条：官方文档给的类型和实测**不一定一致**。
     * 文档说 Sequence.overwriteClip 的 time 是「秒的字符串」，
     * Track.overwriteClip / Track.insertClip 是「ticks 的字符串」，
     * 但实际有些版本只认 Time 对象；传错类型的后果是
     * **不抛异常、不返回 false、就是静默什么都不做** —— 光看返回值永远查不出来。
     *
     * 所以只能一个个试，每试一次都回轨道上验一次「剪辑数有没有变多」。
     * 第一次成功的形状会被记下来，后面 41 条就不用再逐个试了。
     */
    /* 这 8 个是**标识符**，callStyle 里用 === 比对，翻成英文就一条都对不上，
       8 种插入方式会全部变成「未知的插入方式」。整块豁免。 */
    /* i18n-allow */
    var STYLES = [
        "seq.overwriteClip(秒)",
        "seq.overwriteClip(Time)",
        "track.overwriteClip(ticks)",
        "track.overwriteClip(Time)",
        "track.insertClip(ticks)",
        "track.insertClip(Time)",
        "seq.insertClip(Time)",
        "seq.insertClip(ticks)"
    ];
    /* i18n-allow-end */

    /** 按某一种「参数形状」调一次插入接口。返回 "" 表示这次调用本身没报错。 */
    function callStyle(seq, item, vTrack, aTrack, sec, ticks, style) {
        var vt = null;
        try { vt = seq.videoTracks[vTrack]; } catch (e0) { vt = null; }

        if (style === "seq.overwriteClip(秒)") {   // i18n-allow：跟 STYLES 里的标识符比对
            if (!seq.overwriteClip) { return SB.M("这台 PR 没有 Sequence.overwriteClip"); }
            seq.overwriteClip(item, String(sec), vTrack, aTrack);
            return "";
        }
        if (style === "seq.overwriteClip(Time)") {
            if (!seq.overwriteClip) { return SB.M("这台 PR 没有 Sequence.overwriteClip"); }
            seq.overwriteClip(item, S.timeAt(sec), vTrack, aTrack);
            return "";
        }
        if (style === "track.overwriteClip(ticks)") {
            if (!vt || !vt.overwriteClip) { return SB.M("这台 PR 没有 Track.overwriteClip"); }
            vt.overwriteClip(item, ticks);
            return "";
        }
        if (style === "track.overwriteClip(Time)") {
            if (!vt || !vt.overwriteClip) { return SB.M("这台 PR 没有 Track.overwriteClip"); }
            vt.overwriteClip(item, S.timeAt(sec));
            return "";
        }
        if (style === "track.insertClip(ticks)") {
            if (!vt || !vt.insertClip) { return SB.M("这台 PR 没有 Track.insertClip"); }
            vt.insertClip(item, ticks, vTrack, aTrack);
            return "";
        }
        if (style === "track.insertClip(Time)") {
            if (!vt || !vt.insertClip) { return SB.M("这台 PR 没有 Track.insertClip"); }
            vt.insertClip(item, S.timeAt(sec), vTrack, aTrack);
            return "";
        }
        if (style === "seq.insertClip(Time)") {
            if (!seq.insertClip) { return SB.M("这台 PR 没有 Sequence.insertClip"); }
            seq.insertClip(item, S.timeAt(sec), vTrack, aTrack);
            return "";
        }
        if (style === "seq.insertClip(ticks)") {
            if (!seq.insertClip) { return SB.M("这台 PR 没有 Sequence.insertClip"); }
            seq.insertClip(item, ticks, vTrack, aTrack);
            return "";
        }
        return SB.M("未知的插入方式");
    }

    /**
     * 插入一个母版剪辑。返回 { clip, how, tries, note }。
     *
     * 流程：
     *   ① 母版是 .mogrt 且还没导进来 → 先 importMGT（唯一会返回 TrackItem 的接口）；
     *   ② 否则按 STYLES 逐个试，**每试一次就回轨道上数一次剪辑数**，
     *      数量变多才算成功，并把是哪一种形状干成的记在 how 里。
     *
     * only 参数：批量生成时第一条试出有效形状后，后面的条目直接用它，
     * 不用再逐个试（否则每条要试 8 次，41 条就是 328 次调用）。
     *
     * aTrack 传 -1 表示「不放音频」。序列没有音频轨时**必须**传 -1：
     * 传 0 是越界，overwriteClip 会静默失败。
     */
    function insertOne(seq, ctx, vTrack, aTrack, sec, only) {
        var tries = [];

        /* ① MOGRT 的首条：importMGT 是唯一会返回 TrackItem 的接口，直接用 */
        if (ctx.kind === "mogrt" && !ctx.projectItem) {
            var beforeMgt = snapshot(seq, vTrack);
            var ti = null;
            try {
                ti = seq.importMGT(ctx.path, S.secToTicks(sec), vTrack, aTrack);
            } catch (e0) {
                tries.push("seq.importMGT: " + e0);
            }
            if (ti) {
                try { ctx.projectItem = ti.projectItem; } catch (e1) { }
                return { clip: ti, how: "seq.importMGT", tries: tries, note: "" };
            }
            var pk = pickNew(seq, vTrack, beforeMgt);
            if (pk.clip) {
                try { ctx.projectItem = pk.clip.projectItem; } catch (e2) { }
                return { clip: pk.clip, how: "seq.importMGT（没返回 TrackItem）", tries: tries, note: pk.note };   // i18n-allow：how 是标识符
            }
            tries.push("seq.importMGT: " + (pk.note !== "" ? pk.note : SB.M("调用了，没返回 TrackItem，轨道上也没多出剪辑")));
        }

        if (!ctx.projectItem) {
            tries.push(SB.M("母版没有可复用的素材项（projectItem）"));
            return { clip: null, how: "", tries: tries, note: "" };
        }

        /* ①b 母版是从**项目面板**选的 .mogrt（不是用文件选择器挑的）：
         *     overwriteClip 不一定吃这种素材，但 importMGT 是专门干这个的，
         *     而且它是唯一会返回 TrackItem 的接口 —— 值得优先试一次。 */
        if (ctx.kind !== "mogrt") {
            var mp = "";
            try { mp = String(ctx.projectItem.getMediaPath()); } catch (eMP) { mp = ""; }
            if (mp.length > 6 && mp.substring(mp.length - 6).toLowerCase() === ".mogrt") {
                var beforeP = snapshot(seq, vTrack);
                var tiP = null;
                try {
                    tiP = seq.importMGT(mp, S.secToTicks(sec), vTrack, aTrack);
                } catch (eP) {
                    tries.push(SB.M("seq.importMGT(项目面板的 .mogrt): ") + eP);
                }
                if (tiP) {
                    return { clip: tiP, how: "seq.importMGT（项目面板的 .mogrt）", tries: tries, note: "" };   // i18n-allow：how 是标识符
                }
                var pkP = pickNew(seq, vTrack, beforeP);
                if (pkP.clip) {
                    return {
                        clip: pkP.clip, how: "seq.importMGT（项目面板的 .mogrt）",   // i18n-allow：how 是标识符
                        tries: tries, note: pkP.note
                    };
                }
                tries.push(SB.M("seq.importMGT(项目面板的 .mogrt) → ") +
                    (pkP.note !== "" ? pkP.note : SB.M("调用了，轨道上的剪辑数没变")));
            }
        }

        var list = only ? [only] : STYLES;
        var baseN = snapshot(seq, vTrack).n;

        /* 把整张矩阵在某个时间点上跑一遍。返回剪辑或 null。 */
        function sweep(atSec) {
            var t2 = S.secToTicks(atSec);
            for (var s = 0; s < list.length; s++) {
                var style = list[s];
                var before = snapshot(seq, vTrack);
                if (!before.ok) {
                    tries.push(style + " → " + SB.M("插入前拍不到轨道快照"));
                    continue;
                }
                var err = "";
                try {
                    err = callStyle(seq, ctx.projectItem, vTrack, aTrack, atSec, t2, style);
                } catch (eX) {
                    err = String(eX);
                }
                if (err !== "") {
                    tries.push(style + " → " + err);
                    continue;
                }
                var got = pickNew(seq, vTrack, before);
                if (got.clip) {
                    return { clip: got.clip, how: style, note: got.note };
                }
                tries.push(style + " → " + (got.note !== "" ? got.note : SB.M("调用了，但轨道上的剪辑数没变")));
            }
            return null;
        }

        var hit = sweep(sec);
        if (hit) {
            return { clip: hit.clip, how: hit.how, tries: tries, note: hit.note };
        }

        /* 第二遍：目标时间**超出序列范围**时，有些版本的 overwriteClip 会静默不做
         * （字幕常常从 30 秒、60 秒才开始，而序列可能只有几秒长）。
         * 退一步：先插到 0 秒，再靠调用方的 fitClip 把剪辑挪到目标位置 ——
         * 挪位置走的是 clip.start，不受这个限制，效果完全一样。
         * 只在轨道原本为空时这么做，免得把 0 秒处已有的内容压掉。 */
        if (sec > 0.001 && baseN === 0) {
            var zero = sweep(0);
            if (zero) {
                return {
                    clip: zero.clip, how: zero.how, tries: tries,
                    note: SB.M("目标时间超出序列范围，改成先插到 0 秒再挪过去")
                };
            }
            tries.push(SB.M("换成「先插到 0 秒再挪」也一样不成功"));
        }

        return { clip: null, how: "", tries: tries, note: "" };
    }

    /* ---------------------------------------------------------------- 诊断档案 */

    /**
     * 把「每种参数形状各自的返回」压成一行。
     *
     * 8 种形状全失败时会得到一大串，直接铺开结果框就变成一堵墙。
     * 所以按**理由**归组：「6 种 → 调用了但剪辑数没变；2 种 → 没有这个方法」，
     * 既短又不丢信息。只有一条理由时直接合并成一句。
     */
    function summarizeTries(tries) {
        if (!tries || tries.length === 0) { return SB.M("原因不明"); }
        var order = [], count = {}, i;
        for (i = 0; i < tries.length; i++) {
            var p = tries[i].indexOf(" → ");
            var r = (p >= 0) ? tries[i].substring(p + 3) : tries[i];
            if (count[r] === undefined) { count[r] = 0; order.push(r); }
            count[r]++;
        }
        if (order.length === 1) {
            return SB.M("试过的 %1 种插入方式，结果完全一样：%2", tries.length, order[0]);
        }
        var parts = [];
        for (i = 0; i < order.length; i++) {
            parts.push(SB.M("%1 种 → %2", count[order[i]], order[i]));
        }
        return SB.M("共试了 %1 种插入方式：", tries.length) + parts.join("；");
    }

    /** 把参数清单压成一行。名字 + 类型 + 是不是文字 —— 一眼能看出该填哪个。 */
    function paramSummary(list) {
        if (!list || list.length === 0) { return SB.M("（没读到参数）"); }
        var out = [];
        for (var i = 0; i < list.length; i++) {
            out.push(list[i].displayName + "[" + list[i].kind + (list[i].isText ? SB.M("·文字") : "") + "]");
        }
        return (out.length > 0) ? out.join("、") : SB.M("（一个都没有）");
    }

    /** 母版档案。插入全失败时，这几行是唯一能定位问题的东西。 */
    function itemDossier(item) {
        var o = { ok: false, name: "", type: "", nodeId: "", mediaPath: "", isSeq: null };
        if (!item) { return o; }
        o.ok = true;
        try { o.name = String(item.name); } catch (e0) { }
        try { o.type = String(item.type); } catch (e1) { }
        try { o.nodeId = String(item.nodeId); } catch (e2) { }
        /* 真实路径最能说明「这到底是个什么素材」——
         * .mogrt / 视频文件 / PR 内部的图形文件，一眼就能分出来。 */
        try { o.mediaPath = String(item.getMediaPath()); } catch (e4) { }
        try { if (item.isSequence) { o.isSeq = item.isSequence() ? true : false; } } catch (e3) { }
        return o;
    }

    /** 目标轨道的档案。**锁定轨道写不进去，而且同样不报错。** */
    function trackDossier(seq, vTrack) {
        var o = { ok: false, name: "", locked: null, count: -1 };
        var t = null;
        try { t = seq.videoTracks[vTrack]; } catch (e0) { return o; }
        if (!t) { return o; }
        o.ok = true;
        try { o.name = String(t.name); } catch (e1) { }
        try { o.count = t.clips.numItems; } catch (e2) { }
        try { if (t.isLocked) { o.locked = t.isLocked() ? true : false; } } catch (e3) { }
        return o;
    }

    /** 把剪辑掐到指定起止。返回实际落到的位置，供核对。 */
    function fitClip(clip, startSec, endSec) {
        var got = { start: -1, end: -1, startOk: false, endOk: false };
        if (!clip) { return got; }

        /* 先拉长再挪位置：反过来做的话，素材长度不够时挪完就拉不动了 */
        try { clip.end = S.timeAt(endSec); got.endOk = true; } catch (e0) { }
        try { clip.start = S.timeAt(startSec); got.startOk = true; } catch (e1) { }
        try { clip.end = S.timeAt(endSec); } catch (e2) { }

        got.start = S.secOf(clip.start, -1);
        got.end = S.secOf(clip.end, -1);
        return got;
    }

    /* ---------------------------------------------------------------- 批量生成 */

    /**
     * 主入口。
     *
     * frames  : L.buildFrames 的产物
     * opts    : {
     *   source      { kind:"mogrt"|"project"|"track"|"selection",
     *                 path, itemName, clipKind, trackIndex, clipIndex }
     *   vTrack      目标视频轨下标（默认自动挑第一条空轨）
     *   aTrack      音频轨下标（默认 0；序列没有音频轨时自动变 -1，否则会静默失败）
     *   offset      整体时间偏移（秒）
     *   textParam   文字参数名（留空 = 自动识别）
     *   newline     换行符 "\r"（默认）或 "\n"
     *   merge       双语合并成一条（默认 true）
     *   minDur/maxDur 最短 / 最长显示时长（秒），0 = 不干预
     *   sizeParam / sizeValue   可选：字号参数名与值
     *   colorParam / colorRgb   可选：颜色参数名与 [r,g,b]
     *   limit       最多生成几条（0 = 全部）—— 试跑用
     * }
     *
     * 返回 { ok, count, track, usedParam, params[], warnings[], errors[], samples[] }
     */
    G.build = function (frames, opts) {
        if (!opts) { opts = {}; }
        var warnings = [], errors = [];

        var seq = S.active();
        if (!seq) { return { ok: false, error: SB.M("没有打开的序列。请先打开一条时间线。") }; }

        /* --- 母版 ---
         *
         * 四种来源。前两种（mogrt / project）**不需要时间线上有任何东西**，
         * 所以在空白序列上照样能直接批量造图形剪辑 —— 这是用户明确问过的一条。
         * 后两种（track / selection）本质是「拿时间线上已有的某个剪辑当母版」，
         * 空白序列上无从谈起，只能明确报错并指路。 */
        var src = opts.source || {};
        var ctx = { kind: String(src.kind || "selection"), path: "", projectItem: null };

        if (ctx.kind === "mogrt") {
            if (!src.path) { return { ok: false, error: SB.M("没有指定 MOGRT 文件路径。") }; }
            if (!U.fileExists(src.path)) { return { ok: false, error: SB.M("找不到这个文件：%1", src.path) }; }
            ctx.path = src.path;
        } else if (ctx.kind === "project") {
            if (!src.itemName) { return { ok: false, error: SB.M("没有指定项目面板里的母版素材。") }; }
            ctx.projectItem = G.findProjectItem(src.itemName);
            if (!ctx.projectItem) { return { ok: false, error: SB.M("项目面板里找不到「%1」。", src.itemName) }; }

            /* ⚠ 序列不能当母版。用户实测就撞上这个：他在项目面板里挑了自己另一条序列
             * （名字叫「1080P」），结果 16 种参数形状全试完一条都插不进去。
             * 原因是 PR 不会把序列放进另一条序列的轨道上，而且**静默拒绝**。
             * 与其试完 16 种再说，不如一眼拦住、直接把出路说清楚。 */
            var isSeqMaster = false;
            try {
                if (ctx.projectItem.isSequence) { isSeqMaster = ctx.projectItem.isSequence() ? true : false; }
            } catch (eSQ) { }
            if (isSeqMaster) {
                return {
                    ok: false,
                    needMaster: true,
                    error: SB.M("「%1」是一个序列，不能当图形剪辑的母版 —— Premiere Pro 不会把序列放进另一条序列的轨道上，而且是静默拒绝（试多少种参数都没用）。请改用「MOGRT 文件」挑一个 .mogrt，或者先用文字工具在时间线上做一个文字剪辑、再用「时间线上已有的剪辑」当母版。", src.itemName)
                };
            }
        } else {
            /* track：面板下拉里明确挑了「V3 上的第 2 个剪辑」
             * selection：交给 G.selectedClip（内含扫轨道兜底） */
            var master = null;
            if (ctx.kind === "track") {
                var ti2 = U.toNumber(src.trackIndex, -1);
                var ci2 = U.toNumber(src.clipIndex, -1);
                if (ti2 < 0 || ci2 < 0) {
                    /* 面板下拉是空的（时间线上本来就没有剪辑），
                     * 或者用户没挑。别报「V0 上的第 0 个」这种看不懂的话。 */
                    var emptySeq = (G.timelineClips(seq, 5).length === 0);
                    return {
                        ok: false,
                        needMaster: true,
                        seqEmpty: emptySeq,
                        error: emptySeq
                            ? SB.M("这条序列上还没有任何剪辑，挑不出母版。请把「母版来源」换成「MOGRT 文件」或「项目面板里的素材」—— 这两种不需要时间线上有东西，空白序列也能用。")
                            : SB.M("还没在「时间线上的剪辑」下拉里挑母版。点「刷新剪辑列表」再选一个。")
                    };
                }
                master = G.clipOnTrack(seq, src.clipKind || "video", ti2, ci2);
                if (!master) {
                    return {
                        ok: false,
                        needMaster: true,
                        error: SB.M("时间线上找不到这个剪辑（V%1 上的第 %2 个），可能已经删掉或挪走了。点「刷新剪辑列表」重新挑一个。",
                            (ti2 + 1), (ci2 + 1))
                    };
                }
            } else {
                master = G.selectedClip(seq);
                if (!master) {
                    /* 选中状态拿不到时别急着报错：时间线上如果有现成的图形剪辑，
                     * 就顺手用第一个，并明确告诉用户「用的是哪个」。 */
                    var all = G.timelineClips(seq, 200);
                    var fallback = null;
                    for (var fa = 0; fa < all.length; fa++) {
                        if (all[fa].kind === "video" && all[fa].hasMGT && all[fa].hasItem) { fallback = all[fa]; break; }
                    }
                    if (fallback) {
                        master = G.clipOnTrack(seq, "video", fallback.vTrack, fallback.index);
                        if (master) {
                            warnings.push(SB.M("没读到时间线的选中状态，自动改用 V%1 上的「%2」当母版。",
                                (fallback.vTrack + 1), fallback.name));
                        }
                    }
                    if (!master) {
                        return {
                            ok: false,
                            needMaster: true,
                            seqEmpty: (S.tracks(seq, "video").length > 0 && G.timelineClips(seq, 5).length === 0),
                            error: SB.M("没有选中的剪辑，时间线上也没有可当母版的图形剪辑。请改选「MOGRT 文件」或「项目面板素材」作母版 —— 这两种不依赖时间线，空白序列也能用。")
                        };
                    }
                }
            }
            var masterName = "";
            try { masterName = String(master.name); } catch (eN) { }
            try { ctx.projectItem = master.projectItem; } catch (e0) { }

            /* ⚠ PR 里用 Ctrl+T / 文字工具做出来的文字剪辑，ExtendScript 经常
             * **拿不到 projectItem** —— 它是「内部图形」，不像素材那样在项目面板
             * 里有一条。这时候别直接报死，两条路依次试：
             *   ① clip.createSubClip() —— 拿它现造一个可复用的素材项
             *   ② 去项目面板里按名字找一个对得上的（有些版本确实会建一条）
             * 都不行才明确说「这个剪辑复制不了」，并指去 MOGRT。 */
            if (!ctx.projectItem) {
                var made = null;
                try { if (master.createSubClip) { made = master.createSubClip(); } } catch (e1) { }
                if (made) { ctx.projectItem = made; }
            }
            if (!ctx.projectItem && masterName) {
                var byName = null;
                try { byName = G.findProjectItem(masterName); } catch (e2) { }
                if (byName) {
                    ctx.projectItem = byName;
                    warnings.push(SB.M("时间线上那个剪辑没有 projectItem，改用项目面板里同名的「%1」。", masterName));
                }
            }
            if (!ctx.projectItem) {
                return {
                    ok: false,
                    needMaster: true,
                    error: SB.M("这个剪辑（%1）在 PR 里没有可复用的素材项 —— 用 Ctrl+T / 文字工具做出来的文字剪辑是「内部图形」，ExtendScript 拿不到它的 projectItem，也就没法复制。请改成「MOGRT 文件」（点「扫描自带模板」挑一个现成的），或者从项目面板里挑一个真正的 .mogrt / 图形素材。",
                        masterName || SB.M("（无名）"))
                };
            }
        }

        /* --- 目标轨道 --- */
        var vTrack = U.toNumber(opts.vTrack, -1);
        if (vTrack < 0) { vTrack = S.firstEmptyVideoTrack(seq); }
        var tracks = S.tracks(seq, "video");
        if (tracks.length === 0) { return { ok: false, error: SB.M("这条序列没有视频轨道。") }; }
        if (vTrack >= tracks.length) { vTrack = tracks.length - 1; }

        /* 音频轨下标。
         * ⚠ 序列没有音频轨时必须传 -1：传 0 是越界，overwriteClip 会**静默失败**
         *   （不抛异常也不返回 false），症状就是「每条都插入失败」。
         *   空白序列很容易是「只有视频轨、没有音频轨」，用户实测就撞上了这个。 */
        var aTrack = U.toNumber(opts.aTrack, 0);
        var aTracks = S.tracks(seq, "audio");
        if (aTracks.length === 0) {
            aTrack = -1;
        } else if (aTrack < 0) {
            aTrack = 0;
        } else if (aTrack >= aTracks.length) {
            aTrack = aTracks.length - 1;
        }

        var occupied = 0;
        for (var t = 0; t < tracks.length; t++) {
            if (tracks[t].index === vTrack) { occupied = tracks[t].clips; }
        }
        if (occupied > 0) {
            warnings.push(SB.M("目标视频轨 V%1 上已经有 %2 个剪辑，覆盖式插入会把它们压掉。建议换一条空轨道。",
                (vTrack + 1), occupied));
        }

        /* --- 条目 --- */
        var items = C.mergeFrames(frames, (opts.merge === false) ? false : true);
        var limit = U.toNumber(opts.limit, 0);
        if (limit > 0 && items.length > limit) { items.length = limit; }

        var offset = U.toNumber(opts.offset, 0);
        var minDur = U.toNumber(opts.minDur, 0);
        var maxDur = U.toNumber(opts.maxDur, 0);

        if (items.length === 0) { return { ok: false, error: SB.M("没有可生成的字幕（解析结果为空）。") }; }

        var done = 0, textParamName = String(opts.textParam || "");
        var samples = [], lastParams = null;
        var insertHow = "", lastTries = [];
        /* 第一条试出「哪种参数形状能插进去」之后就固定下来，
         * 后面几十条直接用 —— 不然每条要试 8 次，白跑几百次调用。 */
        var insertStyle = "";
        /* 文字写入成功用的是哪种写法（手术式 / 重建 / 纯文本）。
         * 报出来很有用：如果屏幕上还是模板占位符，看一眼就知道卡在哪一步。 */
        var textMode = "";
        var textViaAuto = false;

        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var startSec = it.start + offset;
            if (startSec < 0) { startSec = 0; }
            var endSec = it.end + offset;
            var dur = endSec - startSec;
            if (minDur > 0 && dur < minDur) { dur = minDur; }
            if (maxDur > 0 && dur > maxDur) { dur = maxDur; }
            if (dur <= 0.02) { dur = 0.5; }
            endSec = startSec + dur;

            var ins = insertOne(seq, ctx, vTrack, aTrack, startSec, insertStyle);
            var clip = ins.clip;
            if (!clip) {
                /* 把每种插入方式各自失败的原因都带上 —— PR 的插入失败是静默的，
                 * 不写清楚就只能靠猜，用户还得再跑一轮。 */
                lastTries = ins.tries;
                if (errors.length < 3) {
                    errors.push(SB.M("第 %1 条插入失败（时间 %2）：%3",
                        (i + 1), U.formatTimecode(startSec, true),
                        summarizeTries(ins.tries)));
                }
                continue;
            }
            if (i === 0) { insertHow = ins.how; }
            /* 记下有效的形状给后面的条目用；importMGT 那条不算
             * （它只在第一条、且母版是 .mogrt 时走） */
            if (insertStyle === "" && ins.how.indexOf("importMGT") < 0) { insertStyle = ins.how; }
            if (ins.note !== "") { warnings.push(SB.M("第 %1 条：%2", (i + 1), ins.note)); }

            var fit = fitClip(clip, startSec, endSec);
            if (Math.abs(fit.end - endSec) > 0.05) {
                /* 素材本身不够长时会这样：记一次就够，别刷屏 */
                if (errors.length < 3) {
                    warnings.push(SB.M("第 %1 条的出点没掐到位（想要 %2，实际 %3）——多半是母版素材长度不够。",
                        (i + 1), U.formatTimecode(endSec, true), U.formatTimecode(fit.end, true)));
                }
            }

            /* 第一条上认参数：用户没指定就自动挑一个，挑到就固定下来给后面用 */
            if (i === 0 || !textParamName) {
                var pr = G.paramsOf(clip);
                if (pr.ok) { lastParams = pr.params; }
                if (!textParamName) {
                    var pick = G.autoPickText(clip);
                    if (pick.ok) {
                        textParamName = pick.name;
                    } else if (i === 0) {
                        errors.push(pick.error || SB.M("认不出文字参数。"));
                    }
                }
            }

            if (textParamName) {
                var wr = G.setText(clip, textParamName, it.text, opts.newline);
                if (wr.ok) {
                    if (!textMode) { textMode = String(wr.mode || ""); }
                    /* 参数名对不上、自动改用了带文字的那个参数 —— 报出去，
                     * 别让用户以为他填的名字生效了。 */
                    if (wr.via === "auto" && !textViaAuto) {
                        textViaAuto = true;
                        warnings.push(SB.M("「%1」这个参数名在模板里对不上，已自动改用模板里带文字的那个参数。", textParamName));
                    }
                } else {
                    if (errors.length < 5) {
                        errors.push(SB.M("第 %1 条改文字失败：%2", (i + 1), wr.error || ""));
                    }
                    /* 失败一次就把「这个模板到底有什么参数、文字参数现在是什么值」
                     * 全吐出来 —— 写入失败是静默的，没这几行就只能来回猜。 */
                    if (i === 0) {
                        warnings.push(SB.M("这个模板的参数清单：%1", paramSummary(lastParams)));
                        if (wr.raw) { warnings.push(SB.M("文字参数现在的值：%1", wr.raw)); }
                    }
                }
            }

            /* 可选的样式注入 —— 设不上不算失败，只提示 */
            if (opts.sizeParam && opts.sizeValue !== undefined && opts.sizeValue !== null && opts.sizeValue !== "") {
                var sr = G.setNumber(clip, opts.sizeParam, opts.sizeValue);
                if (i === 0 && !sr.ok && !sr.skipped) { warnings.push(SB.M("字号没设上：%1", sr.error || "")); }
            }
            if (opts.colorParam && opts.colorRgb && opts.colorRgb.length >= 3) {
                var cr = G.setColor(clip, opts.colorParam, opts.colorRgb[0], opts.colorRgb[1], opts.colorRgb[2]);
                if (i === 0 && !cr.ok && !cr.skipped) { warnings.push(SB.M("颜色没设上：%1", cr.error || "")); }
            }

            done++;
            if (samples.length < 5) {
                samples.push({
                    index: i + 1,
                    start: startSec,
                    end: endSec,
                    want: it.text.replace(/\n/g, " / "),
                    got: textParamName ? G.getText(clip, textParamName).replace(/\r/g, " / ").replace(/\n/g, " / ") : ""
                });
            }
        }

        if (done > 0) { S.seek(seq, items[0].start + offset); }

        /* 全失败时别只报「0 条」—— 把定位信息一起给出去：
         * 用的是哪条 API、音频轨下标是多少、序列上有几条轨道。
         * PR 的插入失败是静默的，这些数字是唯一能定位问题的东西。 */
        if (done === 0) {
            var diag = SB.M("插入方式：%1", insertHow || SB.M("（各种参数形状都试过了，都没成功）"));
            diag += SB.M("｜音频轨下标：%1（序列共 %2 条音频轨）", aTrack, aTracks.length);
            diag += SB.M("｜目标视频轨：V%1（序列共 %2 条视频轨）", (vTrack + 1), tracks.length);
            warnings.push(diag);
            if (lastTries.length > 0) {
                warnings.push(SB.M("各接口的返回：%1", summarizeTries(lastTries)));
            }
        }

        /* 母版 / 轨道的档案 —— 不管成功失败都给，
         * 「哪个形状干成的」和「轨道是不是锁着」都在这儿。 */
        var dossier = {
            kind: ctx.kind,
            item: itemDossier(ctx.projectItem),
            trackInfo: trackDossier(seq, vTrack),
            path: ctx.path,
            style: insertStyle
        };
        if (done === 0) {
            if (dossier.trackInfo.locked === true) {
                warnings.push(SB.M("⚠ 目标轨道「%1」是**锁定**状态 —— 锁定的轨道写不进去，而且 PR 不会报错。请先解锁。",
                    dossier.trackInfo.name));
            }
            if (dossier.item.ok) {
                warnings.push(SB.M("母版素材：%1｜类型 %2｜真实路径 %3",
                    dossier.item.name || SB.M("（无名）"),
                    dossier.item.type || SB.M("（读不出）"),
                    dossier.item.mediaPath || SB.M("（读不出）")));
                if (dossier.item.isSeq === true) {
                    warnings.push(SB.M("⚠ 母版是一个**序列**，不能直接当图形剪辑的母版用。请改用文字 / 图形剪辑或 .mogrt。"));
                }
            }
        }

        return {
            ok: true,
            count: done,
            total: items.length,
            track: vTrack,
            aTrack: aTrack,
            videoTracks: tracks.length,
            audioTracks: aTracks.length,
            insertHow: insertHow,
            textMode: textMode,
            usedParam: textParamName,
            params: lastParams || [],
            samples: samples,
            dossier: dossier,
            warnings: warnings,
            errors: errors
        };
    };

    /* ---------------------------------------------------------------- 试跑 */

    /**
     * 只放第一条，用来确认「母版 + 文字参数」这套配置对不对，再跑全量。
     * 相当于 build 的 limit=1 版本，单独留个入口是为了面板上好写提示文案。
     */
    G.tryOne = function (frames, opts) {
        if (!opts) { opts = {}; }
        opts.limit = 1;
        return G.build(frames, opts);
    };
})();
