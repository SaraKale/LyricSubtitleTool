/* ============================================================================
 *  01_json.jsx —— JSON 解析/序列化 polyfill
 *  ---------------------------------------------------------------------------
 *  ExtendScript 只实现了 ECMAScript 3 的语法，没有内置的 JSON 对象。
 *  而在线歌词接口返回的都是 JSON，所以这里自己实现一份最小的 JSON 解析器。
 *
 *  只依赖最基本的 ES3 语法（没有 ES5 的 Array.map / Object.keys 等）。
 * ==========================================================================*/

(function () {
    var root = (typeof SB === "undefined") ? (SB = {}) : SB;

    function JsonError(message) {
        this.name = "JsonError";
        this.message = message;
    }

    function Parser(text) {
        this.s = text;
        this.i = 0;
        this.n = text.length;
    }

    Parser.prototype.err = function (message) {
        throw new JsonError(message + SB.M("（字符位置 %1）", this.i));
    };

    Parser.prototype.skipWs = function () {
        for (;;) {
            if (this.i >= this.n) { return; }
            var c = this.s.charAt(this.i);
            if (c === " " || c === "\t" || c === "\n" || c === "\r") {
                this.i++;
            } else {
                return;
            }
        }
    };

    Parser.prototype.parseValue = function () {
        this.skipWs();
        if (this.i >= this.n) { this.err(SB.M("内容意外结束")); }
        var c = this.s.charAt(this.i);
        if (c === "{") { return this.parseObject(); }
        if (c === "[") { return this.parseArray(); }
        if (c === "\"") { return this.parseString(); }
        if (c === "t") { return this.parseLiteral("true", true); }
        if (c === "f") { return this.parseLiteral("false", false); }
        if (c === "n") { return this.parseLiteral("null", null); }
        return this.parseNumber();
    };

    Parser.prototype.parseLiteral = function (word, value) {
        if (this.s.substr(this.i, word.length) !== word) {
            this.err(SB.M("非法字面量，期望 %1", word));
        }
        this.i += word.length;
        return value;
    };

    Parser.prototype.parseNumber = function () {
        var start = this.i;
        while (this.i < this.n) {
            var c = this.s.charAt(this.i);
            if ((c >= "0" && c <= "9") || c === "-" || c === "+" || c === "." ||
                c === "e" || c === "E") {
                this.i++;
            } else {
                break;
            }
        }
        var raw = this.s.substring(start, this.i);
        if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(raw)) {
            this.err(SB.M("非法数字：%1", raw));
        }
        return parseFloat(raw);
    };

    Parser.prototype.parseString = function () {
        this.i++; // 跳过起始引号
        var out = "";
        for (;;) {
            if (this.i >= this.n) { this.err(SB.M("字符串没有闭合")); }
            var c = this.s.charAt(this.i++);
            if (c === "\"") { return out; }
            if (c !== "\\") { out += c; continue; }

            if (this.i >= this.n) { this.err(SB.M("转义符没有闭合")); }
            var e = this.s.charAt(this.i++);
            if (e === "\"") { out += "\""; }
            else if (e === "\\") { out += "\\"; }
            else if (e === "/") { out += "/"; }
            else if (e === "b") { out += String.fromCharCode(8); }
            else if (e === "f") { out += String.fromCharCode(12); }
            else if (e === "n") { out += "\n"; }
            else if (e === "r") { out += "\r"; }
            else if (e === "t") { out += "\t"; }
            else if (e === "u") {
                var hex = this.s.substr(this.i, 4);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.err(SB.M("非法的 \\u 转义")); }
                this.i += 4;
                out += String.fromCharCode(parseInt(hex, 16));
            } else {
                this.err(SB.M("未知的转义字符 \\%1", e));
            }
        }
    };

    Parser.prototype.parseArray = function () {
        this.i++; // 跳过 [
        var out = [];
        this.skipWs();
        if (this.s.charAt(this.i) === "]") { this.i++; return out; }
        for (;;) {
            out.push(this.parseValue());
            this.skipWs();
            var c = this.s.charAt(this.i);
            if (c === ",") { this.i++; continue; }
            if (c === "]") { this.i++; return out; }
            this.err(SB.M("数组里期望 , 或 ]"));
        }
    };

    Parser.prototype.parseObject = function () {
        this.i++; // 跳过 {
        var out = {};
        this.skipWs();
        if (this.s.charAt(this.i) === "}") { this.i++; return out; }
        for (;;) {
            this.skipWs();
            if (this.s.charAt(this.i) !== "\"") { this.err(SB.M("对象的键必须是字符串")); }
            var key = this.parseString();
            this.skipWs();
            if (this.s.charAt(this.i) !== ":") { this.err(SB.M("键后面期望 :")); }
            this.i++;
            out[key] = this.parseValue();
            this.skipWs();
            var c = this.s.charAt(this.i);
            if (c === ",") { this.i++; continue; }
            if (c === "}") { this.i++; return out; }
            this.err(SB.M("对象里期望 , 或 }"));
        }
    };

    function parse(text) {
        if (text === null || text === undefined) { return null; }
        var s = String(text);
        // 去掉可能存在的 UTF-8 BOM
        if (s.length > 0 && s.charCodeAt(0) === 0xFEFF) { s = s.substring(1); }
        var p = new Parser(s);
        var value = p.parseValue();
        p.skipWs();
        return value;
    }

    function escapeString(s) {
        var out = "\"";
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            var code = s.charCodeAt(i);
            if (c === "\"") { out += "\\\""; }
            else if (c === "\\") { out += "\\\\"; }
            else if (c === "\n") { out += "\\n"; }
            else if (c === "\r") { out += "\\r"; }
            else if (c === "\t") { out += "\\t"; }
            else if (code < 32) { out += "\\u" + ("000" + code.toString(16)).slice(-4); }
            else { out += c; }
        }
        return out + "\"";
    }

    /**
     * 是不是数组。
     *
     * 光用 `instanceof Array` 不够：它在同一个引擎里够用，但跨 context 时会失效
     * （比如 CEP 面板传进来的对象、或者经 $.global.eval 在另一层跑出来的数组），
     * 一旦判错，数组会被当普通对象序列化成 {"0":..,"1":..} ——
     * PR 那边 fontTextRunLength 必须是真数组，写成对象文字会导致文字渲染错位。
     * 所以再用 Object.prototype.toString 兜一层（ES3 就能用，且跨 context 可靠）。
     */
    function isArrayValue(v) {
        if (v === null || v === undefined) { return false; }
        if (v instanceof Array) { return true; }
        return (Object.prototype.toString.call(v) === "[object Array]");
    }

    function stringify(value, indent) {
        var pad = indent || "";
        var isArr = isArrayValue(value);
        if (value === null || value === undefined) { return "null"; }
        if (typeof value === "number" || typeof value === "boolean") { return String(value); }
        if (typeof value === "string") { return escapeString(value); }
        if (isArr) {
            if (value.length === 0) { return "[]"; }
            var parts = [];
            for (var i = 0; i < value.length; i++) {
                parts.push(pad + "  " + stringify(value[i], pad + "  "));
            }
            return "[\n" + parts.join(",\n") + "\n" + pad + "]";
        }
        var keys = [];
        for (var k in value) {
            if (value.hasOwnProperty && value.hasOwnProperty(k)) { keys.push(k); }
        }
        if (keys.length === 0) { return "{}"; }
        var body = [];
        for (var j = 0; j < keys.length; j++) {
            body.push(pad + "  " + escapeString(keys[j]) + ": " + stringify(value[keys[j]], pad + "  "));
        }
        return "{\n" + body.join(",\n") + "\n" + pad + "}";
    }

    root.JSON = {
        parse: parse,
        stringify: stringify,
        JsonError: JsonError
    };
})();
