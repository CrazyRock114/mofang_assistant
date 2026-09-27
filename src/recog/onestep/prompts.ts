// 0040 P1：一步到位识别提示词资产（产品内资源）。
//
// 来源：0042 定稿资产移植（实验期侦察纪要 §七/§9.3 口径在案）。
// 纪律（施工口径在案）：只移植**提示词文本**为 src 内资源；实验期（POC）脚本一律不 import 进 src/。

/**
 * 一步到位提取提示词（0042 Q1 主档；`onestep_extract.md` 逐字移植）。
 * `{GROUNDING}` 段由 buildOnestepExtractPrompt 按需注入（主模型内联 bbox 兜底腿，0042 §十第四轮）。
 */
export const ONESTEP_EXTRACT_PROMPT = `你是教辅题库的试题结构化引擎。输入是一张试题截图或整页试卷图片。请把图中全部试题一次性转成结构化 JSON。

【输出格式】只输出一个 JSON 对象，禁止输出任何解释文字或 Markdown 代码围栏。结构如下：
{
  "questions": [
    {
      "qno": "17 或 2-17 或 null",
      "questionType": "单选|多选|填空|解答|判断 之一",
      "stemMarkdown": "题干",
      "options": [{"label": "A", "content": "选项内容"}],
      "answerMarkdown": "图中给出的答案",
      "analysisMarkdown": "图中给出的解析",
      "suggestedTags": ["知识点标签"]
    }
  ]
}

【字段规则】
1. qno：卷内题号原文的数字形态，如 "17"、"2-17"（章-题号）；图内确无题号则 null。
2. questionType 只能取：单选 / 多选 / 填空 / 解答 / 判断。
3. stemMarkdown：题干用 Markdown；行内公式写 $...$，独立公式行写 $$...$$；题干里的插图、表格在原位置写占位符 [图N]（N=1,2,… 按本题内出现顺序编号）。小题 (1)(2)① 属于同一大题时并入该题 stemMarkdown，不拆成多题。
4. options：有选项的题**必须**给 [{"label":"A","content":"…"},…]（label 不带冒号点号），content 内公式同样走 LaTeX；无选项为 null。
   选择/判断题的选项文字一律进 options 数组，**题干 stemMarkdown 里不得保留 "A．… B．…" 这类选项行**（不要用换行把它们和题干连在一起）。
5. answerMarkdown / analysisMarkdown：只抄录图中实际印出的答案/解析文字；图中没有就是 null，绝不自行作答或补写。
6. suggestedTags：3~8 个知识点标签（自由词、中文、简短，如 "抛体运动" "电磁感应"），按题面实际涉及的知识点给。
7. 整页多题时 questions 按卷面顺序输出全部题目，一条不漏。
{GROUNDING}`;

/**
 * 内联图块定位补充段（`grounding_generic.md` 逐字移植）。
 * 主调用带此段时，模型会在顶层多给 `figures`（0~999 归一）；DSO 未出图时作为兜底坐标源。
 * **注意**：这是兜底腿，不是主坐标源——坐标是 OCR 的独占能力（0042 §八.3）。
 */
export const ONESTEP_INLINE_GROUNDING = `8. 图示定位：在 JSON 顶层增加 "figures" 数组，对本页每个实际存在的插图给出 {"ref":"图N","bboxNorm":[x1,y1,x2,y2]}，ref 与题干中的 [图N] 占位对应；bboxNorm 为归一化坐标，四个值取 0~999 的整数（0=左/上边缘，999=右/下边缘）；框要贴住图形主体（含图内文字与坐标轴，不含题干正文与选项文字）。页内没有插图时 figures 为空数组 []。`;

/** 两段式结构化腿提示词（`twostage_structure.md` 逐字移植；降级档腿 2，文本推理模型） */
export const TWOSTAGE_STRUCTURE_PROMPT = `你是教辅题库的试题结构化引擎。输入是一道或一道大题的文字记录（来自 OCR，可能有识别噪声、公式可能不完整）。请把它整理成结构化 JSON。

【输出格式】只输出一个 JSON 对象，禁止输出任何解释文字或 Markdown 代码围栏。结构如下：
{
  "questions": [
    {
      "qno": "17 或 2-17 或 null",
      "questionType": "单选|多选|填空|解答|判断 之一",
      "stemMarkdown": "题干",
      "options": [{"label": "A", "content": "选项内容"}],
      "answerMarkdown": "文字中给出的答案",
      "analysisMarkdown": "文字中给出的解析",
      "suggestedTags": ["知识点标签"]
    }
  ]
}

【字段规则】
1. qno：题号数字形态（含 "2-17" 章-题号形态）；文字中确无题号则 null。
2. questionType 只能取：单选 / 多选 / 填空 / 解答 / 判断。
3. stemMarkdown：整理为通顺 Markdown；行内公式 $...$，独立公式 $$...$$。OCR 噪声在不改变题意的前提下修复，公式残缺处按物理/数学惯例补全；原文中的插图描述（如"如图所示"）保留文字，不虚构 [图N] 以外的图形内容。
4. options：有选项的题**必须**给 [{"label":"A","content":"…"},…]，选项文字一律进该数组，题干里不保留 "A．… B．…" 选项行；无选项为 null。
5. answerMarkdown / analysisMarkdown：只整理文字中实际存在的答案/解析；没有就是 null，绝不自行作答。
6. suggestedTags：3~8 个知识点标签（自由词、中文、简短）。
7. 输入含多题时 questions 按原顺序全部输出。`;

/** OCR 转写腿提示词（`transcribe_only.md` 逐字移植；降级档腿 1，免费 OCR 模型，1~3s） */
export const ONESTEP_TRANSCRIBE_PROMPT =
  '请把图片中的全部内容逐字转写为 Markdown：文字照抄、公式用 LaTeX、保留原有换行与分段。\n\n要求：只做转写，不做任何结构化、不判断题目边界、不总结、不解释、不要 JSON、不要标题层级之外的任何加工。';

/**
 * 0069（R-075，只增）：**答案/解析整图靶**的转写提示词——既有中文通用转写口径 + 一条「图占位」要求。
 *
 * 为什么必须补这一条（改前实测 = 读提示词文本即可确认）：既有转写口径只说「文字照抄、公式用 LaTeX」，
 * 真配图（几何图形/函数图像/电路图）在图里既不是文字也不是公式 → 转写腿对它的产出是**空**，
 * 结构化腿便无从知道「这里原本有一张图」，抠出的配图也就没有落点。故要求转写腿在原位置留 `[图N]`
 * 占位符（编号与录题侧题面同口径：整张图内按阅读顺序，从 1 起）。公式**不写占位符**（转写腿直接给 LaTeX）。
 *
 * 只增不改：既有的 `ONESTEP_TRANSCRIBE_PROMPT`（录题/公式链在用）一字未动，本常量由它派生。
 */
export const AI_CLEAN_ANSWER_TRANSCRIBE_PROMPT = `${ONESTEP_TRANSCRIBE_PROMPT}

补充要求（图占位）：图中的**插图**（几何图形、函数图像、电路图、受力图、光路图这类真配图）在**原位置**只写占位符 [图N]（N = 整张图内按阅读顺序的编号，从 1 开始、不重复、不漏号）；公式照常转写成 LaTeX，**公式不写占位符**。`;

/**
 * 0069（R-075，只增）：**答案/解析整图靶**的结构化腿提示词——录题侧基础提示词 + 一条图占位规则。
 *
 * 为什么结构化腿也要加：转写腿标出的 `[图N]` 要经这一腿落到 answerMarkdown/analysisMarkdown 里，
 * 否则「整理为通顺 Markdown」会把它洗干净（正文一变，抠图产物就无处可落）。编号口径与题面同源
 * （阅读序），但**答案与解析共用同一条编号轴**——整图里的图只有一条序号轴，分字段各从 1 起会撞号。
 *
 * 只增不改：既有的 `TWOSTAGE_STRUCTURE_PROMPT`（录题两段式在用）一字未动，本常量由它派生。
 */
export const AI_CLEAN_ANSWER_STRUCTURE_PROMPT = `${TWOSTAGE_STRUCTURE_PROMPT}

8. 图占位：文字记录里的 [图N]（转写腿标出的真配图占位）必须**原样保留**在它出现的位置——
   · 落在答案里就写进 answerMarkdown、落在解析里就写进 analysisMarkdown；**答案与解析共用同一条编号轴**（不要各自从 1 重新编号、不要改号、不要漏号、不要合并）；
   · 只保留输入里已有的 [图N]，绝不新增；公式照常整理成 $...$ / $$...$$（公式不用占位符）。`;

/**
 * DeepSeek-OCR grounding 双模板（`deepseek_ocr_ground.md` v4 运行口径，逐字移植）。
 * 单模板随页面内容漂移（v1 在紧凑竞赛排版退化为纯转写 0 图块；官方模板在旧样本漏检/多检图注），
 * 故**并行跑两个模板取并集**，再面积过滤 + IoU 去重（见 figures.ts）。
 */
export const DSO_GROUNDING_PROMPTS = [
  '<|ref|>image<|/ref|><|grounding|>',
  '<|grounding|>Convert the document to markdown.',
] as const;

/**
 * 图块面积下限（0-999 坐标系，`>=` 判据）：实测真图最小 2660（滑轮小图）、图注噪点 464~496，
 * 1200 为分界（demo-app 同口径，0042 §十第四轮）。
 */
export const MIN_FIGURE_AREA_999 = 1200;

/** 重叠去重阈值（IoU ≥ 此值视为同一图块，保面积大者） */
export const FIGURE_DEDUP_IOU = 0.5;

/** 一步到位提取（带/不带内联 grounding 兜底腿） */
export function buildOnestepExtractPrompt(options: { inlineGrounding: boolean }): string {
  return ONESTEP_EXTRACT_PROMPT.replace(
    '{GROUNDING}',
    options.inlineGrounding ? `\n${ONESTEP_INLINE_GROUNDING}` : '',
  );
}
