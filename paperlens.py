# -*- coding: utf-8 -*-
#!/usr/bin/env python3
"""paperlens · 论文解析看板
作者：李子正（正点 / OPC）
仓库：https://github.com/Az0R119/paperlens
设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
"""
"""paperlens · 论文解析智能体（比赛原型）

PDF → 章节定位 → 泛读四步切片 → AI 抽结构化 JSON → Mermaid 导图 + HTML 看板

方法学依据：
- 李旭《研究生科研第一课》(高教学刊 2023): 泛读=标题摘要→图→首末段→每段首末句；
  引言只看研究目的、结果重点看图、结论是精华；精读=批判式(问题/局限/证据/可重复)
- Neel Nanda: 论文=一个论证故事（What/Why/So What）
- Farquhar: 摘要5句公式
- BiliSum: 导图节点带溯源；预设即数据

只用 stdlib + pymupdf + 用户自带 API key。零 key 时走本地规则版（不崩）。
"""

import html
import json
import os
import re
import time
import urllib.request

import pymupdf

# 核心句提取（TextRank）—— 独立模块，纯标准库，不需要模型/key。
# 放在同级目录而不是 research/ 下：research/ 是研究脚本，产品不该依赖它。
from textrank import extract_key_sentences, split_sentences
# ★ OCR 判据/执行器。踩过的坑：在 extract_text() 里直接写了 needs_ocr(...)，
#   但没导入 → NameError，跑测试才发现。凡是新用的名字都要在这里出现。
from paperlens_ocr import needs_ocr, ocr_pdf

# ---------- 全文提取 ----------

def strip_headers_footers(pages: list, edge: int = 2) -> str:
    """去掉每页重复的页眉/页脚。

    为什么必须做（实测）：中文期刊 PDF 的页眉是期刊名，在 46,865 字的正文里
    出现 14 次；还有英文刊名、DOI 行、页码。这些混在正文里会同时伤害三处：
    AI 当正文读、目录抽取要过滤、TextRank 要多加规则。

    **关键：判据不只是"重复"，还要"位置在页首/页尾"。**
    只看重复会误删正文 —— 实测 arXiv 论文每页顶部有 running header
    （当前章节名，如 "3 Model Architecture"），只看重复就把它们当页眉删了，
    目录从 37 条掉到 3 条。真正的页眉页脚只在每页的头几行/末几行。

    edge: 每页开头和结尾各看几行。
    """
    if len(pages) < 3:                     # 页太少，统计没意义
        return "\n".join(pages)

    def key(line):
        # 去掉数字后再比对：页码每页都变（"1" "2" "3"），但位置固定
        return re.sub(r"\d+", "#", line.strip())

    # 只在"页首 N 行 + 页尾 N 行"里统计频次 —— 正文中间重复出现的不算页眉
    freq = {}
    for pg in pages:
        lines = [l for l in pg.splitlines() if l.strip()]
        band = lines[:edge] + lines[-edge:]
        for ln in set(key(l) for l in band):
            freq[ln] = freq.get(ln, 0) + 1

    thr = len(pages) * 0.4                 # 出现在 40% 以上页面的页首/页尾 = 页眉页脚
    out = []
    for pg in pages:
        lines = pg.splitlines()
        keep = []
        for i, ln in enumerate(lines):
            s = ln.strip()
            if not s:
                keep.append(ln)
                continue
            lines_nb = [l for l in lines if l.strip()]
            try:
                pos = lines_nb.index(ln)
            except ValueError:
                pos = 0
            in_band = pos < edge or pos >= len(lines_nb) - edge
            if in_band and len(s) <= 60 and freq.get(key(ln), 0) >= thr:
                continue
            keep.append(ln)
        out.append("\n".join(keep))
    return "\n".join(out)


# 标题页的元信息行 —— 不是页眉（只出现一次），但对读者和 AI 都是垃圾。
# 实测中文期刊首页：`DOI:...` `收稿日期:...` `基金项目:...` `(邮箱@xxx.edu.cn)`。
_FRONT_META = re.compile(
    r"^\s*(DOI\s*[:：]|dOI\s*[:：]|收稿日期|修回日期|基金项目|资助项目|"
    r"作者简介|通信作者|E-?mail|电子邮件|"
    r"[\w.\-]+@[\w.\-]+\.\w+|"
    r"This work was supported by|"
    r"Journal of [A-Z]|"
    r"\([^)]*@[^)]*\)\s*$)", re.I)


def strip_front_meta(text: str) -> str:
    """去掉标题页的元信息行（DOI/收稿日期/基金/邮箱/单位）。

    这些行只出现一次，页眉页脚规则（按重复次数）抓不到，但它们既不是正文、
    AI 读进去还会被干扰（实测 AI 会把基金号当论文内容写进摘要）。
    """
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if s and _FRONT_META.match(s):
            continue
        out.append(ln)
    return "\n".join(out)


def extract_text(pdf_path: str) -> str:
    """抽 PDF 文本层 → 去页眉页脚 → 去标题页元信息 → 全角归一化。

    全角归一的原因：中文期刊 PDF 常把英文数字渲成全角，不归一 AI 会读错，
    切句也切不开（实测 46,865 字只切出 5 段）。

    ★ 文本层坏死时自动走 OCR（实测《中国成人血脂异常防治指南》就是这种）
      那份 PDF 是扫描件，数字用了没写 ToUnicode 的老字体，抽出来是
      "从 \\x01\\x01\\x01 年到 \\x01\\x01\\x01年"（本该是 1984/1999）。
      判据：控制字符占比 > 0.2%（正常 PDF ≈ 0，那份 ≈ 3%）。
      走 OCR 时：前 12 页、200dpi、按栏重排 —— 实测 3 页 60 秒，
      1984/1999/26.5%/16.6%/2136 全读对，剩余控制字符 0。

      为什么放在这里：这是**所有入口唯一共用的抽取函数**（单篇分析、批量、
      CLI 都走它），修在这里一次覆盖全部调用方，不用每个入口各加一遍。
    """
    doc = pymupdf.open(pdf_path)

    # ★★ 第一步：先试坐标修版（几秒，不读图）
    #   大部分论文排版是标准的，坐标本身是好的，只是"按 y 排序"把左右栏读串了。
    #   这种情况重排一下就行，不必花几分钟 OCR。
    #   判据在 reorder_by_coords 里：抽样检查每页"跨栏行"占比，超过 8% 就认为
    #   坐标已烂（CNKI ReaderEx 那种把两栏塞进同一个 line 的），直接放弃。
    reordered, linfo = (None, {})
    try:
        from paperlens_ocr import reorder_by_coords
        reordered, linfo = reorder_by_coords(doc)
    except Exception as e:
        print(f"[坐标修版] 失败：{e}", file=sys.stderr)

    if reordered:
        # 修版成功：再做文本层质量检查（字符层面可能还是坏的，比如 \x01）
        if not needs_ocr(reordered):
            doc.close()
            return _norm_fullwidth(strip_front_meta(
                strip_headers_footers(reordered.split("\n"))))
        raw_for_check = reordered
    else:
        raw_for_check = "".join(pg.get_text() for pg in doc)

    pages = [pg.get_text() for pg in doc]
    doc.close()
    raw = "".join(pages)

    # ★★ 第二步：坐标不可信 或 字符层面坏了 → OCR 读图
    #   实测两类必须走这里：
    #     血脂指南  数字全是 \x01（ctrl 24%）
    #     健康中国  CNKI 生成的，line 横跨两栏（wide_ratio 高）且 PUA 6.69%
    if needs_ocr(raw_for_check):
        try:
            r = ocr_pdf(pdf_path)
            if r["text"] and len(r["text"]) > len(raw) * 0.5:
                # ★ OCR 出来的行是**版面硬换行**（一行读完就换行），中文必须拼回去，
                #   否则句子被切碎（实测："率、5岁以下儿童死亡率、孕产妇死亡率分别下"
                #   + "降到8.1%..." 会被当成两句）。
                #   拼行规则：中文行之间直接连（中文没有词的间隔，换行只是排版）；
                #   只有以句末标点结尾、或遇到空行（段落分隔）才断开。
                pages_txt = r["text"].split("\n\n")
                merged = []
                for ptxt in pages_txt:
                    lines = [x.strip() for x in ptxt.split("\n") if x.strip()]
                    buf = ""
                    for ln in lines:
                        if not buf:
                            buf = ln
                        elif re.search(r"[。！？；：!”』）】]$", buf):
                            merged.append(buf)
                            buf = ln
                        else:
                            buf += ln          # 中文直接连，不加空格
                    if buf:
                        merged.append(buf)
                return _norm_fullwidth(strip_front_meta(
                    strip_headers_footers(merged)))
        except Exception as e:
            print(f"[OCR] 失败，退回文本层：{e}", file=sys.stderr)

    return _norm_fullwidth(strip_front_meta(strip_headers_footers(pages)))


def _norm_fullwidth(t: str) -> str:
    out = []
    for ch in t:
        o = ord(ch)
        if 0xFF01 <= o <= 0xFF5E:
            out.append(chr(o - 0xFEE0))   # 全角ASCII → 半角
        elif o == 0x3000:
            out.append(" ")               # 全角空格
        else:
            out.append(ch)
    return "".join(out)


# ---------- 章节定位（正则，多模式兼容中英文） ----------

# 中文论文 + 英文顶会都要能吃。顺序敏感：越具体的放前面。
# 摘要：中文常见「摘  要：正文…」紧跟冒号(不换行)，英文是「Abstract\n正文」——两种都收。
_ABSTRACT = r"(?:^|\n)\s*(?:摘\s*要|内容提要|Abstract)\s*[:：]?\s*\n?"
_INTRO    = r"(?:^|\n)\s*(?:1\s*[\.、]?\s*(?:引\s*言|绪\s*论)|一\s*[、.]?\s*(?:引\s*言|绪\s*论)|1\s*\n\s*Introduction)\s*\n"
# 兜底引言：编号 + 常见首章名（中文论文常把首章写成"研究背景/概述/相关工作"而不叫"引言"）
# 实测《知识图谱构建技术综述》整篇没有"引言"标题，首章直接是"1 知识图谱的定义与架构"，
# 导致摘要锚点吃掉整个引言区（结构显示"引言 0 字"）。
_INTRO_FALLBACK = r"(?:^|\n)\s*(?:1|一)\s*[\.、]?\s*(?:研究背景|背景|概述|引言|绪论|相关工作)\s*\n"
# 结论章：编号可有可无，名字至少有这几种。
# 实测踩坑：原正则把"结束语""总结与展望"写成**无编号**分支，而中文期刊实际是"6 结束语"
# （《知识图谱构建技术综述》）—— 于是永远匹配不到，结构显示"结论 0 字"。
# 改成"可选编号 + 章名"，一个分支覆盖带编号/不带编号两种。
_CONCL    = (r"(?:^|\n)\s*(?:\d{1,2}\s*[\.、]?\s*)?"      # 可选编号（"6 " / "5. "）
             r"(?:结\s*论|结束语|结\s*语|总结与展望|结论与展望|"
             r"结\s*论\s*与\s*展\s*望|Conclusion|Conclusions)"
             r"\s*[:：]?\s*\n")
_REFS     = r"(?:^|\n)\s*(?:参\s*考\s*文\s*献|References)\s*\n"


def extract_doi(text: str) -> str:
    """从论文头部抽 DOI → 可点击链接。找不到返回空。

    坑：PDF 里 `/` 常被渲成 `?`（如 `10.7544?issn1000-...`），两种都要认。
    另外中文期刊常无 DOI，退回「文章编号」（ISSN 刊号，不可跳转，仅标注）。
    """
    head = text[:4000]
    m = re.search(r"(?:DOI|doi)\s*[:：]?\s*(10\.\d{4,9}[/?][^\s，。;；、]+)", head)
    if m:
        doi = m.group(1).replace("?", "/").rstrip(".,;")
        return "https://doi.org/" + doi
    m = re.search(r"(?:arXiv)\s*[:：]?\s*(\d{4}\.\d{4,5})", head, re.I)
    if m:
        return "https://arxiv.org/abs/" + m.group(1)
    return ""


def extract_cn_code(text: str) -> str:
    """中文期刊「文章编号」（无 DOI 时的退路，只做标注不跳转）。
    形如 2096-000X(2023)06-0047-04 —— 含括号，别在 '(' 处断掉。"""
    m = re.search(r"文章编号\s*[:：]?\s*([\dXx][\d\-Xx()]{7,})", text[:3000])
    return m.group(1).strip() if m else ""


def locate_sections(text: str) -> dict:
    """定位各章节 char 区间。定位不到返回空串（不崩）。"""
    def find(pat, start=0):
        m = re.search(pat, text[start:], re.M)
        return (start + m.start(), start + m.end()) if m else None

    out = {"abstract": "", "intro": "", "conclusion": "", "body": ""}
    ab = find(_ABSTRACT)
    intro = find(_INTRO)
    if not intro and ab:
        # 没有"引言"标题时退化：从摘要之后找"1 研究背景/概述"这类首章标题
        intro = find(_INTRO_FALLBACK, ab[1])
    concl = find(_CONCL)
    refs = find(_REFS)

    if ab:
        # 摘要右边界：优先"引言之前"，否则往后看 2500 字。
        end = intro[0] if intro and intro[0] > ab[1] else min(ab[1] + 2500, len(text))
        seg = text[ab[1]:end]
        # 中文期刊常是"英文摘要在前、中文摘要在后"，2500 字窗口会把中文那份截掉
        # （实测《知识图谱构建技术综述》：前 2500 字是英文摘要，中文摘要从 2115 起
        #   刚好被窗口切在中间 —— 段里有 672 个中文字，但句首还是英文）。
        # 判据不看"中文多少"，而看"**段首是英文、段内却有中文**" —— 这就是双语摘要。
        _head = re.sub(r"\s+", "", seg[:200])
        if re.search(r"[\u4e00-\u9fff]", seg) and not re.search(r"[\u4e00-\u9fff]", _head):
            end = intro[0] if intro and intro[0] > ab[1] else min(ab[1] + 8000, len(text))
            seg = text[ab[1]:end]
        out["abstract"] = seg.strip()
    if intro:
        end = refs[0] if refs and refs[0] > intro[1] else len(text)
        out["intro"] = text[intro[1]:end].strip()
    if concl:
        end = refs[0] if refs and refs[0] > concl[1] else len(text)
        out["conclusion"] = text[concl[1]:end].strip()

    # 正文：引言之后到结论之前（结论缺失则到参考文献前）
    b_start = intro[1] if intro else 0
    b_end = concl[0] if concl else (refs[0] if refs else len(text))
    if b_end > b_start:
        out["body"] = text[b_start:b_end].strip()
    return out


# ---------- 本地规则版（零 key 兜底） ----------

def local_analyze(text: str) -> dict:
    """不调 API 的兜底：靠正则抽标题/摘要要点，保证零 key 也能出东西。"""
    secs = locate_sections(text)
    lines = [x.strip() for x in text.split("\n") if x.strip()]
    title = lines[0] if lines else "未识别标题"
    # 标题后 2-3 行常常还是刊名/作者，取最长的一行当中文标题
    cand = [l for l in lines[:8] if 6 <= len(l) <= 60 and not re.search(r"(第\s*\d+\s*卷|Vol\.|ISSN|DOI|http)", l)]
    if cand:
        title = max(cand, key=len)
    # 摘要优先取中文段 —— 中文期刊常是"英文摘要 + 中文摘要"双份，
    # 直接截前 600 字会拿到英文那份（实测：中文论文的一句话变成英文，
    # 读者一眼就出戏）。
    abstract = _prefer_chinese(secs["abstract"])[:600]
    return {
        "meta": {"title": title, "one_sentence": abstract[:100] or "（未抽取到摘要）",
                 "type": _guess_type(text), "quality": 3},
        "gap": "", "method": "", "did": "",
        "results": [], "contribution": [], "limitation": "",
        "critique": {}, "chain": [],
        "_mode": "local",   # 标记：本地规则版，没调 AI
    }


def _prefer_chinese(s: str) -> str:
    """从混合文本里挑出中文占比最高的连续段落。

    用途：中文期刊的双语摘要，要挑中文那份；英文论文全是英文则原样返回。
    """
    if not s or not s.strip():
        return s
    # 只按**空行**切段。原先写成 r"\n\s*\n|\n"（多了个 |\n）会把单换行也当切点 ——
    # PDF 抽出的摘要在每个换行处都是硬换行，结果整段被切碎，挑出来的是半句
    # （实测："种信息检索方式已经很难满足…" 从句子中间开始）。
    paras = [x.strip() for x in re.split(r"\n\s*\n", s) if x.strip()]
    if not paras:
        paras = [s.strip()]
    if not paras:
        return s

    def cn_ratio(x):
        return len(re.findall(r"[\u4e00-\u9fff]", x)) / max(1, len(x))

    m = re.search(r"[\u4e00-\u9fff]", s)
    if not m:
        return s                      # 整段没中文（英文论文），原样返回

    # 先把"中文占比最高的独立段落"作为候选
    best = max(paras, key=lambda x: (cn_ratio(x), len(x)))
    if re.search(r"[\u4e00-\u9fff]", best[:80]):
        return best                   # 候选本身就以中文起头，直接用

    # 否则：中英摘要黏在一起（无空行），或整个 2500 字窗口是"英文在前、中文在后"
    # （实测《知识图谱构建技术综述》："Abstract Google's ..." 紧接 "摘 要 谷歌知识图谱…"）。
    # 判据只有一条：**段内有中文，就从中文首次出现处截**。
    # 不再用"中文占比 ≥ X%"这类阈值 —— 试过两轮都被阈值卡住，而这里根本不需要比例。
    return s[m.start():] if m.start() > 0 else s


def _guess_type(text: str) -> str:
    """粗略判断论文类型：综述 / 实证 / 教育。"""
    head = text[:3000]
    if re.search(r"(综\s*述|研究进展|review|survey)", head, re.I):
        return "survey"
    if re.search(r"(学位论文|硕士学位论文|博士学位论文|thesis)", head, re.I):
        return "thesis"
    if re.search(r"(教学|课程|教育|培养|教学改革)", head):
        return "education"
    return "empirical"


# ---------- AI 抽取 ----------

AI_PROMPT = """请阅读下面的中文/英文学术论文内容。

=== 标题与摘要 ===
{abstract}

=== 引言 ===
{intro}

=== 结论 ===
{conclusion}

=== 正文节选 ===
{body}

=== 图表标题 ===
{figures}

=== 任务 ===
按学术界的"泛读四步法"解析这篇论文，并补一个"审稿人视角"的批判式评估。

要点：

- meta.one_sentence：**读者视角的一句话判断**（40-70字），不是复述论文做了什么。
  要回答：这篇能解决谁的问题 + 读完能拿走什么 + 值不值得读。
  反面例子（现在这种，别写）："本文自底向上分三层综述了知识图谱构建的关键技术" ← 只说了论文做了啥
  正面例子："想搞清知识图谱从原始文本到可用知识库的完整流水线，这篇是最完整的路线图；
  三层架构可直接当项目设计参考，但技术对比偏定性、无实验数据。"
- meta.background：这论文写作时的领域处境（1-2句）。讲清"当时大家卡在哪"。
- gap：**只写"卡在哪"**（一句话，20-40字）。不要提方法、不要提三层架构/框架名。
  例："概念边界不清，技术散落在 NLP、本体工程、语义 Web 等多个社区，缺统一框架。" ← 好
  例："如何用统一框架把三层技术组织成流水线……" ← 差（这是 approach 的内容）
- approach：**只写"怎么做的"**（80-150 字）。不要再复述 gap 里那个问题。
  也不要在这一节重复 contribution 里已经列过的贡献点。
- contribution：贡献/创新点，逐条列（每条 15-30 字，只写结论式的"提出了什么"，不解释）。
  与 approach 的分工：approach 讲**怎么走这条路**（顺序、步骤、范围），
  contribution 讲**最后拿到了什么**（产物、结论）。同一个"三层架构"不要在两边都解释一遍。
- results：关键结果，**必须带原文的具体数字**（74.2% 这类）。
  ★ 但**不许编数字**。综述/理论/教育类论文常常根本没有实验数据 ——
  这时就写一条说明（例："论文为综述类工作，未报告实验数据或量化指标"），
  **不要为了凑数去编一个看起来像结果的数**。
  判断方法：这个数字在原文字面上能搜到吗？搜不到就不要写。
  （实测教训：同一篇中文综述三次跑出过 3 条 / 1 条 / 0 条 —— 那 3 条是编的。
   原文含百分号的句子数 = 0，客观上就是没有数字。）
- figures：每张图表说明了什么（结果往往在图里）。
- sections：**目录摘要**（30-60 字/条）。按下面【论文自带目录】逐条写，
  写具体内容（用了什么方法、得出什么），**不要复述章节名**。
  这些摘要会挂在「📑 目录」每一条后面（不再单独出「逐章内容」板块，那与目录重复）。
  **英文论文必填 `title_zh`**：把章节英文标题翻成中文（术语保留英文，如
  "Multi-Head Attention" → "多头注意力 (Multi-Head Attention)"）。
  中文论文章节 `title_zh` 留空。
- limitation：局限。
- critique：审稿人视角（研究问题 / 证据是否充分 / 可否重复 / 可改进之处）。
- borrow：**读者能直接拿回去用的东西**（逐条，每条 15-35 字）。
  ★ 关键是「可操作」，不是「评价这篇论文」。写给读者看，不是给论文写评语。
  好的（照这个写）：
    · 缩放点积注意力中除以维度平方根的稳定性技巧
    · warmup 加逆平方根衰减的学习率调度
    · 用多头注意力替代循环结构以提升并行度的设计思路
    · "被引—参考文献—录用期刊—管理软件"四步初筛法
  差的（别写这种，这是论文评语不是借鉴点）：
    · 按抽象程度分层组织技术的框架，可直接迁移到其他领域综述 ← 空泛，换哪篇综述都成立
    · 自底向上、逐层递进的综述写法，便于读者建立整体认知     ← 说的是"论文写得好"
  判断标准：**第一条指令里能不能写进一个具体的动作/参数/结构**。
  写不进去 = 太泛，重写。

**避免重复的三条硬规则**（这些板块内容最容易撞车）：
1. `one_sentence` 面向读者判断；`background` 讲领域处境；`gap` 只讲卡在哪——
   三者不许出现同一句话，也不许都把"三层架构"搬出来说一遍。
2. `approach` 讲怎么做的；`contribution` 只列结论式的成果。同一件事不要两边都写。
3. 不要写"背景→方法→做法→结果→意义"那种论证链——它跟 approach 是同一件事。

**自检**：输出前扫一遍，若同一件事（例如"三层架构"）在三个以上字段出现，删到只剩最该说的那一个。

=== 论文自带目录 ===
{outline}

只输出 JSON，不要任何其他文字：
{{
 "meta": {{"title":"论文标题", "one_sentence":"读者视角的判断：解决谁的问题+能拿走什么+值不值得读", "background":"领域处境", "type":"survey|empirical|theory|education|thesis", "quality":1到5的整数}},
 "gap": "要解决的科学问题",
 "approach": "方法+做法（一个字段，别拆两段重复）",
 "contribution": ["创新点/贡献"],
 "results": ["带具体数字的关键结果"],
 "figures": ["每张图表说明了什么"],
 "sections": [{{"num":"1.1","title":"研究背景","title_zh":"英文标题的中文翻译（中文论文留空）","summary":"这章讲了什么（30-60字）"}}],
 "limitation": "局限",
 "critique": {{"question":"","evidence_ok":"","reproducible":"","improve":""}},
 "borrow": ["可借鉴的点"]
}}"""


def extract_outline(text: str, limit: int = 60) -> list:
    """抽论文**自带的目录/章节结构**（不是我们自己编的）。

    实测踩过的坑（都在这段正则里处理了）：
      · 页码带括号 "(1)" —— 只认裸数字会从第 3 章起全漏
      · 点线里混着全角句号 ··· 。。。
      · 摘要/Abstract 这类不编号的条目
      · 页码被当成编号（"21"）
      · 期刊页眉逐字拆行（"华\\n中\\n科\\n技\\n大\\n学..."）污染正文
    返回 [{"level":1, "num":"1.1", "title":"研究背景"}]，按出现顺序。
    """
    out, seen = [], set()
    _NOISE = re.compile(r"^(计\s*算\s*机|软件\s*学报|电子\s*学报|中国\s*科学|"
                        r"第\s*\d+\s*期|第\s*\d+\s*卷|\d{4}\s*年)")

    def _add(num, title, level=None, pos=0):
        num = (num or "").strip()                   # findall 给的是 None，不是 ""
        title = re.sub(r"\s+", " ", title).strip(" .。:：·…\t")
        # "1 1 绪论" 这类重复编号：编号后面还跟着数字就是抓歪了
        if re.match(r"^\d", title):
            return
        if not title or len(title) > 40 or _NOISE.match(title):
            return
        if num and not re.match(r"^\d{1,2}(\.\d{1,2}){0,3}$", num):
            return                                  # 编号必须是 1 / 1.1 / 1.1.1
        if not num:
            # 无编号：固定标题（比对时去掉空格，"摘 要" == "摘要"），
            # 或中文序号通道带进来的短标题（level 已给值即放行）
            if title.replace(" ", "") in ("摘要", "Abstract", "引言", "绪论",
                                          "结论", "结束语", "参考文献", "致谢"):
                level = 1
            elif not level:
                return
        if re.search(r"[，,。；;：:、]", title):
            return
        if re.search(r"\d+(?:\.\d+)?\s*(?:%|ms|s\)|G\)|倍|L\))", title):
            return
        key = (num or "") + title
        if key in seen:
            return
        seen.add(key)
        out.append({"level": level or (num.count(".") + 1 if num else 1),
                    "num": num, "title": title, "_pos": pos})

    # ── ① 目录页：切出目录区（"目录" → 第一次出现正文的迹象为止），逐行解析 ──
    m = re.search(r"(?:^|\n)\s*目\s*录\s*\n", text)
    if m:
        seg = text[m.end():m.end() + 8000]
        # 目录区到正文为止：正文段落带逗号/句号且很长，见到就截断
        cut = len(seg)
        for pm in re.finditer(r"(?:^|\n)([^\n]{45,})", seg):
            if re.search(r"[，,。；;]", pm.group(1)):
                cut = pm.start()
                break
        seg = seg[:cut]
        # 两条正则都带 _pos，抓完按原文位置排序 —— 分两趟抓会把顺序打乱
        for mm in re.finditer(r"(?:^|\n)\s*(?:(\d{1,2}(?:\.\d{1,2}){0,3})\s+)?"
                              r"([^\n.…·。]{2,40}?)\s*[.…。·]{2,}\s*\(?\s*(?:\d{1,4}|[IVX]{1,5})\s*\)?\s*(?=\n|$)", seg):
            _add(mm.group(1), mm.group(2), pos=mm.start())
        for mm in re.finditer(r"(?:^|\n)\s*(\d{1,2}(?:\.\d{1,2}){0,3})\s+([^\n.…·。]{2,40})\s*(?=\n)", seg):
            _add(mm.group(1), mm.group(2), pos=mm.start())
        if sum(1 for x in out if x["num"]) >= 4:
            out.sort(key=lambda x: x["_pos"])
            for x in out:
                x.pop("_pos", None)
            return out[:limit]

    # ── ② 正文小标题 ──
    for mm in re.finditer(r"(?:^|\n)\s*(\d{1,2}(?:\.\d{1,2}){0,3})\s*[、.．]?\s+"
                          r"([\u4e00-\u9fffA-Za-z][^\n，。；,:：]{1,28})\s*(?=\n|$)", text):
        _add(mm.group(1), mm.group(2), pos=mm.start())

    # ── ③ 中文编号：只有两种确定形态，别的都不认（放宽会把正文全抓成标题）──
    #   (a) "(三)" / "（三）" 单独一行，下一行是标题
    #   (b) "二" 单独一行（裸中文数字，行短），下一行是标题
    for mm in re.finditer(r"(?:^|\n)(?:[（(]\s*([一二三四五六七八九十]+)\s*[）)]"
                          r"|([一二三四五六七八九十]+))\s*\n([^\n]{2,30})\s*(?=\n)", text):
        t_ = mm.group(3).strip()
        if not re.search(r"[，,。；;：:、]", t_):
            _add("", t_, level=1, pos=mm.start())
    # "一、标题" 同一行
    for mm in re.finditer(r"(?:^|\n)\s*([一二三四五六七八九十]+)\s*[、.．]\s*([^\n]{2,30})\s*(?=\n)", text):
        t_ = mm.group(2).strip()
        if not re.search(r"[，,。；;：:、]", t_):
            _add("", f"{mm.group(1)}、{t_}", level=1, pos=mm.start())

    # ── ④ 无编号固定标题 ──
    for mm in re.finditer(r"(?:^|\n)\s*(摘\s*要|Abstract|引\s*言|绪\s*论|结\s*论|"
                          r"结束语|参考文献|致\s*谢)\s*(?=\n|$)", text, re.I):
        _add("", re.sub(r"\s+", "", mm.group(1)), pos=mm.start())
    out.sort(key=lambda x: x["_pos"])
    for x in out:
        x.pop("_pos", None)
    return out[:limit]


def extract_figures(text: str, limit: int = 12) -> list:
    """抽图/表标题。李旭："结果重点看图"——图注是结果的另一种表述。

    中文论文形如「图 1 卷积神经网络结构」「表 2 不同参数对比」；
    英文形如 "Figure 1: ..." "Table 2. ..."。只抓标题行，不抓正文里的引用。
    """
    pats = [
        r"(?:^|\n)\s*图\s*\d+\s*[：:.]?\s*([^\n]{4,80})",
        r"(?:^|\n)\s*表\s*\d+\s*[：:.]?\s*([^\n]{4,80})",
        r"(?:^|\n)\s*Fig(?:ure)?\.?\s*\d+\s*[：:.]?\s*([^\n]{4,80})",
        r"(?:^|\n)\s*Table\s*\d+\s*[：:.]?\s*([^\n]{4,80})",
    ]
    out, seen = [], set()
    for pat in pats:
        for m in re.finditer(pat, text, re.I):
            cap = re.sub(r"\s+", " ", m.group(1)).strip(" .。:：")
            if 4 <= len(cap) <= 80 and cap not in seen:
                seen.add(cap)
                out.append(cap)
            if len(out) >= limit:
                return out
    return out


def ai_analyze(text: str, api_key: str, base: str, model: str, timeout: int = 90,
               outline: list = None) -> dict:
    """调 AI 抽结构化结果。正文在前、格式要求在后——顺序反了 AI 会输出空字段。"""
    secs = locate_sections(text)
    figs = extract_figures(text)
    outline = outline or extract_outline(text)
    prompt = AI_PROMPT.format(
        abstract=secs["abstract"][:1500] or text[:1200],
        intro=secs["intro"][:2800],
        conclusion=secs["conclusion"][:1800] or text[-2500:],
        body=secs["body"][:2500],
        figures="\n".join(f"- {f}" for f in figs) or "（本文没抓到图表标题）",
        outline="\n".join("- %s %s" % (x.get("num",""), x["title"]) for x in outline[:40])
                or "（没抓到目录，sections 留空数组）",
    )
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}]}).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions", data=body,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}, method="POST")

    # ★ 服务端会零星返回 503/429/超时 —— 实测连跑五篇时后三篇全挂在 503 上，
    #   而异常直接抛到用户面前 = 一次跑一半、看着像程序坏了。
    #   AI 服务是外部依赖，必须自己扛住抖动：退避重试，直到拿到结果。
    #   策略：5 次，间隔 5/10/20/40/60 秒（合计约 2 分钟）——
    #   再长就该让用户知道是服务端在抽风，而不是无限等。
    last_err = None
    for _try in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out = json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"]
            # ★ 拿到内容不算成功 —— 还要能解析出 JSON。AI 偶尔返回 HTML/截断内容
            #   （实测报 'invalid literal for int() with base 16'，那是服务端返了非 JSON，
            #   报错信息完全看不出发生了什么）。所以把**解析**也算进"这次成不成功"，
            #   失败就再要一次 —— 跟 503 走同一套退避。
            parsed = _parse_ai_json(out)
            if parsed is not None:
                parsed["_mode"] = "ai"
                return parsed
            last_err = ValueError("返回内容不是 JSON（%d 字符，开头: %s）"
                                  % (len(out or ""), (out or "")[:60].replace("\n", " ")))
            wait = [5, 10, 20, 40, 60][_try]
            print("      AI 返回内容无法解析，%d 秒后重试…" % wait, flush=True)
            time.sleep(wait)
            continue
        except urllib.error.HTTPError as e:
            last_err = e
            # 4xx 里只有 429 值得重试；401/403 是 key 或权限问题，重试没意义
            if e.code not in (429, 500, 502, 503, 504):
                raise
            wait = [5, 10, 20, 40, 60][_try]
        except Exception as e:                       # 超时/连接重置/DNS
            last_err = e
            wait = [5, 10, 20, 40, 60][_try]
        print("      AI 服务暂时不可用（%s），%d 秒后重试…"
              % (str(last_err)[:40], wait), flush=True)
        time.sleep(wait)
    else:
        raise RuntimeError(
            "AI 服务连续 5 次不可用（%s）。\n"
            "  不是你的问题 —— 服务端在抽风，稍后重跑即可。\n"
            "  网络通畅时可改用本地规则版（不配 key 直接跑）。" % str(last_err)[:60])
def _parse_ai_json(out):
    """从 AI 回复里抠出 JSON 对象；抠不出来返回 None（交由调用方重试）。

    容错三级（都是实测踩出来的）：
      ① 剥 ```json 围栏和前后废话 —— 只取第一个 { 到最后一个 }
      ② 字符串值里的裸换行转义（报 "Expecting ',' delimiter"）
      ③ 中文引号换成英文引号（AI 爱在值里用“”）
    """
    if not out:
        return None
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return None
    js = m.group(0)
    try:
        return json.loads(js)
    except json.JSONDecodeError:
        pass
    js2 = re.sub(r'(?<=": ")(.*?)(?=",?\s*\n?\s*")',
                 lambda mm: mm.group(0).replace("\n", "\\n"), js, flags=re.S)
    js2 = js2.replace("\u201c", "'").replace("\u201d", "'").replace("“", "'").replace("”", "'")
    try:
        return json.loads(js2)
    except json.JSONDecodeError:
        return None



def _esc(s) -> str:
    """Mermaid 标签转义：引号/方括号会破坏语法。"""
    s = str(s or "").replace('"', "'").replace("[", "(").replace("]", ")")
    return re.sub(r"\s+", " ", s).strip()


def _wrap(txt: str, per_line: int = 10, max_lines: int = 3) -> str:
    """折行（Mermaid 用 <br/>）。

    坑：早期版本用 s[i:i+n] 硬切，把英文单词切成两半
    （"Encoder and Decoder Stacks" → "EncoderandDecoderSta<br/>cks"），
    又丑又读不懂。现在按**词边界**切：优先在空格/标点后断行，中文按字数。
    """
    s = re.sub(r"\s+", " ", str(txt or "")).strip()
    if not s:
        return ""
    # 中文为主的标题：按字数切
    if len(re.findall(r"[\u4e00-\u9fff]", s)) > len(s) * 0.4:
        ls = [s[i:i + per_line] for i in range(0, len(s), per_line)]
    else:
        # 英文：按词累计，超长才断词
        words, ls, cur = s.split(" "), [], ""
        for w in words:
            if not cur:
                cur = w
            elif len(cur) + 1 + len(w) <= per_line:
                cur += " " + w
            else:
                ls.append(cur); cur = w
        if cur:
            ls.append(cur)
    if len(ls) > max_lines:
        ls = ls[:max_lines]
        ls[-1] = ls[-1][:max(1, per_line - 1)] + "…"
    return "<br/>".join(ls)


def _zh_title_map(data: dict) -> dict:
    """{章节英文标题: 中文标题} —— 英文论文的目录/图要用中文，不然一屏英文看不懂。"""
    m = {}
    for s in (data.get("sections") or []):
        if isinstance(s, dict) and s.get("title") and s.get("title_zh"):
            m[re.sub(r"\s+", "", str(s["title"]))] = str(s["title_zh"])
    return m


def _looks_like_heading(t: str) -> bool:
    """判断一个标题串像不像**章节名**（而不是被误抽的正文）。

    实测《知识图谱构建技术综述》：正文里的"由于可以将实体的属性视为实体与属性值之间"
    被抽取器安上 num=8 冒充了章节，还把编号顺序搞乱，导致后面 18 条真章节全被丢。

    章节名的特征：短、不以连词/介词开头。
    """
    # ★ 长度阈值必须**按语言分**。中文一个字符是一个信息单位，英文一个词才是 ——
    # "Scaled Dot-Product Attention" 28 字符、中文"实体抽取"4 字，量纲根本不同。
    # 实测教训：拿"中文 16 字"这条去卡英文，Attention 那篇的
    # Model Architecture / Why Self-Attention / Machine Translation 全被砍，
    # 目录从 32 条掉到 9 条。这类"中文规则套英文"的错我这一晚犯了不止一次。
    n_cjk = len(re.findall(r"[\u4e00-\u9fff]", t))
    if n_cjk >= 4:                        # 中文标题
        if n_cjk <= 8:
            return True                   # "实体抽取""问题与挑战""结束语"
        if re.search(r"[，。；,;]", t):
            return False                  # 带标点 = 句子
        if n_cjk > 16:
            return False                  # 超 16 字的中文标题不存在
        # 以助词/介词收尾 = 半句话（"…中抽取实"的"实"是"实体"被截断）
        if re.search(r"(的|了|是|在|和|与|对|从|把|被|为|以|中|上|下)$", t):
            return False
        return True
    # 英文标题：词数 ≤ 6 且没有整句特征
    if len(t.split()) > 6:
        return False
    if re.search(r"[.;:]\s|\b(is|are|was|were|has|have|we|our|this|that)\b", t, re.I):
        return False
    return True


def _clean_outline(outline: list) -> list:
    """过滤目录里的垃圾条目。

    英文论文的 PDF 正文里，图表标题/引用常被误认成章节
    （实测 "big"、"Deep-Att+PosUnk[39]"、"Petrov et al.(2006)[29]"）。
    判定：编号层级必须连续合理，标题不能含引用方括号、不能超过 40 字、不能是纯数字。
    """
    out, seen_nums, last_parts = [], set(), None
    last_by_prefix = {}
    last_by_prefix = {}          # 同前缀编号递增检查（见下方注释）
    for it in outline:
        t = str(it.get("title") or "").strip()
        if not t or len(t) > 40:
            continue
        if re.search(r"\[\d+\]|\(\d{4}\)", t):      # 引用标记
            continue
        if re.match(r"^\d+(\.\d+)*$", t):              # 纯数字
            continue
        if t.lower() in ("big", "small", "base", "ours", "the", "a", "an",
                         "and", "or", "of", "in", "on", "for", "with"):
            continue
        # 表头残片：如 "Transformer (4 layers)" 这种是表格数据，不是章节
        if re.match(r"^[A-Za-z\-\s]+\s*\(\s*\d+\s*(layers?|heads?|d_model)?\s*\)$", t, re.I):
            continue
        num = str(it.get("num") or "").strip()
        # 层级一律按**编号里的点数**算，不信抽取器给的 level ——
        # 实测 "3.3 Scaled Dot-Product Attention" 会被抓成 num="3"/level=1，
        # 结果 3.2.1 找不到父节点 3.2，挂到根上去了。
        if num and re.match(r"^\d+(\.\d+)*$", num):
            it = dict(it); it["level"] = num.count(".") + 1
        # 编号必须**向前推进**：出现过的编号不能倒退重复。
        # 论文里的图注常带孤立数字（实测 "3\nScaled Dot-Product Attention"
        # 其实是图 2 里的标签），会冒充章节；真章节编号只增不减。
        key = num or t
        if key in seen_nums:
            continue
        # ★★ 这个是整个"目录只剩 8 条"bug 的根治点 ★★
        # 正文冒充的垃圾（实测 num=5/8/9："一种自动化地从半结构化…""通过最大熵方法…"
        # "以提高算法精度"）编号看着递增，会把编号进度推到 9，
        # 之后所有 2.x / 3 / 6 全被判"倒退"丢掉 —— 26 条目录只剩 8 条。
        # 所以「不像章节名」的项要在**编号判定之前**就丢掉，且不参与进度更新。
        if num and not _looks_like_heading(t):
            continue
        # ★ 编号递增检查**只看兄弟序列**（同前缀），且一个垃圾只影响它自己所属的那一支。
        # 走过的弯路（记下来免重走）：
        #   ① 全局 last_parts 比 → 垃圾 "5 一种自动化地…" 把进度推到 5，
        #      后面 3/4/5/6 四个真章节全判"倒退"丢掉（26 条只剩 8 条）
        #   ② 改成同前缀比 + 先过滤不像章节名的 → 21 字的垃圾被拦了，
        #      但 7 字的 "9 以提高算法精度" 又顶上挡住后面的 3/4/5/6
        # 根因：靠"编号必须递增"本身就脆 —— 只要有一个编号异常的条目混进来，
        # 它后面的一整支就全废。
        # 所以这里只做**弱检查**：同前缀下编号重复才丢（明显的抽取错误），
        # 不递增不再直接丢 —— 交给"父节点是否存在"这个更强的语义判据兜底。
        if num:
            _pfx = num.rsplit(".", 1)[0] if "." in num else ""
            if num in seen_nums:
                continue                      # 同编号重复 = 抽取错误
            _prev = last_by_prefix.get(_pfx)
            if _prev == num:
                continue
            last_by_prefix[_pfx] = num
            last_parts = [int(x) for x in num.split(".")]
        seen_nums.add(key)
        out.append(it)

    # ★ 最后一道：丢掉"被夹在兄弟序列中间的外来条目"。
    # 实测 知识图谱那篇剩一条垃圾 —— 编号 9、被夹在 2.3.1 与 2.3.2 之间：
    #     2.3.1 本体构建 / 9 以提高算法精度 / 2.3.2 知识推理
    # 它 len=7、不以连词开头、编号还"递增"，前面所有词形/长度判据都拦不住。
    # 但语义上很明显：**它的前后两条同属 2.3，它自己却是个孤零零的顶层 9**。
    # 判据只用一个事实：前后邻居有共同父前缀(2)、而它没有 → 外来者。
    out = _drop_interspersed(out)
    return out


def _drop_interspersed(items: list) -> list:
    """丢掉插在兄弟序列中间的顶层外来条目（如 "9 以提高算法精度"）。

    只在**前后邻居共享同一个父前缀**时才判定，避免误杀真章节：
      · 2.3.1 / [9] / 2.3.2  → 前后都是 2.3.x，9 是外来者 → 丢
      · 1 / 2 / 3            → 前后没有共同父前缀 → 保留
    """
    def pfx(num: str) -> str:
        return num.rsplit(".", 1)[0] if "." in num else ""

    keep, i, n = [], 0, len(items)
    while i < n:
        it = items[i]
        num = str(it.get("num") or "").strip()
        if num and i > 0 and i + 1 < n:
            a = str(items[i - 1].get("num") or "").strip()
            b = str(items[i + 1].get("num") or "").strip()
            pa, pb = pfx(a), pfx(b)
            # 前后邻居同父、且这个父不是空、而自己不属于这个父 → 外来者
            if pa and pa == pb and pfx(num) != pa and "." not in num:
                i += 1
                continue
        keep.append(it)
        i += 1
    return keep


def to_mermaid(data: dict) -> str:
    """章节结构图：两层（一级章节 → 二级小节），分支以作者官方目录为准。

    横向铺 20 个节点会被 Mermaid 缩到看不清，所以用竖排（TD）+ 节点折行。
    超宽时容器横向滚动，不强行缩放。
    """
    meta = data.get("meta", {}) or {}
    outline = [x for x in (data.get("outline") or []) if x.get("title")]
    if not outline:
        return "graph TD\n  R[\"%s\"]" % _esc(meta.get("title", "论文"))
    zh = _zh_title_map(data)

    lines = ["graph TD", '  R["%s"]' % _wrap(meta.get("title", "论文"), 12)]
    # 按**编号前缀**挂父子（3.2.1 的父是 3.2），不靠遍历顺序 ——
    # 顺序法在编号跳级时会把节点挂到错误的分支下（实测踩过）。
    idx, nids, l1s = 0, {}, []
    for it in outline:
        num = str(it.get("num") or "").strip()
        lv = it.get("level", 1)
        if lv > 3:                        # 四级太密，图上不画
            continue
        label = _wrap(zh.get(re.sub(r"\s+", "", it.get("title", "")), it.get("title", "")), 10)
        if not label:
            continue
        idx += 1
        nid = "N%d" % idx
        nids[num] = nid
        if lv == 1 or "." not in num:
            lines.append('  R --> %s["%s"]' % (nid, label))
            l1s.append(nid)
        else:
            parent_num = num.rsplit(".", 1)[0]        # 3.2.1 -> 3.2；3.2 -> 3
            pnode = nids.get(parent_num) or (l1s[-1] if l1s else "R")
            lines.append('  %s --> %s["%s"]' % (pnode, nid, label))
    if data.get("limitation"):
        lines.append('  R -.-> LIM["⚠️ 局限"]')
    lines += [
        '  classDef l1 fill:#232a3d,stroke:#4b5b85,color:#ffffff,font-weight:600',
        '  classDef l2 fill:#1b2436,stroke:#33405c,color:#c3cde0',
        '  classDef root fill:#2a3350,stroke:#5b6e9e,color:#ffffff',
        '  class R root',
    ]
    if l1s:
        lines.append("  class %s l1" % ",".join(l1s))
    return "\n".join(lines)


def to_outline_html(data: dict) -> str:
    """自绘章节树（纯 HTML/CSS，不用 Mermaid）。

    为什么弃用 Mermaid：它的布局引擎按"布线最省交叉"排，完全不理会容器宽度 ——
    20 个节点的树它一律铺成 1300-2300px 宽，容器只有 700px，结果要么缩成糊、
    要么横向滚三屏，怎么调参数都治不好。自己画嵌套列表，宽度、缩进、字号全可控。

    输出：根 → 一级章节（卡片）→ 二级小节（缩进小字）。零 JS、零 CDN、断网可用。
    """
    meta = data.get("meta", {}) or {}
    outline = [x for x in (data.get("outline") or []) if x.get("title")]
    if not outline:
        return ""

    smap = {}
    for s in (data.get("sections") or []):
        if isinstance(s, dict) and s.get("title"):
            smap[re.sub(r"\s+", "", str(s["title"]))] = str(s.get("summary") or "")

    def esc(t):
        return html.escape(str(t or ""), quote=False)

    # 组装成 [一级, [二级...]] 的结构
    groups, cur = [], None
    for it in outline:
        lv = it.get("level", 1)
        if lv > 2:
            continue
        if lv == 1:
            cur = {"num": it.get("num", ""), "title": it["title"], "kids": []}
            groups.append(cur)
        elif cur is not None:
            cur["kids"].append({"num": it.get("num", ""), "title": it["title"]})

    out = ['<div class="otree">']
    out.append('<div class="otree-root">%s</div>' % esc(meta.get("title", "论文")))
    for g in groups:
        out.append('<div class="otree-node">')
        out.append('  <div class="otree-l1"><span class="otree-num">%s</span>%s</div>'
                   % (esc(g["num"]), esc(g["title"])))
        tip = smap.get(re.sub(r"\s+", "", g["title"]), "")
        if tip:
            out.append('  <div class="otree-tip">%s</div>' % esc(tip))
        if g["kids"]:
            out.append('  <div class="otree-kids">')
            for k in g["kids"]:
                out.append('    <span class="otree-kid"><i>%s</i>%s</span>'
                           % (esc(k["num"]), esc(k["title"])))
            out.append('  </div>')
        out.append('</div>')
    if data.get("limitation"):
        out.append('<div class="otree-lim">⚠️ 局限 · %s</div>' % esc(data["limitation"]))
    out.append('</div>')
    return "\n".join(out)


# ---------- Markdown 输出（主交付格式） ----------

def to_markdown(data: dict) -> str:
    """输出 Markdown。

    结构就像读者真正的阅读顺序（而不是论文的章节顺序）：
      速览(论文原生目录+一句话+背景) → 为什么做 → 怎么做 → 做出了什么 → 审稿人视角 → 细节(数据/方法/局限)
    细节后移：读者先要知道"这论文讲了啥、值不值得读"，才有耐心看数据和方法。
    """
    meta = data.get("meta", {}) or {}
    crit = data.get("critique") or {}
    outline = data.get("outline") or []      # analyze_pdf 已清理过

    head, body = [], []
    head.append(f"# {meta.get('title', '论文')}")
    head.append("")

    # 一句话结论（含背景，见 AI prompt 要求）
    if meta.get("one_sentence"):
        head += [f"> {meta['one_sentence']}", ""]
    if meta.get("background"):
        head += [f"**背景**：{meta['background']}", ""]

    head += [f"`类型` {_TYPE_LABEL.get(meta.get('type',''), meta.get('type',''))}　"
             f"`质量` {'⭐' * int(meta.get('quality') or 0)}　"
             f"`解析` {'AI 深度解析' if data.get('_mode')=='ai' else '本地规则版'}", ""]

    # 原文出处
    if data.get("source"):
        head += [f"> 📄 原文：[{data.get('source_label') or data['source']}]({data['source']})", ""]
    elif data.get("source_note"):
        head += [f"> 📄 出处：{data['source_note']}", ""]

    # 章节 → 一句话内容（AI 写的）。没有它目录就是个空壳。
    smap = {}
    for s in (data.get("sections") or []):
        if isinstance(s, dict) and s.get("title"):
            smap[re.sub(r"\s+", "", str(s["title"]))] = str(s.get("summary") or "")

    # ── 核心句：全篇最先看到的实质内容 ──
    # 为什么放最前（而不是放在导图后面）：这是 paperlens 最能打的东西
    # （150 篇英文实测 93% 命中核心贡献句、0% 噪声），而目录和导图读者要滚一屏才见。
    # 读者先看这几句就知道论文骨架、值不值得细读。
    ks = data.get("key_sentences") or []
    if ks:
        head += ["## 📌 论文最核心的几句话", ""]
        # 一次拼成整个列表再交给渲染器 —— 逐句加 "- " 会让渲染器把每句
        # 当成一个新列表（实测渲染出 4 个 <ol>，序号全是 1）。
        # 空行只留在列表首尾，列表内部不插空行。
        head += ["\n".join("%d. %s" % (i, s) for i, s in enumerate(ks, 1)), ""]
        # ★ 这段说明是"注脚"，不能喧宾夺主 —— 用户原话：
        #   "颜色应更浅 字体应更小 不喧宾夺主"。
        # 所以用专用的 .why 容器（小字 + muted 色 + 左边细线），
        # 不复用 blockquote（那是正文引用的样式，加进去会让人以为这是论文原文）。
        head += ['<div class="why">TextRank 从全文自动挑出（句子当节点、相似度当边、跑 PageRank），'
                 '不看词频 —— 高频词是 the/of/method 这类到处都有的结构词，零区分度。'
                 '另加「新颖句保送」：含「我们提出 / 本文 / these findings show」类句式的句子直接入选，'
                 '因为纯 TextRank 会偏向跟多数句子相似的背景句，而论文的价值恰恰在新意。'
                 '实测 537 篇英文 arXiv 语料：命中率 88%，噪声句 0%。</div>', ""]

    # 论文**原生目录**：作者自己写的章节结构，每条带一句话内容。
    # 不做锚点跳转 —— 目录条目本身就是内容（滚一屏就看完），
    # 点自己跳自己没意义，之前那套 <a id> 只是制造"滚木"。
    if outline:
        zh = _zh_title_map(data)
        head += ["## 📑 目录", ""]
        for it in outline:
            if it.get("level", 1) > 3:
                continue
            t = zh.get(re.sub(r"\s+", "", it["title"]), it["title"])
            label = (it["num"] + " " if it["num"] else "") + t
            # 注：垃圾条目的过滤统一在 _clean_outline 里做（单一真源）。
            # 这里原先又加了一道 len(t) > 24 —— 重复劳动，而且会误杀
            # "一种自动化地从半结构化和无结构数据中抽取实" 这类 21 字的真条目判不准。
            indent = "  " * max(0, it.get("level", 1) - 1)
            # ★ 带上该章的一句话摘要。原先只输出标题链接 ——
            #   用户原话："目录和小点摘要又漏了"。摘要从 AI 的 sections 里取。
            summ = smap.get(re.sub(r"\s+", "", it["title"]), "")
            if summ:
                head += ["%s- [%s](#%s)　%s" % (indent, label, _anchor(label), summ)]
            else:
                head += ["%s- [%s](#%s)" % (indent, label, _anchor(label))]
        head += ["", "---", ""]

    # ── 正文 ──
    # 板块取舍的唯一标准（用户反复强调）：**重复的删一个，不重复的不要删**。
    #   · 逐章内容  → 已删：与上面「📑 目录」逐条同一份数据（滚木）
    #   · 方法/做法 → 已合并：同一件事说三遍
    #   · 论证链    → 保留（背景→方法→结果→意义 串起全文，是项目特色）
    #   · 贡献/关键数据/图表/审稿人视角/可借鉴 → 全部保留，各讲各的
    # 🧭 论证链：把 AI 抽出的五个字段串成**一条链**，一眼看完论文的推理走向。
    # 用户原话："不重复的不要删 项目特色都没了" —— 这块是特色，早前误删过，已恢复。
    # 与「🗺️ 论证导图」的分工：这里只给**五行文字**，图归上面的 Mermaid 板块，
    # 不在两处画同一张图（那是真重复）。
    _chain = []
    _meta = data.get("meta") or {}
    for _lab, _txt in (("背景", _meta.get("background")), ("问题", data.get("gap")),
                       ("方法", data.get("approach")), ("结果", data.get("results"))):
        _v = _txt[0] if isinstance(_txt, list) and _txt else (_txt if isinstance(_txt, str) else "")
        if _v and str(_v).strip():
            _chain.append((_lab, str(_v).strip()))
    _cs = [c for c in (data.get("contribution") or []) if str(c).strip()]
    if _cs:
        _chain.append(("贡献", "；".join(str(c).strip() for c in _cs[:3])))
    if _chain:
        _one = str(_meta.get("one_sentence") or "").strip()
        if _one:
            body += ["## 🧭 论证链", "", "> %s" % _one, ""]
        else:
            body += ["## 🧭 论证链", ""]
        body += ["| 环节 | 内容 |", "|---|---|"]
        for _lab, _v in _chain:
            body += ["| **%s** | %s |" % (_lab, _v.replace("|", "\\|"))]
        body += [""]

    # 论证导图：Mermaid 代码块（比赛题干要求"Mermaid 导图生成"）
    if outline:
        body += ["## 🗺️ 论证导图", "", "```mermaid", to_mermaid(data), "```", ""]

    # 意图导航：读者按需求跳（只想了解 / 想看局限）
    nav = data.get("intent_nav") or []
    if nav:
        body += ["## 🎯 想看什么，去哪看", ""]
        for it in nav:
            body += ["**%s** —— *%s*" % (it["want"], it["where"]), "",
                     "> %s" % it["text"], ""]

    if data.get("gap"):
        body += ["## ❓ 为什么做（问题 / 领域空白）", "", data["gap"], ""]

    # 方法与做法合并成一节（approach 已含做法，不再单列 did）
    approach = data.get("approach") or ""
    if approach:
        body += ["## 🔧 怎么做（方法）", "", approach, ""]

    if data.get("contribution"):
        body += ["## 💡 做出了什么", ""] + ["- %s" % x for x in data["contribution"]] + [""]

    if data.get("results"):
        body += ["## 📊 关键数据", ""] + ["- %s" % x for x in data["results"]] + [""]

    if data.get("figures"):
        body += ["## 🖼️ 图表说明了什么", ""] + ["- %s" % x for x in data["figures"]] + [""]

    if any(crit.values()) or data.get("limitation"):
        body += ["## 🔬 审稿人视角（批判式精读）", "", "| 维度 | 评估 |", "| --- | --- |"]
        for k, lbl in [("question", "🎯 研究问题"), ("evidence_ok", "📐 证据是否充分"),
                       ("reproducible", "🔁 可否重复"), ("improve", "🔨 可改进之处")]:
            if crit.get(k):
                body.append("| %s | %s |" % (lbl, crit[k]))
        body.append("")

    if data.get("limitation"):
        body += ["## ⚠️ 局限", "", data["limitation"], ""]

    if data.get("borrow"):
        body += ["## 📥 可借鉴", ""] + ["- %s" % x for x in data["borrow"]] + [""]

    L = head[:]
    L += body
    L += ["---", "", "*由 paperlens 生成 · 泛读四步法 + 审稿人视角*"]
    return "\n".join(L)


def _anchor(name: str) -> str:
    """把标题转成 URL 锚点（去掉 emoji / 标点，保留中文）。"""
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", str(name)).strip("-").lower()
    return s or "sec"



# ---------- 渲染：Markdown → 好看页面（排版参照 Obsidian） ----------

# Obsidian 的正文行宽约 40rem(~700px)，一行 40-45 个汉字最舒服；行高对中文要更松。
_HTML = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{
  --bg:#0f1117; --card:#161922; --line:#272c3a; --text:#e6e9f0; --muted:#8b93a7;
  --hi:#a78bfa; --med:#22d3ee; --warn:#fbbf24; --bad:#f87171;
  --line-width:700px;      /* Obsidian 默认 ~40rem：一行 40+ 汉字最舒服 */
  --line-height:1.68;      /* 中文比英文需要更松 */
  --p-spacing:1.05rem;
}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--text);line-height:var(--line-height);
  font-size:16px;padding:48px 20px 60px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}}
.wrap{{max-width:var(--line-width);margin:0 auto}}
h1{{font-size:1.7em;line-height:1.35;font-weight:700;margin-bottom:.5em;color:#fff}}
h2{{font-size:1.2em;font-weight:650;margin:2.1em 0 .7em;color:var(--med);
  padding-bottom:.35em;border-bottom:1px solid var(--line)}}
h3{{font-size:1.03em;font-weight:650;margin:1.6em 0 .5em;color:#cfd6e6}}
p{{margin:var(--p-spacing) 0}}
strong{{color:#fff;font-weight:650}}
em{{color:var(--muted)}}
code{{background:#1d2230;border-radius:4px;padding:.15em .4em;font-size:.875em;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--med)}}
pre.code{{background:#131722;border:1px solid var(--line);border-radius:8px;
  padding:14px 16px;overflow:auto;margin:1.1em 0}}
pre.code code{{background:none;padding:0;color:var(--text);font-size:.85em;line-height:1.6}}
/* 引用块：Obsidian 只留左侧细线，不加重底色 */
/* 注脚式说明：小字、浅色、左边一条细线。刻意压暗，不跟正文抢注意力。 */
.why{{margin:1.1em 0 0;padding:.5em 0 .5em 1em;border-left:1px solid var(--line);
  color:var(--muted);font-size:.78em;line-height:1.7;opacity:.75}}
blockquote{{border-left:2px solid var(--hi);padding:.1em 0 .1em 1.1em;margin:1.2em 0;
  color:#c9d2e3;font-size:1.05em}}
ul,ol{{margin:.9em 0;padding-left:1.5em}}
li{{margin:.42em 0}}
li::marker{{color:var(--muted)}}
hr.md-hr{{border:none;border-top:1px solid var(--line);margin:2.2em 0}}
a{{color:var(--med);text-decoration:none;border-bottom:1px solid rgba(34,211,238,.3)}}
a:hover{{border-bottom-color:var(--med)}}
/* 表格：Obsidian 风格——无外框，只留横线 */
table.md-table{{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:.94em}}
table.md-table th{{text-align:left;font-weight:650;color:var(--med);
  padding:.55em .8em;border-bottom:1px solid var(--line);white-space:normal}}
/* 第一列（维度名）给固定宽度，否则"证据是否充分"会被挤压成竖排 */
table.md-table th:first-child,table.md-table td:first-child{{width:9.5em;white-space:nowrap}}
/* 目录的二级条目缩进 —— 不然一级二级全左对齐，看不出从属 */
ul.md-ul{{padding-left:1.35em}}
ul.md-ul li[data-lv="2"]{{margin-left:1.5em;font-size:.94em;list-style-type:circle}}
ul.md-ul li[data-lv="3"]{{margin-left:3em;font-size:.9em;list-style-type:square}}
table.md-table td{{padding:.55em .8em;border-bottom:1px solid rgba(39,44,58,.55);vertical-align:top}}
table.md-table tr:last-child td{{border-bottom:none}}
/* Mermaid 图：撤掉花哨背景，让它像正文的一部分；
   节点圆角/字号用 JS 在渲染后设（Mermaid 把样式写成 SVG 属性，CSS 压不过）。 */
.mermaid{{background:transparent;border:none;padding:0;margin:1.4em 0;
  overflow-x:auto;text-align:center}}
.mermaid svg{{max-width:none;height:auto}}
.mermaid .nodeLabel,.mermaid .edgeLabel{{line-height:1.5!important}}
.mermaid .edgePath path{{stroke:#3d4560!important;stroke-width:1.4px!important}}
.mermaid .marker{{fill:#3d4560!important;stroke:#3d4560!important}}
/* 公式：KaTeX 渲染失败时保持原样，不至于是乱码 */
.katex{{font-size:1.06em}}
.katex-fallback{{font-family:ui-monospace,Consolas,monospace;color:var(--warn);font-size:.9em}}
.foot{{margin-top:3.4em;padding-top:1.1em;border-top:1px solid var(--line);
  color:var(--muted);font-size:.8em;text-align:center}}
@media(max-width:640px){{body{{padding:24px 16px 40px;font-size:15.5px}}
  h1{{font-size:1.45em}}h2{{font-size:1.12em}}}}
</style>
<!-- 公式：KaTeX（失败降级为原文，不崩、不留空白） -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{{delimiters:[
    {{left:'$$',right:'$$',display:true}},
    {{left:'$',right:'$',display:false}},
    {{left:'\\\\(',right:'\\\\)',display:false}},
    {{left:'\\\\[',right:'\\\\]',display:true}}]}});"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head><body><div class="wrap">
{body}
<div class="foot">paperlens · 泛读四步法 + 审稿人视角</div>
</div>
<script>
// Mermaid：节点字号和圆角必须渲染后改 DOM —— Mermaid 把样式写成 SVG 属性，
// 外部 CSS 和 classDef 的 font-size 都会被它自己的内联样式压过（实测）。
(function(){{
  function polish(){{
    document.querySelectorAll(".mermaid svg").forEach(function(svg){{
      // Mermaid 给 svg 写 width="100%" 把整图缩到容器宽 → 节点字小到看不清。
      // 改成 viewBox 里的原始像素宽，容器横向滚动（宁可滚，不要糊）。
      var vb = (svg.getAttribute("viewBox") || "").split(/\s+/);
      if (vb.length === 4) {{
        svg.setAttribute("width", Math.ceil(parseFloat(vb[2])));
        svg.setAttribute("height", Math.ceil(parseFloat(vb[3])));
        svg.style.maxWidth = "none";
      }}
      svg.querySelectorAll(".node rect, .node polygon").forEach(function(r){{
        r.setAttribute("rx", 9); r.setAttribute("ry", 9);
      }});
      svg.querySelectorAll("g.node").forEach(function(n){{
        var isRoot = n.classList.contains("root");
        n.querySelectorAll(".nodeLabel").forEach(function(l){{
          l.style.fontSize = isRoot ? "16px" : "13px";
          l.style.fontWeight = isRoot ? "600" : "400";
          if (isRoot) l.style.color = "#fff";
        }});
      }});
    }});
  }}
  if (typeof mermaid !== "undefined") {{
    mermaid.initialize({{startOnLoad:true,theme:"base",securityLevel:"loose",
      flowchart:{{curve:"linear",useMaxWidth:false,htmlLabels:true,
                 padding:12,nodeSpacing:22,rankSpacing:34}},
      themeVariables:{{
        fontFamily:'-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
        fontSize:"13px",
        primaryColor:"#1f2738",primaryTextColor:"#dbe4f5",primaryBorderColor:"#33405c",
        secondaryColor:"#1c2130",tertiaryColor:"#1c2130",
        lineColor:"#3d4560",nodeBorder:"#33405c",nodeTextColor:"#dbe4f5",
        edgeLabelBackground:"#0f1117",defaultLinkColor:"#3d4560"
      }}}});
  }} else {{
    // CDN 挂了：退化成可读的代码块，不留白图（不静默失败）
    document.querySelectorAll(".mermaid").forEach(function(el){{
      el.innerHTML = '<pre class="code"><code>' +
        el.textContent.replace(/&/g,"&amp;").replace(/</g,"&lt;") + "</code></pre>";
    }});
  }}
  // Mermaid 渲染完后会**重写整个 svg**，把 width 又设回 100%。
  // 所以必须等它的 render 真正结束再改 —— 用 MutationObserver 监听，
  // 每次 svg 变化后延迟改一次，改完停手（不无限循环）。
  var fixed = false;
  var obs = new MutationObserver(function(){{
    if (fixed) return;
    var svg = document.querySelector(".mermaid svg");
    if (svg && svg.getAttribute("viewBox")) {{
      var vb = (svg.getAttribute("viewBox") || "").split(/\s+/);
      if (vb.length === 4 && svg.getAttribute("width") !== String(Math.ceil(parseFloat(vb[2])))) {{
        polish();
      }}
      if (svg.getAttribute("width") !== "100%") fixed = true;
    }}
  }});
  obs.observe(document.body, {{childList:true, subtree:true, attributes:true,
                              attributeFilter:["width"]}});
  setTimeout(function(){{ obs.disconnect(); }}, 20000);   // 20 秒后不再管
}})();

// 目录跳转：file:// 下中文 id 的 #锚点经常点不动（浏览器不做百分号编码匹配），
// 点击时自己找目标再滚过去 —— 否则用户点了没反应，等于目录是死的。
(function(){{
  function target(href){{
    var raw = href.slice(1);
    var el = document.getElementById(raw);
    if (el) return el;
    try {{ el = document.getElementById(decodeURIComponent(raw)); if (el) return el; }} catch(e){{}}
    var list = document.querySelectorAll("[id]");
    for (var i=0;i<list.length;i++){{ if (list[i].id === raw) return list[i]; }}
    return null;
  }}
  document.querySelectorAll('a[href^="#"]').forEach(function(a){{
    a.addEventListener("click", function(ev){{
      var el = target(a.getAttribute("href"));
      if (!el) return;                 // 找不到就交给浏览器默认行为
      ev.preventDefault();
      el.scrollIntoView({{behavior:"smooth", block:"start"}});
      history.replaceState(null, "", a.getAttribute("href"));
    }});
  }});
}})();
</script>
</body></html>"""


def _md_inline(s: str) -> str:
    """行内：转义 HTML → 粗体 → 行内代码 → 链接。

    链接要连站内锚点（#xxx，目录跳转用）一起认，只写 https?:// 会把目录点成死字。
    LaTeX 公式 $…$ 原样留着，交给页面上的 KaTeX 渲染。
    """
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\[([^\]]+)\]\(([#\w\-./:%\u4e00-\u9fff]*)\)",
               r'<a href="\2">\1</a>', s)
    return s


def render_markdown(md: str) -> str:
    """Markdown → HTML 片段。支持：h1-h4 / 列表 / 引用 / 表格 / 代码块(含 mermaid) /
    粗体 / 行内代码 / 链接 / 分隔线。自带实现，不引第三方 Markdown 库。

    ponytail: 只覆盖我们生成的 md 用到的语法；没见过的语法当普通段落，不报错。
    """
    out, i = [], 0
    lines = md.split("\n")
    while i < len(lines):
        ln = lines[i]

        # 代码块
        if ln.startswith("```"):
            lang = ln[3:].strip()
            buf = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            code = "\n".join(buf)
            if lang == "mermaid":
                out.append('<div class="mermaid">' + code + "</div>")
            else:
                out.append('<pre class="code"><code>' + html.escape(code) + "</code></pre>")
            continue

        # 整行 HTML 原样放行 —— 我们自己生成的排版标签（如 <div class="why"> 注脚容器）
        # 不能被转义。实测不加这条，页面里直接显示 &lt;div class="why"&gt;
        # （跟早前 <details> 被转义是同一个坑）。
        # 放行规则：整行以 HTML 标签开头、并以标签结尾。
        # 不要求"整行只有一个标签" —— 实测 <div class="why">文字…</div> 这种
        # 「标签里带文字」的形态会被旧正则漏掉，然后当普通段落转义成 &lt;div&gt;
        # （跟早前 <details> 被转义是同一个坑）。
        if re.match(r"^\s*<[a-zA-Z][\w-]*(\s[^<>]*)?>.*</[a-zA-Z][\w-]*>\s*$", ln) \
           or re.match(r"^\s*<[a-zA-Z][\w-]*(\s[^<>]*)?/?>\s*$", ln):
            out.append(ln.strip())
            i += 1
            continue

        # 表格
        if ln.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s\-:|]+\|\s*$", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not re.match(r"^[\s\-:]+$", "".join(cells)):
                    rows.append(cells)
                i += 1
            if rows:
                th = "".join(f"<th>{_md_inline(c)}</th>" for c in rows[0])
                td = "".join("<tr>" + "".join(f"<td>{_md_inline(c)}</td>" for c in r) + "</tr>"
                             for r in rows[1:])
                out.append(f'<table class="md-table"><thead><tr>{th}</tr></thead><tbody>{td}</tbody></table>')
            continue

        # 自绘章节树：整块 HTML 原样放行（转义了就成了可见标签文字）
        if ln.startswith('<div class="otree'):
            buf = []
            depth = 0
            while i < len(lines):
                buf.append(lines[i])
                depth += lines[i].count("<div") - lines[i].count("</div>")
                i += 1
                if depth <= 0:
                    break
            out.append("\n".join(buf))
            continue

        # 自己生成的「<h3><a id="..."></a>章节名</h3>」：原样放行。
        # 转义了就变成一堆可见标签文字，而且目录点了没落点。
        if re.match(r'^<h[2-5]><a\s+id="[^"<>]+"\s*>\s*</a>.+</h[2-5]>$', ln):
            out.append(ln)
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            out.append(f"<h{len(m.group(1))}>{_md_inline(m.group(2))}</h{len(m.group(1))}>")
            i += 1
            continue

        # 裸锚点（我们自己生成的 <a id="...">）：原样放行，转义了目录就点不动
        if re.match(r"^\s*<a\s+id=\"[^\"<>]+\"\s*>\s*</a>\s*$", ln):
            out.append(ln.strip())
            i += 1
            continue
        # 锚点 + 列表标记同行：锚点塞进 li 里，别截断列表（否则每条各起一个 ul）
        # 锚点 + 列表标记同行：先拆成"锚点行 + 列表行"，列表分支会把锚点嵌进 li
        m = re.match(r"^(\s*)<a\s+id=\"([^\"<>]+)\"\s*>\s*</a>\s*([-*]\s+.*)$", ln)
        if m:
            lines[i:i + 1] = ['<a id="%s"></a>' % m.group(2), m.group(1) + m.group(3)]
            ln = lines[i]

        if re.match(r"^\s*(---|\*\*\*)\s*$", ln):
            out.append('<hr class="md-hr">'); i += 1
            continue

        if ln.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i][1:].strip()); i += 1
            out.append('<blockquote>' + _md_inline(" ".join(buf)) + "</blockquote>")
            continue

        if re.match(r"^\s*[-*]\s+", ln):
            items = []
            while i < len(lines) and re.match(r"^\s*[-*]\s+", lines[i]):
                # 记下缩进层级：目录的一级/二级靠这个区分，全平铺就看不出从属
                lvl = min(3, len(lines[i]) - len(lines[i].lstrip()))
                items.append((lvl, re.sub(r"^\s*[-*]\s+", "", lines[i]))); i += 1
            lis = "".join('<li%s>%s</li>' % (" data-lv=\"%d\"" % lv if lv else "", _md_inline(x))
                          for lv, x in items)
            out.append("<ul class=\"md-ul\">" + lis + "</ul>")
            continue

        if re.match(r"^\s*\d+\.\s+", ln):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+\.\s+", lines[i]):
                items.append(re.sub(r"^\s*\d+\.\s+", "", lines[i])); i += 1
            out.append("<ol>" + "".join(f"<li>{_md_inline(x)}</li>" for x in items) + "</ol>")
            continue

        if not ln.strip():
            i += 1
            continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(
                r"^(#{1,4}\s|>|\s*[-*]\s|\s*\d+\.\s|```|\s*\||\s*---)", lines[i]):
            buf.append(lines[i]); i += 1
        out.append("<p>" + _md_inline(" ".join(buf)) + "</p>")
    return "\n".join(out)


# ---------- HTML 看板 ----------

def render_html_from_md(md: str, title: str = "") -> str:
    """Markdown → 完整可双击打开的 HTML（零 JS、零 CDN）。"""
    m = re.search(r"^#\s+(.*)$", md, re.M)
    return _HTML.format(title=html.escape(title or (m.group(1) if m else "论文解析")),
                        body=render_markdown(md))


def render_html(data: dict) -> str:
    """看板 = 走同一条链路：数据 → Markdown → 渲染。单一真源，不维护两套 HTML。"""
    return render_html_from_md(to_markdown(data),
                               (data.get("meta") or {}).get("title", "论文解析"))

_TYPE_LABEL = {"survey": "综述", "empirical": "实证研究", "theory": "理论",
               "education": "教育教学", "thesis": "学位论文"}


def _li(items, cls=""):
    if not items:
        return '<div class="pt">（未抽取到）</div>'
    if isinstance(items, str):
        items = [items]
    return "".join(f'<div class="pt {cls}">{x}</div>' for x in items if x)


# ---------- 主流程 ----------

def build_intent_nav(text: str) -> list:
    """意图导航 —— 实测做不可靠，返回空（保留函数签名与调用点，便于将来用别的手段补）。

    为什么不做（五轮实测，全部失败，记下来免得重走）：
      想让读者"想看局限 → 去结论段"，需要先**认出哪句是结论章节的标题**。
      但从 PDF 抽出的纯文本里，**版式信息（标题层级/字号/栏位）已经丢了**，
      所以这件事判不准：

        · 学位论文：前几页是版权声明、后几页是致谢（"作者签名: 日期: 年月日"）
        · 中文期刊：有中英文双摘要，锚点会命中英文那个
        · arXiv 论文：首页是 Google 版权声明；参考文献占比大，按位置比例换算也失真
        · 部分论文（如 CNN 综述）**根本没有结论章节**

      试过的五种手段：锚点黑名单 → 标题格式判定 → 原始文本定位 → 子串匹配
      → 按字符比例换算。五种都在真论文上翻车。

    结论：**这条规则做不出来，就不该留在产品里** —— 显示"局限在结论段"
    却给人家一段数据来源，比不给更糟。

    替代：读者要的"这篇讲了啥"由「📌 核心句」板块承担（TextRank，150 篇实测 93% 命中）。
    """
    return []


def analyze_pdf(pdf_path: str, api_key: str = "", base: str = "", model: str = "") -> dict:
    """一条龙：PDF → 结构化结果。无 key 自动走本地规则版（不报错、不静默假装成 AI 版）。"""
    text = extract_text(pdf_path)
    if not text.strip():
        raise RuntimeError("PDF 抽不到文字（可能是扫描件，需要 OCR）")

    # 原文出处：DOI 可跳转；没有就退中文期刊「文章编号」（仅标注）
    source = extract_doi(text)
    if not source:
        cn = extract_cn_code(text)
        if cn:
            source = ""      # 无链接
            src_note = f"文章编号 {cn}"
        else:
            src_note = ""
    else:
        src_note = ""

    outline = extract_outline(text)               # 先抽目录
    # ★ 清理要在调 AI **之前** —— AI 拿着这份目录逐条写摘要（sections）。
    # 早前是先调 AI 再清理，于是 AI 按含垃圾的 26 条写、清理后只剩 22 条：
    #   ① 多写的 4 条摘要永远匹配不上，白烧 token
    #   ② 第 3 步打印"逐章 26 条"、第 4 步打印"章节 22 条"，同一份数据两个数，看着像 bug
    outline = _clean_outline(outline)
    key_sents = extract_key_sentences(text, top=4)   # TextRank 核心句（本地，不需 AI）
    nav = build_intent_nav(text)                     # 意图导航（位置区间，不靠跳转词）
    if api_key and base and model:
        data = ai_analyze(text, api_key, base, model, outline=outline)
    else:
        data = local_analyze(text)
    # ★ 在这里就清理一次，下游（导图 / markdown / 目录）直接用。
    # 原先 data["outline"] 存未清理的，导图和 markdown 各自再调一次 _clean_outline ——
    # 同一份数据清两遍（浪费），而且 json 产物里存的是含垃圾的版本，
    # 谁忘了清理就会漏垃圾出来（实测 json 26 条 vs 页面 23 条对不上）。
    data["outline"] = outline                     # 论文原生目录（上面已清理一次）
    data["key_sentences"] = key_sents             # 论文最核心的几句话（TextRank）
    data["intent_nav"] = nav                      # "想看 X 去哪看"（按位置区间）
    data["source"] = source          # 可点击链接（可能空）
    data["source_note"] = src_note   # 无链接时的标注
    if source:
        data["source_label"] = source.replace("https://doi.org/", "DOI ").replace("https://arxiv.org/abs/", "arXiv ")
    else:
        data["source_label"] = src_note
    return data


def _write_outputs(pdf_path: str, data: dict, out_html: str = None,
                   save_json: bool = True) -> dict:
    """把已分析好的 data 落盘成 .md / .html / .json。"""
    stem = os.path.splitext(out_html or pdf_path)[0]
    out_html = out_html or stem + "_看板.html"
    out_md = stem + ".md"

    with open(out_md, "w", encoding="utf-8") as f:
        f.write(to_markdown(data))
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(render_html(data))
    if save_json:
        with open(stem + ".json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    return {"out_html": out_html, "out_md": out_md, "data": data}


def build(pdf_path: str, out_html: str = None, api_key: str = "", base: str = "",
          model: str = "", save_json: bool = True) -> dict:
    """跑完整流程，同时产出 .md（主交付）和 .html（看板，带 Mermaid 渲染）。"""
    data = analyze_pdf(pdf_path, api_key, base, model)
    return _write_outputs(pdf_path, data, out_html, save_json)


if __name__ == "__main__":
    import sys

    args = [a for a in sys.argv[1:]]
    step = ""
    if "--step" in args:
        k = args.index("--step")
        step = args[k + 1] if k + 1 < len(args) else ""
        del args[k:k + 2]
    if not args:
        print(__doc__)
        print("用法:")
        print("  python paperlens.py 论文.pdf              # 一条龙，出看板")
        print("  python paperlens.py --step text   论文.pdf  # 只抽正文（看提取质量）")
        print("  python paperlens.py --step analyze 论文.pdf # 只分析（出结构化数据）")
        sys.exit(1)

    pdf = args[0]
    if not os.path.exists(pdf):
        print("[错误] 找不到文件:", pdf)
        sys.exit(1)

    # 配置：有 key 就走 AI 深度解析，没 key 自动落到本地规则版
    cfg = {}
    try:
        cfg = json.load(open(os.path.expanduser("~/.wxmindmap_config.json"), encoding="utf-8"))
    except Exception:
        pass
    key = cfg.get("api_key", "")
    base = cfg.get("base_url", "")
    model = cfg.get("model", "")

    if step == "text":
        text = extract_text(pdf)
        secs = locate_sections(text)
        outline = extract_outline(text)
        figs = extract_figures(text)
        src = extract_doi(text) or extract_cn_code(text) or "（未识别到 DOI）"
        print("总字数: %d" % len(text))
        # 说明：这几个数字是"按章节标题切出来的块大小"，不是论文结构本身。
        # 中文论文的首章名五花八门（"1 知识图谱的定义与架构"这种，不叫"引言"），
        # 找标题这条路的可靠性有限 —— 所以标"未识别到标题"而不是显示 0 字让人误解。
        def _blk(n):
            return "%d 字" % n if n else "未识别到标题（不影响分析，AI 那边有兜底）"
        print("结构:   摘要 %s" % _blk(len(secs["abstract"])))
        print("        首节 %s" % _blk(len(secs["intro"])))
        print("        结论 %s" % _blk(len(secs["conclusion"])))
        print("        正文 %s" % _blk(len(secs["body"])))
        print("章节:   抓到 %d 条目录" % len(outline))
        for it in outline[:6]:
            print("        %s%s" % ("  " * (it["level"] - 1),
                                    (it["num"] + " " if it["num"] else "") + it["title"]))
        if len(outline) > 6:
            print("        ...（共 %d 条）" % len(outline))
        print("图表:   抓到 %d 条标题" % len(figs))
        print("出处:   %s" % src)
        print()
        print("---- 正文开头 300 字（自检提取质量）----")
        print(text[:300])
        sys.exit(0)

    if step == "analyze":
        text = extract_text(pdf)
        outline = extract_outline(text)
        # 与 analyze_pdf 一致：清理必须在调 AI 之前（AI 按这份目录写 sections）
        outline = _clean_outline(outline)
        mode = "AI 深度解析" if (key and base and model) else "本地规则版（没配 key）"
        print("分析方式: %s" % mode)
        if key and base and model:
            data = ai_analyze(text, key, base, model, outline=outline)
        else:
            data = local_analyze(text)
        # ★ 必须补齐 analyze_pdf 会挂的那几项，否则第 4 步复用缓存时
        # 目录（outline）和核心句（key_sentences）是空的 —— 实测看板"章节: 0 条"。
        data["outline"] = outline
        data["key_sentences"] = extract_key_sentences(text, top=4)
        data["key_sentences"] = extract_key_sentences(text, top=4)
        data["intent_nav"] = build_intent_nav(text)
        _s = extract_doi(text)
        data["source"] = _s
        data["source_note"] = "" if _s else (extract_cn_code(text) or "")
        data["source_label"] = (_s.replace("https://doi.org/", "DOI ")
                                .replace("https://arxiv.org/abs/", "arXiv ")) if _s else data["source_note"]
        print()
        print("一句话:", (data.get("meta") or {}).get("one_sentence"))
        print("背景:  ", (data.get("meta") or {}).get("background"))
        print("问题:  ", data.get("gap"))
        print("方法:  ", data.get("approach"))
        print("逐章:   %d 条" % len(data.get("sections") or []))
        for s in (data.get("sections") or [])[:4]:
            print("        %s %s -> %s" % (s.get("num", ""), s.get("title"), s.get("summary")))
        print("贡献:  %d 条 / 数据 %d 条 / 图表 %d 条"
              % (len(data.get("contribution") or []), len(data.get("results") or []),
                 len(data.get("figures") or [])))
        # 落盘缓存，供第 4 步复用。
        # 为什么：run.bat 的第 3 步和第 4 步都调 paperlens.py，不缓存的话
        # 第 4 步会**重新跑一遍 AI**（白烧一次额度），而且两次结果还不一样。
        # 缓存文件带 `.分析缓存.json` 后缀，不跟正式产物混淆。
        _cache = os.path.splitext(pdf)[0] + ".分析缓存.json"
        try:
            with open(_cache, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            print()
            print("已缓存分析结果:", _cache)
        except Exception as e:
            print("[警告] 缓存失败（不影响本次结果）: %s" % e)
        sys.exit(0)

    # 优先用第 3 步的缓存 —— 避免重复调 AI（省额度、且两次结果一致）
    _cache = os.path.splitext(pdf)[0] + ".分析缓存.json"
    if os.path.exists(_cache):
        try:
            data = json.load(open(_cache, encoding="utf-8"))
            print("复用第 3 步的分析结果（不重复调 AI）")
            r = _write_outputs(pdf, data)
            d = r["data"]
        except Exception as e:
            print("[警告] 缓存读不出，重新分析: %s" % e)
            r = build(pdf, api_key=key, base=base, model=model)
            d = r["data"]
    else:
        r = build(pdf, api_key=key, base=base, model=model)
        d = r["data"]
    print("标题:", (d.get("meta") or {}).get("title"))
    print("方式:", "AI 深度解析" if d.get("_mode") == "ai" else "本地规则版")
    print("章节:", len(d.get("outline") or []), "条")
    print()
    print("看板(双击看):", r["out_html"])
    print("数据源(md):  ", r["out_md"])
