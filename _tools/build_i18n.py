#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 i18n 字典生成到两端，并（可选）把源码里的文案改写成查表调用。

设计：**中文原文就是 key**。

  _tools/i18n/ui.json     面板 HTML 的界面文案（英文译文）
  _tools/i18n/app.json    前端 app.js 的文案（英文译文）
  _tools/i18n/host.json   宿主 ExtendScript 侧的文案（英文译文）
  _tools/i18n/zht.json    繁体中文译文（脚本自动生成，见 gen_zht.py）
  _tools/i18n/ja.json     日文译文（人工维护）
  _tools/i18n/expr.json   改写规则（wrap / pairs）

产物（自动生成，别手改）：
  CEP/client/i18n_en.js      前端查表 window.I18N_EN
  CEP/client/i18n_zht.js     前端查表 window.I18N_ZH_HANT
  CEP/client/i18n_ja.js      前端查表 window.I18N_JA
  AE/src/02b_i18n.jsx        宿主查表核心：SB.M / SB.T / SB.setLang（不含大表）
  AE/src/02c_i18n_en_a/b.jsx 宿主的英文表（拆两片，单文件 104KB 上限）
  AE/src/02d_i18n_zht_a/b.jsx 宿主的繁体表
  AE/src/02e_i18n_ja_a/b.jsx 宿主的日文表

为什么要拆成 4 个宿主文件：一张表 60KB 上下，四张塞进同一个 .jsx 就是 ~180KB，
而 ExtendScript 单个编译单元只有 ~107KB 的余量 —— 塞一起必然报「语法错误」，
而且报出来的行号是别处的代码（见 MEMORY.md 的「107KB 上限」那条）。

用法：
  python _tools/build_i18n.py            # 只生成产物
  python _tools/build_i18n.py --apply    # 生成 + 把 expr.json 的改写应用到源码
  python _tools/build_i18n.py --check    # 只校验字典（重复 key、未被引用的 key、各语言缺词）

为什么用「中文原文当 key」：改一处文案时不会出现「忘了改 key」这种漂移，
中文模式下 SB.M() 就是恒等函数，等于没改。
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N_DIR = os.path.join(ROOT, "_tools", "i18n")

SOURCES = ["ui.json", "app.json", "host.json"]

# 语言清单：(语言代码, 前端全局变量, 前端文件名, 宿主表文件名(两个分片), 译文来源 json)
#   en 的译文散在 ui/app/host 三本里（历史原因），其余语言各自一本。
#   语言代码同时是前端 / 宿主之间传递的值，改一处两边都得跟着改。
#
# 为什么每张宿主表要拆成 a/b 两个文件：
#   ExtendScript 单个编译单元只有 ~104KB 余量。1015 条文案时英文表 97KB、
#   繁体 95KB、日文 121KB —— 日文直接超限，构建报「语法错误」且行号指到别处。
#   两个分片各自调 addTable，查表是合并语义，对上层完全透明。
LANGS = [
    ("en", "I18N_EN", "i18n_en.js",
     ("02c_i18n_en_a.jsx", "02c_i18n_en_b.jsx"), None),
    ("zh-Hant", "I18N_ZH_HANT", "i18n_zht.js",
     ("02d_i18n_zht_a.jsx", "02d_i18n_zht_b.jsx"), "zht.json"),
    ("ja", "I18N_JA", "i18n_ja.js",
     ("02e_i18n_ja_a.jsx", "02e_i18n_ja_b.jsx"), "ja.json"),
]

# 三张表 AE 版和 PR 版各放一份（PR 版是独立的扩展目录，加载自己的那一份）。
# 以前只有 AE_CEP 会自动更新，PR_CEP 那份靠手拷 —— 结果 PR 面板后加的一堆词
# 一直没译文，切语言就露馅。现在两个目录一起写，不会再漂。
CLIENT_DIRS = [
    os.path.join(ROOT, "AE_CEP", "client"),
    os.path.join(ROOT, "PR_CEP", "client"),
]
CLIENT_DIR = CLIENT_DIRS[0]
AE_SRC = os.path.join(ROOT, "AE_JSX", "src")
OUT_HOST_CORE = os.path.join(AE_SRC, "02b_i18n.jsx")

# PR_CEP 必须在这张表里：漏了它，PR 面板新加的词永远不会被 --check 报成「没译文」。
TARGET_GLOBS = ["AE_JSX/src", "AE_CEP/host", "AE_CEP/client", "PR_CEP/host", "PR_CEP/client"]

# 自动生成的查表文件：整张表当然全是中文，不是「裸中文」，扫描时要跳过
GENERATED = {
    "i18n_en.js", "i18n_zht.js", "i18n_ja.js",
    "02b_i18n.jsx",
    "02c_i18n_en_a.jsx", "02c_i18n_en_b.jsx",
    "02d_i18n_zht_a.jsx", "02d_i18n_zht_b.jsx",
    "02e_i18n_ja_a.jsx", "02e_i18n_ja_b.jsx",
}


def load_en():
    """英文表：ui/app/host 三本的合集。同一条中文给了不同译文要报冲突。"""
    table = {}
    origin = {}
    conflicts = []
    for name in SOURCES:
        path = os.path.join(I18N_DIR, name)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for k, v in data.items():
            if k.startswith("_"):
                continue
            if k in table and table[k] != v:
                conflicts.append((k, origin[k], name, table[k], v))
                continue
            table[k] = v
            origin[k] = name
    return table, conflicts


def load_lang(json_name):
    path = os.path.join(I18N_DIR, json_name)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return dict((k, v) for k, v in json.load(f).items() if not k.startswith("_"))


def js_escape(s):
    return json.dumps(s, ensure_ascii=False)


def table_lines(table, indent):
    out = []
    keys = sorted(table.keys())
    for i, k in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        out.append("%s%s: %s%s" % (indent, js_escape(k), js_escape(table[k]), comma))
    return out, len(keys)


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def write_client(code, var, file_name, table):
    lines = [
        "/* ============================================================================",
        " *  %s —— %s 查表（自动生成，不要手改）" % (file_name, code),
        " *  ---------------------------------------------------------------------------",
        " *  源：_tools/i18n/*.json    生成：_tools/build_i18n.py",
        " *  key 就是界面上的中文原文，中文模式下根本不会用到这张表。",
        " * ==========================================================================*/",
        "",
        "window.%s = {" % var,
    ]
    body, n = table_lines(table, "    ")
    lines += body
    lines += ["};", ""]
    for d in CLIENT_DIRS:
        write_text(os.path.join(d, file_name), "\n".join(lines))
    return n


def write_host_core():
    """宿主的查表核心。这里不含任何大表 —— 表在 02c/02d/02e 里 addTable 进来。"""
    lines = [
        "/* ============================================================================",
        " *  02b_i18n.jsx —— 宿主侧的多语言（核心，自动生成，不要手改）",
        " *  ---------------------------------------------------------------------------",
        " *  源：_tools/i18n/*.json    生成：_tools/build_i18n.py",
        " *",
        " *  各语言的表在 02c / 02d / 02e 三个文件里（一张表 60KB 上下，四张塞一起",
        " *  会顶穿 ExtendScript 单个编译单元 ~107KB 的上限）。它们只调 addTable，",
        " *  顺序无所谓；加载失败也只是那一个语言翻不了，不会连累中文模式。",
        " *",
        " *  用法：SB.M(\"中文原文\")、SB.M(\"模板 %1 和 %2\", a, b)",
        " *    · SB.lang = \"zh\"（默认）时是恒等函数，等于没接这层",
        " *    · key 就是中文原文本身 —— 改文案不会漏改 key，因为根本不需要 key",
        " *    · 查不到就原样返回，绝不因为少一条翻译把功能搞挂",
        " * ==========================================================================*/",
        "",
        "(function () {",
        "    var root = (typeof SB === \"undefined\") ? (SB = {}) : SB;",
        "",
        "    root.I18N_TABLES = root.I18N_TABLES || {};",
        "",
        "    /** 支持的语言。zh 是「不查表」，所以不在表那边出现。 */",
        "    root.LANGS = [\"zh\", \"zh-Hant\", \"en\", \"ja\"];",
        "    root.lang = root.lang || \"zh\";",
        "",
        "    /** 表文件把自己的内容挂进来；重复加载就合并，后写的覆盖先写的。 */",
        "    root.addTable = function (name, t) {",
        "        if (!root.I18N_TABLES) { root.I18N_TABLES = {}; }",
        "        var cur = root.I18N_TABLES[name];",
        "        if (!cur) { root.I18N_TABLES[name] = t; return name; }",
        "        for (var k in t) {",
        "            if (t.hasOwnProperty(k)) { cur[k] = t[k]; }",
        "        }",
        "        return name;",
        "    };",
        "",
        "    /** 认不出来的语言一律退回中文 —— 面板传什么都不会把界面搞成半吊子。 */",
        "    root.normalizeLang = function (l) {",
        "        var i;",
        "        for (i = 0; i < root.LANGS.length; i++) {",
        "            if (l === root.LANGS[i]) { return l; }",
        "        }",
        "        return \"zh\";",
        "    };",
        "",
        "    root.setLang = function (l) {",
        "        root.lang = root.normalizeLang(l);",
        "        return root.lang;",
        "    };",
        "",
        "    /** 当前语言的表；zh 没有表（恒等），缺表也当恒等处理。 */",
        "    root.table = function () {",
        "        if (root.lang === \"zh\") { return null; }",
        "        var t = root.I18N_TABLES[root.lang];",
        "        return (t === undefined || t === null) ? null : t;",
        "    };",
        "",
        "    /** 当前语言下的这条文案；带参数时把 %1 %2 … 换成实参 */",
        "    root.M = function (zh) {",
        "        var s = zh;",
        "        var t = root.table();",
        "        if (t) {",
        "            var hit = t[zh];",
        "            if (hit !== undefined && hit !== null) { s = hit; }",
        "        }",
        "        if (arguments.length > 1) {",
        "            for (var i = 1; i < arguments.length; i++) {",
        "                var a = arguments[i];",
        "                s = s.split(\"%\" + i).join(String(a));",
        "            }",
        "        }",
        "        return s;",
        "    };",
        "",
        "    /** 只翻一个值（不查表就原样返回），给数组里的名字用 */",
        "    root.T = function (v) {",
        "        var t = root.table();",
        "        if (!t) { return v; }",
        "        var hit = t[v];",
        "        return (hit !== undefined && hit !== null) ? hit : v;",
        "    };",
        "",
        "    /** 整批翻（下拉框的标签用） */",
        "    root.TList = function (list) {",
        "        var out = [];",
        "        for (var i = 0; i < list.length; i++) { out.push(root.T(list[i])); }",
        "        return out;",
        "    };",
        "",
        "    /** 给面板回话用：当前语言 + 已经挂上的表，排查「切了没反应」时看这个 */",
        "    root.langInfo = function () {",
        "        var names = [], k;",
        "        for (k in root.I18N_TABLES) {",
        "            if (root.I18N_TABLES.hasOwnProperty(k)) { names.push(k); }",
        "        }",
        "        return { lang: root.lang, tables: names.join(\",\") };",
        "    };",
        "})();",
        "",
    ]
    write_text(OUT_HOST_CORE, "\n".join(lines))


def split_table(table):
    """按「累计字符数」把表劈成两半。

    单编译单元只有 ~104KB 余量，1015 条文案的日文表能到 121KB。按键排序后累加，
    找到最接近一半的那个位置切 —— 两个分片大小接近，将来再加词也不会一头先爆。
    """
    keys = sorted(table.keys())
    total = sum(len(k) + len(table[k]) for k in keys)
    acc = 0
    cut = len(keys) // 2
    for i, k in enumerate(keys):
        acc += len(k) + len(table[k])
        if acc >= total / 2.0:
            cut = i + 1
            break
    return [dict((k, table[k]) for k in keys[:cut]),
            dict((k, table[k]) for k in keys[cut:])]


def write_host_table(file_name, code, table, part=""):
    lines = [
        "/* ============================================================================",
        " *  %s —— 宿主侧的 %s 查表%s（自动生成，不要手改）" % (file_name, code, part),
        " *  ---------------------------------------------------------------------------",
        " *  源：_tools/i18n/*.json    生成：_tools/build_i18n.py",
        " *",
        " *  这个文件的全部内容就是把一张表挂到 SB.I18N_TABLES 上，",
        " *  查表逻辑在 02b_i18n.jsx。单独成一个文件是为了不撑爆单个编译单元；",
        " *  每门语言拆成 a/b 两片，addTable 是合并语义，两片先后加载都能查全。",
        " * ==========================================================================*/",
        "",
        "(function () {",
        "    var root = (typeof SB === \"undefined\") ? (SB = {}) : SB;",
        "    var t = {",
    ]
    body, n = table_lines(table, "        ")
    lines += body
    lines += [
        "    };",
        "",
        "    /* 02b 没加载时（单独 evalFile 这个文件）也能挂上，不至于把表丢掉 */",
        "    if (typeof root.addTable === \"function\") {",
        "        root.addTable(\"%s\", t);" % code,
        "    } else {",
        "        root.I18N_TABLES = root.I18N_TABLES || {};",
        "        root.I18N_TABLES[\"%s\"] = t;" % code,
        "    }",
        "})();",
        "",
    ]
    write_text(os.path.join(AE_SRC, file_name), "\n".join(lines))
    return n


# ------------------------------------------------------------------ 改写源码

def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def apply_expr(table):
    spec_path = os.path.join(I18N_DIR, "expr.json")
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    problems = []
    stats = []
    for entry in spec.get("files", []):
        rel = entry["file"]
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(path):
            problems.append("缺文件：%s" % rel)
            continue
        text = read_text(path)

        # 先跑 pairs（它们按**原始源码**写），再跑 wrap（兜住剩下的裸字面量）。
        # 反过来的话 pairs 里的 old 就得按「已经包过」的样子写，很难维护。
        n_pair = 0
        miss_pair = []
        for old, new in entry.get("pairs", []):
            cnt = text.count(old)
            if cnt == 0:
                miss_pair.append(old.strip().split("\n")[0][:70])
                continue
            text = text.replace(old, new)
            n_pair += cnt

        n_wrap = 0
        miss_wrap = []
        for lit in entry.get("wrap", []):
            if lit == "-":
                continue
            needle = '"%s"' % lit.replace('"', '\\"')
            wrapped = 'SB.M("%s")' % lit.replace('"', '\\"')
            # 已经包过的不再包：SB.M("x") / SB.T("x") 里的那段跳过。
            # 用 lambda 当替换串 —— 否则 re.sub 会把里面的 \ 当转义处理。
            pattern = r'(?<!SB\.M\()(?<!SB\.T\()' + re.escape(needle)
            text, cnt = re.subn(pattern, lambda m: wrapped, text)
            if cnt == 0:
                miss_wrap.append(lit)
                continue
            n_wrap += cnt

        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        stats.append((rel, n_wrap, n_pair))
        if miss_wrap:
            problems.append("[%s] wrap 没命中 %d 条：%s"
                            % (rel, len(miss_wrap), " | ".join(miss_wrap[:6])))
        if miss_pair:
            problems.append("[%s] pairs 没命中 %d 条：%s"
                            % (rel, len(miss_pair), " | ".join(miss_pair[:6])))

    print("改写结果：")
    for rel, w, p in stats:
        print("  %-28s wrap %d 条, pairs %d 条" % (rel, w, p))
    if problems:
        print("")
        print("!! 有没命中的规则（说明源码里的写法和我写的不一致，需要人工看）：")
        for x in problems:
            print("  " + x)
        return False
    print("全部规则命中。")
    return True


# ------------------------------------------------------------------ 校验

def find_targets():
    out = []
    for d in TARGET_GLOBS:
        base = os.path.join(ROOT, d.replace("/", os.sep))
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            if "dist" in dirpath.split(os.sep):
                continue
            for fn in filenames:
                if fn in GENERATED or fn == "CSInterface.js":
                    continue
                if fn.endswith(".jsx") or fn.endswith(".js") or fn.endswith(".html"):
                    out.append(os.path.join(dirpath, fn))
    return out


def report_unused(table):
    """字典里存在的 key 一次都没在源码里出现 —— 多半是拼写和源码对不上。

    三种「算命中」的形态：
      1) **还原转义后**的字面量正好等于 key（字符串字面量、HTML 的 data-i18n 值）；
      2) key 原样出现在源码里（比如 i18n-allow 包起来的数据表，运行时才查表）；
      3) key 里的换行在源码里写成 \\n 的形式。

    为什么不能只看 2)：源码里写的是 `\\n`（反斜杠 + n 两个字符），字典的 key 里
    是**真换行**。只看原样匹配的话，所有多行文案都会被误报成「没接上去」。
    """
    import i18n_audit as A          # 复用它的字面量扫描器，别再写一份转义还原
    literals = set()
    raw = ""
    for p in find_targets():
        rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
        text = read_text(p)
        raw += text
        if rel.endswith(".html"):
            _bad, declared = A.scan_html(p, text)
            literals |= set(declared.keys())
        else:
            _bad, wrapped = A.scan_js(p, text)
            literals |= set(b for _ln, b in wrapped)

    unused = []
    for k in sorted(table.keys()):
        if k in literals:
            continue
        if k in raw or k.replace("\n", "\\n") in raw:
            continue
        unused.append(k)
    return unused


def report_missing(en, tables):
    """各语言相对英文表缺了哪些 key。缺了不会挂（查不到就显示中文），
    但用户切过去会看到半句中文，所以列出来提醒补。"""
    out = []
    for code, table in tables:
        miss = sorted(set(en) - set(table))
        extra = sorted(set(table) - set(en))
        if miss or extra:
            out.append((code, miss, extra))
    return out


def main():
    args = sys.argv[1:]
    en, conflicts = load_en()
    if conflicts:
        print("!! 同一个中文在不同 JSON 里给了不同译文：")
        for k, o1, o2, v1, v2 in conflicts:
            print("  [%s] %s -> %s / %s -> %s" % (k, o1, v1, o2, v2))
        return 2

    tables = []
    for code, var, client_file, host_file, src in LANGS:
        table = en if src is None else load_lang(src)
        tables.append((code, table))

    write_host_core()
    print("字典 %d 条（以中文原文为 key），生成产物：" % len(en))
    print("  %s  （查表核心，不含大表）" % os.path.relpath(OUT_HOST_CORE, ROOT))
    for (code, table), (_c, var, client_file, host_files, _s) in zip(tables, LANGS):
        n1 = write_client(code, var, client_file, table)
        print("  %-24s %d 条" % (os.path.join("AE_CEP", "client", client_file), n1))
        for fname, part, tag in zip(host_files, split_table(table), ("（上）", "（下）")):
            n2 = write_host_table(fname, code, part, tag)
            print("      %-38s %d 条" % (os.path.join("AE_JSX", "src", fname), n2))

    ok = True
    if "--apply" in args:
        print("")
        ok = apply_expr(en)

    if "--check" in args or "--apply" in args:
        gaps = report_missing(en, tables)
        if gaps:
            print("")
            print("!! 译文不齐（缺了会退回中文显示，不致命但要补）：")
            for code, miss, extra in gaps:
                print("  [%s] 缺 %d 条%s" % (code, len(miss),
                                            ("，多 %d 条" % len(extra)) if extra else ""))
                for k in miss[:8]:
                    print("      " + k[:60].replace("\n", "\\n"))
            ok = False
        unused = report_unused(en)
        if unused:
            print("")
            print("字典里这些 key 在源码里找不到（译文没接上去）：")
            for k in unused[:40]:
                print("  " + k)
            if len(unused) > 40:
                print("  …还有 %d 条" % (len(unused) - 40))
            ok = False

    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
