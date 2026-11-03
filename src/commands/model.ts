/**
 * 模型命令
 *
 * - /model                 查看当前模型 + 快捷切换按钮
 * - /model list（/models）  列出全部可用模型（可点击）
 * - /model <快捷名|模型> [档位]  原地切换当前会话的模型（与 Web 模型选择器同一路径，sessionId 不变）
 * - /effort [档位]          查看或切换当前模型的推理档位
 *
 * <模型> 可写 provider/model、裸 model id 或显示名（不区分大小写）；
 * 快捷名来自插件配置 modelShortcuts，优先于模型匹配。
 */
import type { ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller';
import type { CommandDeps, CategorizedCommand } from './types.js';
import type { ModelRoute } from '../model/types.js';
import type { ModelShortcut } from '../config.js';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.js';

const MODEL_USAGE = '用法: /model [快捷名|模型] [推理档位]，/model list 查看全部\n示例: /model kimi-coding/k3-256k high';
const EFFORT_USAGE = '用法: /effort [推理档位]';

interface CatalogHit {
  provider: string;
  providerName: string;
  model: ModelCatalogModel;
}

export type ModelTargetResolution =
  | { ok: true; hit: CatalogHit; route: ModelRoute }
  | { ok: false; message: string };

function norm(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hits(catalog: ModelCatalog): CatalogHit[] {
  return catalog.groups.flatMap((group) => group.models.map((model) => ({
    provider: group.id, providerName: group.name, model,
  })));
}

/** Find one catalog model by provider/model, bare id or display name. */
export function findCatalogModel(
  catalog: ModelCatalog,
  target: string,
  current?: ModelRoute,
): { hit?: CatalogHit; ambiguous?: CatalogHit[] } {
  const wanted = norm(target);
  if (!wanted) return {};
  const all = hits(catalog);
  const exact = all.find((h) => norm(`${h.provider}/${h.model.id}`) === wanted);
  if (exact) return { hit: exact };
  for (const field of [(h: CatalogHit) => h.model.id, (h: CatalogHit) => h.model.name]) {
    const found = all.filter((h) => norm(field(h)) === wanted);
    if (found.length === 1) return { hit: found[0] };
    if (found.length > 1) {
      const preferred = found.find((h) => h.provider === current?.provider);
      return preferred ? { hit: preferred } : { ambiguous: found };
    }
  }
  return {};
}

function effortIds(model: ModelCatalogModel): string[] {
  return model.reasoning?.efforts.map((e) => e.id) ?? [];
}

/** Validate an explicit effort, or carry the current one over when the new model supports it. */
export function chooseEffort(
  model: ModelCatalogModel,
  requested: string | undefined,
  current: string | undefined,
): { ok: true; effort?: string } | { ok: false; message: string } {
  const ids = effortIds(model);
  if (requested !== undefined) {
    const match = ids.find((id) => id.toLowerCase() === requested.toLowerCase());
    if (match) return { ok: true, effort: match };
    return {
      ok: false,
      message: ids.length > 0
        ? `${model.name} 不支持推理档位 "${requested}"，可选: ${ids.join(' / ')}`
        : `${model.name} 没有可调的推理档位`,
    };
  }
  if (current && ids.includes(current)) return { ok: true, effort: current };
  return { ok: true, ...(model.reasoning?.defaultEffort ? { effort: model.reasoning.defaultEffort } : {}) };
}

/** Expand a configured shortcut (case-insensitive name) into a model target and effort. */
export function expandShortcut(
  shortcuts: readonly ModelShortcut[],
  raw: string,
): { target: string; effort?: string } | undefined {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return undefined;
  const shortcut = shortcuts.find((s) => norm(s.name) === norm(words[0]!));
  if (!shortcut) return undefined;
  const effort = words[1] ?? shortcut.effort;
  return { target: shortcut.model, ...(effort ? { effort } : {}) };
}

/**
 * Parse `/model` arguments against the catalog. The whole argument is tried as
 * a model first (display names contain spaces); otherwise the last word is the effort.
 */
export function resolveModelTarget(
  catalog: ModelCatalog,
  raw: string,
  current?: ModelRoute,
  shortcuts: readonly ModelShortcut[] = [],
): ModelTargetResolution {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: false, message: MODEL_USAGE };

  const shortcut = expandShortcut(shortcuts, raw);
  if (shortcut) {
    const resolved = resolveAttempts(catalog, [shortcut], current);
    if (resolved.ok || !resolved.message.startsWith('找不到模型')) return resolved;
    return { ok: false, message: `快捷方式 "${words[0]}" 指向的模型 "${shortcut.target}" 不在可用列表中，请检查 modelShortcuts 配置` };
  }

  const attempts: Array<{ target: string; effort?: string }> = [{ target: words.join(' ') }];
  if (words.length >= 2) attempts.push({ target: words.slice(0, -1).join(' '), effort: words.at(-1) });
  const resolved = resolveAttempts(catalog, attempts, current);
  if (resolved.ok || !resolved.message.startsWith('找不到模型')) return resolved;
  return { ok: false, message: `找不到模型 "${raw.trim()}"。发送 /model list 查看可用模型。` };
}

function resolveAttempts(
  catalog: ModelCatalog,
  attempts: ReadonlyArray<{ target: string; effort?: string }>,
  current: ModelRoute | undefined,
): ModelTargetResolution {
  for (const attempt of attempts) {
    const { hit, ambiguous } = findCatalogModel(catalog, attempt.target, current);
    if (ambiguous) {
      return {
        ok: false,
        message: `"${attempt.target}" 对应多个模型，请写成 provider/model:\n${ambiguous.map((h) => `- ${h.provider}/${h.model.id}`).join('\n')}`,
      };
    }
    if (!hit) continue;
    const sameModel = current?.provider === hit.provider && current?.model === hit.model.id;
    const effort = chooseEffort(hit.model, attempt.effort, current?.reasoningEffort);
    if (!effort.ok) return effort;
    if (sameModel && attempt.effort === undefined) {
      return { ok: false, message: `当前已是 ${hit.model.name}${current?.reasoningEffort ? `（${current.reasoningEffort}）` : ''}` };
    }
    return {
      ok: true,
      hit,
      route: { provider: hit.provider, model: hit.model.id, ...(effort.effort ? { reasoningEffort: effort.effort } : {}) },
    };
  }
  return { ok: false, message: '找不到模型' };
}

/** Human-readable label for a route, preferring the catalog display name. */
export function describeRoute(catalog: ModelCatalog | undefined, route: ModelRoute | undefined): string {
  if (!route) return '宿主默认配置';
  const hit = catalog ? findCatalogModel(catalog, `${route.provider}/${route.model}`).hit : undefined;
  const name = hit ? `${hit.model.name}（${route.provider}/${route.model}）` : `${route.provider}/${route.model}`;
  return route.reasoningEffort ? `${name} · 推理 ${route.reasoningEffort}` : name;
}

function sameRoute(left: ModelRoute | undefined, right: ModelRoute | undefined): boolean {
  return !!left && !!right && left.provider === right.provider && left.model === right.model;
}

async function loadCatalog(deps: CommandDeps): Promise<ModelCatalog | { error: string }> {
  try {
    return await deps.manager.modelCatalog();
  } catch (err) {
    return { error: `模型列表获取失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function switchedReply(catalog: ModelCatalog, route: ModelRoute, busy: boolean): string {
  return [
    `✅ 已切换到 ${describeRoute(catalog, route)}`,
    busy ? '当前回复不受影响，从下一次请求开始生效；会话与上下文不变。' : '下一条消息起生效；会话与上下文不变。',
  ].join('\n');
}

/** Full catalog grouped by provider, each model a clickable switch. */
export function renderModelList(catalog: ModelCatalog, current: ModelRoute | undefined): string {
  const lines: string[] = ['### 🤖 全部模型', '', `**当前:** ${describeRoute(catalog, current)}`];
  for (const group of catalog.groups) {
    if (group.models.length === 0) continue;
    lines.push('', `**${group.name}**`);
    for (const m of group.models) {
      const mark = sameRoute(current, { provider: group.id, model: m.id }) ? ' ✓' : '';
      lines.push(`<qqbot-cmd-input text="/model ${group.id}/${m.id}" show="${m.name}${mark}"/>`);
    }
  }
  for (const failure of catalog.failures) lines.push('', `⚠️ ${failure.name}: ${failure.message}`);
  lines.push('', '手动指定: `/model 模型 [推理档位]`，只改档位: `/effort 档位`');
  return lines.join('\n');
}

/** Current model plus the configured shortcuts as one-tap switches. */
export function renderModelOverview(
  catalog: ModelCatalog,
  current: ModelRoute | undefined,
  shortcuts: readonly ModelShortcut[],
): string {
  const lines: string[] = ['### 🤖 模型', '', `**当前:** ${describeRoute(catalog, current)}`];
  if (shortcuts.length > 0) {
    lines.push('', '**快捷切换:**');
    for (const shortcut of shortcuts) {
      const resolved = resolveModelTarget(catalog, shortcut.name, undefined, shortcuts);
      if (!resolved.ok) {
        lines.push(`⚠️ ${shortcut.name} → ${shortcut.model}（不可用）`);
        continue;
      }
      const { route, hit } = resolved;
      const active = sameRoute(current, route)
        && (route.reasoningEffort === undefined || route.reasoningEffort === current?.reasoningEffort);
      const effort = route.reasoningEffort ? ` · ${route.reasoningEffort}` : '';
      lines.push(`<qqbot-cmd-input text="/model ${shortcut.name}" show="${shortcut.name}: ${hit.model.name}${effort}${active ? ' ✓' : ''}"/>`);
    }
  }
  lines.push('', '<qqbot-cmd-input text="/model list" show="查看全部模型"/>');
  lines.push('', '用法: `/model 快捷名|模型 [推理档位]`，只改档位: `/effort 档位`');
  return lines.join('\n');
}

const LIST_WORDS = new Set(['list', 'ls', 'all', '列表']);

async function switchTo(
  deps: CommandDeps,
  scope: 'c2c' | 'group',
  peerId: string,
  catalog: ModelCatalog,
  route: ModelRoute,
): Promise<string> {
  const result = await deps.manager.selectModel(scope, peerId, route);
  if (!result.ok) return result.reason === 'no-session' ? '当前无活跃会话' : `切换失败: ${result.message ?? '未知错误'}`;
  return switchedReply(catalog, result.route, result.busy);
}

export function modelCommand(deps: CommandDeps): CategorizedCommand {
  const { manager, config } = deps;
  const shortcuts = config.modelShortcuts ?? [];
  return {
    name: 'model',
    category: 'agent',
    description: '查看或原地切换模型（/model list 全部模型，/model 快捷名|模型 [档位] 切换）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();

      // Slash commands bypass inbound: restore the peer's session first so the
      // current model shown and switched is the session's own, not a default.
      await manager.getOrCreate(scope, peerId, cmdCtx.message.senderId, cmdCtx.replyTarget);
      const current = manager.getEffectiveModel(scope, peerId);
      const catalog = await loadCatalog(deps);
      if ('error' in catalog) return catalog.error;

      if (!args || LIST_WORDS.has(args.toLowerCase())) {
        const text = args || shortcuts.length === 0
          ? renderModelList(catalog, current)
          : renderModelOverview(catalog, current, shortcuts);
        await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      const resolved = resolveModelTarget(catalog, args, current, shortcuts);
      if (!resolved.ok) return resolved.message;
      return switchTo(deps, scope, peerId, catalog, resolved.route);
    },
  };
}

/** /models — alias for `/model list`. */
export function modelsCommand(deps: CommandDeps): CategorizedCommand {
  const { manager, config } = deps;
  return {
    name: 'models',
    category: 'agent',
    description: '列出全部可用模型（可点击切换）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      await manager.getOrCreate(scope, peerId, cmdCtx.message.senderId, cmdCtx.replyTarget);
      const catalog = await loadCatalog(deps);
      if ('error' in catalog) return catalog.error;
      await sendMarkdownChunked(cmdCtx, renderModelList(catalog, manager.getEffectiveModel(scope, peerId)), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

export function effortCommand(deps: CommandDeps): CategorizedCommand {
  const { manager } = deps;
  return {
    name: 'effort',
    category: 'agent',
    description: '查看或切换当前模型的推理档位（用法: /effort [档位]）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();
      if (args.includes(' ')) return EFFORT_USAGE;

      await manager.getOrCreate(scope, peerId, cmdCtx.message.senderId, cmdCtx.replyTarget);
      const current = manager.getEffectiveModel(scope, peerId);
      if (!current) return '当前会话还没有模型，请先用 /model 选择';
      const catalog = await loadCatalog(deps);
      if ('error' in catalog) return catalog.error;
      const hit = findCatalogModel(catalog, `${current.provider}/${current.model}`).hit;
      if (!hit) return `当前模型 ${current.provider}/${current.model} 不在可用列表中，请先用 /model 切换`;
      const ids = effortIds(hit.model);

      if (!args) {
        if (ids.length === 0) return `${hit.model.name} 没有可调的推理档位`;
        await sendMarkdownChunked(cmdCtx, [
          `**当前:** ${describeRoute(catalog, current)}`,
          '',
          '**可选档位（点击切换）:**',
          ...ids.map((id) => `<qqbot-cmd-input text="/effort ${id}" show="${id}${id === current.reasoningEffort ? ' ✓' : ''}"/>`),
        ].join('\n'), deps.config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      const effort = chooseEffort(hit.model, args, current.reasoningEffort);
      if (!effort.ok) return effort.message;
      if (effort.effort === current.reasoningEffort) return `当前已是推理 ${effort.effort}`;
      return switchTo(deps, scope, peerId, catalog, {
        provider: current.provider, model: current.model, ...(effort.effort ? { reasoningEffort: effort.effort } : {}),
      });
    },
  };
}
