/* ============================================================================
 *  03_lrc.jsx —— LRC 歌词解析 / 双语合并 / 时间轴排版
 *  ---------------------------------------------------------------------------
 *  这一层完全不依赖 AE，可以在 Node 里直接跑单元测试（见 tests/test_logic.js）。
 *
 *  支持：
 *    [00:12.34]歌词          ← 标准 LRC
 *    [00:12.345]歌词         ← 三位毫秒（P9 老脚本在这里会出 bug，这里没问题）
 *    [00:12]歌词             ← 没有小数
 *    [00:12:34]歌词          ← 少数播放器用冒号分隔
 *    [00:12.34][01:30.00]副歌 ← 一行多个时间码
 *    [ti:][ar:][al:][by:][offset:]  ← 元信息标签
 *    <00:12.34> 逐字标签、[00:12.34] 内联重复标签会被清掉
 *    没有时间码的纯文本一行一句
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var L = {};

    L.TAG_SOURCE = "\\[(\\d{1,4}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]";
    L.META_KEYS = "ti|ar|al|by|offset|re|ve|length|kana|au|t_time|tool|encoding";

    /* ------------------------------------------------------------------ 解析 */

    function fracToSeconds(frac) {
        if (frac === undefined || frac === null || frac === "") { return 0; }
        var v = parseInt(frac, 10);
        if (isNaN(v)) { return 0; }
        if (frac.length === 1) { return v / 10; }
        if (frac.length === 2) { return v / 100; }
        return v / 1000;
    }

    /** 取出这一行里所有的时间码，返回秒数组 */
    L.extractTimes = function (line) {
        var re = new RegExp(L.TAG_SOURCE, "g");
        var out = [];
        var m;
        while ((m = re.exec(line)) !== null) {
            out.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fracToSeconds(m[3]));
            if (m[0] === "") { re.lastIndex++; }
        }
        return out;
    };

    /** 去掉时间码，只留歌词文字 */
    L.stripTags = function (line) {
        var t = line.replace(new RegExp(L.TAG_SOURCE, "g"), "");
        // 增强型 LRC 的词级时间码 <00:12.34>
        t = t.replace(/<\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?>/g, "");
        // 有些文件会把时间码写成 {00:12.34}
        t = t.replace(/\{\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?\}/g, "");
        // 音译行常见 [00:12.34] 叠在行尾
        t = t.replace(/\[\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?\]/g, "");
        return U.trim(t);
    };

    /**
     * 「随便丢进来一段文本」的入口：先交给 SB.Sub 认 SRT / ASS / VTT，
     * 认出来就用那边的解析器（自带结束时间、ASS 还带样式表）；
     * 认不出来（LRC / 纯文本）才走下面的 L.parse。
     *
     * 为什么不直接改 L.parse：L.parse 的语义是「按 LRC 规则解析」，
     * 双语合并、自检、单测都直接调它，动了它等于动所有老路径。
     * 加一层入口，老代码一行都不用改。
     */
    L.parseAuto = function (text, options) {
        var o = options || {};
        var r = (root.Sub) ? root.Sub.parse(text, o) : null;
        if (r) { return r; }
        return L.parse(text, o);
    };

    /**
     * 解析整段歌词文本。
     * @param text   歌词全文
     * @param options { group:"A"|"B" }
     * @return { meta, items:[{time,text,order,group}], hasTime, warnings }
     */
    L.parse = function (text, options) {
        var o = options || {};
        var group = o.group || "A";
        var src = U.normalizeNewlines(text);
        var rows = src.split("\n");
        var meta = {};
        var items = [];
        var warnings = [];
        var hasTime = false;
        var order = 0;
        var droppedUntimed = 0;
        var metaRe = new RegExp("^\\[(" + L.META_KEYS + "):([^\\]]*)\\]$", "i");

        for (var i = 0; i < rows.length; i++) {
            var line = U.trim(rows[i]);
            if (line === "") { continue; }

            var metaOnly = metaRe.exec(line);
            if (metaOnly) {
                var key = metaOnly[1].toLowerCase();
                meta[key] = U.trim(metaOnly[2]);
                continue;
            }

            var times = L.extractTimes(line);
            var content = L.stripTags(line);

            if (times.length === 0) {
                if (content === "") { continue; }
                items.push({ time: null, text: content, order: order++, group: group });
                droppedUntimed++;
                continue;
            }

            hasTime = true;
            if (content === "") { continue; }
            for (var t = 0; t < times.length; t++) {
                items.push({ time: times[t], text: content, order: order++, group: group });
            }
        }

        if (hasTime && droppedUntimed > 0) {
            warnings.push(SB.M("有 %1 行没有时间码", droppedUntimed));
        }

        // offset 标签（毫秒）
        if (meta["offset"]) {
            var off = parseInt(meta["offset"], 10);
            if (!isNaN(off) && off !== 0) {
                for (var k = 0; k < items.length; k++) {
                    if (items[k].time !== null) { items[k].time += off / 1000; }
                }
                warnings.push(SB.M("已应用文件内的 offset：%1ms", off));
            }
        }

        return { meta: meta, items: items, hasTime: hasTime, warnings: warnings };
    };

    /* ------------------------------------------------------------------ 双语配对 */

    function timedItems(items) {
        var out = [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].time !== null && items[i].text !== "") { out.push(items[i]); }
        }
        return out;
    }

    /**
     * 把「原文歌词」和「译文歌词」两份 LRC 合到一起，并把译文对其到原文的时间码上。
     *
     * 在线接口拿到的原文/译文时间码经常有 0.0x ~ 0.3s 的偏差，直接按时间码合并会
     * 拆成两条字幕。这里先按「时间最近」配对，配不上的再按行号配对。
     */
    L.pairBilingual = function (originalText, translatedText, options) {
        var o = options || {};
        var tol = (o.matchTolerance === undefined) ? 0.6 : o.matchTolerance;
        var A = L.parse(originalText || "", { group: "A" });
        var B = L.parse(translatedText || "", { group: "B" });
        var aTimed = timedItems(A.items);
        var bTimed = timedItems(B.items);

        var items = [];
        var usedA = {};
        var i, j;

        for (i = 0; i < aTimed.length; i++) {
            items.push({ time: aTimed[i].time, text: aTimed[i].text, group: "A", order: 0, paired: false });
        }

        var sameCount = (bTimed.length > 0 && bTimed.length === aTimed.length);

        for (i = 0; i < bTimed.length; i++) {
            var best = -1;
            var bestDiff = 1e9;
            for (j = 0; j < aTimed.length; j++) {
                if (usedA[j]) { continue; }
                var d = Math.abs(aTimed[j].time - bTimed[i].time);
                if (d < bestDiff) { bestDiff = d; best = j; }
            }
            var target = -1;
            if (best >= 0 && bestDiff <= tol) {
                target = best;
            } else if (sameCount && !usedA[i]) {
                target = i;
            }

            if (target >= 0) {
                usedA[target] = true;
                items.push({ time: aTimed[target].time, text: bTimed[i].text, group: "B", order: 0, paired: true });
            } else {
                items.push({ time: bTimed[i].time, text: bTimed[i].text, group: "B", order: 0, paired: false });
            }
        }

        // 没有时间码的行（一般是作词/翻译署名）直接丢掉，避免生成莫名其妙的字幕
        var unpaired = 0;
        for (i = 0; i < items.length; i++) { if (!items[i].paired && items[i].group === "B") { unpaired++; } }

        // 稳定排序：同一时间点原文排在译文前面
        items.sort(function (x, y) {
            if (x.time !== y.time) { return x.time - y.time; }
            if (x.group !== y.group) { return x.group < y.group ? -1 : 1; }
            return 0;
        });
        for (i = 0; i < items.length; i++) { items[i].order = i; }

        var warnings = A.warnings.concat(B.warnings);
        if (unpaired > 0) {
            warnings.push(SB.M("有 %1 行译文没能匹配到原文时间码", unpaired));
        }

        return {
            meta: A.meta,
            items: items,
            hasTime: aTimed.length > 0 || bTimed.length > 0,
            warnings: warnings
        };
    };

    /** 把解析结果重新拼回 LRC 文本（在线歌词预览用） */
    L.toLrcText = function (parsed) {
        var items = parsed.items || [];
        var timed = [];
        var untimed = [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].time === null) { untimed.push(items[i]); } else { timed.push(items[i]); }
        }
        timed.sort(function (a, b) { return a.time - b.time || a.order - b.order; });

        var lines = [];
        for (var u = 0; u < untimed.length; u++) { lines.push(untimed[u].text); }
        for (var t = 0; t < timed.length; t++) {
            lines.push("[" + U.formatLrcTime(timed[t].time) + "]" + timed[t].text);
        }
        return lines.join("\n");
    };

    /* ------------------------------------------------------------------ 时间轴 */

    L.defaultFrameOptions = function () {
        return {
            defaultDuration: 2.0,      // 最后一行 / 整段无时间码时的默认时长（秒）
            gap: 0.02,                 // 相邻字幕之间留的空隙
            minDuration: 0.30,         // 太短的字幕强制拉长
            maxDuration: 0,            // >0 时限制单条字幕最长时长
            leadIn: 0,                 // 整体延后（秒）
            leadOut: 0,                // 整体提前（秒）
            startOffset: 0,            // 整段时间轴偏移（秒）
            /* SRT / ASS / VTT 自带结束时间：true = 用它，不再拿「下一句的开始」
             * 去推（推出来的会把句与句之间的空档填掉）。LRC 没有结束时间，
             * 走到这条分支时 g.end 是 null，行为跟以前一模一样。 */
            useEndTime: true,
            /* ASS 样式表里的字体/字号/颜色/描边要不要盖到面板设置上。
             * false = 完全按面板的排版样式走，跟导入 LRC 一样。 */
            useStyle: true,
            mergeTolerance: 0.02,      // 时间差小于这个值视为同一时间点 → 合并成多行
            untimedMode: "mergePrev",  // ignore | mergePrev —— 有时间码时怎么处理没时间码的行
            bilingualLayout: "stack",  // stack（上下两行） | sameLine（同一行拼接）
            bilingualOrder: "AB",      // AB（原文在上） | BA（译文在上）
            lineSeparator: " / ",      // sameLine 模式下的连接符
            splitLines: false          // true = 同一时间点的多行各自单独建层
        };
    };

    /**
     * 给拆出来的帧打上「同组序号」。
     *
     * 同一时间码的一组歌词（比如一句原文 + 一句译文）被拆成多个图层之后，
     * 每个图层得知道自己在这组里排第几、这组一共几个 —— 生成图层时要用它算
     * 垂直错位（不然两个图层会严丝合缝地叠在同一个 Y 上，看起来就像只有一行）。
     *
     * 字段含义：
     *   pairId   同一时间码分组的编号（同一组的帧这个值相同）
     *   sub      自己在组里排第几（0 = 最上面那行）
     *   subCount 这组一共拆出几个图层（1 = 没拆，就是普通帧）
     *   role     "A" 原文 / "B" 译文 / "M" 合并行
     */
    function stampSub(frame, pairId, sub, subCount, role) {
        frame.pairId = pairId;
        frame.sub = sub;
        frame.subCount = subCount;
        frame.role = role;
        return frame;
    }

    function buildLines(groupItems, o) {
        var a = [];
        var b = [];
        var i;
        for (i = 0; i < groupItems.length; i++) {
            var it = groupItems[i];
            if ((it.group || "A") === "A") { a.push(it); } else { b.push(it); }
        }

        var lines = [];
        if (o.bilingualLayout === "sameLine" && b.length > 0 && a.length > 0) {
            var count = a.length > b.length ? a.length : b.length;
            for (var k = 0; k < count; k++) {
                var left = k < a.length ? a[k].text : "";
                var right = k < b.length ? b[k].text : "";
                var joined = (left !== "" && right !== "") ? (left + o.lineSeparator + right) : (left !== "" ? left : right);
                if (U.trim(joined) !== "") {
                    lines.push({ text: joined, group: "M", srcGroup: "M", order: k, style: a[k].style || b[k].style });
                }
            }
            return lines;
        }

        /* ⚠️ group 在这里表示的是「这一组里的第几行」（A=第一行、B=第二行），
         *   跟 pairBilingual 那个「A=原文、B=译文」不是一回事 —— 同名不同义，
         *   历史包袱，别混。要判断语言得看 srcGroup，它是从原始 item 透传下来的。 */
        var first = (o.bilingualOrder === "BA") ? b : a;
        var second = (o.bilingualOrder === "BA") ? a : b;
        for (var x = 0; x < first.length; x++) {
            lines.push({ text: first[x].text, group: "A", srcGroup: first[x].group, order: first[x].order, style: first[x].style });
        }
        for (var y = 0; y < second.length; y++) {
            lines.push({ text: second[y].text, group: "B", srcGroup: second[y].group, order: second[y].order, style: second[y].style });
        }
        return lines;
    }

    /**
     * 生成最终的字幕帧列表。
     * @return [ { index, start, end, duration, lines:[{text,group}], text:"多行文本" } ]
     */
    L.buildFrames = function (parsed, options) {
        var o = L.defaultFrameOptions();
        if (options) {
            for (var key in options) {
                if (options.hasOwnProperty && options.hasOwnProperty(key)) { o[key] = options[key]; }
            }
        }

        var items = (parsed && parsed.items) ? parsed.items : [];
        var frames = [];
        var i;

        var timed = [];
        var untimed = [];
        for (i = 0; i < items.length; i++) {
            if (items[i].time === null || items[i].time === undefined) { untimed.push(items[i]); }
            else { timed.push(items[i]); }
        }

        /* ---------- 情况 A：整段都没有时间码 → 一行一句按默认时长顺序排 ---------- */
        if (timed.length === 0) {
            var cursor = Math.max(0, o.startOffset);
            for (i = 0; i < untimed.length; i++) {
                var one = U.trim(untimed[i].text);
                if (one === "") { continue; }
                frames.push(stampSub({
                    index: frames.length,
                    start: cursor,
                    end: cursor + o.defaultDuration,
                    duration: o.defaultDuration,
                    lines: [{ text: one, group: "A", order: untimed[i].order }],
                    text: one,
                    untimed: true
                }, i, 0, 1, "A"));
                cursor += o.defaultDuration + o.gap;
            }
            return frames;
        }

        /* ---------- 情况 B：有时间码 → 按时间码分组成帧 ---------- */
        var groups = [];
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            var txt = U.trim(it.text);
            if (txt === "") { continue; }

            if (it.time === null || it.time === undefined) {
                if (o.untimedMode === "mergePrev" && groups.length > 0) {
                    groups[groups.length - 1].items.push({ text: txt, group: it.group, order: it.order, style: it.style });
                }
                continue;
            }

            var t = it.time + o.startOffset;
            /* 自带结束时间（SRT / ASS / VTT）：跟着 startOffset 一起平移 */
            var tend = (it.end === null || it.end === undefined) ? null : (it.end + o.startOffset);
            var last = groups.length > 0 ? groups[groups.length - 1] : null;
            if (last && Math.abs(t - last.time) <= o.mergeTolerance) {
                last.items.push({ text: txt, group: it.group, order: it.order, style: it.style });
                // 同一时间点被合并成多行时，取最晚的那个结束时间
                if (tend !== null && (last.end === null || last.end === undefined || tend > last.end)) {
                    last.end = tend;
                }
            } else {
                groups.push({
                    time: t, end: tend,
                    items: [{ text: txt, group: it.group, order: it.order, style: it.style }]
                });
            }
        }

        /* ---------- 计算 in/out ---------- */
        for (i = 0; i < groups.length; i++) {
            var g = groups[i];
            var start = g.time + o.leadIn;
            var end;
            if (o.useEndTime && g.end !== null && g.end !== undefined && g.end > start) {
                /* 自带结束时间：直接用。注意这里**不减 gap** ——
                 * 自带的时间轴已经是「这句到这儿为止」，再减就切短了。 */
                end = g.end - o.leadOut;
            } else if (i + 1 < groups.length) {
                end = groups[i + 1].time - o.gap - o.leadOut;
            } else {
                end = g.time + o.defaultDuration - o.leadOut;
            }
            if (end - start < o.minDuration) { end = start + o.minDuration; }
            if (o.maxDuration > 0 && end - start > o.maxDuration) { end = start + o.maxDuration; }
            if (end <= start) { end = start + o.defaultDuration; }
            g.start = start;
            g.end = end;
        }

        /* ---------- 组装帧 ---------- */
        for (i = 0; i < groups.length; i++) {
            var grp = groups[i];
            var lines = buildLines(grp.items, o);
            if (lines.length === 0) { continue; }

            if (o.splitLines && lines.length > 1) {
                for (var s = 0; s < lines.length; s++) {
                    var fs2 = stampSub({
                        index: frames.length,
                        start: grp.start,
                        end: grp.end,
                        duration: grp.end - grp.start,
                        lines: [lines[s]],
                        text: lines[s].text,
                        srcGroup: lines[s].srcGroup,
                        untimed: false
                    }, i, s, lines.length, lines[s].srcGroup || lines[s].group);
                    /* ASS 样式逐条带过去：生成图层时盖在面板设置上面 */
                    if (o.useStyle && lines[s].style) { fs2.style = lines[s].style; }
                    frames.push(fs2);
                }
            } else {
                var joined = [];
                for (var q = 0; q < lines.length; q++) { joined.push(lines[q].text); }
                var fm = stampSub({
                    index: frames.length,
                    start: grp.start,
                    end: grp.end,
                    duration: grp.end - grp.start,
                    lines: lines,
                    text: joined.join("\r"),
                    srcGroup: lines[0].srcGroup,
                    untimed: false
                }, i, 0, 1, lines[0].srcGroup || lines[0].group);
                if (o.useStyle && lines[0].style) { fm.style = lines[0].style; }
                frames.push(fm);
            }
        }

        return frames;
    };

    /* ------------------------------------------------------------------ 统计 */

    L.stats = function (frames) {
        var out = { count: 0, total: 0, first: 0, last: 0, shortest: 0, longest: 0 };
        if (!frames || frames.length === 0) { return out; }
        out.count = frames.length;
        out.first = frames[0].start;
        out.shortest = frames[0].duration;
        out.longest = frames[0].duration;
        for (var i = 0; i < frames.length; i++) {
            if (frames[i].start < out.first) { out.first = frames[i].start; }
            if (frames[i].end > out.last) { out.last = frames[i].end; }
            if (frames[i].duration < out.shortest) { out.shortest = frames[i].duration; }
            if (frames[i].duration > out.longest) { out.longest = frames[i].duration; }
        }
        out.total = out.last - out.first;
        return out;
    };

    /** 同一时间点存在多条文本的行数（判断是不是双语） */
    L.countMultiLineFrames = function (frames) {
        var n = 0;
        for (var i = 0; i < frames.length; i++) {
            if (frames[i].lines.length > 1) { n++; }
        }
        return n;
    };

    root.Lrc = L;
})();
