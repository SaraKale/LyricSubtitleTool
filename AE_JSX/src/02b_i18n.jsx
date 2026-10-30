/* ============================================================================
 *  02b_i18n.jsx —— 宿主侧的多语言（核心，自动生成，不要手改）
 *  ---------------------------------------------------------------------------
 *  源：_tools/i18n/*.json    生成：_tools/build_i18n.py
 *
 *  各语言的表在 02c / 02d / 02e 三个文件里（一张表 60KB 上下，四张塞一起
 *  会顶穿 ExtendScript 单个编译单元 ~107KB 的上限）。它们只调 addTable，
 *  顺序无所谓；加载失败也只是那一个语言翻不了，不会连累中文模式。
 *
 *  用法：SB.M("中文原文")、SB.M("模板 %1 和 %2", a, b)
 *    · SB.lang = "zh"（默认）时是恒等函数，等于没接这层
 *    · key 就是中文原文本身 —— 改文案不会漏改 key，因为根本不需要 key
 *    · 查不到就原样返回，绝不因为少一条翻译把功能搞挂
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;

    root.I18N_TABLES = root.I18N_TABLES || {};

    /** 支持的语言。zh 是「不查表」，所以不在表那边出现。 */
    root.LANGS = ["zh", "zh-Hant", "en", "ja"];
    root.lang = root.lang || "zh";

    /** 表文件把自己的内容挂进来；重复加载就合并，后写的覆盖先写的。 */
    root.addTable = function (name, t) {
        if (!root.I18N_TABLES) { root.I18N_TABLES = {}; }
        var cur = root.I18N_TABLES[name];
        if (!cur) { root.I18N_TABLES[name] = t; return name; }
        for (var k in t) {
            if (t.hasOwnProperty(k)) { cur[k] = t[k]; }
        }
        return name;
    };

    /** 认不出来的语言一律退回中文 —— 面板传什么都不会把界面搞成半吊子。 */
    root.normalizeLang = function (l) {
        var i;
        for (i = 0; i < root.LANGS.length; i++) {
            if (l === root.LANGS[i]) { return l; }
        }
        return "zh";
    };

    root.setLang = function (l) {
        root.lang = root.normalizeLang(l);
        return root.lang;
    };

    /** 当前语言的表；zh 没有表（恒等），缺表也当恒等处理。 */
    root.table = function () {
        if (root.lang === "zh") { return null; }
        var t = root.I18N_TABLES[root.lang];
        return (t === undefined || t === null) ? null : t;
    };

    /** 当前语言下的这条文案；带参数时把 %1 %2 … 换成实参 */
    root.M = function (zh) {
        var s = zh;
        var t = root.table();
        if (t) {
            var hit = t[zh];
            if (hit !== undefined && hit !== null) { s = hit; }
        }
        if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
                var a = arguments[i];
                s = s.split("%" + i).join(String(a));
            }
        }
        return s;
    };

    /** 只翻一个值（不查表就原样返回），给数组里的名字用 */
    root.T = function (v) {
        var t = root.table();
        if (!t) { return v; }
        var hit = t[v];
        return (hit !== undefined && hit !== null) ? hit : v;
    };

    /** 整批翻（下拉框的标签用） */
    root.TList = function (list) {
        var out = [];
        for (var i = 0; i < list.length; i++) { out.push(root.T(list[i])); }
        return out;
    };

    /** 给面板回话用：当前语言 + 已经挂上的表，排查「切了没反应」时看这个 */
    root.langInfo = function () {
        var names = [], k;
        for (k in root.I18N_TABLES) {
            if (root.I18N_TABLES.hasOwnProperty(k)) { names.push(k); }
        }
        return { lang: root.lang, tables: names.join(",") };
    };
})();
