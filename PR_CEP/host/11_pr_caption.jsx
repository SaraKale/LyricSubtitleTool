/* ============================================================================
 *  11_pr_caption.jsx —— PR 的「字幕轨」通道
 *  ---------------------------------------------------------------------------
 *  PR 从 2021 起有了原生字幕（Caption）轨道，ExtendScript 也给了入口：
 *
 *      Sequence.createCaptionTrack(projectItem, startAtTime[, captionFormat])
 *
 *  也就是说，**批量字幕的正路是「生成 SRT → 导入项目 → 建字幕轨」**，
 *  而不是一条条去建文字图层。PR 自己会把 SRT 拆成一条条字幕剪辑摆在轨道上，
 *  比脚本逐条插入快几个数量级，而且时间码、换行、双语都是原生行为。
 *
 *  这个通道的取舍（先讲清楚，省得用户以为插件坏了）：
 *    ✔ 快、稳、不吃模板；SRT 里有什么就是什么
 *    ✔ 字幕轨是 PR 原生对象，可以在「字幕」面板里直接改字、调时间
 *    ✘ 样式不归脚本管 —— 字体/字号/描边由 PR 的「字幕样式」（Caption Style）
 *      决定，ExtendScript 没有写样式的 API。想控制样式请用「图形剪辑」通道。
 *    ✘ 反复生成会叠加出多条字幕轨（PR 不允许脚本删轨），
 *      所以每次生成前会提醒，并且优先复用同名轨道所在的序列状态。
 *
 *  另外提供 exportSrt()：只把 SRT 写到磁盘，用户自己拖进 PR —— 兜底用。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var S = root.Seq;

    var C = {};
    root.Cap = C;

    /* ---------------------------------------------------------------- SRT 生成 */

    /** 秒 → SRT 时间码 00:00:01,234 */
    C.srtTime = function (sec) {
        var v = parseFloat(sec);
        if (isNaN(v) || v < 0) { v = 0; }
        var ms = Math.round(v * 1000);
        var h = Math.floor(ms / 3600000);
        ms -= h * 3600000;
        var m = Math.floor(ms / 60000);
        ms -= m * 60000;
        var s = Math.floor(ms / 1000);
        ms -= s * 1000;
        return U.pad(h, 2) + ":" + U.pad(m, 2) + ":" + U.pad(s, 2) + "," + U.pad(ms, 3);
    };

    /** 反过来：SRT 时间码 → 秒。给「读回已有 SRT」用，目前只在自检里跑一下。 */
    C.parseSrtTime = function (s) {
        var m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(String(s));
        if (!m) { return 0; }
        return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 +
            parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
    };

    /**
     * 把 frames 里「同一时间码的原句 + 译文」并成一条。
     * 字幕轨和图形剪辑两条通道都要这一步（PR 的一条字幕/一个文字图层可以多行），
     * 所以抽出来共用 —— 别在两个文件里各写一份，改一处漏一处的。
     *
     * 返回 [{ start, end, text, lines }]，lines 是合并进来的行数。
     */
    C.mergeFrames = function (frames, merge) {
        var items = [];
        var i, fr;
        if (merge === false) {
            for (i = 0; i < frames.length; i++) {
                fr = frames[i];
                items.push({ start: fr.start, end: fr.end, text: String(fr.text), lines: 1 });
            }
            return items;
        }
        for (i = 0; i < frames.length; i++) {
            fr = frames[i];
            if (fr.sub && items.length > 0) {
                items[items.length - 1].text += "\n" + String(fr.text);
                items[items.length - 1].lines++;
            } else {
                items.push({ start: fr.start, end: fr.end, text: String(fr.text), lines: 1 });
            }
        }
        return items;
    };

    /**
     * frames（L.buildFrames 的产物）→ SRT 文本。
     *
     * opts:
     *   offset   整体平移（秒），默认 0
     *   minDur   最短显示时长（秒），默认 0（0 表示不干预）
     *   maxDur   最长显示时长（秒），默认 0
     *   gap      两条字幕之间的最小间隔（秒），默认 0.001，防止首尾相接被合并
     *   merge    双语是否合成一条（两条用换行分隔）—— 默认 true，
     *            因为 SRT 一条字幕内是可以多行的，合成一条更符合 PR 字幕轨的预期
     *
     * 返回 { text, count, lines }
     */
    C.buildSrt = function (frames, opts) {
        if (!opts) { opts = {}; }
        var offset = U.toNumber(opts.offset, 0);
        var minDur = U.toNumber(opts.minDur, 0);
        var maxDur = U.toNumber(opts.maxDur, 0);
        var gap = U.toNumber(opts.gap, 0.001);
        var merge = (opts.merge === false) ? false : true;

        var out = [];
        var n = 0;
        var i, start, end, dur, text;

        /* 先把「同一时间码的原句 + 译文」并成一条 —— 这是字幕轨最自然的形态 */
        var items = C.mergeFrames(frames, merge);

        for (i = 0; i < items.length; i++) {
            start = items[i].start + offset;
            end = items[i].end + offset;
            if (start < 0) { start = 0; }
            dur = end - start;
            if (minDur > 0 && dur < minDur) { dur = minDur; }
            if (maxDur > 0 && dur > maxDur) { dur = maxDur; }
            if (dur <= 0) { dur = 0.5; }
            end = start + dur;

            text = String(items[i].text);
            /* SRT 的正文里不能有空行，否则解析器认为这一条结束了 */
            text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            while (text.indexOf("\n\n") >= 0) { text = text.split("\n\n").join("\n"); }
            if (!U.trim(text)) { continue; }
            /* 块内换行也统一成 CRLF —— SRT 是 Windows 时代的格式，
             * 各家解析器对纯 LF 的容忍度不一，混着来最容易被某一家读丢。 */
            text = text.split("\n").join("\r\n");

            n++;
            out.push(String(n));
            out.push(C.srtTime(start) + " --> " + C.srtTime(end + gap));
            out.push(text);
            out.push("");
        }

        return {
            /* 末尾再补一个 CRLF：每条字幕后面要跟一个空行，而 join 只会
             * 在元素**之间**插分隔符，最后那个空元素前面只有一个 CRLF。 */
            text: out.join("\r\n") + "\r\n",
            count: n,
            firstStart: items.length ? (items[0].start + offset) : 0,
            lastEnd: items.length ? (items[items.length - 1].end + offset) : 0
        };
    };

    /* ---------------------------------------------------------------- 文件 */

    /** 临时目录里的 srt 路径。名字带上时间戳，避免和用户自己的文件撞车。 */
    C.tempSrtPath = function (tag) {
        var d = U.tempDir();
        var stamp = "";
        try {
            var t = new Date();
            stamp = U.pad(t.getFullYear(), 4) + U.pad(t.getMonth() + 1, 2) + U.pad(t.getDate(), 2) +
                "_" + U.pad(t.getHours(), 2) + U.pad(t.getMinutes(), 2) + U.pad(t.getSeconds(), 2);
        } catch (e) { stamp = String(Math.round(Math.random() * 1e9)); }
        var name = "LyricSubtitle_" + (tag ? tag + "_" : "") + stamp + ".srt";
        return d + "/" + name;
    };

    /** 写 UTF-8（带 BOM）—— PR 导入 SRT 时靠 BOM 认编码，省得中文变乱码 */
    C.writeSrt = function (path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("w")) { return { ok: false, error: SB.M("写不进文件：%1", path) }; }
        try {
            f.write(String.fromCharCode(65279) + text);
        } finally {
            f.close();
        }
        return { ok: true, path: path };
    };

    /** 只导出 SRT 到磁盘（不碰项目），给「我自己拖进去」的用户 */
    C.exportSrt = function (frames, opts, savePath) {
        var built = C.buildSrt(frames, opts);
        if (built.count <= 0) {
            return { ok: false, error: SB.M("没有可写出的字幕（解析结果为空）") };
        }
        var path = savePath;
        if (!path) {
            var f = File.saveDialog(SB.M("保存 SRT 字幕"), "SubRip:*.srt");
            if (!f) { return { ok: false, canceled: true }; }
            path = f.fsName;
        }
        var w = C.writeSrt(path, built.text);
        if (!w.ok) { return w; }
        return { ok: true, path: path, count: built.count, text: built.text };
    };

    /* ---------------------------------------------------------------- 导入 */

    /** 在项目面板里找一个（没有就建一个）用来放字幕文件的素材箱 */
    function ensureBin(name) {
        try {
            var rootItem = app.project.rootItem;
            var n = rootItem.children.numItems;
            for (var i = 0; i < n; i++) {
                var it = rootItem.children[i];
                var t = "";
                try { t = String(it.type); } catch (e0) { }
                if (String(it.name) === name && t === "BIN") { return it; }
            }
            return rootItem.createBin(name);
        } catch (e) {
            return null;
        }
    }

    /** 在 bin 里按名字找刚导入的 srt 项目项 */
    function findInBin(bin, baseName) {
        try {
            var n = bin.children.numItems;
            for (var i = 0; i < n; i++) {
                var it = bin.children[i];
                var nm = String(it.name);
                if (nm === baseName || nm === baseName + ".srt") { return it; }
            }
            /* 名字对不上就退而求其次：拿最后一个（刚导入的通常排在最后） */
            if (n > 0) { return bin.children[n - 1]; }
        } catch (e) { }
        return null;
    }

    function baseNameOf(path) {
        var s = String(path).split("\\").join("/");
        var i = s.lastIndexOf("/");
        if (i >= 0) { s = s.substring(i + 1); }
        if (s.length > 4 && s.substring(s.length - 4).toLowerCase() === ".srt") {
            s = s.substring(0, s.length - 4);
        }
        return s;
    }

    /**
     * 核心动作：把 frames 变成一条 PR 原生字幕轨。
     *
     * opts:
     *   offset    起始偏移（秒），默认 0
     *   keepSrt   是否把生成的 srt 留在临时目录（默认 true，方便用户自己再导一次）
     *   binName   素材箱名，默认「歌词字幕工具」
     *   seqName   目标序列名；不传就用当前激活的
     *
     * 返回 { ok, count, path, trackIndex, warnings[] }
     */
    C.createTrack = function (frames, opts) {
        if (!opts) { opts = {}; }
        var warnings = [];

        var seq = S.active();
        if (opts.seqName) {
            var byName = S.byName(opts.seqName);
            if (byName) { seq = byName; }
        }
        if (!seq) {
            return { ok: false, error: SB.M("没有打开的序列。请先打开一条时间线。") };
        }

        /* 版本闸门：老版本 PR 没有这个 API，早点说清楚，别让用户对着不动的时间线发呆 */
        var canCaption = false;
        try { canCaption = (typeof seq.createCaptionTrack === "function"); } catch (e0) { }
        if (!canCaption) {
            return {
                ok: false,
                error: SB.M("这个 Premiere Pro 版本没有字幕轨 API（Sequence.createCaptionTrack 不存在）。请改用「图形剪辑」通道，或先「导出 SRT」再手动拖进项目。")
            };
        }

        var built = C.buildSrt(frames, opts);
        if (built.count <= 0) {
            return { ok: false, error: SB.M("没有可写出的字幕（解析结果为空）") };
        }

        /* 1) 落盘 */
        var path = opts.path || C.tempSrtPath("track");
        var w = C.writeSrt(path, built.text);
        if (!w.ok) { return w; }

        /* 2) 导入到素材箱 */
        var bin = ensureBin(opts.binName || SB.M("歌词字幕工具"));
        var imported = false;
        try {
            imported = app.project.importFiles([path], true, bin, false) ? true : false;
        } catch (e1) {
            return { ok: false, error: SB.M("导入 SRT 失败：%1", String(e1)), path: path };
        }
        if (!imported) {
            return {
                ok: false,
                path: path,
                error: SB.M("Premiere 拒绝了这次导入。SRT 已经写在：%1 —— 可以手动拖进项目面板。", path)
            };
        }

        /* 3) 找到刚导入的项目项 */
        var item = findInBin(bin, baseNameOf(path));
        if (!item) {
            return {
                ok: false,
                path: path,
                error: SB.M("SRT 导进去了但没能在项目面板里定位到它。请手动把它拖到时间线（PR 会自动建字幕轨）。")
            };
        }

        /* 4) 建字幕轨。第三个参数（captionFormat）不传 —— 默认就是 Subtitle，
         *    而 Sequence.CAPTION_FORMAT_* 这组常量不是每个版本都挂在全局上，
         *    传错了反而抛异常。 */
        var ok = false;
        var err = "";
        try {
            ok = seq.createCaptionTrack(item, U.toNumber(opts.offset, 0)) ? true : false;
        } catch (e2) {
            err = String(e2);
        }
        if (!ok) {
            warnings.push(SB.M("createCaptionTrack 没返回成功%1。可以手动把「%2」从项目面板拖到时间线，效果一样。",
                err ? "（" + err + "）" : "", item.name ? String(item.name) : baseNameOf(path)));
        }

        /* 5) 顺手把播放头挪到第一条，用户一眼能看到 */
        if (ok) { S.seek(seq, built.firstStart); }

        var caps = S.captionTracks(seq);
        if (caps.length > 1) {
            warnings.push(SB.M("当前序列已有 %1 条字幕轨。PR 不允许脚本删除轨道，多余的请在时间线上右键删除。", caps.length));
        }

        return {
            ok: true,
            count: built.count,
            path: path,
            created: ok,
            itemName: item.name ? String(item.name) : baseNameOf(path),
            firstStart: built.firstStart,
            lastEnd: built.lastEnd,
            captions: caps,
            warnings: warnings
        };
    };

    /* ---------------------------------------------------------------- 读回 */

    /** 列出序列上每条字幕轨里已有的字幕条数和首尾时间 —— 「工具」页显示用 */
    C.inspect = function (seqName) {
        var seq = S.active();
        if (seqName) {
            var b = S.byName(seqName);
            if (b) { seq = b; }
        }
        if (!seq) { return { ok: false, error: SB.M("没有打开的序列。") }; }
        var out = { ok: true, tracks: [] };
        var cols = null;
        try { cols = seq.captionTracks; } catch (e) { }
        if (!cols) { return { ok: true, tracks: [], note: SB.M("这个版本没有字幕轨集合（captionTracks）") }; }
        var n = 0;
        try { n = cols.numTracks; } catch (e1) { }
        for (var i = 0; i < n; i++) {
            var t = { index: i, name: "", clips: 0, first: 0, last: 0, samples: [] };
            try { t.name = String(cols[i].name); } catch (e2) { }
            var clips = null;
            try { clips = cols[i].clips; } catch (e3) { }
            if (clips) {
                try { t.clips = clips.numItems; } catch (e4) { }
                for (var k = 0; k < t.clips && k < 5; k++) {
                    var c = clips[k];
                    var s = S.secOf(c.start, 0);
                    var en = S.secOf(c.end, 0);
                    if (k === 0) { t.first = s; }
                    if (k === t.clips - 1) { t.last = en; }
                    var txt = "";
                    try { txt = String(c.name); } catch (e5) { }
                    t.samples.push({ start: s, end: en, text: txt });
                }
            }
            out.tracks.push(t);
        }
        return out;
    };
})();
