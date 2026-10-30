# -*- coding: utf-8 -*-
"""
构建 ScriptUI 单脚本版（AE_JSX/）：把 AE_JSX/src/*.jsx 按 ORDER 拼成 bootstrap + 模块文件，
并做一整套构建期检查。

三个构建脚本的分工（名字统一成 build_<宿主>.py）：
  build_AEJSX.py   ScriptUI 单脚本版 → AE_JSX/歌词字幕排版工具.jsx + lyric_modules/
  build_AECEP.py   AE 的 CEP 面板版   → AE_CEP/dist/LyricSubtitleTool_AE/
  build_PRCEP.py   PR 的 CEP 面板版   → PR_CEP/dist/LyricSubtitleTool_PR/

本文件同时是另外两个的「工具箱」：ES3 规则表、strip_comments、find_node、
verify_units、check_xml 都在这里，它们 `import build_AEJSX as build` 复用。

检查项：
  1. 语法检查：剥掉 #target/#targetengine 这类 ExtendScript 预处理指令后交给 node --check
  2. ES3 兼容检查：ExtendScript 只支持 ECMAScript 3 + 少量扩展，
     扫一遍有没有 let/const/箭头函数/模板字符串/Object.keys 之类会直接报错的东西
  3. 正则字符类里未转义的斜杠（ExtendScript 的旧词法器会被截断）
  4. acorn 的 ecmaVersion:3 严格校验
  5. 产出文件逐个校验：BOM / 第 1 行是指令 / 104KB 上限 / 行注释里带 @

输出：AE_JSX/歌词字幕排版工具.jsx（UTF-8 with BOM —— 没有 BOM 的话 AE 里中文会乱码）
      另出一份纯 ASCII 文件名的 AE_JSX/LyricSubtitleTool_AE.jsx，
      给「AE 读不了中文路径」的老版本 / 某些同步盘用。
"""

import datetime
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "AE_JSX", "src")
OUT_FILE = os.path.join(ROOT, "AE_JSX", "歌词字幕排版工具.jsx")
OUT_FILE_ASCII = os.path.join(ROOT, "AE_JSX", "LyricSubtitleTool_AE.jsx")

# 注意 02b_i18n.jsx 必须排在所有调用 SB.M() 的模块前面：
# 它是查表核心（SB.M / SB.T / setLang 的定义）。ScriptUI 版也拼它 ——
# 逻辑层（02~08）里到处是 SB.M("中文")，少了这个文件会直接「SB.M is not a function」。
# 中文模式下 SB.M 是恒等函数，等于没接这层，所以 ScriptUI 版的行为一点没变。
#
# 02c/02d/02e（英 / 繁 / 日三张语言表）**不进 ScriptUI 版**：ScriptUI 面板没有
# 语言切换，永远是中文，拼进来只是白撑大产物。CEP 版才需要，见 build_AECEP.py 的 ORDER。
ORDER = [
    "00_header.jsx",
    "01_json.jsx",
    "02_util.jsx",
    "02b_i18n.jsx",
    "03_lrc.jsx",
    "03b_sub.jsx",   # SRT / ASS(SSA) / WebVTT 解析，被 03_lrc 的 parseAuto 调用
    "04_layers.jsx",
    "05_style.jsx",
    "06_online.jsx",
    "08_preset.jsx",
    "07_ui.jsx",
]

NODE_CANDIDATES = [
    r"C:\Users\SaraKale\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
    "node",
]

# 会直接把 ExtendScript 搞挂的写法
ES3_FORBIDDEN = [
    (r"(?<![\w$.])let\s+[A-Za-z_$]", "let 声明"),
    (r"(?<![\w$.])const\s+[A-Za-z_$]", "const 声明"),
    (r"=>", "箭头函数"),
    (r"`", "模板字符串"),
    (r"(?<![\w$.])class\s+[A-Za-z_$]", "class 声明"),
    (r"\.\.\.", "展开/剩余运算符"),
    (r"\?\?", "空值合并运算符"),
    (r"\?\.", "可选链"),
    (r"\bfor\s*\([^)]*\bof\b", "for...of"),
    (r"Object\.keys\s*\(", "Object.keys（ExtendScript 没有）"),
    (r"Object\.assign\s*\(", "Object.assign（ExtendScript 没有）"),
    (r"Array\.isArray\s*\(", "Array.isArray（ExtendScript 没有）"),
    (r"\.padStart\s*\(", "String.padStart（ExtendScript 没有）"),
    (r"\.includes\s*\(", "String/Array.includes（ExtendScript 没有）"),
    (r"(?<!SB\.)(?<!root\.)\bJSON\.(parse|stringify)", "原生 JSON（ExtendScript 没有，应使用 SB.JSON）"),
    (r"\bnew\s+Map\s*\(", "Map（ExtendScript 没有）"),
    (r"\bnew\s+Set\s*\(", "Set（ExtendScript 没有）"),
    # ES3 的「未来保留字」，ExtendScript 会直接抛 SyntaxError: 非法使用保留字
    (r"\b(abstract|boolean|byte|char|class|const|debugger|double|enum|export|extends|"
     r"final|float|goto|implements|import|int|interface|long|native|package|private|"
     r"protected|public|short|static|super|synchronized|throws|transient|volatile|"
     r"let|yield)\b", "ES3 保留字（不能当变量名/函数名）"),
]

# 只是提醒，可能是字符串里的内容
ES3_WARN = [
    (r"\.map\s*\(", "Array.map"),
    (r"\.filter\s*\(", "Array.filter"),
    (r"\.forEach\s*\(", "Array.forEach"),
    (r"\.reduce\s*\(", "Array.reduce"),
    (r"\bimport\b", "import"),
    (r"\bexport\b", "export"),
]


# 入口 bootstrap 是独立模板文件（AE/_bootstrap_scriptui.jsx），构建时读它、补 BOM 写出。
# 抽成文件是为了好维护：以前它是个几百行的 Python 字符串常量，改一次对不上字符一次。
SCRIPTUI_BOOTSTRAP_TEMPLATE = os.path.join(ROOT, "AE_JSX", "_bootstrap_scriptui.jsx")



def strip_ui_iife(code):
    """去掉 07_ui 外层 (function(thisObj){ ... })(this); 包装，改成顶层代码。

    这样内部的 function 声明变成全局函数，拆成两个 $.evalFile 单元后跨文件还能
    互相引用（UI 对象构建时引用的一堆 doXxx 函数才不会变成 undefined）。
    同时在顶部注入 var thisObj = this; 保持原来的 thisObj 语义（ScriptUI 面板用 it 做持久化）。
    """
    lines = code.split("\n")
    out = []
    in_iife = False
    for ln in lines:
        s = ln.strip()
        # 找到外层 IIFE 开口：丢掉这一行
        if (not in_iife) and s.startswith("(function") and s.rstrip().endswith("{"):
            in_iife = True
            continue
        # 找到结尾 })(this); 系列：丢掉这一行
        if in_iife and (s == "})(this);" or s == "})(this)" or s.startswith("})(this)")):
            in_iife = False
            continue
        out.append(ln)
    body = "\n".join(out)
    return "var thisObj = this;\n" + body


def split_at_function(code):
    """在顶层 function 声明边界把代码切成两半（各 < 107KB），两半都语法自洽。

    07_ui 去掉外层 IIFE 后，顶层（原 IIFE 内部第一级）函数声明稳定是「4 个空格缩进
    + function」。用缩进判断切点，比数花括号稳（字符串里的 { } 会干扰括号计数）。
    切点必须落在一个完整语句的边界，这样前半段、后半段各自的括号都配平。
    """
    lines = code.split("\n")
    total = len(code)
    cum = 0
    cuts = []  # (line_index, byte_offset_before_line)
    for i, ln in enumerate(lines):
        s = ln.strip()
        b_before = cum
        # 顶层函数声明：恰好 4 空格缩进 + function ... {
        if ln.startswith("    function ") and s.rstrip().endswith("{"):
            cuts.append((i, b_before))
        cum += len(ln) + 1
    if not cuts:
        return code, ""
    best = min(cuts, key=lambda c: abs(c[1] - total / 2))
    cut = best[0]
    return "\n".join(lines[:cut]), "\n".join(lines[cut:])


def write_split_scriptui(stamp):
    """把各模块写成独立文件 + bootstrap，解决单文件超限问题。

    模块统一放进 AE/lyric_modules/ 子文件夹——AE 只扫 ScriptUI Panels 顶层的
    .jsx，子文件夹里的不会变成面板，避免菜单里冒出十几个同名「面板」。
    """
    out_dir = os.path.dirname(OUT_FILE)
    lib_dir = os.path.join(out_dir, "lyric_modules")
    if os.path.isdir(lib_dir):
        shutil.rmtree(lib_dir)
    os.makedirs(lib_dir)

    # 清掉旧版平铺在 AE/ 下的模块副本（会污染 ScriptUI Panels 菜单）
    flat_old = [n for n in ORDER if n != "07_ui.jsx"] + ["07_ui_a.jsx", "07_ui_b.jsx"]
    for name in flat_old:
        old = os.path.join(out_dir, name)
        if os.path.exists(old):
            try:
                os.remove(old)
            except OSError:
                pass

    for name in ORDER:
        if name == "07_ui.jsx":
            continue
        # 每个模块文件都必须单独带 UTF-8 BOM！拆成独立文件后，单文件顶部那个 BOM
        # 不再覆盖它们；模块里有中文，没有 BOM 时 ExtendScript 按系统 GBK 解码 → 中文乱码。
        with open(os.path.join(SRC_DIR, name), "r", encoding="utf-8-sig") as f:
            mod_code = f.read()
        with open(os.path.join(lib_dir, name), "w", encoding="utf-8-sig", newline="\n") as f:
            f.write(mod_code)
    # 07_ui：盖构建号 -> 去 IIFE -> 对半切
    ui = read_text(os.path.join(SRC_DIR, "07_ui.jsx"))
    ui = ui.replace('var BUILD = "dev";', 'var BUILD = "%s";' % stamp)
    ui = strip_ui_iife(ui)
    a, b = split_at_function(ui)
    with open(os.path.join(lib_dir, "07_ui_a.jsx"), "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(a)
    with open(os.path.join(lib_dir, "07_ui_b.jsx"), "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(b)
    with open(SCRIPTUI_BOOTSTRAP_TEMPLATE, "r", encoding="utf-8-sig") as f:
        bootstrap_code = f.read()
    for path in (OUT_FILE, OUT_FILE_ASCII):
        with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write(bootstrap_code)
        print("[OK] 已生成 %s  (%d 字节)" % (path, os.path.getsize(path)))
    print("[OK] 模块已写入 %s/（共 %d 个文件）" % (lib_dir, len(ORDER) + 1))


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def find_node():
    for c in NODE_CANDIDATES:
        if os.path.sep in c:
            if os.path.exists(c):
                return c
        else:
            return c
    return "node"


def strip_directives(code):
    """去掉 #target / #targetengine / #include 这类预处理指令行"""
    out = []
    for line in code.split("\n"):
        if re.match(r"^\s*#(target|targetengine|include|includepath|strict|engine)\b", line):
            out.append("")
        else:
            out.append(line)
    return "\n".join(out)


def strip_comments(code):
    """
    把注释替换成等长空白（保留换行），字符串内容保留。
    这样 ES3 检查就不会被注释里的 "..." 之类误伤。
    """
    out = []
    i = 0
    n = len(code)
    state = "normal"
    prev = ""
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""

        if state == "normal":
            if c == "/" and nxt == "/":
                state = "line"; out.append("  "); i += 2; continue
            if c == "/" and nxt == "*":
                state = "block"; out.append("  "); i += 2; continue
            if c == '"':
                state = "dq"; out.append(c); i += 1; prev = '"'; continue
            if c == "'":
                state = "sq"; out.append(c); i += 1; prev = "'"; continue
            # 正则字面量：前一个有效字符是运算符/括号时才可能是正则，避免把 a / b 当正则
            if c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%~^<>"):
                state = "re"; out.append(c); i += 1; continue
            out.append(c)
            if c == "\n":
                prev = ""
            elif not c.isspace():
                prev = c
            i += 1
            continue

        if state == "line":
            if c == "\n":
                state = "normal"; out.append("\n")
            else:
                out.append(" ")
            i += 1
            continue

        if state == "block":
            if c == "*" and nxt == "/":
                state = "normal"; out.append("  "); i += 2; continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue

        if state in ("sq", "dq"):
            if c == "\\":
                out.append("  "); i += 2; continue
            # 字符串内容也抹成空白：保留字、.map( 之类出现在字符串里是合法的
            out.append("  " if c != "\n" else "\n")
            if (state == "sq" and c == "'") or (state == "dq" and c == '"'):
                state = "normal"
            i += 1
            continue

        if state == "re":
            if c == "\\":
                out.append("  "); i += 2; continue
            out.append("  " if c != "\n" else "\n")
            if c == "/":
                state = "normal"
            i += 1
            continue

    return "".join(out)


# ExtendScript 对**单个编译单元**的字节上限，实测约 107KB。
# 超了之后解析器会中途放弃，报出来的「语法错误」行号指向超限处附近 ——
# 那一行本身往往完全正常，所以这个报错极难查。构建期必须拦。
SIZE_LIMIT = 107000


def node_syntax_err(code):
    """node --check（剥掉 #target 这类指令）。通过返回 None，否则返回错误文本。"""
    node = find_node()
    tmp = os.path.join(ROOT, "_tools", "_syntax_check.js")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(strip_directives(code))
        res = subprocess.run([node, "--check", tmp], capture_output=True,
                             text=True, encoding="utf-8", errors="replace")
        if res.returncode != 0:
            return (res.stderr or res.stdout or "").strip()
        return None
    except FileNotFoundError:
        return None
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


_REGEX_PREV = set("(,=:[!&|?{};+-*/%<>^~\n")
_REGEX_KW = set("return typeof case in instanceof delete void new".split())


def find_line_comment_at(text):
    """找出「`//` 行注释里带 `@`」的位置，返回 [(行号, 注释文本), ...]。

    ExtendScript 的预处理器会把 `//@xxx` 当 `//@target`、`//@include` 那一族的
    **指令**来解析，识别不了的变体直接报「语法错误」 —— 而且行号就指在那一行
    的代码上，看着完全无辜。本项目踩过一次，`// @i18n-allow 目录名` 这一句
    让 04_layers / 06_online / 08_preset / 09_bridge 四个模块全部加载失败，
    报错行恰好等于各自第一个 `// @i18n-allow` 所在行。
    （写成 `/* ... */` 块注释同样的内容反而没事，实测 02_util 有两个块注释
    形式的标记，加载正常。所以这里只拦行注释。）
    """
    bad = []
    i, n, line, prev = 0, len(text), 1, None
    st, q = "code", ""
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if st == "code":
            if c == "/" and i + 1 < n and text[i + 1] == "/":
                j = text.find("\n", i)
                j = n if j < 0 else j
                chunk = text[i:j]
                if "@" in chunk:
                    bad.append((line, chunk.strip()[:70]))
                prev = None
                i = j
                continue
            if c == "/" and i + 1 < n and text[i + 1] == "*":
                st = "bc"
                i += 2
                continue
            if c == '"' or c == "'":
                q, st, prev = c, "str", ("str", c)
                i += 1
                continue
            if c == "/":
                # 可能是正则字面量：只有前一个有效 token 能引出正则时才是
                can = (prev is None)
                if prev is not None:
                    pk, pt = prev
                    can = ((pk == "punct" and pt in _REGEX_PREV)
                           or (pk == "kw" and pt in _REGEX_KW))
                if can:
                    j, ok = i + 1, False
                    while j < n:
                        if text[j] == "\\":
                            j += 2
                            continue
                        if text[j] == "\n":
                            break
                        if text[j] == "/":
                            j += 1
                            ok = True
                            break
                        j += 1
                    if ok:
                        while j < n and text[j].isalpha():
                            j += 1
                        prev = ("re", "/")
                        i = j
                        continue
            if c.isalpha() or c in "_$":
                j = i
                while j < n and (text[j].isalnum() or text[j] in "_$"):
                    j += 1
                w = text[i:j]
                prev = (("kw" if w in _REGEX_KW else "id"), w)
                i = j
                continue
            if c.isdigit():
                j = i
                while j < n and (text[j].isalnum() or text[j] == "."):
                    j += 1
                prev = ("num", text[i:j])
                i = j
                continue
            prev = ("punct", c)
            i += 1
            continue
        if st == "str":
            if c == "\\":
                i += 2
                continue
            if c == q:
                st, prev = "code", ("str", q)
            i += 1
            continue
        if st == "bc":
            if c == "*" and i + 1 < n and text[i + 1] == "/":
                st = "code"
                i += 2
                continue
            i += 1
            continue
        i += 1
    return bad


def verify_unit(path):
    """检查一个**真的要交给 ExtendScript 的编译单元**（bootstrap 或模块文件）。

    这里查的几条，每一条都对应本项目一次真实的翻车：
      · 缺 BOM            → 模块里的中文按系统 GBK 解码 → 乱码，甚至吞掉引号报语法错
      · 第 1 行是指令     → BOM 把 #target 废掉 → 「在行 1 无法执行脚本。语法错误」
      · 含 #targetengine  → 这个模块被切到命名引擎，全局 SB 与 evalScript 侧不是同一个对象
      · 超 107KB          → 解析器中途放弃，报出的「语法错误」行号是别处的代码
      · 行注释里带 @      → 被当 //@xxx 指令解析，报语法错误，行号就在那一行
    """
    problems = []
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:3] == b"\xef\xbb\xbf":
        text = raw[3:].decode("utf-8", "replace")
    else:
        problems.append("缺少 UTF-8 BOM（中文会乱码 / 可能吞引号）")
        text = raw.decode("utf-8", "replace")
    if len(raw) >= SIZE_LIMIT:
        problems.append("超过 %.0fKB 单编译单元上限（实际 %d 字节）"
                        % (SIZE_LIMIT / 1024.0, len(raw)))
    first = text.split("\n")[0].lstrip()
    if first.startswith("#"):
        problems.append("第 1 行是预处理指令（BOM 会把它废掉，报「在行 1 语法错误」）")
    if re.search(r"(?m)^\s*#targetengine\b", text):
        problems.append("含 #targetengine 指令（会把该模块切到别的引擎）")
    ats = find_line_comment_at(text)
    if ats:
        problems.append(
            "行注释里含 @（ExtendScript 会当 //@xxx 指令解析 → 直接报语法错误）："
            + "；".join("第%d行「%s」" % (ln, s) for ln, s in ats[:6]))
    if "@i18n" in text:
        problems.append("残留 @i18n 标记（已改名为不含 @ 的 i18n-allow）")
    err = node_syntax_err(text)
    if err:
        problems.append("语法检查未通过：\n      " + err.replace("\n", "\n      ")[:500])
    return problems


def verify_units(paths, title):
    """批量 verify_unit 并打印结果。返回有问题的文件数。"""
    bad = 0
    for p in paths:
        probs = verify_unit(p)
        if probs:
            bad += 1
            print("!! [%s] %s" % (title, os.path.basename(p)))
            for x in probs:
                print("     - %s" % x)
        else:
            print("   [OK] %-24s %7.1fKB" % (os.path.basename(p), os.path.getsize(p) / 1024.0))
    return bad


def check_xml(paths):
    """校验写出去的 XML 真的能被解析（CEP 的 manifest.xml / .debug 用）。

    为什么必须单独查一遍：manifest.xml 写坏了，CEP 是**静默拒绝**的 ——
    表现是「PR / AE 的窗口 > 扩展菜单里根本没有这个插件」，一句报错都没有，
    只能去 %TEMP%\\CEP11-PPRO.log 里翻。实测踩过一次：
    在 XML 注释里写了两个连续的减号（XML 规定注释内容不得包含它），
    日志里只会出现一行 `Comment must not contain '--' (double-hyphen)`。

    这里用真正的解析器过一遍，并把这个高频原因单独指出来。
    返回有问题的文件数。
    """
    import xml.etree.ElementTree as ET

    bad = 0
    for p in paths:
        if not os.path.exists(p):
            print("!! 缺少 XML 文件：%s" % p)
            bad += 1
            continue
        try:
            ET.parse(p)
            print("[OK] %s 是合法 XML" % os.path.basename(p))
            continue
        except ET.ParseError as e:
            print("!! %s 不是合法 XML：%s" % (os.path.basename(p), e))
            bad += 1

        # 注释可以跨行，所以要带着状态扫，不能只看单行
        text = read_text(p)
        inside = False
        hit = 0
        for i, line in enumerate(text.splitlines(), 1):
            j = 0
            while j < len(line):
                if inside:
                    k = line.find("--", j)
                    if k < 0:
                        break
                    if line.startswith("-->", k):
                        inside = False
                        j = k + 3
                        continue
                    print("     第 %d 行：XML 注释里出现了连续减号（--），"
                          "这就是解析失败的原因" % i)
                    print("               %s" % line.strip()[:90])
                    hit = 1
                    break
                a = line.find("<!--", j)
                if a < 0:
                    break
                inside = True
                j = a + 4
            if hit:
                break
    return bad


def main():
    if not os.path.isdir(SRC_DIR):
        print("找不到源码目录: %s" % SRC_DIR)
        return 1

    parts = []
    missing = []
    for name in ORDER:
        path = os.path.join(SRC_DIR, name)
        if not os.path.exists(path):
            missing.append(name)
            continue
        with open(path, "r", encoding="utf-8") as f:
            parts.append(f.read().rstrip("\n"))

    if missing:
        print("缺少模块: %s" % ", ".join(missing))
        return 1

    banner = ("\n\n/* " + "=" * 72 + "\n * "
              " 模块：%s\n * " + "=" * 72 + " */\n\n")

    chunks = []
    for name, code in zip([n for n in ORDER if n not in missing], parts):
        chunks.append(banner % name)
        chunks.append(code)

    merged = "\n".join(chunks) + "\n"

    # 0) 盖上构建时间戳。
    #    面板标题和「关于」页都会显示它 —— 用户说「功能不好使」的时候，
    #    先看一眼这个号就知道 AE 里跑的是不是最新那版（旧版面板要重启 AE 才会换）。
    stamp = datetime.datetime.now().strftime("%m-%d %H:%M")
    placeholder = 'var BUILD = "dev";'
    if placeholder not in merged:
        print("!! 找不到构建号占位符 %s（07_ui.jsx 里被改过？）" % placeholder)
        return 5
    merged = merged.replace(placeholder, 'var BUILD = "%s";' % stamp)
    print("[OK] 构建号：%s" % stamp)

    # 1) ES3 兼容检查（在去掉注释的代码上做，避免注释误伤）
    #    除了插件本体，tests/ae/ae_selftest.jsx 也要一起查 —— 它同样跑在 ExtendScript 里，
    #    踩过一次「变量名叫 native」导致整个自检脚本 SyntaxError 的坑。
    targets = [("AE/歌词字幕排版工具.jsx", merged)]
    selftest = os.path.join(ROOT, "tests", "ae", "ae_selftest.jsx")
    if os.path.exists(selftest):
        with open(selftest, "r", encoding="utf-8") as f:
            targets.append(("tests/ae/ae_selftest.jsx", f.read()))

    all_problems = []
    all_warns = []
    for label, code in targets:
        checked = strip_comments(code)
        for pattern, msg in ES3_FORBIDDEN:
            for m in re.finditer(pattern, checked):
                line_no = checked[:m.start()].count("\n") + 1
                all_problems.append("  [%s] 第 %d 行：%s  →  %s" % (label, line_no, msg, m.group(0)[:60]))
        for pattern, msg in ES3_WARN:
            for m in re.finditer(pattern, checked):
                line_no = checked[:m.start()].count("\n") + 1
                all_warns.append("  [%s] 第 %d 行：%s  →  %s" % (label, line_no, msg, m.group(0)[:60]))

    if all_problems:
        print("!! ES3 兼容检查未通过（ExtendScript 会直接报错）：")
        for p in all_problems[:40]:
            print(p)
        return 2

    # 1.5) 正则里未转义斜杠的检查
    #      ExtendScript 的旧词法分析器会把字符类里的 / 当成正则的结束符，把后面的
    #      字符当代码解析，最终报出「ReferenceError: 无法显示在分配的左边，因为它为只读」
    #      这种完全看不懂的错误，而且不给任何有用线索。
    #      node --check 查不出来（标准 JS 允许字符类里写 /），所以必须单独查。
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import check_jsx
        regex_problems = []
        for label, code in targets:
            for ln, src, why in check_jsx.find_bad_regex_slash(code):
                regex_problems.append("  [%s] 第 %d 行：%s\n        %s" % (label, ln, why, src[:100]))
        if regex_problems:
            print("!! 正则检查未通过（ExtendScript 会把正则截断，报错信息完全对不上）：")
            for p in regex_problems[:20]:
                print(p)
            return 4
        print("[OK] 正则斜杠检查通过")
    except ImportError:
        print("[跳过] 没找到 check_jsx.py，跳过正则检查")

    # 1.6) ES3 严格校验（acorn, ecmaVersion:3）
    #      node --check 按 ES5+ 解析，会放过「对象字面量尾随逗号」「getter 字面量」
    #      「正则后顾断言」「数字分隔符」这些 ExtendScript 直接报语法错误的写法。
    #      acorn 的 ES3 模式能抓住；它不查「保留字当标识符」，那条由上面 1) 负责。
    es3_js = os.path.join(ROOT, "_tools", "es3_check.js")
    if os.path.exists(es3_js):
        tmp_es3 = os.path.join(ROOT, "_tools", "_es3_target.jsx")
        try:
            with open(tmp_es3, "w", encoding="utf-8") as f:
                f.write(merged)
            res = subprocess.run([find_node(), es3_js, tmp_es3],
                                 capture_output=True, text=True,
                                 encoding="utf-8", errors="replace")
            sys.stdout.write(res.stdout or "")
            if res.returncode == 1:
                print("!! ES3 严格校验未通过（ExtendScript 会报「语法错误」）")
                return 6
        except FileNotFoundError:
            print("[跳过] 没找到 node，跳过 ES3 严格校验")
        finally:
            if os.path.exists(tmp_es3):
                os.remove(tmp_es3)
    else:
        print("[跳过] 没找到 _tools/es3_check.js")

    # 2) 语法检查
    node = find_node()
    tmp_js = os.path.join(ROOT, "_tools", "_syntax_check.js")
    try:
        for label, code in targets:
            with open(tmp_js, "w", encoding="utf-8") as f:
                f.write(strip_directives(code))
            # 必须显式给 utf-8：Windows 下默认用 gbk 解码 node 的输出，
            # 报错行里带中文时会 UnicodeDecodeError，把真正的语法错误整条吞掉。
            res = subprocess.run([node, "--check", tmp_js], capture_output=True,
                                 text=True, encoding="utf-8", errors="replace")
            if res.returncode != 0:
                print("!! 语法检查未通过（%s）：" % label)
                print(res.stderr or res.stdout)
                return 3
        print("[OK] 语法检查通过（node --check，%d 个文件）" % len(targets))
    except FileNotFoundError:
        print("[跳过] 没找到 node，跳过语法检查")
    finally:
        if os.path.exists(tmp_js):
            os.remove(tmp_js)

    # 3) 输出（UTF-8 with BOM）—— 拆成 bootstrap + 各模块独立文件，绕开 ExtendScript 大小上限
    write_split_scriptui(stamp)

    # 3.5) 校验**真正写出去的每个编译单元**（bootstrap + 每个模块）。
    #      以前只检查内存里拼出来的 merged 字符串，产出文件本身从没查过 ——
    #      结果「模块缺 BOM」「bootstrap 第 1 行是指令」这类问题都是用户先撞上的。
    lib_dir = os.path.join(os.path.dirname(OUT_FILE), "lyric_modules")
    units = [OUT_FILE, OUT_FILE_ASCII]
    units += [os.path.join(lib_dir, n) for n in sorted(os.listdir(lib_dir))
              if n.endswith(".jsx")]
    print("\n[校验] 逐个编译单元（BOM / 第 1 行 / 107KB 上限 / 语法）：")
    if verify_units(units, "ScriptUI"):
        print("!! 产出文件有问题，先别装进 AE")
        return 7

    if all_warns:
        print("\n[提醒] 下面这些写法在 ExtendScript 里可能不存在，请确认（也可能是字符串内容）：")
        for w in all_warns[:20]:
            print(w)
        print("  共 %d 处。" % len(all_warns))

    print("\n完成。把 %s 和同目录下的 lyric_modules/ 文件夹一起复制到"
          "\nAE 的 Support Files\\Scripts\\ScriptUI Panels\\ 即可。"
          "\n（bootstrap 会自动到 lyric_modules/ 里逐个 $.evalFile 加载模块，"
          "不要再单独复制 lyric_modules 里面的 .jsx，否则它们会被 AE 当成面板）"
          % os.path.basename(OUT_FILE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
