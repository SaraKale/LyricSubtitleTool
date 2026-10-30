/* ============================================================================
 *  net.js —— 面板侧的网络层（PR 版的「取网」就靠这个）
 *  ---------------------------------------------------------------------------
 *  为什么 PR 版必须有这么一个文件？
 *
 *   AE 版取歌词走的是宿主：
 *       system.callSystem('curl …')      ← AE 的 ExtendScript 有 system 对象
 *   而 Premiere Pro 的 ExtendScript **根本没有 system 对象**，也没有别的
 *   能发 HTTPS 的东西（Socket 只有裸 TCP，没 TLS）。所以同一个调用到了 PR 里
 *   就是一句「ReferenceError: system is undefined」—— 用户实测踩到的就是这个。
 *
 *  那让面板的 Chromium 用 fetch 去取呢？也不行：
 *   CEP 11 起**严格执行 CORS 检查**（CEP 11 Cookbook: Migration from CEP 10 to
 *   CEP 11 → CORS checks）。而网易云 / QQ 音乐这几个接口实测都**不返回**
 *   Access-Control-Allow-Origin 头，浏览器侧直接就被拦了。
 *
 *  所以走第三条路：**面板里的 Node.js**。
 *   Node 的 https 模块是进程级的 socket，不受浏览器同源策略约束。
 *   CEP 默认关闭 Node（自 CEP 6.1 起），必须在 manifest 的 <CEFCommandLine>
 *   里显式写 --enable-nodejs 和 --mixed-context —— 见 _tools/build_PRCEP.py。
 *   （--mixed-context 不能少：没有它 require 只在另一个 JS 上下文里存在，
 *     页面里 window.require 是 undefined。）
 *
 *  兜底：万一 Node 没起来（用户手动改了 manifest、或者 CEP 版本太老），
 *  就退回浏览器 fetch。能不能成看对方给不给 CORS 头，成不了也把原因说清楚，
 *  别让用户对着一个空白面板猜。
 * ==========================================================================*/

(function () {
    var UAS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    /* 面板侧的多语言。app.js 切语言时会把当前语言写进 window.LST_LANG；
       查表规则和 app.js 的 T() 完全一样：中文原文就是 key，查不到原样返回。
       这里不能直接用 app.js 的 T() —— 它在另一个闭包里，拿不到。 */
    function T(zh) {
        var lg = window.LST_LANG || "zh";
        var tb = (lg === "en") ? window.I18N_EN
               : (lg === "zh-Hant") ? window.I18N_ZH_HANT
               : (lg === "ja") ? window.I18N_JA : null;
        var s = zh;
        if (tb) {
            var hit = tb[zh];
            if (hit !== undefined && hit !== null) { s = hit; }
        }
        if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
                s = s.split("%" + i).join(String(arguments[i]));
            }
        }
        return s;
    }

    /* ------------------------------------------------------------ Node 拿得到吗 */

    var nodeCache = null;   /* undefined = 还没试过；null = 试过没有 */
    var nodeWhy = "";

    /** 取 Node 的核心模块。CEP 里两个入口都试：window.require（mixed-context）
     *  和 window.cep_node.require（CEP 8+ 的全局符号）。 */
    function getNode() {
        if (nodeCache !== null) { return nodeCache; }

        var req = null;
        try { if (typeof require === "function") { req = require; } } catch (e0) { }
        if (!req) {
            try {
                if (window.cep_node && typeof window.cep_node.require === "function") {
                    req = window.cep_node.require;
                }
            } catch (e1) { }
        }
        if (!req) {
            nodeWhy = T("面板里拿不到 require —— manifest 的 <CEFCommandLine> 里缺少 " +
                "--enable-nodejs / --mixed-context（改完必须重启 PR 才生效）。");
            nodeCache = null;
            return null;
        }

        var mods = {};
        try {
            mods.https = req("https");
            mods.http = req("http");
            mods.zlib = req("zlib");
            mods.url = req("url");
            mods.fs = req("fs");
            /* Buffer 不靠全局：--mixed-context 下 window.Buffer 通常有，
               但显式 require 一份更保险，免得哪天 CEP 改了全局暴露方式。 */
            mods.Buffer = req("buffer").Buffer;
        } catch (e2) {
            nodeWhy = T("require 拿到了，但加载 https/http 模块失败：") + e2;
            nodeCache = null;
            return null;
        }
        nodeCache = mods;
        return nodeCache;
    }

    function hasNode() { return !!getNode(); }
    function nodeReason() { getNode(); return nodeWhy; }

    /* ------------------------------------------------------------ 解码 */

    /** Content-Type 里的 charset，取不到就当 utf-8 */
    function charsetOf(ctype) {
        var s = String(ctype || "").toLowerCase();
        var m = /charset\s*=\s*"?([a-z0-9_\-]+)"?/.exec(s);
        return m ? m[1] : "";
    }

    /** Buffer → 字符串。中文站点偶尔回 gbk，优先用 TextDecoder('gbk')；
     *  Node 没编进 ICU 时它会抛，那就退回 utf-8（网易云 / QQ 实际都是 utf-8）。 */
    function decode(buf, charset) {
        var cs = String(charset || "utf-8").toLowerCase();
        if (cs === "utf8") { cs = "utf-8"; }
        if (cs !== "utf-8" && cs !== "ascii") {
            /* 不引 iconv-lite：多一个依赖就多一处会坏的地方。真遇到 gbk 且
               TextDecoder 不支持，utf-8 解出来的中文会是乱码 —— 歌词解析本身
               有容错，不至于把整条链路带崩，但这种情况要在状态栏说清楚。 */
            try {
                if (typeof TextDecoder === "function") {
                    return new TextDecoder(cs).decode(buf);
                }
            } catch (e0) { /* 落到 utf-8 */ }
        }
        return buf.toString("utf8");
    }

    /** gzip / deflate / br 解压。我们默认不带 Accept-Encoding，
     *  服务器一般就发原文；带了也顺手处理掉，免得以后换接口踩坑。 */
    function inflate(buf, enc, zlib) {
        var e = String(enc || "").toLowerCase();
        if (e === "" || e === "identity") { return buf; }
        if (!zlib) { return buf; }
        try {
            if (e === "gzip" || e === "x-gzip") { return zlib.gunzipSync(buf); }
            if (e === "deflate") { return zlib.inflateSync(buf); }
            if (e === "br") { return zlib.brotliDecompressSync(buf); }
        } catch (e2) { /* 解不开就用原样，至少不崩 */ }
        return buf;
    }

    /* ------------------------------------------------------------ Node 版 GET */

    /**
     * 用 Node 发一次 GET，自动跟最多 5 跳 301/302/307/308。
     * 返回 Promise<{ ok, text, encoding, status, error }>
     */
    function nodeGet(url, referer, round) {
        return new Promise(function (resolve) {
            var n = getNode();
            if (!n) { resolve({ ok: false, error: nodeReason() }); return; }

            var depth = round || 0;
            if (depth > 5) { resolve({ ok: false, error: T("重定向次数过多：") + url }); return; }

            var parsed = null;
            try { parsed = n.url.parse(String(url)); } catch (eP) {
                resolve({ ok: false, error: T("URL 解析失败：") + url });
                return;
            }

            var mod = (parsed.protocol === "http:") ? n.http : n.https;
            var headers = {
                "User-Agent": UAS,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9"
            };
            if (referer) { headers["Referer"] = String(referer); }

            var opts = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || ((parsed.protocol === "http:") ? 80 : 443),
                path: (parsed.path || "/") + (parsed.hash ? "" : ""),
                method: "GET",
                headers: headers,
                timeout: 25000
            };
            /* query 在 url.parse 里已经并进 path 了，这里不用再拼 */

            var done = false;
            function finish(o) {
                if (done) { return; }
                done = true;
                resolve(o);
            }

            var req = null;
            try {
                req = mod.request(opts, function (res) {
                    var code = res.statusCode || 0;

                    /* 跟重定向。Location 可能是相对路径，用 url.resolve 补全。 */
                    if (code >= 300 && code < 400 && res.headers && res.headers.location) {
                        var next = "";
                        try { next = n.url.resolve(String(url), String(res.headers.location)); }
                        catch (eR) { next = String(res.headers.location); }
                        try { res.resume(); } catch (eRe) { }
                        nodeGet(next, referer, depth + 1).then(finish);
                        return;
                    }

                    var chunks = [];
                    res.on("data", function (c) { chunks.push(c); });
                    res.on("end", function () {
                        var buf = null;
                        try { buf = n.Buffer.concat(chunks); } catch (eC) {
                            finish({ ok: false, error: T("响应拼装失败") });
                            return;
                        }
                        buf = inflate(buf, res.headers && res.headers["content-encoding"], n.zlib);
                        var cs = charsetOf(res.headers && res.headers["content-type"]);
                        var text = "";
                        try { text = decode(buf, cs); } catch (eD) {
                            finish({ ok: false, error: T("解码失败：") + eD });
                            return;
                        }
                        if (code !== 200) {
                            finish({
                                ok: false,
                                status: code,
                                error: T("服务器返回 HTTP ") + code,
                                text: text.slice(0, 200)
                            });
                            return;
                        }
                        finish({ ok: true, status: 200, text: text, encoding: cs || "utf-8" });
                    });
                    res.on("error", function (eS) {
                        finish({ ok: false, error: T("读响应出错：") + eS });
                    });
                });
            } catch (eQ) {
                finish({ ok: false, error: T("建立请求失败：") + eQ });
                return;
            }

            req.on("timeout", function () {
                try { req.abort(); } catch (eT) { }
                finish({ ok: false, error: T("请求超时（25 秒）：") + url });
            });
            req.on("error", function (eE) {
                finish({ ok: false, error: T("网络错误：") + (eE && eE.message ? eE.message : eE) });
            });
            try { req.end(); } catch (eEnd) { finish({ ok: false, error: T("发送失败：") + eEnd }); }
        });
    }

    /* ------------------------------------------------------------ 浏览器版 GET */

    function browserGet(url, referer) {
        return new Promise(function (resolve) {
            if (typeof fetch !== "function") {
                resolve({ ok: false, error: T("面板不支持 fetch，且 Node 不可用。") });
                return;
            }
            var init = { method: "GET", credentials: "omit", cache: "no-store" };
            if (referer) { init.headers = { "Referer": String(referer) }; }
            fetch(String(url), init).then(function (res) {
                if (!res.ok) {
                    resolve({ ok: false, status: res.status, error: "HTTP " + res.status });
                    return;
                }
                return res.text().then(function (t) {
                    resolve({ ok: true, status: res.status, text: t, encoding: "utf-8" });
                });
            })["catch"](function (e) {
                resolve({
                    ok: false,
                    error: T("浏览器请求被拒绝：") + (e && e.message ? e.message : e) +
                        T("（多半是 CORS —— 请确认 manifest 里已开启 Node）")
                });
            });
        });
    }

    /* ------------------------------------------------------------ 对外 */

    /**
     * 取一个 URL。
     * 优先 Node（不受 CORS 约束），Node 不可用才退回浏览器 fetch。
     * 返回 Promise<{ ok, text, encoding, status, error, via }>
     */
    function get(url, referer) {
        if (hasNode()) {
            return nodeGet(url, referer, 0).then(function (r) {
                r.via = "node";
                return r;
            });
        }
        return browserGet(url, referer).then(function (r) {
            r.via = "browser";
            return r;
        });
    }

    /**
     * 一次取一批。宿主给的是 [{url, referer}]，我们回 [{url, text}] 或 [{url, error}]。
     * 串行取：接口一般就两跳，并发没意义，串行还能让失败原因更好定位。
     */
    function getAll(list) {
        var out = [];
        var i = 0;
        return new Promise(function (resolve) {
            function step() {
                if (i >= list.length) { resolve(out); return; }
                var it = list[i++];
                var u = String((it && it.url) || "");
                var rf = String((it && it.referer) || "");
                if (u === "") { step(); return; }
                get(u, rf).then(function (r) {
                    if (r.ok) { out.push({ url: u, text: r.text }); }
                    else { out.push({ url: u, error: r.error || T("取回失败") }); }
                    step();
                });
            }
            step();
        });
    }

    /* ------------------------------------------------------------ 读 .mogrt
     *
     *  .mogrt 就是个 zip，里面 definition.json 的 clientControls 写着这个模板
     *  **暴露了哪些参数**，其中 type:6 就是文字参数，uiName 就是脚本要用的名字。
     *  实测踩过的坑：
     *    · 中文 PR 里 property.displayName 是「文本图层」，
     *      而 definition.json 的 en_US uiName 是 "TextLayer" —— 两边对不上就白找。
     *    · 系统自带的字幕模板分两派：
     *        aefx / project.aegraphic（AE 做的）   → 文字参数叫 Text，脚本改写稳定
     *        ppro / project.prgraphic（PR 原生的）  → 文字参数叫 TextLayer，
     *          用户实测「插进去了但屏幕上还是占位文字」就出在这一派上
     *  所以扫描列表里把这两派分开标出来，并把正确的参数名直接填进面板 ——
     *  用户不用再猜，也不用等生成完才发现全是占位符。
     *
     *  ExtendScript 里没有 zip 库，这件事只能在 Node 侧做；读不到就返回
     *  ok:false，面板照旧显示，绝不因为读不出参数就让扫描失败。
     */

    /** 读 zip 的中央目录，返回 [{ name, method, csize, lho }]。
     *  只扫目录，不动数据 —— 判断「里面有没有 project.aegraphic」这种事
     *  不该把几 MB 的图形数据解压一遍（169 个模板会明显卡住面板）。 */
    function zipEntries(fs, B, path) {
        var fd = fs.openSync(path, "r");
        try {
            var size = fs.fstatSync(fd).size;
            var tailLen = Math.min(size, 65557);
            var tail = B.alloc(tailLen);
            fs.readSync(fd, tail, 0, tailLen, size - tailLen);

            var eocd = -1;
            for (var i = tail.length - 22; i >= 0; i--) {
                if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
            }
            if (eocd < 0) { throw new Error(T("不是有效的 zip（找不到结尾记录）")); }

            var count = tail.readUInt16LE(eocd + 10);
            var cdSize = tail.readUInt32LE(eocd + 12);
            var cdOff = tail.readUInt32LE(eocd + 16);
            if (cdOff + cdSize > size) { throw new Error(T("zip 目录越界")); }

            var cd = B.alloc(cdSize);
            fs.readSync(fd, cd, 0, cdSize, cdOff);

            var out = [], p = 0;
            for (var k = 0; k < count; k++) {
                if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) { break; }
                var nlen = cd.readUInt16LE(p + 28);
                var elen = cd.readUInt16LE(p + 30);
                var clen = cd.readUInt16LE(p + 32);
                out.push({
                    name: cd.toString("utf8", p + 46, p + 46 + nlen),
                    method: cd.readUInt16LE(p + 10),
                    csize: cd.readUInt32LE(p + 20),
                    lho: cd.readUInt32LE(p + 42)
                });
                p += 46 + nlen + elen + clen;
            }
            return out;
        } finally {
            try { fs.closeSync(fd); } catch (eC) { }
        }
    }

    /** 按中央目录里的记录读出某一个条目的内容。 */
    function readZipEntry(fs, zlib, B, path, ent) {
        var fd = fs.openSync(path, "r");
        try {
            var lh = B.alloc(30);
            fs.readSync(fd, lh, 0, 30, ent.lho);
            var dataOff = ent.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
            var raw = B.alloc(ent.csize);
            fs.readSync(fd, raw, 0, ent.csize, dataOff);
            return (ent.method === 0) ? raw : zlib.inflateRawSync(raw);
        } finally {
            try { fs.closeSync(fd); } catch (eC) { }
        }
    }

    /** 从 uiName / value 的 strDB 里挑某个语言的串。
     *  优先级：目标语言 → en_US → 第一条非空的。
     *  （用户自己另存的模板常常只有 zh_CN 一条，没有这一层兜底就会读成空。） */
    function locOf(ui, locale) {
        var db = (ui && ui.strDB) || null;
        if (!db) { return ""; }
        var en = "", any = "";
        for (var i = 0; i < db.length; i++) {
            var s = db[i] || {};
            var v = String(s.str === undefined || s.str === null ? "" : s.str);
            if (s.localeString === locale) { return v; }
            if (s.localeString === "en_US" && en === "") { en = v; }
            if (any === "" && v !== "") { any = v; }
        }
        return en !== "" ? en : any;
    }

    /**
     * 读一个 .mogrt 的参数表。
     * 返回 { ok, name, authorApp, kind, textParam, textParamZh, textParams, error }
     * kind: "aegraphic"（AE 做的，改文字稳定）/ "prgraphic"（PR 原生，改文字不稳）/ ""
     */
    function readMogrt(path) {
        var N = getNode();
        if (!N || !N.fs) { return { ok: false, error: nodeReason() || T("Node 不可用") }; }
        var p = String(path || "");
        var ents = null;
        try { ents = zipEntries(N.fs, N.Buffer, p); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

        /* 内部格式只看目录里的文件名，不去解压几 MB 的图形数据 */
        var kind = "";
        var defEnt = null;
        for (var i = 0; i < ents.length; i++) {
            var n = ents[i].name;
            if (n === "definition.json") { defEnt = ents[i]; }
            else if (/^project.*\.aegraphic$/i.test(n)) { kind = "aegraphic"; }
            else if (kind === "" && /^project.*\.prgraphic$/i.test(n)) { kind = "prgraphic"; }
        }
        if (!defEnt) { return { ok: false, error: T("里面没有 definition.json") }; }

        var d = null;
        try { d = JSON.parse(readZipEntry(N.fs, N.zlib, N.Buffer, p, defEnt).toString("utf8")); }
        catch (e2) { return { ok: false, error: T("definition.json 解析失败：") + e2 }; }

        var texts = [];
        var cc = d.clientControls || [];
        for (var j = 0; j < cc.length; j++) {
            var c = cc[j] || {};
            if (c.type !== 6) { continue; }
            texts.push({
                en: locOf(c.uiName, "en_US"),
                zh: locOf(c.uiName, "zh_CN"),
                value: locOf(c.value, "en_US")
            });
        }

        var first = texts.length > 0 ? texts[0] : null;
        /* 有的模板只有 zh_CN 一条 uiName（用户自己另存的那类），en 是空的 ——
           那就用 zh 顶上，别让「文字参数」框空着。 */
        var pEn = first ? first.en : "";
        var pZh = first ? first.zh : "";
        if (!pEn) { pEn = pZh; }
        if (!pZh) { pZh = pEn; }
        return {
            ok: true,
            name: String(d.capsuleName || ""),
            authorApp: String(d.authorApp || ""),
            kind: kind,
            textParam: pEn,
            textParamZh: pZh,
            textParams: texts,
            placeholder: first ? first.value : ""
        };
    }

    window.LSTNet = {
        get: get,
        getAll: getAll,
        hasNode: hasNode,
        nodeReason: nodeReason,
        readMogrt: readMogrt,
        ua: UAS
    };
})();
