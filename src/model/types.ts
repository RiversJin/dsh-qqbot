/**
 * 模型路由层类型定义
 */

/** 模型路由 */
export interface ModelRoute {
  provider: string;
  model: string;
  /** Adapter-owned reasoning level selected for the session, when explicit. */
  reasoningEffort?: string;
}

/** 模型信息条目 */
export interface ModelEntry {
  provider: string;
  id: string;
  name?: string;
}
