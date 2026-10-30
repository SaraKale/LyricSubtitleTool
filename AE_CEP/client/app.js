/* ============================================================================
 *  app.js —— CEP 面板的前端
 *  ---------------------------------------------------------------------------
 *  这里只负责「界面」：读控件 → 打包成 JSON → 交给宿主（ExtendScript）→ 显示结果。
 *  所有 AE 对象操作都在 host/index.jsx（09_bridge.jsx）那边，跟 ScriptUI 版共用。
 *
 *  三条约定：
 *   1) 调宿主走 call(action, args)，返回 Promise。args 会先 JSON.stringify，
 *      再把反斜杠和引号各转义一层 —— 因为 evalScript 传的是**字符串**，
 *      而 Windows 路径里到处都是反斜杠，歌词里到处都是换行。
 *   2) 长任务是同步阻塞的（宿主跑的时候面板动不了），进度写在宿主的 log 队列里，
 *      这边每 300ms 取一次显示到状态栏。
 *   3) 需要用户确认的地方（合成加长 / 重建）用 HTML 弹窗，不用 ExtendScript 的
 *      confirm() —— 那个弹出来会卡在 AE 主窗口后面，用户根本看不见。
 * ==========================================================================*/

(function () {
    var cs = new CSInterface();

    /* ------------------------------------------------------------ 多语言
     *
     * 设计：**中文原文就是 key**。中文模式下 T() 是恒等函数，等于没接这层；
     * 英文模式下才去查表。这样改文案时不存在「忘了改 key」的漂移。
     * 译文表在 i18n_en.js（window.I18N_EN，自动生成，别手改）。
     *
     * 语言状态有两份，切的时候两边都要通知：
     *   · 这一份（lang）   —— 管面板上的文字；
     *   · 宿主那一份（SB.lang，走 setLang 动作）—— 管脚本返回的运行日志 / 错误信息。
     */
    /* 译文表分别在 i18n_en.js / i18n_zht.js / i18n_ja.js（window.I18N_*，自动生成，别手改）。
     * 语言代码跟宿主那边 SB.LANGS 一一对应 —— 加一种语言要同时动：
     *   ① 这张表  ② index.html 的 <script> 和下拉 option  ③ 宿主 02x_i18n_*.jsx
     *   ④ build_AECEP.py 的 CLIENT_FILES 和 ORDER
     * zh 没有表：中文模式下 T() 是恒等函数，等于没接这层。 */
    var TABLES = {
        "zh": null,
        "zh-Hant": window.I18N_ZH_HANT || {},
        "en": window.I18N_EN || {},
        "ja": window.I18N_JA || {}
    };
    var LANGS = ["zh", "zh-Hant", "en", "ja"];
    /* 切换后状态栏要报「切到哪种语言」—— 语言名本身也走查表，
     * 所以在日文界面下会显示「日本語 に切り替えました」而不是夹一句中文。 */
    var LANG_NAME = { "zh": "简体中文", "zh-Hant": "繁体中文", "en": "English", "ja": "日语" }; /* i18n-allow 语言名当参数传给 T()，不直接显示 */
    var LS_LANG = "st.lang";
    var lang = "zh";

    /** 认不出来的语言一律退回中文 —— 面板上不会出现「一半中文一半别的」。 */
    function normalizeLang(l) {
        var i;
        for (i = 0; i < LANGS.length; i++) { if (l === LANGS[i]) { return l; } }
        return "zh";
    }

    /** 按系统语言猜一个（CEP 里偶尔拿不到 navigator.language，那就按中文走 —— 这插件的用户九成是中文用户） */
    function detectSystemLang() {
        var nav = "";
        try { nav = String(navigator.language || navigator.userLanguage || "").toLowerCase(); } catch (e1) { }
        if (nav === "") { return "zh"; }
        if (nav.indexOf("ja") === 0) { return "ja"; }
        if (nav.indexOf("zh") === 0) {
            /* zh-TW / zh-HK / zh-MO / zh-Hant 用繁体，其余（zh-CN / zh-SG …）用简体 */
            return (nav.indexOf("zh-tw") === 0 || nav.indexOf("zh-hk") === 0 ||
                    nav.indexOf("zh-mo") === 0 || nav.indexOf("zh-hant") === 0) ? "zh-Hant" : "zh";
        }
        return "en";
    }

    /** 上次选过的语言；没选过（或选了「跟随系统」）就按系统语言猜 */
    function initialLang() {
        var saved = null;
        try { saved = localStorage.getItem(LS_LANG); } catch (e0) { }
        if (saved === null || saved === "" || saved === "auto") { return detectSystemLang(); }
        return normalizeLang(saved);
    }

    /**
     * 取当前语言下的这条文案。
     * @param {String} zh 中文原文（＝查表的 key）
     * @param {...} 后面的实参依次替换 %1 %2 %3 …
     * 查不到就原样返回 —— 绝不因为少一条翻译把功能搞挂。
     */
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

    /** 把页面上所有 data-i18n / data-i18n-placeholder 的静态文案铺成当前语言 */
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

    function $(id) { return document.getElementById(id); }
    function v(id) { return $(id).value; }
    function n(id, def) {
        var x = parseFloat($(id).value);
        return isNaN(x) ? def : x;
    }
    function chk(id) { return $(id).checked; }
    function sel(id) { return $(id).selectedIndex; }
    function escJson(s) {
        return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }

    var state = {
        comps: [],
        textLayers: [],
        presets: [],
        fontPs: [""],
        songs: [],
        translated: "",
        build: "?",          // 构建时间戳（排查用：确认 AE 里跑的是不是刚装的那版）
        version: "1.0.1",         // 1.0.0
        versionDate: "2026-10-30",     // 2026-09-20
        ae: "",              // AE 版本 / build
        engine: "",          // ExtendScript 版本
        progPath: "",        // 宿主给的进度文件路径（长动作的实时进度，见 progPoll）
        host: ""             // 宿主信息汇总（设置页 / 关于页显示）
    };

    /** 「v1.0.0(2026-09-20)」这一串的唯一拼法（跟宿主 BR.versionLine() 一致） */
    function versionLine() {
        if (state.version) { return "v" + state.version + "(" + state.versionDate + ")"; }
        /* 还没从宿主拿到版本号时退化成时间戳，总比显示一个空字符串强 */
        return (state.build && state.build !== "?") ? state.build : "";
    }

    /* ------------------------------------------------------------ 与宿主通信 */

    /* 宿主脚本（host/index.jsx）的路径。
     * 理论上 manifest 里的 <ScriptPath> 会在面板加载时自动执行它，但这条链路上
     * 有一环断掉（换了引擎 / 扩展被重新加载 / 手动跑脚本的场景），SB 就不存在，
     * evalScript 会直接返回 "EvalScript error."。所以这里留一条退路：
     * 发现 SB.Bridge 不在，就当场 $.evalFile 把宿主脚本拉起来。
     * 路径统一成正斜杠 —— ExtendScript 在 Windows 上也认 "/"，省掉一层反斜杠转义。 */
    var extRoot = "";
    try { extRoot = (cs.getSystemPath(SystemPath.EXTENSION) || "").replace(/\\/g, "/"); }
    catch (eSys) { extRoot = ""; }

    /* 模块清单（跟构建脚本 build_AECEP.py 里的 ORDER 一致）。只在兜底路径里用，
     * 正常情况下由 host/index.jsx 自己按目录找。 */
    var HOST_MODULES = [
        "00_header.jsx", "01_json.jsx", "02_util.jsx", "02b_i18n.jsx",
        "02c_i18n_en_a.jsx", "02c_i18n_en_b.jsx",
        "02d_i18n_zht_a.jsx", "02d_i18n_zht_b.jsx",
        "02e_i18n_ja_a.jsx", "02e_i18n_ja_b.jsx", "03_lrc.jsx",
        "03b_sub.jsx", "04_layers.jsx", "05_style.jsx", "06_online.jsx", "08_preset.jsx",
        "09_bridge.jsx"
    ];

    /**
     * 引导前缀**每次都带**。
     *   · 先告诉宿主「模块目录在哪」—— 绝对路径，来自 getSystemPath，
     *     **不依赖 $.fileName**。这正是上一版翻车的地方：宿主里那句
     *     `new Folder($.fileName).parent` 没包 try/catch，它一抛异常，
     *     十个模块一个都不加载，面板只能拿到空字符串。
     *   · 正常走 host/index.jsx（它会挑目录、逐个加载、并把结果写进
     *     $.global.LST_LOAD_REPORT）。
     *   · all=true 时**不经过 index.jsx**，直接按绝对路径逐个 evalFile —— 兜底用：
     *     万一装着旧的/坏的 index.jsx，这条路照样能把模块拉起来。
     *   · 整段包在 try/catch 里：它一旦抛异常，后面那句 SB.Bridge.invoke 就不执行，
     *     面板只会拿到空串，什么线索都没有。
     *   · 这段不能以分号收尾把后面那条表达式吞掉（用换行分隔即可）。 */
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
        if (s === "" ) { return T("宿主返回了空字符串（多半是 SB.Bridge 不存在，evalScript 静默失败）"); }
        if (s.indexOf("EvalScript error") >= 0) {
            return T("宿主脚本执行时抛异常了（%1）。常见原因：SB.Bridge 没挂上、或者宿主脚本里某个模块报错。", s);
        }
        return s.slice(0, 300);
    }

    /* 宿主没就绪时**不要让 evalScript 抛异常**：抛了只会回一个空串，
     * 面板拿不到任何线索（这正是「宿主返回空字符串」那句报错的来处）。
     * 改成先回一个 ASCII 标记，再补一句宿主自述的诊断。 */
    var NO_BRIDGE = "LST_NO_BRIDGE";

    /**
     * 拿宿主的自述：模块加载报告 + SB / SB.Bridge 到底在不在。
     * 这条片段**完全不依赖 SB**，所以哪怕宿主彻底没加载成功，它也一定返回点什么。
     * 用 String(...) 包一层是因为 evalScript 只保证回字符串。
     */
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

    /* 宿主加载失败时，把「到底是哪个文件、第几行、什么错误」问出来。
     *
     * 为什么不能用 call()：宿主正是加载失败的那一个，SB.Bridge 根本不存在，
     * 走 call() 只会得到一句「返回内容不是合法 JSON」，什么线索都没有。
     * 所以这条片段**完全不依赖宿主**：它先读宿主自述的加载报告，再自己在
     * try/catch 里 evalFile 一遍，把 ExtendScript 的 Error 对象原样回传。
     *
     * 回传值只用 ASCII + "@@@" 分隔（evalScript 的字符串通道不保证编码），
     * 换行统一压成空格。 */
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
            /* 状态栏太窄，同一份内容再往「关于 / 自检」的结果框里塞一份，方便复制 */
            var box = $("aboutLog");
            if (box) { box.value = txt + "\n\n" + box.value; }
        });
    }

    /* 正在跑的 evalScript 个数。宿主是**串行**执行的：这里大于 0 时再发调用只会
     * 排队，等前一个跑完才轮到 —— 所以「拉日志」那种定时轮询必须让路，不然
     * 长动作结束后会有几十个排队的调用一起执行，面板反而又卡一下。 */
    var hostBusy = 0;

    function attempt(action, args, allowRetry) {
        var json = JSON.stringify(args || {});
        /* 末尾这条表达式在 SB.Bridge 缺失时**不抛异常**，而是回一个标记字符串，
         * 面板据此就能把「宿主的加载报告」捞出来显示 —— 比一个空串有用得多。 */
        var script = bootPrefix(!allowRetry) +
            '((typeof SB === "undefined" || !SB.Bridge || !SB.Bridge.invoke) ? "' + NO_BRIDGE + '" : ' +
            'SB.Bridge.invoke("' + action + '", "' + escJson(json) + '"))';
        return new Promise(function (resolve) {
            hostBusy++;
            try {
                cs.evalScript(script, function (res) {
                    hostBusy--;
                    var out = null, bad = false;
                    try { out = JSON.parse(res); } catch (e) { bad = true; }
                    if (bad && allowRetry && extRoot) {
                        /* 拿到不是 JSON 的东西：再走一遍引导（bootPrefix 里带条件判断，
                         * 只有 SB.Bridge 还不存在时才会真的重载），只重试一回 */
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
            } catch (eEval) {
                hostBusy--;
                resolve({ ok: false, error: String(eEval) });
            }
        });
    }

    function call(action, args) {
        return attempt(action, args, true);
    }

    function setStatus(msg, kind) {
        var bar = $("status");
        bar.textContent = msg || "";
        bar.parentNode.className = "statusbar" + (kind ? (" " + kind) : "");
    }

    /* ------------------------------------------------------------ 长任务的进度
     *
     * 两条通道，分工不同：
     *
     *   ① **进度文件**（同步样式 / 重建这种逐层长动作用）
     *      宿主每处理完一层写一次 "s 3/10" / "r 3/10"，这里用 cep.fs.readFile 直接读。
     *      为什么要绕这一圈：evalScript 是串行的 —— 长动作还在 AE 主线程上跑的时候，
     *      再发 "log" 去取进度只会排队，等动作结束才一起返回。于是状态栏永远停在
     *      「正在重建 0……」，看着就像卡死。而 cep.fs 是 CEP 自己的原生层，不排
     *      AE 主线程的队，动作进行中照样读得到。
     *
     *   ② **宿主日志**（搜索 / 生成这种短一点的动作用）
     *      原来那套 300ms 拉一次 "log"，保留。但宿主忙的时候不拉（见 hostBusy），
     *      否则几十个调用排到最后一起执行，动作都结束了面板还要再卡一下。
     */
    var logTimer = null;
    var progTimer = null;
    var progLast = "";

    function progPoll() {
        var p = state.progPath;
        if (!p) { return; }
        try {
            var fsm = window.cep && window.cep.fs;
            if (!fsm || typeof fsm.readFile !== "function") { return; }
            var r = fsm.readFile(p);
            if (!r || r.err || !r.data) { return; }
            var s = String(r.data).replace(/^\s+|\s+$/g, "");
            if (s === "" || s === progLast) { return; }
            var sp = s.indexOf(" ");
            var kind = (sp > 0) ? s.substring(0, sp) : "r";
            var nt = ((sp > 0) ? s.substring(sp + 1) : s).split("/");
            var done = parseInt(nt[0], 10);
            var total = parseInt(nt[1], 10);
            /* 写文件是覆盖式的，极端情况下可能读到半截（"3/1"）。数值不合理就当没读到。 */
            if (!(done >= 0) || !(total > 0) || done > total) { return; }
            progLast = s;
            setStatus(kind === "s" ? T("正在同步 %1/%2……", done, total)
                                   : T("正在重建 %1/%2……", done, total));
        } catch (eP) { }
    }

    function startProgress(first) {
        if (first) { setStatus(first); }
        progLast = "";
        if (logTimer) { clearInterval(logTimer); }
        logTimer = setInterval(pullLog, 300);
        if (progTimer) { clearInterval(progTimer); }
        progTimer = setInterval(progPoll, 250);
        progPoll();
    }
    function stopProgress() {
        if (logTimer) { clearInterval(logTimer); logTimer = null; }
        if (progTimer) { clearInterval(progTimer); progTimer = null; }
        pullLog();
    }
    function pullLog() {
        /* 宿主正忙就别排这个队了：evalScript 串行，这时候发出去只是白排，
         * 而且会在长动作结束后集中执行几十次，反倒把面板再卡一下。 */
        if (hostBusy > 0) { return; }
        call("log", {}).then(function (r) {
            if (r.ok && r.lines && r.lines.length > 0) {
                setStatus(r.lines[r.lines.length - 1]);
            }
        });
    }

    /* HTML 确认框（替代 ExtendScript 的 confirm） */
    function confirmBox(title, msg, okText) {
        return new Promise(function (resolve) {
            $("dlgTitle").textContent = title;
            $("dlgMsg").textContent = msg;
            $("dlgYes").textContent = okText || T("确定");
            $("mask").classList.add("show");
            function done(v) {
                $("mask").classList.remove("show");
                $("dlgYes").onclick = null;
                $("dlgNo").onclick = null;
                resolve(v);
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

    /* ------------------------------------------------------------ 界面状态持久化 */

    var LS_FORM = "st.form";
    var LS_SEC = "st.sec.";

    /* 表单的「存档版本」。
     *
     * 表单值存在 localStorage 里，下次开面板会整体灌回去 —— 所以光改 HTML 里的
     * selected/checked 是**不够**的：老用户机器上那份旧存档会把它覆盖掉，
     * 表现就是「我明明改了默认值，用户那边还是老样子」。
     *
     * 于是加个版本号：加载时盖不严的就迁移 —— 只把「这次改了默认值」的那几个控件
     * 强制写成新默认，其余的一概不动（用户的字体、位置、折叠状态都保住）。
     * 改哪个控件的默认值了，就把它加进 CHANGED 并把 FORM_VER 往上抬一号。
     */
    var LS_FORM_VER = "st.formVer";
    var FORM_VER = "2";
    var FORM_DEFAULTS_CHANGED = {
        biLayer: "split"          // v2：双语默认「原文/译文各占一个图层」
    };

    function saveForm() {
        try {
            var o = {};
            var els = document.querySelectorAll("input[id],select[id],textarea[id]");
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                /* 语言下拉单独存在 st.lang 里（还要同步给宿主），不混进表单存档 ——
                 * 否则「切换语言」和「恢复默认设置」两套逻辑会互相打架。 */
                if (el.id === "langSel") { continue; }
                o[el.id] = (el.type === "checkbox") ? el.checked : el.value;
            }
            o[".translated"] = state.translated;
            localStorage.setItem(LS_FORM, JSON.stringify(o));
        } catch (e) { }
    }

    function loadForm() {
        var migrating = false;
        try { migrating = (localStorage.getItem(LS_FORM_VER) !== FORM_VER); } catch (e0) { }
        try {
            var raw = localStorage.getItem(LS_FORM);
            if (raw) {
                var o = JSON.parse(raw);
                for (var k in o) {
                    if (!Object.prototype.hasOwnProperty.call(o, k)) { continue; }
                    if (k === ".translated") { state.translated = o[k]; continue; }
                    var el = $(k);
                    if (!el) { continue; }
                    if (el.id === "langSel") { continue; }   // 语言从 st.lang 来，不走存档
                    if (el.type === "checkbox") { el.checked = !!o[k]; }
                    else { el.value = o[k]; }
                }
            }
        } catch (e) { }
        if (migrating) {
            for (var id in FORM_DEFAULTS_CHANGED) {
                if (!Object.prototype.hasOwnProperty.call(FORM_DEFAULTS_CHANGED, id)) { continue; }
                try { $(id).value = FORM_DEFAULTS_CHANGED[id]; } catch (e1) { }
            }
            try { localStorage.setItem(LS_FORM_VER, FORM_VER); } catch (e2) { }
        }
    }

    /* ------------------------------------------------------------ 折叠分组 */

    var secs = Array.prototype.slice.call(document.querySelectorAll(".sec"));

    function setSecOpen(sec, open, remember) {
        var key = sec.getAttribute("data-key");
        if (open) { sec.classList.remove("collapsed"); }
        else { sec.classList.add("collapsed"); }
        if (remember !== false) {
            try { localStorage.setItem(LS_SEC + key, open ? "1" : "0"); } catch (e) { }
        }
    }

    /* 「同时展开多块」勾着＝各块互不干扰；不勾＝单开模式（展开一块自动收起其它）。
     * 存的是「允许同时展开」，跟界面上那个勾的方向一致，读起来不用反着想。
     *
     * 歌词导入页和样式同步页各有自己的一套分组、各有一个开关，
     * 所以用 data-group 区分：收起时只收同页的，不会把另一个页也更着关门。
     */
    function secGroup(sec) { return sec.getAttribute("data-group") || "import"; }

    function accordionOn(sec) {
        var gid = (secGroup(sec) === "style") ? "multiChkStyle" : "multiChk";
        var el = $(gid);
        return el ? !el.checked : false;
    }

    function setAllSections(open, group) {
        for (var i = 0; i < secs.length; i++) {
            if (group && secGroup(secs[i]) !== group) { continue; }
            setSecOpen(secs[i], open);
        }
    }

    function initSections() {
        for (var i = 0; i < secs.length; i++) {
            (function (sec) {
                var key = sec.getAttribute("data-key");
                var saved = null;
                try { saved = localStorage.getItem(LS_SEC + key); } catch (e) { }
                /* 第一次用：全展开（HTML 有滚动条，不折叠也看得全） */
                setSecOpen(sec, saved === null ? true : (saved === "1"), false);
                sec.querySelector(".sec-head").addEventListener("click", function () {
                    var willOpen = sec.classList.contains("collapsed");
                    if (willOpen && accordionOn(sec)) {
                        var grp = secGroup(sec);
                        for (var j = 0; j < secs.length; j++) {
                            if (secs[j] !== sec && secGroup(secs[j]) === grp) {
                                setSecOpen(secs[j], false);
                            }
                        }
                    }
                    setSecOpen(sec, willOpen);
                });
            })(secs[i]);
        }
    }

    /* ------------------------------------------------------------ 通用刷新 */

    function compIndex() { return sel("compList"); }

    /**
     * 填下拉框。
     *
     * 两种入参都吃：
     *   · 纯字符串数组        —— 文案已经翻好了（宿主返回的、或这边 T() 拼的）
     *   · [{value,label}] 数组 —— value 是跨语言不变的稳定值（编码的 ASCII id、
     *     标签色的下标），label 才是给人看的。切语言时只有 label 变，value 不动，
     *     所以「面板回传给宿主的值」不会因为切了语言而错位。
     */
    function fillSelectObj(el, items, keep) {
        if (!el) { return; }
        el.innerHTML = "";
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var op = document.createElement("option");
            if (it !== null && typeof it === "object") {
                op.value = String(it.value);
                /* 宿主那边已经翻过一道；这里再走一次 T() 是**安全网**：
                 * 万一 setLang 那条调用没送达宿主，标签还是中文，这边也能翻过来。
                 * 对已经是英文的标签来说 T() 查不到 key，原样返回，不会翻重。 */
                op.textContent = T(it.label);
            } else {
                op.textContent = String(it);
            }
            el.appendChild(op);
        }
        var idx = (keep !== undefined && keep !== null && keep < items.length) ? keep : 0;
        el.selectedIndex = idx < 0 ? 0 : idx;
    }

    function fillSelect(el, items, keep) { fillSelectObj(el, items, keep); }

    function refreshComps() {
        return call("comps", {}).then(function (r) {
            if (!r.ok) { setStatus(T("读取合成失败：%1", r.error), "err"); return; }
            state.comps = r.comps || [];
            var names = [];
            for (var i = 0; i < state.comps.length; i++) {
                names.push((i + 1) + ". " + state.comps[i].name);
            }
            if (names.length === 0) { names.push(T("（当前项目没有合成）")); }
            fillSelect($("compList"), names, r.active);
            updatePosHint();
            return refreshTextLayers();
        });
    }

    function updatePosHint() {
        var c = state.comps[compIndex()];
        $("posHint").textContent = c
            ? T("合成：%1×%2，%3fps，时长 %4s，%5 个图层", c.width, c.height, c.fps.toFixed(2), c.duration.toFixed(1), c.layers)
            : "";
    }

    function refreshTextLayers() {
        return call("textLayers", { compIndex: compIndex() }).then(function (r) {
            if (!r.ok) { return; }
            state.textLayers = r.layers || [];
            var names = [];
            for (var i = 0; i < state.textLayers.length; i++) {
                names.push("#" + state.textLayers[i].index + "  " + state.textLayers[i].name);
            }
            if (names.length === 0) { names.push(T("（合成里没有文字图层）")); }
            fillSelect($("refList"), names, 0);
            fillSelect($("refList2"), [T("（不用 —— 两组都用同一个参考层）")].concat(names), 0);
            fillSelect($("tplList"), [T("（不使用 —— 按排版样式新建）")].concat(names), 0);
            $("tplInfo").textContent = state.textLayers.length > 0
                ? T("当前合成里有 %1 个文字图层可以当模板。\n选一个，生成时就会复制它（图层样式 / 效果 / 动画器全带走），只换文字和时间。", state.textLayers.length)
                : T("当前合成里还没有文字图层。先手动做一个满意的样式，再回来选它当模板。");
            updateRefInfo();
            updateIndexHint();
        });
    }

    function refLayerIndex() {
        var i = sel("refList");
        var t = state.textLayers[i];
        return t ? t.index : 0;
    }

    /** 第二个参考层的图层号（0 = 不用） */
    function ref2LayerIndex() {
        var i = sel("refList2");
        if (i <= 0) { return 0; }
        var t = state.textLayers[i - 1];
        return t ? t.index : 0;
    }

    function tplLayerIndex() {
        var i = sel("tplList");
        if (i <= 0) { return 0; }
        var t = state.textLayers[i - 1];
        return t ? t.index : 0;
    }

    /**
     * 「获取当前选中图层」：把时间轴里选中的图层同步到某个下拉框。
     * @param {String} listId  目标下拉框
     * @param {Number} offset  列表前面的占位项数（tplList 第一项是「不使用」，所以是 1）
     */
    function pickSelected(listId, offset) {
        call("textLayers", { compIndex: compIndex(), selectedOnly: true }).then(function (r) {
            if (!r.ok || !r.index) {
                alertBox(T("获取不到选中的图层"),
                    r.error || T("请先在时间轴里选中一个图层，再点这个按钮。"));
                return;
            }
            function applyIt() {
                for (var j = 0; j < state.textLayers.length; j++) {
                    if (state.textLayers[j].index === r.index) {
                        $(listId).selectedIndex = j + offset;
                        updateRefInfo();
                        updateIndexHint();
                        setStatus(T("已获取到选中的第 %1 层「%2」%3", r.index, r.name,
                            (r.more ? T("（另外还选中了 %1 个）", r.more) : "")), "ok");
                        return;
                    }
                }
                alertBox(T("这个图层不在列表里"),
                    T("选中的第 %1 层「%2」不是文字图层，\n参考图层 / 模板图层只能选文字图层。", r.index, r.name));
            }
            /* 选中的图层在另一个合成里：把下拉框切过去再刷一次清单 */
            if (r.compIndex >= 0 && r.compIndex !== compIndex()) {
                $("compList").selectedIndex = r.compIndex;
                updatePosHint();
                refreshTextLayers().then(applyIt);
                return;
            }
            applyIt();
        });
    }

    function updateRefInfo() {
        var t = state.textLayers[sel("refList")];
        $("refInfo").textContent = t
            ? T("参考：%1（第 %2 层）", t.name, t.index)
            : T("未选择参考图层");
        updateBiInfo();
    }

    /** ③ 那块底下的说明：把「怎么认分组」「位置会怎么处理」写成具体的话 */
    function updateBiInfo() {
        var el = $("biInfo");
        if (!el) { return; }
        var pos = optionValue("biPos", "stagger");
        var scope = optionValue("biScope", "all");
        var step = n("biStep", 0);
        var hasRef2 = ref2LayerIndex() > 0;

        var lines = [];
        lines.push(T("怎么认分组：先读图层备注里生成时留的配对标记；没有标记（图层不是本脚本生成的）就按文字体系判断 —— 日文一定带假名、中文只有汉字，这两类分得最干净。"));

        if (pos === "stagger") {
            lines.push(T("位置：抄完参考层之后，按组内行号错开 %1。原文在上、译文在下，跟生成时排的一样。",
                (step > 0 ? (step + "px") : T("行距（自动＝字号 × 1.25）"))));
        } else if (pos === "keep") {
            lines.push(T("位置：完全不参与复制，每层保留自己原来的 X / Y。"));
        } else {
            lines.push(T("⚠ 位置：照抄参考层 —— 成对的原文 / 译文会得到同一个 Y，叠在一起。要分开就改成「保留上下错位」。"));
        }

        if (scope === "same") { lines.push(T("范围：只处理跟参考层同组的那些层。")); }
        else if (scope === "other") { lines.push(T("范围：只处理另一组（跟参考层不同组）的那些层。")); }

        if (hasRef2) {
            lines.push(T("另一组用第二个参考层：那一组直接照抄它的样式和位置（不再错位，因为第二参考层本来就摆在译文该在的位置上）。"));
        }
        el.textContent = lines.join("\n");
    }

    /** 扫一遍：把「同组 / 另一组」各多少层摊出来，省得盲选 */
    function scanPairs() {
        if (refLayerIndex() <= 0) {
            alertBox(T("还没选参考图层"), T("先在「① 参考图层」里选一个文字图层，再扫。"));
            return;
        }
        setStatus(T("正在扫描双语分组……"));
        call("pairs", {
            compIndex: compIndex(), refIndex: refLayerIndex(), spec: v("indexSpec")
        }).then(function (r) {
            if (!r.ok) {
                $("pairScanInfo").textContent = "";
                setStatus(T("扫描失败：%1", r.error), "err");
                return;
            }
            $("pairScanInfo").textContent =
                T("%1 层里：同组 %2 / 另一组 %3", r.total, r.same, r.other) +
                (r.scripts ? ("　（" + r.scripts + "）") : "");
            var t = [];
            t.push(T("参考层判定为「%1」，位置在第 %2 行%3", r.refScript, r.refSub + 1,
                r.refTagged ? T("（来自生成时的标记）") : T("（按文字体系猜的）")));
            if (r.total > 0 && r.same > 0 && r.other === 0) {
                t.push(T("⚠ 没认出第二组：目标里全是和参考层同类的文字。如果确实是双语，检查是不是只勾了「只跟参考层同组」，或者图层号没覆盖到译文层。"));
            }
            if (r.total > 0 && r.same > 0 && r.other > 0) {
                t.push(T("举例　同组：%1　另一组：%2",
                    (r.sampleSame || []).join(" / "), (r.sampleOther || []).join(" / ")));
            }
            if (r.tagged > 0) {
                t.push(T("其中 %1 层带生成时的配对标记，判定是最准的那批。", r.tagged));
            }
            $("biInfo").textContent = t.join("\n");
            setStatus(T("扫描完成：同组 %1 层 / 另一组 %2 层", r.same, r.other), "ok");
        });
    }

    function updateIndexHint() {
        var c = state.comps[compIndex()];
        if (!c) { $("indexHint").textContent = T("（还没选到合成）"); return; }
        call("indexHint", { compIndex: compIndex(), spec: v("indexSpec") }).then(function (r) {
            if (r.ok) { $("indexHint").textContent = r.text; }
        });
    }

    function refreshPresets() {
        return call("presets", { presetDir: localStorage.getItem("st.presetDir") || "" }).then(function (r) {
            if (!r.ok) { return; }
            state.presets = r.items || [];
            var names = [];
            for (var i = 0; i < state.presets.length; i++) { names.push(state.presets[i].name); }
            fillSelect($("presetList"), names, 0);
            $("presetInfo").textContent = r.info || "";
        });
    }

    function refreshFonts() {
        return call("fonts", {}).then(function (r) {
            if (!r.ok) { return; }
            var items = r.fonts || [];
            var names = [], ps = [];
            for (var i = 0; i < items.length; i++) { names.push(items[i].label); ps.push(items[i].ps); }
            state.fontPs = ps;
            fillSelect($("fontList"), names, 0);
            setStatus(r.fallback
                ? T("当前 AE 不提供字体列表（app.fonts 不可用），已换成常见字体清单")
                : T("字体列表已刷新，共 %1 个", items.length - 1));
        });
    }

    /* ------------------------------------------------------------ 参数打包 */

    function frameArgs() {
        return {
            defaultDur: n("defaultDur", 2), gap: n("gap", 0.02), minDur: n("minDur", 0.3),
            maxDur: n("maxDur", 0), offset: n("offset", 0), leadIn: n("leadIn", 0),
            leadOut: n("leadOut", 0), mergeTol: n("mergeTol", 0.02),
            biLayout: sel("biLayout") === 1 ? "sameLine" : "stack",
            biOrder: sel("biOrder") === 1 ? "BA" : "AB",
            biLayer: biLayerMode(),
            lineStep: n("lineStep", 0),
            splitLines: chk("splitLines")
        };
    }

    /**
     * 「双语图层」下拉的当前值。
     *
     * 这里要照顾到「同一行」排版：那种模式下原文译文已经拼进同一行文本了，
     * 本来就只有一行，再拆层也没东西可拆，所以只有「上下两行」时才允许拆。
     */
    function biLayerMode() {
        if (sel("biLayout") === 1) { return "merge"; }
        return optionValue("biLayer", "merge");
    }

    /** 读 <select> 的 value（select.options[i].value 在 CEP 的老 Chromium 里也能用） */
    function optionValue(id, fallback) {
        var el = $(id);
        if (!el || el.selectedIndex < 0) { return fallback; }
        var op = el.options[el.selectedIndex];
        var val = op ? (op.getAttribute("value") || op.value) : "";
        return val === "" ? fallback : val;
    }

    function hexToArr(hex) {
        var s = String(hex).replace(/^#/, "");
        if (s.length === 3) { s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]; }
        return [parseInt(s.substr(0, 2), 16) / 255,
                parseInt(s.substr(2, 2), 16) / 255,
                parseInt(s.substr(4, 2), 16) / 255];
    }

    function layerArgs() {
        return {
            fontSize: n("fontSize", 60),
            font: state.fontPs[sel("fontList")] || "",
            fill: hexToArr(v("colorFill")),
            strokeOn: chk("strokeOn"),
            strokeColor: hexToArr(v("colorStroke")),
            strokeWidth: n("strokeWidth", 2),
            justify: ["center", "left", "right"][sel("justify")] || "center",
            posX: n("posX", 960), posY: n("posY", 900),
            autoCenter: chk("autoCenter"),
            vertical: chk("vertical"),
            verticalDir: sel("verticalDir") === 1 ? "ltr" : "rtl",
            leadingRatio: n("leadingRatio", 0),
            vLeadingRatio: n("vLeadingRatio", 1),
            tracking: n("tracking", 0),
            layerName: ["text", "index", "index+text"][sel("layerName")] || "text",
            labelIndex: sel("labelList"),
            lineStep: n("lineStep", 0),
            reverse: chk("optReverse")
        };
    }

    function previewArgs() {
        return {
            text: v("lyricText"),
            hasTrans: chk("hasTrans"),
            translated: state.translated || "",
            matchTol: n("matchTol", 0.6),
            /* 只对 .ass / .ssa 起作用：把文件里样式表的字体/字号/颜色/描边
             * 盖到面板的排版样式上。其它格式没有样式表，勾着也不影响。 */
            assStyle: chk("assStyle"),
            frame: frameArgs()
        };
    }

    function remapMode() {
        var i = sel("remapMode");
        return ["scale", "shift", "none"][i] || "scale";
    }

    /* ------------------------------------------------------------ 导入页 */

    function doPreview() {
        return call("preview", previewArgs()).then(function (r) {
            if (!r.ok) {
                $("previewList").innerHTML = "";
                $("previewInfo").textContent = r.error;
                setStatus(T("解析失败：%1", r.error), "err");
                return false;
            }
            var html = "";
            for (var i = 0; i < r.list.length; i++) {
                var it = r.list[i];
                var no = String(it.i);
                while (no.length < 3) { no = "0" + no; }
                /* 双语拆层时缩进 + 「原 / 译」角标，一眼能看出同一时间码的
                 * 两句是不是挨在一起、顺序对不对 */
                var tag = it.role ? ('<span class="tag">' + escapeHtml(it.role) + "</span>") : "";
                html += '<div class="pv' + (it.indent ? " sub" : "") + '">#' + no +
                    "  " + escapeHtml(it.time) + "  " + tag + escapeHtml(it.text) + "</div>";
            }
            $("previewList").innerHTML = html;
            $("previewInfo").textContent = r.info;
            updateReverseHint(r);
            setStatus(T("解析完成：%1", r.info), "ok");
            return true;
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    /** 预览列表里用的短文本：太长就截断，换行显示成 | */
    function clipText(s) {
        var t = String(s || "").replace(/\r/g, " | ");
        return t.length > 12 ? (t.substring(0, 12) + "…") : t;
    }

    /**
     * 「双语图层」那行底下的说明。
     *
     * 拆层这个功能最容易被误解的地方是「拆完了会不会叠在一起」，所以这里把
     * 实际会用到的行距、中心 Y、图层排列顺序全部写成具体数字，让勾之前就知道结果。
     */
    function updateBiLayerHint() {
        var el = $("biLayerHint");
        if (!el) { return; }
        if (sel("biLayout") === 1) {
            el.textContent = T("「同一行」排版下，原文已经和译文拼进同一行文本了，没有第二行可拆 —— 双语图层固定为合并。");
            try { $("biLayer").disabled = true; } catch (e0) { }
            return;
        }
        try { $("biLayer").disabled = false; } catch (e1) { }

        if (biLayerMode() === "split") {
            el.textContent = T("一句歌词＝2 个文字图层（原文一个、译文一个），时间码完全相同，\n上下错开 %1px，整组以 Y=%2 为中心居中。\n图层顺序：原文 → 译文 → 下一句原文 → 下一句译文 ……同一句的两层始终挨在一起。",
                Math.round(LYStep()), v("posY"));
        } else {
            el.textContent = T("原文译文写在同一个图层里，用换行分隔 —— 一个时间码一个图层。");
        }
    }

    /** 双语行距的实际像素值（跟宿主那条「0 = 字号 × 1.25」的规则保持一致） */
    function LYStep() {
        var s = n("lineStep", 0);
        return (s > 0) ? s : (n("fontSize", 60) * 1.25);
    }

    function updateReverseHint(r) {
        if (!r || !r.count) { $("reverseHint").textContent = ""; return; }
        $("reverseHint").textContent = chk("optReverse")
            ? T("最上层会是「%1」", clipText(r.last))
            : T("最上层是「%1」", clipText(r.first));
    }

    function doGenerate() {
        var args = previewArgs();
        args.compIndex = compIndex();
        args.autoComp = chk("autoComp");
        args.layer = layerArgs();
        args.tplIndex = tplLayerIndex();
        args.tplHide = chk("optTplHide");
        args.tplRename = chk("optTplName");
        args.remapMode = remapMode();
        args.presetOnGen = chk("optPresetOnGen");
        args.presetIndex = sel("presetList");
        args.precompose = chk("precompose");

        startProgress(T("正在生成……"));
        return call("generate", args).then(function (g) {
            if (!g.ok && g.needConfirm && g.needConfirm.kind === "extend") {
                var nc = g.needConfirm;
                return confirmBox(T("合成时长不够"),
                    T("歌词总长 %1 秒，但合成「%2」只有 %3 秒。\n\n后面的字幕会落在合成时长之外，看不到。\n要把合成加长到 %4 秒吗？",
                        nc.need.toFixed(2), nc.comp, nc.current.toFixed(2), nc.want), T("加长")).then(function (yes) {
                    args.extend = !!yes;
                    return call("generate", args);
                });
            }
            return g;
        }).then(function (g) {
            stopProgress();
            if (!g.ok) {
                setStatus(T("生成失败：%1", g.error), "err");
                alertBox(T("生成失败"), g.error);
                return;
            }
            setStatus(g.msg, "ok");
            $("previewInfo").textContent = T("%1。\n图层名就是歌词文本本身，可在合成里直接看到。", g.msg);
            return refreshComps();
        });
    }

    function afterLoadText(r) {
        if (!r.ok) {
            if (r.cancelled) { return; }
            setStatus(T("读取失败：%1", r.error), "err");
            alertBox(T("读取失败"), r.error);
            return;
        }
        $("lyricText").value = r.text;
        state.translated = "";
        $("hasTrans").checked = false;
        $("transInfo").textContent = T("没有译文");
        if (r.dir) { localStorage.setItem("st.lastDir", r.dir); }
        /* SRT / ASS / VTT 会额外回报格式，让人一眼确认「读对了」——
         * 三种格式都是纯文本，互相长得很像，认错了很难一眼看出来。 */
        var tail = r.formatLabel ? T("，%1 字幕", r.formatLabel) : "";
        setStatus(T("已读取 %1（%2，%3 行）", r.name, r.encoding, r.lines) + tail, "ok");
        return doPreview();
    }

    /* ------------------------------------------------------------ 样式页 */

    function copyArgs() {
        return {
            textStyle: chk("optTextStyle"), copyText: chk("optCopyText"),
            transform: chk("optTransform"), layerProps: chk("optLayerProps"),
            keyframes: chk("optKeyframes"), ease: chk("optEase"), values: chk("optValues"),
            expressions: chk("optExpressions"), effects: chk("optEffects"),
            masks: chk("optMasks"), animators: chk("optAnimators"),
            skipRef: chk("optSkipRef"), onlyText: chk("optOnlyText")
        };
    }

    /**
     * 双语分组的参数。
     *
     * 这一块解决的是「应用完之后所有字幕叠在同一个位置」：
     * 「各占一个图层」生成的原文/译文本来是靠 Y 错位分开的，而样式同步会把参考层的
     * 位置原样抄给每一层 —— 两组就重合了。所以默认走 stagger：抄完再按组内行号
     * 把每层挪回该在的高度。
     */
    function biArgs() {
        return {
            scope: optionValue("biScope", "all"),
            pos: optionValue("biPos", "stagger"),
            step: n("biStep", 0),
            ref2Index: ref2LayerIndex()
        };
    }

    function styleBaseArgs() {
        return {
            compIndex: compIndex(),
            refIndex: refLayerIndex(),
            spec: v("indexSpec"),
            copy: copyArgs(),
            remapMode: remapMode(),
            bi: biArgs()
        };
    }

    function doApplyStyle() {
        if (refLayerIndex() <= 0) { alertBox(T("还没选参考图层"), T("先在「① 参考图层」里选一个文字图层。")); return; }
        startProgress(T("正在同步 0……"));
        return call("style", styleBaseArgs()).then(function (r) {
            stopProgress();
            if (!r.ok) { setStatus(T("样式同步失败：%1", r.error), "err"); alertBox(T("样式同步失败"), r.error); return; }
            $("styleResult").value = (r.lines || []).join("\n");
            setStatus(T("样式同步完成"), "ok");
            return refreshTextLayers();
        });
    }

    function doRebuild() {
        if (refLayerIndex() <= 0) { alertBox(T("还没选参考图层"), T("先在「① 参考图层」里选一个文字图层。")); return; }
        var args = styleBaseArgs();
        return call("rebuild", args).then(function (r) {
            if (!r.ok && r.needConfirm && r.needConfirm.kind === "rebuild") {
                var nc = r.needConfirm;
                return confirmBox(T("以参考图层重建"),
                    T("将用参考图层「%1」复制出 %2 个图层，替换掉：\n%3%4\n\n每层会保留自己的文字和入点出点，样式全部换成参考层的。\n旧图层会被删除（整个操作可以 Ctrl+Z 撤销）。",
                        nc.ref, nc.count, (nc.names || []).join("、"), (nc.more ? T(" …等") : "")), T("继续")).then(function (yes) {
                    if (!yes) { return null; }
                    args.confirmed = true;
                    startProgress(T("正在重建 0……"));
                    return call("rebuild", args);
                });
            }
            if (r.ok) { startProgress(T("正在重建……")); }
            return r;
        }).then(function (r) {
            if (!r) { return; }
            stopProgress();
            if (!r.ok) { setStatus(T("重建失败：%1", r.error), "err"); alertBox(T("重建失败"), r.error); return; }
            $("styleResult").value = (r.lines || []).join("\n");
            setStatus(T("重建完成"), "ok");
            return refreshComps();
        });
    }

    function doStyleTextOnly() {
        if (refLayerIndex() <= 0) { alertBox(T("还没选参考图层"), T("先在「① 参考图层」里选一个文字图层。")); return; }
        return call("styleTextOnly", styleBaseArgs()).then(function (r) {
            if (!r.ok) { setStatus(T("同步失败：%1", r.error), "err"); return; }
            $("styleResult").value = (r.lines || []).join("\n");
            setStatus(T("文字样式同步完成"), "ok");
        });
    }

    /* ------------------------------------------------------------ 在线页 */

    function doSearch() {
        var kw = (v("keyword") || "").trim();
        if (!kw) { alertBox(T("还差关键词"), T("请输入歌名、歌手，或者直接粘贴歌曲链接 / 歌曲 ID。")); return; }
        setStatus(T("正在搜索「%1」……（网络慢的话最多等 30 秒）", kw));
        return call("search", { platform: sel("platform") === 1 ? "qq" : "netease", keyword: kw })
            .then(function (r) {
                if (!r.ok) { setStatus(T("搜索失败：%1", r.error), "err"); $("searchResult").textContent = T("搜索失败：%1", r.error); return; }
                fillSelect($("songList"), r.items || [], 0);
                $("searchResult").textContent = r.info;
                setStatus(r.info, "ok");
            });
    }

    function doFetch() {
        var i = sel("songList");
        if (i < 0) { alertBox(T("还没选歌"), T("请先在列表里选一首歌。")); return; }
        setStatus(T("正在获取歌词……"));
        return call("fetch", { index: i }).then(function (r) {
            if (!r.ok) { setStatus(T("获取失败：%1", r.error), "err"); $("lyricPreview").value = T("获取失败：%1", r.error); return; }
            $("lyricPreview").value = r.text;
            setStatus(T("已获取歌词，点「载入歌词导入页」把它带过去"), "ok");
        });
    }

    /* ------------------------------------------------------------ 关于页 */

    function doSelfTest() {
        setStatus(T("正在自检……"));
        return call("selfTest", {}).then(function (r) {
            $("aboutLog").value = r.ok ? r.text : T("自检失败：%1", r.error);
            setStatus(T("自检完成"), "ok");
        });
    }

    function doProbeOnline() {
        setStatus(T("正在体检在线通道……"));
        return call("probeOnline", { keyword: v("keyword") }).then(function (r) {
            $("aboutLog").value = r.ok ? r.text : T("体检失败：%1", r.error);
            setStatus(T("在线通道体检完成"), "ok");
        });
    }

    /* ------------------------------------------------------------ 设置页 / 语言 */

    /** 标签栏右侧那个「构建 v1.0.0(2026-09-20)」 */
    function fillBuildTag() {
        var el = $("buildTag");
        if (el) { el.textContent = T("构建 %1", versionLine()); }
    }

    /** 设置页 / 关于页共用的那几行版本信息 */
    function buildInfoText() {
        return T("版本：%1\n构建时间戳：%2\n宿主：%3",
            versionLine() || "?", state.build || "?", state.host || "?");
    }

    function refreshSettingsInfo() {
        var b = $("settingsBuild");
        if (b) { b.textContent = buildInfoText(); }
        var ab = $("aboutBuild");
        if (ab) { ab.textContent = buildInfoText(); }
        var p = $("settingsPaths");
        if (p) { p.textContent = T("面板目录：%1", extRoot || "?"); }
    }

    /**
     * 切界面语言。
     *
     * @param {String}  l     "zh" / "en"
     * @param {Boolean} quiet 启动时静默切（不往状态栏写「已切换」）
     *
     * 三件事都要做，少一件就会「一半中文一半英文」：
     *   1) 静态文案（data-i18n）重铺
     *   2) 运行时拼出来的那些重刷（下拉框、提示、版本串）
     *   3) 通知宿主 —— 它那边的 SB.lang 管的是运行日志和错误信息
     */
    function setLang(l, quiet) {
        if (l === "auto") { l = detectSystemLang(); }
        lang = normalizeLang(l);
        try { localStorage.setItem(LS_LANG, lang); } catch (e0) { }

        var picker = $("langSel");
        if (picker) { picker.value = lang; }

        applyI18n();
        fillBuildTag();
        refreshSettingsInfo();
        updateBiLayerHint();
        refreshComps();
        refreshPresets();
        call("setLang", { lang: lang });

        if (!quiet) {
            setStatus(T("已切换到 %1", T(LANG_NAME[lang])), "ok");
        }
    }

    /** 设置页：在系统里打开扩展目录（方便看日志 / 换版本） */
    function doOpenFolder() {
        call("openExtFolder", {}).then(function (r) {
            if (!r.ok) { alertBox(T("打开插件文件夹失败"), r.error || ""); return; }
            setStatus(T("已打开：%1", r.path), "ok");
        });
    }

    /**
     * 设置页：恢复默认设置。
     *
     * 直接把 localStorage 里所有 "st." 前缀的键清掉再重载面板 ——
     * 比在代码里逐个 reset 靠谱（将来加了新控件也不用回来改这里）。
     */
    function doResetSettings() {
        confirmBox(T("恢复默认设置"),
            T("会把面板上的所有设置（含界面语言）清回出厂状态，然后重新载入面板。\n\n确定吗？"),
            T("恢复")).then(function (yes) {
                if (!yes) { return; }
                try {
                    var keys = [];
                    for (var i = 0; i < localStorage.length; i++) { keys.push(localStorage.key(i)); }
                    for (var j = 0; j < keys.length; j++) {
                        if (String(keys[j]).indexOf("st.") === 0) { localStorage.removeItem(keys[j]); }
                    }
                } catch (e0) { }
                try { location.reload(); } catch (e1) { setStatus(T("已恢复默认设置"), "ok"); }
            });
    }

    /* ------------------------------------------------------------ 事件绑定 */

    function bind() {
        /* 标签页 */
        var btns = document.querySelectorAll(".tabbtn");
        for (var i = 0; i < btns.length; i++) {
            (function (b) {
                b.addEventListener("click", function () {
                    for (var j = 0; j < btns.length; j++) { btns[j].classList.remove("active"); }
                    b.classList.add("active");
                    var panes = document.querySelectorAll(".tabpane");
                    for (var k = 0; k < panes.length; k++) { panes[k].classList.remove("active"); }
                    $("tab-" + b.getAttribute("data-tab")).classList.add("active");
                });
            })(btns[i]);
        }

        $("btnExpandAll").onclick = function () { setAllSections(true, "import"); };
        $("btnCollapseAll").onclick = function () { setAllSections(false, "import"); };
        $("btnExpandStyle").onclick = function () { setAllSections(true, "style"); };
        $("btnCollapseStyle").onclick = function () { setAllSections(false, "style"); };

        /* --- ① 歌词文本 --- */
        $("btnOpenLrc").onclick = function () {
            call("openFile", { encoding: v("encodingList") }).then(afterLoadText);
        };
        $("btnScanFolder").onclick = function () {
            call("scanFolder", { lastDir: localStorage.getItem("st.lastDir") || "" }).then(function (r) {
                if (!r.ok) { if (!r.cancelled) { setStatus(T("扫描失败：%1", r.error), "err"); } return; }
                localStorage.setItem("st.lastDir", r.dir);
                var items = [];
                for (var i = 0; i < r.files.length; i++) {
                    var h = r.files[i];
                    var kb = Math.round(h.size / 1024);
                    items.push((h.lrc ? T("[歌词] ") : T("[按名字] ")) + h.name + "   " +
                        (kb < 1 ? h.size + " B" : kb + " KB"));
                }
                if (items.length === 0) { items.push(T("（这个文件夹里没找到歌词文件）")); }
                fillSelect($("fileList"), items, 0);
                setStatus(T("扫描完成：找到 %1 个歌词文件", r.files.length), "ok");
            });
        };
        $("btnLoadFile").onclick = function () {
            call("loadFile", { index: sel("fileList"), encoding: v("encodingList") }).then(afterLoadText);
        };
        $("btnPaste").onclick = function () { call("paste", {}).then(afterLoadText); };
        $("btnClear").onclick = function () {
            $("lyricText").value = "";
            $("previewList").innerHTML = "";
            $("previewInfo").textContent = T("（还没有解析）");
            state.translated = "";
            $("hasTrans").checked = false;
            $("transInfo").textContent = T("没有译文");
            setStatus(T("已清空"));
        };
        $("btnClearTrans").onclick = function () {
            state.translated = "";
            $("hasTrans").checked = false;
            $("transInfo").textContent = T("没有译文");
        };
        $("hasTrans").onchange = function () {
            $("transInfo").textContent = this.checked
                ? T("使用译文：%1 行", (state.translated ? state.translated.split("\n").length : 0))
                : T("没有译文");
            doPreview();
        };

        /* --- ② 目标合成 --- */
        $("btnRefreshComp").onclick = function () { refreshComps(); };
        $("compList").onchange = function () {
            updatePosHint();
            refreshTextLayers();
        };
        $("btnGetCenter").onclick = function () {
            var c = state.comps[compIndex()];
            if (!c) { return; }
            $("posX").value = String(Math.round(c.width / 2));
            $("posY").value = String(Math.round(c.height / 2));
        };
        $("btnGetBottom").onclick = function () {
            var c = state.comps[compIndex()];
            if (!c) { return; }
            $("posX").value = String(Math.round(c.width / 2));
            $("posY").value = String(Math.round(c.height * 0.85));
        };

        /* --- ③ 排版样式 --- */
        $("btnFonts").onclick = function () { setStatus(T("正在读取系统字体……")); refreshFonts(); };
        $("fontSize").oninput = function () { updateBiLayerHint(); };
        $("posY").oninput = function () { updateBiLayerHint(); };

        /* --- ④ 时间轴与双语 --- */
        $("biLayout").onchange = function () { updateBiLayerHint(); doPreview(); };
        $("biOrder").onchange = function () { doPreview(); };
        $("biLayer").onchange = function () { updateBiLayerHint(); doPreview(); };
        $("lineStep").oninput = function () { updateBiLayerHint(); };
        $("splitLines").onchange = function () { doPreview(); };

        /* --- ⑤ 预览与生成 --- */
        $("optReverse").onchange = function () { doPreview(); };
        $("btnPreview").onclick = function () { doPreview(); };
        $("btnGenerate").onclick = function () { doGenerate(); };

        /* --- ⑥ 动画预设 --- */
        $("btnPresetRefresh").onclick = function () { refreshPresets(); };
        $("btnPresetToSel").onclick = function () {
            startProgress(T("正在套用预设……"));
            call("applyPreset", { compIndex: compIndex(), scope: "sel", presetIndex: sel("presetList"), clear: chk("optPresetClear") })
                .then(function (r) {
                    stopProgress();
                    if (!r.ok) { setStatus(T("套用失败：%1", r.error), "err"); alertBox(T("套用预设失败"), r.error); return; }
                    setStatus(r.msg, "ok");
                    if (r.errors && r.errors.length) { alertBox(T("套用预设（有报错）"), r.msg + "\n\n" + r.errors.slice(0, 6).join("\n")); }
                });
        };
        $("btnPresetToAll").onclick = function () {
            startProgress(T("正在套用预设……"));
            call("applyPreset", { compIndex: compIndex(), scope: "alltext", presetIndex: sel("presetList"), clear: chk("optPresetClear") })
                .then(function (r) {
                    stopProgress();
                    if (!r.ok) { setStatus(T("套用失败：%1", r.error), "err"); alertBox(T("套用预设失败"), r.error); return; }
                    setStatus(r.msg, "ok");
                    if (r.errors && r.errors.length) { alertBox(T("套用预设（有报错）"), r.msg + "\n\n" + r.errors.slice(0, 6).join("\n")); }
                });
        };
        $("btnPresetDir").onclick = function () {
            call("pickPresetDir", {}).then(function (r) {
                if (!r.ok) { return; }
                localStorage.setItem("st.presetDir", r.dir);
                refreshPresets();
                setStatus(T("已添加预设目录：%1", r.dir), "ok");
            });
        };
        $("btnPresetProbe").onclick = function () {
            call("presetProbe", {}).then(function (r) {
                $("presetInfo").textContent = r.ok ? r.text : r.error;
                setStatus(T("动画预设能力体检完成"), "ok");
            });
        };

        /* --- ⑦ 模板图层 --- */
        $("btnTplRefresh").onclick = function () { refreshTextLayers(); };
        $("btnTplPick").onclick = function () { pickSelected("tplList", 1); };

        /* --- 样式同步页 --- */
        $("btnRefRefresh").onclick = function () { refreshComps(); };
        $("refList").onchange = function () { updateRefInfo(); updateIndexHint(); };
        $("btnRefPick").onclick = function () { pickSelected("refList", 0); };
        $("btnAllLayers").onclick = function () {
            var c = state.comps[compIndex()];
            if (!c) { alertBox(T("还没选到合成"), T("请先在项目里打开/选中一个合成，再点「全部」。")); return; }
            $("indexSpec").value = "1-" + c.layers;
            updateIndexHint();
        };
        $("indexSpec").oninput = function () { updateIndexHint(); };

        /* --- 样式同步页：③ 双语图层 --- */
        $("btnPairScan").onclick = function () { scanPairs(); };
        $("btnRefPick2").onclick = function () { pickSelected("refList2", 1); };
        $("refList2").onchange = function () { updateBiInfo(); };
        $("biPos").onchange = function () { updateBiInfo(); };
        $("biScope").onchange = function () { updateBiInfo(); };
        $("biStep").oninput = function () { updateBiInfo(); };

        /* 「应用到目标图层」的按钮现在藏在 HTML 里（display:none，原因见 index.html 的注释）。
         * 绑定时判一下：哪天彻底删掉这个元素，这里也不会抛「读不到 onclick」。 */
        if ($("btnApply")) { $("btnApply").onclick = function () { doApplyStyle(); }; }
        $("btnRefRebuild").onclick = function () { doRebuild(); };
        $("btnRefCopyOnly").onclick = function () { doStyleTextOnly(); };

        /* --- 在线页 --- */
        $("btnSearch").onclick = function () { doSearch(); };
        $("btnFetch").onclick = function () { doFetch(); };
        $("keyword").addEventListener("keydown", function (e) {
            if (e.keyCode === 13) { doSearch(); }
        });
        $("btnUseLyric").onclick = function () {
            call("fetch", { index: sel("songList"), peek: true }).then(function (r) {
                if (!r.ok) { alertBox(T("还没有歌词"), T("请先点「获取歌词（含译文）」。")); return; }
                $("lyricText").value = r.original || "";
                state.translated = (r.translated || "").trim();
                $("hasTrans").checked = state.translated !== "";
                $("transInfo").textContent = $("hasTrans").checked
                    ? T("已载入译文：%1 行", state.translated.split("\n").length) : T("没有译文");
                var btns = document.querySelectorAll(".tabbtn");
                btns[0].click();
                return doPreview();
            }).then(function () {
                setStatus(T("歌词已载入「歌词导入」页，确认没问题后点「生成字幕图层」"), "ok");
            });
        };

        /* --- 关于页 --- */
        $("btnSelfTest").onclick = function () { doSelfTest(); };
        $("btnProbeOnline").onclick = function () { doProbeOnline(); };

        /* --- 设置页 --- */
        var picker = $("langSel");
        if (picker) {
            picker.onchange = function () { setLang(this.value); };
        }
        $("btnOpenFolder").onclick = function () { doOpenFolder(); };
        $("btnResetForm").onclick = function () { doResetSettings(); };

        /* 表单改动自动存起来（下次打开还是上次的设置） */
        document.addEventListener("change", saveForm);
        document.addEventListener("input", debounce(saveForm, 400));
    }

    function debounce(fn, ms) {
        var t = null;
        return function () {
            if (t) { clearTimeout(t); }
            var self = this, args = arguments;
            t = setTimeout(function () { fn.apply(self, args); }, ms);
        };
    }

    /* ------------------------------------------------------------ 主题 */

    function applyTheme() {
        try {
            var env = JSON.parse(cs.getHostEnvironment());
            var c = env.appSkinInfo.panelBackgroundColor.color;
            var lum = (c.red + c.green + c.blue) / 3;
            if (lum > 128) { document.body.classList.add("light"); }
        } catch (e) { }
    }

    /* ------------------------------------------------------------ 启动 */

    function boot() {
        applyTheme();

        /* 语言要**最先**定下来：后面的 loadForm / bind / 各种 hint 都会往界面上写
         * T() 出来的文案，早一步铺好就不会闪一下中文再变英文。 */
        lang = initialLang();
        applyI18n();
        var picker = $("langSel");
        if (picker) { picker.value = lang; }

        loadForm();
        bind();
        initSections();
        updateBiLayerHint();

        /* 先探一下宿主到底在不在，把结论直接摊在状态栏上。
         * 这一步不走 call()，就是要看**原始返回**。
         * 返回值只用 ASCII，中文在 JS 这边再拼 —— evalScript 的编码链路万一有偏差，
         * 至少不会把诊断信息本身搞成乱码。
         * 探不到就当场用 bootPrefix() 补载一次（它会带上模块目录的绝对路径，
         * 不依赖 $.fileName），然后复探 —— 免得用户看到「面板出来了但按啥都没反应」。 */
        var probe =
            '(typeof SB === "undefined") ? "NO_SB" :' +
            ' ((SB.Bridge && SB.Bridge.invoke) ? ("OK|" + SB.Bridge.build) : "NO_BRIDGE")';

        function readProbe(s) {
            if (s.indexOf("OK|") === 0) { return { ok: true, msg: T("宿主已就绪（构建 %1）", s.slice(3)) }; }
            if (s === "NO_SB") { return { ok: false, msg: T("宿主脚本没加载：manifest 的 ScriptPath 没生效，已尝试自动补载") }; }
            if (s === "NO_BRIDGE") { return { ok: false, msg: T("SB 在，但 SB.Bridge.invoke 不在：宿主模块没加载全") }; }
            return { ok: false, msg: T("宿主探活失败，原始返回：%1", s.slice(0, 200)) };
        }

        cs.evalScript(probe, function (raw) {
            var first = readProbe(String(raw || ""));
            if (first.ok) { setStatus(T("【启动自检】%1", first.msg), "ok"); return; }
            cs.evalScript(bootPrefix(true) + probe, function (raw2) {
                var s2 = String(raw2 || "");
                if (s2.indexOf("OK|") === 0) {
                    setStatus(T("【启动自检】%1", T("宿主已就绪（构建 %1）", s2.slice(3))), "ok");
                    return;
                }
                /* 补载还是不行：把 evalFile 的错误对象和宿主的加载报告一起掏出来
                 * （文件名 + 行号 + 错误号 + 哪个模块失败），省掉一轮来回猜。 */
                setStatus(T("【启动自检】%1", readProbe(s2).msg), "err");
                showHostLoadError();
            });
        });

        call("hello", {}).then(function (r) {
            if (r.ok) {
                state.build = r.build || "?";
                state.version = r.version || "";
                state.versionDate = r.versionDate || "";
                state.ae = r.ae || "";
                state.engine = r.engine || "";
                state.progPath = r.prog || "";
                state.host = T("AE %1 · ExtendScript %2", state.ae, state.engine);
            } else {
                state.build = "?";
                state.host = r.error || "";
                setStatus(T("连不上宿主：%1", r.error), "err");
            }
            fillBuildTag();
            refreshSettingsInfo();
            /* 把面板选的语言告诉宿主 —— 它那边的 SB.lang 管运行日志和错误信息的语言 */
            call("setLang", { lang: lang });
        });

        call("encodings", {}).then(function (r) {
            if (!r.ok) { return; }
            fillSelectObj($("encodingList"), r.encodings || [], 0);
            if (r.labels) { fillSelect($("labelList"), r.labels, 0); }
        });

        refreshComps();
        refreshPresets();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
