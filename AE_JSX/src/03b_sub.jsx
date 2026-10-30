/* ============================================================================
 *  03b_sub.jsx —— SRT / ASS(SSA) / WebVTT 字幕解析
 *  ---------------------------------------------------------------------------
 *  跟 03_lrc.jsx 一样是**纯逻辑**：不碰 AE，能在 Node 里直接跑单测。
 *
 *  为什么单独一个文件：03_lrc 已经 18KB，再往里塞三种字幕格式会顶穿
 *  ExtendScript 单编译单元 ~107KB 的余量（见 00_header.jsx 的说明）。
 *
 *  这几种格式跟 LRC 最大的区别：**自带结束时间**。
 *  LRC 只有开始时间，结束时间靠「下一句的开始」推出来；SRT / ASS / VTT 的
 *  时间轴本来就是精确的，再拿下一句去推反而会把句与句之间的空档填掉。
 *  所以这里解析出来的 item 多带一个 end 字段，03_lrc 的 buildFrames 看到
 *  end 就直接用，不再推算（开关：frame 选项 useEndTime）。
 *
 *  支持的格式：
 *    .srt  SubRip        序号 / 00:00:01,000 --> 00:00:03,500 / 文本 / 空行
 *    .ass  SubStation    [Script Info] [V4+ Styles] [Events]
 *                        Dialogue: Layer,Start,End,Style,Name,MarginL,R,V,Effect,Text
 *    .ssa  SSA v4        同上，样式字段少几个（按 Format: 行认字段，不是按位置）
 *    .vtt  WebVTT        WEBVTT 头 + 00:00:01.000 --> 00:00:03.500 + 文本
 *
 *  ASS 的样式表（[V4+ Styles]）会一并解析成「AE 文字图层认得的一组字段」：
 *    字体 / 字号 / 填充色 / 粗体 / 斜体 / 描边色+描边宽 / 对齐（左中右）
 *  生成图层时可以逐条盖到面板设置上（开关：frame 选项 useStyle）。
 *  位置（\pos）、阴影、旋转、卡拉OK 特效这些 AE 文字图层没有对应物的东西
 *  一律丢掉 —— 覆盖块 {...} 整块移除，不做解释。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util || {};
    var S = {};

    /** 翻译入口兜底：单测里可能没加载 02b_i18n，不能因为少了它挂掉 */
    function M(s) {
        return (root.M) ? root.M(s) : s;
    }

    /** 认得的字幕扩展名（不含点），给文件对话框和扫描文件夹用 */
    S.SUB_EXTS = ["srt", "ass", "ssa", "vtt"];

    /** 格式 id → 显示名。专有名词，不参与翻译 */
    S.FORMAT_LABELS = { lrc: "LRC", srt: "SRT", ass: "ASS", ssa: "SSA", vtt: "WebVTT", text: "TXT" };

    /* ---------------------------------------------------------------- 小工具 */

    function trim(s) {
        if (U.trim) { return U.trim(s); }
        return String(s).replace(/^\s+|\s+$/g, "");
    }

    function nl(s) {
        if (U.normalizeNewlines) { return U.normalizeNewlines(s); }
        return String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    /** 小数位换算：1 位 = 1/10 秒，2 位 = 1/100（ASS 的厘秒），3 位 = 毫秒 */
    function frac(v) {
        if (v === undefined || v === null || v === "") { return 0; }
        var n = parseInt(v, 10);
        if (isNaN(n)) { return 0; }
        if (v.length === 1) { return n / 10; }
        if (v.length === 2) { return n / 100; }
        return n / 1000;
    }

    /** 去掉首尾的空行（ASS / SRT 的文本块前后常带空行） */
    function trimLines(s) {
        var parts = String(s).split("\r");
        while (parts.length > 0 && trim(parts[0]) === "") { parts.shift(); }
        while (parts.length > 0 && trim(parts[parts.length - 1]) === "") { parts.pop(); }
        return parts.join("\r");
    }

    /**
     * 按逗号切字段，但**保证切出 count 段** —— 最后一个字段（正文）里
     * 经常自带逗号，不能跟着一起切碎。
     */
    function splitFields(s, count) {
        var out = [];
        var idx = 0;
        var k;
        for (k = 0; k < count - 1; k++) {
            var c = s.indexOf(",", idx);
            if (c < 0) { break; }
            out.push(s.substring(idx, c));
            idx = c + 1;
        }
        out.push(s.substring(idx));
        while (out.length < count) { out.push(""); }
        return out;
    }

    /** "Format: Name, Fontname, ..." → ["Name","Fontname",...] */
    function parseFormatNames(v) {
        var raw = String(v).split(",");
        var out = [];
        for (var i = 0; i < raw.length; i++) { out.push(trim(raw[i])); }
        return out;
    }

    /* ---------------------------------------------------------------- 时间码 */

    /**
     * "0:00:01.00"（ASS，厘秒）/ "00:00:01,000"（SRT，毫秒）/ "00:01.500"（VTT）
     * → 秒。认不出来返回 null。
     */
    S.parseTime = function (s) {
        var t = trim(String(s));
        var m = /^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t);
        if (m) {
            return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac(m[4]);
        }
        m = /^(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t);
        if (m) {
            return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac(m[3]);
        }
        return null;
    };

    /**
     * SRT / VTT 的时间行：找出 "-->" 两边的时间码。
     * @return [整段匹配, 开始, 结束]，不是时间行返回 null
     */
    S.timeLine = function (line) {
        var s = String(line);
        var m = /(\d{1,3}:\d{1,2}(?::\d{1,2})?[.,]\d{1,3})\s*-->\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?[.,]\d{1,3})/.exec(s);
        if (!m) {
            // 少数文件没有小数部分：00:00:01 --> 00:00:03
            m = /(\d{1,3}:\d{1,2}(?::\d{1,2})?)\s*-->\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?)/.exec(s);
        }
        return m ? [m[0], m[1], m[2]] : null;
    };

    /* ---------------------------------------------------------------- ASS 专用 */

    /**
     * ASS 颜色 "&H00BBGGRR"（也有 &HBBGGRR、十进制三种写法）→ [r,g,b]，各 0~1。
     * 注意顺序：ASS 里是**蓝绿红**，AE 里是红绿蓝。
     */
    S.parseAssColor = function (v) {
        var s = trim(String(v));
        var hex = "";
        var m = /^[&]?[hH]([0-9a-fA-F]+)$/.exec(s);
        if (m) {
            hex = m[1];
        } else if (/^\d+$/.test(s)) {
            hex = parseInt(s, 10).toString(16);
        } else {
            return null;
        }
        while (hex.length < 6) { hex = "0" + hex; }
        hex = hex.substring(hex.length - 6);   // 带 alpha 的 &HAABBGGRR 取低 6 位
        return [
            parseInt(hex.substring(4, 6), 16) / 255,
            parseInt(hex.substring(2, 4), 16) / 255,
            parseInt(hex.substring(0, 2), 16) / 255
        ];
    };

    /**
     * ASS 正文 → 纯文本。
     *   {\i1}…{\i0} 这类覆盖块：整块丢掉（AE 文字图层没有对应开关）
     *   \N / \n：ASS 的硬换行 → \r（AE 文字图层的换行符）
     *   \h：不换行空格 → 普通空格
     */
    S.assText = function (t) {
        var s = String(t);
        s = s.replace(/\{[^}]*\}/g, "");
        s = s.replace(/\\h/g, " ");
        s = s.replace(/\\[Nn]/g, "\r");
        return s;
    };

    /** WebVTT 正文 → 纯文本（<v 说话人>、<i>、<c.color>、时间戳标签全去掉） */
    S.vttText = function (t) {
        return String(t).replace(/<[^>]*>/g, "");
    };

    /**
     * 一条 ASS 样式 → 一组 AE 文字图层认得的字段。
     * 字段名跟 LY.defaultOptions() 对齐，生成图层时直接盖上去就行。
     */
    S.assStyleToText = function (st) {
        var out = {};
        if (st.fontname) { out.fontPostScript = st.fontname; }

        var fs = parseFloat(st.fontsize);
        if (!isNaN(fs) && fs > 0) { out.fontSize = fs; }

        var pc = S.parseAssColor(st.primarycolour);
        if (pc) { out.fillColor = pc; }

        var ow = parseFloat(st.outline);
        if (!isNaN(ow) && ow > 0) {
            out.applyStroke = true;
            out.strokeColor = S.parseAssColor(st.outlinecolour) || [0, 0, 0];
            out.strokeWidth = ow;
        } else {
            out.applyStroke = false;
        }

        if (String(st.bold) === "-1" || String(st.bold) === "1") { out.fauxBold = true; }
        if (String(st.italic) === "-1" || String(st.italic) === "1") { out.fauxItalic = true; }

        // ASS 的 Alignment 是九宫格：1/4/7 左、2/5/8 中、3/6/9 右
        var al = parseInt(st.alignment, 10);
        if (!isNaN(al) && al >= 1 && al <= 9) {
            var mod = al % 3;
            out.justification = (mod === 1) ? "left" : ((mod === 0) ? "right" : "center");
            out.assAlignment = al;   // 上下对齐（1~3 下 / 4~6 中 / 7~9 上）AE 里没接，先留着
        }
        return out;
    };

    var STYLE_FORMAT_DEFAULT = "Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
    var EVENT_FORMAT_DEFAULT = "Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

    /**
     * 解析 ASS / SSA。
     * @return { meta, items:[{time,end,text,order,group,styleName,style}], styles, hasTime, warnings }
     */
    S.parseASS = function (text, options) {
        var o = options || {};
        var group = o.group || "A";
        var rows = nl(text).split("\n");
        var styles = {};
        var styleCount = 0;
        var items = [];
        var warnings = [];
        var meta = {};
        var order = 0;
        var section = "";
        var styleFmt = null;
        var eventFmt = null;
        var i, line, low;

        for (i = 0; i < rows.length; i++) {
            line = trim(rows[i]);
            if (line === "" || line.charAt(0) === ";") { continue; }

            var sec = /^\[([^\]]+)\]$/.exec(line);
            if (sec) { section = trim(sec[1]).toLowerCase(); continue; }

            low = line.toLowerCase();

            if (section === "script info") {
                var pm = /^(PlayResX|PlayResY|WrapStyle|ScaledBorderAndShadow)\s*:\s*(.+)$/i.exec(line);
                if (pm) { meta[pm[1].toLowerCase()] = trim(pm[2]); }
            }

            if (low.indexOf("format:") === 0) {
                var names = parseFormatNames(line.substring(7));
                if (section.indexOf("styles") >= 0) { styleFmt = names; }
                else if (section === "events") { eventFmt = names; }
                continue;
            }

            if (low.indexOf("style:") === 0) {
                var sf = styleFmt || parseFormatNames(STYLE_FORMAT_DEFAULT);
                var sv = splitFields(line.substring(6), sf.length);
                var st = {};
                for (var k2 = 0; k2 < sf.length; k2++) { st[sf[k2].toLowerCase()] = trim(sv[k2]); }
                var sname = st.name || "Default";
                if (!styles[sname]) { styleCount++; }
                styles[sname] = S.assStyleToText(st);
                continue;
            }

            /* Comment: 是注释行（翻译署名、打轴备注之类），不当字幕 */
            if (low.indexOf("dialogue:") === 0) {
                var ef = eventFmt || parseFormatNames(EVENT_FORMAT_DEFAULT);
                var ev = splitFields(line.substring(9), ef.length);
                var e = {};
                for (var k3 = 0; k3 < ef.length; k3++) { e[ef[k3].toLowerCase()] = trim(ev[k3]); }

                var t1 = S.parseTime(e.start || "");
                if (t1 === null) { continue; }
                var t2 = S.parseTime(e.end || "");
                var body = trimLines(S.assText(e.text || ""));
                if (body === "") { continue; }

                var sname2 = e.style || "Default";
                items.push({
                    time: t1,
                    end: (t2 === null || t2 <= t1) ? null : t2,
                    text: body,
                    order: order++,
                    group: group,
                    styleName: sname2,
                    style: styles[sname2] || null
                });
                continue;
            }
        }

        if (styleCount > 0) {
            warnings.push(M("已读入 %1 种 ASS 样式（字体/字号/颜色/描边会套到生成的图层上）", styleCount));
        }

        return {
            meta: meta, items: items, styles: styles,
            hasTime: items.length > 0, warnings: warnings
        };
    };

    /* ---------------------------------------------------------------- SRT / VTT */

    /**
     * 解析 SubRip（.srt）。o.vtt = true 时顺手把 <...> 标签清掉。
     * 序号行可以没有，间隔空行可以不止一个 —— 只认 "-->" 时间行。
     */
    S.parseSRT = function (text, options) {
        var o = options || {};
        var group = o.group || "A";
        var vtt = !!o.vtt;
        var rows = nl(text).split("\n");
        var items = [];
        var order = 0;
        var i = 0;

        while (i < rows.length) {
            var tm = S.timeLine(trim(rows[i]));
            if (!tm) { i++; continue; }

            var t1 = S.parseTime(tm[1]);
            var t2 = S.parseTime(tm[2]);
            i++;

            var buf = [];
            while (i < rows.length) {
                var l2 = String(rows[i]).replace(/\s+$/, "");
                if (trim(l2) === "") { break; }
                // 已经收了几行文字、又撞上下一条的时间行 → 这条到此为止
                if (buf.length > 0 && S.timeLine(trim(l2))) { break; }
                buf.push(vtt ? S.vttText(l2) : l2);
                i++;
            }

            var body = trimLines(buf.join("\r"));
            if (t1 !== null && body !== "") {
                items.push({
                    time: t1,
                    end: (t2 === null || t2 <= t1) ? null : t2,
                    text: body,
                    order: order++,
                    group: group
                });
            }
        }

        return { meta: {}, items: items, styles: {}, hasTime: items.length > 0, warnings: [] };
    };

    /** 解析 WebVTT（.vtt）：先去掉 WEBVTT 头和 NOTE/STYLE/REGION 块，再走 SRT 那套 */
    S.parseVTT = function (text, options) {
        var o = options || {};
        var rows = nl(text).split("\n");
        var out = [];
        var i = 0;

        while (i < rows.length && trim(rows[i]).indexOf("WEBVTT") !== 0) { i++; }
        i++;   // 跳过 WEBVTT 这一行

        while (i < rows.length) {
            var low = trim(rows[i]).toLowerCase();
            if (low === "note" || low.indexOf("note ") === 0 ||
                low === "style" || low.indexOf("style ") === 0 ||
                low === "region" || low.indexOf("region ") === 0) {
                while (i < rows.length && trim(rows[i]) !== "") { i++; }
                i++;
                continue;
            }
            out.push(rows[i]);
            i++;
        }

        o.vtt = true;
        return S.parseSRT(out.join("\n"), o);
    };

    /* ---------------------------------------------------------------- 识别 */

    /** 从文件名猜格式（用户选的文件扩展名是最可靠的信号） */
    S.formatOfName = function (name) {
        var m = /\.([a-z0-9]+)$/i.exec(String(name));
        if (!m) { return ""; }
        var e = m[1].toLowerCase();
        if (e === "srt") { return "srt"; }
        if (e === "ass" || e === "ssa") { return "ass"; }
        if (e === "vtt") { return "vtt"; }
        if (e === "lrc") { return "lrc"; }
        return "";
    };

    /** 从内容猜格式：ass | srt | vtt | lrc | text */
    S.detect = function (text) {
        var head = String(text).substring(0, 20000);
        if (/^\s*﻿?\s*WEBVTT/i.test(head)) { return "vtt"; }
        if (/\[\s*(V4\+?\s*Styles?|Events|Script Info)\s*\]/i.test(head)) { return "ass"; }
        if (/^\s*(Dialogue|Format|Style)\s*:/im.test(head)) { return "ass"; }
        var tl = S.timeLine(head);
        if (tl) { return (/WEBVTT/i.test(head)) ? "vtt" : "srt"; }
        if (U.LRC_TAG && U.LRC_TAG.test(head)) { return "lrc"; }
        if (U.LRC_META && U.LRC_META.test(head)) { return "lrc"; }
        return "text";
    };

    /**
     * 统一入口：认出 SRT / ASS / VTT 就解析，返回带 format 的结果；
     * 认不出（LRC / 纯文本）返回 null —— 交给 L.parse 处理。
     */
    S.parse = function (text, options) {
        var o = options || {};
        var fmt = o.format ? String(o.format).toLowerCase() : S.detect(text);
        if (fmt === "ssa") { fmt = "ass"; }

        var r = null;
        if (fmt === "ass") { r = S.parseASS(text, o); }
        else if (fmt === "srt") { r = S.parseSRT(text, o); }
        else if (fmt === "vtt") { r = S.parseVTT(text, o); }
        if (!r) { return null; }

        r.format = fmt;
        r.formatLabel = S.FORMAT_LABELS[fmt] || fmt;
        return r;
    };

    root.Sub = S;
})();
