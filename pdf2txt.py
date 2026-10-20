#!/usr/bin/env python3
#!/usr/bin/env python3
"""paperlens · 论文解析看板
作者：李子正（正点 / OPC）
仓库：https://github.com/Az0R119/paperlens
设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
"""
"""paperlens 文字抽取器 —— 把 PDF 里的中文完整抽出来成 txt。

★ 为什么单独做这个工具
  paperlens 网页版能在线看板，但**扫描件它处理不了**（浏览器里跑 OCR
  引擎实测卡死：tesseract.js 对 1600×2400 的图会一直不返回）。
  而桌面版（Python + RapidOCR）同一份文件 20 秒一页、中文完整准确。
  → 所以做成一个双击就能用的小工具，专管"把字抠出来"。

★ 它做什么（按顺序，能省就省）
  ① 坐标修版：按 PDF 自带坐标把左右栏重排（几秒，零误差）
  ② 判可信度：行太短/字符坏死 → 认为文字层不可用
  ③ 才对图片做 OCR（慢，但扫描件唯一可行）

★ 用法
  双击运行 → 弹文件选择框 → 选 PDF → 同名 .txt 出现在旁边
  命令行：python pdf2txt.py 某文件.pdf          只抽这一份
          python pdf2txt.py 某目录               抽目录下所有 PDF
          python pdf2txt.py 某.pdf --pages 20    限制 OCR 页数
"""
import os
import re
import sys
import time


def _clear(t):
    """清掉页眉/水印/页码这些非正文的东西。"""
    t = re.sub(r'\(C\)\s*\d{4}-\d{4}\s*China Academic Journal.*?cnki\.net\.?', '', t, flags=re.S)
    t = re.sub(r'国务院公报\s*[·.]?\s*\d{4}\s*[·.]?\s*\d+', '', t)
    t = re.sub(r'[—–-]\s*\d{1,2}\s*[—–-]', '', t)
    t = re.sub(r'中央文件', '', t)
    return t


def extract(pdf_path, max_pages=12, verbose=True):
    """抽一份 PDF 的文字。返回 (text, info)。"""
    import pymupdf
    from paperlens_ocr import (needs_ocr, ocr_pdf, pua_ratio,
                               ctrl_ratio, reorder_by_coords)

    doc = pymupdf.open(pdf_path)
    info = {'pages': doc.page_count}

    # ① 坐标修版
    t0 = time.time()
    reordered, linfo = reorder_by_coords(doc)
    info['reorder_ms'] = int((time.time() - t0) * 1000)
    info['reorder'] = linfo.get('reason')

    if reordered and not needs_ocr(reordered):
        doc.close()
        info['method'] = 'coords'
        text = reordered
    else:
        # ② 文字层不可用 → OCR
        if verbose:
            why = linfo.get('reason')
            if reordered:
                why = 'ctrl %.1f%% / pua %.1f%%' % (
                    ctrl_ratio(reordered) * 100, pua_ratio(reordered) * 100)
            print('   文字层不可用（%s），改读图片…' % why)
        t0 = time.time()
        r = ocr_pdf(pdf_path, max_pages=max_pages)
        doc.close()
        info['method'] = 'ocr'
        info['ocr_ms'] = int((time.time() - t0) * 1000)
        info['ocr_pages'] = r['pages']
        info['ocr_total'] = r['total']
        text = r['text']

    # ③ 拼行：OCR/重排出来的行是版面硬换行，中文直接连回去
    pages = text.split('\n\n')
    merged = []
    for ptxt in pages:
        lines = [x.strip() for x in ptxt.split('\n') if x.strip()]
        buf = ''
        for ln in lines:
            if not buf:
                buf = ln
            elif re.search(r'[。！？；：”』）】]$', buf):
                merged.append(buf)
                buf = ln
            else:
                # ★ 接行要看前一行结尾是什么字
                #   · 前一行结尾是英文/数字 → 补一个空格再拼（否则 'attention' + 'mechanisms'
                #     变 'attentionmechanisms'）
                #   · 结尾是中文 → 直接拼（中文没有词间空格）
                #   实测：不补空格时 arXiv 首页版式说明整段粘成一坨。
                if re.search(r'[A-Za-z0-9,.;:)\]%]$', buf):
                    buf += ' ' + ln
                else:
                    buf += ln
        if buf:
            merged.append(buf)
    text = '\n'.join(merged)

    text = _clear(text)
    # ★ 只删「中文和中文之间」的空格，绝不能全删 —— 实测踩过：
    #   原来写 re.sub(r'[ \t]+', '', text) 把英文词间空格也吃了，
    #   arXiv 版式说明变成一坨：
    #     'Googleherebygrantspermissiontoreproducethetablesandfiguresinthispaper...'
    #   中文期刊的全角空格 U+3000 是排版对齐用的（'计　　算　　机　　学　　报'），
    #   那不是词间隔，该删。
    text = re.sub(r'[\u3000]+', '', text)                                  # 全角空格：排版对齐，删
    text = re.sub(r'(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])', '', text)  # 中文中间的空格：删
    # 英文词间空格保留；行内多余连续空格压成一个
    text = re.sub(r' {2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    # ★ 把「中文句子内部的硬换行」接回去
    #   实测（CNN综述 / 知识图谱）：版面换行留下来的 '\n' 把句子切在词中间 ——
    #     '…降低了网络模型\n的计算量．'
    #   看着像断句，其实一句没说完。判据：换行前一个字是中文且不是句末标点。
    #   段落之间（\n\n）保持不动。
    text = re.sub(r'(?<=[\u4e00-\u9fff，、；：])\n(?=[\u4e00-\u9fff])', '', text)
    info['chars'] = len(text)
    return text, info


def one(path, max_pages=12):
    name = os.path.basename(path)
    print('\n[%s]' % name)
    try:
        t0 = time.time()
        text, info = extract(path, max_pages)
        out = os.path.splitext(path)[0] + '.txt'
        with open(out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('   %s → %d 字 | %.1f 秒 | %s'
              % (info.get('method'), info['chars'], time.time() - t0,
                 'OCR %d/%d 页' % (info.get('ocr_pages'), info.get('ocr_total'))
                 if info['method'] == 'ocr' else '直接抓文字'))
        print('   写入: %s' % out)
        return True
    except Exception as e:
        print('   失败: %s' % e)
        return False


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    max_pages = 12
    if '--pages' in sys.argv:
        max_pages = int(sys.argv[sys.argv.index('--pages') + 1])

    targets = []
    if args:
        for a in args:
            if os.path.isdir(a):
                targets += [os.path.join(a, f) for f in sorted(os.listdir(a))
                            if f.lower().endswith('.pdf')]
            elif os.path.isfile(a):
                targets.append(a)
    else:
        # 双击运行：弹文件选择框
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            sel = filedialog.askopenfilenames(
                title='选要抽文字的 PDF（可多选）',
                filetypes=[('PDF 文件', '*.pdf'), ('所有文件', '*.*')])
            root.destroy()
            targets = list(sel)
        except Exception as e:
            print('打不开文件选择框（%s），请把 PDF 拖到本程序上。' % e)
            return 1

    if not targets:
        print('没有选择文件。')
        return 1

    print('=' * 56)
    print('  paperlens 文字抽取器')
    print('  %d 个文件' % len(targets))
    print('=' * 56)
    ok = sum(1 for t in targets if one(t, max_pages))
    print('\n完成：%d/%d 个文件，txt 就在原 PDF 旁边。' % (ok, len(targets)))
    return 0 if ok == len(targets) else 1


if __name__ == '__main__':
    code = main()
    if not sys.argv[1:]:
        input('\n按回车关闭…')
    sys.exit(code)
