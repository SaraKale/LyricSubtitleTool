/* ============================================================================
 *  07_ui.jsx —— ScriptUI 面板
 *  ---------------------------------------------------------------------------
 *  四个标签页：
 *    歌词导入 —— 读 LRC / 粘贴文本 → 预览 → 批量生成文字图层（①~⑤ 可折叠）
 *    样式同步 —— 选参考图层 → 填图层号(1-10 / 1,5,10) → 批量套样式、效果、关键帧
 *    在线歌词 —— 网易云 / QQ 音乐 搜索 → 取歌词（含译文）→ 灌进歌词导入页
 *    关于自检 —— 环境信息、自检、在线通道体检
 *
 *  ---------------------------------------------------------------------------
 *  关于「折叠」和「滚动」—— 这几条都是本机 AE 2023 实测出来的，别再踩第二次：
 *
 *   1) `visible = false` 不会让布局收缩。控件不画了，但位置还占着，
 *      面板一点都不会变短。想做折叠必须把容器的
 *      preferredSize / minimumSize / maximumSize 高度压到 0。
 *   2) **光压 body 还不够 —— 外层 wrap（panel）自己会留着折叠前的高度。**
 *      只在首屏压 body 的话，就会出现「初次启动时各个分组之间空一大截，
 *      手动点一次『全部折叠』就又正常了」。所以 wrap 的高度也要显式钉住：
 *        展开 = sec.wrapH（展开状态下量到的整高）
 *        折叠 = 标题栏高 + 上下边距 + 间距（baseWrapHeight）
 *      两个方向都要钉，不能只钉折叠 —— 因为尺寸一旦被设过就回不到「自动」，
 *      只钉折叠的话展开时 wrap 会永远停在 44px 高。
 *   3) 反向「还原成自动高度」不可靠（三个值设回 -1 会得到 -1，不是自动），
 *      所以展开时必须用折叠前量下来的高度显式撑回去。
 *   4) 三个尺寸的赋值顺序有讲究，而且 maximumSize 的宽要给**大数**：
 *        preferred=[w,0] → minimum=[10,0] → maximum=[10000,0]
 *      写成 maximum=[当前面板宽,0] 会静默失效（不报错，也不收缩）。
 *   5) 首屏那一次布局经常「算不干净」（win.show() 之后马上改尺寸，AE 还没
 *      进入上屏状态），所以套完折叠状态还要再兜一次：见 runSettleTask()，
 *      用 app.scheduleTask 推迟 60ms 再「量一遍 + 套状态 + 重排」，
 *      scheduleTask 不可用时退化成多跑一遍 relayout()。
 *   6) 折叠完要把浮窗高度收掉（fitWindowHeight），只在「现在比需要的还高」
 *      时收，不主动撑高，免得跟用户手动拉大的尺寸打架。
 *   7) **没有滚动容器，做不出真正的滚动条**，所以最终没做：
 *      · scrollbar 控件是横向的，orientation 设 "vertical" 不生效（实测仍是 120x16）
 *      · stack 分组里手动设子控件的 location 有效，但下一次 layout 就会重置成 (0,0)
 *      · stack 分组不会 fill：它忽略 alignment，宽度算出来是 -1，位置还会飘到中间
 *        （实测 vp 位置 x=334、宽 -1，内容全被挤到窗口右半边外面）
 *      · 用「固定高视口 + 把内容往上挪」模拟滚动，那些内容并不会被裁掉，
 *        只会糊到下面的控件上
 *      所以长面板的正解是「折叠分组 + 单开模式 + 把面板拉大」，不是滚动条。
 *      （真滚动条只有换 CEP/UXP 扩展用 HTML 界面才有，逻辑层可以原样复用。）
 *   8) Point / Bounds 不能直接拼进字符串，会抛
 *      「在需要数字、数组或属性的位置找到类型为"Point"的对象」，必须 .x / .y 拆开读。
 *
 *  验证方式：tests/ae_uitest.jsx（数值）、_tools/shoot_ui.py（截图）
 * ==========================================================================*/

(function (thisObj) {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var L = root.Lrc;
    var LY = root.Layers;
    var ST = root.Style;
    var ON = root.Online;
    var PR = root.Preset;

    var UI = {};
    var S = {};
    var R = {};            // 控件引用

    /* build_AEJSX.py 会把下面这行的字符串替换成构建时间戳。
     * 面板标题和「关于」页都会显示它 —— 以后再说「功能不好使」的时候，
     * 先看一眼这个号，就能确认 AE 里跑的到底是不是最新那版。 */
    var BUILD = "dev";

    /** 「v1.0.0(2026-09-20)」—— 版本号 + 日期。
     *  唯一来源是 00_header.jsx 的 SB.VERSION / SB.VERSION_DATE，发版只改那两行。
     *  BUILD 那个时间戳另有用处：判别 AE 里跑的到底是不是刚装的那版（旧面板要重启 AE 才换）。 */
    function versionLine() {
        return "v" + SB.VERSION + "(" + SB.VERSION_DATE + ")";
    }

    var SEC = {};          // 折叠分组
    var SECTION_ORDER = [];

    root.STATE = S;

    var SETTINGS_SECTION = "SubtitleToolAE";

    /* ================================================================== 小工具 */

    function row(parent, spacing) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];
        if (spacing !== undefined) { g.spacing = spacing; }
        return g;
    }

    function col(parent, spacing) {
        var g = parent.add("group");
        g.orientation = "column";
        g.alignChildren = ["fill", "top"];
        g.alignment = ["fill", "top"];
        if (spacing !== undefined) { g.spacing = spacing; }
        return g;
    }

    function lab(parent, text, width) {
        var t = parent.add("statictext", undefined, text);
        if (width) { t.preferredSize.width = width; }
        return t;
    }

    function edit(parent, value, width) {
        var e = parent.add("edittext", undefined, value);
        e.preferredSize.width = width || 56;
        return e;
    }

    function drop(parent, items, width) {
        var d = parent.add("dropdownlist", undefined, items);
        if (width) { d.preferredSize.width = width; }
        if (items && items.length > 0) { d.selection = 0; }
        return d;
    }

    function check(parent, text, value) {
        var c = parent.add("checkbox", undefined, text);
        c.value = !!value;
        return c;
    }

    function saveSetting(key, value) {
        try { app.settings.saveSetting(SETTINGS_SECTION, key, String(value)); } catch (e) { }
    }

    function loadSetting(key, fallback) {
        try {
            var v = app.settings.getSetting(SETTINGS_SECTION, key);
            if (v === null || v === undefined || v === "") { return fallback; }
            return String(v);
        } catch (e) {
            return fallback;
        }
    }

    /** 递归地显示/隐藏一个容器里的直接子控件（折叠时用） */
    function setKidsVisible(cont, v) {
        try {
            if (!cont || !cont.children) { return; }
            for (var i = 0; i < cont.children.length; i++) {
                try { cont.children[i].visible = v; } catch (e) { }
            }
        } catch (e2) { }
    }

    /* ================================================================== 重绘 */

    /**
     * 让面板立刻重画。
     *
     * 为什么需要：ScriptUI 默认要等事件处理函数返回才重绘。我们的搜索
     * 是同步阻塞的（system.callSystem 不返回，主线程就卡着），所以必须在
     * 发起请求之前手动刷一下，用户才看得到「正在搜索」这几个字。
     */
    function repaint() {
        try {
            if (UI.window && typeof UI.window.update === "function") { UI.window.update(); }
        } catch (e) { }
    }

    /** 重新布局（折叠/展开、控件增删之后必须调），并补量还没记下高度的分组 */
    function relayout() {
        try {
            if (UI.window) {
                /* 连跑两遍：AE 的布局是自顶向下重算一遍，改过尺寸之后一遍
                 * 常常算不干净（尤其是首屏那次），第二遍就稳了。 */
                UI.window.layout.layout(true);
                UI.window.layout.resize();
                repaint();
                UI.window.layout.layout(true);
                UI.window.layout.resize();
            }
        } catch (e) { }
        try { measureOpenSections(); } catch (e2) { }
    }

    /**
     * 把浮窗收成「内容刚好装下」的高度。
     *
     * 折叠之后窗口本身不会跟着变矮，多出来的高度就在底下留一大片空白。
     * 两步走：
     *   1) layout.resize() —— ScriptUI 官方的「按内容把窗口收小」
     *   2) 收不动的话手动设一次 size，但**多给 30px 余量**：
     *      Windows 上 win.size 可能把标题栏也算进去，给少了会把底部状态栏切掉。
     *      宁可多留一条空白，也不切控件。
     * 只在「明显偏高」时才动手（>40px），不然会跟用户手动拉大的尺寸打架 ——
     * 用户拉大的部分记在 filler（R.filler）里，本来就算在内容高度里。
     */
    function fitWindowHeight() {
        if (!(UI.window instanceof Window)) { return; }
        try { UI.window.layout.resize(); } catch (e0) { }

        var need = contentNeedHeight();
        if (!(need > 200)) { return; }
        try {
            var cur = UI.window.size.height;
            if (cur > need + 40) {
                UI.window.size = [UI.window.size.width, need + 30];
            }
        } catch (e) { }
    }

    /** 浮窗里各子控件的自然高度之和（含边距 / 间距）。量不全就返回 0，调用方跳过 */
    function contentNeedHeight() {
        try {
            var win = UI.window;
            if (!win || !win.children) { return 0; }
            var n = win.children.length, need = 0;
            for (var i = 0; i < n; i++) {
                var h = 0;
                try { h = win.children[i].size.height; } catch (e1) { h = 0; }
                if (!(h > 0)) { return 0; }
                need += h;
            }
            if (n > 1) { need += (n - 1) * (win.spacing || 0); }
            need += (win.margins || 0) * 2;
            return need;
        } catch (e) { return 0; }
    }

    /* ================================================================== 折叠分组 */

    /**
     * 把分组外框（wrap）的高度钉死。
     *
     * h <= 0 表示「不管它」（保持自动）。注意宽度**只读不写** ——
     * 写 preferredSize.width 会让它不再跟着面板宽度拉伸。
     */
    function pinWrapHeight(wrap, h) {
        if (!wrap || !(h > 0)) { return; }
        try {
            wrap.preferredSize.height = h;
            wrap.minimumSize.height = h;
            wrap.maximumSize.height = h;
        } catch (e) { }
    }

    /**
     * 分组「只剩标题栏」时该有多高 = 标题按钮高 + 上下边距 + 间距。
     *
     * 实测值就是从这里来的，不是拍脑袋的常数：展开时的整高减掉 body 高度，
     * 剩下的正好是这几个数。所以折叠时钉这个值，展开时钉 wrapH，两个方向闭合。
     */
    function baseWrapHeight(sec) {
        var headH = 24;
        try { if (sec.head && sec.head.size.height > 0) { headH = sec.head.size.height; } } catch (e) { }
        var m = 8;
        try { if (typeof sec.wrap.margins === "number") { m = sec.wrap.margins; } } catch (e2) { }
        var sp = 0;
        try { sp = sec.wrap.spacing || 0; } catch (e3) { }
        return headH + m * 2 + sp;
    }

    /** 分组展开时该有多高：优先用展开状态下量到的整高 */
    function openWrapHeight(sec) {
        if (sec.wrapH > 0) { return sec.wrapH; }
        return baseWrapHeight(sec) + (sec.h > 0 ? sec.h : 0);
    }

    /* ------------------------------------------------------------ 单开模式 */

    /**
     * 单开模式（手风琴）：展开一块的时候自动收起其它块。
     *
     * 为什么默认开：面板没有滚动容器（见文件头 7)），内容一长就只能靠折叠 +
     * 拉大窗口。单开模式下整个面板 ≈ 一块的高度，用不着滚动。
     * 想同时看两块，把这个勾去掉就行。
     */
    function accordionOn() { return loadSetting("accordion", "1") !== "0"; }

    function closeSiblings(keep) {
        for (var i = 0; i < SECTION_ORDER.length; i++) {
            var other = SECTION_ORDER[i];
            if (other === keep || !other.open) { continue; }
            other.apply(false);
            saveSetting("sec_" + other.key, "0");
        }
    }

    /**
     * 可折叠分组：一个「▼ 标题」按钮 + 一块内容。
     *
     * 折叠的实现见文件头的说明 1)/2)：靠容器尺寸压 0，靠记下来的高度还原。
     */
    function makeSection(parent, key, title, defaultOpen) {
        var wrap = parent.add("panel", undefined, undefined);
        wrap.orientation = "column";
        wrap.alignChildren = ["fill", "top"];
        wrap.alignment = ["fill", "top"];
        wrap.margins = 8;
        wrap.spacing = 4;

        var head = wrap.add("button", undefined, "");
        head.alignment = ["fill", "top"];
        head.preferredSize.height = 24;

        var body = wrap.add("group");
        body.orientation = "column";
        body.alignChildren = ["fill", "top"];
        body.alignment = ["fill", "top"];
        body.spacing = 4;

        var sec = {
            key: key, title: title, wrap: wrap, head: head, body: body,
            open: true, h: 0, wrapH: 0, defaultOpen: !!defaultOpen, lastError: ""
        };

        sec.paint = function () {
            try { head.text = (sec.open ? "\u25BC  " : "\u25B6  ") + sec.title; } catch (e) { }
        };

        /**
         * 套用折叠状态。
         *
         * 尺寸的三个值必须按 preferred → minimum → maximum 的顺序设，
         * 而且 maximumSize 的宽要给一个大数（探针里验证过的写法）。
         * 注意 open=true 且还没量到高度时**不要**加尺寸约束 —— 加了会把
         * 刚建好的分组直接压成 0 高，之后就再也量不到真实高度了。
         * 界面搭完之后 applySavedStates() 会统一量一遍再套状态。
         *
         * 这里连外层 wrap 一起钉住（见文件头 2)）：只压 body 的话，首屏那次
         * wrap 会留着展开时的高度，于是「初次启动各分组之间空一大截」。
         */
        sec.apply = function (open) {
            sec.lastError = "";
            var w = 0;
            try { w = sec.wrap.size.width; } catch (e0) { w = 0; }
            if (!(w > 40)) { w = 600; }

            if (open) {
                setKidsVisible(sec.body, true);
                if (!(sec.h > 0)) {
                    /* 还没量到高度：按子控件算一个。
                     * 这里**不要**写「把三个尺寸设回 -1 让它自动撑开」—— 那个方向
                     * 回不去（见 makeSection 的说明），只会让它永远卡在 -1 高度上。 */
                    sec.h = naturalBodyHeight(sec.body);
                }
                if (sec.h > 0) {
                    try {
                        sec.body.preferredSize = [w, sec.h];
                        sec.body.minimumSize = [10, sec.h];
                        sec.body.maximumSize = [10000, 100000];
                    } catch (e1) { sec.lastError = "展开失败：" + e1.toString(); }
                }
                pinWrapHeight(sec.wrap, openWrapHeight(sec));
            } else {
                try {
                    if (sec.body.size && sec.body.size.height > 4) { sec.h = sec.body.size.height; }
                } catch (eH) { }
                if (!(sec.h > 0)) { sec.h = naturalBodyHeight(sec.body); }
                try {
                    sec.body.preferredSize = [w, 0];
                    sec.body.minimumSize = [10, 0];
                    sec.body.maximumSize = [10000, 0];
                } catch (e2) { sec.lastError = "折叠失败：" + e2.toString(); }
                setKidsVisible(sec.body, false);
                pinWrapHeight(sec.wrap, baseWrapHeight(sec));
            }
            sec.open = open;
            sec.paint();
        };

        sec.toggle = function () {
            var willOpen = !sec.open;
            /* 单开模式：展开一块的时候，把别的块都收起来。
             * 面板没有滚动条（见下方说明），一次只留一块展开就不会长到屏幕外。 */
            if (willOpen && accordionOn()) {
                closeSiblings(sec);
            }
            sec.apply(willOpen);
            saveSetting("sec_" + sec.key, willOpen ? "1" : "0");
            relayout();
            fitWindowHeight();
        };

        head.onClick = function () { sec.toggle(); };

        /* 注意：建的时候**绝对不能碰尺寸**，连设成 -1 都不行。
         * 实测（探针 v4）：一个容器的 min/max/preferredSize 只要被显式设过一次，
         * 再设回 -1 也**不会**恢复「按内容自动算」——preferredSize 会永远停在
         * 2147483648 这个「未定义」哨兵值上，size.height 也就一直是 -1。
         * 所以这里让它保持出厂状态，等界面搭完、布局跑过一遍，再由
         * measureAllSections() 统一量高度、applySavedStates() 统一套状态。 */
        sec.open = true;
        sec.paint();
        SECTION_ORDER.push(sec);
        return sec;
    }

    /**
     * 按内容算一个分组该有多高。
     *
     * 为什么不用 size.height：那个值可能因为上面说的「尺寸被设过」而变成 -1。
     * 但子控件的 size.height 是可靠的（探针 v4 实测：110 + 28 + 28 + 28，
     * 加上 3 个间距 12，正好等于显式撑开时量到的 206）。
     */
    function naturalBodyHeight(body) {
        if (!body || !body.children || body.children.length === 0) { return 0; }
        var h = 0, n = 0;
        for (var i = 0; i < body.children.length; i++) {
            var ch = body.children[i];
            var chh = 0;
            try { chh = ch.size.height; } catch (e1) { chh = 0; }
            if (!(chh > 0)) {
                try { chh = ch.preferredSize.height; } catch (e2) { chh = 0; }
            }
            if (!(chh > 0)) { chh = 0; }
            h += chh;
            n++;
        }
        if (n > 1) { h += (n - 1) * (body.spacing || 0); }
        return h;
    }

    /**
     * 补量「还没记下高度」的分组。
     *
     * 两条路：能读到 body.size.height 就用它；读不到（返回 -1，说明这个容器的
     * 尺寸被显式设过、自动算高度已经失效）就按子控件加一遍。
     *
     * 顺带把「展开时的整高 wrapH」记下来 —— 折叠时要用它减出标题栏的高度。
     * 只量**展开着**的分组：折叠着的那些 wrap 已经是压缩后的值了。
     */
    function measureOpenSections() {
        for (var i = 0; i < SECTION_ORDER.length; i++) {
            var sec = SECTION_ORDER[i];

            if (sec.open && !(sec.wrapH > 0)) {
                var wh = 0;
                try { if (sec.wrap.size.width > 40) { wh = sec.wrap.size.height; } } catch (ew) { wh = 0; }
                if (wh > 20) { sec.wrapH = wh; }
            }

            if (sec.h > 0) { continue; }
            var h = 0;
            try {
                if (sec.wrap.size.width > 40 && sec.body.size.height > 4) {
                    h = sec.body.size.height;
                }
            } catch (e1) { h = 0; }
            if (!(h > 4)) { h = naturalBodyHeight(sec.body); }
            if (h > 4) { sec.h = h; }
        }
    }

    /** 面板宽度变了之后，重新贴合 / 撑开各个分组（高度也要重新钉一遍） */
    function refitSections() {
        for (var i = 0; i < SECTION_ORDER.length; i++) {
            var sec = SECTION_ORDER[i];
            pinWrapHeight(sec.wrap, sec.open ? openWrapHeight(sec) : baseWrapHeight(sec));
            if (!sec.open || !(sec.h > 0)) { continue; }
            try {
                var w = sec.wrap.size.width;
                if (w > 40) {
                    sec.body.preferredSize = [w, sec.h];
                    sec.body.minimumSize = [10, sec.h];
                    sec.body.maximumSize = [10000, 100000];
                }
            } catch (e) { }
        }
    }

    /** 建完界面、量好高度之后，套用「上次的折叠状态」 */
    function applySavedStates() {
        /* 第一次启动：①~⑦ 全部折叠。
         * 面板默认全长展开实在太长了（一上来就八百多像素），
         * 第一次进来先收成 7 个标题栏，要用哪块点哪块，之后按用户自己存的状态走。
         * 之后配合「单开模式」，展开一块只占用一块的高度。 */
        var firstRun = loadSetting("secInit", "") !== "1";

        for (var i = 0; i < SECTION_ORDER.length; i++) {
            var sec = SECTION_ORDER[i];
            var want = firstRun
                ? false
                : (loadSetting("sec_" + sec.key, sec.defaultOpen ? "1" : "0") === "1");
            if (want !== sec.open) { sec.apply(want); }
            if (firstRun) { saveSetting("sec_" + sec.key, "0"); }
        }
        if (firstRun) { saveSetting("secInit", "1"); }
    }

    /** 建完界面之后量一遍高度：先让布局按自然状态排一次，再逐个补量 */
    function measureAllSections() {
        relayout();
        measureOpenSections();
    }

    function setAllSections(open) {
        for (var i = 0; i < SECTION_ORDER.length; i++) {
            SECTION_ORDER[i].apply(open);
            saveSetting("sec_" + SECTION_ORDER[i].key, open ? "1" : "0");
        }
        relayout();
        fitWindowHeight();
    }

    /**
     * 首屏布局收尾。
     *
     * 「初次启动各个分组之间空一大截，手动点一下『全部折叠』又正常」——
     * 根因是 win.show() 之后紧接着改尺寸时，AE 的布局还没进入上屏状态，
     * 那一次 layout 是算不干净的。这里推迟一拍再「量一遍 + 套状态 + 重排」。
     */
    function settleLayout() {
        try { measureOpenSections(); } catch (e0) { }
        try { applySavedStates(); } catch (e1) { }
        try { relayout(); } catch (e2) { }
        try { fitWindowHeight(); } catch (e3) { }
    }

    /**
     * 把 settleLayout 排到首屏之后执行。
     *
     * app.scheduleTask 跑的是**字符串**，拿不到这里的闭包变量，
     * 所以只能走全局：07_ui.jsx 末尾把 UI.__settle 挂在 SB 上，
     * 定时任务里再摸回来（SB 是全局的，见文件末尾 root.UI = UI）。
     * scheduleTask 不存在 / 排不进去时退化成再跑一遍 relayout —— 至少不是原地不动。
     */
    function runSettleTask() {
        var scheduled = false;
        try {
            if (app && typeof app.scheduleTask === "function") {
                app.scheduleTask(
                    "try{if(typeof SB!=='undefined'&&SB.UI&&SB.UI.__settle){SB.UI.__settle();}}catch(e){}",
                    60, false);
                scheduled = true;
            }
        } catch (e) { scheduled = false; }
        if (!scheduled) { relayout(); }
    }

    /* ============================================================ 关于「滚动条」 */

    /* 用户提过两次「面板太长，能不能加个滚动条」。AE 2023 的 ScriptUI 做不到，
     * 这里留一段说明，免得以后再走一遍弯路：
     *   · stack 分组不 fill：宽度算出来是 -1，位置飘到父容器中间
     *     （实测视口 x=334、宽 -1，整块内容被挪到窗口右半边外）
     *   · 手动设的 location 在下一次 layout.layout() 之后会被重置回 (0,0)
     *   · 超出视口的内容不会被裁掉，会直接糊到下面的控件上
     *   · scrollbar 控件是横向的，orientation 设 "vertical" 也不生效
     *     （换来的「滚动条」也没法真的带动内容，因为没有裁剪）
     * 所以「太长」是靠三招一起解决的：
     *   ① 折叠分组（②~⑦ 默认收起）
     *   ② 单开模式：展开一块自动收起其它块，面板高度 ≈ 一块
     *   ③ 面板本身可拉大 / 右下角「＋ −」按 60px 调高调矮
     * 真要原生滚动条，只能把界面层换成 CEP/UXP 扩展用 HTML 写
     * （逻辑层 01~06、08 可以原样复用，是要重写 UI 层 + 加一层 CSInterface 桥）。
     */

    /* ================================================================== 颜色按钮 */

    function makeColorButton(parent, initial) {
        var btn = parent.add("button", undefined, "");
        btn.preferredSize = [44, 20];
        btn.__c = initial || [1, 1, 1];
        btn.onDraw = function () {
            var g = this.graphics;
            var c = this.__c;
            g.newPath();
            g.rectPath(1, 1, this.size.width - 2, this.size.height - 2);
            g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [c[0], c[1], c[2], 1]));
            g.newPath();
            g.rectPath(1, 1, this.size.width - 2, this.size.height - 2);
            g.strokePath(g.newPen(g.PenType.SOLID_COLOR, [0.2, 0.2, 0.2, 1], 1));
        };
        btn.onClick = function () {
            var pick = null;
            try {
                if (typeof $.colorPicker === "function") {
                    var hex = ((Math.round(this.__c[0] * 255) << 16) |
                        (Math.round(this.__c[1] * 255) << 8) |
                        Math.round(this.__c[2] * 255));
                    pick = $.colorPicker(hex);
                }
            } catch (e) { pick = null; }

            if (pick === null || pick === undefined || pick < 0) {
                var s = prompt("输入十六进制颜色（如 FFFFFF）", rgbToHex(this.__c));
                if (s === null) { return; }
                var v = hexToRgb(s);
                if (!v) { notice("颜色格式不对，示例：FFFFFF 或 #FF0000"); return; }
                this.__c = v;
            } else {
                if (typeof pick === "string") {
                    var v2 = hexToRgb(pick);
                    if (v2) { this.__c = v2; }
                } else {
                    var n = Number(pick);
                    if (n > 0xFFFF) {
                        this.__c = [((n >> 16) & 0xFF) / 255, ((n >> 8) & 0xFF) / 255, (n & 0xFF) / 255];
                    } else {
                        this.__c = [((n >> 8) & 0xF) / 15, ((n >> 4) & 0xF) / 15, (n & 0xF) / 15];
                    }
                }
            }
            this.notify("onDraw");
        };
        return btn;
    }

    function rgbToHex(c) {
        function h(v) {
            var n = Math.round(U.clamp(v, 0, 1) * 255);
            var s = n.toString(16).toUpperCase();
            return s.length < 2 ? "0" + s : s;
        }
        return h(c[0]) + h(c[1]) + h(c[2]);
    }

    function hexToRgb(text) {
        var s = U.trim(text).replace(/^#/, "");
        if (/^[0-9a-fA-F]{6}$/.test(s)) {
            return [parseInt(s.substr(0, 2), 16) / 255, parseInt(s.substr(2, 2), 16) / 255,
                parseInt(s.substr(4, 2), 16) / 255];
        }
        if (/^[0-9a-fA-F]{3}$/.test(s)) {
            return [parseInt(s.substr(0, 1) + s.substr(0, 1), 16) / 255,
                parseInt(s.substr(1, 1) + s.substr(1, 1), 16) / 255,
                parseInt(s.substr(2, 1) + s.substr(2, 1), 16) / 255];
        }
        return null;
    }

    /* ================================================================== 提示 */

    /**
     * 所有给用户看的消息都从这里走。
     *
     * 为什么要绕一层：headless 自动化测试要驱动这些函数，而 ExtendScript 的
     * alert() 是**模态**的 —— 弹出来没人点，整个脚本就永远卡在那里，
     * 命令行跑自检会直接挂死。测试时把 SILENT 置 true，消息只记录不弹窗。
     */
    var SILENT = false;

    function notice(msg, isError) {
        S.lastNotice = msg;
        if (isError) { S.lastError = msg; }
        if (!SILENT) {
            try { alert(msg); } catch (e) { }
        }
    }

    function askYesNo(msg) {
        if (SILENT) { return true; }
        try { return confirm(msg); } catch (e) { return false; }
    }

    /* ================================================================== 状态栏 */

    function setStatus(text, isError) {
        if (!R.status) { return; }
        R.status.text = text;
        try {
            R.status.graphics.backgroundColor = R.status.graphics.newBrush(
                R.status.graphics.BrushType.SOLID_COLOR,
                isError ? [0.75, 0.2, 0.2, 1] : [0.2, 0.5, 0.25, 1]
            );
        } catch (e) { }
        repaint();
    }

    function getSelectedComp() {
        if (!app.project) { return null; }
        if (R.compList && R.compList.selection && S.comps && S.comps.length > 0) {
            var idx = R.compList.selection.index;
            if (idx >= 0 && idx < S.comps.length) { return S.comps[idx].comp; }
        }
        var ai = app.project.activeItem;
        return (ai && ai instanceof CompItem) ? ai : null;
    }

    /* ================================================================== 导入页逻辑 */

    function refreshComps() {
        if (!R.compList) { return; }
        R.compList.removeAll();
        S.comps = LY.listComps();
        for (var i = 0; i < S.comps.length; i++) {
            R.compList.add("item", (i + 1) + ". " + S.comps[i].name);
        }
        if (S.comps.length === 0) {
            R.compList.add("item", "（当前项目没有合成）");
            R.compList.selection = 0;
            return;
        }
        var ai = app.project ? app.project.activeItem : null;
        var sel = 0;
        for (var j = 0; j < S.comps.length; j++) {
            if (S.comps[j].comp === ai) { sel = j; break; }
        }
        R.compList.selection = sel;
        updatePositionHint();
    }

    function updatePositionHint() {
        var comp = getSelectedComp();
        if (!comp || !R.posHint) { return; }
        R.posHint.text = "合成：" + comp.width + "\u00D7" + comp.height +
            "，" + comp.frameRate.toFixed(2) + "fps，时长 " + comp.duration.toFixed(1) + "s，" +
            comp.numLayers + " 个图层";
    }

    function collectFrameOptions() {
        var o = L.defaultFrameOptions();
        o.defaultDuration = U.toNumber(R.defaultDur.text, 2);
        o.gap = U.toNumber(R.gap.text, 0.02);
        o.minDuration = U.toNumber(R.minDur.text, 0.3);
        o.maxDuration = U.toNumber(R.maxDur.text, 0);
        o.startOffset = U.toNumber(R.offset.text, 0);
        o.leadIn = U.toNumber(R.leadIn.text, 0);
        o.leadOut = U.toNumber(R.leadOut.text, 0);
        o.mergeTolerance = U.toNumber(R.mergeTol.text, 0.02);
        o.untimedMode = "mergePrev";
        o.bilingualLayout = (R.biLayout.selection && R.biLayout.selection.index === 1) ? "sameLine" : "stack";
        o.bilingualOrder = (R.biOrder.selection && R.biOrder.selection.index === 1) ? "BA" : "AB";
        /* 「同一行」排版下原文已经和译文拼成一行文本了，没有第二行可拆 */
        o.splitLines = splitDiLayerOn() || R.splitLines.value;
        return o;
    }

    /** 「双语图层」下拉是不是选了「各一个图层」 */
    function splitDiLayerOn() {
        return !!(R.biLayer && R.biLayer.selection && R.biLayer.selection.index === 1 &&
            R.biLayout.selection && R.biLayout.selection.index !== 1);
    }

    /** 双语行距的实际像素值（0 = 自动：字号 × 1.25，跟 LY.subStep 保持一致） */
    function dualStepPx() {
        var s = R.lineStep ? U.toNumber(R.lineStep.text, 0) : 0;
        if (s > 0) { return s; }
        var fs = R.fontSize ? U.toNumber(R.fontSize.text, 60) : 60;
        return fs * 1.25;
    }

    /** ④ 里那句「双语图层」的说明：把会用到的数字直接摊开 */
    function updateDualHint() {
        if (!R.biLayerInfo) { return; }
        if (R.biLayout.selection && R.biLayout.selection.index === 1) {
            R.biLayerInfo.text = "「同一行」排版下原文已经和译文拼成一行文本，没有第二行可拆。";
            return;
        }
        if (splitDiLayerOn()) {
            R.biLayerInfo.text = "一句歌词＝2 个文字图层，时间码相同，上下错开 " +
                Math.round(dualStepPx()) + "px（以 Y=" + (R.posY ? R.posY.text : "900") +
                " 为中心）；顺序：原文→译文→下一句原文→下一句译文。";
        } else {
            R.biLayerInfo.text = "原文译文写在同一个图层里，用换行分隔（一个时间码一个图层）。";
        }
    }

    function parseCurrent() {
        var text = R.lyricText.text || "";
        var opt = collectFrameOptions();
        var warnings = [];

        if (U.trim(text) === "") {
            S.parsed = null;
            S.frames = null;
            return { ok: false, error: "歌词内容是空的（先用「打开歌词文件…」或「扫描文件夹…」读一个进来）" };
        }

        if (S.translated && R.hasTrans.value) {
            S.parsed = L.pairBilingual(text, S.translated, {
                matchTolerance: U.toNumber(R.matchTol.text, 0.6)
            });
        } else {
            /* parseAuto：同一段文本可能是 SRT / ASS / VTT，认出来就走那边的
             * 解析器（自带结束时间、ASS 还带样式表），认不出来才当 LRC 处理 */
            S.parsed = L.parseAuto(text, { group: "A" });
        }

        warnings = S.parsed.warnings ? S.parsed.warnings.slice(0) : [];
        S.frames = L.buildFrames(S.parsed, opt);
        if (S.frames.length === 0) {
            return { ok: false, error: "没有解析出任何字幕行：LRC 要有 [00:12.34] 这种时间码，SRT / VTT 要有 00:00:01,000 --> 00:00:03,000，ASS 要有 Dialogue: 行。" };
        }
        return { ok: true, warnings: warnings };
    }

    function doPreview() {
        var res = parseCurrent();
        if (!res.ok) {
            R.previewList.removeAll();
            R.previewInfo.text = res.error;
            setStatus("解析失败：" + res.error, true);
            return false;
        }

        R.previewList.removeAll();
        var limit = Math.min(S.frames.length, 600);
        for (var i = 0; i < limit; i++) {
            var fr = S.frames[i];
            var t = U.formatTimecode(fr.start, false) + "\u2192" + U.formatTimecode(fr.end, false);
            var txt = String(fr.text).replace(/\r/g, " | ");
            if (txt.length > 60) { txt = txt.substring(0, 60) + "\u2026"; }
            R.previewList.add("item", "#" + U.pad(i + 1, 3) + "  " + t + "  " + txt);
        }

        var st = L.stats(S.frames);
        var multi = L.countMultiLineFrames(S.frames);
        var info = S.frames.length + " 条字幕";
        if (limit < S.frames.length) { info += "（列表只显示前 " + limit + " 条）"; }
        info += "；" + U.formatTimecode(st.first, false) + " ~ " + U.formatTimecode(st.last, false);
        info += "；单条 " + st.shortest.toFixed(2) + "s ~ " + st.longest.toFixed(2) + "s";
        if (multi > 0) { info += "；" + multi + " 条为多行（双语）"; }
        if (res.warnings && res.warnings.length > 0) { info += "；" + res.warnings.join("，"); }
        if (S.parsed && S.parsed.meta && S.parsed.meta.ti) { info += "；标题：" + S.parsed.meta.ti; }
        R.previewInfo.text = info;
        updateReverseHint();
        setStatus("解析完成：" + info);
        return true;
    }

    /**
     * 倒序开关旁边那句提示。
     * 光说「倒序」有点抽象，直接把「最上层会是哪一句」摆出来最好懂。
     */
    function updateReverseHint() {
        if (!R.reverseHint) { return; }
        if (!S.frames || S.frames.length === 0) { R.reverseHint.text = ""; return; }
        function clipText(s) {
            var t = String(s || "").replace(/\r/g, " | ");
            return t.length > 12 ? (t.substring(0, 12) + "\u2026") : t;
        }
        var first = clipText(S.frames[0].text);
        var last = clipText(S.frames[S.frames.length - 1].text);
        R.reverseHint.text = R.optReverse.value
            ? ("最上层会是「" + last + "」")
            : ("最上层是「" + first + "」");
    }

    function collectLayerOptions() {
        var o = LY.defaultOptions();
        o.fontSize = U.toNumber(R.fontSize.text, 60);
        o.fontPostScript = (S.fontMap && R.fontList.selection)
            ? (S.fontMap[R.fontList.selection.index] || "") : "";
        o.fillColor = R.colorFill.__c;
        o.applyStroke = R.strokeOn.value;
        o.strokeColor = R.colorStroke.__c;
        o.strokeWidth = U.toNumber(R.strokeWidth.text, 2);
        o.justification = ["center", "left", "right"][R.justify.selection ? R.justify.selection.index : 0];
        o.targetX = U.toNumber(R.posX.text, 960);
        o.targetY = U.toNumber(R.posY.text, 900);
        o.autoCenter = R.autoCenter.value;
        o.vertical = R.vertical.value;
        o.verticalDirection = (R.vertical.value && R.verticalDir.selection &&
            R.verticalDir.selection.index === 1) ? "ltr" : "rtl";
        o.leadingRatio = U.toNumber(R.leadingRatio.text, 0);
        o.verticalLeadingRatio = U.toNumber(R.vLeadingRatio.text, 1.0);
        o.tracking = U.toNumber(R.tracking.text, 0);
        o.layerNameMode = ["text", "index", "index+text"][R.layerName.selection ? R.layerName.selection.index : 0];
        o.labelIndex = R.labelList.selection ? R.labelList.selection.index : 0;
        o.lineStep = R.lineStep ? U.toNumber(R.lineStep.text, 0) : 0;
        o.reverse = !!(R.optReverse && R.optReverse.value);
        return o;
    }

    /* ------------------------------------------------------- 动画预设相关 */

    /** 填「内置预设 + 扫到的 .ffx」进下拉框 */
    function refreshPresets() {
        if (!R.presetList) { return; }
        S.presetItems = [];
        var names = [];
        var i;

        for (i = 0; i < PR.BUILTIN.length; i++) {
            S.presetItems.push({ kind: "builtin", id: PR.BUILTIN[i].id, name: PR.BUILTIN[i].name, tip: PR.BUILTIN[i].tip });
            names.push(PR.BUILTIN[i].name);
        }

        var dirs = PR.defaultDirs();
        var extra = loadSetting("presetDir", "");
        if (extra) { dirs.push(extra); }
        var ffx = PR.scanFFX(dirs, 2);
        if (ffx.length > 0) {
            for (i = 0; i < ffx.length; i++) {
                S.presetItems.push({ kind: "ffx", path: ffx[i].path, name: "[ffx] " + ffx[i].name, tip: ffx[i].path });
                names.push("[ffx] " + ffx[i].name);
            }
        }

        R.presetList.removeAll();
        for (i = 0; i < names.length; i++) { R.presetList.add("item", names[i]); }
        if (names.length > 0) { R.presetList.selection = 0; }

        R.presetInfo.text = "内置预设 " + PR.BUILTIN.length + " 个，扫到 .ffx " + ffx.length + " 个。\n" +
            "扫描目录：" + dirs.join(" / ");
        return ffx.length;
    }

    /**
     * 刷新「⑦ 模板图层」下拉框：列出当前合成里所有可以当模板的文字图层。
     * 第 0 项是「（不使用 —— 用样式新建）」，保持和以前一样的行为。
     */
    function refreshTemplateLayers() {
        if (!R.tplList) { return; }
        S.tplLayers = [];
        var names = ["（不使用 —— 按排版样式新建）"];
        var comp = null;
        try { comp = getSelectedComp(); } catch (eC) { }
        if (comp) {
            for (var i = 1; i <= comp.numLayers; i++) {
                var L = null;
                try { L = comp.layer(i); } catch (eL) { continue; }
                if (!(L instanceof TextLayer)) { continue; }
                S.tplLayers.push(L);
                names.push("#" + i + " " + L.name);
            }
        }
        var keep = 0;
        if (R.tplList.selection) { keep = R.tplList.selection.index; }
        R.tplList.removeAll();
        for (var j = 0; j < names.length; j++) { R.tplList.add("item", names[j]); }
        R.tplList.selection = (keep < names.length) ? keep : 0;

        if (R.tplInfo) {
            R.tplInfo.text = names.length > 1
                ? ("当前合成里有 " + (names.length - 1) + " 个文字图层可以当模板。\n" +
                    "选一个，生成时就会复制它（图层样式 / 效果 / 动画器全带走），只换文字和时间。")
                : "当前合成里还没有文字图层。先手动做一个满意的样式，再回来选它当模板。";
        }
    }

    /** 取当前选中的模板图层（没选就返回 null） */
    function getTemplateLayer() {
        if (!R.tplList || !R.tplList.selection) { return null; }
        var idx = R.tplList.selection.index;
        if (idx <= 0) { return null; }
        if (!S.tplLayers || idx - 1 >= S.tplLayers.length) { return null; }
        return S.tplLayers[idx - 1];
    }

    function getPresetChoice() {
        if (!R.presetList || !R.presetList.selection) { return null; }
        var idx = R.presetList.selection.index;
        if (!S.presetItems || idx < 0 || idx >= S.presetItems.length) { return null; }
        return S.presetItems[idx];
    }

    /** scope: "sel" | "alltext" */
    function doApplyPreset(scope) {
        try {
            var comp = getSelectedComp();
            if (!comp) { notice("请先选择一个合成。"); return; }
            var choice = getPresetChoice();
            if (!choice || (choice.kind === "builtin" && !choice.id)) {
                notice("先在下拉框里选一个预设。");
                return;
            }

            var layers = [];
            var i;
            if (scope === "sel") {
                for (i = 1; i <= comp.numLayers; i++) {
                    var L = comp.layer(i);
                    if (L.selected) { layers.push(L); }
                }
                if (layers.length === 0) {
                    notice("当前合成里没有选中的图层。\n在时间轴里选中要套用的图层再来点这个按钮。");
                    return;
                }
            } else {
                for (i = 1; i <= comp.numLayers; i++) {
                    var t = comp.layer(i);
                    if (t instanceof TextLayer) { layers.push(t); }
                }
                if (layers.length === 0) { notice("这个合成里没有文字图层。"); return; }
            }

            if (choice.kind === "ffx" && !PR.canApplyPreset(layers[0])) {
                notice("这个 AE 版本的脚本接口没有 layer.applyPreset（需要 CC 2014+），\n" +
                    "只能用内置预设。");
                return;
            }

            setStatus("正在套用预设 0/" + layers.length + "\u2026\u2026");
            repaint();

            var ctx = { errors: [], notes: [] };
            var opts = {
                clearAnimators: R.optPresetClear ? R.optPresetClear.value : true,
                onProgress: function (done, total, name) {
                    if (done % 5 === 0 || done === total) {
                        setStatus("正在套用预设 " + done + "/" + total + "\u2026\u2026");
                        repaint();
                    }
                }
            };

            var res = PR.applyToLayers(layers, choice, opts, ctx);

            var msg = "预设「" + choice.name + "」→ " + res.ok + "/" + res.total + " 个图层";
            setStatus(msg);
            if (res.errors.length > 0) {
                var head = [];
                for (i = 0; i < res.errors.length && i < 6; i++) { head.push(res.errors[i]); }
                notice(msg + "\n\n" + (res.errors.length > 6 ? ("（共 " + res.errors.length + " 条，先列前 6 条）\n") : "") +
                    head.join("\n"));
            } else {
                notice(msg + "\n\n可以撤销（Ctrl+Z）。");
            }
        } catch (e) {
            notice("套用预设失败：" + e.toString());
        }
    }

    /**
     * 生成字幕图层。
     *
     * 整个函数包在 try/catch 里：ScriptUI 的事件处理函数里抛出异常时，
     * 面板往往只是「什么都没发生」，连个红字都不给 —— 用户看到的就是
     * 「点了生成没效果」。所以宁可弹个框，也不能静默失败。
     */
    function doGenerate() {
        try {
            if (!app.project) {
                notice("请先新建或打开一个项目（文件 > 新建 > 新建项目）。");
                return;
            }

            var comp = getSelectedComp();
            if (!comp && R.autoComp.value) {
                var est = S.frames ? (S.frames[S.frames.length - 1].end + 2) : 60;
                comp = LY.createComp({
                    name: (S.parsed && S.parsed.meta && S.parsed.meta.ti)
                        ? ("字幕_" + S.parsed.meta.ti) : "字幕合成",
                    duration: est
                });
                refreshComps();
                setStatus("已自动新建合成：" + comp.name);
            }
            if (!comp) {
                notice("没有可用的目标合成。\n请在「② 目标合成」里选一个，或勾上「没有合成时自动新建」。");
                return;
            }

            /* 先解析。解析失败要把话说清楚，别让用户以为是「生成」坏了。 */
            if (!doPreview()) {
                notice("生成中断：歌词还没解析成功。\n" + (R.previewInfo ? R.previewInfo.text : ""));
                return;
            }

            /* 合成太短的话，后面的字幕会落在合成范围外（看不见） */
            var need = S.frames[S.frames.length - 1].end;
            if (need > comp.duration + 0.05) {
                var want = Math.ceil(need + 1);
                if (askYesNo("歌词总长 " + need.toFixed(2) + " 秒，但合成「" + comp.name +
                    "」只有 " + comp.duration.toFixed(2) + " 秒。\n\n" +
                    "后面的字幕会落在合成时长之外，看不到。\n" +
                    "要把合成加长到 " + want + " 秒吗？（确定＝加长，取消＝不动）")) {
                    try {
                        app.beginUndoGroup("加长字幕合成");
                        comp.duration = want;
                        app.endUndoGroup();
                        setStatus("合成已加长到 " + want + " 秒");
                    } catch (eDur) { }
                }
            }

            setStatus("正在生成 " + S.frames.length + " 个图层\u2026\u2026");
            repaint();

            var lo = collectLayerOptions();
            var tpl = getTemplateLayer();
            var layers = null;
            var tplRep = null;

            if (tpl) {
                /* ---- 模板模式：直接复制现有图层（Ctrl+D 式） ----
                 * duplicate() 由 AE 内部完成，图层样式/效果/动画器/蒙版/表达式
                 * 全都原样带过去 —— 这是唯一能把「图层样式」也搬走的办法。
                 * 只改文字 + 入点出点 + 关键帧对时。 */
                setStatus("正在以模板复制 " + S.frames.length + " 个图层\u2026\u2026");
                repaint();
                var tr = LY.createFromTemplate(comp, tpl, S.frames, {
                    reverse: lo.reverse,
                    layerNameMode: R.optTplName && R.optTplName.value ? lo.layerNameMode : null,
                    hideTemplate: R.optTplHide ? R.optTplHide.value : true,
                    remapMode: (R.remapMode && R.remapMode.selection)
                        ? ["scale", "shift", "none"][R.remapMode.selection.index] : "scale",
                    onProgress: function (done, total) {
                        if (done > 0 && done % 10 !== 0 && done < total) { return; }
                        setStatus("正在复制 " + done + "/" + total + "\u2026\u2026");
                        repaint();
                    }
                });
                layers = tr.layers;
                tplRep = tr.report;
            } else {
                layers = LY.createTextLayers(comp, S.frames, lo);
            }
            S.lastLayers = layers;

            /* 让用户「看得见结果」：把合成调到前台并选中刚生成的图层。
             * 之前只写状态栏，用户很容易以为没生效。 */
            try { comp.openInViewer(); } catch (eV) { }
            try {
                for (var i = 0; i < layers.length; i++) { layers[i].selected = true; }
            } catch (eSel) { }

            var msg = "已在「" + comp.name + "」生成 " + layers.length + " 个文字图层";
            if (tpl) {
                msg += "（复制自模板「" + tpl.name + "」";
                if (tplRep && tplRep.remapped > 0) { msg += "，关键帧对时 " + tplRep.remapped + " 个"; }
                msg += "）";
            }
            if (lo.reverse) { msg += "（倒序：最后一句在最上层）"; }
            if (tplRep && tplRep.errors.length > 0) {
                msg += "；有 " + tplRep.errors.length + " 条报错：" + tplRep.errors[0];
            }

            /* 生成后顺手套用动画预设（⑥ 里勾了才会做）。
             * 注意要在预合成**之前**套：打包进预合成之后图层就换了个合成，不好再改。 */
            if (R.optPresetOnGen && R.optPresetOnGen.value && layers.length > 0) {
                var pchoice = getPresetChoice();
                if (pchoice && pchoice.kind === "builtin" && pchoice.id) {
                    setStatus("正在套用预设 0/" + layers.length + "\u2026\u2026");
                    repaint();
                    var pctx = { errors: [], notes: [] };
                    var pres = PR.applyToLayers(layers, pchoice, { clearAnimators: false }, pctx);
                    msg += "，并套用预设「" + pchoice.name + "」（" + pres.ok + "/" + pres.total + "）";
                    if (pctx.errors.length > 0) {
                        msg += "，有 " + pctx.errors.length + " 条报错：" + pctx.errors[0];
                    }
                } else if (pchoice && pchoice.kind === "ffx") {
                    setStatus("正在套用 .ffx 预设 0/" + layers.length + "\u2026\u2026");
                    repaint();
                    var fctx = { errors: [], notes: [] };
                    var fres = PR.applyToLayers(layers, pchoice, { clearAnimators: false }, fctx);
                    msg += "，并套用 .ffx「" + pchoice.name + "」（" + fres.ok + "/" + fres.total + "）";
                }
            }

            if (R.precompose.value && layers.length > 0) {
                var pc = LY.precompose(comp, layers, "字幕");
                if (pc) { msg += "，并已打包为预合成「" + pc.name + "」"; }
            }
            setStatus(msg);
            R.previewInfo.text = msg + "。\n图层名就是歌词文本本身，可在合成里直接看到。";
            refreshRefLayers();
            if (tpl) { refreshTemplateLayers(); }
        } catch (e) {
            var detail = e.toString();
            try { if (e.line !== undefined) { detail += "（第 " + e.line + " 行）"; } } catch (x) { }
            setStatus("生成失败：" + detail, true);
            notice("生成失败：\n" + detail);
        }
    }

    /* ================================================================== 文件读取 */

    /** 把读到的文本灌进编辑框并预览 */
    function loadLyricText(text, label, encName) {
        R.lyricText.text = text;
        clearTranslation();
        S.lyricFile = label;
        setStatus("已读取 " + label + "（" + encName + "，" +
            text.split("\n").length + " 行）");
        doPreview();
    }

    /**
     * 读一个歌词文件。
     * 返回 { ok, encoding, lines, error }，方便自动化测试判断；
     * 失败时的提示要说清「怎么办」（选 GBK 再试），而不是只说一句「失败」。
     */
    function readLyricFile(path, name) {
        var enc = R.encodingList.selection ? R.encodingList.selection.text : "自动";
        var r = null;
        try {
            r = U.readTextAuto(path, enc);
        } catch (e) {
            notice("读取失败：" + e.toString() +
                "\n\n如果这是 GBK 编码的老文件，请在「编码」里选 GBK 再试一次。", true);
            return { ok: false, error: "读取异常：" + e.toString() };
        }
        if (!r.ok || U.trim(r.text) === "") {
            notice("这个文件的编码识别不了：" + name +
                "\n\n请在「编码」下拉框里手动选 GBK / GB2312 / BIG5 再试一次。", true);
            return { ok: false, error: "编码识别失败（" + r.encoding + "）" };
        }
        loadLyricText(r.text, name, r.encoding);
        return { ok: true, encoding: r.encoding, lines: r.text.split("\n").length };
    }

    function doOpenFile() {
        try {
            /* 过滤器用 ExtendScript 文档里的「描述:模式」格式（冒号 + 逗号分隔），
             * 并显式写上 *lrc* 通配 —— 这样「《仙剑》主题曲-《少年情》lrc」
             * 这种文件名里带 lrc 但没有扩展名的文件也能看见。 */
            var lastDir = loadSetting("lastDir", "");
            var filter = "歌词/字幕 (*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt):*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt;*lrc*," +
                "全部文件 (*.*):*.*";
            var f = null;
            try {
                f = File.openDialog("选择歌词/字幕文件（.lrc / .srt / .ass / .vtt / .txt，或者文件名里带 lrc 的文件）", filter);
            } catch (eF) {
                /* 少数 AE 版本对过滤器格式挑剔，退化成不过滤 */
                f = File.openDialog("选择歌词/字幕文件（已列出全部文件）");
            }
            if (!f) { return; }

            saveSetting("lastDir", f.parent ? f.parent.fsName : "");
            readLyricFile(f.fsName, f.name);
        } catch (e) {
            setStatus("打开文件失败：" + e.toString(), true);
            notice("打开文件失败：" + e.toString());
        }
    }

    /**
     * 扫描一个文件夹里的歌词文件。
     *
     * 为什么要有这个：只靠文件对话框的扩展名过滤，遇到「没有 .lrc 后缀」
     * 或者「后缀写成别的」的歌词就会漏掉。这里改成按内容判断 ——
     * 只要文件里有 [00:12.34] 这种时间码（不管 UTF-8 还是 GBK，
     * 那些字符都是 ASCII），就算歌词。
     *
     * @param presetFolder 测试用：直接指定文件夹，跳过选择框。
     * @return 找到的候选数组（同时也填进下拉框）
     */
    function doScanFolder(presetFolder) {
        try {
            var folder = presetFolder || null;
            if (!folder) {
                var startDir = null;
                var last = loadSetting("lastDir", "");
                if (last !== "") {
                    try { startDir = new Folder(last); } catch (e0) { startDir = null; }
                }
                folder = Folder.selectDialog("选择存放歌词的文件夹（会自动找出里面的歌词文件）", startDir);
            }
            if (!folder) { return null; }

            saveSetting("lastDir", folder.fsName);

            var all = folder.getFiles();
            var hits = [];
            for (var i = 0; i < all.length; i++) {
                var item = all[i];
                if (!(item instanceof File)) { continue; }
                if (item.name.charAt(0) === ".") { continue; }
                var byName = U.looksLikeLyricsName(item.name);
                var byContent = U.sniffLyricsFile(item.fsName);
                if (byName || byContent) {
                    hits.push({
                        path: item.fsName,
                        name: item.name,
                        lrc: byContent,
                        size: item.length
                    });
                }
            }

            /* 按内容确认过的排前面，读起来更靠谱 */
            hits.sort(function (a, b) {
                if (a.lrc === b.lrc) { return a.name < b.name ? -1 : 1; }
                return a.lrc ? -1 : 1;
            });

            S.folderFiles = hits;
            R.fileList.removeAll();
            for (var j = 0; j < hits.length; j++) {
                R.fileList.add("item", hitLabel(hits[j]));
            }

            if (hits.length === 0) {
                R.fileList.add("item", "（这个文件夹里没找到歌词文件）");
                R.fileList.selection = 0;
                setStatus("扫描完成：" + folder.fsName + " 里没有找到歌词文件", true);
                notice("这个文件夹里没找到歌词/字幕文件：\n" + folder.fsName +
                    "\n\n判断依据是文件名带 lrc 或后缀是 .lrc / .srt / .ass / .ssa / .vtt，"
                    + "或者内容里有 [00:12.34] 这种 LRC 时间码、00:00:01,000 --> 00:00:03,000 这种 SRT 时间码。");
                return hits;
            }
            R.fileList.selection = 0;
            setStatus("扫描完成：找到 " + hits.length + " 个歌词文件，选中第 1 个");
            return hits;
        } catch (e) {
            setStatus("扫描文件夹失败：" + e.toString(), true);
            notice("扫描文件夹失败：" + e.toString(), true);
            return null;
        }
    }

    function hitLabel(h) {
        var tag = h.lrc ? "[歌词]" : "[按名字]";
        var kb = Math.round(h.size / 1024);
        return tag + " " + h.name + "   " + (kb < 1 ? h.size + " B" : kb + " KB");
    }

    function doLoadScanned() {
        try {
            if (!S.folderFiles || !R.fileList.selection) {
                notice("还没有扫描结果。先点「扫描文件夹…」。");
                return;
            }
            var idx = R.fileList.selection.index;
            if (idx < 0 || idx >= S.folderFiles.length) { return; }
            var info = S.folderFiles[idx];
            readLyricFile(info.path, info.name);
        } catch (e) {
            setStatus("载入失败：" + e.toString(), true);
            notice("载入失败：" + e.toString());
        }
    }

    function doPaste() {
        var txt = "";
        try {
            if ($.os.indexOf("Windows") >= 0) {
                txt = system.callSystem("powershell -NoProfile -Command \"Get-Clipboard -Raw\"");
            } else {
                txt = system.callSystem("/usr/bin/pbpaste");
            }
        } catch (e) { txt = ""; }
        if (txt === null || txt === undefined || U.trim(txt) === "") {
            notice("剪贴板是空的，或者读取失败。可以直接在文本框里粘贴（Ctrl+V）。");
            return;
        }
        loadLyricText(txt, "剪贴板", "按系统编码");
    }

    function clearTranslation() {
        S.translated = "";
        if (R.hasTrans) { R.hasTrans.value = false; }
        if (R.transInfo) { R.transInfo.text = "没有译文"; }
    }

    /* ================================================================== 样式页逻辑 */

    function refreshRefLayers() {
        if (!R.refList) { return; }
        updateIndexHint();
        R.refList.removeAll();
        var comp = getSelectedComp();
        S.refCandidates = comp ? LY.listTextLayers(comp) : [];

        var names = [];
        for (var i = 0; i < S.refCandidates.length; i++) {
            names.push("#" + S.refCandidates[i].index + "  " + S.refCandidates[i].name);
        }
        if (names.length === 0) { names.push("（合成里没有文字图层）"); }

        R.refList.removeAll();
        for (var k = 0; k < names.length; k++) { R.refList.add("item", names[k]); }
        R.refList.selection = 0;

        /* 第二个参考层：第一项是「不用」，所以整体比 refList 多一格 */
        if (R.refList2) {
            R.refList2.removeAll();
            R.refList2.add("item", "（不用 —— 两组都用同一个参考层）");
            for (var m = 0; m < names.length; m++) { R.refList2.add("item", names[m]); }
            R.refList2.selection = 0;
        }
        updateRefInfo();
    }

    /** 第二个参考层（0 = 不用） */
    function getRef2Layer() {
        var comp = getSelectedComp();
        if (!comp || !R.refList2 || !R.refList2.selection || !S.refCandidates) { return null; }
        var i = R.refList2.selection.index - 1;
        if (i < 0 || i >= S.refCandidates.length) { return null; }
        try {
            var l = comp.layer(S.refCandidates[i].index);
            return (l && l !== getRefLayer()) ? l : null;
        } catch (e) { return null; }
    }

    function getRefLayer() {
        var comp = getSelectedComp();
        if (!comp || !R.refList.selection || !S.refCandidates) { return null; }
        var i = R.refList.selection.index;
        if (i < 0 || i >= S.refCandidates.length) { return null; }
        return comp.layer(S.refCandidates[i].index);
    }

    function updateRefInfo() {
        if (!R.refInfo) { return; }
        var ref = getRefLayer();
        if (!ref) { R.refInfo.text = "未选择参考图层"; return; }
        var fx = 0;
        try { fx = ref.property("ADBE Effect Parade").numProperties; } catch (e) { }
        var keys = 0;
        try {
            var tf = ref.property("ADBE Transform Group");
            for (var i = 1; i <= tf.numProperties; i++) { keys += tf.property(i).numKeys; }
        } catch (e2) { }
        R.refInfo.text = "参考：" + ref.name + "（效果 " + fx + " 个，变换关键帧 " + keys + " 个）";
        updateBiInfo();
    }

    /** ③ 那块的说明：把「怎么认分组」「位置怎么处理」说清楚 */
    function updateBiInfo() {
        if (!R.biInfo) { return; }
        var posIdx = (R.biPos && R.biPos.selection) ? R.biPos.selection.index : 1;
        var scopeIdx = (R.biScope && R.biScope.selection) ? R.biScope.selection.index : 0;
        var step = parseFloat(R.biStep ? R.biStep.text : "0");
        if (isNaN(step)) { step = 0; }
        var ref2 = getRef2Layer();

        var t = "认分组：先读图层备注里生成时留的配对标记；没有标记就按文字体系" +
            "（日文带假名 / 中文只有汉字）。";
        if (posIdx === 1) {
            t += "\n位置：抄完后按组内行号错开 " +
                (step > 0 ? (step + "px") : "行距（自动＝字号 × 1.25）") + "，原文在上译文在下。";
        } else if (posIdx === 2) {
            t += "\n位置：完全不参与复制，各层保留自己原来的 X / Y。";
        } else {
            t += "\n⚠ 位置照抄参考层：成对的原文 / 译文会得到同一个 Y，会叠在一起。";
        }
        if (scopeIdx === 1) { t += "\n范围：只处理跟参考层同组的层。"; }
        else if (scopeIdx === 2) { t += "\n范围：只处理另一组。"; }
        if (ref2) { t += "\n另一组照抄第二个参考层「" + ref2.name + "」（不再错位）。"; }
        R.biInfo.text = t;
    }

    /** 扫一遍：把「同组 / 另一组」各多少层摊出来，省得盲选 */
    function scanPairs() {
        if (!R.pairScanInfo) { return; }
        var comp = getSelectedComp();
        var ref = getRefLayer();
        if (!comp || !ref) { notice("请先选好合成和参考图层。"); return; }
        var spec = null;
        try { spec = U.parseIndexSpec(R.indexSpec.text, comp.numLayers); } catch (eP) { spec = null; }
        if (!spec || spec.error) { notice("图层号有误：" + (spec ? spec.error : "")); return; }

        var g = LY.scanGroups(comp, spec.list, ref);
        R.pairScanInfo.text = g.total + " 层里：同组 " + g.same + " / 另一组 " + g.other;
        var t = "参考层判定为「" + LY.detectScript(LY.getLayerText(ref)) + "」。";
        if (g.total > 0 && g.same > 0 && g.other === 0) {
            t += "\n⚠ 没认出第二组：目标里全是和参考层同类的文字。";
        }
        if (g.sampleSame.length > 0) { t += "\n同组举例：" + g.sampleSame.join(" / "); }
        if (g.sampleOther.length > 0) { t += "\n另一组举例：" + g.sampleOther.join(" / "); }
        R.biInfo.text = t;
        setStatus("扫描完成：同组 " + g.same + " 层 / 另一组 " + g.other + " 层");
    }

    /**
     * 「应用到哪些图层」那块儿的实时提示。
     *
     * 之前只有一个冰冷的「已处理 41 个（2-42）」，用户根本判断不了这是不是全部
     * —— 还得自己数合成里到底有几层。所以这里把「总共几层 / 覆盖几个 /
     * 漏了哪几层」直接摊开，再配一个「全部」按钮一键填满。
     */
    function updateIndexHint() {
        if (!R.indexHint) { return; }
        var comp = getSelectedComp();
        if (!comp) { R.indexHint.text = "（还没选到合成）"; return; }

        var total = comp.numLayers;
        var txt = "本合成「" + comp.name + "」共 " + total + " 层";
        var ref = null;
        try { ref = getRefLayer(); } catch (eR) { ref = null; }
        if (ref) { txt += "；参考图层是第 " + ref.index + " 层"; }

        var spec = null;
        try { spec = U.parseIndexSpec(R.indexSpec.text, total); } catch (eP) { spec = null; }
        if (spec && !spec.error && spec.list && spec.list.length > 0) {
            var inList = {};
            var i;
            for (i = 0; i < spec.list.length; i++) { inList[spec.list[i]] = true; }
            var missed = [];
            for (i = 1; i <= total; i++) { if (!inList[i]) { missed.push(i); } }

            txt += "；本次覆盖 " + spec.list.length + " 个（" +
                U.formatIndexList(spec.list) + "）";
            txt += missed.length > 0
                ? ("；还有 " + missed.length + " 层没覆盖（" + U.formatIndexList(missed) + "）")
                : "；已覆盖全部图层";
        } else if (spec && spec.error) {
            txt += "；图层号还没填对（" + spec.error + "）";
        }
        R.indexHint.text = txt;
    }

    function pickSelectedLayer() { pickRefLayer("refList", 0); }

    /**
     * 「取当前选中图层」：把时间轴里选中的图层同步到某个参考层下拉框。
     * @param {String} listId  R 里的控件名
     * @param {Number} offset  列表前面的占位项数（refList2 第一项是「不用」，所以是 1）
     */
    function pickRefLayer(listId, offset) {
        var list = R[listId];
        if (!list) { return; }
        var comp = getSelectedComp();
        if (!comp) { return; }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) { notice("请先在合成里选中一个图层。"); return; }
        var target = sel[0];
        var i, j;
        for (i = 0; i < S.refCandidates.length; i++) {
            if (S.refCandidates[i].index === target.index) {
                list.selection = i + offset;
                updateRefInfo();
                return;
            }
        }
        refreshRefLayers();
        for (j = 0; j < S.refCandidates.length; j++) {
            if (S.refCandidates[j].index === target.index) {
                list.selection = j + offset;
                updateRefInfo();
                return;
            }
        }
    }

    /**
     * 读一个图层的「肉眼可见样式」摘要，用来在日志里当证据：
     * 光报「属性项 630」用户根本判断不了到底改没改，得把字号/颜色这种
     * 看得见的东西「同步前 → 同步后」摆出来。
     */
    function readStyleBrief(layer) {
        var out = { ok: false, text: "（读不到）" };
        try {
            var td = layer.property(LY.MATCH.TEXT_PROPERTIES)
                .property(LY.MATCH.TEXT_DOCUMENT).value;
            var col = td.fillColor;
            out.ok = true;
            out.fontSize = td.fontSize;
            out.font = td.font;
            out.color = "[" + col[0].toFixed(2) + "," + col[1].toFixed(2) + "," + col[2].toFixed(2) + "]";
            out.stroke = td.applyStroke ? ("描边" + td.strokeWidth) : "无描边";
            out.text = "字号" + td.fontSize + " 字体" + td.font +
                " 填充" + out.color + " " + out.stroke;
        } catch (e) {
            return out;
        }
        try {
            var tf = layer.property(LY.MATCH.TRANSFORM);
            var sc = tf.property(LY.MATCH.SCALE).value;
            out.text += " 缩放[" + Math.round(sc[0]) + "," + Math.round(sc[1]) + "]";
        } catch (e2) { }
        return out;
    }

    function doApplyStyle() {
        try {
            var comp = getSelectedComp();
            if (!comp) { notice("请先选择一个合成。"); return; }
            var ref = getRefLayer();
            if (!ref) { notice("请先选择参考图层。"); return; }

            var spec = U.parseIndexSpec(R.indexSpec.text, comp.numLayers);
            if (spec.error) { notice("图层号有误：" + spec.error); return; }

            /* 找一个「会被改到的」图层留作证据：优先第一个非参考的文字图层 */
            var sampleIdx = 0, sampleBefore = null, i0;
            for (i0 = 0; i0 < spec.list.length; i0++) {
                var cand = null;
                try { cand = comp.layer(spec.list[i0]); } catch (eL0) { cand = null; }
                if (!cand) { continue; }
                if (cand === ref) { continue; }
                if (R.optOnlyText.value && !(cand instanceof TextLayer)) { continue; }
                sampleIdx = spec.list[i0];
                sampleBefore = readStyleBrief(cand);
                break;
            }

            /* 先盘一下参考层到底「有什么可给的」。
             *
             * 为什么必须这么做：用户实测时日志写着「效果：0」，看着像同步成功了，
             * 实际是 7 个效果一个都没过去 —— 光看结果数字根本分不清
             * 「参考层本来就没有」还是「有但没复制过去」。把参考层的家底先亮出来，
             * 两边一对比，谁漏了立刻现形。 */
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

            /* 同步是阻塞的，先把「正在同步」画出来，否则面板一上来就像死了一样 */
            setStatus("正在同步 0/" + spec.list.length + "\u2026\u2026");
            if (R.styleResult) { R.styleResult.text = "正在同步\u2026\u2026"; }
            repaint();

            var o = ST.defaultOptions();
            o.textStyle = R.optTextStyle.value;
            o.keepText = !R.optCopyText.value;
            o.transform = R.optTransform.value;
            o.effects = R.optEffects.value;
            o.masks = R.optMasks.value;
            o.textAnimators = R.optAnimators.value;
            o.layerProps = R.optLayerProps.value;
            o.keyframes = R.optKeyframes.value;
            o.keyframeInterpolation = R.optEase.value;
            o.keyframeEase = R.optEase.value;
            o.expressions = R.optExpressions.value;
            o.values = R.optValues.value;
            o.skipRef = R.optSkipRef.value;
            o.onlyTextLayers = R.optOnlyText.value;

            /* 关键帧对时：抄过去的关键帧原本是参考层的绝对时间，不动的话
             * 动画会落在目标图层的可见范围之外（用户报的「效果过去了但关键帧位置不对」）。*/
            var rmSel = R.remapMode && R.remapMode.selection ? R.remapMode.selection.index : 0;
            o.remapMode = ["scale", "shift", "none"][rmSel];
            o.remapKeys = (o.remapMode !== "none");

            /* ---- 双语图层 ----
             * 默认「保留上下错位」：不然成对的原文/译文会被抄成同一个 Y、叠在一起。 */
            var biScope = (R.biScope && R.biScope.selection) ? R.biScope.selection.index : 0;
            var biPosIdx = (R.biPos && R.biPos.selection) ? R.biPos.selection.index : 1;
            o.biScope = ["all", "same", "other"][biScope];
            o.biPos = ["follow", "stagger", "keep"][biPosIdx];
            o.biStep = (R.biStep && parseFloat(R.biStep.text) > 0) ? parseFloat(R.biStep.text) : 0;
            o.refLayer2 = getRef2Layer();

            /* 一层层报进度：主线程被占满时 ScriptUI 不重绘，不手动 update()
             * 面板看上去就是卡死，等缓过来窗口还可能被推到后台（用户说的「面板消失了」）。*/
            o.onProgress = function (done, total, name) {
                if (done > 0 && done % 5 !== 0 && done < total) { return; }
                var msg = "正在同步 " + done + "/" + total +
                    (name ? ("（" + name + "）") : "");
                setStatus(msg + "\u2026\u2026");
                if (R.styleResult) { R.styleResult.text = msg + "\u2026\u2026"; }
                repaint();
            };

            var report = ST.applyToLayers(comp, ref, spec.list, o);

            var sampleAfter = null;
            if (sampleIdx > 0) {
                try { sampleAfter = readStyleBrief(comp.layer(sampleIdx)); }
                catch (eS0) { sampleAfter = null; }
            }

            var lines = [];
            /* 光说「处理了 41 个」用户判断不了是不是全部，所以把总数和漏掉的都列出来 */
            var covered = {};
            var ci;
            for (ci = 0; ci < spec.list.length; ci++) { covered[spec.list[ci]] = true; }
            var missedIdx = [];
            for (ci = 1; ci <= comp.numLayers; ci++) { if (!covered[ci]) { missedIdx.push(ci); } }

            lines.push("本合成共 " + comp.numLayers + " 层；图层号指定 " + spec.list.length +
                " 个（" + U.formatIndexList(spec.list) + "）");
            if (missedIdx.length > 0) {
                lines.push("⚠ 有 " + missedIdx.length + " 层不在图层号里，没被处理：" +
                    U.formatIndexList(missedIdx) +
                    "　（要全部就点「全部」按钮）");
            } else {
                lines.push("已覆盖全部图层");
            }
            lines.push("参考层 #" + ref.index + "「" + ref.name + "」自带：效果 " + inv.fx +
                " 个" + (inv.fxNames.length > 0 ? ("（" + inv.fxNames.join("、") +
                    (inv.fx > inv.fxNames.length ? "…" : "") + "）") : "") +
                "、文字动画器 " + inv.an + " 个、蒙版 " + inv.mk + " 个");
            lines.push("实际写入：" + report.layers + " 个图层");
            if (report.skipped > 0) { lines.push("跳过：" + report.skipped + " 个（非文字图层 / 参考图层本身 / 锁定）"); }

            /* 双语分组的结果要写在明面上：只看「写入 N 个图层」看不出两组叠没叠 */
            var gg = report.groups || { same: 0, other: 0 };
            if (gg.same > 0 || gg.other > 0) {
                lines.push("双语分组：同组 " + gg.same + " 层 / 另一组 " + gg.other + " 层" +
                    (o.biScope === "all" ? "" : ("（本次只处理「" +
                        (o.biScope === "same" ? "与参考层同组" : "另一组") + "」")));
            }
            if (report.staggered > 0) {
                lines.push("已按组内行号错开：" + report.staggered + " 层");
            }
            if (o.biPos === "follow" && gg.same > 0 && gg.other > 0) {
                lines.push("⚠ 认出两组，但「双语位置」是照抄参考层 —— 两组 Y 相同、会叠在一起。" +
                    "改成「保留上下错位」即可。");
            }

            /* 「参考层有、但一个都没过去」是静默失败里最坑的一种，单独点名 */
            if (inv.fx > 0 && report.effects === 0) {
                lines.push("⚠ 参考层有 " + inv.fx + " 个效果，却一个都没复制过去 —— " +
                    (o.effects ? "看下面有没有报错（多半是 addProperty 失败了）"
                        : "因为「效果（整条特效栈）」这个选项没勾选"));
            }
            if (inv.an > 0 && report.animators === 0) {
                lines.push("⚠ 参考层有 " + inv.an + " 个文字动画器，却一个都没复制过去 —— " +
                    (o.textAnimators ? "看下面有没有报错"
                        : "因为「文字动画器」这个选项没勾选"));
            }
            if (inv.mk > 0 && report.masks === 0) {
                lines.push("⚠ 参考层有 " + inv.mk + " 个蒙版，却一个都没复制过去 —— " +
                    (o.masks ? "看下面有没有报错" : "因为「蒙版」这个选项默认不勾，要就勾上"));
            }
            if (inv.layerStyles > 0) {
                lines.push("⚠ 参考层还有 " + inv.layerStyles +
                    " 个「图层样式」（投影 / 描边 / 外发光 / 斜面…）：属性逐个深拷贝这一招对" +
                    "图层样式不好使，这一块同步不了，不是漏了。");
                lines.push("　要连图层样式一起搬：选中参考层 → 菜单「动画 > 将动画预设另存为」存成 .ffx，" +
                    "再到「歌词导入」页 ⑥ 里选它套过去。");
                lines.push("　只想要描边的话，改成「文字属性 → 描边」或「效果 → 生成 → 描边」（这两样能同步）。");
            }
            lines.push("属性项：" + report.props + "，效果：" + report.effects +
                "，蒙版：" + report.masks + "，文字动画器：" + report.animators +
                "，文字样式项：" + report.textStyles +
                "，关键帧对时：" + report.remapped + " 个" +
                (report.ms > 0 ? ("（耗时 " + (report.ms / 1000).toFixed(1) + " 秒）") : ""));

            /* 实证：把「同步前 → 同步后」摆出来。说「处理了 45 个」没用，
             * 得让用户一眼看出字号/颜色真的变了 —— 没变就是没变，别猜。 */
            if (sampleIdx > 0 && sampleBefore && sampleAfter && sampleBefore.ok && sampleAfter.ok) {
                var same = (sampleBefore.text === sampleAfter.text);
                lines.push((same ? "⚠ " : "✓ ") + "第 " + sampleIdx + " 层实测：" +
                    sampleBefore.text + "  →  " + sampleAfter.text);
                if (same) {
                    lines.push("　（前后完全一样 —— 要么参考层和目标层本来就同款样式，" +
                        "要么这次同步真的没写进去，看下面有没有报错）");
                }
            }
            if (report.errors.length > 0) {
                lines.push("—— 有 " + report.errors.length + " 条提示 ——");
                for (var i = 0; i < Math.min(report.errors.length, 8); i++) {
                    lines.push("· " + report.errors[i]);
                }
            }
            R.styleResult.text = lines.join("\n");
            updateIndexHint();
            setStatus("样式同步完成：" + report.layers + " 个图层" +
                (missedIdx.length > 0 ? "（还有 " + missedIdx.length + " 层没覆盖）" : ""));
        } catch (e) {
            setStatus("样式同步失败：" + e.toString(), true);
            notice("样式同步失败：" + e.toString());
        }
    }

    /**
     * 「以参考图层重建」—— Ctrl+D 式。
     *
     * 逐属性抄（doApplyStyle）抄不到的东西（图层样式等），用 duplicate() 就能带走，
     * 因为那是 AE 自己在内部复制，不走脚本 API。代价是目标层会被「换掉」，
     * 所以这里先确认一次，并且整个操作压在一个撤销组里，Ctrl+Z 能撤。
     */
    function doRebuildFromRef() {
        try {
            var comp = getSelectedComp();
            if (!comp) { notice("请先选择一个合成。"); return; }
            var ref = getRefLayer();
            if (!ref) { notice("请先选择参考图层。"); return; }

            var spec = U.parseIndexSpec(R.indexSpec.text, comp.numLayers);
            if (spec.error) { notice("图层号有误：" + spec.error); return; }

            /* 第二参考层本身不能被当成目标重建掉 */
            var ref2 = getRef2Layer();

            /* 先收集 Layer 对象：删层会让编号失效，所以绝不能边删边按编号取 */
            var targets = [];
            var names = [];
            for (var i = 0; i < spec.list.length; i++) {
                var L = null;
                try { L = comp.layer(spec.list[i]); } catch (eL) { }
                if (!L || L === ref || (ref2 && L === ref2)) { continue; }
                if (R.optOnlyText.value && !(L instanceof TextLayer)) { continue; }
                targets.push(L);
                if (names.length < 4) { names.push("#" + L.index + " " + L.name); }
            }
            if (targets.length === 0) {
                notice("没有可重建的目标图层（参考层本身会被跳过）。");
                return;
            }

            if (!askYesNo("将用参考图层「" + ref.name + "」复制出 " + targets.length +
                " 个图层，替换掉：\n" + names.join("、") +
                (targets.length > 4 ? " …等" : "") + "\n\n" +
                "每层会保留自己的**文字**和**入点出点**，样式全部换成参考层的。\n" +
                "旧图层会被删除（整个操作可以 Ctrl+Z 撤销）。\n\n继续吗？")) {
                return;
            }

            var rmSel = R.remapMode && R.remapMode.selection ? R.remapMode.selection.index : 0;
            var mode = ["scale", "shift", "none"][rmSel];

            /* 双语：和「应用到目标图层」共用同一组控件（范围 / 位置 / 行距 / 第二参考层） */
            var biScopeIdx = (R.biScope && R.biScope.selection) ? R.biScope.selection.index : 0;
            var biPosIdx = (R.biPos && R.biPos.selection) ? R.biPos.selection.index : 1;
            var biStepPx = (R.biStep && parseFloat(R.biStep.text) > 0) ? parseFloat(R.biStep.text) : 0;

            setStatus("正在重建 0/" + targets.length + "\u2026\u2026");
            if (R.styleResult) { R.styleResult.text = "正在以参考图层重建\u2026\u2026"; }
            repaint();

            var rep = ST.rebuildFromReference(comp, ref, targets, {
                remapMode: mode,
                biScope: ["all", "same", "other"][biScopeIdx],
                biPos: ["follow", "stagger", "keep"][biPosIdx],
                biStep: biStepPx,
                refLayer2: ref2,
                onProgress: function (done, total) {
                    if (done > 0 && done % 5 !== 0 && done < total) { return; }
                    setStatus("正在重建 " + done + "/" + total + "\u2026\u2026");
                    repaint();
                }
            });

            var lines = [];
            lines.push("以参考图层「" + ref.name + "」重建：" + rep.ok + "/" + rep.total + " 个图层");
            lines.push("关键帧对时：" + rep.remapped + " 个（" +
                (mode === "scale" ? "缩放到每层入点出点" : (mode === "shift" ? "整体平移" : "不处理")) + "）");
            if (rep.skipped > 0) { lines.push("跳过：" + rep.skipped + " 个"); }
            /* 双语的结果要写出来：不然「原文译文叠在一起」用户看不出来是哪一步的锅 */
            var gg = rep.groups || { same: 0, other: 0 };
            if (gg.same + gg.other > 0) {
                lines.push("双语分组：与参考层同组 " + gg.same + " 层、另一组 " + gg.other + " 层" +
                    (rep.scopeSkipped > 0 ? ("（本次跳过 " + rep.scopeSkipped + " 层）") : ""));
            }
            if (rep.staggered > 0) { lines.push("已按组内行号错开：" + rep.staggered + " 层"); }
            if (ref2) { lines.push("另一组用的是第二个参考层 #" + ref2.index + "「" + ref2.name + "」"); }
            if (rep.errors.length > 0) {
                lines.push("—— 有 " + rep.errors.length + " 条报错 ——");
                for (var j = 0; j < Math.min(rep.errors.length, 6); j++) {
                    lines.push("· " + rep.errors[j]);
                }
            } else {
                lines.push("文字与入点出点已写回。可 Ctrl+Z 撤销。");
            }
            R.styleResult.text = lines.join("\n");
            setStatus("重建完成：" + rep.ok + " 个图层");
            refreshRefLayers();
            updateIndexHint();
        } catch (e) {
            setStatus("重建失败：" + e.toString(), true);
            notice("重建失败：" + e.toString());
        }
    }

    /* ================================================================== 在线页逻辑 */

    function onSearchProgress(msg) {
        if (R.searchResult) { R.searchResult.text = msg; }
        setStatus(msg);
    }

    function doSearch() {
        try {
            var platform = (R.platform.selection && R.platform.selection.index === 1) ? "qq" : "netease";
            var kw = U.trim(R.keyword.text || "");
            if (kw === "") {
                notice("请先输入歌名、歌手，或者直接粘贴歌曲链接 / 歌曲 ID。");
                try { R.keyword.active = true; } catch (eA) { }
                return;
            }

            R.songList.removeAll();
            S.songs = [];
            setStatus("准备搜索\u2026\u2026");
            R.searchResult.text = "准备请求\u2026\u2026";
            repaint();

            /* 每换一个阶段都会回调，状态栏会一直变 —— 万一卡住，
             * 用户看到的最后一句就是卡在哪一步，而不是干瞪眼「正在搜索」。 */
            ON.onProgress = onSearchProgress;

            var t0 = new Date().getTime();
            setStatus("正在搜索「" + kw + "」\u2026\u2026（网络慢的话最多等 30 秒）");
            repaint();

            var res = ON.search(platform, kw);
            var ms = new Date().getTime() - t0;
            ON.onProgress = null;

            if (!res.ok) {
                setStatus("搜索失败（用时 " + ms + " ms）：" + res.error, true);
                R.searchResult.text = "搜索失败：" + res.error;
                return;
            }

            S.songs = res.songs || [];
            for (var i = 0; i < S.songs.length; i++) {
                var s = S.songs[i];
                var dur = s.duration > 0
                    ? (" " + Math.floor(s.duration / 60) + ":" + U.pad(s.duration % 60, 2)) : "";
                R.songList.add("item", (i + 1) + ". " + s.name + " - " + s.singer +
                    (s.album ? "《" + s.album + "》" : "") + dur);
            }
            R.searchResult.text = "找到 " + S.songs.length + " 首（用时 " + ms +
                " ms，通道：" + (ON.lastTransport || "无") + "）";
            if (S.songs.length === 0) {
                setStatus("搜索完成，但没有结果，换个关键词试试");
            } else {
                setStatus("搜索到 " + S.songs.length + " 首歌曲");
            }
        } catch (e) {
            ON.onProgress = null;
            var detail = e.toString();
            try { if (e.line !== undefined) { detail += "（第 " + e.line + " 行）"; } } catch (x) { }
            setStatus("搜索出错：" + detail, true);
            if (R.searchResult) { R.searchResult.text = "搜索出错：" + detail; }
            notice("搜索出错：\n" + detail);
        }
    }

    function doFetchLyrics() {
        try {
            if (!R.songList.selection) { notice("请先在列表里选一首歌。"); return; }
            var s = S.songs[R.songList.selection.index];
            if (!s) { return; }

            R.lyricPreview.text = "正在获取歌词\u2026\u2026";
            setStatus("正在获取「" + s.name + "」的歌词\u2026\u2026");
            repaint();

            ON.onProgress = onSearchProgress;
            var res = null;
            try {
                res = ON.fetchLyrics(s);
            } catch (e) {
                res = { ok: false, error: e.toString() };
            }
            ON.onProgress = null;

            if (!res.ok) {
                R.lyricPreview.text = "获取失败：" + res.error;
                setStatus("歌词获取失败：" + res.error, true);
                return;
            }

            S.currentSong = s;
            S.currentOriginal = res.original || "";
            S.currentTranslated = res.translated || "";

            var out = [];
            out.push("【" + s.name + " - " + s.singer + "】");
            out.push("歌词通道：" + (ON.lastTransport || "") + "    原文 " +
                S.currentOriginal.split("\n").length + " 行，译文 " +
                (U.trim(S.currentTranslated) === "" ? 0 : S.currentTranslated.split("\n").length) + " 行");
            out.push("");
            out.push("—— 原文 ——");
            out.push(U.trim(S.currentOriginal));
            if (U.trim(S.currentTranslated) !== "") {
                out.push("");
                out.push("—— 译文 ——");
                out.push(U.trim(S.currentTranslated));
            }
            R.lyricPreview.text = out.join("\n");
            setStatus("已获取歌词：" + s.name + "（点「载入歌词导入页」把它带过去）");
        } catch (e) {
            ON.onProgress = null;
            setStatus("获取歌词出错：" + e.toString(), true);
            notice("获取歌词出错：" + e.toString());
        }
    }

    function useLyricsInImport() {
        if (!S.currentOriginal || U.trim(S.currentOriginal) === "") {
            notice("还没有获取到歌词，请先点「获取歌词（含译文）」。");
            return;
        }
        R.lyricText.text = S.currentOriginal;
        S.translated = U.trim(S.currentTranslated) !== "" ? S.currentTranslated : "";
        R.hasTrans.value = (U.trim(S.translated) !== "");
        R.transInfo.text = R.hasTrans.value
            ? ("已载入译文：" + S.translated.split("\n").length + " 行")
            : "没有译文";
        doPreview();
        setStatus("歌词已载入「歌词导入」页，确认没问题后点「生成字幕图层」");
    }

    /* ================================================================== 关于页 */

    function doSelfTest() {
        var lines = [];
        lines.push("=== 版本 ===");
        lines.push("构建 " + versionLine() + "（时间戳 " + BUILD + "）");
        try { lines.push("AE 版本：" + app.version + " / build " + app.buildNumber); }
        catch (e) { lines.push("AE 版本：读取失败"); }
        try { lines.push("脚本引擎：" + $.engineName + "  ExtendScript " + $.version); } catch (e2) { }
        try { lines.push("系统：" + $.os); } catch (e3) { }

        lines.push("");
        lines.push("=== 图层模块 ===");
        try {
            var logs = LY.selfTest();
            for (var i = 0; i < logs.length; i++) { lines.push("· " + logs[i]); }
        } catch (e4) {
            lines.push("· 自检失败：" + e4.toString());
        }

        lines.push("");
        lines.push("=== 在线歌词通道 ===");
        try {
            var t = ON.probeTransport();
            lines.push("· " + t.note);
        } catch (e5) {
            lines.push("· 检测失败：" + e5.toString());
        }
        lines.push("· 点下面的按钮可以真跑一遍搜索并计时");

        lines.push("");
        lines.push("=== 解析器自测 ===");
        try {
            var p = L.parse("[00:01.00]甲\n[00:01.00]乙\n[00:03.00]丙");
            var f = L.buildFrames(p, { gap: 0 });
            lines.push("· LRC 解析：" + p.items.length + " 行 → " + f.length + " 帧（期望 2 帧）");
            lines.push("· 第 1 帧内容：" + f[0].text.replace(/\r/g, " | "));
            var spec = U.parseIndexSpec("1-3,7", 10);
            lines.push("· 图层号解析 1-3,7 → " + U.formatIndexList(spec.list));
        } catch (e6) {
            lines.push("· 自检失败：" + e6.toString());
        }

        R.aboutLog.text = lines.join("\n");
    }

    /** 在线通道体检：真跑一遍搜索并计时，用来定位「一直正在搜索」 */
    function doProbeOnline() {
        var kw = U.trim(R.keyword ? R.keyword.text : "") || "海阔天空";
        R.aboutLog.text = "正在体检（关键词：" + kw + "）……\n请稍候，正常一两秒就好。";
        setStatus("正在体检在线通道\u2026\u2026");
        repaint();
        var lines = [];
        try {
            lines = ON.probeOnline(kw);
        } catch (e) {
            lines = ["体检本身出错：" + e.toString()];
        }
        var head = ["构建 " + versionLine() + "（时间戳 " + BUILD + "）", ""];
        R.aboutLog.text = head.concat(lines).join("\n");
        setStatus("在线通道体检完成，结果见上方文本框");
    }

    /* ================================================================== 界面搭建 */

    UI.build = function () {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "歌词字幕排版工具 · AE 版 · " + versionLine(), undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 6;
        win.margins = 10;

        var tabs = win.add("tabbedpanel");
        tabs.alignChildren = ["fill", "top"];
        tabs.alignment = ["fill", "top"];

        buildImportTab(tabs);
        buildStyleTab(tabs);
        buildOnlineTab(tabs);
        buildAboutTab(tabs);

        /* --- 面板高度 ---
         * AE 的 ScriptUI 面板是**跟着内容长**的，边框拖不动（吸附在界面里时更是如此），
         * 所以这里垫一条可高可矮的空填充条，用「＋/－」调它的高度，
         * 间接把面板撑开 / 收拢。配合①~⑤的折叠，面板长短就完全可控了。 */
        var panelExtraH = U.toNumber(loadSetting("panelH", "0"), 0);
        if (panelExtraH < 0) { panelExtraH = 0; }
        if (panelExtraH > 600) { panelExtraH = 0; }

        R.filler = win.add("group", undefined);
        R.filler.alignment = ["fill", "top"];
        R.filler.preferredSize = [10, panelExtraH];

        function setPanelExtraHeight(h) {
            if (h < 0) { h = 0; }
            if (h > 600) { h = 600; }
            panelExtraH = h;
            saveSetting("panelH", String(h));
            try { if (R.filler) { R.filler.preferredSize = [10, h]; } } catch (eF) { }
            relayout();
            setStatus("面板高度 +" + h + "px", false);
        }

        var bottom = row(win);
        bottom.alignment = ["fill", "bottom"];
        R.status = bottom.add("statictext", undefined, "就绪");
        R.status.characters = 46;
        R.status.alignment = ["fill", "center"];
        R.status.preferredSize.height = 20;

        R.btnPanelShorter = bottom.add("button", undefined, "\u2212");
        R.btnPanelShorter.preferredSize = [26, 20];
        R.btnPanelShorter.helpTip = "面板调矮 60px（面板会自动贴合内容高度，这里是在内容之外额外留白）";
        R.btnPanelTaller = bottom.add("button", undefined, "+");
        R.btnPanelTaller.preferredSize = [26, 20];
        R.btnPanelTaller.helpTip = "面板调高 60px（在内容之外额外留白，折叠分组时不会被吞掉）";
        R.btnPanelShorter.onClick = function () { setPanelExtraHeight(panelExtraH - 60); };
        R.btnPanelTaller.onClick = function () { setPanelExtraHeight(panelExtraH + 60); };

        win.onResizing = win.onResize = function () {
            this.layout.resize();
            /* 尺寸变了之后分组的宽度要重新贴合（折叠状态下高度必须保持 0） */
            refitSections();
        };

        // 初始化数据
        try { refreshComps(); } catch (e1) { }
        try { refreshRefLayers(); } catch (e2) { }
        try { refreshPresets(); } catch (eP) { }
        try { refreshTemplateLayers(); } catch (eT) { }

        if (win instanceof Window) {
            win.center();
            win.show();
        } else {
            win.layout.layout(true);
            win.layout.resize();
        }

        /* 先把所有分组都按「展开」量一遍高度，再套用上次的折叠状态。
         * 顺序反了的话，量到的就是折叠后的 0，展开时撑不回去 —— 这正是
         * 「上次折叠着退出、这次点展开没反应」那个毛病的根因。 */
        try { measureAllSections(); } catch (e3) { }
        try { applySavedStates(); } catch (e5) { }
        try { relayout(); } catch (e4) { }
        try { fitWindowHeight(); } catch (e6) { }

        /* 首屏那一遍经常算不干净（见 runSettleTask 的说明），再兜一次 */
        try { runSettleTask(); } catch (e7) { }

        return win;
    };

    /* ------------------------------------------------------------ 导入页 */

    function buildImportTab(tabs) {
        var tab = tabs.add("tab", undefined, "歌词导入");
        tab.orientation = "column";
        tab.alignChildren = ["fill", "top"];
        tab.spacing = 4;
        tab.margins = 6;

        /* --- 顶部工具条：一键展开 / 一键折叠 / 单开模式 --- */
        var bar = row(tab);
        R.btnExpandAll = bar.add("button", undefined, "全部展开");
        R.btnCollapseAll = bar.add("button", undefined, "全部折叠");

        R.accChk = bar.add("checkbox", undefined, "单开模式");
        R.accChk.value = accordionOn();
        R.accChk.helpTip = "展开一块时自动收起其它块。\n面板没有滚动条，一次只展开一块最省地方。\n关掉它就能同时展开多块。";
        R.accChk.onClick = function () {
            saveSetting("accordion", this.value ? "1" : "0");
            setStatus(this.value
                ? "单开模式：开（展开一块会自动收起其它块）"
                : "单开模式：关（可以同时展开多块）", false);
        };

        bar.add("statictext", undefined, "\u2502");
        R.barHint = lab(bar, "面板会自动贴合内容高度；想再多留点空就用右下角「＋ −」，或直接拉面板边框");
        R.barHint.alignment = ["fill", "center"];

        /* ①~⑤ 直接挂在 tab 下（AE 2023 没有能用的滚动容器，见上方说明） */
        var c = col(tab, 4);
        c.alignment = ["fill", "top"];

        var openLyrics = loadSetting("sec_lyrics", "1") === "1";
        var openComp = loadSetting("sec_comp", "1") === "1";
        var openText = loadSetting("sec_text", "0") === "1";
        var openTime = loadSetting("sec_time", "0") === "1";
        var openOut = loadSetting("sec_out", "1") === "1";
        var openPreset = loadSetting("sec_preset", "0") === "1";
        var openTpl = loadSetting("sec_tpl", "0") === "1";

        /* ============ ① 歌词文本 ============ */
        var s1 = makeSection(c, "lyrics", "① 歌词文本（LRC / 纯文本）", openLyrics);
        var g1 = s1.body;

        R.lyricText = g1.add("edittext", undefined, "", { multiline: true, scrolling: true });
        R.lyricText.preferredSize = [-1, 110];

        var r11 = row(g1);
        R.btnOpenLrc = r11.add("button", undefined, "打开歌词文件\u2026");
        R.btnOpenLrc.preferredSize.width = 130;
        R.btnScanFolder = r11.add("button", undefined, "扫描文件夹\u2026");
        R.btnScanFolder.preferredSize.width = 110;
        R.btnClear = r11.add("button", undefined, "清空");
        lab(r11, "编码");
        R.encodingList = drop(r11, U.ENCODING_LABELS, 90);
        R.encodingList.selection = 0;
        R.btnPaste = r11.add("button", undefined, "从剪贴板粘贴");

        var r12 = row(g1);
        lab(r12, "文件夹里找到的");
        R.fileList = drop(r12, ["（还没有扫描）"], 300);
        R.fileList.alignment = ["fill", "center"];
        R.btnLoadFile = r12.add("button", undefined, "载入选中文件");
        R.btnLoadFile.preferredSize.width = 110;

        var r13 = row(g1);
        R.hasTrans = r13.add("checkbox", undefined, "使用译文（双语）");
        R.hasTrans.value = false;
        lab(r13, "译文对齐容差(秒)");
        R.matchTol = edit(r13, "0.6", 44);
        R.btnClearTrans = r13.add("button", undefined, "清空译文");
        R.transInfo = lab(r13, "没有译文");
        R.transInfo.alignment = ["fill", "center"];

        /* ============ ② 目标合成 ============ */
        var s2 = makeSection(c, "comp", "② 目标合成", openComp);
        var g2 = s2.body;

        var r21 = row(g2);
        lab(r21, "合成");
        R.compList = drop(r21, [], 240);
        R.compList.alignment = ["fill", "center"];
        R.btnRefreshComp = r21.add("button", undefined, "刷新");
        R.btnGetCenter = r21.add("button", undefined, "位置居中");
        R.btnGetBottom = r21.add("button", undefined, "位置下方");
        R.autoComp = r21.add("checkbox", undefined, "没有合成时自动新建");
        R.autoComp.value = true;
        R.posHint = lab(g2, "");

        /* ============ ③ 排版样式 ============ */
        var s3 = makeSection(c, "text", "③ 排版样式", openText);
        var g3 = s3.body;

        var r31 = row(g3);
        lab(r31, "字体");
        R.fontList = drop(r31, ["（保持图层原字体）"], 240);
        R.fontList.alignment = ["fill", "center"];
        R.btnFonts = r31.add("button", undefined, "刷新字体");

        var r31b = row(g3);
        lab(r31b, "字号");
        R.fontSize = edit(r31b, "60", 44);
        lab(r31b, "字距");
        R.tracking = edit(r31b, "0", 40);
        lab(r31b, "横排行距倍数(0=自动)");
        R.leadingRatio = edit(r31b, "0", 44);
        lab(r31b, "竖排行距倍数");
        R.vLeadingRatio = edit(r31b, "1.0", 44);

        var r32 = row(g3);
        lab(r32, "填充");
        R.colorFill = makeColorButton(r32, [1, 1, 1]);
        R.strokeOn = check(r32, "描边", false);
        R.colorStroke = makeColorButton(r32, [0, 0, 0]);
        lab(r32, "描边宽度");
        R.strokeWidth = edit(r32, "2", 40);
        lab(r32, "对齐");
        R.justify = drop(r32, ["居中", "左对齐", "右对齐"], 80);
        R.vertical = check(r32, "竖排文字", false);
        R.verticalDir = drop(r32, ["从右往左", "从左往右"], 90);

        var r33 = row(g3);
        lab(r33, "字幕中心 X");
        R.posX = edit(r33, "960", 60);
        lab(r33, "Y");
        R.posY = edit(r33, "900", 60);
        R.autoCenter = check(r33, "按包围盒自动居中", true);
        lab(r33, "图层名");
        R.layerName = drop(r33, ["歌词文本", "序号", "序号+歌词"], 90);
        lab(r33, "图层颜色");
        R.labelList = drop(r33, LY.LABELS, 70);

        /* ============ ④ 时间轴与双语 ============ */
        var s4 = makeSection(c, "time", "④ 时间轴与双语", openTime);
        var g4 = s4.body;

        var r41 = row(g4);
        lab(r41, "无时间码时长(s)");
        R.defaultDur = edit(r41, "2", 40);
        lab(r41, "相邻间隙(s)");
        R.gap = edit(r41, "0.02", 40);
        lab(r41, "最短(s)");
        R.minDur = edit(r41, "0.3", 40);
        lab(r41, "最长(s)");
        R.maxDur = edit(r41, "0", 40);
        lab(r41, "整体偏移(s)");
        R.offset = edit(r41, "0", 40);

        var r42 = row(g4);
        lab(r42, "额外延后(s)");
        R.leadIn = edit(r42, "0", 40);
        lab(r42, "提前结束(s)");
        R.leadOut = edit(r42, "0", 40);
        lab(r42, "同时间码判定容差(s)");
        R.mergeTol = edit(r42, "0.02", 40);
        lab(r42, "双语排版");
        R.biLayout = drop(r42, ["上下两行", "同一行"], 90);
        lab(r42, "顺序");
        R.biOrder = drop(r42, ["原文在上", "译文在上"], 90);

        var r43 = row(g4);
        lab(r43, "双语图层");
        R.biLayer = drop(r43, ["合并到一个图层", "原文/译文各一个图层"], 160);
        /* 默认「各一个图层」：一句原文 + 一句译文 = 两个图层，想分别调位移/样式时最好用。
         * 这个下拉没有存档（只有分组折叠状态会存），所以每次开面板都会回到这里。 */
        R.biLayer.selection = 1;
        lab(r43, "双语行距(px,0=自动)");
        R.lineStep = edit(r43, "0", 46);
        R.splitLines = check(r43, "同一时间码的每行都单独建层（不限双语）", false);

        var r44 = row(g4);
        R.precompose = check(r44, "生成后打包成预合成", false);

        var r45 = row(g4);
        R.biLayerInfo = lab(r45, "");
        R.biLayerInfo.alignment = ["fill", "center"];

        /* ============ ⑤ 预览与生成 ============ */
        var s5 = makeSection(c, "out", "⑤ 预览与生成", openOut);
        var g5 = s5.body;

        R.previewList = g5.add("listbox", undefined, []);
        R.previewList.preferredSize = [-1, 100];
        R.previewInfo = g5.add("statictext", undefined, "（还没有解析）", { multiline: true });
        R.previewInfo.alignment = ["fill", "top"];

        var r50 = row(g5);
        R.optReverse = check(r50, "倒序导入（最后一句排在最上层）", false);
        R.optReverse.helpTip = "默认：第一句在最上层（歌词1/歌词2/歌词3）。\n" +
            "勾上：最后一句在最上层（歌词3/歌词2/歌词1）。\n" +
            "只改图层的上下顺序，每句自己的入点出点不变。";
        R.reverseHint = lab(r50, "");

        var r51 = row(g5);
        R.btnPreview = r51.add("button", undefined, "预览解析结果");
        R.btnGenerate = r51.add("button", undefined, "生成字幕图层");
        R.btnGenerate.preferredSize.width = 140;

        /* ============ ⑥ 动画预设 ============ */
        var s6 = makeSection(c, "preset", "⑥ 动画预设（内置 / .ffx）", openPreset);
        var g6 = s6.body;

        var r60 = row(g6);
        lab(r60, "预设");
        R.presetList = r60.add("dropdownlist", undefined, []);
        R.presetList.alignment = ["fill", "center"];
        R.presetList.preferredSize.width = 260;
        R.btnPresetRefresh = r60.add("button", undefined, "刷新");

        var r61 = row(g6);
        R.btnPresetToSel = r61.add("button", undefined, "套到选中图层");
        R.btnPresetToAll = r61.add("button", undefined, "套到本合成全部文字层");
        R.optPresetClear = check(r61, "套用前清掉已有动画器", true);

        var r62 = row(g6);
        R.optPresetOnGen = check(r62, "生成字幕时自动套用", false);
        R.btnPresetDir = r62.add("button", undefined, "预设文件夹…");
        R.btnPresetProbe = r62.add("button", undefined, "能力体检");

        R.presetInfo = g6.add("statictext", undefined,
            "内置预设开箱即用；.ffx 是 AE 自己的预设格式，能把图层样式/效果/动画器一起带走。",
            { multiline: true });
        R.presetInfo.alignment = ["fill", "top"];
        R.presetInfo.preferredSize = [-1, 46];

        /* ============ ⑦ 模板图层（Ctrl+D 式生成） ============ */
        var s7 = makeSection(c, "tpl", "⑦ 模板图层（复制现有图层来生成）", openTpl);
        var g7 = s7.body;

        var r70 = row(g7);
        lab(r70, "模板");
        R.tplList = r70.add("dropdownlist", undefined, []);
        R.tplList.alignment = ["fill", "center"];
        R.tplList.preferredSize.width = 250;
        R.btnTplRefresh = r70.add("button", undefined, "刷新");
        R.btnTplPick = r70.add("button", undefined, "用选中层");

        var r71 = row(g7);
        R.optTplHide = check(r71, "生成后隐藏模板图层（不删除）", true);
        R.optTplName = check(r71, "图层名改成歌词（不勾则都叫模板名）", true);

        R.tplInfo = g7.add("statictext", undefined,
            "选一个做好的图层当模板，点「生成字幕图层」时会直接复制它 —— " +
            "图层样式 / 效果 / 动画器 / 蒙版 / 表达式全都原样带过去，比逐属性抄靠谱。",
            { multiline: true });
        R.tplInfo.alignment = ["fill", "top"];
        R.tplInfo.preferredSize = [-1, 46];

        /* --- 事件 --- */
        R.btnExpandAll.onClick = function () { setAllSections(true); };
        R.btnCollapseAll.onClick = function () { setAllSections(false); };

        R.optReverse.onClick = function () { updateReverseHint(); };

        /* ④ 双语：改了就立刻刷新提示，并重新预览一遍（图层数会变） */
        R.biLayout.onChange = function () { updateDualHint(); doPreview(); };
        R.biOrder.onChange = function () { doPreview(); };
        R.biLayer.onChange = function () { updateDualHint(); doPreview(); };
        R.splitLines.onClick = function () { doPreview(); };
        R.lineStep.onChange = function () { updateDualHint(); };
        R.fontSize.onChange = function () { updateDualHint(); };
        R.posY.onChange = function () { updateDualHint(); };
        updateDualHint();

        R.btnOpenLrc.onClick = function () { doOpenFile(); };
        R.btnScanFolder.onClick = function () { doScanFolder(); };
        R.btnLoadFile.onClick = function () { doLoadScanned(); };
        R.btnPaste.onClick = function () { doPaste(); };

        R.btnClear.onClick = function () {
            R.lyricText.text = "";
            R.previewList.removeAll();
            R.previewInfo.text = "（还没有解析）";
            clearTranslation();
            S.parsed = null;
            S.frames = null;
            setStatus("已清空");
        };

        R.btnClearTrans.onClick = function () { clearTranslation(); };
        R.hasTrans.onClick = function () {
            R.transInfo.text = R.hasTrans.value
                ? ("使用译文：" + String(S.translated || "").split("\n").length + " 行")
                : "没有译文";
        };

        R.btnRefreshComp.onClick = function () { refreshComps(); };
        R.compList.onChange = function () {
            updatePositionHint();
            refreshRefLayers();
            updateIndexHint();
            refreshTemplateLayers();
        };

        R.btnGetCenter.onClick = function () {
            var comp = getSelectedComp();
            if (!comp) { return; }
            R.posX.text = String(Math.round(comp.width / 2));
            R.posY.text = String(Math.round(comp.height / 2));
        };
        R.btnGetBottom.onClick = function () {
            var comp = getSelectedComp();
            if (!comp) { return; }
            R.posX.text = String(Math.round(comp.width / 2));
            R.posY.text = String(Math.round(comp.height * 0.85));
        };

        R.btnFonts.onClick = function () {
            setStatus("正在读取系统字体\u2026\u2026");
            repaint();
            var fonts = LY.listFonts();
            var items = ["（保持图层原字体）"];
            S.fontMap = [""];
            var i;
            if (fonts.length === 0) {
                /* AE 2023 上 app.fonts 是 undefined，列不出系统字体。
                 * 退化成一份常见字体清单：不一定装了，选了不存在的字体 AE 会静默回退。 */
                for (i = 0; i < LY.FALLBACK_FONTS.length; i++) {
                    items.push(LY.FALLBACK_FONTS[i] + "（常见字体，未必已安装）");
                    S.fontMap.push(LY.FALLBACK_FONTS[i]);
                }
                setStatus("当前 AE 不提供字体列表（app.fonts 不可用），已换成常见字体清单");
            } else {
                for (i = 0; i < fonts.length; i++) {
                    items.push(fonts[i].label);
                    S.fontMap.push(fonts[i].ps);
                }
                setStatus("字体列表已刷新，共 " + fonts.length + " 个");
            }
            R.fontList.removeAll();
            for (var j = 0; j < items.length; j++) { R.fontList.add("item", items[j]); }
            R.fontList.selection = 0;
        };

        R.btnPreview.onClick = function () { doPreview(); };
        R.btnGenerate.onClick = function () { doGenerate(); };

        /* --- ⑥ 动画预设 --- */
        R.presetList.onChange = function () {
            var ch = getPresetChoice();
            if (ch) { setStatus("预设：" + ch.name + (ch.tip ? (" —— " + ch.tip) : "")); }
        };
        R.btnPresetRefresh.onClick = function () {
            refreshPresets();
            setStatus("预设列表已刷新");
        };
        R.btnPresetToSel.onClick = function () { doApplyPreset("sel"); };
        R.btnPresetToAll.onClick = function () { doApplyPreset("alltext"); };
        R.btnPresetDir.onClick = function () {
            var d = Folder.selectDialog("选一个放 .ffx 预设的文件夹");
            if (d) {
                saveSetting("presetDir", d.fsName);
                refreshPresets();
                setStatus("已添加预设目录：" + d.fsName);
            }
        };
        R.btnPresetProbe.onClick = function () {
            var txt = PR.probeSupport();
            R.presetInfo.text = txt;
            notice("动画预设能力体检：\n\n" + txt);
        };

        R.btnTplRefresh.onClick = function () {
            refreshTemplateLayers();
            setStatus("模板图层列表已刷新");
        };
        R.btnTplPick.onClick = function () {
            try {
                var comp = getSelectedComp();
                if (!comp) { notice("请先选择一个合成。"); return; }
                var picked = null;
                for (var i = 1; i <= comp.numLayers; i++) {
                    var L = comp.layer(i);
                    if (L.selected && (L instanceof TextLayer)) { picked = L; break; }
                }
                if (!picked) {
                    notice("现在没有选中的文字图层。\n在时间轴里选中一个做好的字幕图层再来点这个按钮。");
                    return;
                }
                refreshTemplateLayers();
                for (var j = 0; j < S.tplLayers.length; j++) {
                    if (S.tplLayers[j] === picked) {
                        R.tplList.selection = j + 1;
                        break;
                    }
                }
                setStatus("已把「" + picked.name + "」设为模板图层");
            } catch (e) {
                notice("设置模板失败：" + e.toString());
            }
        };

        R.previewList.onDoubleClick = function () {
            if (!S.lastLayers || !R.previewList.selection) { return; }
            var i = R.previewList.selection.index;
            if (i >= 0 && i < S.lastLayers.length) {
                try {
                    var comp = getSelectedComp();
                    if (comp) {
                        for (var k = 1; k <= comp.numLayers; k++) { comp.layer(k).selected = false; }
                        S.lastLayers[i].selected = true;
                        comp.time = S.lastLayers[i].inPoint + 0.05;
                    }
                } catch (e) { }
            }
        };

        S.fontMap = [""];
        return tab;
    }

    /* ------------------------------------------------------------ 样式页 */

    function buildStyleTab(tabs) {
        var tab = tabs.add("tab", undefined, "样式同步");
        tab.orientation = "column";
        tab.alignChildren = ["fill", "top"];
        tab.spacing = 6;
        tab.margins = 8;

        var g1 = tab.add("panel", undefined, "① 参考图层（从这里复制样式）");
        g1.orientation = "column";
        g1.alignChildren = ["fill", "top"];
        g1.margins = 10;

        var r11 = row(g1);
        lab(r11, "参考图层");
        R.refList = drop(r11, [], 300);
        R.refList.alignment = ["fill", "center"];
        R.btnRefRefresh = r11.add("button", undefined, "刷新");
        R.btnRefPick = r11.add("button", undefined, "取当前选中图层");
        R.refInfo = lab(g1, "未选择参考图层");

        /* 这一句必须常驻：不少人把描边做在「图层样式 → 描边」上，同步完发现没描边，
         * 会以为是脚本坏了 —— 其实是逐个属性深拷贝对图层样式不好使。
         * （能**读**到，但照着结构重建会缺东西；真要搬请用 .ffx 预设。） */
        var hint = lab(g1, "「图层样式」（投影/描边/外发光/斜面…）跟不走：要连它一起搬，选中参考层 → " +
            "菜单「动画 > 将动画预设另存为」存成 .ffx，再去「歌词导入」页 ⑥ 套用。" +
            "只要描边的话，用文字属性里的「描边」或「效果 → 生成 → 描边」。");
        hint.alignment = ["fill", "top"];

        var g2 = tab.add("panel", undefined, "② 应用到哪些图层");
        g2.orientation = "column";
        g2.alignChildren = ["fill", "top"];
        g2.margins = 10;

        var r21 = row(g2);
        lab(r21, "图层号");
        R.indexSpec = edit(r21, "1-10", 200);
        R.btnAllLayers = r21.add("button", undefined, "全部");
        R.btnAllLayers.preferredSize.width = 48;
        R.btnAllLayers.helpTip = "一键填成「1-当前合成图层总数」，省得自己数";
        lab(r21, "支持 1-10 / 1,5,10 / 1-3,7,9-11 / 全部");
        R.indexHint = lab(g2, "");       // 「本合成共 N 层」—— 不然只能自己数
        var r22 = row(g2);
        R.optOnlyText = check(r22, "只处理文字图层", true);
        R.optSkipRef = check(r22, "跳过参考图层本身", true);

        R.btnAllLayers.onClick = function () {
            var comp = getSelectedComp();
            if (!comp) {
                notice("请先在项目里打开/选中一个合成，再点「全部」。");
                return;
            }
            R.indexSpec.text = "1-" + comp.numLayers;
            updateIndexHint();
        };
        R.indexSpec.onChange = function () { updateIndexHint(); };

        /* ================================================ ③ 双语图层
         *
         * 这里解决的是「应用完样式，所有字幕叠在同一个位置」：
         * 「各占一个图层」生成的原文 / 译文本来是靠 Y 错位分开的，而样式同步会把
         * 参考层的位置原样抄给每一层 —— 两组就重合了。
         * 默认走「保留上下错位」：抄完再按组内行号把每层挪回该在的高度。
         */
        var gBi = tab.add("panel", undefined, "③ 双语图层（原文 / 译文成对时）");
        gBi.orientation = "column";
        gBi.alignChildren = ["fill", "top"];
        gBi.margins = 10;

        var r31 = row(gBi);
        lab(r31, "另一组用");
        R.refList2 = drop(r31, [], 260);
        R.refList2.alignment = ["fill", "center"];
        R.btnRefPick2 = r31.add("button", undefined, "取当前选中图层");
        R.refList2.helpTip = "留「不用」＝两组都用同一个参考层（靠行距错开）";

        var r32 = row(gBi);
        lab(r32, "范围");
        R.biScope = drop(r32, ["全部图层", "只跟参考层同组", "只另一组"], 150);
        R.biScope.selection = 0;
        lab(r32, "双语位置");
        R.biPos = drop(r32, ["照抄参考层（两组会叠在一起）", "保留上下错位（推荐）", "完全不动位置"], 220);
        R.biPos.selection = 1;
        lab(r32, "行距(px,0=自动)");
        R.biStep = edit(r32, "0", 46);

        var r33 = row(gBi);
        R.btnPairScan = r33.add("button", undefined, "扫一遍分组");
        R.pairScanInfo = lab(r33, "");
        R.biInfo = lab(gBi, "");
        R.biInfo.alignment = ["fill", "top"];

        R.btnPairScan.onClick = function () { scanPairs(); };
        R.btnRefPick2.onClick = function () { pickRefLayer("refList2", 1); };
        R.biScope.onChange = function () { updateBiInfo(); };
        R.biPos.onChange = function () { updateBiInfo(); };

        var g3 = tab.add("panel", undefined, "④ 复制哪些内容");
        g3.orientation = "column";
        g3.alignChildren = ["fill", "top"];
        g3.margins = 10;

        var r31 = row(g3);
        R.optTextStyle = check(r31, "文字样式（字体/大小/颜色/描边/行距/字距/对齐）", true);
        var r32 = row(g3);
        R.optCopyText = check(r32, "同时覆盖文本内容（默认不覆盖，保留各自歌词）", false);

        var r33 = row(g3);
        R.optTransform = check(r33, "变换属性（位置/缩放/旋转/不透明度）", true);
        R.optLayerProps = check(r33, "图层属性（混合模式/3D/运动模糊/折叠变换/标签色）", true);

        var r34 = row(g3);
        R.optKeyframes = check(r34, "关键帧", true);
        R.optEase = check(r34, "同时复制缓动与插值曲线", true);
        R.optValues = check(r34, "无关键帧时复制静态值", true);

        var r35 = row(g3);
        R.optExpressions = check(r35, "表达式", true);
        R.optEffects = check(r35, "效果（整条特效栈，含参数关键帧）", true);
        R.optMasks = check(r35, "蒙版（含蒙版路径关键帧）", false);
        R.optAnimators = check(r35, "文字动画器", true);

        var r36 = row(g3);
        lab(r36, "关键帧对时");
        R.remapMode = r36.add("dropdownlist", undefined,
            ["缩放到每层的入点/出点（推荐）", "整体平移，保持原节奏", "不处理（保留绝对时间）"]);
        R.remapMode.selection = 0;
        R.remapMode.alignment = ["left", "center"];
        R.remapMode.helpTip =
            "复制过来的关键帧原本是**参考层的绝对时间**，不动的话动画会落在\n" +
            "目标图层可见范围之外（看着像「效果过去了但没反应」）。\n" +
            "「缩放」= 把参考层的时长拉伸/压缩到每一层自己的入点出点之间；\n" +
            "「平移」= 只把整段动画挪到这一层的入点上，节奏长度不变。";

        var g4 = row(tab);
        /* 「应用到目标图层」暂时不暴露 —— 逐属性抄带不走图层样式（AE 脚本接口没开放
         * 投影 / 描边 / 外发光），用户拿它做出来的字幕经常「样式没跟上」；而「以参考
         * 图层重建」是 duplicate()，AE 内部复制，样式 / 效果 / 动画器 / 蒙版全带得走，
         * 双语错位也已经补上，效果明显更好。
         *
         * 这里**不能**用 visible = false 藏：见文件头第 1 条 —— 控件不画了但位置还占着，
         * 那排按钮会留一个空档。要恢复就取消下面两行的注释，并把 onClick 那行的 if 去掉。 */
        R.btnApply = null;
        // R.btnApply = g4.add("button", undefined, "应用到目标图层");
        // R.btnApply.preferredSize.width = 160;
        R.btnRefRebuild = g4.add("button", undefined, "以参考图层重建（Ctrl+D 式）");
        R.btnRefRebuild.helpTip =
            "不走「逐属性抄」，而是直接复制参考图层（AE 内部复制，图层样式/效果/\n" +
            "动画器/蒙版全都带得走），再把每层原来的文字和入点出点写回去，\n" +
            "最后删掉旧图层。整个操作可 Ctrl+Z 撤销。";

        R.styleResult = tab.add("edittext", undefined, "", { multiline: true, scrolling: true });
        /* 高度给足：日志现在会带「参考层自带什么 / 实测前后对比 / 报错」，
         * 只有 130px 的话最关键的报错正好被截在看不见的地方。 */
        R.styleResult.preferredSize = [-1, 210];
        R.styleResult.alignment = ["fill", "top"];

        var g5 = row(tab);
        R.btnRefCopyOnly = g5.add("button", undefined, "只同步文字样式（最轻量）");

        R.btnRefRefresh.onClick = function () { refreshRefLayers(); };
        R.refList.onChange = function () { updateRefInfo(); };
        R.btnRefPick.onClick = function () { pickSelectedLayer(); };
        if (R.btnApply) { R.btnApply.onClick = function () { doApplyStyle(); }; }
        R.btnRefRebuild.onClick = function () { doRebuildFromRef(); };
        R.btnRefCopyOnly.onClick = function () {
            try {
                var comp = getSelectedComp();
                var ref = getRefLayer();
                if (!comp || !ref) { notice("请先选好合成和参考图层。"); return; }
                var spec = U.parseIndexSpec(R.indexSpec.text, comp.numLayers);
                if (spec.error) { notice("图层号有误：" + spec.error); return; }
                var rep = ST.applyTextStyleOnly(comp, ref, spec.list);
                R.styleResult.text = "只同步文字样式：处理 " + rep.layers + " 个图层，样式项 " +
                    rep.textStyles + " 个；跳过 " + rep.skipped + " 个。";
                setStatus("文字样式同步完成");
            } catch (e) {
                notice("同步失败：" + e.toString());
            }
        };

        return tab;
    }

    /* ------------------------------------------------------------ 在线页 */

    function buildOnlineTab(tabs) {
        var tab = tabs.add("tab", undefined, "在线歌词");
        tab.orientation = "column";
        tab.alignChildren = ["fill", "top"];
        tab.spacing = 6;
        tab.margins = 8;

        var g1 = tab.add("panel", undefined, "① 搜索歌曲");
        g1.orientation = "column";
        g1.alignChildren = ["fill", "top"];
        g1.margins = 10;

        var r11 = row(g1);
        lab(r11, "平台");
        R.platform = drop(r11, ["网易云音乐", "QQ 音乐"], 110);
        lab(r11, "关键词");
        R.keyword = r11.add("edittext", undefined, "");
        R.keyword.alignment = ["fill", "center"];
        R.keyword.characters = 24;
        R.btnSearch = r11.add("button", undefined, "搜索");
        R.btnSearch.preferredSize.width = 90;

        R.searchHint = lab(g1, "也可以直接粘贴歌曲链接或歌曲 ID（网易云纯数字 ID / QQ songmid）");
        R.searchResult = lab(g1, "");
        R.searchResult.alignment = ["fill", "center"];

        var g2 = tab.add("panel", undefined, "② 搜索结果");
        g2.orientation = "column";
        g2.alignChildren = ["fill", "top"];
        g2.margins = 10;
        R.songList = g2.add("listbox", undefined, []);
        R.songList.preferredSize = [-1, 120];
        var r21 = row(g2);
        R.btnFetch = r21.add("button", undefined, "获取歌词（含译文）");
        R.btnUseLyric = r21.add("button", undefined, "载入歌词导入页");
        R.btnUseLyric.preferredSize.width = 160;

        var g3 = tab.add("panel", undefined, "③ 歌词预览");
        g3.orientation = "column";
        g3.alignChildren = ["fill", "top"];
        g3.margins = 10;
        R.lyricPreview = g3.add("edittext", undefined, "", { multiline: true, scrolling: true });
        R.lyricPreview.preferredSize = [-1, 180];
        R.lyricPreview.alignment = ["fill", "top"];

        R.btnSearch.onClick = function () { doSearch(); };
        R.btnFetch.onClick = function () { doFetchLyrics(); };
        R.btnUseLyric.onClick = function () { useLyricsInImport(); };
        R.keyword.onEnterKey = function () { doSearch(); };

        return tab;
    }

    /* ------------------------------------------------------------ 关于页 */

    function buildAboutTab(tabs) {
        var tab = tabs.add("tab", undefined, "关于 / 自检");
        tab.orientation = "column";
        tab.alignChildren = ["fill", "top"];
        tab.spacing = 6;
        tab.margins = 8;

        var g1 = tab.add("panel", undefined, "歌词字幕排版工具 · AE 版");
        g1.orientation = "column";
        g1.alignChildren = ["fill", "top"];
        g1.margins = 10;
        var desc = g1.add("statictext", undefined,
            "构建 " + versionLine() + "（时间戳 " + BUILD + "）\n" +
            "导入 LRC / 纯文本自动排字幕 · 参考图层样式与关键帧批量同步 · 在线歌词搜索\n" +
            "竖排文字：AE 2024(24.2) 及以上用原生竖排，更早版本自动降级为逐字换行方案。\n" +
            "如果觉得上面显示的功能对不上，说明 AE 还开着旧版面板 —— 重启一次即可。",
            { multiline: true });
        desc.preferredSize.width = 520;

        var r11 = row(g1);
        R.btnSelfTest = r11.add("button", undefined, "运行自检");
        R.btnSelfTest.preferredSize.width = 120;
        R.btnProbeOnline = r11.add("button", undefined, "在线通道体检（会真搜一次）");
        R.btnProbeOnline.preferredSize.width = 200;

        R.aboutLog = tab.add("edittext", undefined, "", { multiline: true, scrolling: true });
        R.aboutLog.preferredSize = [-1, 280];
        R.aboutLog.alignment = ["fill", "top"];

        R.btnSelfTest.onClick = function () { doSelfTest(); };
        R.btnProbeOnline.onClick = function () { doProbeOnline(); };

        return tab;
    }

    /* ================================================================== 启动 */

    UI.window = UI.build();

    /* 给自动化测试留个把手：headless 自检脚本可以直接驱动这些内部函数，
     * 不用去猜控件树。对外部用户没有影响。 */
    UI.__debug = {
        refs: R,
        state: S,
        sections: SEC,
        order: SECTION_ORDER,
        build: BUILD,

        /** 测试模式：true 时不弹任何模态框（alert/confirm），消息记进 state.lastNotice */
        setSilent: function (v) { SILENT = !!v; },
        lastNotice: function () { return S.lastNotice || ""; },
        lastError: function () { return S.lastError || ""; },

        doPreview: doPreview,
        doGenerate: doGenerate,
        doSearch: doSearch,
        doFetchLyrics: doFetchLyrics,
        doApplyStyle: doApplyStyle,
        doRebuildFromRef: doRebuildFromRef,

        refreshTemplateLayers: refreshTemplateLayers,
        getTemplateLayer: getTemplateLayer,
        setTemplate: function (idx) {
            if (R.tplList && idx < R.tplList.items.length) { R.tplList.selection = idx; }
        },

        /** 等价于用户点了「打开歌词文件…」并选了这个文件 */
        openFile: function (path) { return readLyricFile(path, String(path).split("/").pop()); },
        /** 把一个字符串直接灌进歌词框 */
        setLyrics: function (text) { loadLyricText(text, "测试文本", "UTF-8"); },
        /** 等价于用户点了「扫描文件夹…」并选了这个目录 */
        scanFolder: function (dir) { return doScanFolder(new Folder(dir)); },

        preset: PR,
        refreshPresets: refreshPresets,
        doApplyPreset: doApplyPreset,
        getPresetChoice: getPresetChoice,

        setAllSections: setAllSections,
        measureAllSections: measureAllSections,
        measureOpenSections: measureOpenSections,
        updateIndexHint: updateIndexHint,
        updateReverseHint: updateReverseHint,
        /** 把「上次的折叠状态」清掉，让测试每次从默认状态开始 */
        resetSectionSettings: function () {
            for (var i = 0; i < SECTION_ORDER.length; i++) {
                saveSetting("sec_" + SECTION_ORDER[i].key, "");
            }
        },
        refitSections: refitSections,
        relayout: relayout,
        setStatus: setStatus,

        /* --- 布局相关（首屏收尾 / 单开模式），给布局回归测试用 --- */
        settleLayout: settleLayout,
        fitWindowHeight: fitWindowHeight,
        accordionOn: accordionOn,
        baseWrapHeight: baseWrapHeight,
        openWrapHeight: openWrapHeight,
        setAccordion: function (v) {
            saveSetting("accordion", v ? "1" : "0");
            if (R.accChk) { R.accChk.value = !!v; }
        }
    };

    /* 定时任务（app.scheduleTask）跑的是字符串，拿不到闭包，只能从全局摸回来 */
    UI.__settle = settleLayout;

    root.UI = UI;

})(this);
