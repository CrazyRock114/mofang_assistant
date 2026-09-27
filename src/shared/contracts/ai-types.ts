// 0023: AI 模型配置契约（五角色档案 + 测连通 + ai.* 通道 payload）
// 本文件为 0023 独占新建契约（任务书锚点；0024/0025 不改动本文件）。
// 红线（D-043「Key 三不进」）：key_encrypted 密文不出 service 层——list/get 永不返回，
// 只回 hasKey 布尔；明文 Key 仅在「创建/更新瞬间」经主进程托管层加密后即弃。

/** 五角色（P-14）：推理 / 视觉 / 轻量 / 向量 / 专用 */
export const MODEL_ROLES = ['reasoning', 'vision', 'light', 'embedding', 'specialty'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** 一期唯一实装协议；R5 允许以其他协议值建档（配置位），invoke 遇到即明确报错（不静默） */
export const PROTOCOL_OPENAI_CHAT = 'openai-chat';

/** capability JSON 结构，如 {"vision":true}；null=未声明 */
export interface ModelCapability {
  vision?: boolean;
}

/**
 * 模型档案（对外形态）——**永不包含 key_encrypted**（D-043 红线，service 层即剥离）。
 */
export interface ModelProfile {
  id: string;
  role: ModelRole;
  name: string;
  provider: string;
  protocol: string;
  baseUrl: string;
  model: string;
  capability: ModelCapability | null;
  isEnabled: boolean;
  /** 是否已配置 Key（真实密文存 bank 列 key_encrypted，经主进程托管层加解密） */
  hasKey: boolean;
  /** 测连通：null=未测过；P-18 未通过测试的档案禁止启用（UI 置灰 + service 双保险） */
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 建档入参（service 层形态）。
 * keyEncrypted = 主进程托管层（safeStorage / 机器密钥回退）加密后的**不透明密文串**；
 * service 原样存取、永不返回。bank/mock 两实现均不解释其内容（对 service 透明，任务书 P2.1）。
 */
export interface ModelProfileInput {
  role: ModelRole;
  name: string;
  provider: string;
  /** 缺省 'openai-chat' */
  protocol?: string;
  baseUrl: string;
  model: string;
  capability?: ModelCapability | null;
  keyEncrypted?: string | null;
}

/** 更新入参：undefined=保持不变；keyEncrypted 显式 null=清除 Key */
export interface ModelProfileUpdate {
  name?: string;
  provider?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
  capability?: ModelCapability | null;
  keyEncrypted?: string | null;
}

export interface ModelProfileListFilter {
  role?: ModelRole;
}

/**
 * 模型档案 service（bank 真实 SQLite + mock 内存契约测试双跑同绿，D-005 铁律）。
 */
export interface ModelProfileService {
  createProfile(data: ModelProfileInput): Promise<ModelProfile>;
  getProfile(id: string): Promise<ModelProfile | null>;
  listProfiles(filter?: ModelProfileListFilter): Promise<ModelProfile[]>;
  updateProfile(id: string, data: ModelProfileUpdate): Promise<ModelProfile>;
  /** 硬删（无软删列）；删除启用中的档案后该角色自然回未配置态 */
  deleteProfile(id: string): Promise<void>;
  /**
   * 启用守卫（任务书 P1.2）：同 role 至多一条 is_enabled=1——启用动作在事务内排他
   *（同角色其余档案自动停用）；允许某角色 0 条启用=未配置态。
   * P-18 双保险：lastTestOk !== true 的档案拒绝启用。
   */
  setProfileEnabled(id: string, enabled: boolean): Promise<ModelProfile>;
  /** 测连通结果回写（last_test_at/last_test_ok；不改 updated_at——档案内容未变） */
  recordTestResult(id: string, ok: boolean, testedAt: string): Promise<void>;
  /** 该角色当前启用中的档案；未配置态 → null */
  getEnabledProfile(role: ModelRole): Promise<ModelProfile | null>;
  /**
   * 主进程代理内部取密文用（解密在托管层；密文仅存主进程内存，**不经任何 IPC 返回 renderer**，
   * 不出现在 list/get 返回值中）。仅 shell 网关消费，renderer 桥不暴露此方法。
   */
  getKeyEncrypted(id: string): Promise<string | null>;
}

// ==================== ai.invoke：OpenAI 兼容 chat/completions 通用代理 ====================

export type AiChatRole = 'system' | 'user' | 'assistant';

/** 消息内容分片：文本 / 图片（vision 消息形态；url 可为 http(s) 或 data URL） */
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string } };

export interface AiChatMessage {
  role: AiChatRole;
  content: string | AiContentPart[];
}

/**
 * 通用代理入参：按 role 解析**该角色启用中的档案**（缺档案即明确报错——三分支校验之一），
 * 取其 base_url/model/解密 Key 发起 OpenAI 兼容请求。
 */
export interface AiInvokePayload {
  /** 必填；缺省/非法 = payload 校验失败（IPC 拒绝） */
  role: ModelRole;
  messages: AiChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 单次尝试超时（毫秒），缺省 30000 */
  timeoutMs?: number;
  /** 网络错误/超时/5xx/429 的有限重试次数，缺省 0，上限 2 */
  retries?: number;
  /**
   * 0040（只增）：思考开关（外源思考模型实测项，deepseek-flash/mimo 接受 `{"thinking":{"type":…}}`）。
   * 'disabled' = 关闭思考（整页样本实测烧 13k 推理 token 且预算下截断为空，必须能关）；
   * 'enabled' = 显式开启；缺省 = 不发送该字段，走供应商默认。
   * 网关透传；供应商不识别该参数时按「降级不报错」处理（见 ai-gateway 的省略重试）。
   */
  thinking?: 'enabled' | 'disabled';
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiInvokeSuccess {
  ok: true;
  content: string;
  latencyMs: number;
  usage?: AiUsage;
}

/** 失败是结果不是异常：网络/HTTP 错误经此形态返回；错误信息保证不含 Key（构造注入测试钉死） */
export interface AiInvokeFailure {
  ok: false;
  error: string;
  latencyMs: number;
}

export type AiInvokeResult = AiInvokeSuccess | AiInvokeFailure;

// ==================== ai.* 通道 payload（ipc-channels.ts 只增引用） ====================

/** renderer 建档入参：apiKey 明文仅存在于此 payload → 主进程加密即弃（P2.1 Key 写入流） */
export interface AiProfileInput {
  role: ModelRole;
  name: string;
  provider: string;
  protocol?: string;
  baseUrl: string;
  model: string;
  capability?: ModelCapability | null;
  /** 明文 Key；缺省=暂不配置 */
  apiKey?: string;
}

/** renderer 更新入参：apiKey 缺省（undefined）=不换 Key（编辑留空语义） */
export interface AiProfileUpdateInput {
  name?: string;
  provider?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
  capability?: ModelCapability | null;
  apiKey?: string;
}

export interface AiProfileCreatePayload {
  data: AiProfileInput;
}

export interface AiProfileUpdatePayload {
  id: string;
  data: AiProfileUpdateInput;
}

export interface AiProfileIdPayload {
  id: string;
}

export interface AiProfileSetEnabledPayload {
  id: string;
  enabled: boolean;
}

export interface AiProfileListPayload {
  filter?: ModelProfileListFilter;
}

export interface AiProfileTestConnectionPayload {
  profileId: string;
}

/** 测连通结果：文本角色发短请求；视觉角色必发随包小图（任务书 P2.2） */
export interface AiTestConnectionResult {
  ok: boolean;
  latencyMs: number | null;
  /** 失败原因（已脱敏，不含 Key） */
  error?: string;
  /** 成功时模型回复摘要（截断展示用） */
  reply?: string;
}

// ==================== 0023 目检返工 R3（只增）：获取模型列表 ====================

/**
 * 拉取 OpenAI 兼容 GET {base_url}/models 列表。
 * 两种形态：① 传 profileId（编辑态）——取档案 baseUrl + 解密存量 Key（apiKey 留空回落存量，与
 * 「不换 Key」语义衔接）；② 直传 baseUrl + apiKey（新建表单态，档案尚未落库）。
 * 明文 Key 仅此一瞬用于请求，不落库（D-043 同纪律）。
 */
export interface AiModelsListPayload {
  profileId?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 失败是结果不是异常：HTTP/网络错误经 ok:false + 已脱敏 error 返回 */
export interface AiModelsListResult {
  ok: boolean;
  /** 模型 id 列表（OpenAI 兼容 /models 返回的 data[].id） */
  models: string[];
  error?: string;
}
