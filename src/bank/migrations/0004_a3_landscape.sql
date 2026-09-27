-- 0004-fix-2 F2-A：A3双列=横幅（用户目检 #1）——内置预设种子 config 增 orientation。
-- 依 0004-剩余施工串行指引在主工作区施工的追加迁移（version 4；0003 种子 config 无 orientation）。
-- 内置预设不可被用户改删（服务层守卫），UPDATE 按内置名定位幂等；用户预设零触碰。

UPDATE layout_presets
SET config_json = '{"version":2,"pageSize":"A3","orientation":"landscape","columns":2,"columnGapMm":8,"fontSize":12,"lineHeight":1.5,"header":{"style":"exam"}}'
WHERE is_builtin = 1 AND name = 'A3双列'
  AND config_json NOT LIKE '%"orientation"%';

UPDATE layout_presets
SET config_json = '{"version":2,"pageSize":"A4","orientation":"portrait","columns":1,"fontSize":12,"lineHeight":1.5,"header":{"style":"exam"}}'
WHERE is_builtin = 1 AND name = 'A4'
  AND config_json NOT LIKE '%"orientation"%';
