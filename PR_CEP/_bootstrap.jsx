/* ============================================================================
 * LyricSubtitlePR —— Premiere Pro 版 CEP 宿主入口（bootstrap）
 * ---------------------------------------------------------------------------
 * 这个文件是**模板**：build_PRCEP.py 读它、原样写成 host/index.jsx（并补 BOM）。
 * 请改这里，不要去改 PR_CEP/dist 或 %APPDATA% 下的产物。
 *
 * 与 AE 版（AE_CEP/_bootstrap.jsx）的差别只有两处：
 *   ① MODS 列表 —— PR 不加载 AE 专属的 04_layers / 05_style / 08_preset
 *      （那是「合成 / 图层 / .ffx 预设」，PR 里没有对应概念），
 *      换成 10_pr_seq / 11_pr_caption / 12_pr_graphics。
 *   ② 兜底路径推导里的扩展目录名（LyricSubtitlePR）。
 * 其余的铁律和坑**一模一样**，别改回去。
 *
 * ★★ 六条铁律（每一条都真的踩过）★★
 *
 *   1) 本文件**不写任何 #target / #targetengine 指令**，且第 1 行必须是注释。
 *      · 必须带 UTF-8 BOM（否则中文乱码），BOM 落在第 1 行；第 1 行若是指令，
 *        BOM 会和它黏成「\uFEFF#target」，指令不被识别 → 报「在行 1 语法错误」。
 *      · #targetengine 更不能用：它会把宿主切到命名引擎，而面板的 cs.evalScript(...)
 *        仍在默认引擎，两边 SB 不是同一个对象 → SB.Bridge 在面板侧 undefined →
 *        所有按钮报「返回内容不是合法 JSON」。CEP 的 <ScriptPath> 与 evalScript
 *        本来就在同一引擎，什么都不写才是对的。
 *
 *   2) 路径**一律用字符串拼接**，绝不用 new File(文件夹对象, "名字") 这种两参构造。
 *      实测这种写法拿到的不是拼接后的路径（第二个参数被丢掉），于是 .exists 恒为假，
 *      全部模块 NOT_FOUND，连 $.evalFile 的真实报错都拿不到，只剩一句空串。
 *
 *   3) **不拿 .exists 当加载闸门**，真正的加载靠 try/catch。
 *
 *   4) 目录**不能只靠 $.fileName**（<ScriptPath> 加载时未必指向本文件，实测是
 *      「~/AppData/...」这种带波浪号的形态）。候选依次是：
 *        ① $.global.__LST_HOST_DIR（面板用 getSystemPath 算出来的绝对路径，最可靠）
 *        ② $.fileName 所在目录（原样 + 波浪号展开两种都试）
 *        ③ %APPDATA%/Adobe/CEP/extensions/<目录名>/host
 *      再挑一个「真含 09_bridge.jsx」的；都探不到就用第一个，**仍然继续尝试加载**。
 *
 *   5) 兜底里**不许写 $.eval**。实测 ExtendScript 没有 $.eval（报「函数 $.eval
 *      未定义」）—— 必须用 $.global.eval / 全局 eval。
 *
 *   6) 已就绪（SB.Bridge.invoke 在）就直接 return —— 面板每次动作都会重跑本文件，
 *      重复加载会让引擎里堆满重复编译的脚本，后面的模块更容易加载失败。
 *      已加载过的模块名记在 $.global.__LST_MODS 里，重复调用时跳过。
 *
 * 排查用：加载结果写在 $.global.LST_LOAD_REPORT（纯字符串），面板的
 * 「关于 / 自检」和状态栏都会显示它 —— 宿主加载失败时这句话就是唯一线索。
 * ==========================================================================*/

(function () {
    var MODS = [
        "00_header.jsx", "01_json.jsx", "02_util.jsx", "02b_i18n.jsx",
        "02c_i18n_en_a.jsx", "02c_i18n_en_b.jsx",
        "02d_i18n_zht_a.jsx", "02d_i18n_zht_b.jsx",
        "02e_i18n_ja_a.jsx", "02e_i18n_ja_b.jsx",
        "03_lrc.jsx", "03b_sub.jsx", "06_online.jsx",
        "10_pr_seq.jsx", "11_pr_caption.jsx", "12_pr_graphics.jsx",
        "09_bridge.jsx"
    ];
    var BS = String.fromCharCode(92);       /* 反斜杠：写成字符码，省得层层转义 */
    var BOM = String.fromCharCode(65279);   /* U+FEFF */

    /* ---- 已经就绪就别重来（面板每次动作都会重跑本文件） ---- */
    try {
        if (typeof SB !== "undefined" && SB && SB.Bridge && SB.Bridge.invoke) { return; }
    } catch (eSkip) { }

    function S(x) { try { return String(x); } catch (e0) { return ""; } }
    function toSlash(p) { return S(p).split(BS).join("/"); }
    function join(d, n) {
        d = S(d);
        var last = d.length ? d.charAt(d.length - 1) : "";
        return d + ((last === "/" || last === BS || last === "") ? "" : "/") + n;
    }
    function isFile(path) {
        try { var t = new File(path); return (t && t.exists) ? true : false; }
        catch (e1) { return false; }
    }
    function dirOf(path) {
        path = S(path);
        var i = path.lastIndexOf("/");
        if (i < 0) { i = path.lastIndexOf(BS); }
        return (i > 0) ? path.substring(0, i) : "";
    }
    function homeDir() {
        try { return toSlash(Folder.userData.parent.parent.fsName); } catch (e2) { return ""; }
    }
    function lineOf(x) { try { var v = x.line; return (v === undefined || v === null || v === "") ? "" : (" @行" + S(v)); } catch (e3) { return ""; } }
    function numOf(x) { try { var v = x.number; return (v === undefined || v === null || v === "") ? "" : (" #" + S(v)); } catch (e4) { return ""; } }
    function errMsg(x) {
        try {
            if (!x) { return "?"; }
            var m = x.description ? S(x.description) : (x.message ? S(x.message) : S(x));
            return m + lineOf(x) + numOf(x);
        } catch (e5) { return "?"; }
    }

    /* 读源码：显式指定 UTF-8（别赌引擎自己的编码判断），并吃掉 BOM */
    function readSrc(fp) {
        var ff = new File(fp);
        if (!ff.exists) { throw new Error("文件不存在"); }
        ff.encoding = "UTF-8";
        if (!ff.open("r")) { throw new Error("打开失败"); }
        var src = ff.read();
        ff.close();
        if (src.length && src.charAt(0) === BOM) { src = src.substring(1); }
        return src;
    }

    /* 执行源码：从 $.global.eval 到全局 eval 逐级兜底。
     * 绝不写 $.eval —— 那个在 ExtendScript 里不存在（见文件头 5）。 */
    function evalSrc(src) {
        try { if ($.global && typeof $.global.eval === "function") { return $.global.eval(src); } } catch (eG) { }
        try { if (typeof eval === "function") { return eval(src); } } catch (eE) { }
        throw new Error("eval 不可用");
    }

    var cand = [], i, p, report = "", dir = "", how = "";
    function add(x) { x = S(x); if (x) { cand[cand.length] = x; } }

    /* ① 面板传进来的绝对路径（getSystemPath 算出来的，最可靠） */
    try { add($.global.__LST_HOST_DIR); } catch (e6) { }

    /* ② 本文件所在目录：$.fileName 可能是「~/AppData/...」形态，原样和展开都试 */
    try {
        var d0 = dirOf(S($.fileName));
        add(d0);
        if (d0.charAt(0) === "~") {
            var hd = homeDir();
            if (hd) { add(hd + d0.substring(1)); }
        }
    } catch (e7) { }

    /* ③ CEP 约定推导 */
    try {
        var ad = toSlash(Folder.userData.fsName);
        add(ad + "/Adobe/CEP/extensions/LyricSubtitlePR/host");
        add(ad + "/Adobe/CEP/extensions/LyricSubtitlePR");
        add(ad + "/Adobe/CEP/extensions/com.sarakale.lyricsubtitle.pr/host");
    } catch (e8) { }

    /* 挑一个真含 09_bridge.jsx 的；都探不到就用第一个，后面照样试着加载 */
    for (i = 0; i < cand.length; i++) {
        if (isFile(join(cand[i], "09_bridge.jsx"))) { dir = cand[i]; break; }
    }
    if (!dir && cand.length) { dir = cand[0]; }

    report = "dir=" + dir +
        " | fn=" + S($.fileName) +
        " | cand=" + cand.length +
        " | idx=" + (isFile(join(dir, "index.jsx")) ? "y" : "n") +
        " | br=" + (isFile(join(dir, "09_bridge.jsx")) ? "y" : "n");

    /* 先把 SB 挂到引擎全局：模块里的 typeof SB 判断会复用它，而不是各建一个 */
    try { if (typeof $.global.SB === "undefined" || !$.global.SB) { $.global.SB = {}; } } catch (e9) { }

    /* 已加载模块记账（跨多次调用复用，避免重复编译） */
    var done = null;
    try { done = $.global.__LST_MODS; } catch (e10) { }
    if (!done) { done = {}; try { $.global.__LST_MODS = done; } catch (e10) { } }

    /* 加载一个模块，三级兜底：
     *   ① $.evalFile(new File(完整路径字符串))  —— 标准写法
     *   ② 读文本（显式 UTF-8）+ eval            —— 绕开 $.evalFile 自身的读取/编译
     *   ③ $.evalFile(完整路径字符串)            —— 有的版本只认路径字符串
     * 三级都失败才抛，异常里把三级报错都带上（含行号/错误号）。 */
    function loadOne(fp) {
        var a1 = null, a2 = null, a3 = null, src = null;
        try { $.evalFile(new File(fp)); return "evalFile"; } catch (x1) { a1 = x1; }
        try { src = readSrc(fp); evalSrc(src); return "eval"; } catch (x2) { a2 = x2; }
        try { $.evalFile(fp); return "evalFile(path)"; } catch (x3) { a3 = x3; }
        throw new Error("①" + errMsg(a1) + " / ②" + errMsg(a2) + " / ③" + errMsg(a3));
    }

    for (i = 0; i < MODS.length; i++) {
        if (done[MODS[i]]) { report += " || " + MODS[i] + ":SKIP"; continue; }
        p = join(dir, MODS[i]);
        try {
            how = loadOne(p);
            done[MODS[i]] = how;
            report += " || " + MODS[i] + ":OK(" + how + ")";
        } catch (e11) {
            report += " || " + MODS[i] + ":FAIL(" + errMsg(e11) + ")";
        }
    }

    /* ---- 第二轮重试：把第一轮失败的模块再加载一次 ----
     * 实测失败集合不一定是「尾部连续」，更像引擎在某一刻的解析状态/时机问题。
     * 重试成本极低，而且重试结果本身就是诊断信号：
     *   重试成功 ⇒ 与顺序/时机有关；重试仍失败 ⇒ 与内容有关。
     * 顺序上先把 09_bridge.jsx 抢回来 —— 没有桥接层，面板什么都做不了。 */
    var retry = [], k2;
    for (i = 0; i < MODS.length; i++) {
        if (!done[MODS[i]] && MODS[i] === "09_bridge.jsx") { retry[retry.length] = MODS[i]; }
    }
    for (i = 0; i < MODS.length; i++) {
        if (!done[MODS[i]] && MODS[i] !== "09_bridge.jsx") { retry[retry.length] = MODS[i]; }
    }
    if (retry.length > 0) {
        for (k2 = 0; k2 < retry.length; k2++) {
            try {
                how = loadOne(join(dir, retry[k2]));
                done[retry[k2]] = how;
                report += " || 重试:" + retry[k2] + ":OK(" + how + ")";
            } catch (e11b) {
                report += " || 重试:" + retry[k2] + ":FAIL(" + errMsg(e11b) + ")";
            }
        }
    }

    try { if (typeof SB !== "undefined" && SB) { $.global.SB = SB; } } catch (e12) { }

    function checkBridge() {
        try { return (typeof SB !== "undefined" && SB && SB.Bridge && SB.Bridge.invoke) ? true : false; }
        catch (e13) { return false; }
    }
    var hasBridge = checkBridge();

    /* ---- 终极兜底：桥接仍没挂上，就把所有模块源码拼成一份直接 eval ----
     * 完全绕开 $.evalFile（以及它的预处理/逐文件加载）。只跑一次，避免反复重来。
     * eval 是先整体编译再执行：编译不过就什么都没跑，不会留下半个状态。 */
    if (!hasBridge) {
        var tried = false;
        try { tried = ($.global.__LST_CONCAT_TRIED === 1); } catch (e14) { }
        if (!tried) {
            try { $.global.__LST_CONCAT_TRIED = 1; } catch (e14) { }
            try {
                var all = "", okRead = 0, k;
                for (k = 0; k < MODS.length; k++) {
                    try { all += readSrc(join(dir, MODS[k])) + "\n"; okRead++; } catch (e15) { }
                }
                if (okRead === MODS.length) {
                    try { evalSrc(all); report += " || 合并加载:OK"; }
                    catch (e16) { report += " || 合并加载:FAIL(" + errMsg(e16) + ")"; }
                } else {
                    report += " || 合并加载:跳过(读到 " + okRead + "/" + MODS.length + ")";
                }
            } catch (e17) { report += " || 合并加载:异常(" + errMsg(e17) + ")"; }
            try { if (typeof SB !== "undefined" && SB) { $.global.SB = SB; } } catch (e18) { }
            hasBridge = checkBridge();
        } else {
            report += " || 合并加载:已试过";
        }
    }

    report += " || SB=" + S(typeof SB) + " Bridge=" + (hasBridge ? "yes" : "no");
    try { $.global.LST_LOAD_REPORT = report; } catch (e19) { }
    try { if (hasBridge) { $.global.__LST_HOST_LOADED = 1; } } catch (e19) { }

    if (!hasBridge) { $.writeln("[LyricSubtitlePR] " + report); }
})();
