-- 0023 P1：模型档案表（五角色 + Key 托管 + 测连通状态）
-- 0023 任务书 §一 P1.1；决策锚点 D-043/D-044/D-045
-- key_encrypted：safeStorage（Win=DPAPI）密文 base64（回退形态带 mkey: 前缀，见 shell 托管层）；
-- NULL=未配置；**永不以明文出现**，service 层剥离（list/get 只回 hasKey）。

CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('reasoning','vision','light','embedding','specialty')),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'openai-chat',
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  key_encrypted TEXT,                -- safeStorage 密文 base64；NULL=未配置；永不以明文出现
  capability TEXT,                   -- JSON，如 {"vision":true}
  is_enabled INTEGER NOT NULL DEFAULT 0,
  last_test_at TEXT,
  last_test_ok INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 角色维度查询（listProfiles 过滤 / getEnabledProfile / 启用排他 UPDATE）走索引
CREATE INDEX idx_model_profiles_role ON model_profiles(role);
