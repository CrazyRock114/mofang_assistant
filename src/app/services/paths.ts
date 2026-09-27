// D1 P0/P3: renderer 侧 userData 资产根只读取 accessor（Phase 0 __mofangPaths 通道的唯一消费入口）

export function getUserDataAssetsRoot(): string | null {
  if (typeof window === 'undefined') return null;
  return window.__mofangPaths?.userDataAssets ?? null;
}
