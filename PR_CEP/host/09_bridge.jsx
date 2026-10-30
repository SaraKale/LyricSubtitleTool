/* ============================================================================
 *  09_bridge.jsx —— PR 版 CEP 面板的宿主桥接层
 *  ---------------------------------------------------------------------------
 *  和 AE 版的 09_bridge.jsx 是**同一个思路**：面板是 HTML（跑在 Chromium 里），
 *  碰不到 PR 的对象；PR 的对象只有 ExtendScript 能碰。两边靠
 *  CSInterface.evalScript() 通信，传的都是**字符串**。所以这里做一层
 *
 *      JS 侧：  cs.evalScript('SB.invoke("seqInfo","{}")')
 *      JSX 侧： SB.invoke(action, argsJson)  →  返回 JSON 字符串
 *
 *  设计约定（跟 AE 版一致，改之前先看这几条）：
 *
 *   1) 这里是纯逻辑封装，不碰界面。01~03b、06 那几个模块原样复用，一行不改。
 *   2) 参数里的轨道一律用**下标**（0 起），序列用**名字**定位 ——
 *      PR 的序列没有 AE 合成那种稳定编号，名字是用户唯一能对得上的东西。
 *   3) 长任务（扫描 / 在线搜索 / 批量生成）的进度不回调到 JS
 *      （evalScript 是同步阻塞的），改成写进 BR.state.log，JS 定时调 "log" 取走。
 *   4) 需要用户确认的地方**不在宿主里弹窗**：ExtendScript 的 confirm() 是模态的，
 *      在 CEP 里会卡在 PR 主窗口后面。改成返回 needConfirm，让 JS 用 HTML 弹。
 *   5) 一切 ExtendScript 的老规矩照旧：ES3 语法、没有原生 JSON（用 SB.JSON）。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var L = root.Lrc;
    var ON = root.Online;
    var S = root.Seq;
    var C = root.Cap;
    var G = root.Gfx;

    var BR = {};
    root.Bridge = BR;

    BR.build = "dev";

    /** 「v1.0.0(2026-09-20)」这一串的唯一拼法，面板和自检报告共用 */
    BR.versionLine = function () {
        return "v" + SB.VERSION + "(" + SB.VERSION_DATE + ")";
    };

    /* 跨调用要记住的东西。CEP 扩展的 ExtendScript 引擎在面板生命周期内一直活着，
     * evalScript 每次都跑在同一个引擎里，所以这个对象自然还在。
     * （注意：**不要**为此去写 #targetengine —— 那会把宿主切到另一个引擎，
     *  反而让面板侧的 SB 和宿主侧的 SB 不是同一个对象。） */
    BR.state = {
        text: "",           // 当前歌词原文
        translated: "",     // 当前译文（双语用）
        files: [],          // 扫描到的歌词文件
        songs: [],          // 在线搜索结果
        current: null,      // 当前选中的在线歌曲
        source: "",         // 当前歌词的来源描述，显示在状态栏
        log: []
    };

    /* ---------------------------------------------------------------- 小工具 */

    function num(v, def) {
        try { return U.toNumber(v, def); } catch (e) { return def; }
    }

    function push(msg) {
        try {
            BR.state.log.push(String(msg));
            if (BR.state.log.length > 300) { BR.state.log.shift(); }
        } catch (e) { }
    }

    /**
     * 跑一个「可能要去网上取数据」的动作。
     *
     * AE 的宿主自己能发请求（system.callSystem + curl），一次就出结果。
     * Premiere Pro 的 ExtendScript **没有 system 对象**，06_online 会把想取的
     * URL 记下来抛 FETCH_REQUIRED；这里接住，转成「面板请代取这些 URL」的响应。
     * 面板 fetch 完调 onlineDeliver 喂回缓存，再重放同一个动作 —— 这次就通了。
     *
     * 注意：重放是面板发起的，宿主这边是无状态的（只认 fetchCache）。
     */
    function runWithFetch(fn) {
        try { ON.clearFetchNeeds(); } catch (e0) { }
        try {
            return fn();
        } catch (e) {
            if (ON.isFetchRequired(e)) {
                try { ON.trimFetchCache(); } catch (e1) { }
                return {
                    ok: false,
                    needFetch: ON.needFetch || [],
                    error: SB.M("这台宿主的脚本引擎不能直接发网络请求，改由面板代取（面板会自动继续，不用你操作）。")
                };
            }
            throw e;
        }
    }

    /** 解析 + 建帧，预览和生成两处共用 —— 保证「预览看到什么，生成就是什么」 */
    function buildFrames(a) {
        var text = String(a.text || "");
        if (U.trim(text) === "") {
            return { error: SB.M("歌词内容是空的（先打开文件 / 扫描文件夹 / 粘贴一段进来）") };
        }
        var fo = L.defaultFrameOptions();
        var f = a.frame || {};
        fo.defaultDuration = num(f.defaultDur, 2);
        fo.gap = num(f.gap, 0.02);
        fo.minDuration = num(f.minDur, 0.3);
        fo.maxDuration = num(f.maxDur, 0);
        fo.startOffset = num(f.offset, 0);
        fo.leadIn = num(f.leadIn, 0);
        fo.leadOut = num(f.leadOut, 0);
        fo.mergeTolerance = num(f.mergeTol, 0.02);
        fo.untimedMode = "mergePrev";
        fo.bilingualLayout = (f.biLayout === "sameLine") ? "sameLine" : "stack";
        fo.bilingualOrder = (f.biOrder === "BA") ? "BA" : "AB";
        fo.splitLines = (f.biLayer === "split") || !!f.splitLines;
        fo.useStyle = (a.assStyle !== false);

        var parsed;
        if (a.hasTrans && U.trim(String(a.translated || "")) !== "") {
            parsed = L.pairBilingual(text, a.translated, { matchTolerance: num(a.matchTol, 0.6) });
        } else {
            /* parseAuto 而不是 parse：同一段文本可能是 SRT / ASS / VTT，
             * 认出来就走那边的解析器，认不出来（LRC / 纯文本）才回头走 LRC。 */
            parsed = L.parseAuto(text, { group: "A" });
        }
        var frames = L.buildFrames(parsed, fo);
        if (!frames || frames.length === 0) {
            return {
                error: SB.M("没有解析出任何字幕行：LRC 要有 [00:12.34] 这种时间码，SRT / VTT 要有 00:00:01,000 --> 00:00:03,000，ASS 要有 Dialogue: 行。")
            };
        }
        return { parsed: parsed, frames: frames };
    }

    function readLyricFile(path, name, enc) {
        var r = null;
        try { r = U.readTextAuto(path, enc); }
        catch (e) { return { ok: false, error: SB.M("读取异常：%1", e.toString()) }; }
        if (!r.ok || U.trim(r.text) === "") {
            return {
                ok: false,
                error: SB.M("这个文件的编码识别不了（%1）。请在「编码」里手动选 GBK / GB2312 / BIG5 再试一次。", (r ? r.encoding : "?"))
            };
        }
        var out = {
            ok: true, text: r.text, name: name, encoding: r.encoding,
            lines: r.text.split("\n").length
        };
        if (root.Sub) {
            var fmt = root.Sub.formatOfName(name);
            if (!fmt) { fmt = root.Sub.detect(r.text); }
            if (fmt === "srt" || fmt === "ass" || fmt === "vtt") {
                out.format = fmt;
                out.formatLabel = root.Sub.FORMAT_LABELS[fmt] || fmt;
            }
        }
        return out;
    }

    /** 预览用的行（只挑面板要显示的字段，别把整个 frames 丢过去） */
    function previewRows(frames, max) {
        if (!max) { max = 400; }
        var out = [];
        var n = frames.length > max ? max : frames.length;
        for (var i = 0; i < n; i++) {
            var fr = frames[i];
            out.push({
                index: i + 1,
                start: fr.start,
                end: fr.end,
                dur: fr.end - fr.start,
                text: fr.text,
                sub: fr.sub ? true : false,
                role: fr.role || ""
            });
        }
        return out;
    }

    /* ---------------------------------------------------------------- 动作表 */

    var API = {};

    /* --- 环境 --- */

    API.hello = function () {
        var v = "";
        try { v = String(app.version); } catch (e) { v = "?"; }
        var proj = "";
        try { proj = String(app.project.name); } catch (e1) { }
        var seqName = "";
        try {
            var sq = S.active();
            if (sq) { seqName = S.nameOf(sq); }
        } catch (e2) { }
        return {
            ok: true,
            build: BR.build,
            pr: v,
            engine: "ExtendScript " + $.version,
            version: SB.VERSION,
            versionDate: SB.VERSION_DATE,
            project: proj,
            sequence: seqName,
            host: "PPRO",
            lang: SB.lang,
            langs: SB.LANGS
        };
    };

    API.setLang = function (a) {
        var l = SB.setLang(String(a.lang || "zh"));
        var info = SB.langInfo();
        return { ok: true, lang: l, tables: info.tables, langs: SB.LANGS };
    };

    API.log = function () {
        var out = BR.state.log;
        BR.state.log = [];
        return { ok: true, lines: out };
    };

    API.clearLog = function () {
        BR.state.log = [];
        return { ok: true };
    };

    /* --- 序列 / 环境探测 --- */

    API.seqInfo = function () {
        return S.info();
    };

    API.probe = function () {
        return S.probe();
    };

    /* --- 歌词来源：文件 --- */

    /**
     * 面板递过来的路径 → File 对象。没给、或者文件已经不在了，返回 null，
     * 调用方就照旧弹自己的对话框（老面板、失效路径都不会崩）。
     *
     * 为什么会有这条路：PR 的 File.openDialog **没有 owner 窗口**，第一次弹
     * 会被排到 PR 主窗口后面去（用户得去任务栏点出来）。所以面板先用
     * cep.fs.showOpenDialog 自己选好，再把真实路径传进来，这里只负责读。
     * 详见 client/app.js 里 pickPath 的注释。
     */
    function fileFromPath(a) {
        if (!a || !a.path) { return null; }
        var f = null;
        try { f = new File(String(a.path)); } catch (e) { return null; }
        if (!f || !f.exists) { return null; }
        return f;
    }

    function folderFromPath(a) {
        if (!a || !a.path) { return null; }
        var d = null;
        try { d = new Folder(String(a.path)); } catch (e2) { return null; }
        if (!d || !d.exists) { return null; }
        return d;
    }

    API.openFile = function (a) {
        var f = fileFromPath(a);
        if (!f) {
            f = File.openDialog(SB.M("选择歌词 / 字幕文件"),
                SB.M("歌词字幕:*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt;*.json,所有文件:*.*"), false);
        }
        if (!f) { return { ok: false, canceled: true }; }
        var r = readLyricFile(f.fsName, f.name, a.encoding);
        if (!r.ok) { return r; }
        BR.state.text = r.text;
        BR.state.translated = "";
        BR.state.source = f.name;
        r.source = f.name;
        r.path = f.fsName;
        return r;
    };

    /** 打开一个文件并直接当作「译文」放进来（双语对轴用） */
    API.openTranslated = function (a) {
        var f = fileFromPath(a);
        if (!f) {
            f = File.openDialog(SB.M("选择译文文件"),
                SB.M("歌词字幕:*.lrc;*.srt;*.ass;*.ssa;*.vtt;*.txt,所有文件:*.*"), false);
        }
        if (!f) { return { ok: false, canceled: true }; }
        var r = readLyricFile(f.fsName, f.name, a.encoding);
        if (!r.ok) { return r; }
        BR.state.translated = r.text;
        r.source = f.name;
        r.path = f.fsName;
        return r;
    };

    API.scanFolder = function (a) {
        var folder = folderFromPath(a);
        if (!folder) { folder = Folder.selectDialog(SB.M("选择包含歌词文件的文件夹")); }
        if (!folder) { return { ok: false, canceled: true }; }
        var files = folder.getFiles();
        var hits = [];
        for (var i = 0; i < files.length; i++) {
            var p = files[i];
            /* 正向判断「是文件」而不是「不是文件夹」：getFiles() 里混着 Folder 对象，
             * 反过来判断在部分版本上会漏掉 instanceof 的兼容问题。 */
            var isFileObj = false;
            try { isFileObj = (p instanceof File); } catch (e) { isFileObj = false; }
            if (!isFileObj) { continue; }
            var nm = String(p.name);
            if (nm.charAt(0) === ".") { continue; }
            if (U.looksLikeLyricsName(nm) || U.sniffLyricsFile(p.fsName)) {
                hits.push({ name: nm, path: p.fsName });
            }
        }
        /* 按文件名排序，用户找起来有顺序感 */
        hits.sort(function (x, y) {
            return (x.name < y.name) ? -1 : ((x.name > y.name) ? 1 : 0);
        });
        BR.state.files = hits;
        var out = [];
        for (var k = 0; k < hits.length; k++) {
            out.push({ index: k, name: hits[k].name });
        }
        return {
            ok: true, files: out, count: out.length, folder: folder.fsName,
            info: SB.M("扫到 %1 个候选歌词文件", out.length)
        };
    };

    API.pickFile = function (a) {
        var idx = num(a.index, -1);
        if (!(idx >= 0) || idx >= BR.state.files.length) {
            return { ok: false, error: SB.M("文件下标越界，重新扫一次文件夹") };
        }
        var info = BR.state.files[idx];
        var r = readLyricFile(info.path, info.name, a.encoding);
        if (!r.ok) { return r; }
        BR.state.text = r.text;
        BR.state.source = info.name;
        r.source = info.name;
        r.path = info.path;
        return r;
    };

    /** 直接塞一段文本进来（粘贴 / 前端文本框） */
    API.setText = function (a) {
        var t = String(a.text || "");
        BR.state.text = t;
        BR.state.source = a.source ? String(a.source) : SB.M("（手动粘贴）");
        return { ok: true, text: t, lines: t.split("\n").length, source: BR.state.source };
    };

    API.setTranslated = function (a) {
        var t = String(a.text || "");
        BR.state.translated = t;
        return { ok: true, text: t, lines: t.split("\n").length };
    };

    /**
     * 读系统剪贴板。
     * ExtendScript 没有剪贴板 API，面板里的 document.execCommand("paste") 在 CEP 里
     * 也是被禁的，所以只能借系统的命令：Windows 走 powershell 的 Get-Clipboard，
     * macOS 走 pbpaste。取不到就明确说「直接在文本框里 Ctrl+V」——
     * 面板本身就是 Chromium，文本框里手动粘贴一直是能用的。
     */
    API.paste = function () {
        var txt = "";
        try {
            if ($.os.indexOf("Windows") >= 0) {
                txt = system.callSystem("powershell -NoProfile -Command \"Get-Clipboard -Raw\"");
            } else {
                txt = system.callSystem("/usr/bin/pbpaste");
            }
        } catch (e) { txt = ""; }
        if (txt === null || txt === undefined || U.trim(txt) === "") {
            return { ok: false, error: SB.M("剪贴板是空的，或者读取失败。可以直接在文本框里粘贴（Ctrl+V）。") };
        }
        BR.state.text = txt;
        BR.state.source = SB.M("剪贴板");
        return {
            ok: true, text: txt, name: SB.M("剪贴板"),
            encoding: SB.M("按系统编码"), lines: txt.split("\n").length,
            source: BR.state.source
        };
    };

    /* --- 解析预览 --- */

    API.preview = function (a) {
        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: r.error }; }
        var frames = r.frames;
        var stats = {
            count: frames.length,
            first: frames[0].start,
            last: frames[frames.length - 1].end,
            total: frames[frames.length - 1].end - frames[0].start,
            sub: 0
        };
        for (var i = 0; i < frames.length; i++) {
            if (frames[i].sub) { stats.sub++; }
        }
        stats.main = stats.count - stats.sub;
        return { ok: true, rows: previewRows(frames), stats: stats, count: frames.length };
    };

    /* --- 在线歌词 --- */

    /**
     * 告诉面板：这台宿主能不能自己发网络请求。
     * AE 能（system.callShell + curl），PR 不能（没有 system 对象）——
     * 不能的时候由面板的 Chromium 代取，面板据此决定要不要走重放流程。
     */
    API.onlineCapability = function () {
        var can = false;
        try { can = ON.hasLocalShell(); } catch (e) { }
        var c = 0;
        try {
            for (var k in ON.fetchCache) {
                if (ON.fetchCache.hasOwnProperty(k)) { c++; }
            }
        } catch (e2) { }
        return {
            ok: true,
            localShell: can,
            transport: ON.lastTransport || "",
            cached: c,
            note: can
                ? SB.M("宿主自己发请求（curl / PowerShell）")
                : SB.M("宿主不能发请求，由面板代取（CEP 面板的 Chromium 直接发 HTTPS）")
        };
    };

    /** 面板把取回来的内容喂进缓存。items = [{ url, text, error }] */
    API.onlineDeliver = function (a) {
        var items = a.items || [];
        var okCount = 0, fails = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it || !it.url) { continue; }
            if (it.error) {
                fails.push(String(it.url) + " → " + String(it.error));
                continue;
            }
            ON.feedFetch(it.url, it.text);
            okCount++;
        }
        try { ON.trimFetchCache(); } catch (e) { }
        return {
            ok: true, count: okCount, failed: fails,
            error: (fails.length > 0 && okCount === 0)
                ? SB.M("面板代取失败：%1", fails.join("；")) : ""
        };
    };

    API.onlineProbe = function (a) {
        var r = null;
        try { r = ON.probeOnline(String(a.keyword || "")); }
        catch (e) {
            if (ON.isFetchRequired(e)) {
                return { ok: false, needFetch: ON.needFetch || [], error: SB.M("需要面板代取。") };
            }
            return { ok: false, error: String(e) };
        }
        r = r || {};
        r.ok = (r.ok === undefined) ? true : r.ok;
        r.transport = ON.lastTransport || "";
        return r;
    };

    API.onlineSearch = function (a) {
        var platform = String(a.platform || "netease");
        var keyword = U.trim(String(a.keyword || ""));
        if (keyword === "") { return { ok: false, error: SB.M("先填歌名 / 歌手，再搜索") }; }
        var t0 = new Date().getTime();
        var res = runWithFetch(function () { return ON.search(platform, keyword); });
        if (res && res.needFetch) { return res; }
        if (!res || !res.songs) {
            return { ok: false, error: (res && res.error) ? res.error : SB.M("没有搜到结果（也可能是网络不通）") };
        }
        BR.state.songs = res.songs;
        var ms = new Date().getTime() - t0;
        var out = [];
        for (var i = 0; i < res.songs.length; i++) {
            var s = res.songs[i];
            out.push({
                index: i,
                name: String(s.name || ""),
                artist: String(s.artist || ""),
                album: String(s.album || ""),
                platform: String(s.platform || platform)
            });
        }
        return {
            ok: true, songs: out, count: out.length,
            info: SB.M("找到 %1 首（用时 %2 ms，通道：%3）", out.length, ms, (ON.lastTransport || SB.M("无")))
        };
    };

    API.onlinePick = function (a) {
        var idx = num(a.index, -1);
        if (!(idx >= 0) || idx >= BR.state.songs.length) {
            return { ok: false, error: SB.M("歌曲下标越界，重新搜一次") };
        }
        var s = BR.state.songs[idx];
        var res = runWithFetch(function () { return ON.fetchLyrics(s); });
        if (res && res.needFetch) { return res; }
        if (!res || !res.ok) {
            return { ok: false, error: (res && res.error) ? res.error : SB.M("这首歌没有取到歌词") };
        }
        BR.state.current = s;
        BR.state.text = res.original || "";
        BR.state.translated = res.translated || "";
        BR.state.source = String(s.name) + (s.artist ? (" - " + s.artist) : "");
        var origLines = BR.state.text.split("\n").length;
        var transLines = (U.trim(BR.state.translated) === "") ? 0 : BR.state.translated.split("\n").length;
        return {
            ok: true,
            name: String(s.name),
            artist: String(s.artist || ""),
            original: BR.state.text,
            translated: BR.state.translated,
            hasTrans: transLines > 0,
            info: SB.M("《%1》原文 %2 行%3", String(s.name), origLines,
                transLines > 0 ? SB.M("，译文 %1 行", transLines) : "")
        };
    };

    /* --- 导出 / 生成 --- */

    API.exportSrt = function (a) {
        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: r.error }; }
        var res = C.exportSrt(r.frames, {
            offset: num(a.offset, 0),
            minDur: num((a.frame || {}).minDur, 0),
            maxDur: num((a.frame || {}).maxDur, 0),
            merge: (a.mergeSrt === false) ? false : true
        }, a.path || "");
        if (!res.ok) { return res; }
        return {
            ok: true, path: res.path, count: res.count,
            info: SB.M("已写出 SRT：%1（%2 条）", res.path, res.count)
        };
    };

    /** 生成 PR 原生字幕轨（SRT 通道） */
    API.buildCaption = function (a) {
        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: r.error }; }

        push(SB.M("开始生成字幕轨……"));
        var res = C.createTrack(r.frames, {
            offset: num(a.offset, 0),
            minDur: num((a.frame || {}).minDur, 0),
            maxDur: num((a.frame || {}).maxDur, 0),
            merge: (a.mergeSrt === false) ? false : true,
            seqName: a.seqName ? String(a.seqName) : "",
            binName: a.binName ? String(a.binName) : ""
        });
        if (res.ok) {
            push(SB.M("字幕轨生成完成：%1 条", res.count));
            /* 顺手探一下「字幕剪辑能不能改文字」。一次调用就把这个问题永久关掉，
               省得以后再猜；探测是只读的，不会动任何东西。 */
            try {
                res.captionProbe = G.probeCaptionText(a.seqName ? String(a.seqName) : "");
            } catch (eP) { }
        } else {
            push(SB.M("字幕轨生成失败：%1", res.error || ""));
        }
        res.rows = previewRows(r.frames, 60);
        return res;
    };

    API.inspectCaptions = function (a) {
        return C.inspect(a.seqName ? String(a.seqName) : "");
    };

    /** 单独探一次「字幕剪辑能不能当文字载体」（只读）。 */
    API.probeCaptionText = function (a) {
        return G.probeCaptionText(a && a.seqName ? String(a.seqName) : "");
    };

    /* --- 图形剪辑通道 --- */

    API.gfxSources = function () {
        return G.sources();
    };

    /** 扫系统自带的 .mogrt 模板（PR 安装目录 + Adobe 公共模板目录）。 */
    API.gfxMogrts = function () {
        return G.mogrtList();
    };

    /** 读某个母版的参数列表。source 的形态和 gfxBuild 的 opts.source 一致。 */
    API.gfxParams = function (a) {
        var seq = S.active();
        if (!seq) { return { ok: false, error: SB.M("没有打开的序列。") }; }
        var src = a.source || {};
        var kind = String(src.kind || "selection");
        var clip = null;

        if (kind === "selection") {
            clip = G.selectedClip(seq);
            if (!clip) { return { ok: false, error: SB.M("时间线上没有选中的剪辑。") }; }
        } else if (kind === "track") {
            clip = G.clipOnTrack(seq, src.clipKind || "video",
                num(src.trackIndex, -1), num(src.clipIndex, -1));
            if (!clip) { return { ok: false, error: SB.M("时间线上找不到这个剪辑。点「刷新」重新挑一个。") }; }
        } else {
            /* mogrt / project 这两种来源没法凭空造一个剪辑来读参数 ——
             * 让用户先试跑一条，试跑完参数列表会一起回来。这里明确说清楚。 */
            return {
                ok: false,
                needTry: true,
                error: SB.M("这个来源的参数要等第一条生成出来才能读到。请先点「试跑一条」。")
            };
        }
        var r = G.paramsOf(clip);
        if (!r.ok) { return r; }
        var pick = G.autoPickText(clip);
        r.picked = pick.ok ? pick.name : "";
        return r;
    };

    /** 选一个 .mogrt 文件。面板会先用 cep.fs 选好并把路径递过来；
     *  没递（老面板 / cep.fs 不可用）才在这里自己弹。 */
    API.pickMogrt = function (a) {
        var f = fileFromPath(a);
        if (!f) {
            f = File.openDialog(SB.M("选择 MOGRT 动态图形模板"),
                SB.M("Motion Graphics Templates:*.mogrt,所有文件:*.*"), false);
        }
        if (!f) { return { ok: false, canceled: true }; }
        return { ok: true, path: f.fsName, name: f.name };
    };

    API.gfxBuild = function (a) {
        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: r.error }; }

        push(SB.M("开始批量生成图形剪辑……"));
        var res = G.build(r.frames, {
            source: a.source || { kind: "selection" },
            vTrack: num(a.vTrack, -1),
            aTrack: num(a.aTrack, 0),
            offset: num(a.offset, 0),
            textParam: a.textParam ? String(a.textParam) : "",
            newline: a.newline ? String(a.newline) : "\r",
            merge: (a.mergeSrt === false) ? false : true,
            minDur: num((a.frame || {}).minDur, 0),
            maxDur: num((a.frame || {}).maxDur, 0),
            sizeParam: a.sizeParam ? String(a.sizeParam) : "",
            sizeValue: a.sizeValue,
            colorParam: a.colorParam ? String(a.colorParam) : "",
            colorRgb: a.colorRgb,
            limit: num(a.limit, 0)
        });
        if (res.ok) {
            push(SB.M("图形剪辑生成完成：%1 / %2 条", res.count, res.total));
        } else {
            push(SB.M("图形剪辑生成失败：%1", res.error || ""));
        }
        res.rows = previewRows(r.frames, 60);
        return res;
    };

    API.gfxTryOne = function (a) {
        var r = buildFrames(a);
        if (r.error) { return { ok: false, error: r.error }; }
        var res = G.tryOne(r.frames, {
            source: a.source || { kind: "selection" },
            vTrack: num(a.vTrack, -1),
            aTrack: num(a.aTrack, 0),
            offset: num(a.offset, 0),
            textParam: a.textParam ? String(a.textParam) : "",
            newline: a.newline ? String(a.newline) : "\r",
            merge: (a.mergeSrt === false) ? false : true
        });
        res.rows = previewRows(r.frames, 3);
        return res;
    };

    /* --- 自检 --- */

    API.selftest = function () {
        var out = { ok: true, rows: [], report: "" };
        function row(name, ok, note) {
            out.rows.push({ name: name, ok: ok ? true : false, note: note ? String(note) : "" });
        }

        row(SB.M("宿主"), true, "Premiere Pro " + (function () { try { return String(app.version); } catch (e) { return "?"; } })());
        row(SB.M("桥接层 SB.Bridge.invoke"), (typeof BR.invoke === "function"), BR.build);
        row(SB.M("版本"), true, BR.versionLine());

        var seq = S.active();
        row(SB.M("打开的序列"), seq ? true : false, seq ? S.nameOf(seq) : SB.M("没有（先打开一条时间线）"));
        if (seq) {
            row(SB.M("序列帧率"), S.frameRate(seq) > 0, S.frameRate(seq).toFixed(3) + " fps");
            var vt = S.tracks(seq, "video");
            var empty = 0, i;
            for (i = 0; i < vt.length; i++) { if (vt[i].empty) { empty++; } }
            row(SB.M("视频轨道"), vt.length > 0, SB.M("%1 条，其中 %2 条是空的", vt.length, empty));

            /* 音频轨必须报 —— 图形剪辑插入时要把音频轨下标一起传过去，
             * 序列没有音频轨就得传 -1，否则 overwriteClip 会**静默失败**
             * （不抛异常也不返回 false），症状是「每条都插入失败」。
             * 之前自检没报这一项，排查时只能靠猜。 */
            var at = S.tracks(seq, "audio");
            row(SB.M("音频轨道"), true, at.length > 0
                ? SB.M("%1 条（插入图形剪辑时会用到第 1 条）", at.length)
                : SB.M("0 条 —— 插入图形剪辑时会自动传 -1（没有音频轨时的正确做法）"));

            var ct = S.captionTracks(seq);
            row(SB.M("字幕轨道"), true, SB.M("%1 条", ct.length));
        }

        row(SB.M("字幕解析 L.parseAuto"), (typeof L.parseAuto === "function"), "03_lrc / 03b_sub");
        row(SB.M("在线歌词 ON.search"), (typeof ON.search === "function"), (ON.lastTransport || SB.M("未用过")));
        row(SB.M("字幕轨 API"), (seq && typeof seq.createCaptionTrack === "function"), "Sequence.createCaptionTrack");
        row(SB.M("MOGRT 导入"), (seq && typeof seq.importMGT === "function"), "Sequence.importMGT");

        var clip = G.selectedClip(seq);
        /* 这一项只做「有就顺手显示」，没选中**不是问题** —— 图形剪辑的母版
         * 完全可以用 MOGRT 文件 / 项目面板素材 / 时间线上的剪辑坐标来指定，
         * 不需要依赖选中状态。所以这里恒为 true，不参与「需要注意」的计数，
         * 免得用户看到一个红叉以为哪里坏了。 */
        row(SB.M("当前选中的剪辑"), true,
            clip ? (String(clip.name) + " @ " + U.formatTimecode(S.secOf(clip.start, 0), true))
                 : SB.M("没有（不影响：母版可以改用 MOGRT 文件 / 项目面板素材 / 剪辑坐标）"));
        if (clip) {
            var pr = G.paramsOf(clip);
            row(SB.M("选中剪辑的图形参数"), pr.ok, pr.ok ? SB.M("%1 个参数", pr.count) : pr.error);
        }

        row(SB.M("i18n 语言"), true, SB.lang + " / " + SB.langInfo().tables);

        var bad = 0;
        for (var k = 0; k < out.rows.length; k++) {
            if (!out.rows[k].ok) { bad++; }
        }
        out.bad = bad;
        out.report = SB.M("自检完成：%1 项，%2 项需要注意", out.rows.length, bad);
        return out;
    };

    /* ---------------------------------------------------------------- 分发 */

    BR.invoke = function (action, argsJson) {
        var a = {};
        if (argsJson !== undefined && argsJson !== null && String(argsJson) !== "") {
            try { a = SB.JSON.parse(String(argsJson)); } catch (e) { a = {}; }
        }
        if (!a) { a = {}; }

        var fn = API[action];
        if (typeof fn !== "function") {
            return SB.JSON.stringify({ ok: false, error: SB.M("未知动作：%1", String(action)) });
        }

        var out = null;
        try {
            out = fn(a);
        } catch (e2) {
            var msg = "";
            try { msg = (e2 && e2.description) ? String(e2.description) : String(e2); } catch (e3) { msg = "?"; }
            out = { ok: false, error: SB.M("动作「%1」执行出错：%2", String(action), msg) };
        }
        if (!out) { out = { ok: true }; }
        if (out.ok === undefined) { out.ok = true; }
        out.build = BR.build;

        try {
            return SB.JSON.stringify(out);
        } catch (e4) {
            return '{"ok":false,"error":"\\u7ed3\\u679c\\u65e0\\u6cd5\\u5e8f\\u5217\\u5316"}';
        }
    };
})();
