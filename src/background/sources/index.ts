import type { SourceProvider } from '@/core/source/types';
import { eudicProvider } from './eudic';
import { youdaoProvider } from './youdao';

/**
 * 来源 provider 注册表（background 专用）。
 * 新增来源：实现 SourceProvider（id 与 core/source/providers.ts 中的静态描述一致）并加入此列表。
 */
const PROVIDERS: SourceProvider[] = [youdaoProvider, eudicProvider];

export function getSourceProvider(id: string): SourceProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function listSourceProviders(): readonly SourceProvider[] {
  return PROVIDERS;
}
