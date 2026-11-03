import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller';
import { chooseEffort, describeRoute, expandShortcut, findCatalogModel, renderModelList, renderModelOverview, resolveModelTarget } from './model.js';

const efforts = (...ids: string[]) => ids.map((id) => ({ id, name: id }));
const catalog = {
  default: { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' },
  routableProviders: ['deepseek-official', 'kimi-coding', 'cpa-aistudio', 'cpa-vertex'],
  failures: [],
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: efforts('off', 'low', 'high', 'max'), defaultEffort: 'high' } },
    ] },
    { id: 'kimi-coding', name: 'kimi-coding', models: [
      { id: 'k3', name: 'Kimi K3', reasoning: { efforts: efforts('low', 'high', 'max') } },
      { id: 'k3-256k', name: 'Kimi K3-256K', reasoning: { efforts: efforts('low', 'high', 'max') } },
    ] },
    { id: 'cpa-aistudio', name: 'AI Studio', models: [
      { id: 'aistudio/gemini-4-argon', name: 'Gemini 4 Argon', reasoning: { efforts: efforts('low', 'medium', 'high') } },
    ] },
    { id: 'cpa-vertex', name: 'Vertex', models: [
      { id: 'vertex/gemini-4-argon', name: 'Gemini 4 Argon', reasoning: { efforts: efforts('low', 'medium', 'high') } },
      { id: 'plain', name: 'Plain' },
    ] },
  ],
} as unknown as ModelCatalog;
const k3 = { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'high' };

describe('/model target resolution', () => {
  it('matches provider/model, bare ids containing slashes, and display names', () => {
    expect(findCatalogModel(catalog, 'kimi-coding/k3-256k').hit?.model.id).toBe('k3-256k');
    expect(findCatalogModel(catalog, 'K3-256K').hit?.provider).toBe('kimi-coding');
    expect(findCatalogModel(catalog, 'aistudio/gemini-4-argon').hit?.provider).toBe('cpa-aistudio');
    expect(findCatalogModel(catalog, 'cpa-vertex/vertex/gemini-4-argon').hit?.provider).toBe('cpa-vertex');
    expect(findCatalogModel(catalog, 'kimi  k3').hit?.model.id).toBe('k3');
  });

  it('reports ambiguous display names unless the current provider disambiguates', () => {
    expect(resolveModelTarget(catalog, 'gemini 4 argon', k3)).toMatchObject({ ok: false, message: expect.stringContaining('cpa-vertex/vertex/gemini-4-argon') });
    expect(resolveModelTarget(catalog, 'gemini 4 argon', { provider: 'cpa-vertex', model: 'plain' }))
      .toMatchObject({ ok: true, route: { provider: 'cpa-vertex', model: 'vertex/gemini-4-argon' } });
  });

  it('takes a trailing effort, carries a supported effort over, and falls back to the model default', () => {
    expect(resolveModelTarget(catalog, 'Kimi K3-256K max', k3)).toEqual({
      ok: true, hit: expect.anything(), route: { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'max' },
    });
    expect(resolveModelTarget(catalog, 'k3-256k', k3)).toMatchObject({ ok: true, route: { reasoningEffort: 'high' } });
    expect(resolveModelTarget(catalog, 'deepseek-flash', { ...k3, reasoningEffort: 'medium' }))
      .toMatchObject({ ok: true, route: { model: 'deepseek-flash', reasoningEffort: 'high' } });
    expect(resolveModelTarget(catalog, 'cpa-vertex/plain', k3)).toMatchObject({ ok: true, route: { provider: 'cpa-vertex', model: 'plain' } });
    expect(resolveModelTarget(catalog, 'cpa-vertex/plain', k3).ok && resolveModelTarget(catalog, 'cpa-vertex/plain', k3)).not.toHaveProperty('route.reasoningEffort');
  });

  it('rejects unsupported efforts, unknown models and no-op switches', () => {
    expect(resolveModelTarget(catalog, 'k3 off', k3)).toMatchObject({ ok: false, message: expect.stringContaining('low / high / max') });
    expect(resolveModelTarget(catalog, 'gpt-9', k3)).toMatchObject({ ok: false, message: expect.stringContaining('找不到模型') });
    expect(resolveModelTarget(catalog, 'k3', k3)).toMatchObject({ ok: false, message: expect.stringContaining('当前已是') });
    expect(resolveModelTarget(catalog, 'k3 max', k3)).toMatchObject({ ok: true, route: { reasoningEffort: 'max' } });
  });

  it('validates efforts case-insensitively and describes routes', () => {
    const model = catalog.groups[1]!.models[0]!;
    expect(chooseEffort(model, 'MAX', undefined)).toEqual({ ok: true, effort: 'max' });
    expect(chooseEffort(model, undefined, 'medium')).toEqual({ ok: true });
    expect(describeRoute(catalog, k3)).toBe('Kimi K3（kimi-coding/k3） · 推理 high');
    expect(describeRoute(catalog, undefined)).toBe('宿主默认配置');
  });
});

const shortcuts = [
  { name: 'long', model: 'kimi-coding/k3-256k', effort: 'high' },
  { name: 'Fast', model: 'deepseek-flash', effort: 'low' },
  { name: 'argon', model: 'aistudio/gemini-4-argon' },
  { name: 'broken', model: 'gone/model' },
];

describe('/model shortcuts', () => {
  it('expands names case-insensitively, letting an explicit effort win', () => {
    expect(expandShortcut(shortcuts, 'fast')).toEqual({ target: 'deepseek-flash', effort: 'low' });
    expect(expandShortcut(shortcuts, 'FAST max')).toEqual({ target: 'deepseek-flash', effort: 'max' });
    expect(expandShortcut(shortcuts, 'argon')).toEqual({ target: 'aistudio/gemini-4-argon' });
    expect(expandShortcut(shortcuts, 'k3')).toBeUndefined();
    expect(expandShortcut(shortcuts, 'fast a b')).toBeUndefined();
  });

  it('resolves shortcuts before catalog models and reports broken targets', () => {
    expect(resolveModelTarget(catalog, 'long', k3, shortcuts)).toMatchObject({
      ok: true, route: { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' },
    });
    expect(resolveModelTarget(catalog, 'fast', k3, shortcuts)).toMatchObject({ ok: true, route: { model: 'deepseek-flash', reasoningEffort: 'low' } });
    expect(resolveModelTarget(catalog, 'argon', k3, shortcuts)).toMatchObject({ ok: true, route: { provider: 'cpa-aistudio', reasoningEffort: 'high' } });
    expect(resolveModelTarget(catalog, 'broken', k3, shortcuts)).toMatchObject({ ok: false, message: expect.stringContaining('modelShortcuts') });
    expect(resolveModelTarget(catalog, 'fast off', k3, shortcuts)).toMatchObject({ ok: true, route: { reasoningEffort: 'off' } });
    expect(resolveModelTarget(catalog, 'k3 max', k3, shortcuts)).toMatchObject({ ok: true, route: { model: 'k3', reasoningEffort: 'max' } });
    expect(resolveModelTarget(catalog, 'nope', k3, shortcuts)).toMatchObject({ ok: false, message: expect.stringContaining('/model list') });
  });

  it('renders the overview with shortcut buttons and the full list with every model', () => {
    const overview = renderModelOverview(catalog, { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' }, shortcuts);
    expect(overview).toContain('<qqbot-cmd-input text="/model long" show="long: Kimi K3-256K · high ✓"/>');
    expect(overview).toContain('<qqbot-cmd-input text="/model Fast" show="Fast: DeepSeek-V4.1-Flash · low"/>');
    expect(overview).toContain('⚠️ broken → gone/model（不可用）');
    expect(overview).toContain('text="/model list"');
    expect(overview).not.toContain('Gemini 4 Argon · ');
    const list = renderModelList(catalog, k3);
    expect(list).toContain('<qqbot-cmd-input text="/model kimi-coding/k3" show="Kimi K3 ✓"/>');
    expect(list).toContain('<qqbot-cmd-input text="/model cpa-vertex/vertex/gemini-4-argon" show="Gemini 4 Argon"/>');
  });
});
