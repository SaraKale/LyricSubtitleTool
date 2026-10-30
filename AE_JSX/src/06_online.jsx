/* ============================================================================
 *  06_online.jsx —— 在线歌词搜索（网易云音乐 / QQ 音乐）
 *  ---------------------------------------------------------------------------
 *  ExtendScript 没有 XMLHttpRequest，也没法直接做 HTTPS。
 *  所以这里用最土但最稳的办法：调系统自带的 curl.exe 下载到临时文件，
 *  再用 File + 编码识别读回来（见 02_util.jsx 的 readTextAuto）。
 *
 *    Windows 10 1803+ / Windows 11 自带 C:\Windows\System32\curl.exe
 *    macOS 自带 /usr/bin/curl
 *  找不到 curl 时降级到 PowerShell 的 Invoke-WebRequest。
 *
 *  接口参考（与 MMT Subtitle Editor 项目一致）：
 *    网易云搜索  https://music.163.com/api/search/get?s=<kw>&type=1&offset=0&limit=30&total=true
 *    网易云歌词  https://music.163.com/api/song/lyric?os=pc&id=<id>&lv=-1&tv=-1
 *    QQ 搜索     https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=30&w=<kw>&format=json&new_json=1
 *    QQ 歌词     https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=<mid>&format=json&nobase64=1
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;
    var U = root.Util;
    var ON = {};

    ON.UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    /* 平台清单是**数据**（id → 显示名）：显示名不给界面直接用，
     * 面板上的平台下拉是自己写死的中文标签，翻译在 ui.json 里。 */
    /* i18n-allow */
    ON.PLATFORMS = [
        { id: "netease", name: "网易云音乐" },
        { id: "qq", name: "QQ 音乐" }
    ];
    /* i18n-allow-end */

    ON.REFERER = {
        netease: "https://music.163.com/",
        qq: "https://y.qq.com/portal/player.html"
    };

    /* ------------------------------------------------------------------ 命令行工具 */

    ON.findCurl = function () {
        var candidates = [];
        var isWin = false;
        try { isWin = ($.os.indexOf("Windows") >= 0); } catch (e) { isWin = true; }

        if (isWin) {
            candidates.push("C:/Windows/System32/curl.exe");
            candidates.push("C:/Windows/SysWOW64/curl.exe");
            candidates.push("C:/Program Files/Git/mingw64/bin/curl.exe");
        } else {
            candidates.push("/usr/bin/curl");
            candidates.push("/usr/local/bin/curl");
            candidates.push("/opt/homebrew/bin/curl");
        }
        for (var i = 0; i < candidates.length; i++) {
            if (U.fileExists(candidates[i])) { return candidates[i]; }
        }
        return "curl";
    };

    function quote(s) {
        return "\"" + String(s) + "\"";
    }

    function buildCommand(exe, args) {
        var parts = [quote(exe)];
        for (var i = 0; i < args.length; i++) { parts.push(quote(args[i])); }
        return parts.join(" ");
    }

    function readDownloaded(outFile, stdout) {
        var f = new File(outFile);
        if (!f.exists || f.length === 0) {
            var msg = U.trim(stdout || "");
            return {
                ok: false,
                error: SB.M("下载失败，没有拿到数据%1", (msg !== "" ? SB.M("：%1", msg.substr(0, 200)) : SB.M("（请检查网络 / 代理）")))
            };
        }
        return { ok: true, file: outFile };
    }

    ON.callCurl = function (url, referer, outFile) {
        var exe = ON.findCurl();
        /* 参数说明（踩过的坑都写在这）：
         *  -s              静默模式，不要进度条
         *  -L              跟随 302
         *  -m 25           25 秒超时
         *  -A <UA>         带浏览器 UA，音乐接口没有 UA 会直接拒绝
         *  -e <referer>    带 Referer
         *  -o <file>       写到文件（ExtendScript 拿不到管道输出，只能落盘再读）
         * 不加 --compressed：Windows 自带的那份 libcurl 是精简版，
         * 没有编进 zlib，一加 --compressed 就直接报
         * "the installed libcurl version doesn't support this"。
         * 不加它也不会拿到乱码：不带 Accept-Encoding 时服务器不会发 gzip。
         */
        var args = ["-s", "-L", "-m", "25", "-A", ON.UA];
        if (referer) { args.push("-e"); args.push(referer); }
        args.push("-o"); args.push(outFile);
        args.push(url);

        var stdout = "";
        try {
            stdout = system.callSystem(buildCommand(exe, args));
        } catch (e) {
            return { ok: false, error: SB.M("调用 curl 出错：%1", e.toString()) };
        }
        return readDownloaded(outFile, stdout);
    };

    ON.PS1_SOURCE = [
        "param([string]$UrlFile,[string]$OutFile,[string]$Referer)",
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$url = (Get-Content -LiteralPath $UrlFile -Encoding UTF8 -Raw).Trim()",
        "$headers = @{ 'User-Agent' = '" + ON.UA + "' }",
        "if ($Referer -ne '-') { $headers['Referer'] = $Referer }",
        "Invoke-WebRequest -UseBasicParsing -Uri $url -Headers $headers -TimeoutSec 25 -OutFile $OutFile",
        "exit 0"
    ].join("\r\n");

    ON.callPowerShell = function (url, referer, outFile) {
        try {
            var dir = U.tempDir();
            var ps1 = dir + "/sb_http.ps1";
            var urlFile = dir + "/sb_url.txt";

            var pf = new File(ps1);
            pf.encoding = "UTF-8";
            if (!pf.open("w")) { return { ok: false, error: SB.M("无法写入临时脚本") }; }
            pf.write(ON.PS1_SOURCE);
            pf.close();

            var uf = new File(urlFile);
            uf.encoding = "UTF-8";
            if (!uf.open("w")) { return { ok: false, error: SB.M("无法写入临时文件") }; }
            uf.write(url);
            uf.close();

            var cmd = buildCommand("powershell", [
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
                urlFile, outFile, (referer || "-")
            ]);
            var stdout = system.callSystem(cmd);
            return readDownloaded(outFile, stdout);
        } catch (e) {
            return { ok: false, error: SB.M("调用 PowerShell 出错：%1", e.toString()) };
        }
    };

    ON.lastTransport = "";

    /**
     * 进度回调。
     * 面板里的搜索是「同步阻塞」的（system.callSystem 不返回，界面就不刷），
     * 所以这里每换一个阶段都回调一次，让面板把当前进度写出来。
     * 万一卡住，用户看到的最后一句就是卡在哪一步，而不是干瞪眼「正在搜索」。
     */
    ON.onProgress = null;

    function progress(msg) {
        ON.lastProgress = msg;
        if (typeof ON.onProgress === "function") {
            try { ON.onProgress(msg); } catch (e) { }
        }
    }

    ON.lastProgress = "";

    /** 探到的可用通道缓存：探一次就够了，别每次搜索都白等一次超时 */
    ON._transportCache = null;

    /* ------------------------------------------------------------------ 面板代取（CEP）

     * Premiere Pro 的 ExtendScript **没有 system 对象** —— 那是 After Effects
     * 那边才有的。所以 system.callSystem("curl …") 这条路在 PR 里一调用就报
     * 「ReferenceError: system is undefined」，PowerShell 兜底也一样。
     * 而 ExtendScript 又做不了 HTTPS（Socket 只有裸 TCP，没有 TLS）。
     *
     * 绕法：CEP 面板本身是 Chromium，发 HTTPS 是它的本能。于是把「取数据」
     * 这一步外包给面板：
     *   ① 宿主想取某个 URL 时先查 fetchCache（面板刚喂回来的）；
     *   ② 没缓存、又没有本地 shell → 记下这个 URL 并抛 FETCH_REQUIRED；
     *   ③ 桥接层捕获它，把待取清单回给面板；
     *   ④ 面板 fetch 完调 onlineDeliver 把内容塞进 fetchCache；
     *   ⑤ 面板**重放**刚才那个动作 —— 这次缓存命中，一路跑到底。
     * 搜索是两跳的（先搜到歌曲、再拿歌词），所以可能要往返两轮，
     * 面板那边设了重放上限兜底。
     *
     * 这条通道对 AE 完全透明：AE 有 system，永远走不到这里。
     */
    ON.fetchCache = {};
    ON.needFetch = [];
    ON.FETCH_REQUIRED = "LST_FETCH_REQUIRED";

    /** 宿主这边能不能自己发网络请求（AE 能，PR 不能） */
    ON.hasLocalShell = function () {
        try {
            return (typeof system !== "undefined" && system &&
                typeof system.callSystem === "function") ? true : false;
        } catch (e) { return false; }
    };

    /** 判断一个异常是不是「需要面板代取」 */
    ON.isFetchRequired = function (e) {
        if (!e) { return false; }
        var s = "";
        try { s = String(e.message || e.description || e); } catch (e2) { s = ""; }
        return (s.indexOf(ON.FETCH_REQUIRED) >= 0);
    };

    ON.clearFetchNeeds = function () {
        ON.needFetch = [];
    };

    ON.feedFetch = function (url, text) {
        ON.fetchCache[String(url)] = String(text === undefined || text === null ? "" : text);
    };

    /** 缓存别无限长：同一关键词重搜会复用，但也别攒着不放 */
    ON.trimFetchCache = function () {
        var keys = [], k;
        for (k in ON.fetchCache) {
            if (ON.fetchCache.hasOwnProperty(k)) { keys.push(k); }
        }
        if (keys.length <= 40) { return; }
        for (var i = 0; i < keys.length - 40; i++) {
            try { delete ON.fetchCache[keys[i]]; } catch (e) { ON.fetchCache[keys[i]] = null; }
        }
    };

    /**
     * 下载一个 URL 到临时文件，返回 { ok, text, encoding, error }
     */
    ON.httpGet = function (url, referer) {
        /* ① 面板刚喂回来的内容。
         *
         * 判「有没有」用 hasOwnProperty，而不是判「值非空」——
         * 万一接口回了个 200 但 body 是空的，面板照样会把它喂进来；
         * 这时若按「空 = 没缓存」处理，就会再次抛 FETCH_REQUIRED，
         * 面板再取一次、再喂一次……一直空转到重放上限。
         * 交给下游的 JSON 解析去报「内容为空」反而更清楚。 */
        var cached = ON.fetchCache[url];
        var hasCached = false;
        try { hasCached = ON.fetchCache.hasOwnProperty(url); }
        catch (eH) { hasCached = (cached !== undefined); }
        if (hasCached && cached !== undefined && cached !== null) {
            progress(SB.M("正在解析…"));
            return { ok: true, text: String(cached), encoding: "utf-8" };
        }

        /* ② 宿主没有本地 shell（Premiere Pro）→ 把 URL 记下来，交给面板去取 */
        if (!ON.hasLocalShell()) {
            ON.needFetch.push({ url: String(url), referer: String(referer || "") });
            var fe = new Error(ON.FETCH_REQUIRED);
            try { fe.lstFetchRequired = true; } catch (eFE) { }
            throw fe;
        }

        var stamp = new Date().getTime();
        var outFile = U.tempDir() + "/sb_http_" + stamp + ".dat";

        var useCurl = true;
        if (ON._transportCache === "powershell") { useCurl = false; }

        var res = null;
        if (useCurl) {
            progress(SB.M("正在用 curl 请求（最多 15 秒）…"));
            res = ON.callCurl(url, referer, outFile);
            if (res.ok) {
                ON.lastTransport = "curl";
                ON._transportCache = "curl";
            } else {
                progress(SB.M("curl 没成功，正在用 PowerShell 兜底…"));
            }
        }

        if (!res || !res.ok) {
            var res2 = ON.callPowerShell(url, referer, outFile);
            if (res2.ok) {
                ON.lastTransport = "powershell";
                ON._transportCache = "powershell";
                res = res2;
            } else {
                ON.lastTransport = "";
                return {
                    ok: false,
                    error: (res ? res.error + "；" : "") + SB.M("PowerShell 兜底也失败：%1", res2.error)
                };
            }
        }

        progress(SB.M("正在读取返回内容…"));
        var read = null;
        try {
            read = U.readTextAuto(outFile, "auto");
        } catch (e) {
            return { ok: false, error: SB.M("读取下载内容失败：%1", e.toString()) };
        }
        try { new File(outFile).remove(); } catch (e2) { }

        if (!read.ok || U.trim(read.text) === "") {
            return { ok: false, error: SB.M("下载内容为空或编码无法识别") };
        }
        progress(SB.M("正在解析…"));
        return { ok: true, text: read.text, encoding: read.encoding };
    };

    ON.httpGetJson = function (url, referer) {
        var res = ON.httpGet(url, referer);
        if (!res.ok) { return res; }
        var text = res.text;
        // 有些接口会包一层回调
        var m = /^[A-Za-z_$][A-Za-z0-9_$.]*\s*\((.*)\)\s*;?\s*$/.exec(U.trim(text));
        if (m) { text = m[1]; }
        try {
            return { ok: true, data: SB.JSON.parse(text) };
        } catch (e) {
            return { ok: false, error: SB.M("解析 JSON 失败：%1\n原始内容开头：%2", e.toString(), text.substr(0, 200)) };
        }
    };

    /* ------------------------------------------------------------------ 链接识别 */

    ON.extractNetEaseId = function (text) {
        var t = U.trim(text);
        if (/^\d{5,}$/.test(t)) { return t; }
        var m = /(?:[?&]id=|song\?id=)(\d{5,})/i.exec(t);
        return m ? m[1] : "";
    };

    ON.extractQqMid = function (text) {
        var t = U.trim(text);
        var m = /songDetail\/([A-Za-z0-9]{10,20})/i.exec(t);
        if (m) { return m[1]; }
        if (/^[A-Za-z0-9]{12,16}$/.test(t)) { return t; }
        return "";
    };

    ON.guessPlatform = function (text) {
        var t = String(text);
        if (/163\.com|music\.163/i.test(t)) { return "netease"; }
        if (/qq\.com|y\.qq/i.test(t)) { return "qq"; }
        var id = ON.extractNetEaseId(t);
        if (id !== "") { return "netease"; }
        if (ON.extractQqMid(t) !== "") { return "qq"; }
        return "";
    };

    /* ------------------------------------------------------------------ 网易云 */

    ON.neteaseSearch = function (keyword) {
        var url = "https://music.163.com/api/search/get?s=" + encodeURIComponent(keyword) +
            "&type=1&offset=0&limit=30&total=true";
        var res = ON.httpGetJson(url, ON.REFERER.netease);
        if (!res.ok) { return res; }

        var data = res.data;
        if (!data || !data.result || !data.result.songs) {
            if (data && data.code && data.code !== 200) {
                return { ok: false, error: SB.M("网易云接口返回错误码 %1（可能是搜索频率限制，稍后再试）", data.code) };
            }
            return { ok: true, songs: [] };
        }
        var songs = [];
        var list = data.result.songs;
        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            var artists = [];
            if (s.artists) {
                for (var a = 0; a < s.artists.length; a++) { artists.push(s.artists[a].name); }
            } else if (s.ar) {
                for (var a2 = 0; a2 < s.ar.length; a2++) { artists.push(s.ar[a2].name); }
            }
            var ms = s.duration || s.dt || 0;
            songs.push({
                platform: "netease",
                id: s.id || s.songId,
                mid: "",
                name: s.name || "",
                singer: artists.join(" / "),
                album: s.album ? s.album.name : (s.al ? s.al.name : ""),
                duration: ms > 0 ? Math.round(ms / 1000) : 0,
                link: s.id ? ("https://music.163.com/#/song?id=" + s.id) : ""
            });
        }
        return { ok: true, songs: songs };
    };

    ON.neteaseLyrics = function (songId) {
        var url = "https://music.163.com/api/song/lyric?os=pc&id=" + songId + "&lv=-1&tv=-1";
        var res = ON.httpGetJson(url, ON.REFERER.netease);
        if (!res.ok) { return res; }
        var d = res.data;
        if (!d) { return { ok: false, error: SB.M("网易云歌词接口返回空数据") }; }
        if (d.code && d.code !== 200) {
            return { ok: false, error: SB.M("网易云歌词接口返回错误码 %1", d.code) };
        }
        var original = (d.lrc && d.lrc.lyric) ? d.lrc.lyric : "";
        var translated = (d.tlyric && d.tlyric.lyric) ? d.tlyric.lyric : "";
        if (U.trim(original) === "" && U.trim(translated) === "") {
            return { ok: false, error: SB.M("这首歌没有返回歌词（可能是纯音乐或接口受限）") };
        }
        return { ok: true, original: original, translated: translated };
    };

    /* ------------------------------------------------------------------ QQ 音乐 */

    ON.qqSearch = function (keyword) {
        var url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=30&w=" +
            encodeURIComponent(keyword) + "&format=json&cr=1&new_json=1&t=0";
        var res = ON.httpGetJson(url, ON.REFERER.qq);
        if (!res.ok) { return res; }

        var d = res.data;
        var list = (d && d.data && d.data.song && d.data.song.list) ? d.data.song.list : null;
        if (!list) { return { ok: true, songs: [] }; }

        var songs = [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            var singers = [];
            var arr = s.singer || s.singers || [];
            for (var a = 0; a < arr.length; a++) { singers.push(arr[a].name); }
            songs.push({
                platform: "qq",
                id: s.id || s.songid || 0,
                mid: s.mid || s.songmid || "",
                name: s.title || s.name || s.songname || "",
                singer: singers.join(" / "),
                album: s.album ? (s.album.name || s.album.title || "") : (s.albumname || ""),
                duration: s.interval || 0,
                link: (s.mid || s.songmid) ? ("https://y.qq.com/n/ryqq/songDetail/" + (s.mid || s.songmid)) : ""
            });
        }
        return { ok: true, songs: songs };
    };

    ON.qqLyrics = function (songMid) {
        var url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=" +
            encodeURIComponent(songMid) + "&format=json&nobase64=1";
        var res = ON.httpGetJson(url, ON.REFERER.qq);
        if (!res.ok) { return res; }
        var d = res.data;
        if (!d) { return { ok: false, error: SB.M("QQ 音乐歌词接口返回空数据") }; }
        if (d.code !== undefined && d.code !== 0 && d.code !== 200) {
            return { ok: false, error: SB.M("QQ 音乐歌词接口返回错误码 %1", d.code) };
        }
        var original = U.decodeHtmlEntities(ON.decodeMaybeBase64(d.lyric || ""));
        var translated = U.decodeHtmlEntities(ON.decodeMaybeBase64(d.trans || ""));
        if (U.trim(original) === "" && U.trim(translated) === "") {
            return { ok: false, error: SB.M("这首歌没有返回歌词（可能是纯音乐或接口受限）") };
        }
        return { ok: true, original: original, translated: translated };
    };

    /** QQ 接口有时返回 Base64，有时是明文 */
    ON.decodeMaybeBase64 = function (text) {
        var t = U.trim(text);
        if (t === "") { return ""; }
        if (t.indexOf("[") >= 0 || t.indexOf("\n") >= 0) { return t; }
        try {
            var out = "";
            var buffer = 0;
            var bits = 0;
            var table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            // 注意：字符类里的 / 必须写成 \/ 。ExtendScript 的旧的词法分析器
            // 遇到字符类里没转义的 / 会把它当成正则的结束符，然后把后面的 = 当成
            // 「给正则字面量赋值」，报出莫名奇妙的
            // ReferenceError: 无法显示在分配的左边，因为它为只读
            var clean = t.replace(/[^A-Za-z0-9+\/=]/g, "");
            var bytes = [];
            for (var i = 0; i < clean.length; i++) {
                var ch = clean.charAt(i);
                if (ch === "=") { break; }
                var idx = table.indexOf(ch);
                if (idx < 0) { continue; }
                buffer = (buffer << 6) | idx;
                bits += 6;
                if (bits >= 8) {
                    bits -= 8;
                    bytes.push((buffer >> bits) & 0xFF);
                }
            }
            var decoded = U.decodeUtf8(bytes);
            return decoded === null ? t : decoded;
        } catch (e) {
            return t;
        }
    };

    /* ------------------------------------------------------------------ 统一入口 */

    ON.search = function (platform, keyword) {
        var kw = U.trim(keyword);
        if (kw === "") { return { ok: false, error: SB.M("请先输入歌名 / 歌手 / 歌曲链接") }; }

        // 直接贴链接或 ID
        var guessed = ON.guessPlatform(kw);
        if (guessed === "netease" && /^\d{5,}$/.test(kw)) {
            return { ok: true, songs: [{
                platform: "netease", id: kw, mid: "", name: SB.M("（按 ID 直取）%1", kw),
                singer: "", album: "", duration: 0,
                link: "https://music.163.com/#/song?id=" + kw
            }] };
        }
        if (guessed === "qq") {
            var mid = ON.extractQqMid(kw);
            if (mid !== "") {
                return { ok: true, songs: [{
                    platform: "qq", id: 0, mid: mid, name: SB.M("（按 songmid 直取）%1", mid),
                    singer: "", album: "", duration: 0,
                    link: "https://y.qq.com/n/ryqq/songDetail/" + mid
                }] };
            }
        }

        if (platform === "qq") { return ON.qqSearch(kw); }
        return ON.neteaseSearch(kw);
    };

    ON.fetchLyrics = function (song) {
        if (!song) { return { ok: false, error: SB.M("没有选中歌曲") }; }
        if (song.platform === "qq") {
            if (!song.mid) { return { ok: false, error: SB.M("这首歌没有 songmid，无法获取歌词") }; }
            return ON.qqLyrics(song.mid);
        }
        if (!song.id) { return { ok: false, error: SB.M("这首歌没有 ID，无法获取歌词") }; }
        return ON.neteaseLyrics(song.id);
    };

    /** 环境自检：curl 是否可用 */
    ON.probeTransport = function () {
        var exe = ON.findCurl();
        var exists = U.fileExists(exe);
        return {
            curlPath: exe,
            curlExists: exists,
            note: exists
                ? SB.M("curl 可用（%1）", exe)
                : SB.M("没找到 curl.exe，将尝试用 PowerShell 兜底（Windows 10 1803 以上一般自带 curl）")
        };
    };

    /**
     * 在线通道体检：把「搜索 → 取歌词」整条链路跑一遍，每一步都计时。
     *
     * 用途：面板上「一直正在搜索」的时候，点一下这个，就能看出是
     *   · 找不到 curl / 命令跑不起来
     *   · 请求超时（网络或代理）
     *   · 返回了但解析不了
     *   · 其实都已经跑完了，只是面板没刷
     * 到底卡在哪一环。返回一串可以直接显示的报告行。
     */
    ON.probeOnline = function (keyword) {
        var out = [];
        var kw = U.trim(keyword || "海阔天空"); // i18n-allow 默认搜索关键词（歌名），不是界面文案
        var t0, t1;

        var tr = ON.probeTransport();
        out.push(tr.note);
        out.push(SB.M("临时目录：%1", U.tempDir()));

        // 把通道缓存清掉，强制真跑一次 curl
        ON._transportCache = null;

        t0 = new Date().getTime();
        out.push("");
        out.push(SB.M("① 直接下载一个字节流测通道……"));
        var got = ON.httpGet("https://music.163.com/api/search/get?s=" +
            encodeURIComponent(kw) + "&type=1&offset=0&limit=1&total=true", ON.REFERER.netease);
        t1 = new Date().getTime();
        if (!got.ok) {
            out.push(SB.M("   [失败] 用时 %1 ms：%2", (t1 - t0), got.error));
            out.push(SB.M("   → 结论：连不上接口。请检查网络 / 代理 / 防火墙。"));
            return out;
        }
        out.push(SB.M("   [OK] 用时 %1 ms，通道 = %2，返回 %3 字符，编码 %4", (t1 - t0), ON.lastTransport, got.text.length, got.encoding));

        t0 = new Date().getTime();
        out.push("");
        out.push(SB.M("② 搜索「%1」……", kw));
        var res = ON.search("netease", kw);
        t1 = new Date().getTime();
        if (!res.ok) {
            out.push(SB.M("   [失败] 用时 %1 ms：%2", (t1 - t0), res.error));
            return out;
        }
        out.push(SB.M("   [OK] 用时 %1 ms，找到 %2 首", (t1 - t0), res.songs.length));
        if (res.songs.length === 0) {
            out.push(SB.M("   → 接口通了但没结果，换个关键词试试。"));
            return out;
        }
        var s0 = res.songs[0];
        out.push(SB.M("   第一首：%1 - %2", s0.name, s0.singer));

        t0 = new Date().getTime();
        out.push("");
        out.push(SB.M("③ 获取第一首的歌词……"));
        var lyr = ON.fetchLyrics(s0);
        t1 = new Date().getTime();
        if (!lyr.ok) {
            out.push(SB.M("   [失败] 用时 %1 ms：%2", (t1 - t0), lyr.error));
            return out;
        }
        out.push(SB.M("   [OK] 用时 %1 ms，原文 %2 行，译文 %3 行", (t1 - t0),
            U.trim(lyr.original).split("\n").length,
            (U.trim(lyr.translated) === "" ? "0" : U.trim(lyr.translated).split("\n").length)));

        out.push("");
        out.push(SB.M("结论：整条链路正常。如果面板上还是「一直正在搜索」，"));
        out.push(SB.M("那说明卡住的地方不在网络，而是面板事件里抛了异常 —— 请把状态栏文字发给我。"));
        return out;
    };

    root.Online = ON;
})();
