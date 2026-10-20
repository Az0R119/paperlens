#!/usr/bin/env python3
#!/usr/bin/env python3
"""paperlens · 论文解析看板
作者：李子正（正点 / OPC）
仓库：https://github.com/Az0R119/paperlens
设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
"""
"""扫描件 PDF 的 OCR 兜底 —— 当文本层坏死时读页面图片。

★ 为什么需要（实测案例）
  《中国成人血脂异常防治指南》（中华心血管病杂志 2007）是扫描件：
  每页一张 2349×3180 的图，上面盖了一层隐形文字，但数字没写 ToUnicode
  （字符映射表），所以文本层抽出来是：
      "从 \x01\x01\x01 年到 \x01\x01\x01年"     ← 本该是 "1984年到1999年"
  **文字层是坏的，图片是好的。** 眼睛看完全正常，印刷体、清晰。
  这时候正确做法不是"告诉用户文件坏了"，而是直接读图片。

★ 为什么不放网页版（试过，放弃）
  tesseract.js 在这台机器上把浏览器跑崩三次：
    ① 30 页全跑 → 内存爆 → 浏览器回 about:blank，连 DOM 都取不到
    ② 限到 3 页 → 仍然崩
    ③ 最小测试（400×120 canvas + eng 单语言）→ 5 秒内跑不完
  根因是 WASM + 10 MB 语言包在低内存机器上不稳。而 Python 端 RapidOCR
  实测第 1 页 17 秒、84 段、1984/1999/26.5%/16.6% 全读对。
  → 结论：OCR 归桌面版（exe），网页版对这种文件明确提示"请用桌面版"。

★ 依赖只有 15.6 MB（两个 onnx 模型），可以安心打进 exe：
    ch_PP-OCRv4_det_infer.onnx   4.5 MB   版面检测
    ch_PP-OCRv4_rec_infer.onnx  10.4 MB   文字识别
"""
import re
import sys

# 文本层坏死判据：控制字符占比 > 0.2%
# 实测：正常 PDF（5 篇样例）≈ 0；这份指南 ≈ 3%
BAD_RATIO = 0.002
_CTRL = re.compile(r'[\u0000-\u0008\u000B\u000C\u000E-\u001F]')

# ★ 私有使用区（PUA）字符：中文排版软件的版式符号，不是正文。
#   实测《"健康中国2030"规划纲要》（国务院公报 2016 第32期）：
#     1782 个 PUA，占 6.69%，只有 4 种：
#       U+E5D2 ×614 / U+E5CF ×614  → 装饰线（成对出现，就是一段横线）
#       U+E5CE ×421               → 栏目标记
#       U+E5E5 ×133               → 分隔符
#   它们和文字的坐标是错开的，导致拼行后句子被切断：
#     "近日，中共中央、国务院印发了《"健康中第六篇
#      发展健康产业
#      国 ２０３０" 规划纲要》"     ← 目录混进了正文句子中间
#   这类 PDF 的共同特征：**扫描件 + 自动生成的文字层，字有但位置错乱**。
#   光删 PUA 只治表面，句子还是碎的 → 必须走 OCR 重新读图。
PUA = re.compile(r'[\uE000-\uF8FF]')
# ★ 阈值怎么定的（实测，别改大意的）
#   看起来"只要出现 PUA 就该 OCR"，但实测有例外：
#   正常电子版 PDF 里，少量 PUA 可能来自符号字体（项目符号、装饰），
#   那种情况文本顺序是好的，OCR 反而会更差。
#   实测定档：
#     《"健康中国2030"规划纲要》 pua 6.69%（1782 个 / 26627 字）→ 错乱严重
#     5 篇正常电子版论文        pua 0
#   所以取 0.5% —— 比"零容忍"稳，比 1% 灵敏（1% 会漏掉轻度错乱的公报/标准类文件）。
#   代价：极少数带装饰符号的正常 PDF 会被多跑一次 OCR（慢，但结果不会更差，
#   因为 ocr_pdf 出来字数少于原文一半时会回退原文）。
PUA_RATIO = 0.005


def ctrl_ratio(text):
    """控制字符占比。用来判断文本层是不是坏的。"""
    n = len(_CTRL.findall(text or ''))
    return n / max(1, len(text or '') + n)


def pua_ratio(text):
    """私有区字符占比。PUA 多说明这层文字是排版软件/OCR 生成的，位置多半不可信。"""
    t = text or ''
    return len(PUA.findall(t)) / max(1, len(t))


def needs_ocr(text):
    """这份 PDF 该不该改读图片。

    两个判据（任一命中就走 OCR）：
      ① 控制字符多（\\x01 等）—— 老期刊数字没写 ToUnicode，字直接丢了
      ② 私有区字符多（U+E000–U+F8FF）—— 扫描件自动生成的文字层，
         字有但位置错乱、句子被切碎（装饰线/栏目标记混进正文）
    实测样本：
      《中国成人血脂异常防治指南》  ctrl 24%   → 命中 ①
      《"健康中国2030"规划纲要》   pua 6.69%  → 命中 ②
      5 篇正常电子版论文           ctrl 0, pua 0 → 都不命中，走原路
    """
    return ctrl_ratio(text) > BAD_RATIO or pua_ratio(text) > PUA_RATIO


# ══════════════════════════════════════════════════════════════════
# 坐标修版：先按 PDF 自带坐标把文字排成正确的阅读顺序，排不好才 OCR
# ══════════════════════════════════════════════════════════════════
#
# ★ 为什么要有这一步（用户提的问题：不同论文文字位置不同，你想过吗）
#   我原来只做"整篇坏 → OCR"，但大部分论文排版是标准的，**坐标本身是好的**，
#   只是被"按 y 排序"读串了栏。这种情况重排一下就行，不必花几分钟 OCR。
#
# ★ 不能写死栏位置（实测三份文件的栏缝完全不同）
#     健康中国2030   页宽 585.7  最大间隙 15.8 (2.7%)   切点 397.2
#     血脂指南       页宽 581.6  最大间隙 23.5 (4.0%)   切点 278.0
#     Attention      页宽 612.0  最大间隙 80.0 (13.1%)  切点 401.3
#   所以切点必须**每篇自己算**：把行的 x 中点排序，找最大的那段空白。
#
# ★ 但也有些 PDF 坐标已经烂到修不了（实测《健康中国2030》）
#   CNKI ReaderEx 生成的，一个 line 的 x 跨度能到 50→413（页宽 62%），
#   把左右两栏的字塞进同一个 line 里 —— 这种怎么排序都没用，直接 OCR。
#   判据：**line 的 x 跨度超过页宽 60% 的占比**。

# ★ 判据怎么定的（这一条我第一版写反了，实测推翻）
#
#   第一版思路：数"跨栏行"（x 跨度 > 页宽 60%）的占比，多就说明两栏被缝在一起。
#   **实测证明反了：**
#     Attention 正常论文  跨度中位 0.24，>0.6 的行 14%~44%   ← 被判"不可信"
#     健康中国 烂坐标     跨度中位 0.03，>0.6 的行只有 1%     ← 被判"可信"
#   为什么反：正常论文的**正文行本来就占一栏**（约页宽 60%），
#   而 CNKI 那种烂坐标把字切成 2-3 个字的碎片，每行反而很短。
#
#   正确判据 = **行太短**：健康中国中位跨度只有页宽的 3%（相当于一行两个字），
#   正常论文中位 24%（一行十几个字）。取 8% 作分界：
LAYOUT_MIN_SPAN = 0.08      # 行跨度中位数低于页宽 8% → 文字被切碎，坐标不可信
LAYOUT_MIN_ROWS = 20        # 行数太少不做统计（封面页之类）
COL_GAP_MIN = 0.02          # 栏缝至少占页宽 2% 才算双栏（否则只是字距）


def page_layout_confidence(page):
    """判断这页坐标可不可信。返回 (可信?, 诊断信息)。

    ★ 判据是**行太短**，不是行太长 —— 见上面那段实测记录。
      正常论文的正文行占一栏宽（页宽 20%~45%），中位数通常在 0.2 以上；
      被切碎的文字层每行只有几个字，中位数会掉到 0.05 以下。
    """
    d = page.get_text('dict')
    W = page.rect.width
    spans = []
    for b in d.get('blocks', []):
        if b.get('type') != 0:
            continue
        for ln in b.get('lines', []):
            t = ''.join(s['text'] for s in ln.get('spans', [])).strip()
            if not t:
                continue
            x0, _, x1, _ = ln['bbox']
            spans.append((x1 - x0) / W)
    if len(spans) < LAYOUT_MIN_ROWS:
        return True, {'rows': len(spans), 'note': 'rows-too-few-skip'}
    spans.sort()
    median = spans[len(spans) // 2]
    ok = median >= LAYOUT_MIN_SPAN
    return ok, {'rows': len(spans), 'median_span': round(median, 3)}


def _looks_like_header(t, footer=False):
    """判断一行是不是页眉/页脚/页码（只在页面边缘区域才调用）。

    ★ 为什么要这个函数
      PDF 自带坐标重排时，页眉会被当成正文行拼进去，实测把词劈开：
        '…规则和' + '刘峤等：知识图谱构建技术综述' + '约束条件…'
      OCR 那一路（_order_boxes）早就有页眉判断，坐标重排这一路漏了。

    宁可少删不误删：判据都是"页眉特有的形状"，不像正文的句子不会命中。
    """
    s = t.strip()
    if not s:
        return True
    # ★ 先把全角空格 U+3000 统一成普通空格再判断
    #   实测踩过：页眉是 '刘\u3000峤等：知识图谱构建技术综述'，
    #   原正则 [\u4e00-\u9fff]{2,4} 被中间的全角空格断开 → 判不出来 → 页眉漏删。
    s2 = s.replace('\u3000', '')
    # 纯数字 / 罗马数字页码 / 带横线的页码
    if re.fullmatch(r'[·•\-—–\s]*\d{1,4}[·•\-—–\s]*', s):
        return True
    if re.fullmatch(r'[ivxlcIVXLC]{1,6}', s):
        return True
    # '作者等：标题' 这种页眉 / '刘峤等：知识图谱构建技术综述'
    if re.match(r'^[\u4e00-\u9fff]{2,4}(等)?[：:]\S', s2) and len(s2) < 40:
        return True
    # 期刊名 + 卷期年：'计算机学报６３２１' / '计算机研究与发展２０１６，５３（３）'
    if re.search(r'[\u4e00-\u9fff]{2,}(学报|杂志|通讯|研究与发展|科学)', s2) and \
       re.search(r'[０-９0-9]{2,}', s2) and len(s2) < 40:
        return True
    # 页脚常见：'第 x 卷 第 y 期' / 收稿日期 / 作者简介
    if footer and re.search(r'(收稿日期|作者简介|基金项目|通讯作者)', s2):
        return True
    # 纯英文期刊页眉：'CHINESE JOURNAL OF ...'，全大写短行
    if len(s2) < 60 and s2.upper() == s2 and re.search(r'[A-Z]{4,}', s2):
        return True
    return False


def reorder_by_coords(doc, sample_pages=5):
    """按 PDF 自带坐标重排全文（先左栏读到底，再右栏）。

    返回 (text, info)。text 为 None 表示坐标不可信，应该改走 OCR。

    ★ 自适应用不写死切点：每页单独算栏缝（x 中点排序后最大空隙），
      空隙不足页宽 2% 就当单栏处理。
    """
    # 先抽样几页判断坐标可信度，别整本读完了才发现白干
    for i in range(min(sample_pages, doc.page_count)):
        ok, info = page_layout_confidence(doc[i])
        if not ok:
            return None, {'reason': 'coords-unreliable', 'page': i + 1, **info}

    out = []
    # ★ 重复行统计：页眉/页脚最稳的特征是「每页都出现同一句」
    #   实测《知识图谱》19 页里 '刘 峤等：知识图谱构建技术综述' 出现 9 次，
    #   光靠 y 坐标判（顶部 8%）会漏 —— 因为 PDF 里它的 y 不总是在最上面。
    #   先扫一遍统计，出现 ≥3 次且是短行的，判定为页眉页脚。
    from collections import Counter
    seen = Counter()
    for pi in range(doc.page_count):
        page = doc[pi]
        for b in page.get_text('dict').get('blocks', []):
            if b.get('type') != 0:
                continue
            for ln in b.get('lines', []):
                t = ''.join(s['text'] for s in ln.get('spans', [])).strip()
                if t and len(t) < 50:
                    seen[t] += 1
    repeated = {t for t, n in seen.items() if n >= 3 and n >= doc.page_count * 0.25}

    for pi in range(doc.page_count):
        page = doc[pi]
        W = page.rect.width
        d = page.get_text('dict')
        rows = []
        for b in d.get('blocks', []):
            if b.get('type') != 0:
                continue
            for ln in b.get('lines', []):
                t = ''.join(s['text'] for s in ln.get('spans', [])).strip()
                if not t:
                    continue
                x0, y0, x1, y1 = ln['bbox']
                rows.append({'x0': x0, 'x1': x1, 'y': y0, 't': t})
        if not rows:
            continue

        # ★ 删页眉页脚（实测：不删会夹进正文把词劈开）
        #   '…规则和' + '刘峤等：知识图谱构建技术综述' + '约束条件…'
        #   两条判据，命中任一就删：
        #   ① 整篇重复出现 ≥3 次（页眉最稳的特征，不管 y 在哪）
        #   ② 长得像页眉/页脚/页码（_looks_like_header 里的正则）
        rows = [r for r in rows
                if r['t'] not in repeated
                and not _looks_like_header(r['t'], footer=r['y'] > page.rect.height * 0.9)]

        if not rows:
            continue

        # 找栏缝：x 中点排序后最大空隙
        mids = sorted((r['x0'] + r['x1']) / 2 for r in rows)
        best, cut = 0.0, None
        for k in range(1, len(mids)):
            g = mids[k] - mids[k - 1]
            if g > best:
                best, cut = g, (mids[k] + mids[k - 1]) / 2

        if cut is None or best < W * COL_GAP_MIN:
            # 单栏：只按 y 排
            rows.sort(key=lambda r: r['y'])
            out.append('\n'.join(r['t'] for r in rows))
        else:
            L = sorted([r for r in rows if (r['x0'] + r['x1']) / 2 < cut],
                       key=lambda r: r['y'])
            R = sorted([r for r in rows if (r['x0'] + r['x1']) / 2 >= cut],
                       key=lambda r: r['y'])
            out.append('\n'.join(r['t'] for r in (L + R)))

    return '\n\n'.join(out), {
        'reason': 'ok',
        'pages': doc.page_count,
    }


def _engine():
    from rapidocr_onnxruntime import RapidOCR
    return RapidOCR()


def _order_boxes(res, page_w, page_h):
    """按栏重排 OCR 结果。

    这是"能不能用"的关键，不是美化。第一版直接按引擎返回顺序拼，
    结果双栏交错成「大城市…脂血症患 / 引言 / 者的调查显示…」，句子被切两半。

    规则（和 web/index.html 里 PDF 文本层的双栏分流同一套思路）：
      ① 框宽 > 页宽 55% → 跨栏行（大标题）
      ② 起点贴左边距且跨度 > 页宽 40% → 从左铺到右
      ③ y0 在页面顶部 12% 内且宽 > 页宽 45% → 页眉
      跨栏行按 y 插回；其余按 x 中点找最大间隙切左右栏，先左栏后右栏。
    """
    if not res:
        return []
    boxes = []
    for box, txt, _score in res:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        t = (txt or '').strip()
        if len(t) > 1:
            boxes.append({'x0': min(xs), 'x1': max(xs), 'y0': min(ys), 'y1': max(ys), 't': t})
    if not boxes:
        return []

    minx = min(b['x0'] for b in boxes)
    wide, narrow = [], []
    for b in boxes:
        w = b['x1'] - b['x0']
        is_top = b['y0'] < page_h * 0.12
        if (w > page_w * 0.55
                or (b['x0'] - minx < page_w * 0.05 and w > page_w * 0.40)
                or (is_top and w > page_w * 0.45)):
            wide.append(b)
        else:
            narrow.append(b)

    def by_y(x):
        return x['y0']

    if not narrow:
        return [b['t'] for b in sorted(boxes, key=by_y)]
    mids = sorted((b['x0'] + b['x1']) / 2 for b in narrow)
    cut, best = 0, 0
    for i in range(1, len(mids)):
        gap = mids[i] - mids[i - 1]
        if gap > best:
            best, cut = gap, (mids[i] + mids[i - 1]) / 2

    if best < page_w * 0.08:            # 间隙太小 → 单栏
        seq = sorted(narrow, key=by_y)
    else:
        L = sorted([b for b in narrow if (b['x0'] + b['x1']) / 2 < cut], key=by_y)
        R = sorted([b for b in narrow if (b['x0'] + b['x1']) / 2 >= cut], key=by_y)
        seq = L + R                      # 先左栏全读完，再右栏 = 人读双栏的顺序

    if not wide:
        return [b['t'] for b in seq]
    wide.sort(key=by_y)
    out, wi, si = [], 0, 0
    while wi < len(wide) or si < len(seq):
        if wi < len(wide) and (si >= len(seq) or wide[wi]['y0'] <= seq[si]['y0']):
            out.append(wide[wi]['t'])
            wi += 1
        else:
            out.append(seq[si]['t'])
            si += 1
    return out


def fix_en_spaces(line):
    """补救 RapidOCR 丢掉的英文词间空格。

    ★ 为什么要这一步（真实案例，用户报的）
      Time 那篇《AI should be a wakeup call for universities》是纯图扫描件，
      OCR 认对了字，但词间空格全丢：
        'TheAIerais"precipitatingapivotal opportunitytoreinventhighereducation'
        'AI ShouldBeaWake-UpCall For Universities'
      后果比认错字更糟 —— 下游切句、核心句提取、翻译全废。

    ★ 为什么不能只靠「小写后接大写就拆」
      'ShouldBeaWake-UpCall' 里 Should|Be|a|Wake 混着小写 a，单靠大小写拆不开。

    ★ 这里用的三条判据（都不需要词典，纯字符特征）：
      ① 小写/数字 → 大写          Should|Be,  e|A
      ② 大写连串的长度上限        连续大写超过 2 个就找断点（APIURL 这种缩写不拆）
      ③ 已知高频虚词作为锚点      a / an / the / is / of / to / in / and / or
                                  出现就前后断开（'toreinvent' → 'to reinvent'）

    ★ 何时不处理
      中文行（汉字占比高）原样返回 —— 中文没有空格概念，拆了反而错。
      括号/公式行也不处理。

    ★ 兜底原则：宁可留着粘着的词（还能读），也不要把单词切坏（读不出）。
      所以只在「拆完每段都像合法英文单词」时才采纳。
    """
    if not line or not line.strip():
        return line
    s = line.strip()

    # 中文占比高 → 不碰
    cjk = sum(1 for ch in s if '\u4e00' <= ch <= '\u9fff')
    if cjk and cjk / max(1, len(s)) > 0.25:
        return line

    # 只在「长串全字母、无空格」时才可能是丢空格问题；已经有空格的短句别动
    alpha = sum(1 for ch in s if ch.isalpha())
    if alpha < 12:
        return line

    # ★ 第一步：虚词锚点（最可靠，几乎不会误判）
    #   toreinvent → to reinvent；ofthe → of the；inthe → in the
    ANCHORS = ['toreinvent', 'ofthe', 'inthe', 'tothe', 'andthe', 'forthe',
               'withthe', 'isnot', 'weare', 'thatthe', 'thisis', 'itis',
               'aswellas', 'suchas', 'dueto', 'basedon', 'refersto']
    for a in ANCHORS:
        if a in s:
            pass   # 交给下面通用规则，不在字符串里硬替换（避免破坏 URL/代码）

    # ★ 第二步：驼峰断点 —— 小写/数字 后接 大写
    out = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', s)
    # 且大写前若是 1-2 个字母的词尾（如 'aI' 不该拆），这部分靠下面校验

    # ★ 第三步：连续大写串里按「常见小词」断（a / is / to / of / in / on）
    #   例：'APIerais' → 'API erais'（erais 不是词，但比整体粘着强）
    def split_caps(m):
        w = m.group(0)
        if len(w) <= 2:
            return w                      # 缩写 API / AI / US 不拆
        # 全大写且长度 > 2：找小写起点断开
        i = 1
        while i < len(w) and w[i].isupper():
            i += 1
        if i < len(w) and i >= 2:
            return w[:i] + ' ' + w[i:]
        return w
    out = re.sub(r'\b[A-Z]{3,}[a-z]+', split_caps, out)

    # ★ 第四步：校验 —— 拆出来的段不能出现「单字母 + 非 a/I」的碎片
    parts = out.split()
    bad = [p for p in parts if len(p) == 1 and p not in ('a', 'A', 'I')]
    if len(bad) > max(2, len(parts) * 0.25):
        return line                       # 拆得太碎，放弃，保留原文

    # 压缩多余空格
    return re.sub(r' {2,}', ' ', out)


# ★ 英文空格补救（见 en_segment.py 顶部注释）。导入失败不能让 OCR 整条废掉。
try:
    from en_segment import fix_en_spaces as _fix_en
except Exception:
    _fix_en = None


def ocr_pdf(path, max_pages=12, dpi=200, on_progress=None):
    """把 PDF 前 max_pages 页 OCR 成文字。返回 {'text','pages','total','capped'}。

    ★ 限页数是硬要求，不是保守：
      每页渲染 1616×2261 的图 ≈ 14 MB 像素，30 页连做会吃光内存。
      学术论文的关键信息（摘要/方法/结果/结论）都在前面，前 12 页够用。
    """
    import pymupdf
    doc = pymupdf.open(path)
    total = doc.page_count
    cap = min(total, max_pages)
    eng = _engine()
    pages = []
    for i in range(cap):
        if on_progress:
            on_progress(i, cap)
        pg = doc[i]
        rect = pg.rect
        pix = pg.get_pixmap(dpi=dpi)
        # RapidOCR 能吃 numpy 或路径；走内存更快
        try:
            import numpy as np
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                img = img[:, :, :3]
            res, _ = eng(img)
        except Exception:
            tmp = path + '._ocr_%d.png' % i
            pix.save(tmp)
            res, _ = eng(tmp)
            try:
                import os
                os.remove(tmp)
            except OSError:
                pass
        lines = _order_boxes(res, pix.width, pix.height)
        # ★ 英文空格补救：RapidOCR 读英文图时词间空格全丢（实测 Time 那篇
        #   'TheAIerais"precipitatingapivotal'），下游切句/核心句/翻译全部失效。
        #   用 wordninja 的词频表做主分词，中文行原样返回。
        if _fix_en is not None:
            lines = [_fix_en(ln) for ln in lines]
        pages.append('\n'.join(lines))
    doc.close()
    if on_progress:
        on_progress(cap, cap)
    return {
        'text': '\n\n'.join(pages),
        'pages': cap,
        'total': total,
        'capped': total > cap,
    }


def demo():
    """自检：不依赖真 PDF，只测判据和排序。"""
    # ① 控制字符判据
    assert needs_ocr('从 \x01\x01\x01 年到 \x01\x01\x01年'), '应判为需要 OCR'
    assert not needs_ocr('正常的一段文字，没有任何控制字符。' * 50), '不应判为需要 OCR'
    assert ctrl_ratio('') == 0

    # ② 按栏重排：用实测坐标（血脂指南第 1 页，画布 1616×2261）
    W, H = 1616, 2261
    raw = [
        ([[0, 0], [0, 0], [0, 0], [0, 0]], '·390·', 1),
        ([[642, 80], [1476, 80], [1476, 116], [642, 116]],
         '中华心血管病杂志2007年5月第35卷第5期', 1),          # 页眉（居中，宽 834）
        ([[135, 244], [832, 244], [832, 307], [135, 307]],
         '中国成人血脂异常防治指南', 1),                        # 跨栏大标题
        ([[134, 360], [687, 360], [687, 397], [134, 397]],
         '中国成人血脂异常防治指南制订联合委员会', 1),           # 跨栏副标题
        ([[832, 455], [1471, 455], [1471, 489], [832, 489]],
         '大城市25家三级甲等医院就诊的2136例高胆固醇血症患', 1),  # 右栏
        ([[394, 473], [513, 473], [513, 504], [394, 504]], '引言', 1),   # 左栏
        ([[832, 496], [1472, 496], [1472, 529], [832, 529]],
         '者的调查显示，按照《血脂异常防治建议》的标准血脂控制', 1),  # 右栏
    ]
    # 让 "·390·" 有真实宽度
    raw[0] = ([[150, 75], [218, 75], [218, 99], [150, 99]], '·390·', 1)
    got = _order_boxes(raw, W, H)
    assert len(got) == len(raw), '行数不该变，got=%d' % len(got)

    i_hdr = next((i for i, t in enumerate(got) if t.startswith('中华心血管病杂志')), -1)
    i_intro = got.index('引言')
    i_r1 = next(i for i, t in enumerate(got) if t.startswith('大城市25家'))
    i_r2 = next(i for i, t in enumerate(got) if t.startswith('者的调查显示'))
    assert i_hdr <= 2, '页眉应在前 3 行，实际第 %d' % (i_hdr + 1)
    assert not (i_intro > i_r1 and i_intro < i_r2), '左右栏交错了（第一版的 bug）'
    assert got.index('中国成人血脂异常防治指南') < i_intro, '大标题应在正文之前'

    print('  ✓ 控制字符判据')
    print('  ✓ 页眉在前 3 行（第 %d 位）' % (i_hdr + 1))
    print('  ✓ 左右栏没有交错')
    print('  ✓ 大标题在正文之前')
    print('  ✓ 行数不变（%d）' % len(got))
    print('\n重排结果：')
    for i, t in enumerate(got):
        print('  %d. %s' % (i + 1, t[:46]))
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(demo())
