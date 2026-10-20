/* paperlens · 论文解析看板
 * 作者：李子正（正点 / OPC）
 *  * 仓库：https://github.com/Az0R119/paperlens
 *
 * 纯前端实现：不调任何 API、不上传任何数据。
 * 设计决策、实测数据与踩坑记录见 README.md 的「实测记录」章节。
 */
// 论文领域检测 —— 判"这篇适不适合用 ML 模型"。
//
// ★ 为什么需要（用户的思路，原话）：
//   "先判断论文类型 擅长的用模型 不擅长的就不用"
//   这正好是"专家混合（Mixture of Experts）"的朴素形态。
//
// ★ 实测依据（research/route_detect.py，7 个样本）：
//
//     PubMed 医学摘要    → medical (81 vs 42)   ✓ 关键：医学识别对了
//     Attention (ML)    → tech    (3 vs 45)     ✓
//     知识图谱 (中文CS)   → tech    (0 vs 30)     ✓
//     CNN综述 (中文CS)    → tech    (0 vs 28)     ✓
//     微博情感 (中文CS)   → tech    (0 vs 48)     ✓
//     李旭 教育          → unknown             ✓
//     arXiv 混合语料      → unknown (59 vs 54)  ✗ 唯一失败，但无代价
//
// ★ 关键安全属性：**把通用论文误判成 medical 的次数 = 0**。
//   这是唯一会造成伤害的错法（会把医学模型用到 ML 论文上瞎判）。
//   而 tech 与 unknown 的**处置完全相同**（都不用模型），所以判错它们零代价。
//
// ★ 为什么不直接接进产品主流程：
//   比赛演示的 5 篇全是 tech/unknown，一个都不会走模型分支 ——
//   接了等于给每篇都跑一遍无用计算。所以做成独立模块 + 明确开关，
//   等有通用论文的人工标注语料、模型能跨领域用了再默认打开。
//
// ponytail: 信号表是"词面 + 计数"的朴素做法。要更准可上 TF-IDF + 线性分类器，
//   但当前样本量（7 个）撑不起训练，等标注语料到位再说。

(function () {
  'use strict';

  // 医学信号（来源：PubMed RCT 语料里高频、而 ML/通用论文里罕见的词与结构）
  var MED = [
    [/\b(patients?|subjects?|participants?|adults?|children|women|men)\b/g, 3, '受试对象'],
    [/\b(randomi[sz]ed|placebo|double-blind|single-blind|blinded|open-label|crossover)\b/g, 4, '试验设计'],
    [/\b(trial|cohort|intervention|treatment|therapy|dose|dosage|placebo)\b/g, 3, '临床干预'],
    [/\b(disease|disorder|syndrome|infection|cancer|tumor|diabetes|hypertension|stroke|pain)\b/g, 3, '疾病名'],
    [/\b(clinical|hospital|clinic|outpatient|surgery|surgical|diagnos\w+|prognos\w+)\b/g, 3, '临床场所'],
    [/\b(mortality|morbidity|adverse events?|efficacy|safety profile|side effects?)\b/g, 3, '临床终点'],
    [/\b(95%\s*(ci|confidence interval)|p\s*[<=]\s*0?\.\d+|hazard ratio|odds ratio|mmhg|hba1c)\b/g, 4, '统计报告'],
    [/\b(consort|nct\d+|clinicaltrials\.gov|informed consent|ethics committee|irb)\b/g, 4, '试验注册'],
    [/\b(pubmed|medline|mesh terms?|systematic review|meta-analysis|cochrane)\b/g, 3, '文献库']
  ];

  // 技术/通用信号
  var TECH = [
    [/\b(model|network|neural|deep learning|training|dataset|benchmark)\b/g, 2, 'ML 术语'],
    [/\b(algorithm|architecture|framework|pipeline|implementation|open[- ]source|github)\b/g, 3, '工程术语'],
    [/\b(accuracy|f1|bleu|perplexity|state-of-the-art|sota|baseline)\b/g, 3, 'ML 指标'],
    [/\b(gpu|tpu|cuda|pytorch|tensorflow|transformer|attention|embedding)\b/g, 3, '框架/架构'],
    [/\b(arxiv|neurips|icml|iclr|cvpr|acl|emnlp|aaai|ijcai)\b/g, 4, 'ML 会议'],
    [/\b(ablation|hyperparameter|fine-?tun\w+|pretrain\w+|throughput|latency)\b/g, 3, 'ML 实验'],
    // 中文信号（实测补：中文 CS 论文原来拿 0 分，因为全是英文正则）
    [/(神经网络|深度学习|机器学习|卷积|注意力|模型|算法|数据集|训练|特征|分类器)/g, 3, '中文 ML 术语'],
    [/(准确率|精确率|召回率|性能|基线|最优|实验表明|实验结果)/g, 3, '中文 ML 指标'],
    [/(计算机|软件|信息|数据|人工智能|模式识别|自然语言|图像)/g, 2, '中文 CS 领域'],
    [/(本文提出|本文采用|我们提出|该方法|所提方法)/g, 2, '中文论文自指']
  ];

  function score(text, table) {
    var t = text.toLowerCase(), total = 0, hits = [];
    for (var i = 0; i < table.length; i++) {
      var rx = table[i][0], w = table[i][1], name = table[i][2];
      var m = t.match(rx);
      if (m && m.length) {
        total += w * Math.min(3, m.length);      // 单信号最多计 3 次，避免长文堆分
        hits.push(name + '×' + m.length);
      }
    }
    return { total: total, hits: hits };
  }

  function detect(text) {
    var med = score(text || '', MED), tech = score(text || '', TECH);
    // DOI / PubMed 链接是强医学信号
    if (/(10\.\d{4,}\/[^\s]*)|\bpubmed\b|ncbi\.nlm\.nih\.gov/i.test(text || '')) {
      med.total += 4;
      med.hits.push('DOI/PubMed');
    }
    var dom;
    if (med.total > tech.total * 1.2 && med.total >= 12) dom = 'medical';
    else if (tech.total > med.total * 1.2 && tech.total >= 12) dom = 'tech';
    else dom = 'unknown';
    return {
      domain: dom,
      medical: med.total,
      tech: tech.total,
      hits: { medical: med.hits.slice(0, 4), tech: tech.hits.slice(0, 4) },
      // ★ 只有 medical 才建议用医学模型；tech 与 unknown 处置相同（都不用）
      useModel: dom === 'medical'
    };
  }

  var G = (typeof window !== 'undefined') ? window : globalThis;
  G.PL_DOMAIN = { detect: detect, MED: MED, TECH: TECH };
})();
