/* ============================================================================
 *  10_pr_seq.jsx —— Premiere Pro 侧的「序列 / 轨道 / 时间」适配层
 *  ---------------------------------------------------------------------------
 *  这是 PR 版相对 AE 版**唯一真正要重写**的地方：
 *    AE 里一切以「合成 + 图层」为单位，PR 里是「序列 + 轨道 + 剪辑」。
 *    逻辑层（01_json / 02_util / 02b~02e i18n / 03_lrc / 03b_sub / 06_online）
 *    一行都不用改，直接复用。
 *
 *  PR 的时间单位（踩过才知道的）：
 *    · ticks —— 1 秒 = 254016000000 ticks（254016000000 = 44100 * 5760000）
 *    · seq.timebase 是「每帧多少 ticks」，所以 fps = TICKS_PER_SEC / timebase
 *    · Time 对象的 .ticks 是**字符串**（数值太大，超过 32 位整数）
 *    · 有的 API 要秒（overwriteClip / createCaptionTrack），有的要 ticks 字符串
 *      （importMGT / setPlayerPosition）—— 这个文件专门负责换算，别在业务里手算。
 *
 *  另外提供 probe()：PR 各版本的 ExtendScript 能力差异比 AE 大得多
 *  （字幕轨 API 是 2021 才进来的，MOGRT 参数注入各家版本行为也不一样），
 *  面板的「自检」直接把这个函数的输出显示出来，省得靠猜。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;

    var S = {};
    root.Seq = S;

    /* 1 秒 = 254016000000 ticks。这个数是 PR 内部的时间基，改不得。 */
    S.TICKS_PER_SEC = 254016000000;

    /* ---------------------------------------------------------------- 基础换算 */

    S.ticksToSec = function (t) {
        var v = parseFloat(t);
        if (isNaN(v)) { return 0; }
        return v / S.TICKS_PER_SEC;
    };

    S.secToTicks = function (sec) {
        var v = parseFloat(sec);
        if (isNaN(v)) { v = 0; }
        if (v < 0) { v = 0; }
        return String(Math.round(v * S.TICKS_PER_SEC));
    };

    /** 造一个 Time 对象。PR 里改 clip.start / clip.end 都要求传 Time，不能传秒数。 */
    S.timeAt = function (sec) {
        var v = parseFloat(sec);
        if (isNaN(v) || v < 0) { v = 0; }
        var t = new Time();
        try {
            t.seconds = v;
        } catch (e) {
            /* 个别版本 .seconds 只读，退回落 ticks */
            try { t.ticks = S.secToTicks(v); } catch (e2) { }
        }
        return t;
    };

    /** Time 对象 → 秒（拿不到就返回 fallback） */
    S.secOf = function (t, fallback) {
        if (fallback === undefined) { fallback = 0; }
        if (t === null || t === undefined) { return fallback; }
        try {
            var v = parseFloat(t.seconds);
            if (!isNaN(v)) { return v; }
        } catch (e) { }
        try {
            var w = parseFloat(t.ticks);
            if (!isNaN(w)) { return w / S.TICKS_PER_SEC; }
        } catch (e2) { }
        return fallback;
    };

    S.frameRate = function (seq) {
        if (!seq) { return 0; }
        try {
            var tb = parseFloat(seq.timebase);
            if (tb > 0) { return S.TICKS_PER_SEC / tb; }
        } catch (e) { }
        return 0;
    };

    /* ---------------------------------------------------------------- 序列 */

    /** 当前激活的序列（时间线）。没打开就返回 null。 */
    S.active = function () {
        try {
            var sq = app.project.activeSequence;
            if (sq) { return sq; }
        } catch (e) { }
        return null;
    };

    /** 项目里所有序列的名字 + 下标（面板的下拉框用下标定位，名字只用来显示） */
    S.list = function () {
        var out = [];
        try {
            var col = app.project.sequences;
            var n = col.numSequences;
            for (var i = 0; i < n; i++) {
                var o = { index: i, name: "", fps: 0 };
                try { o.name = String(col[i].name); } catch (e1) { o.name = "Sequence " + (i + 1); }
                o.fps = S.frameRate(col[i]);
                out.push(o);
            }
        } catch (e) { }
        return out;
    };

    /** 按名字找序列（同名取第一个）；找不到返回 null */
    S.byName = function (name) {
        try {
            var col = app.project.sequences;
            for (var i = 0; i < col.numSequences; i++) {
                if (String(col[i].name) === String(name)) { return col[i]; }
            }
        } catch (e) { }
        return null;
    };

    /** 序列的起止范围（秒）。end 可能是空（空序列），那时用 0。 */
    S.range = function (seq) {
        var out = { start: 0, end: 0, duration: 0 };
        if (!seq) { return out; }
        try { out.start = S.ticksToSec(seq.zeroPoint); } catch (e) { }
        try { out.end = S.ticksToSec(seq.end); } catch (e2) { }
        out.duration = out.end - out.start;
        if (out.duration < 0) { out.duration = 0; }
        return out;
    };

    S.playerPosition = function (seq) {
        if (!seq) { return 0; }
        try { return S.secOf(seq.getPlayerPosition(), 0); } catch (e) { return 0; }
    };

    /* ---------------------------------------------------------------- 轨道 */

    /** 轨道清单。empty 表示这条轨道上一个剪辑都没有 —— 批量生成时默认挑它。 */
    S.tracks = function (seq, kind) {
        var out = [];
        if (!seq) { return out; }
        var col = null;
        try { col = (kind === "audio") ? seq.audioTracks : seq.videoTracks; } catch (e) { return out; }
        if (!col) { return out; }
        var n = 0;
        try { n = col.numTracks; } catch (e1) { return out; }
        for (var i = 0; i < n; i++) {
            var o = { index: i, name: "", clips: 0, empty: true };
            try { o.name = String(col[i].name); } catch (e2) { }
            try {
                o.clips = col[i].clips.numItems;
                o.empty = (o.clips === 0);
            } catch (e3) { }
            out.push(o);
        }
        return out;
    };

    /** 第一条没有剪辑的视频轨下标；全满就返回最后一条（调用方自己去提醒用户）。 */
    S.firstEmptyVideoTrack = function (seq) {
        var list = S.tracks(seq, "video");
        var i;
        for (i = 0; i < list.length; i++) {
            if (list[i].empty) { return list[i].index; }
        }
        return (list.length > 0) ? list[list.length - 1].index : 0;
    };

    /** 字幕轨清单。PR 2021+ 才有 captionTracks，没有就返回空数组。 */
    S.captionTracks = function (seq) {
        var out = [];
        if (!seq) { return out; }
        var col = null;
        try { col = seq.captionTracks; } catch (e) { return out; }
        if (!col) { return out; }
        var n = 0;
        try { n = col.numTracks; } catch (e1) { return out; }
        for (var i = 0; i < n; i++) {
            var o = { index: i, name: "", clips: 0 };
            try { o.name = String(col[i].name); } catch (e2) { }
            try { o.clips = col[i].clips.numItems; } catch (e3) { }
            out.push(o);
        }
        return out;
    };

    /* ---------------------------------------------------------------- 能力探测 */

    function hasFn(obj, name) {
        try {
            if (!obj) { return false; }
            return (typeof obj[name] === "function") ? true : false;
        } catch (e) { return false; }
    }

    function hasProp(obj, name) {
        try {
            if (!obj) { return false; }
            var v = obj[name];
            return (v === undefined) ? false : true;
        } catch (e) { return false; }
    }

    /**
     * 把当前这台机器上的 PR 到底支持哪些 API 摊开来看。
     * 返回的每行都是「项目 / 结果 / 说明」，面板直接显示。
     * 为什么需要它：PR 各版本 API 差异大，且很多调用失败时**不抛异常**，
     * 只是静默不生效 —— 没有这份探测，出问题只能靠猜。
     */
    S.probe = function () {
        var rows = [];
        function add(name, ok, note) {
            rows.push({ name: name, ok: ok ? true : false, note: note ? String(note) : "" });
        }

        var seq = S.active();
        add("app.project.activeSequence", seq ? true : false,
            seq ? SB.M("当前序列：%1", S.nameOf(seq)) : SB.M("没有打开的序列"));

        add("Sequence.createCaptionTrack", hasFn(seq, "createCaptionTrack"),
            SB.M("生成字幕轨（PR 2021+）"));
        add("Sequence.importMGT", hasFn(seq, "importMGT"),
            SB.M("导入 MOGRT 动态图形模板"));
        add("Sequence.overwriteClip", hasFn(seq, "overwriteClip"),
            SB.M("覆盖式插入剪辑"));
        add("Sequence.insertClip", hasFn(seq, "insertClip"),
            SB.M("插入式剪辑"));
        add("Sequence.captionTracks", hasProp(seq, "captionTracks"),
            SB.M("字幕轨集合"));
        add("Sequence.getSelection", hasFn(seq, "getSelection"),
            SB.M("取当前选中的剪辑"));

        var vTrack = null;
        try { vTrack = seq ? seq.videoTracks[0] : null; } catch (e) { }
        add("Track.overwriteClip", hasFn(vTrack, "overwriteClip"), SB.M("轨道级覆盖插入"));
        add("Track.insertClip", hasFn(vTrack, "insertClip"), SB.M("轨道级插入"));

        var clip = null;
        try {
            var vt = seq ? seq.videoTracks[0] : null;
            if (vt && vt.clips && vt.clips.numItems > 0) { clip = vt.clips[0]; }
        } catch (e2) { }
        add("TrackItem.getMGTComponent", hasFn(clip, "getMGTComponent"),
            clip ? SB.M("在 V1 的第一个剪辑上探测") : SB.M("V1 上没有剪辑，无法探测（先在 V1 放一个图形剪辑再自检）"));

        add("app.project.importFiles", hasFn(app.project, "importFiles"), SB.M("导入文件到项目面板"));
        add("ProjectItem.createBin", hasFn(app.project.rootItem, "createBin"), SB.M("新建素材箱"));

        var prVer = "";
        try { prVer = String(app.version); } catch (e3) { }
        add("app.version", prVer !== "", prVer);

        return { ok: true, rows: rows, seq: seq ? S.nameOf(seq) : "" };
    };

    S.nameOf = function (seq) {
        try { return String(seq.name); } catch (e) { return ""; }
    };

    /** 序列总览：面板「序列」标签页一次拿全 */
    S.info = function () {
        var seq = S.active();
        if (!seq) {
            return {
                ok: false,
                error: SB.M("没有打开的序列。请先在 Premiere Pro 里打开一条时间线（序列），再回到本面板。")
            };
        }
        var r = S.range(seq);
        return {
            ok: true,
            name: S.nameOf(seq),
            fps: S.frameRate(seq),
            start: r.start,
            end: r.end,
            duration: r.duration,
            player: S.playerPosition(seq),
            video: S.tracks(seq, "video"),
            audio: S.tracks(seq, "audio"),
            captions: S.captionTracks(seq),
            sequences: S.list()
        };
    };

    /* ---------------------------------------------------------------- 定位 */

    /** 把播放头挪到某个时间（秒）。批量生成后跳到第一句，方便用户立刻看到结果。 */
    S.seek = function (seq, sec) {
        if (!seq) { return false; }
        try { return seq.setPlayerPosition(S.secToTicks(sec)) ? true : false; }
        catch (e) { return false; }
    };
})();
