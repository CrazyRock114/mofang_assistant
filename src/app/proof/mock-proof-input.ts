// C1 Phase 1: mock 校对输入 — 由 C0 回归样本（shanghai-2024-deepseek 前 3 页）经
// fixture-convert → segmentPaper → DraftBuilder 生成后固化为字面量（生成口径在案）。
// imagePath 为内联最小样例图（1×1 透明 PNG data URL，不引用任何本机路径）；页面回落时图不显示但文本可用。

import type { ProofPageInput } from '../../shared/contracts/recog-ui-types.js';

// 0075 A2（内联化）：mock 页图统一用 1×1 透明 PNG data URL——原相对路径指向的样例图不随产品分发。
const MOCK_PAGE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const MOCK_PROOF_INPUT: ProofPageInput = {
  "pages": [
    {
      "pageNo": 1,
      "imagePath": MOCK_PAGE_IMAGE,
      "ocrText": "# 绝密★启用前  \n\n# 2024年上海市高考物理试卷  \n\n学校：______ 姓名：______ 班级：______ 考号：______  \n\n## 注意事项：  \n\n1. 答卷前，考生务必将自己的姓名、准考证号填写在答题卡上。  \n2. 回答选择题时，选出每小题答案后，用铅笔把答题卡对应题目的答案标号涂黑；如需改动，用橡皮擦干净后，再选涂其他答案标号。回答非选择题时，将答案写在答题卡上，写在试卷上无效。  \n3. 考试结束后，本试卷和答题卡一并交回。  \n\n# 第II卷（非选择题）  \n\n## 一、简答题：本大题共6小题，共18分。  \n\n1. 实验是人类认识物质世界的宏观性质与微观结构的重要手段之一，也是物理学研究的重要方法。  \n\n(1)通过“用油膜法估测油酸分子的大小”的实验可推测油酸分子的直径约为______。  \n\n\\(A.10^{-15}m\\) \\(B.10^{-12}m\\) \\(C.10^{-9}m\\) \\(D.10^{-6}m\\)  \n\n(2)验证气体体积随温度变化关系的实验装置如图所示，用支架将封有一定质量气体的注射器和温度传感器固定在盛有热水的烧杯中。实验过程中，随着水温的缓慢下降，记录多组气体温度和体积的数据。  \n\n<|ref|>text<|/ref|><|det|>[[87, 669, 491, 686]]<|/det|>  \n\n<|ref|>image<|/ref|><|det|>[[85, 690, 718, 780]]<|/det|>  \n\n<|ref|>text<|/ref|><|det|>[[87, 791, 438, 808]]<|/det|>  \n\n<|ref|>text<|/ref|><|det|>[[86, 819, 321, 863]]<|/det|>  \n\n<|ref|>image<|/ref|><|det|>[[744, 390, 909, 580]]<|/det|>"
    },
    {
      "pageNo": 2,
      "imagePath": MOCK_PAGE_IMAGE,
      "ocrText": "C. 待温度读数完全稳定后才记录数据  \nD. 测量过程中保持水面高于活塞下端  \n\n2. 我国的汽车智能化技术发展迅猛。各类车载雷达是汽车自主感知系统的重要组成部分。汽车在检测到事故风险后，通过自主决策和自主控制及时采取措施，提高了安全性。  \n\n(1) 车载雷达系统可以发出激光和超声波信号，其中____。  \nA. 仅激光是横波  \nB. 激光与超声波都是横波  \nC. 仅超声波是横波  \nD. 激光与超声波都不是横波  \n\n(2) 一辆质量 \\(m = 2.0 \\times 10^3 \\, \\text{kg}\\) 的汽车，以 \\(v = 36 \\, \\text{km/h}\\) 的速度在平直路面上匀速行驶，此过程中发动机功率 \\(P_1 = 6.0 \\, \\text{kW}\\)，汽车受到的阻力大小为____N。当车载雷达探测到前方有障碍物时，主动刹车系统立即撤去发动机驱动力，同时施加制动力使车辆减速。在刚进入制动状态的瞬间，系统提供的制动功率 \\(P_2 = 48 \\, \\text{kW}\\)，此时汽车的制动力大小为____N，加速度大小为____m/s\\(^2\\)。（不计传动装置和热损耗造成的能量损失）  \n\n3. 光的行为曾令物理学家感到困惑。双缝干涉、光电效应等具有里程碑意义的实验。逐渐揭开了光的神秘面纱。人类对光的认识不断深入，引发了具有深远意义的物理学革命。  \n\n(1) 在“用双缝干涉实验测量光的波长”的实验中，双缝间距为 \\(d\\)，双缝到光强分布传感器距离为 \\(L\\)。  \n① 实验时测得 \\(N\\) 条暗条纹间距为 \\(D\\)，则激光器发出的光波波长为____。  \nA. \\(\\frac{Dd}{NL}\\)  \nB. \\(\\frac{Dd}{(N-1)L}\\)  \nC. \\(\\frac{DL}{Nd}\\)  \nD. \\(\\frac{DL}{(N-1)d}\\)  \n\n② 在激光器和双缝之间加入一个与光束垂直放置的偏振片，测得的干涉条纹间距与不加偏振片时相比____。  \n\nA. 增加  \nB. 不变  \nC. 减小  \nD. 移去偏振片，将双缝换成单缝，能使单缝衍射中央亮纹宽度增大的操作有____。（多选）  \n\nA. 减小缝宽"
    },
    {
      "pageNo": 3,
      "imagePath": MOCK_PAGE_IMAGE,
      "ocrText": "B. 使单缝靠近传感器  \nC. 增大缝宽  \nD. 使单缝远离传感器  \n\n(2) 某紫外激光波长为 \\(\\lambda\\)，其单个光子能量为______。若用该激光做光电效应实验，所用光电材料的截止频率为 \\(\\nu_0\\)，则逸出光电子的最大初动能为______。(普朗克常量为 \\(h\\)，真空中光速为 \\(c\\))  \n\n4. 包括太阳、地球在内的所有物体都会在其周围产生引力场。在不同尺度的空间，引力场中的物体运动具有不同的表象。牛顿揭示了苹果下落和行星运动共同的物理机制。意味着天上的物理和地上的物理是一样的，物理规律的普适性反映了一种简单的美。  \n\n(1) 如图1，小球 \\(a\\) 通过轻质细线 \\(I\\)、\\(II\\) 悬挂，处于静止状态。线 \\(I\\) 长 \\(l = 0.5m\\)，\\(I\\) 上端固定于离地 \\(H = 2.1m\\) 的 \\(O\\) 点，与竖直方向之间夹角 \\(\\theta = 37^\\circ\\)；线 \\(II\\) 保持水平。\\(O\\) 点正下方有一与 \\(a\\) 质量相等的小球 \\(b\\)，静置于离地高度 \\(h = 1.6m\\) 的支架上。(取 \\(\\sin 37^\\circ = 0.6\\)，\\(\\cos 37^\\circ = 0.8\\))  \n\n(1) 在线 \\(I\\)、\\(II\\) 的张力大小 \\(F_{\\text{沿}}\\)、\\(F_{\\text{后}}\\) 和小球 \\(a\\) 所受重力大小 \\(G\\) 中，最大的是______。  \n\n(2) 烧断线 \\(II\\)，\\(a\\) 运动到最低点时与 \\(b\\) 发生弹性碰撞。求：  \n\nA. 与 \\(b\\) 球碰撞前瞬间 \\(a\\) 球的速度大小 \\(\\nu_a\\)；(计算)  \nB. 碰撞后瞬间 \\(b\\) 球的速度大小 \\(\\nu_b\\)；(计算)  \nC. \\(b\\) 球的水平射程 \\(s\\)。(计算)  \n\n(2) 图2示虚线为某彗星绕日运行的椭圆形轨道，\\(a\\)、\\(c\\) 为椭圆轨道长轴端点，\\(b\\)、\\(d\\) 为椭圆轨道短轴端点。彗星沿图中箭头方向运行。  \n\n(1) 该彗星某时刻位于 \\(a\\) 点，经过四分之一周期该彗星位于轨道的______。  \n\nA. \\(ab\\) 之间  \nB. \\(b\\) 点  \nC. \\(bc\\) 之间  \nD. \\(c\\) 点  \n\n(2) 已知太阳质量为 \\(M\\)，引力常量为 \\(G\\)。当彗日间距为 \\(r_1\\) 时，彗星速度大小为 \\(\\nu_1\\)。求彗日间距为 \\(r_2\\) 时的彗星速度大小 \\(\\nu_2\\)。(计算)"
    }
  ],
  "items": [
    {
      "draftId": "1-1",
      "pageNo": 1,
      "qno": 1,
      "source": "rule",
      "contentHtml": "<div class=\"question\"><p>实验是人类认识物质世界的宏观性质与微观结构的重要手段之一，也是物理学研究的重要方法。\n(1)通过“用油膜法估测油酸分子的大小”的实验可推测油酸分子的直径约为______。\n<span class=\"math\" data-tex=\"A.10^{-15}m\"></span> <span class=\"math\" data-tex=\"B.10^{-12}m\"></span> <span class=\"math\" data-tex=\"C.10^{-9}m\"></span> <span class=\"math\" data-tex=\"D.10^{-6}m\"></span>\n(2)验证气体体积随温度变化关系的实验装置如图所示，用支架将封有一定质量气体的注射器和温度传感器固定在盛有热水的烧杯中。实验过程中，随着水温的缓慢下降，记录多组气体温度和体积的数据。</p><figure class=\"diagram\" data-align=\"center\" data-w=\"0\" data-h=\"0\"><img src=\"\" alt=\"p1-img-0\"></figure><figure class=\"diagram\" data-align=\"center\" data-w=\"0\" data-h=\"0\"><img src=\"\" alt=\"p1-img-1\"></figure><div class=\"options\"><span class=\"option\">C. 待温度读数完全稳定后才记录数据</span><span class=\"option\">D. 测量过程中保持水面高于活塞下端</span></div></div>",
      "imageRefIds": [
        "p1-img-0",
        "p1-img-1"
      ],
      "status": "pending",
      "warnings": [
        "图片块 p1-img-0 无裁图数据，img 为占位",
        "图片块 p1-img-1 无裁图数据，img 为占位"
      ],
      "rawText": "1. 实验是人类认识物质世界的宏观性质与微观结构的重要手段之一，也是物理学研究的重要方法。  \n(1)通过“用油膜法估测油酸分子的大小”的实验可推测油酸分子的直径约为______。  \n\\(A.10^{-15}m\\) \\(B.10^{-12}m\\) \\(C.10^{-9}m\\) \\(D.10^{-6}m\\)  \n(2)验证气体体积随温度变化关系的实验装置如图所示，用支架将封有一定质量气体的注射器和温度传感器固定在盛有热水的烧杯中。实验过程中，随着水温的缓慢下降，记录多组气体温度和体积的数据。  \n<|ref|>image<|/ref|><|det|>[[85, 690, 718, 780]]<|/det|>  \n<|ref|>image<|/ref|><|det|>[[744, 390, 909, 580]]<|/det|>\nC. 待温度读数完全稳定后才记录数据  \nD. 测量过程中保持水面高于活塞下端  "
    },
    {
      "draftId": "2-2",
      "pageNo": 2,
      "qno": 2,
      "source": "rule",
      "contentHtml": "<div class=\"question\"><p>我国的汽车智能化技术发展迅猛。各类车载雷达是汽车自主感知系统的重要组成部分。汽车在检测到事故风险后，通过自主决策和自主控制及时采取措施，提高了安全性。\n(1) 车载雷达系统可以发出激光和超声波信号，其中____。</p><div class=\"options\"><span class=\"option\">A. 仅激光是横波</span><span class=\"option\">B. 激光与超声波都是横波</span><span class=\"option\">C. 仅超声波是横波</span><span class=\"option\">D. 激光与超声波都不是横波</span></div><p>(2) 一辆质量 <span class=\"math\" data-tex=\"m = 2.0 \\times 10^3 \\, \\text{kg}\"></span> 的汽车，以 <span class=\"math\" data-tex=\"v = 36 \\, \\text{km/h}\"></span> 的速度在平直路面上匀速行驶，此过程中发动机功率 <span class=\"math\" data-tex=\"P_1 = 6.0 \\, \\text{kW}\"></span>，汽车受到的阻力大小为____N。当车载雷达探测到前方有障碍物时，主动刹车系统立即撤去发动机驱动力，同时施加制动力使车辆减速。在刚进入制动状态的瞬间，系统提供的制动功率 <span class=\"math\" data-tex=\"P_2 = 48 \\, \\text{kW}\"></span>，此时汽车的制动力大小为____N，加速度大小为____m/s<span class=\"math\" data-tex=\"^2\"></span>。（不计传动装置和热损耗造成的能量损失）</p></div>",
      "imageRefIds": [],
      "status": "pending",
      "warnings": [],
      "rawText": "2. 我国的汽车智能化技术发展迅猛。各类车载雷达是汽车自主感知系统的重要组成部分。汽车在检测到事故风险后，通过自主决策和自主控制及时采取措施，提高了安全性。  \n(1) 车载雷达系统可以发出激光和超声波信号，其中____。  \nA. 仅激光是横波  \nB. 激光与超声波都是横波  \nC. 仅超声波是横波  \nD. 激光与超声波都不是横波  \n(2) 一辆质量 \\(m = 2.0 \\times 10^3 \\, \\text{kg}\\) 的汽车，以 \\(v = 36 \\, \\text{km/h}\\) 的速度在平直路面上匀速行驶，此过程中发动机功率 \\(P_1 = 6.0 \\, \\text{kW}\\)，汽车受到的阻力大小为____N。当车载雷达探测到前方有障碍物时，主动刹车系统立即撤去发动机驱动力，同时施加制动力使车辆减速。在刚进入制动状态的瞬间，系统提供的制动功率 \\(P_2 = 48 \\, \\text{kW}\\)，此时汽车的制动力大小为____N，加速度大小为____m/s\\(^2\\)。（不计传动装置和热损耗造成的能量损失）  "
    },
    {
      "draftId": "2-3",
      "pageNo": 2,
      "qno": 3,
      "source": "rule",
      "contentHtml": "<div class=\"question\"><p>光的行为曾令物理学家感到困惑。双缝干涉、光电效应等具有里程碑意义的实验。逐渐揭开了光的神秘面纱。人类对光的认识不断深入，引发了具有深远意义的物理学革命。\n(1) 在“用双缝干涉实验测量光的波长”的实验中，双缝间距为 <span class=\"math\" data-tex=\"d\"></span>，双缝到光强分布传感器距离为 <span class=\"math\" data-tex=\"L\"></span>。\n① 实验时测得 <span class=\"math\" data-tex=\"N\"></span> 条暗条纹间距为 <span class=\"math\" data-tex=\"D\"></span>，则激光器发出的光波波长为____。</p><div class=\"options\"><span class=\"option\">A. <span class=\"math\" data-tex=\"\\frac{Dd}{NL}\"></span></span><span class=\"option\">B. <span class=\"math\" data-tex=\"\\frac{Dd}{(N-1)L}\"></span></span><span class=\"option\">C. <span class=\"math\" data-tex=\"\\frac{DL}{Nd}\"></span></span><span class=\"option\">D. <span class=\"math\" data-tex=\"\\frac{DL}{(N-1)d}\"></span></span></div><p>② 在激光器和双缝之间加入一个与光束垂直放置的偏振片，测得的干涉条纹间距与不加偏振片时相比____。</p><div class=\"options\"><span class=\"option\">A. 增加</span><span class=\"option\">B. 不变</span><span class=\"option\">C. 减小</span><span class=\"option\">D. 移去偏振片，将双缝换成单缝，能使单缝衍射中央亮纹宽度增大的操作有____。（多选）</span><span class=\"option\">A. 减小缝宽</span><span class=\"option\">B. 使单缝靠近传感器</span><span class=\"option\">C. 增大缝宽</span><span class=\"option\">D. 使单缝远离传感器</span></div><p>(2) 某紫外激光波长为 <span class=\"math\" data-tex=\"\\lambda\"></span>，其单个光子能量为______。若用该激光做光电效应实验，所用光电材料的截止频率为 <span class=\"math\" data-tex=\"\\nu_0\"></span>，则逸出光电子的最大初动能为______。(普朗克常量为 <span class=\"math\" data-tex=\"h\"></span>，真空中光速为 <span class=\"math\" data-tex=\"c\"></span>)</p></div>",
      "imageRefIds": [],
      "status": "pending",
      "warnings": [],
      "rawText": "3. 光的行为曾令物理学家感到困惑。双缝干涉、光电效应等具有里程碑意义的实验。逐渐揭开了光的神秘面纱。人类对光的认识不断深入，引发了具有深远意义的物理学革命。  \n(1) 在“用双缝干涉实验测量光的波长”的实验中，双缝间距为 \\(d\\)，双缝到光强分布传感器距离为 \\(L\\)。  \n① 实验时测得 \\(N\\) 条暗条纹间距为 \\(D\\)，则激光器发出的光波波长为____。  \nA. \\(\\frac{Dd}{NL}\\)  \nB. \\(\\frac{Dd}{(N-1)L}\\)  \nC. \\(\\frac{DL}{Nd}\\)  \nD. \\(\\frac{DL}{(N-1)d}\\)  \n② 在激光器和双缝之间加入一个与光束垂直放置的偏振片，测得的干涉条纹间距与不加偏振片时相比____。  \nA. 增加  \nB. 不变  \nC. 减小  \nD. 移去偏振片，将双缝换成单缝，能使单缝衍射中央亮纹宽度增大的操作有____。（多选）  \nA. 减小缝宽\nB. 使单缝靠近传感器  \nC. 增大缝宽  \nD. 使单缝远离传感器  \n(2) 某紫外激光波长为 \\(\\lambda\\)，其单个光子能量为______。若用该激光做光电效应实验，所用光电材料的截止频率为 \\(\\nu_0\\)，则逸出光电子的最大初动能为______。(普朗克常量为 \\(h\\)，真空中光速为 \\(c\\))  "
    },
    {
      "draftId": "3-4",
      "pageNo": 3,
      "qno": 4,
      "source": "rule",
      "contentHtml": "<div class=\"question\"><p>包括太阳、地球在内的所有物体都会在其周围产生引力场。在不同尺度的空间，引力场中的物体运动具有不同的表象。牛顿揭示了苹果下落和行星运动共同的物理机制。意味着天上的物理和地上的物理是一样的，物理规律的普适性反映了一种简单的美。\n(1) 如图1，小球 <span class=\"math\" data-tex=\"a\"></span> 通过轻质细线 <span class=\"math\" data-tex=\"I\"></span>、<span class=\"math\" data-tex=\"II\"></span> 悬挂，处于静止状态。线 <span class=\"math\" data-tex=\"I\"></span> 长 <span class=\"math\" data-tex=\"l = 0.5m\"></span>，<span class=\"math\" data-tex=\"I\"></span> 上端固定于离地 <span class=\"math\" data-tex=\"H = 2.1m\"></span> 的 <span class=\"math\" data-tex=\"O\"></span> 点，与竖直方向之间夹角 <span class=\"math\" data-tex=\"\\theta = 37^\\circ\"></span>；线 <span class=\"math\" data-tex=\"II\"></span> 保持水平。<span class=\"math\" data-tex=\"O\"></span> 点正下方有一与 <span class=\"math\" data-tex=\"a\"></span> 质量相等的小球 <span class=\"math\" data-tex=\"b\"></span>，静置于离地高度 <span class=\"math\" data-tex=\"h = 1.6m\"></span> 的支架上。(取 <span class=\"math\" data-tex=\"\\sin 37^\\circ = 0.6\"></span>，<span class=\"math\" data-tex=\"\\cos 37^\\circ = 0.8\"></span>)\n(1) 在线 <span class=\"math\" data-tex=\"I\"></span>、<span class=\"math\" data-tex=\"II\"></span> 的张力大小 <span class=\"math\" data-tex=\"F_{\\text{沿}}\"></span>、<span class=\"math\" data-tex=\"F_{\\text{后}}\"></span> 和小球 <span class=\"math\" data-tex=\"a\"></span> 所受重力大小 <span class=\"math\" data-tex=\"G\"></span> 中，最大的是______。\n(2) 烧断线 <span class=\"math\" data-tex=\"II\"></span>，<span class=\"math\" data-tex=\"a\"></span> 运动到最低点时与 <span class=\"math\" data-tex=\"b\"></span> 发生弹性碰撞。求：</p><div class=\"options\"><span class=\"option\">A. 与 <span class=\"math\" data-tex=\"b\"></span> 球碰撞前瞬间 <span class=\"math\" data-tex=\"a\"></span> 球的速度大小 <span class=\"math\" data-tex=\"\\nu_a\"></span>；(计算)</span><span class=\"option\">B. 碰撞后瞬间 <span class=\"math\" data-tex=\"b\"></span> 球的速度大小 <span class=\"math\" data-tex=\"\\nu_b\"></span>；(计算)</span><span class=\"option\">C. <span class=\"math\" data-tex=\"b\"></span> 球的水平射程 <span class=\"math\" data-tex=\"s\"></span>。(计算)</span></div><p>(2) 图2示虚线为某彗星绕日运行的椭圆形轨道，<span class=\"math\" data-tex=\"a\"></span>、<span class=\"math\" data-tex=\"c\"></span> 为椭圆轨道长轴端点，<span class=\"math\" data-tex=\"b\"></span>、<span class=\"math\" data-tex=\"d\"></span> 为椭圆轨道短轴端点。彗星沿图中箭头方向运行。\n(1) 该彗星某时刻位于 <span class=\"math\" data-tex=\"a\"></span> 点，经过四分之一周期该彗星位于轨道的______。</p><div class=\"options\"><span class=\"option\">A. <span class=\"math\" data-tex=\"ab\"></span> 之间</span><span class=\"option\">B. <span class=\"math\" data-tex=\"b\"></span> 点</span><span class=\"option\">C. <span class=\"math\" data-tex=\"bc\"></span> 之间</span><span class=\"option\">D. <span class=\"math\" data-tex=\"c\"></span> 点</span></div><p>(2) 已知太阳质量为 <span class=\"math\" data-tex=\"M\"></span>，引力常量为 <span class=\"math\" data-tex=\"G\"></span>。当彗日间距为 <span class=\"math\" data-tex=\"r_1\"></span> 时，彗星速度大小为 <span class=\"math\" data-tex=\"\\nu_1\"></span>。求彗日间距为 <span class=\"math\" data-tex=\"r_2\"></span> 时的彗星速度大小 <span class=\"math\" data-tex=\"\\nu_2\"></span>。(计算)</p></div>",
      "imageRefIds": [],
      "status": "pending",
      "warnings": [],
      "rawText": "4. 包括太阳、地球在内的所有物体都会在其周围产生引力场。在不同尺度的空间，引力场中的物体运动具有不同的表象。牛顿揭示了苹果下落和行星运动共同的物理机制。意味着天上的物理和地上的物理是一样的，物理规律的普适性反映了一种简单的美。  \n(1) 如图1，小球 \\(a\\) 通过轻质细线 \\(I\\)、\\(II\\) 悬挂，处于静止状态。线 \\(I\\) 长 \\(l = 0.5m\\)，\\(I\\) 上端固定于离地 \\(H = 2.1m\\) 的 \\(O\\) 点，与竖直方向之间夹角 \\(\\theta = 37^\\circ\\)；线 \\(II\\) 保持水平。\\(O\\) 点正下方有一与 \\(a\\) 质量相等的小球 \\(b\\)，静置于离地高度 \\(h = 1.6m\\) 的支架上。(取 \\(\\sin 37^\\circ = 0.6\\)，\\(\\cos 37^\\circ = 0.8\\))  \n(1) 在线 \\(I\\)、\\(II\\) 的张力大小 \\(F_{\\text{沿}}\\)、\\(F_{\\text{后}}\\) 和小球 \\(a\\) 所受重力大小 \\(G\\) 中，最大的是______。  \n(2) 烧断线 \\(II\\)，\\(a\\) 运动到最低点时与 \\(b\\) 发生弹性碰撞。求：  \nA. 与 \\(b\\) 球碰撞前瞬间 \\(a\\) 球的速度大小 \\(\\nu_a\\)；(计算)  \nB. 碰撞后瞬间 \\(b\\) 球的速度大小 \\(\\nu_b\\)；(计算)  \nC. \\(b\\) 球的水平射程 \\(s\\)。(计算)  \n(2) 图2示虚线为某彗星绕日运行的椭圆形轨道，\\(a\\)、\\(c\\) 为椭圆轨道长轴端点，\\(b\\)、\\(d\\) 为椭圆轨道短轴端点。彗星沿图中箭头方向运行。  \n(1) 该彗星某时刻位于 \\(a\\) 点，经过四分之一周期该彗星位于轨道的______。  \nA. \\(ab\\) 之间  \nB. \\(b\\) 点  \nC. \\(bc\\) 之间  \nD. \\(c\\) 点  \n(2) 已知太阳质量为 \\(M\\)，引力常量为 \\(G\\)。当彗日间距为 \\(r_1\\) 时，彗星速度大小为 \\(\\nu_1\\)。求彗日间距为 \\(r_2\\) 时的彗星速度大小 \\(\\nu_2\\)。(计算)"
    }
  ],
  "warnings": [
    "第1页出现首个章节头，其前编号段 1/2/3 降级为 skipped（注意事项等）"
  ]
};
