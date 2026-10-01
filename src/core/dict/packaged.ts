import { browser } from 'wxt/browser';
import {
  dictShardOf,
  type DictEntry,
  type DictForm,
  type DictFormType,
  type Dictionary,
  type DictShardFile,
  type PackedDictEntry,
} from './types';

/** 读取扩展包内资源（内容脚本中依赖 web_accessible_resources 声明 data/*） */
export async function fetchPackagedJson<T>(path: string): Promise<T> {
  // getURL 的参数类型由 WXT 按 public 目录生成，这里是运行时拼接的路径，需要断言
  const url = browser.runtime.getURL(path as '/');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载扩展资源失败: ${path} ${res.status}`);
  return (await res.json()) as T;
}

const FORM_TYPES = new Set<string>(['p', 'd', 'i', '3', 's', 'r', 't']);

/** 解析 ECDICT exchange 子集 "s:widths/p:went,goed" 为词形列表 */
export function parseForms(x: string | undefined): DictForm[] | undefined {
  if (!x) return undefined;
  const out: DictForm[] = [];
  for (const part of x.split('/')) {
    const idx = part.indexOf(':');
    const type = part.slice(0, idx);
    if (!FORM_TYPES.has(type)) continue;
    for (const word of part.slice(idx + 1).split(',')) if (word) out.push({ type: type as DictFormType, word });
  }
  return out.length ? out : undefined;
}

/** 打包条目转 DictEntry；full 为全表条目（批量查询不加载全表时为空） */
export function unpackDictEntry(word: string, e: PackedDictEntry, full?: PackedDictEntry): DictEntry {
  const f = full?.f ?? e.f;
  return {
    word,
    phonetic: e.p,
    short: e.s,
    shortVerb: e.v,
    full: f ?? e.s,
    tags: e.g ? e.g.split(' ') : undefined,
    level: e.l,
    rank: e.r,
    forms: parseForms(full?.x ?? e.x),
  };
}

/**
 * 基于打包分片文件的词典，两层懒加载并缓存：
 * - 短表 data/dict/<shard>.json：lookupMany 只读这一层（整页行内翻译，体积约为全表的一半）
 * - 全表 data/dict/full/<shard>.json：lookup（卡片）时再加载，补齐完整释义与词形
 * 分片缺失时视为空（不抛错），保证数据未就绪时扩展仍可运行。
 */
export class PackagedDictionary implements Dictionary {
  private shards = new Map<string, Promise<DictShardFile>>();

  constructor(private readonly load: (path: string) => Promise<DictShardFile> = (p) => fetchPackagedJson<DictShardFile>(`data/dict/${p}.json`)) {}

  /** name 为 'a' 或 'full/a' */
  private shard(name: string): Promise<DictShardFile> {
    let p = this.shards.get(name);
    if (!p) {
      p = this.load(name).catch(() => ({}));
      this.shards.set(name, p);
    }
    return p;
  }

  async lookup(word: string): Promise<DictEntry | undefined> {
    const w = word.toLowerCase();
    const s = dictShardOf(w);
    const [short, full] = await Promise.all([this.shard(s), this.shard(`full/${s}`)]);
    const e = short[w];
    return e ? unpackDictEntry(w, e, full[w]) : undefined;
  }

  async lookupMany(words: Iterable<string>): Promise<Map<string, DictEntry>> {
    const out = new Map<string, DictEntry>();
    const byShard = new Map<string, string[]>();
    for (const raw of words) {
      const w = raw.toLowerCase();
      const s = dictShardOf(w);
      const list = byShard.get(s);
      if (list) list.push(w);
      else byShard.set(s, [w]);
    }
    await Promise.all(
      [...byShard].map(async ([s, list]) => {
        const data = await this.shard(s);
        for (const w of list) {
          const e = data[w];
          if (e) out.set(w, unpackDictEntry(w, e));
        }
      }),
    );
    return out;
  }
}

/**
 * 组合词典：按顺序查询，前者优先（如 云端生词本自带释义 > 打包词典）。
 * 同一词多个来源时字段逐项补齐。
 */
export class CompositeDictionary implements Dictionary {
  constructor(private readonly sources: Dictionary[]) {}

  /** 单词完整查询：逐个来源调用 lookup（打包词典需要加载全表才有完整释义/词形） */
  async lookup(word: string): Promise<DictEntry | undefined> {
    const results = await Promise.all(this.sources.map((s) => s.lookup(word)));
    let out: DictEntry | undefined;
    for (const e of results) if (e) out = out ? mergeEntry(out, e) : e;
    return out;
  }

  async lookupMany(words: Iterable<string>): Promise<Map<string, DictEntry>> {
    const list = [...words];
    const results = await Promise.all(this.sources.map((s) => s.lookupMany(list)));
    const out = new Map<string, DictEntry>();
    for (const map of results) {
      for (const [w, e] of map) {
        const prev = out.get(w);
        out.set(w, prev ? mergeEntry(prev, e) : e);
      }
    }
    return out;
  }
}

/**
 * 合并同一词的两个来源：prev 优先，later 只补齐缺失字段。
 * 前者已给出 short（用户词书自带释义）时不再补后者的 shortVerb，避免行内翻译在用户释义与打包动词释义之间来回切换
 */
function mergeEntry(prev: DictEntry, later: DictEntry): DictEntry {
  const merged = { ...later, ...stripUndefined(prev) };
  if (prev.short !== undefined && prev.shortVerb === undefined) delete merged.shortVerb;
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
