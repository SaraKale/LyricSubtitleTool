/* ============================================================================
 *  02_util.jsx —— 通用工具
 *  ---------------------------------------------------------------------------
 *  只写不依赖 AE 的纯逻辑 + 少量文件读写封装，方便在 Node 里跑单元测试。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = {};

    /* ------------------------------------------------------------------ 字符串 */

    U.trim = function (s) {
        if (s === null || s === undefined) { return ""; }
        var t = String(s);
        return t.replace(/^[\s\u00a0\u3000]+/, "").replace(/[\s\u00a0\u3000]+$/, "");
    };

    U.normalizeNewlines = function (s) {
        if (s === null || s === undefined) { return ""; }
        return String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    };

    U.pad = function (n, width) {
        var s = String(Math.floor(Math.abs(n)));
        while (s.length < width) { s = "0" + s; }
        return s;
    };

    U.repeat = function (s, times) {
        var out = "";
        for (var i = 0; i < times; i++) { out += s; }
        return out;
    };

    U.startsWith = function (s, prefix) {
        return String(s).substr(0, prefix.length) === prefix;
    };

    U.arrayIndexOf = function (arr, value) {
        if (!arr) { return -1; }
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === value) { return i; }
        }
        return -1;
    };

    U.clamp = function (v, lo, hi) {
        if (v < lo) { return lo; }
        if (v > hi) { return hi; }
        return v;
    };

    U.isNumber = function (v) {
        return typeof v === "number" && isFinite(v);
    };

    /** 宽松地把输入转成正数，失败返回 fallback */
    U.toNumber = function (v, fallback) {
        var n = parseFloat(String(v).replace(",", "."));
        if (isNaN(n) || !isFinite(n)) { return fallback; }
        return n;
    };

    /* ------------------------------------------------------------------ 时间格式 */

    /** 12.345 → "00:00:12.345" */
    U.formatTimecode = function (seconds, withMs) {
        var s = Math.max(0, seconds || 0);
        var totalMs = Math.round(s * 1000);
        var ms = totalMs % 1000;
        var totalSec = (totalMs - ms) / 1000;
        var sec = totalSec % 60;
        var totalMin = (totalSec - sec) / 60;
        var min = totalMin % 60;
        var hour = (totalMin - min) / 60;
        var out = U.pad(hour, 2) + ":" + U.pad(min, 2) + ":" + U.pad(sec, 2);
        if (withMs) { out += "." + U.pad(ms, 3); }
        return out;
    };

    /** 12.345 → "00:12.35"（LRC 风格） */
    U.formatLrcTime = function (seconds) {
        var s = Math.max(0, seconds || 0);
        var totalCs = Math.round(s * 100);
        var cs = totalCs % 100;
        var totalSec = (totalCs - cs) / 100;
        var sec = totalSec % 60;
        var min = (totalSec - sec) / 60;
        return U.pad(min, 2) + ":" + U.pad(sec, 2) + "." + U.pad(cs, 2);
    };

    /* ------------------------------------------------------------------ 图层号表达式 */

    /**
     * 解析 "1-10" / "1,5,10" / "1-3,7,9-11" / "全部" / "*"
     * 返回 { list:[...], error:"..." }，list 已去重并升序。
     */
    U.parseIndexSpec = function (spec, maxIndex) {
        var result = { list: [], error: "" };
        var text = U.trim(spec);
        if (text === "" ) { result.error = SB.M("图层号不能为空"); return result; }
        if (text === "*" || text === "全部" || text === "all" || text === "ALL") {
            var all = [];
            for (var a = 1; a <= (maxIndex || 0); a++) { all.push(a); }
            result.list = all;
            return result;
        }

        var parts = text.split(/[,，、;；\s]+/);
        var seen = {};
        for (var i = 0; i < parts.length; i++) {
            var p = U.trim(parts[i]);
            if (p === "") { continue; }

            var range = /^(\d+)\s*[-~—]\s*(\d+)$/.exec(p);
            if (range) {
                var lo = parseInt(range[1], 10);
                var hi = parseInt(range[2], 10);
                if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
                if (lo < 1) { result.error = SB.M("图层号从 1 开始：%1", p); return result; }
                for (var r = lo; r <= hi; r++) { seen[r] = true; }
                continue;
            }

            if (/^\d+$/.test(p)) {
                var n = parseInt(p, 10);
                if (n < 1) { result.error = SB.M("图层号从 1 开始：%1", p); return result; }
                seen[n] = true;
                continue;
            }

            result.error = SB.M("无法识别的图层号片段：%1", p);
            return result;
        }

        var list = [];
        for (var key in seen) {
            if (seen.hasOwnProperty && seen.hasOwnProperty(key)) { list.push(parseInt(key, 10)); }
        }
        list.sort(function (a, b) { return a - b; });

        if (list.length === 0) { result.error = SB.M("没有解析出任何图层号"); return result; }
        if (maxIndex && list[list.length - 1] > maxIndex) {
            result.error = SB.M("图层号超出范围（当前合成共 %1 个图层）", maxIndex);
            return result;
        }
        result.list = list;
        return result;
    };

    /** [1,2,3,7,9] → "1-3,7,9" */
    U.formatIndexList = function (list) {
        if (!list || list.length === 0) { return ""; }
        var out = [];
        var start = list[0];
        var prev = list[0];
        for (var i = 1; i <= list.length; i++) {
            var cur = list[i];
            if (i < list.length && cur === prev + 1) { prev = cur; continue; }
            out.push(start === prev ? String(start) : (start + "-" + prev));
            start = cur;
            prev = cur;
        }
        return out.join(",");
    };

    /* ------------------------------------------------------------------ 编码识别 */

    /** 把文件读成 0~255 的字节数组 */
    U.readBytes = function (path) {
        var f = new File(path);
        f.encoding = "BINARY";
        if (!f.open("r")) { throw new Error(SB.M("无法读取文件：%1", path)); }
        var raw;
        try {
            raw = f.read();
        } finally {
            f.close();
        }
        var bytes = [];
        for (var i = 0; i < raw.length; i++) {
            bytes.push(raw.charCodeAt(i) & 0xFF);
        }
        return bytes;
    };

    /**
     * 严格 UTF-8 解码。只要有一个非法字节序列就返回 null。
     * 这是区分「UTF-8 的中文」和「GBK 的中文」最可靠的办法：
     * GBK 的高位字节序列几乎必然违反 UTF-8 规则。
     */
    U.decodeUtf8 = function (bytes) {
        var out = "";
        var i = 0;
        var n = bytes.length;
        while (i < n) {
            var b = bytes[i++];
            var cp;
            if (b < 0x80) {
                cp = b;
            } else if ((b & 0xE0) === 0xC0) {
                if (i >= n) { return null; }
                var b1 = bytes[i++];
                if ((b1 & 0xC0) !== 0x80) { return null; }
                cp = ((b & 0x1F) << 6) | (b1 & 0x3F);
                if (cp < 0x80) { return null; }
            } else if ((b & 0xF0) === 0xE0) {
                if (i + 1 >= n) { return null; }
                var b1 = bytes[i++];
                var b2 = bytes[i++];
                if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80) { return null; }
                cp = ((b & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
                if (cp < 0x800) { return null; }
                if (cp >= 0xD800 && cp <= 0xDFFF) { return null; }
            } else if ((b & 0xF8) === 0xF0) {
                if (i + 2 >= n) { return null; }
                var b1 = bytes[i++];
                var b2 = bytes[i++];
                var b3 = bytes[i++];
                if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80 || (b3 & 0xC0) !== 0x80) { return null; }
                cp = ((b & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
                if (cp < 0x10000 || cp > 0x10FFFF) { return null; }
            } else {
                return null;
            }
            if (cp > 0xFFFF) {
                cp -= 0x10000;
                out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
            } else {
                out += String.fromCharCode(cp);
            }
        }
        return out;
    };

    U.decodeUtf16 = function (bytes, littleEndian) {
        var out = "";
        for (var i = 0; i + 1 < bytes.length; i += 2) {
            var lo = littleEndian ? bytes[i] : bytes[i + 1];
            var hi = littleEndian ? bytes[i + 1] : bytes[i];
            out += String.fromCharCode((hi << 8) | lo);
        }
        return out;
    };

    /** 借助 ExtendScript 自带的编码转换读文件（GBK / BIG5 等） */
    U.readAsLegacy = function (path, encoding) {
        try {
            var f = new File(path);
            f.encoding = encoding;
            if (!f.open("r")) { return null; }
            var text;
            try {
                text = f.read();
            } finally {
                f.close();
            }
            if (text === null || text === undefined || text.length === 0) { return null; }
            if (text.indexOf("\uFFFD") >= 0) { return null; }
            return text;
        } catch (e) {
            return null;
        }
    };

    /* 编码下拉：value 用稳定的 ASCII id（跨语言不变），标签另给一份。
     * 面板把 value 传回来，这里再用 ENCODING_IDS 映射回内部的编码名。
     *
     * 下面这两张表是**数据**，不在这里翻：标签是桥接层的 API.encodings 用
     * SB.M(ENCODING_LABELS[i]) 现翻的 —— 在声明处翻会被「模块只在加载时求值一次」
     * 卡住，用户切语言时切不动。 */
    /* i18n-allow */
    U.ENCODINGS = ["auto", "utf8", "gbk", "gb2312", "big5", "system"];
    U.ENCODING_LABELS = ["自动", "UTF-8", "GBK", "GB2312", "BIG5", "系统默认"];
    U.ENCODING_IDS = {
        "自动": "auto", "系统默认": "system",
        "auto": "auto", "system": "system",
        "utf8": "UTF-8", "gbk": "GBK", "gb2312": "GB2312", "big5": "BIG5",
        "UTF-8": "UTF-8", "GBK": "GBK", "GB2312": "GB2312", "BIG5": "BIG5"
    };
    /* i18n-allow-end */
    U.normalizeEncoding = function (v) {
        var s = U.trim(v || "");
        /* 空值＝交给自动识别；返回 ASCII id 而不是中文标签，
         * 免得这个「内部状态值」被当成界面文案。 */
        if (s === "") { return "auto"; }
        return U.ENCODING_IDS[s] || s;
    };

    /**
     * 判断一个文件「像不像歌词」。
     *
     * 为什么要按内容而不是按扩展名：
     *   实测用户的歌词文件叫《仙剑》主题曲-《少年情》lrc —— 没有那个点，
     *   根本不是扩展名。任何 *.lrc 过滤器都看不到它，用户就会觉得
     *   「软件识别不到我的 lrc 文件」。
     *
     * 这里只读文件开头一小段并以 BINARY 方式比较，所以：
     *   · 不受编码影响（GBK / UTF-8 都一样）—— [00:12.34] 这些字符都是 ASCII
     *   · 不整文件读，快
     */
    U.LRC_TAG = /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/;
    U.LRC_META = /\[\s*(ti|ar|al|by|au|re|ve|length|offset|kana)\s*:/i;
    /* 字幕格式的「指纹」。都是 ASCII，所以按 BINARY 读也能认出来，
     * 不受 GBK / UTF-8 编码影响。
     *   SRT / VTT：  00:00:01,000 --> 00:00:03,000
     *   ASS / SSA：  [Script Info] / [V4+ Styles] / Dialogue: ...
     */
    U.SRT_TIME = /\d{1,3}:\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->/;
    U.ASS_SECTION = /\[\s*(Script Info|V4\+?\s*Styles?|Events|Fonts|Graphics)\s*\]/i;
    U.ASS_EVENT = /^\s*(Dialogue|Format|Style)\s*:/im;

    U.sniffLyricsFile = function (path) {
        try {
            var f = new File(path);
            f.encoding = "BINARY";
            if (!f.open("r")) { return false; }
            var raw;
            try { raw = f.read(); } finally { f.close(); }
            if (raw === null || raw === undefined || raw.length === 0) { return false; }
            var head = raw.substring(0, 4000);
            return U.LRC_TAG.test(head) || U.LRC_META.test(head)
                || U.SRT_TIME.test(head) || U.ASS_SECTION.test(head) || U.ASS_EVENT.test(head);
        } catch (e) {
            return false;
        }
    };

    /**
     * 文件名看着像歌词/字幕文件就算候选。
     * 后缀名单之外还认「文件名里带 lrc」—— 兜住《仙剑》主题曲-《少年情》lrc
     * 这种没有扩展名的文件。
     */
    U.looksLikeLyricsName = function (name) {
        var n = String(name);
        if (/\.(lrc|txt|srt|ass|ssa|vtt)$/i.test(n)) { return true; }
        if (/lrc/i.test(n)) { return true; }
        return false;
    };

    /**
     * 读文本文件，自动识别编码。
     * @return { text, encoding, ok }
     */
    U.readTextAuto = function (path, forcedEncoding) {
        var forced = U.normalizeEncoding(forcedEncoding);
        var bytes = U.readBytes(path);

        // 1) BOM 优先
        if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            var noBom = [];
            for (var i = 3; i < bytes.length; i++) { noBom.push(bytes[i]); }
            var bomText = U.decodeUtf8(noBom);
            return { text: bomText === null ? "" : bomText, encoding: "UTF-8(BOM)", ok: bomText !== null };
        }
        if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
            var leBytes = [];
            for (var j = 2; j < bytes.length; j++) { leBytes.push(bytes[j]); }
            return { text: U.decodeUtf16(leBytes, true), encoding: "UTF-16LE", ok: true };
        }
        if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
            var beBytes = [];
            for (var k = 2; k < bytes.length; k++) { beBytes.push(bytes[k]); }
            return { text: U.decodeUtf16(beBytes, false), encoding: "UTF-16BE", ok: true };
        }

        // 2) 指定编码
        if (forced === "UTF-8") {
            var t = U.decodeUtf8(bytes);
            if (t !== null) { return { text: t, encoding: "UTF-8", ok: true }; }
            return { text: "", encoding: "UTF-8", ok: false };
        }
        if (forced === "GBK" || forced === "GB2312" || forced === "BIG5") {
            var legacy = U.readAsLegacy(path, forced);
            return legacy === null
                ? { text: "", encoding: forced, ok: false }
                : { text: legacy, encoding: forced, ok: true };
        }

        // 3) 自动：先严格 UTF-8，失败再按简中/繁中常见编码试
        var utf8 = U.decodeUtf8(bytes);
        if (utf8 !== null) { return { text: utf8, encoding: "UTF-8", ok: true }; }

        var tries = ["GBK", "GB18030", "GB2312", "BIG5", "Shift-JIS"];
        for (var m = 0; m < tries.length; m++) {
            var r = U.readAsLegacy(path, tries[m]);
            if (r !== null) { return { text: r, encoding: tries[m], ok: true }; }
        }
        return { text: "", encoding: SB.M("未知"), ok: false };
    };

    U.writeText = function (path, text, encoding) {
        var f = new File(path);
        f.encoding = encoding || "UTF-8";
        if (!f.open("w")) { throw new Error(SB.M("无法写入文件：%1", path)); }
        try {
            f.write(text);
        } finally {
            f.close();
        }
        return f.fsName;
    };

    U.readTextRaw = function (path, encoding) {
        var f = new File(path);
        if (encoding) { f.encoding = encoding; }
        if (!f.open("r")) { return null; }
        var t;
        try {
            t = f.read();
        } finally {
            f.close();
        }
        return t;
    };

    U.fileExists = function (path) {
        try {
            return new File(path).exists;
        } catch (e) {
            return false;
        }
    };

    U.tempDir = function () {
        var dir = Folder.temp;
        if (!dir.exists) { dir.create(); }
        var sub = new Folder(dir.fsName + "/sb_subtitle_tmp");
        if (!sub.exists) { sub.create(); }
        return sub.fsName;
    };

    /* ------------------------------------------------------------------ 其它 */

    U.decodeHtmlEntities = function (s) {
        if (!s) { return ""; }
        var t = String(s);
        t = t.replace(/&apos;/g, "'").replace(/&#39;/g, "'");
        t = t.replace(/&quot;/g, "\"").replace(/&#34;/g, "\"");
        t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        t = t.replace(/&nbsp;/g, " ");
        t = t.replace(/&#(\d+);/g, function (all, code) {
            return String.fromCharCode(parseInt(code, 10));
        });
        t = t.replace(/&#x([0-9a-fA-F]+);/g, function (all, code) {
            return String.fromCharCode(parseInt(code, 16));
        });
        t = t.replace(/&amp;/g, "&");
        return t;
    };

    U.escapeForShellDoubleQuote = function (s) {
        // Windows cmd 的双引号里，只有 " 需要转义，其它字符原样即可
        return String(s).replace(/"/g, "\\\"");
    };

    root.Util = U;
})();
