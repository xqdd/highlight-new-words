import type { SourceProviderInfo } from './types';

/**
 * 已知来源的静态描述（任何上下文可用，UI 用于展示名称/能力/登录入口）。
 * 网络实现见 src/background/sources/，两边 id 必须一致；新增来源在两处各登记一项，
 * 并在 settings 默认值（createDefaultSettings 的 sources）中补一项默认配置。
 */
export const YOUDAO_PROVIDER_ID = 'youdao';
export const EUDIC_PROVIDER_ID = 'eudic';

export const SOURCE_PROVIDER_INFOS: readonly SourceProviderInfo[] = [
  {
    id: YOUDAO_PROVIDER_ID,
    name: '有道词典',
    // 多生词本：webapi/books 列出各分组（含默认“无标签” bookId=0），按 bookId 拉取（2026-10 调试账号实测）
    // 加词接口 webapi/v2/ajax/add 只能加入默认分组“无标签”（bookId=0），所以只有该分组 canAdd
    capabilities: {
      delete: true,
      multiBook: true,
      requiresCookie: true,
      apiToken: false,
      canAdd: true,
      knownBooks: false,
      notes: ['加词只能加入默认分组“无标签”，其他分组只能删除', '有道没有“已掌握”分组，熟词只保存在本地熟词本'],
    },
    loginUrl: 'https://dict.youdao.com/wordbook/wordlist',
  },
  {
    id: EUDIC_PROVIDER_ID,
    name: '欧路词典',
    // 多生词本：配置 OpenAPI token 时按分类列出；仅 cookie 时退化为“全部生词”一本（见 background/sources/eudic.ts）
    // OpenAPI token 模式：各分类可加/删；“已掌握单词”作为只读的来源熟词本（OpenAPI 没有写入已掌握的接口）
    capabilities: {
      delete: true,
      multiBook: true,
      requiresCookie: true,
      apiToken: true,
      canAdd: true,
      knownBooks: true,
      notes: [
        '配置 OpenAPI 授权后可按分类同步、加词、删词，并同步“已掌握单词”作为熟词本（只读）',
        '未配置授权时用网页登录（cookie）只能同步“全部生词”一本，不能加词，删除会从全部分类中移除',
      ],
    },
    loginUrl: 'https://my.eudic.net/studylist',
    tokenUrl: 'https://my.eudic.net/OpenAPI/Authorization',
  },
];

export function getProviderInfo(id: string): SourceProviderInfo | undefined {
  return SOURCE_PROVIDER_INFOS.find((p) => p.id === id);
}

/**
 * 旧数据迁移时各来源对应的远端生词本 id：
 * - 有道只有一本，固定 'default'
 * - 欧路旧版用 cookie 接口拉取“全部生词”（WordsDataSource 不带分类），对应 cookie 模式的 '-1'（全部）
 */
export const LEGACY_REMOTE_BOOK_ID: Record<string, string> = {
  [YOUDAO_PROVIDER_ID]: 'default',
  [EUDIC_PROVIDER_ID]: '-1',
};
