#!/usr/bin/env python3
"""生成部署版：去掉源码注释（保留功能，只删「怎么想出来的」）。

★ 为什么做这个
  网页版必须公开 JS（浏览器要下载才能跑），这是物理限制。
  但注释里写着我们的设计思路、实测数据、踩坑记录 —— 那才是不该白送的东西。
  部署版去掉注释后：功能一模一样，别人看不出判定逻辑是怎么定的。

★ 不做混淆
  混淆会让代码不可读，评委看代码时是负分，而且防不住真想抄的人。
  去注释是「不白送思路」，混淆是「主动贬值源码」—— 只做前者。

用法：python make_deploy.py
"""
import os
import re
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(BASE, 'dist-site')
OUT = os.path.join(BASE, "dist-部署")

# 部署必需的静态文件
COPY_ASIS = ['index.html', 'p3r.css', 'netlify.toml']
# 需要去注释的 JS
STRIP_JS = ['core.js', 'domain.js', 'local_ai.js', 'ocr.js',
            'binary_bridge.js', 'cloud_translate.js']


def strip_js_comments(src):
    """去掉 JS 的 /* */ 和 // 注释，但**不碰字符串和正则里的内容**。

    ★ 实现要点（踩过坑）
      ① 朴素的 re.sub(r'/\\*.*?\\*/') 会把字符串里的 '/*' 也删掉 → 按字符扫
      ② 正则字面量里的 // 不是注释 —— 例如 /(?:https?:\\/\\/)/ 里的 //。
         判断「/ 是除号、正则开头，还是注释」看前一个有效字符：
         如果前面是标识符/数字/)]，那 / 是除号；否则是正则开头。
      ③ 块注释里的换行要保留，否则行号全挤一行
    """
    out = []
    i = 0
    n = len(src)
    state = 'code'          # code | line | block | sq | dq | tpl | regex
    last_sig = ''           # 上一个"有效"字符（用来判断 / 是除号还是正则）
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''

        if state == 'code':
            if c == '/' and nxt == '/':
                state = 'line'
                i += 2
                continue
            if c == '/' and nxt == '*':
                state = 'block'
                i += 2
                continue
            if c == '/':
                # 前面是「值」结尾 → 除号；否则 → 正则字面量开头
                if last_sig and (last_sig.isalnum() or last_sig in ')]}'):
                    out.append(c)
                    last_sig = c
                    i += 1
                    continue
                state = 'regex'
                out.append(c)
                i += 1
                continue
            if c == "'":
                state = 'sq'
                out.append(c); last_sig = c; i += 1
                continue
            if c == '"':
                state = 'dq'
                out.append(c); last_sig = c; i += 1
                continue
            if c == '`':
                state = 'tpl'
                out.append(c); last_sig = c; i += 1
                continue
            out.append(c)
            if not c.isspace():
                last_sig = c
            i += 1
            continue

        if state == 'regex':
            out.append(c)
            if c == '\\':
                if i + 1 < n:
                    out.append(src[i + 1])
                i += 2
                continue
            if c == '/':
                state = 'code'
                last_sig = '/'
            i += 1
            continue

        if state == 'line':
            if c == '\n':
                state = 'code'
                out.append('\n')
            i += 1
            continue

        if state == 'block':
            if c == '*' and nxt == '/':
                state = 'code'
                i += 2
                continue
            if c == '\n':
                out.append('\n')
            i += 1
            continue

        if state == 'sq':
            out.append(c)
            if c == '\\':
                if i + 1 < n:
                    out.append(src[i + 1])
                i += 2
                continue
            if c == "'":
                state = 'code'
            i += 1
            continue

        if state == 'dq':
            out.append(c)
            if c == '\\':
                if i + 1 < n:
                    out.append(src[i + 1])
                i += 2
                continue
            if c == '"':
                state = 'code'
            i += 1
            continue

        if state == 'tpl':
            out.append(c)
            if c == '\\':
                if i + 1 < n:
                    out.append(src[i + 1])
                i += 2
                continue
            if c == '`':
                state = 'code'
            i += 1
            continue

    return ''.join(out)


def tidy(js):
    """收掉去注释留下的空行（最多留一个空行，行首缩进不动）。"""
    lines = [ln.rstrip() for ln in js.split('\n')]
    out = []
    blank = 0
    for ln in lines:
        if ln.strip() == '':
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    return '\n'.join(out).strip() + '\n'


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    # 目录可能被资源管理器/终端占用（WinError 32），删不掉就复用，别让整次打包失败
    if os.path.isdir(OUT):
        shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    # 清掉旧文件，避免上一版的残留混进新包
    for f in os.listdir(OUT):
        p = os.path.join(OUT, f)
        try:
            os.remove(p) if os.path.isfile(p) else shutil.rmtree(p, ignore_errors=True)
        except OSError:
            print('  ! 清不掉（被占用）:', f)

    print('=' * 60)
    print('  生成部署包（去源码注释）')
    print('=' * 60)
    saved = 0
    for f in COPY_ASIS:
        src = os.path.join(SITE, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(OUT, f))
            print('  复制  %-20s %6.1f KB' % (f, os.path.getsize(src) / 1024))

    for f in STRIP_JS:
        src = os.path.join(SITE, f)
        if not os.path.exists(src):
            print('  缺文件: %s' % f)
            continue
        raw = open(src, encoding='utf-8').read()
        stripped = tidy(strip_js_comments(raw))
        dst = os.path.join(OUT, f)
        open(dst, 'w', encoding='utf-8', newline='\n').write(stripped)
        before, after = len(raw), len(stripped)
        saved += before - after
        print('  去注释 %-20s %6.1f -> %5.1f KB  (-%.0f%%)'
              % (f, before / 1024, after / 1024, (before - after) * 100.0 / before))

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print('-' * 60)
    print('  输出：%s' % OUT)
    print('  文件 %d 个 / 共 %.0f KB / 去掉了 %.0f KB 注释'
          % (len(os.listdir(OUT)), total / 1024, saved / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
