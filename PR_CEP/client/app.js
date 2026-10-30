/* ============================================================================
 *  app.js —— PR 版 CEP 面板的前端
 *  ---------------------------------------------------------------------------
 *  这里只负责「界面」：读控件 → 打包成 JSON → 交给宿主（ExtendScript）→ 显示结果。
 *  所有 Premiere Pro 对象操作都在 host/index.jsx（09_bridge.jsx 及其依赖）那边。
 *
 *  三条约定（跟 AE 版一样）：
 *   1) 调宿主走 call(action, args)，返回 Promise。args 会先 JSON.stringify，
 *      再把反斜杠和引号各转义一层 —— 因为 evalScript 传的是**字符串**，
 *      而 Windows 路径里到处都是反斜杠，歌词里到处都是换行。
 *   2) 长任务是同步阻塞的（宿主跑的时候面板动不了），进度写在宿主的 log 队列里，
 *      这边每 300ms 取一次显示到状态栏。
 *   3) 需要用户确认的地方用 HTML 弹窗，不用 ExtendScript 的 confirm() ——
 *      那个弹出来会卡在 PR 主窗口后面，用户根本看不见。
 * ==========================================================================*/

(function () {
    var cs = new CSInterface();

    /* ------------------------------------------------------------ 功能开关
     *
     * GFX_ENABLED：图形剪辑通道（在视频轨道上批量造文字剪辑）。
     *
     * 2026-10-07 实测结论：这条路走不通，先关掉，面板只留「字幕轨道」一条。
     * 原因记在这儿，免得以后又从头查一遍：
     *   · PR 自己导出的 .mogrt 是 prgraphic，文字参数叫 TextLayer，
     *     脚本写不进去 —— setValue 不报错、剪辑也确实插进去了、条数也对，
     *     但屏幕上永远是模板里的占位文字，静默失败。
     *   · 只有 AE 导出的 aegraphic 模板（文字参数叫 Text）才能被脚本改。
     *   · 系统的 169 个自带模板里 46 个是 aegraphic，但那是别人的样式。
     *   · 「字幕升级为图形」Adobe 明确说没有 API。
     *
     * 要恢复：这里改成 true，再把 index.html 里被注释掉的那段
     * <section class="sec" data-key="gfx"> 放出来。
     * 宿主侧 12_pr_graphics.jsx / API.gfxBuild 一直都在，没删。
     */
    var GFX_ENABLED = false;

    /* ------------------------------------------------------------ 多语言
     *
     * 设计：**中文原文就是 key**。中文模式下 T() 是恒等函数，等于没接这层。
     * 译文表复用 AE 版那三张（i18n_en/zht/ja.js）—— 通用的界面词（打开/清空/编码/
     * 确定…）直接命中；PR 专有的新词表里没有，会原样显示中文，不影响使用。
     * 要补译文就往 _tools/i18n/*.json 里加，然后跑 build_i18n.py。
     */
    var TABLES = {
        "zh": null,
        "zh-Hant": window.I18N_ZH_HANT || {},
        "en": window.I18N_EN || {},
        "ja": window.I18N_JA || {}
    };
    var LANGS = ["zh", "zh-Hant", "en", "ja"];
    var LANG_NAME = { "zh": "简体中文", "zh-Hant": "繁体中文", "en": "English", "ja": "日语" }; /* i18n-allow */
    var LS_LANG = "st.lang";
    var lang = "zh";

    function normalizeLang(l) {
        var i;
        for (i = 0; i < LANGS.length; i++) { if (l === LANGS[i]) { return l; } }
        return "zh";
    }

    function detectSystemLang() {
        var nav = "";
        try { nav = String(navigator.language || navigator.userLanguage || "").toLowerCase(); } catch (e1) { }
        if (nav === "") { return "zh"; }
        if (nav.indexOf("ja") === 0) { return "ja"; }
        if (nav.indexOf("zh") === 0) {
            return (nav.indexOf("zh-tw") === 0 || nav.indexOf("zh-hk") === 0 ||
                    nav.indexOf("zh-mo") === 0 || nav.indexOf("zh-hant") === 0) ? "zh-Hant" : "zh";
        }
        return "en";
    }

    function initialLang() {
        var saved = null;
        try { saved = localStorage.getItem(LS_LANG); } catch (e0) { }
        if (saved === null || saved === "" || saved === "auto") { return detectSystemLang(); }
        return normalizeLang(saved);
    }

    /** 取当前语言下的这条文案；%1 %2 依次替换。查不到原样返回。 */
    function T(zh) {
        var s = zh;
        var t = TABLES[lang];
        if (t) {
            var hit = t[zh];
            if (hit !== undefined && hit !== null) { s = hit; }
        }
        if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
                s = s.split("%" + i).join(String(arguments[i]));
            }
        }
        return s;
    }

    function applyI18n() {
        var i;
        var els = document.querySelectorAll("[data-i18n]");
        for (i = 0; i < els.length; i++) {
            els[i].textContent = T(els[i].getAttribute("data-i18n"));
        }
        var phs = document.querySelectorAll("[data-i18n-placeholder]");
        for (i = 0; i < phs.length; i++) {
            try { phs[i].setAttribute("placeholder", T(phs[i].getAttribute("data-i18n-placeholder"))); }
            catch (e2) { }
        }
    }

    /* ------------------------------------------------------------ 控件助手 */

    function $(id) { return document.getElementById(id); }
    function v(id) { var el = $(id); return el ? el.value : ""; }
    function n(id, def) {
        var el = $(id);
        if (!el) { return def; }
        var x = parseFloat(el.value);
        return isNaN(x) ? def : x;
    }
    function chk(id) { var el = $(id); return el ? !!el.checked : false; }
    function sel(id) { var el = $(id); return el ? el.selectedIndex : 0; }
    function optionValue(id) {
        var el = $(id);
        if (!el) { return ""; }
        if (el.options && el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
            return el.options[el.selectedIndex].value;
        }
        return el.value || "";
    }
    function escJson(s) {
        return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }
    function escHtml(s) {
        return String(s === null || s === undefined ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function pad(x, w) {
        var t = String(x);
        while (t.length < w) { t = "0" + t; }
        return t;
    }
    /** 秒 → 00:00:01.234 */
    function fmtTime(s) {
        var vv = parseFloat(s);
        if (isNaN(vv) || vv < 0) { vv = 0; }
        var ms = Math.round(vv * 1000);
        var h = Math.floor(ms / 3600000); ms -= h * 3600000;
        var m = Math.floor(ms / 60000); ms -= m * 60000;
        var sec = Math.floor(ms / 1000); ms -= sec * 1000;
        return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(sec, 2) + "." + pad(ms, 3);
    }
    function hexToRgb(hex) {
        var s = String(hex || "").replace("#", "");
        if (s.length === 3) {
            s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
        }
        if (s.length !== 6) { return [255, 255, 255]; }
        return [parseInt(s.substring(0, 2), 16), parseInt(s.substring(2, 4), 16), parseInt(s.substring(4, 6), 16)];
    }

    var state = {
        source: "",
        translated: "",
        songs: [],
        files: [],
        build: "?",
        version: "1.0.1",
        versionDate: "2026-10-30",
        pr: "",
        engine: "",
        sequence: "",
        params: [],
        mogrtScanned: false
    };

    function versionLine() {
        if (state.version) { return "v" + state.version + "(" + state.versionDate + ")"; }
        return (state.build && state.build !== "?") ? state.build : "";
    }

    /* ------------------------------------------------------------ 与宿主通信 */

    var extRoot = "";
    try { extRoot = (cs.getSystemPath(SystemPath.EXTENSION) || "").replace(/\\/g, "/"); }
    catch (eSys) { extRoot = ""; }

    /* 模块清单（跟构建脚本 _tools/build_PRCEP.py 里的 ORDER 一致）。
     * 只在兜底路径里用，正常情况下由 host/index.jsx 自己按目录找。 */
    var HOST_MODULES = [
        "00_header.jsx", "01_json.jsx", "02_util.jsx", "02b_i18n.jsx",
        "02c_i18n_en_a.jsx", "02c_i18n_en_b.jsx",
        "02d_i18n_zht_a.jsx", "02d_i18n_zht_b.jsx",
        "02e_i18n_ja_a.jsx", "02e_i18n_ja_b.jsx",
        "03_lrc.jsx", "03b_sub.jsx", "06_online.jsx",
        "10_pr_seq.jsx", "11_pr_caption.jsx", "12_pr_graphics.jsx",
        "09_bridge.jsx"
    ];

    function bootPrefix(all) {
        if (!extRoot) { return ""; }
        var dir = extRoot + "/host";
        var s = '$.global.__LST_HOST_DIR = "' + dir + '";\n';
        s += 'try { if (typeof SB === "undefined" || !SB.Bridge) {\n';
        if (all) {
            s += '  var _m = ["' + HOST_MODULES.join('", "') + '"];\n';
            s += '  for (var _i = 0; _i < _m.length; _i++) {' +
                ' try { $.evalFile("' + dir + '/" + _m[_i]); } catch (em) { } }\n';
        } else {
            s += '  $.evalFile("' + dir + '/index.jsx");\n';
        }
        s += '} } catch (eL) { $.global.LST_LOAD_REPORT = "evalFile threw: " + String(eL) +' +
            ' " @" + String((eL && eL.line) || ""); }\n';
        return s;
    }

    function explain(raw) {
        var s = String(raw === null || raw === undefined ? "" : raw);
        if (s === "LST_NO_BRIDGE") {
            return T("宿主没就绪：SB.Bridge 不存在（宿主模块没加载成功）");
        }
        if (s === "") {
            return T("宿主返回了空字符串（多半是 SB.Bridge 不存在，evalScript 静默失败）");
        }
        if (s.indexOf("EvalScript error") >= 0) {
            return T("宿主脚本执行时抛异常了（%1）。常见原因：SB.Bridge 没挂上、或者宿主脚本里某个模块报错。", s);
        }
        return s.slice(0, 300);
    }

    var NO_BRIDGE = "LST_NO_BRIDGE";

    function hostDiag(cb) {
        var expr = 'String($.global.LST_LOAD_REPORT || "(no report)") +' +
            ' " ## SB=" + (typeof SB) + " Bridge=" +' +
            ' ((typeof SB !== "undefined" && SB && SB.Bridge) ? "yes" : "no")';
        try {
            cs.evalScript(expr, function (r) {
                cb(String(r === null || r === undefined ? "" : r).replace(/[\r\n]+/g, " "));
            });
        } catch (eD) { cb("hostDiag failed: " + eD); }
    }

    function showHostLoadError() {
        if (!extRoot) {
            setStatus(T("宿主加载探测返回：%1", T("extRoot 取不到（getSystemPath 失败）")), "err");
            return;
        }
        var snip =
            '(function(){' +
            'var r="";try{r=String($.global.LST_LOAD_REPORT||"(no report)");}catch(e0){}' +
            'var f="";try{$.evalFile("' + extRoot + '/host/index.jsx");f="LOADED";}' +
            'catch(e){f="FAIL@@@"+String(e.fileName||"")+"@@@"+String(e.line||"")+"@@@"+' +
            'String(e.number||"")+"@@@"+String(e.description||"")+"@@@"+String(e.message||"");}' +
            'return "R@@@"+r+"@@@"+f+"@@@SB="+String(typeof SB)+"@@@"+' +
            '((typeof SB!=="undefined"&&SB&&SB.Bridge)?"Bridge=yes":"Bridge=no");' +
            '})()';
        cs.evalScript(snip, function (raw) {
            var s = String(raw === null || raw === undefined ? "" : raw).replace(/[\r\n]+/g, " ");
            var txt = T("宿主加载探测返回：%1", s.slice(0, 900));
            if (s.indexOf("R@@@") === 0) {
                var a = s.slice(4).split("@@@");
                var fpart;
                if (a[1] === "LOADED") {
                    fpart = T("（重新 evalFile 入口：成功）");
                } else if (String(a[1] || "").indexOf("FAIL") === 0) {
                    var b = String(a[1]).split("@@@");
                    fpart = T("（重新 evalFile 入口：失败）文件 %1 第 %2 行（错误号 %3）%4 %5",
                        b[1] || "?", b[2] || "?", b[3] || "?", b[4] || "", b[5] || "");
                } else {
                    fpart = String(a[1] || "");
                }
                txt = T("【宿主加载诊断】\n%1\n%2\n%3 %4", a[0] || "", fpart, a[2] || "", a[3] || "");
            }
            setStatus(txt, "err");
            var box = $("aboutLog");
            if (box) { box.value = txt + "\n\n" + box.value; }
        });
    }

    function attempt(action, args, allowRetry) {
        var json = JSON.stringify(args || {});
        var script = bootPrefix(!allowRetry) +
            '((typeof SB === "undefined" || !SB.Bridge || !SB.Bridge.invoke) ? "' + NO_BRIDGE + '" : ' +
            'SB.Bridge.invoke("' + action + '", "' + escJson(json) + '"))';
        return new Promise(function (resolve) {
            cs.evalScript(script, function (res) {
                var out = null, bad = false;
                try { out = JSON.parse(res); } catch (e) { bad = true; }
                if (bad && allowRetry && extRoot) {
                    attempt(action, args, false).then(resolve);
                    return;
                }
                if (bad) {
                    hostDiag(function (info) {
                        resolve({ ok: false, error: T("返回内容不是合法 JSON：%1", explain(res)) + T("\n【宿主诊断】") + info });
                    });
                    return;
                }
                resolve(out || { ok: false, error: T("（空返回）") });
            });
        });
    }

    function call(action, args) {
        return attempt(action, args, true);
    }

    /* ---------------------------------------------------------------- 代宿主取网
     *
     * PR 的 ExtendScript **没有 system 对象**（那是 AE 独有的），CEP 11 又严格
     * 执行 CORS，所以「宿主想去网上取点什么」这件事只能由面板代劳：
     *
     *   ① 面板照常调宿主动作；
     *   ② 宿主跑到「要取某个 URL」那一步，把 URL 记下来、抛一个内部信号；
     *   ③ 桥接层接住，回 { ok:false, needFetch:[{url,referer}] }；
     *   ④ 面板用 LSTNet 把 URL 取回来，调 onlineDeliver 喂进宿主缓存；
     *   ⑤ 面板**重放**刚才那个动作 —— 这次缓存命中，一路跑到底。
     *
     * 搜索是两跳的（先搜歌曲列表、再取歌词），所以最多往返两轮；
     * 上限 6 轮纯粹是兜底，正常两三轮就收敛。
     */
    var FETCH_ROUNDS = 6;

    function hostCall(action, args) {
        return new Promise(function (resolve) {
            var round = 0;

            function fail(msg) { resolve({ ok: false, error: msg }); }

            function go() {
                round++;
                if (round > FETCH_ROUNDS) {
                    fail(T("反复取网都没成功（试了 %1 轮）。请检查网络，或改用本地歌词文件。", FETCH_ROUNDS));
                    return;
                }
                call(action, args).then(function (r) {
                    if (!r || !r.needFetch || !r.needFetch.length) { resolve(r); return; }

                    if (!window.LSTNet) {
                        fail(T("面板的取网模块没加载（net.js 缺失），而宿主自己发不了网络请求。"));
                        return;
                    }
                    if (!window.LSTNet.hasNode()) {
                        fail(T("取网需要面板里的 Node，但现在用不了：%1", window.LSTNet.nodeReason()));
                        return;
                    }

                    setStatus(T("正在通过面板取网……（第 %1 轮，共 %2 个地址）",
                        round, r.needFetch.length));

                    window.LSTNet.getAll(r.needFetch).then(function (items) {
                        /* 一个都没取到就别再重放了 —— 否则会空转到轮次上限，
                           用户看到的是「转了 6 圈然后失败」，还不如一次说清。 */
                        var okCount = 0, firstErr = "";
                        for (var i = 0; i < items.length; i++) {
                            if (items[i].text !== undefined) { okCount++; }
                            else if (!firstErr) { firstErr = items[i].error || ""; }
                        }
                        if (okCount === 0) {
                            fail(T("面板取网失败：%1", firstErr || T("未知原因")));
                            return;
                        }
                        call("onlineDeliver", { items: items }).then(function () {
                            go();
                        });
                    });
                });
            }
            go();
        });
    }

    /** 面板侧的网络能力（给「关于 / 自检」页显示用） */
    function netCapability() {
        if (!window.LSTNet) { return { ok: false, note: T("net.js 没加载") }; }
        if (window.LSTNet.hasNode()) {
            return { ok: true, note: T("面板 Node 可用 —— 宿主发不了请求时由面板代取（不受 CORS 限制）") };
        }
        return { ok: false, note: window.LSTNet.nodeReason() || T("Node 不可用") };
    }

    function setStatus(msg, kind) {
        var bar = $("status");
        if (!bar) { return; }
        bar.textContent = msg || "";
        bar.parentNode.className = "statusbar" + (kind ? (" " + kind) : "");
    }

    var logTimer = null;
    function startProgress(first) {
        if (first) { setStatus(first); }
        if (logTimer) { clearInterval(logTimer); }
        logTimer = setInterval(pullLog, 300);
    }
    function stopProgress() {
        if (logTimer) { clearInterval(logTimer); logTimer = null; }
        pullLog();
    }
    function pullLog() {
        call("log", {}).then(function (r) {
            if (r.ok && r.lines && r.lines.length > 0) {
                setStatus(r.lines[r.lines.length - 1]);
            }
        });
    }

    function confirmBox(title, msg, okText) {
        return new Promise(function (resolve) {
            $("dlgTitle").textContent = title;
            $("dlgMsg").textContent = msg;
            $("dlgYes").textContent = okText || T("确定");
            $("mask").classList.add("show");
            function done(val) {
                $("mask").classList.remove("show");
                $("dlgYes").onclick = null;
                $("dlgNo").onclick = null;
                resolve(val);
            }
            $("dlgYes").onclick = function () { done(true); };
            $("dlgNo").onclick = function () { done(false); };
        });
    }

    function alertBox(title, msg) {
        return new Promise(function (resolve) {
            $("dlgTitle").textContent = title;
            $("dlgMsg").textContent = msg;
            $("dlgYes").textContent = T("知道了");
            $("dlgNo").style.display = "none";
            $("mask").classList.add("show");
            $("dlgYes").onclick = function () {
                $("mask").classList.remove("show");
                $("dlgNo").style.display = "";
                resolve(true);
            };
        });
    }

    /* ------------------------------------------------------------ 表单持久化 */

    var LS_FORM = "st.form";
    var LS_SEC = "st.sec.";

    function saveForm() {
        try {
            var o = {};
            var els = document.querySelectorAll("input[id],select[id],textarea[id]");
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.id === "langSel") { continue; }
                /* 只读的结果框不用存，省得把上一次的日志也灌回来 */
                if (el.readOnly) { continue; }
                o[el.id] = (el.type === "checkbox") ? el.checked : el.value;
            }
            o[".translated"] = state.translated;
            o[".source"] = state.source;
            localStorage.setItem(LS_FORM, JSON.stringify(o));
        } catch (e) { }
    }

    function loadForm() {
        try {
            var raw = localStorage.getItem(LS_FORM);
            if (!raw) { return; }
            var o = JSON.parse(raw);
            for (var k in o) {
                if (!o.hasOwnProperty(k)) { continue; }
                if (k.charAt(0) === ".") { continue; }
                var el = $(k);
                if (!el) { continue; }
                if (el.type === "checkbox") { el.checked = !!o[k]; }
                else { el.value = o[k]; }
            }
            if (typeof o[".translated"] === "string") { state.translated = o[".translated"]; }
            if (typeof o[".source"] === "string") { state.source = o[".source"]; }
        } catch (e2) { }
    }

    function doResetSettings() {
        confirmBox(T("恢复默认设置"), T("会清掉面板里记住的所有设置（含语言），确定吗？")).then(function (yes) {
            if (!yes) { return; }
            try {
                var keys = [];
                for (var i = 0; i < localStorage.length; i++) {
                    keys.push(localStorage.key(i));
                }
                for (i = 0; i < keys.length; i++) {
                    if (String(keys[i]).indexOf("st.") === 0) { localStorage.removeItem(keys[i]); }
                }
            } catch (e) { }
            location.reload();
        });
    }

    function doOpenFolder() {
        var p = extRoot || "";
        if (!p) { setStatus(T("拿不到扩展目录"), "err"); return; }
        try { cs.openURLInDefaultBrowser("file:///" + p.replace(/ /g, "%20")); }
        catch (e) { setStatus(String(e), "err"); }
    }

    /* ------------------------------------------------------------ 折叠分组 */

    function initSections(scope) {
        var root = scope ? $(scope) : document;
        var secs = root.querySelectorAll(".sec");
        for (var i = 0; i < secs.length; i++) {
            (function (sec) {
                var key = sec.getAttribute("data-key") || "";
                var head = sec.querySelector(".sec-head");
                if (!head) { return; }
                try {
                    if (key && localStorage.getItem(LS_SEC + key) === "0") {
                        sec.classList.add("collapsed");
                    }
                } catch (e) { }
                head.onclick = function () {
                    sec.classList.toggle("collapsed");
                    try {
                        if (key) { localStorage.setItem(LS_SEC + key, sec.classList.contains("collapsed") ? "0" : "1"); }
                    } catch (e2) { }
                };
            })(secs[i]);
        }
    }

    function expandAll(scope, open) {
        var root = scope ? $(scope) : document;
        var secs = root.querySelectorAll(".sec");
        for (var i = 0; i < secs.length; i++) {
            var key = secs[i].getAttribute("data-key") || "";
            if (open) { secs[i].classList.remove("collapsed"); }
            else { secs[i].classList.add("collapsed"); }
            try { if (key) { localStorage.setItem(LS_SEC + key, open ? "1" : "0"); } } catch (e) { }
        }
    }

    /* ------------------------------------------------------------ 标签页 */

    function initTabs() {
        var btns = document.querySelectorAll(".tabbtn");
        for (var i = 0; i < btns.length; i++) {
            btns[i].onclick = function () {
                var tab = this.getAttribute("data-tab");
                var all = document.querySelectorAll(".tabbtn");
                for (var k = 0; k < all.length; k++) { all[k].classList.remove("active"); }
                this.classList.add("active");
                var panes = document.querySelectorAll(".tabpane");
                for (k = 0; k < panes.length; k++) { panes[k].classList.remove("active"); }
                var pane = $("tab-" + tab);
                if (pane) { pane.classList.add("active"); }
                try { localStorage.setItem("st.tab", tab); } catch (e) { }
            };
        }
        var last = null;
        try { last = localStorage.getItem("st.tab"); } catch (e2) { }
        if (last) {
            for (i = 0; i < btns.length; i++) {
                if (btns[i].getAttribute("data-tab") === last) { btns[i].onclick(); break; }
            }
        }
    }

    /* ------------------------------------------------------------ 请求载荷 */

    /**
     * 组装发给宿主的参数。
     *
     * 注意 offset 只走 frame.offset 这一条路：
     * 宿主里 buildFrames 用 frame.offset 平移 frames，createTrack / exportSrt
     * 还有一个顶层 offset 会在生成时**再**平移一次。两处都给就会偏移两倍，
     * 所以顶层恒为 0，要调偏移就改「整体偏移(s)」那一个输入框。
     */
    function payload(extra) {
        var p = {
            text: v("lyricText"),
            translated: state.translated,
            hasTrans: chk("hasTrans"),
            matchTol: n("matchTol", 0.6),
            assStyle: chk("assStyle"),
            seqName: optionValue("seqList"),
            mergeSrt: chk("mergeSrt"),
            offset: 0,
            frame: {
                defaultDur: n("defaultDur", 2),
                gap: n("gap", 0.02),
                minDur: n("minDur", 0.3),
                maxDur: n("maxDur", 0),
                offset: n("offset", 0),
                leadIn: n("leadIn", 0),
                leadOut: n("leadOut", 0),
                mergeTol: n("mergeTol", 0.02),
                biLayout: v("biLayout"),
                biOrder: v("biOrder")
            }
        };
        if (extra) {
            for (var k in extra) {
                if (extra.hasOwnProperty(k)) { p[k] = extra[k]; }
            }
        }
        return p;
    }

    /* ------------------------------------------------------------ 歌词载入 */

    function afterLoadText(r) {
        if (!r) { return; }
        if (r.canceled || r.cancelled) { setStatus(T("已取消")); return; }
        if (!r.ok) { setStatus(r.error || T("载入失败"), "err"); return; }
        if (r.text !== undefined && r.text !== null) {
            $("lyricText").value = r.text;
        }
        if (r.source) { state.source = r.source; }
        var msg = T("已载入 %1（%2 行%3）", (state.source || ""), (r.lines || 0),
            r.formatLabel ? T("，格式：%1", r.formatLabel) : "");
        setStatus(msg, "ok");
        saveForm();
    }

    /* ------------------------------------------------------- 面板侧的系统文件对话框
     *
     * 为什么 PR 版不让宿主去弹 File.openDialog：
     *   Premiere 的 ExtendScript 弹文件对话框时**没给对话框指定 owner 窗口**，
     *   Windows 就把它当成一个独立的顶层窗口（所以它在任务栏里单独占一个按钮）。
     *   第一次点「打开歌词文件」时焦点还在面板的 Chromium 子窗口上，这个没有
     *   主人的对话框就被排到 PR 主窗口后面去了 —— 用户看不到，得去任务栏把它
     *   点出来。AE 的 ExtendScript 同样一句 File.openDialog 却没这毛病（它的
     *   对话框是挂在 AE 主窗口下的），所以只有 PR 版走下面这条路。
     *
     * 面板侧的 cep.fs.showOpenDialog 是 CEP 自己实现的系统对话框，owner 就是
     * 面板窗口，永远在 PR 前面；而且它直接给出**真实路径**（HTML5 的
     * <input type="file"> 只给文件名，还得自己重新做一遍编码识别）。拿回路径
     * 交给宿主照旧读文件、照旧做编码识别，宿主的读取逻辑一行都不用改。
     *
     * 返回三种值，调用方必须分清：
     *   "C:\\a.srt"  选到了（真实路径）
     *   ""           用户取消了
     *   undefined    cep.fs 在这台机器上不可用 → 退回宿主的 File.openDialog
     *
     * 参数 o：
     *   title    对话框标题（已经翻好的文案）
     *   types    扩展名数组，不带点，如 ["lrc","srt"]
     *   friendly 过滤器显示名，仅 Windows 生效，如 "歌词/字幕 (*.lrc;*.srt)"
     *   dir      true = 选文件夹（此时 types / friendly 都被忽略）
     */
    function pickPath(o) {
        o = o || {};
        try {
            var fsm = window.cep && window.cep.fs;
            if (!fsm || typeof fsm.showOpenDialog !== "function") { return undefined; }
            var r = null;
            if (typeof fsm.showOpenDialogEx === "function") {
                /* Ex 比基础版多两个参数：Windows 的过滤器显示名、Mac 的按钮文字。
                 * 老 CEP 上没有 Ex，就退基础版（过滤器会显示成一串扩展名，能用）。 */
                r = fsm.showOpenDialogEx(false, !!o.dir, o.title || "", o.initial || "",
                    o.types || [], o.friendly || "", "");
            } else {
                r = fsm.showOpenDialog(false, !!o.dir, o.title || "", o.initial || "", o.types || []);
            }
            if (!r) { return ""; }
            /* err 只有 0（正常）和 2（参数不合法）。2 说明这个 CEP 版本的签名跟
             * 文档不一样 —— 别再猜了，让宿主去弹老对话框，至少功能是通的。 */
            if (r.err) { return undefined; }
            var d = r.data || [];
            return d.length ? String(d[0]) : "";
        } catch (eP) {
            return undefined;
        }
    }

    function doOpenLrc() {
        var p = pickPath({
            title: T("选择歌词 / 字幕文件"),
            types: ["lrc", "srt", "ass", "ssa", "vtt", "txt", "json"],
            friendly: T("歌词/字幕 (*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt;*.json)")
        });
        if (p === undefined) { call("openFile", { encoding: v("encodingList") }).then(afterLoadText); return; }
        if (p === "") { setStatus(T("已取消")); return; }
        call("openFile", { encoding: v("encodingList"), path: p }).then(afterLoadText);
    }

    function doScanFolder() {
        var p = pickPath({ dir: true, title: T("选择包含歌词文件的文件夹") });
        if (p === undefined) { scanFolderRun(null); return; }
        if (p === "") { setStatus(T("已取消")); return; }
        scanFolderRun(p);
    }

    /** 真正去扫。dir 为 null 时让宿主自己弹 Folder.selectDialog（cep.fs 不可用的兜底）。 */
    function scanFolderRun(dir) {
        setStatus(T("正在扫描文件夹……"));
        call("scanFolder", dir ? { path: dir } : {}).then(function (r) {
            if (!r || !r.ok) {
                if (r && (r.canceled || r.cancelled)) { setStatus(T("已取消")); return; }
                setStatus((r && r.error) || T("扫描失败"), "err");
                return;
            }
            state.files = r.files || [];
            var list = $("fileList");
            list.innerHTML = "";
            if (state.files.length === 0) {
                var o0 = document.createElement("option");
                o0.value = "";
                o0.textContent = T("（这个文件夹里没找到歌词文件）");
                list.appendChild(o0);
            } else {
                for (var i = 0; i < state.files.length; i++) {
                    var o = document.createElement("option");
                    o.value = String(state.files[i].index);
                    o.textContent = state.files[i].name;
                    list.appendChild(o);
                }
            }
            setStatus(T("扫到 %1 个候选歌词文件", state.files.length), "ok");
        });
    }

    function doLoadFile() {
        var idx = parseInt(optionValue("fileList"), 10);
        if (isNaN(idx)) { setStatus(T("先扫描文件夹"), "err"); return; }
        call("pickFile", { index: idx, encoding: v("encodingList") }).then(afterLoadText);
    }

    function doPaste() {
        call("paste", {}).then(afterLoadText);
    }

    function doClearTrans() {
        state.translated = "";
        $("transInfo").textContent = T("没有译文");
        setStatus(T("译文已清空"));
        saveForm();
    }

    function updateTransInfo() {
        var t = String(state.translated || "");
        $("transInfo").textContent = (t === "") ? T("没有译文") : T("%1 行译文", t.split("\n").length);
    }

    /* ------------------------------------------------------------ 预览 */

    function renderPreview(rows) {
        var box = $("previewList");
        if (!box) { return; }
        var html = "";
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            html += '<div class="pv' + (r.sub ? " sub" : "") + '">' +
                '<span class="tag">' + (r.sub ? T("译") : escHtml(r.index)) + '</span>' +
                escHtml(fmtTime(r.start)) + " → " + escHtml(fmtTime(r.end)) + "  " +
                escHtml(String(r.text).replace(/\n/g, " ⏎ ")) +
                "</div>";
        }
        box.innerHTML = html || '<div class="pv">' + escHtml(T("（空）")) + "</div>";
    }

    function doPreview() {
        setStatus(T("正在解析……"));
        call("preview", payload()).then(function (r) {
            if (!r.ok) {
                setStatus(r.error || T("解析失败"), "err");
                $("previewInfo").textContent = r.error || "";
                return;
            }
            renderPreview(r.rows || []);
            var s = r.stats || {};
            $("previewInfo").textContent = T("共 %1 条（原文 %2 / 译文 %3）｜%4 → %5｜总长 %6",
                s.count || 0, s.main || 0, s.sub || 0,
                fmtTime(s.first || 0), fmtTime(s.last || 0), fmtTime(s.total || 0));
            setStatus(T("解析完成：%1 条", r.count || 0), "ok");
        });
    }

    /* ------------------------------------------------------------ 序列 */

    function refreshSeq() {
        return call("seqInfo", {}).then(function (r) {
            var list = $("seqList");
            if (!r.ok) {
                list.innerHTML = "";
                var o = document.createElement("option");
                o.value = "";
                o.textContent = T("（没有打开的序列）");
                list.appendChild(o);
                $("seqHint").textContent = r.error || "";
                renderTracks([]);
                return r;
            }
            var seqs = r.sequences || [];
            var keep = list.value;
            list.innerHTML = "";
            for (var i = 0; i < seqs.length; i++) {
                var op = document.createElement("option");
                op.value = seqs[i].name;
                op.textContent = seqs[i].name + "  (" + (seqs[i].fps ? seqs[i].fps.toFixed(2) : "?") + " fps)";
                list.appendChild(op);
            }
            /* 优先停在当前激活的序列上；没有就保持用户原来的选择 */
            var want = r.name || keep;
            for (i = 0; i < list.options.length; i++) {
                if (list.options[i].value === want) { list.selectedIndex = i; break; }
            }
            renderTracks(r.video || []);
            $("seqHint").textContent = T("当前序列：%1｜%2 fps｜视频轨 %3 条｜字幕轨 %4 条｜时长 %5",
                r.name, (r.fps ? r.fps.toFixed(2) : "?"),
                (r.video || []).length, (r.captions || []).length, fmtTime(r.duration || 0));
            return r;
        });
    }

    function renderTracks(video) {
        var s = $("gfxVTrack");
        if (!s) { return; }
        var keep = s.value;
        s.innerHTML = "";
        var auto = document.createElement("option");
        auto.value = "-1";
        auto.textContent = T("自动（第一条空轨）");
        s.appendChild(auto);
        for (var i = 0; i < video.length; i++) {
            var o = document.createElement("option");
            o.value = String(video[i].index);
            o.textContent = "V" + (video[i].index + 1) + "  " +
                (video[i].empty ? T("（空）") : T("（%1 个剪辑）", video[i].clips));
            s.appendChild(o);
        }
        for (i = 0; i < s.options.length; i++) {
            if (s.options[i].value === keep) { s.selectedIndex = i; break; }
        }
    }

    /* ------------------------------------------------------------ 字幕轨通道 */

    /**
     * 把「字幕剪辑能不能改文字」的探测结果翻成人话。
     *
     * 用户提的思路是：拿 PR 原生字幕当中转，再把文字灌进图形模板。
     * 灌进去那一步正是 PR 原生模板挡路的地方，所以那个绕法不通；
     * 但「字幕剪辑自己有没有可写的文字参数」是个真问题 —— 字幕剪辑也是
     * TrackItem，也有 getMGTComponent()。宿主会顺手探一次，这里把结论说清楚，
     * 别让用户自己去猜字幕剪辑内部长什么样。
     */
    function captionProbeLines(pr) {
        var out = [];
        if (!pr) { return out; }
        out.push("");
        out.push(T("── 顺手探测：字幕剪辑能不能改文字 ──"));
        if (pr.error) { out.push(T("探测失败：%1", pr.error)); return out; }
        out.push(T("字幕轨 %1 条，字幕条 %2 个。", pr.tracks, pr.clipsSeen));
        if (pr.note) { out.push(pr.note); }
        if (pr.components && pr.components.length > 0) {
            var names = [];
            for (var i = 0; i < pr.components.length; i++) {
                names.push(pr.components[i].displayName || pr.components[i].matchName || "?");
            }
            out.push(T("它挂的组件：%1", names.join(" / ")));
        }
        if (pr.hasMgt && pr.textParam) {
            out.push(T("结论：值得一试。母版来源改成「时间线上已有的剪辑」，选中一条字幕，"));
            out.push(T("      「文字参数」填 %1 再生成 —— 成了的话就完全不需要 .mogrt 了。", pr.textParam));
        } else if (!pr.hasMgt) {
            out.push(T("结论：不行。字幕的文字不走「基本图形」那条管线，脚本读写不到它。"));
            out.push(T("      要批量字幕就留在这一页（字幕轨本身就是成品）；要图形剪辑样式就换 AE 制作的 .mogrt。"));
        }
        return out;
    }

    function doBuildCaption() {
        startProgress(T("正在生成字幕轨……"));
        call("buildCaption", payload()).then(function (r) {
            stopProgress();
            var lines = [];
            if (!r.ok) {
                lines.push(T("失败：%1", r.error || ""));
                setStatus(r.error || T("生成失败"), "err");
            } else {
                lines.push(T("字幕条数：%1", r.count));
                lines.push(T("SRT 文件：%1", r.path));
                lines.push(T("项目面板素材：%1", r.itemName || ""));
                lines.push(T("时间范围：%1 → %2", fmtTime(r.firstStart || 0), fmtTime(r.lastEnd || 0)));
                lines.push(r.created ? T("字幕轨已创建（播放头已跳到第一条）") : T("字幕轨没有创建成功，见下方提示"));
            }
            var w = r.warnings || [];
            for (var i = 0; i < w.length; i++) { lines.push(T("提示：%1", w[i])); }
            var pl = captionProbeLines(r.captionProbe);
            for (i = 0; i < pl.length; i++) { lines.push(pl[i]); }
            $("capResult").value = lines.join("\n");
            if (r.ok) { setStatus(T("已生成 %1 条字幕", r.count), "ok"); }
            refreshSeq();
        });
    }

    function doExportSrt() {
        call("exportSrt", payload()).then(function (r) {
            if (!r.ok) {
                if (r.canceled || r.cancelled) { setStatus(T("已取消")); return; }
                setStatus(r.error || T("导出失败"), "err");
                return;
            }
            $("capResult").value = T("已写出 SRT：%1\n条数：%2\n可以直接把这个文件拖进项目面板，PR 会自动建字幕轨。", r.path, r.count);
            setStatus(r.info || T("已导出"), "ok");
        });
    }

    function doInspectCaptions() {
        call("inspectCaptions", {}).then(function (r) {
            if (!r.ok) { setStatus(r.error || T("读取失败"), "err"); return; }
            var lines = [];
            var tr = r.tracks || [];
            if (tr.length === 0) {
                lines.push(T("这条序列上还没有字幕轨。"));
            }
            for (var i = 0; i < tr.length; i++) {
                lines.push(T("字幕轨 %1：%2 条字幕｜%3 → %4", (i + 1), tr[i].clips,
                    fmtTime(tr[i].first), fmtTime(tr[i].last)));
                var sm = tr[i].samples || [];
                for (var k = 0; k < sm.length; k++) {
                    lines.push("    " + fmtTime(sm[k].start) + "  " + sm[k].text);
                }
            }
            if (r.note) { lines.push(r.note); }
            $("capResult").value = lines.join("\n");
            setStatus(T("字幕轨 %1 条", tr.length), "ok");
        });
    }

    /* ------------------------------------------------------------ 图形剪辑通道 */

    function gfxSource() {
        var kind = v("gfxSrcKind");
        if (kind === "mogrt") {
            return { kind: "mogrt", path: v("gfxMogrtPath") };
        }
        if (kind === "project") {
            return { kind: "project", itemName: optionValue("gfxItemList") };
        }
        if (kind === "track") {
            /* 下拉里每项的值形如 "video|2|0"（轨道类型|轨道下标|剪辑下标）。
             * 这条路完全不依赖时间线的选中状态 —— 选区接口失灵时最稳的备选。 */
            var raw = optionValue("gfxTrackClipList");
            var p = String(raw || "").split("|");
            return {
                kind: "track",
                clipKind: p[0] || "video",
                trackIndex: parseInt(p[1], 10),
                clipIndex: parseInt(p[2], 10)
            };
        }
        return { kind: "selection" };
    }

    function updateGfxRows() {
        /* 图形剪辑关掉时这些控件根本不在 DOM 里，一律先撤。
           在门口拦而不是在每个调用点拦 —— init() 和好几个回调都会调它。 */
        if (!GFX_ENABLED) { return; }
        var kind = v("gfxSrcKind");
        $("rowMogrt").style.display = (kind === "mogrt") ? "" : "none";
        $("rowMogrtList").style.display = (kind === "mogrt" && state.mogrtScanned) ? "" : "none";
        $("rowItem").style.display = (kind === "project") ? "" : "none";
        $("rowTrackClip").style.display = (kind === "track") ? "" : "none";
    }

    function gfxOpts() {
        return {
            source: gfxSource(),
            vTrack: n("gfxVTrack", -1),
            aTrack: 0,
            textParam: v("gfxTextParam"),
            newline: v("gfxNewline"),
            sizeParam: v("gfxSizeParam"),
            sizeValue: v("gfxSizeValue"),
            colorParam: chk("gfxColorOn") ? v("gfxColorParam") : "",
            colorRgb: hexToRgb(v("gfxColor")),
            limit: 0
        };
    }

    /** 把宿主返回的「时间线上已有剪辑」填进下拉 */
    function fillTrackClips(clips, selectedRaw) {
        var list = $("gfxTrackClipList");
        /* 先记住当前值：面板重开时 loadForm 会把上次选的 "video|2|0" 塞回来，
           这里清空重建后要尽量把它选回去，否则用户每次都要重挑一次。 */
        var want = selectedRaw || list.value || "";
        list.innerHTML = "";
        clips = clips || [];
        if (clips.length === 0) {
            var o0 = document.createElement("option");
            o0.value = "";
            o0.textContent = T("（时间线上没有剪辑）");
            list.appendChild(o0);
            return;
        }
        var hit = -1, firstMGT = -1;
        for (var i = 0; i < clips.length; i++) {
            var c = clips[i];
            var raw = c.kind + "|" + c.vTrack + "|" + c.index;
            var o = document.createElement("option");
            o.value = raw;
            o.textContent = "V" + (c.vTrack + 1) + " · " + (c.name || T("（无名）")) +
                "  " + fmtTime(c.start) +
                (c.hasMGT ? T("  ← 有图形参数") : T("  ← 无图形参数")) +
                (c.selected ? T("  ← 当前选中") : "");
            list.appendChild(o);
            if (raw === want) { hit = i; }
            if (firstMGT < 0 && c.hasMGT) { firstMGT = i; }
        }
        /* 优先还原上次选的；没有就挑第一个「有图形参数」的，省得在一堆素材里翻 */
        if (hit >= 0) { list.selectedIndex = hit; }
        else if (firstMGT >= 0) { list.selectedIndex = firstMGT; }
    }

    function doRefreshGfx() {
        setStatus(T("正在读取项目面板……"));
        call("gfxSources", {}).then(function (r) {
            if (!r.ok) { setStatus(r.error || T("读取失败"), "err"); return; }

            var list = $("gfxItemList");
            var items = r.items || [];
            list.innerHTML = "";
            if (items.length === 0) {
                var o0 = document.createElement("option");
                o0.value = "";
                o0.textContent = T("（项目面板里没有素材）");
                list.appendChild(o0);
            } else {
                for (var i = 0; i < items.length; i++) {
                    var o = document.createElement("option");
                    o.value = items[i].name;
                    /* 序列在列表里明确标出来 —— 它当不了母版，
                     * 不标的话用户会挑一个，然后白等 16 种插入方式试完。 */
                    var tag = items[i].isSeq
                        ? T("序列·不能当母版")
                        : (items[i].type ? String(items[i].type) : "");
                    o.textContent = items[i].name + (tag ? ("  [" + tag + "]") : "");
                    list.appendChild(o);
                }
            }

            fillTrackClips(r.clips, null);

            /* --- 母版信息 + 空白序列提示 --- */
            var lines = [];
            lines.push(T("项目面板素材：%1 个（列出 %2 个）", (r.total || 0), items.length));
            lines.push(T("时间线上可当母版的剪辑：%1 个", (r.clips || []).length));

            if (r.selection) {
                var sl = r.selection;
                lines.push(T("当前选中剪辑：%1｜%2 → %3", sl.name || T("（无名）"), fmtTime(sl.start), fmtTime(sl.end)));
                if (sl.hasMGT) {
                    lines.push(T("它带基本图形参数：%1 个", (sl.params || []).length));
                    if (sl.picked) {
                        lines.push(T("自动认出的文字参数：%1", sl.picked));
                        if (!v("gfxTextParam")) { $("gfxTextParam").value = sl.picked; }
                    }
                    state.params = sl.params || [];
                    renderParams(state.params);
                } else {
                    lines.push(sl.error || T("这个剪辑没有基本图形参数"));
                }
            } else {
                lines.push(T("没读到时间线的选中状态 —— 用「时间线上已有的剪辑」这条路照样能挑母版。"));
            }
            $("gfxParamInfo").textContent = lines.join("\n");

            /* 空白序列的正面回答：能不能生成？能，但要换来源。 */
            var hint = $("gfxSeqHint");
            if (hint) {
                if (r.seqEmpty) {
                    hint.textContent = T("这条序列（%1）上还没有任何剪辑。空白序列也能直接生成图形剪辑 —— " +
                        "把「母版来源」换成「项目面板里的素材」或「MOGRT 文件」即可；" +
                        "这两种不需要时间线上有东西。另外生成前建议先在时间线上随便放一段底片，方便看位置。",
                        r.seqName || T("当前序列"));
                } else {
                    hint.textContent = "";
                }
            }

            setStatus(T("母版信息已更新"), "ok");
        });
    }

    function renderParams(params) {
        if (!params || params.length === 0) { return; }
        var lines = [T("这个母版的参数列表（把名字填到「文字参数」里即可）：")];
        for (var i = 0; i < params.length; i++) {
            var p = params[i];
            lines.push("  " + (i + 1) + ". " + (p.displayName || p.name) +
                "  [" + p.kind + "]" + (p.isText ? T(" ← 文字") : "") +
                (p.preview ? ("  " + p.preview) : ""));
        }
        $("gfxParamInfo").textContent = lines.join("\n");
    }

    function doLoadParams() {
        call("gfxParams", { source: gfxSource() }).then(function (r) {
            if (!r.ok) {
                $("gfxParamInfo").textContent = r.error || T("读取失败");
                if (r.needTry) { setStatus(T("先试跑一条，参数列表会一起回来")); }
                else { setStatus(r.error || T("读取失败"), "err"); }
                return;
            }
            state.params = r.params || [];
            if (r.picked && !v("gfxTextParam")) { $("gfxTextParam").value = r.picked; }
            renderParams(state.params);
            setStatus(T("读到 %1 个参数", state.params.length), "ok");
        });
    }

    function gfxReport(r, title) {
        var lines = [];
        if (!r.ok) {
            lines.push(T("失败：%1", r.error || ""));
            if (r.needMaster) {
                lines.push("");
                lines.push(T("怎么解决："));
                lines.push(T("  1) 母版来源改成「项目面板里的素材」，从下拉里挑一个图形 / MOGRT；"));
                lines.push(T("  2) 或者改成「MOGRT 文件」，点右边按钮选一个 .mogrt；"));
                lines.push(T("  3) 或者改成「时间线上已有的剪辑」，点「刷新剪辑列表」后从下拉里挑。"));
                lines.push(T("这三条都不依赖「时间线上当前选中了什么」，比靠选中状态稳得多。"));
            }
            if (r.seqEmpty) {
                lines.push("");
                lines.push(T("注意：当前序列上还没有任何剪辑，所以「选中的剪辑」这条路必然走不通 —— 请用上面第 1 或第 2 种来源。"));
            }
            $("gfxResult").value = lines.join("\n");
            setStatus(r.error || T("生成失败"), "err");
            return;
        }
        lines.push(title);
        lines.push(T("成功生成：%1 / %2 条", r.count, r.total));
        lines.push(T("目标视频轨：V%1", (r.track + 1)));
        if (r.insertHow) {
            lines.push(T("实际生效的插入方式：%1", r.insertHow));
        }
        lines.push(T("使用的文字参数：%1", r.usedParam || T("（没有）")));
        if (r.textMode) {
            lines.push(T("文字写入方式：%1", r.textMode));
        }
        /* 剪辑插进去了、但文字没换成歌词 —— 屏幕上还是模板的占位符。
           这种情况必须醒目地指出来，否则用户以为整件事都失败了。 */
        if (r.count > 0 && !r.usedParam) {
            lines.push("");
            lines.push(T("⚠ 剪辑插进去了，但**没认出文字参数**，所以文字还是模板的占位符。"));
            lines.push(T("   点「读取选中剪辑的参数」，在列表里找到带文字的那个，把它的名字填到「文字参数」框里再生成。"));
        }
        /* 一条都没成功时，把定位信息顶到最前面 —— 这是用户最需要看到的 */
        if (r.count === 0) {
            lines.push("");
            lines.push(T("一条都没插进去。当前环境：目标视频轨 V%1（序列共 %2 条视频轨），音频轨下标 %3（序列共 %4 条音频轨）。",
                (r.track + 1), r.videoTracks, r.aTrack, r.audioTracks));
            var d = r.dossier || {};
            var ti = d.trackInfo || {};
            if (ti.locked === true) {
                lines.push(T("⚠ 目标轨道「%1」是锁定状态 —— 锁定的轨道写不进去，而且 PR 不会报错。请先点轨道头解锁再试。",
                    ti.name || T("（无名）")));
            }
            if (d.item && d.item.ok) {
                lines.push(T("母版素材：%1｜类型 %2｜来源 %3",
                    d.item.name || T("（无名）"), d.item.type || T("（读不出）"), d.kind || ""));
                if (d.item.mediaPath) {
                    lines.push(T("  真实路径：%1", d.item.mediaPath));
                }
                if (d.item.isSeq === true) {
                    lines.push(T("⚠ 母版是一个序列，不能当图形剪辑的母版用。请改用文字 / 图形剪辑，或 .mogrt 文件。"));
                }
            }
            lines.push(T("插件已经把各种「参数形状」都试过一遍了（秒字符串 / ticks 字符串 / Time 对象 × 四个插入接口），下面「提示：各接口的返回」就是结果（如果每种都一样，会合并成一行）。"));
            if (r.audioTracks === 0) {
                lines.push(T("这条序列没有音频轨，音频轨下标已自动设为 -1。"));
            }
            lines.push(T("请把结果框整段复制发给我。"));
        }
        var sm = r.samples || [];
        if (sm.length > 0) {
            lines.push("");
            lines.push(T("抽样核对（想要什么 vs 实际写进去什么）："));
            for (var i = 0; i < sm.length; i++) {
                lines.push("  #" + sm[i].index + "  " + fmtTime(sm[i].start) + " → " + fmtTime(sm[i].end));
                lines.push("      " + T("期望：%1", sm[i].want));
                lines.push("      " + T("实际：%1", sm[i].got));
            }
        }
        /* 剪辑插进去了、参数也认出来了，但读回来的文字跟歌词对不上 ——
           这就是「PR 原生模板」的典型症状（.prgraphic 的文字参数脚本改不了）。
           必须指名道姓说出来，否则用户会一直以为是脚本的 bug。 */
        var badText = 0;
        for (i = 0; i < sm.length; i++) {
            var gw = String(sm[i].got === undefined ? "" : sm[i].got).replace(/[\r\n]/g, "");
            var ww = String(sm[i].want === undefined ? "" : sm[i].want).replace(/[\r\n]/g, "");
            if (gw !== ww) { badText++; }
        }
        if (badText > 0 && r.usedParam) {
            lines.push("");
            lines.push(T("⚠ 有 %1 条的文字没写进去（看上面的抽样核对）。", badText));
            lines.push(T("  最常见的原因是母版是 PR 原生的图形模板（内部是 project.prgraphic）—— 这类模板的文字参数脚本改不了，剪辑能插进去但文字永远是模板占位符。换一个 AE 制作的 MOGRT 就好，例如 Clean Subtitles 16X9 V13。"));
            lines.push(T("  另一个可能是「文字参数」填错了名字：点「读取选中剪辑的参数」，看哪个参数的值里带文字，把它的名字填进「文字参数」框。"));
        }
        var w = r.warnings || [];
        if (w.length > 0) {
            lines.push("");
            for (i = 0; i < w.length; i++) { lines.push(T("提示：%1", w[i])); }
        }
        var er = r.errors || [];
        if (er.length > 0) {
            lines.push("");
            for (i = 0; i < er.length; i++) { lines.push(T("问题：%1", er[i])); }
        }
        if (r.params && r.params.length > 0) {
            state.params = r.params;
        }
        $("gfxResult").value = lines.join("\n");
        setStatus(T("已生成 %1 条图形剪辑", r.count), "ok");
        refreshSeq();
    }

    /** 生成前先看母版来源挑好了没 —— 试跑和批量都要过这一关，
        免得用户对着「V0 上的第 0 个」这种看不懂的报错发呆。 */
    function checkGfxSource() {
        var src = gfxSource();
        if (src.kind === "mogrt" && !src.path) {
            setStatus(T("先选一个 .mogrt 文件"), "err");
            return false;
        }
        if (src.kind === "project" && !src.itemName) {
            setStatus(T("先在「项目面板素材」里挑一个"), "err");
            return false;
        }
        if (src.kind === "track" && !(src.clipIndex >= 0)) {
            var list = $("gfxTrackClipList");
            var empty = list && list.value === "";
            setStatus(empty
                ? T("「时间线上的剪辑」是空的（时间线上没有剪辑）。请把母版来源换成「MOGRT 文件」或「项目面板里的素材」—— 这两种空白序列也能用。")
                : T("先在「时间线上的剪辑」里挑一个"), "err");
            return false;
        }
        return true;
    }

    /**
     * 生成前拦一道：**PR 原生的图形模板，文字参数脚本改不了。**
     *
     * 症状：MOGRT 插进去了、条数也对、结果框还说成功，但屏幕上永远是模板的
     * 占位文字（比如「在线使用的标题和字幕」），时间线上每条剪辑的名字也一样。
     * Adobe 官方论坛上那个经典问题最后就是这么收尾的 ——「我用错了类型的 .mogrt」。
     *
     * 判据在 zip 里：project.aegraphic = AE 制作的（能改文字）；
     * project.prgraphic = PR 原生「基本图形」做的（改不了）。
     * ExtendScript 读不了 zip，所以这件事交给面板侧的 Node 做。
     *
     * 能在动手前拦住的一定要拦 —— 让用户跑完 41 条再告诉他白跑了，
     * 比现在多问一句糟糕得多。
     */
    function mogrtGuard() {
        if (v("gfxSrcKind") !== "mogrt") { return Promise.resolve(true); }
        var p = v("gfxMogrtPath");
        if (!p) { return Promise.resolve(true); }

        var info = null;
        try {
            if (window.LSTNet && window.LSTNet.readMogrt) { info = window.LSTNet.readMogrt(p); }
        } catch (e) { /* 读不出来就放行：读不了模板不该拦住干活 */ }
        if (!info || !info.ok || info.kind !== "prgraphic") { return Promise.resolve(true); }

        return confirmBox(T("这个模板改不了文字"),
            T("「%1」是 PR 原生的图形模板（内部是 project.prgraphic）。" +
                "这类模板的文字参数用脚本改不了 —— 剪辑能插进去、条数也对，但文字会一直是模板里的「%2」，时间线上每条剪辑的名字也跟着不变。\n\n" +
                "这不是脚本的毛病，是 PR 的老问题：换成 AE 制作的模板就好。\n\n" +
                "请点「取消」，再到「MOGRT 文件」那一行点「扫描自带模板」，挑带 [文字参数：Text] 的那个 —— 例如 Clean Subtitles 16X9 V13。\n\n" +
                "仍然要试一次吗？",
                info.name || p, info.placeholder || T("（占位文字）")));
    }

    function doGfxTryOne() {
        if (!checkGfxSource()) { return; }
        mogrtGuard().then(function (go) {
            if (!go) {
                setStatus(T("已取消：请换一个 AE 制作的 MOGRT（列表里带 [文字参数] 的那些）"), "err");
                return;
            }
            startProgress(T("正在试跑一条……"));
            var p = payload(gfxOpts());
            p.limit = 1;
            call("gfxTryOne", p).then(function (r) {
                stopProgress();
                gfxReport(r, T("【试跑一条】"));
                if (r.ok && r.params && r.params.length > 0) { renderParams(r.params); }
            });
        });
    }

    function doGfxBuild() {
        if (!checkGfxSource()) { return; }
        var p = payload(gfxOpts());
        mogrtGuard().then(function (go) {
            if (!go) {
                setStatus(T("已取消：请换一个 AE 制作的 MOGRT（列表里带 [文字参数] 的那些）"), "err");
                return null;
            }
            return call("preview", payload());
        }).then(function (pv) {
            if (pv === null) { return null; }
            var cnt = (pv && pv.ok ? pv.count : 0);
            var msg = T("会在 V%1 上生成 %2 个图形剪辑。\n\n覆盖式插入会把目标轨道上原有的剪辑压掉，确定继续吗？",
                (p.vTrack >= 0 ? (p.vTrack + 1) : T("自动选的第一条空轨")), cnt);
            return confirmBox(T("批量生成图形剪辑"), msg);
        }).then(function (yes) {
            if (yes === null) { return; }
            if (!yes) { setStatus(T("已取消")); return; }
            startProgress(T("正在批量生成……"));
            call("gfxBuild", p).then(function (r) {
                stopProgress();
                gfxReport(r, T("【批量生成】"));
                if (r.ok && r.params && r.params.length > 0) { renderParams(r.params); }
            });
        });
    }

    /** 一个模板值不值得推荐：字幕类优先，AE 做的优先，
     *  PR 原生（.prgraphic）排最后 —— 用户实测「插进去了但文字还是占位符」
     *  就出在 PR 原生那一派上，别让用户再踩一遍。 */
    function mogrtRank(it) {
        var n = (String(it.rel || "") + " " + String(it.name || "")).toLowerCase();
        var sub = (n.indexOf("subtitle") >= 0 || n.indexOf("caption") >= 0 ||
            n.indexOf("字幕") >= 0 || n.indexOf("标题") >= 0);   // i18n-allow：匹配用的数据
        var k = (it.info && it.info.kind) || "";
        var s = sub ? 0 : 20;
        s += (k === "aegraphic") ? 0 : ((k === "prgraphic") ? 2 : 1);
        return s;
    }

    /** 扫系统自带 / PR 自带的 .mogrt 模板。
     *  用户手上常常没有现成的 .mogrt，也不知道 Adobe 早就装了一整套字幕模板 ——
     *  与其让他去翻 Program Files，不如一键列出来。
     *
     *  光列出名字不够：用户挑错模板的下场就是「生成成功了，但文字全是占位符」。
     *  所以扫到之后再用 Node 把每个 .mogrt 的 definition.json 读一遍，把
     *  **真正的文字参数名**和「这是 AE 做的还是 PR 原生的」一起标在列表上，
     *  并且选中时直接把参数名填进「文字参数」框 —— 不用猜，也不用试完才知道。 */
    function doScanMogrt() {
        setStatus(T("正在扫描模板……"));
        call("gfxMogrts", {}).then(function (r) {
            if (!r.ok) { setStatus(r.error || T("扫描失败"), "err"); return; }
            var items = r.items || [];

            /* 逐个补参数信息。读不出来（Node 没开 / 文件被锁）也不算失败，
               只是列表上少个标记而已。 */
            state.mogrtInfo = {};
            for (var i = 0; i < items.length; i++) {
                var info = { ok: false };
                try {
                    if (window.LSTNet && window.LSTNet.readMogrt) {
                        info = window.LSTNet.readMogrt(items[i].path) || info;
                    }
                } catch (e) { /* 忽略：标记是锦上添花 */ }
                items[i].info = info;
                state.mogrtInfo[items[i].path] = info;
            }
            items.sort(function (a, b) { return mogrtRank(a) - mogrtRank(b); });

            var list = $("gfxMogrtList");
            list.innerHTML = "";
            if (items.length === 0) {
                var o0 = document.createElement("option");
                o0.value = "";
                o0.textContent = T("（没找到自带模板，请用左边的按钮手动选）");
                list.appendChild(o0);
                state.mogrtScanned = false;
                updateGfxRows();
                setStatus(T("没找到自带模板"), "err");
                return;
            }
            var o1 = document.createElement("option");
            o1.value = "";
            o1.textContent = T("（挑一个，共 %1 个）", items.length);
            list.appendChild(o1);
            for (var j = 0; j < items.length; j++) {
                var it = items[j];
                var o = document.createElement("option");
                o.value = it.path;
                var txt = it.rel + "   —   " + it.name;
                var inf = it.info || {};
                if (inf.ok && inf.textParam) { txt += T("   [文字参数：") + inf.textParam + "]"; }
                if (inf.kind === "prgraphic") { txt += T("   ⚠ PR 原生模板"); }
                o.textContent = txt;
                list.appendChild(o);
            }
            state.mogrtScanned = true;
            updateGfxRows();
            setStatus(T("扫到 %1 个模板，从下拉里挑一个（带 [文字参数] 的优先）", items.length), "ok");
        });
    }

    function doPickMogrt() {
        var p = pickPath({
            title: T("选择 MOGRT 动态图形模板"),
            types: ["mogrt"],
            friendly: T("MOGRT 模板 (*.mogrt)")
        });
        if (p === undefined) { pickMogrtRun(null); return; }
        if (p === "") { setStatus(T("已取消")); return; }
        pickMogrtRun(p);
    }

    function pickMogrtRun(path) {
        call("pickMogrt", path ? { path: path } : {}).then(function (r) {
            if (!r.ok) {
                if (r.canceled || r.cancelled) { setStatus(T("已取消")); return; }
                setStatus(r.error || T("选择失败"), "err");
                return;
            }
            $("gfxMogrtPath").value = r.path || "";
            $("gfxSrcKind").value = "mogrt";
            updateGfxRows();
            setStatus(T("已选择：%1", r.name || r.path), "ok");
            saveForm();
        });
    }

    function doUseSelection() {
        $("gfxSrcKind").value = "selection";
        updateGfxRows();
        doRefreshGfx();
        saveForm();
    }

    /* ------------------------------------------------------------ 在线歌词 */

    function doSearch() {
        var kw = v("keyword");
        if (!kw) { setStatus(T("先填歌名 / 歌手，再搜索"), "err"); return; }
        startProgress(T("正在搜索……"));
        hostCall("onlineSearch", { platform: v("platform"), keyword: kw }).then(function (r) {
            stopProgress();
            var list = $("songList");
            list.innerHTML = "";
            if (!r.ok) {
                $("searchResult").textContent = r.error || T("搜索失败");
                setStatus(r.error || T("搜索失败"), "err");
                return;
            }
            state.songs = r.songs || [];
            for (var i = 0; i < state.songs.length; i++) {
                var o = document.createElement("option");
                o.value = String(state.songs[i].index);
                o.textContent = state.songs[i].name + " - " + state.songs[i].artist;
                list.appendChild(o);
            }
            $("searchResult").textContent = r.info || "";
            setStatus(r.info || T("搜索完成"), "ok");
        });
    }

    function doFetch() {
        var idx = parseInt(optionValue("songList"), 10);
        if (isNaN(idx)) { setStatus(T("先搜索并选中一首"), "err"); return; }
        startProgress(T("正在获取歌词……"));
        hostCall("onlinePick", { index: idx }).then(function (r) {
            stopProgress();
            if (!r.ok) {
                setStatus(r.error || T("获取失败"), "err");
                return;
            }
            $("lyricPreview").value = r.original + (r.translated ? ("\n\n---- 译文 ----\n" + r.translated) : "");   // i18n-allow：split 用的分隔符，翻了就对不上
            state.translated = r.translated || "";
            if (r.translated) { $("hasTrans").checked = true; }
            updateTransInfo();
            setStatus(r.info || T("已获取歌词"), "ok");
            /* 自动切到导入页，少点一次 */
            $("lyricText").value = r.original || "";
            state.source = r.name || "";
            saveForm();
        });
    }

    function doUseLyric() {
        var txt = $("lyricPreview").value;
        if (!txt) { setStatus(T("先获取歌词"), "err"); return; }
        var parts = txt.split("\n\n---- 译文 ----\n");   // i18n-allow：同上
        $("lyricText").value = parts[0] || "";
        if (parts.length > 1) {
            state.translated = parts[1];
            $("hasTrans").checked = true;
            updateTransInfo();
        }
        var btn = document.querySelector('.tabbtn[data-tab="import"]');
        if (btn) { btn.onclick(); }
        setStatus(T("已载入歌词导入页"), "ok");
        saveForm();
    }

    function doProbeOnline() {
        var kw = v("keyword") || "测试";   // i18n-allow：默认搜索词是数据
        startProgress(T("正在体检在线通道……"));
        hostCall("onlineProbe", { keyword: kw }).then(function (r) {
            stopProgress();
            var box = $("aboutLog");
            var lines = [T("【在线通道体检】")];
            if (!r.ok) { lines.push(r.error || T("失败")); }
            else {
                lines.push(T("关键词：%1", kw));
                lines.push(T("可用通道：%1", r.transport || T("无")));
                var t = r.tests || [];
                for (var i = 0; i < t.length; i++) {
                    lines.push("  " + (t[i].ok ? "[OK] " : "[X]  ") + t[i].name + "  " + (t[i].note || ""));
                }
            }
            box.value = lines.join("\n") + "\n\n" + box.value;
            setStatus(lines[1] || "", "ok");
        });
    }

    /* ------------------------------------------------------------ 设置 / 关于 */

    function setLang(l) {
        var use = (l === "auto") ? detectSystemLang() : normalizeLang(l);
        lang = use;
        window.LST_LANG = lang;   /* net.js 的错误提示要按当前语言翻 */
        try { localStorage.setItem(LS_LANG, l); } catch (e) { }
        applyI18n();
        call("setLang", { lang: use }).then(function () { });
        updateTransInfo();
        setStatus(T("界面语言：%1", T(LANG_NAME[use] || use)), "ok");
    }

    function doSelfTest() {
        call("selftest", {}).then(function (r) {
            var box = $("aboutLog");
            var lines = [T("【自检】")];
            if (!r.ok) { lines.push(r.error || T("失败")); }
            else {
                var rows = r.rows || [];
                for (var i = 0; i < rows.length; i++) {
                    lines.push((rows[i].ok ? "[OK] " : "[X]  ") + rows[i].name + "  " + (rows[i].note || ""));
                }
                lines.push("");
                lines.push(r.report || "");
            }
            /* 面板侧的网络能力也报一下 —— 在线歌词在 PR 里全靠它。
               这一条是宿主看不见的（Node 在面板进程里），必须由面板自己补。 */
            var nc = netCapability();
            lines.push("");
            lines.push((nc.ok ? "[OK] " : "[X]  ") + T("面板取网（net.js）") + "  " + nc.note);
            box.value = lines.join("\n") + "\n\n" + box.value;
            setStatus(r.report || T("自检完成"), r.bad > 0 ? "err" : "ok");
        });
    }

    function doProbe() {
        call("probe", {}).then(function (r) {
            var box = $("aboutLog");
            var lines = [T("【API 能力探测】")];
            if (!r.ok) { lines.push(r.error || T("失败")); }
            else {
                var rows = r.rows || [];
                for (var i = 0; i < rows.length; i++) {
                    lines.push((rows[i].ok ? "[OK] " : "[X]  ") + rows[i].name + "  " + (rows[i].note || ""));
                }
            }
            box.value = lines.join("\n") + "\n\n" + box.value;
            setStatus(T("探测完成"), "ok");
        });
    }

    function doCopyLog() {
        var box = $("aboutLog");
        if (!box || !box.value) { setStatus(T("没有可复制的内容")); return; }
        try {
            box.removeAttribute("readonly");
            box.select();
            document.execCommand("copy");
            box.setAttribute("readonly", "readonly");
            setStatus(T("已复制"), "ok");
        } catch (e) { setStatus(T("复制失败，请手动选中复制"), "err"); }
    }

    /* ------------------------------------------------------------ 绑定 */

    function fillEncoding() {
        var list = $("encodingList");
        var opts = ["自动识别", "UTF-8", "GBK", "GB2312", "GB18030", "BIG5", "UTF-16LE", "UTF-16BE", "Shift_JIS"];   // i18n-allow：下面 o.textContent = T(opts[i]) 现翻
        list.innerHTML = "";
        for (var i = 0; i < opts.length; i++) {
            var o = document.createElement("option");
            o.value = (i === 0) ? "" : opts[i];
            o.textContent = T(opts[i]);
            list.appendChild(o);
        }
    }

    function bindImport() {
        $("btnOpenLrc").onclick = doOpenLrc;
        $("btnScanFolder").onclick = doScanFolder;
        $("btnLoadFile").onclick = doLoadFile;
        $("btnPaste").onclick = doPaste;
        $("btnClearTrans").onclick = doClearTrans;
        $("btnPreview").onclick = doPreview;
        $("btnRefreshSeq").onclick = function () { refreshSeq(); };
        $("btnClear").onclick = function () {
            $("lyricText").value = "";
            $("previewList").innerHTML = "";
            $("previewInfo").textContent = T("（还没有解析）");
            state.source = "";
            setStatus(T("已清空"));
            saveForm();
        };
        $("hasTrans").onchange = function () {
            if (this.checked && String(state.translated || "") === "") {
                setStatus(T("勾了「使用译文」但没有译文：可以在导入页点「打开歌词/字幕文件…」选译文文件，或在在线歌词页获取。"));
            }
        };
        $("lyricText").addEventListener("change", function () {
            call("setText", { text: this.value, source: T("（手动粘贴）") }).then(function () { });
        });
        $("btnExpandAll").onclick = function () { expandAll("tab-import", true); };
        $("btnCollapseAll").onclick = function () { expandAll("tab-import", false); };
    }

    function bindOutput() {
        $("btnBuildCaption").onclick = doBuildCaption;
        $("btnExportSrt").onclick = doExportSrt;
        $("btnInspectCaptions").onclick = doInspectCaptions;

        /* 图形剪辑那一块整个关掉了（见文件头的 GFX_ENABLED）。
           那些控件在 index.html 里也已经注释掉，元素根本不存在，
           不判一下的话下面随便一行 .onchange 就会抛异常，把整个面板初始化带崩。
           注意这里是包起来而不是 return —— 「全部展开/折叠」在后面，还得绑。 */
        if (GFX_ENABLED) {

        $("gfxSrcKind").onchange = function () { updateGfxRows(); saveForm(); };
        $("btnRefreshGfx").onclick = doRefreshGfx;
        /* 「时间线上的剪辑」那个刷新按钮跟母版区刷新是同一件事 ——
           它也要一并把项目面板素材和参数信息刷新掉，所以直接复用。 */
        $("btnRefreshTrackClips").onclick = doRefreshGfx;
        $("gfxTrackClipList").onchange = saveForm;
        $("btnUseSelection").onclick = doUseSelection;
        $("btnPickMogrt").onclick = doPickMogrt;
        $("btnScanMogrt").onclick = doScanMogrt;
        $("gfxMogrtList").onchange = function () {
            var p = $("gfxMogrtList").value;
            if (!p) { return; }
            $("gfxMogrtPath").value = p;
            $("gfxSrcKind").value = "mogrt";

            /* 把模板里真正的文字参数名填进去 —— 省得用户对着「文字参数」框猜。
               填的是 en_US 那个内部名（PR 里 ComponentParam.name 一般就是它）。
               就算填错了也不怕：宿主的 findParam 还有「按值里带 textEditValue 自动认」
               这一层兜底。 */
            var inf = (state.mogrtInfo && state.mogrtInfo[p]) || null;
            if (inf && inf.ok && inf.textParam) { $("gfxTextParam").value = inf.textParam; }

            updateGfxRows();
            if (inf && inf.kind === "prgraphic") {
                setStatus(T("已选择：%1 ⚠ 这是 PR 原生模板，脚本改文字实测不稳，建议换列表里带 [文字参数] 的（AE 做的）",
                    inf.textParam ? (inf.name || p) : p), "err");
            } else if (inf && inf.ok && inf.textParam) {
                setStatus(T("已选择：%1（文字参数已自动填成 %2）", inf.name || p, inf.textParam), "ok");
            } else {
                setStatus(T("已选择：%1", p), "ok");
            }
            saveForm();
        };
        $("btnLoadParams").onclick = doLoadParams;
        $("btnGfxTryOne").onclick = doGfxTryOne;
        $("btnGfxBuild").onclick = doGfxBuild;

        } /* GFX_ENABLED */

        $("btnExpandOut").onclick = function () { expandAll("tab-output", true); };
        $("btnCollapseOut").onclick = function () { expandAll("tab-output", false); };
    }

    function bindOnline() {
        $("btnSearch").onclick = doSearch;
        $("btnFetch").onclick = doFetch;
        $("btnUseLyric").onclick = doUseLyric;
        $("keyword").addEventListener("keydown", function (e) {
            if (e.keyCode === 13) { doSearch(); }
        });
    }

    function bindSettings() {
        var picker = $("langSel");
        if (picker) { picker.onchange = function () { setLang(this.value); }; }
        $("btnOpenFolder").onclick = doOpenFolder;
        $("btnResetForm").onclick = doResetSettings;
    }

    function bindAbout() {
        $("btnSelfTest").onclick = doSelfTest;
        $("btnProbe").onclick = doProbe;
        $("btnProbeOnline").onclick = doProbeOnline;
        $("btnCopyLog").onclick = doCopyLog;
    }

    /* ------------------------------------------------------------ 启动 */

    function init() {
        lang = initialLang();
        window.LST_LANG = lang;
        applyI18n();

        fillEncoding();
        initTabs();
        initSections("tab-import");
        initSections("tab-output");
        bindImport();
        bindOutput();
        bindOnline();
        bindSettings();
        bindAbout();
        loadForm();
        updateTransInfo();
        updateGfxRows();

        var picker = $("langSel");
        if (picker) {
            var saved = null;
            try { saved = localStorage.getItem(LS_LANG); } catch (e0) { }
            picker.value = (saved === null || saved === "") ? "auto" : saved;
        }

        document.addEventListener("change", saveForm);

        $("buildTag").textContent = "…";

        call("hello", {}).then(function (r) {
            if (!r || !r.ok) {
                setStatus((r && r.error) || T("宿主没就绪"), "err");
                showHostLoadError();
                return;
            }
            state.build = r.build || "?";
            state.version = r.version || "";
            state.versionDate = r.versionDate || "";
            state.pr = r.pr || "";
            state.engine = r.engine || "";
            state.sequence = r.sequence || "";

            $("buildTag").textContent = versionLine() + "  build " + state.build;
            $("aboutBuild").textContent =
                T("版本：%1　构建：%2\nPremiere Pro：%3\n脚本引擎：%4\n当前工程：%5\n当前序列：%6",
                    versionLine(), state.build, state.pr, state.engine,
                    r.project || T("（未保存的工程）"), r.sequence || T("（没有打开的序列）"));
            $("settingsBuild").textContent =
                T("版本：%1　构建：%2", versionLine(), state.build);
            $("settingsPaths").textContent =
                T("扩展目录：%1", extRoot || T("（取不到）"));

            /* 语言在宿主和面板两边各有一份，启动时对齐一次 */
            call("setLang", { lang: lang }).then(function () { });
            refreshSeq();
            setStatus(T("就绪｜Premiere Pro %1", state.pr), "ok");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
