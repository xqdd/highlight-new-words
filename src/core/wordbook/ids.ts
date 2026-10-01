/**
 * 词书 id 规则（三类词书共用一个命名空间，settings.books.enabled 中可任意组合）：
 *
 * | 类别 | 格式 | 示例 |
 * | --- | --- | --- |
 * | 内置分级词书 builtin | catalog 中的 id（不含冒号） | `cet6` |
 * | 来源词书 source（远端生词本的本地镜像） | `src:<providerId>:<encodeURIComponent(remoteId)>` | `src:eudic:0`、`src:youdao:default` |
 * | 本地导入词书 local | `local:<uuid>` | `local:3f2a…` |
 *
 * remoteId 由 provider 定义（如欧路生词本分类 id），编码后不含冒号，保证 id 可以按冒号无歧义拆分。
 */
import type { BookId } from '../settings/schema';

export type BookKind = 'builtin' | 'source' | 'local';

export type ParsedBookId =
  | { kind: 'builtin'; id: BookId }
  | { kind: 'source'; id: BookId; providerId: string; remoteId: string }
  | { kind: 'local'; id: BookId; uuid: string };

export const SOURCE_BOOK_PREFIX = 'src:';
export const LOCAL_BOOK_PREFIX = 'local:';

export function sourceBookId(providerId: string, remoteId: string): BookId {
  return `${SOURCE_BOOK_PREFIX}${providerId}:${encodeURIComponent(remoteId)}`;
}

/** 新建本地词书 id；uuid 可传入（测试/覆盖导入时复用），默认 crypto.randomUUID() */
export function localBookId(uuid: string = crypto.randomUUID()): BookId {
  return `${LOCAL_BOOK_PREFIX}${uuid}`;
}

export function parseBookId(id: BookId): ParsedBookId {
  if (id.startsWith(SOURCE_BOOK_PREFIX)) {
    const rest = id.slice(SOURCE_BOOK_PREFIX.length);
    const sep = rest.indexOf(':');
    return { kind: 'source', id, providerId: rest.slice(0, sep), remoteId: decodeURIComponent(rest.slice(sep + 1)) };
  }
  if (id.startsWith(LOCAL_BOOK_PREFIX)) return { kind: 'local', id, uuid: id.slice(LOCAL_BOOK_PREFIX.length) };
  return { kind: 'builtin', id };
}

export function bookKindOf(id: BookId): BookKind {
  return parseBookId(id).kind;
}
