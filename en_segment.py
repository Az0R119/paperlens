"""英文粘连修复 —— 用 wordninja（英文词频表）+ 两条保护规则。

★ 为什么不用正则 / 自己编词表（试过，都不行）
  · 正则「小写后接大写」：'toreinventhighereducationand' 全小写，一条都切不开
  · 自编 300 词表 + DP：切出 'o p p or t u n it y' 碎片（opportunity 不在表里）
  · wordninja 自带真实英文词频表（约 1 MB），实测正确率接近全对：
      opportunitytoreinventhighereducationand → opportunity to reinvent higher education and

★ 需要人工保护的两类（wordninja 会把它们拆错）
  ① 全大写缩写：AI → 'A I'、API → 'A P I'、USA → 'U S A'
  ② 驼峰专有名词：aWake → 'a Wake'（应该是 aWake 或 a Wake 都不理想，
     但至少不能拆成 'a W ake'）

★ 中文行一律不碰。
"""
import re

try:
    import wordninja
    _HAS_WN = True
except ImportError:          # 打包漏了也不该让整条 OCR 链崩掉
    _HAS_WN = False

# 不能被拆开的全大写缩写（出现频率高、拆错会很难看）
KEEP_UPPER = {
    'AI', 'ML', 'DL', 'API', 'APIs', 'UI', 'URL', 'HTTP', 'HTTPS', 'PDF', 'CPU',
    'GPU', 'TPU', 'RAM', 'SSD', 'OS', 'US', 'USA', 'UK', 'EU', 'CEO', 'CTO',
    'ID', 'IT', 'HR', 'PR', 'TV', 'PC', 'OK', 'FAQ', 'SQL', 'JSON', 'HTML',
    'CSS', 'JS', 'RAG', 'LLM', 'LLMs', 'GPT', 'CNN', 'RNN', 'LSTM', 'NLP',
}

# 拆出来的双字母片段，如果是这些就拼回去（'A I' → 'AI'）
def _merge_initials(line):
    """把被拆散的缩写拼回来：'A I' → 'AI'，'A P I' → 'API'。

    判据：连续的单大写字母（2 个以上）后面不跟小写字母时，视为缩写。
    """
    def m(match):
        letters = re.findall(r'[A-Z]', match.group(0))
        return ''.join(letters)
    return re.sub(r'\b[A-Z](?:\s[A-Z]){1,5}\b', m, line)


def fix_en_spaces(line):
    """修复 OCR 丢空格的英文行。中文行原样返回。

    只在「连续字母长度 >= 8」的片段上动手 —— 短的已经是正常单词，不碰。
    """
    if not line or not line.strip():
        return line
    s = line.strip()

    # 中文占比高 → 不碰
    cjk = sum(1 for ch in s if '\u4e00' <= ch <= '\u9fff')
    if cjk and cjk / max(1, len(s)) > 0.25:
        return line

    if not _HAS_WN:
        return line

    # 先保护全大写缩写：临时替换成占位符
    holders = {}

    def hold(m):
        w = m.group(0)
        if w in KEEP_UPPER:
            key = '\x00%d\x00' % len(holders)
            holders[key] = w
            return key
        return w
    s2 = re.sub(r'\b[A-Z]{2,6}\b', hold, s)

    # 长字母串交给 wordninja
    def split_long(m):
        w = m.group(0)
        if len(w) < 8:
            return w
        try:
            parts = wordninja.split(w)
        except Exception:
            return w
        if not parts:
            return w
        return ' '.join(parts)
    out = re.sub(r'[A-Za-z]{8,}', split_long, s2)

    # 还原占位符
    for k, v in holders.items():
        out = out.replace(k, v)

    # 把被拆散的缩写拼回（'A I' → 'AI'）
    out = _merge_initials(out)

    return re.sub(r' {2,}', ' ', out)


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    cases = [
        'AI ShouldBeaWake-UpCall For',
        'TheAIerais"precipitatingapivotal opportunitytoreinventhighereducationand embrace',
        'thebroaderscope itonce had,writesAriannaHuffington.',
        'ThedebateoverhowAIwillimpacthighereducationhasnarrowedintoasingle',
        'inaworldwheremachinescanthink,howdowemakesurestudentsstilllearn',
        'Thisisan importantquestion,but',
        '这是一段纯中文的测试文字不应该被改动',
        '中英混排 Test Document 这是第二行',
    ]
    for c in cases:
        print('原:', c)
        print('改:', fix_en_spaces(c))
        print()
