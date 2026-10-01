import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectImportFormat, parseWordList } from '@/core/import/parse';

/** 手动导入解析器健壮性（熟词本导入与本地词书导入共用） */
describe('导入解析健壮性', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('TXT：去掉行首序号，识别 [音标]、/音标/ 与中英文冒号分隔', () => {
    const text = '1. abandon\n2) run\tv. 跑\n3、study v. 学习\n4 apple [ˈæpl] n. 苹果\nbanana /bəˈnɑːnə/ n. 香蕉\ncherry：n. 樱桃\n';
    const r = parseWordList({ text });
    expect(r.words).toEqual([
      { word: 'abandon' },
      { word: 'run', trans: 'v. 跑' },
      { word: 'study', trans: 'v. 学习' },
      { word: 'apple', phonetic: '[ˈæpl]', trans: 'n. 苹果' },
      { word: 'banana', phonetic: '/bəˈnɑːnə/', trans: 'n. 香蕉' },
      { word: 'cherry', trans: 'n. 樱桃' },
    ]);
    // 只有末尾空行计入 skipped，没有警告
    expect(r.skipped).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('TXT：CR 换行、带变音符的拉丁词保留，中文/数字行跳过并给出警告', () => {
    const r = parseWordList({ text: 'café\rnaïve\r中文\r12345\r' });
    expect(r.words.map((w) => w.word)).toEqual(['café', 'naïve']);
    // 两行非英文 + 末尾空行
    expect(r.skipped).toBe(3);
    expect(r.warnings).toHaveLength(2);
  });

  it('CSV：自动识别分号分隔（Excel 区域设置）与 序号 列', () => {
    const r = parseWordList({ text: '序号;单词;音标;释义\n1;apple;/ˈæpl/;n. 苹果\n2;run;;v. 跑\n', fileName: 'words.csv' });
    expect(r.words).toEqual([
      { word: 'apple', phonetic: '/ˈæpl/', trans: 'n. 苹果' },
      { word: 'run', trans: 'v. 跑' },
    ]);
  });

  it('CSV：表头后数据行列数不足、空行与重复词（后者覆盖）', () => {
    const r = parseWordList({ text: 'word,translation\napple\n\nApple,n. 苹果\n', fileName: 'a.csv' });
    expect(r.words).toEqual([{ word: 'Apple', trans: 'n. 苹果' }]);
  });

  it('有道 XML：没有 DOMParser（service worker）或 XML 不规范（裸 &）时退回正则解析', () => {
    const text = readFileSync('tests/fixtures/exampleNewWords.xml', 'utf8');
    const withDom = parseWordList({ text, fileName: 'a.xml' });
    vi.stubGlobal('DOMParser', undefined);
    const noDom = parseWordList({ text, fileName: 'a.xml' });
    expect(noDom.words).toEqual(withDom.words);
    vi.unstubAllGlobals();
    const broken = '<wordbook><item><word>R&D</word><trans>研发 & 开发</trans></item><item><word>apple</word><trans><![CDATA[n. 苹果 & 树]]></trans><phonetic><![CDATA[[ˈæpl]]]></phonetic></item></wordbook>';
    const r = parseWordList({ text: broken, fileName: 'b.xml' });
    expect(r.words.find((w) => w.word === 'apple')).toEqual({ word: 'apple', trans: 'n. 苹果 & 树', phonetic: '[ˈæpl]' });
  });

  it('Anki：去掉 [sound:] 与 HTML、跳过 #columns 行、notetype/deck 元数据列', () => {
    const text = '#separator:Tab\n#html:true\n#columns:Front\tBack\n#notetype column:1\n#deck column:2\nBasic\tMy Deck\tapple[sound:apple.mp3]\t<div>n. 苹果&nbsp;</div>\n';
    expect(detectImportFormat(text, 'x.txt')).toBe('anki');
    expect(parseWordList({ text }).words).toEqual([{ word: 'apple', trans: 'n. 苹果' }]);
  });

  it('欧路导出：按表头列名，分隔符按首行猜测', () => {
    const r = parseWordList({ text: '单词\t音标\t解释\nabandon\t/əˈbændən/\tv. 放弃\n', format: 'eudic' });
    expect(r.words).toEqual([{ word: 'abandon', phonetic: '/əˈbændən/', trans: 'v. 放弃' }]);
  });

  it('大文件：5 万行在 1 秒内解析完成', () => {
    const text = Array.from({ length: 50000 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i.toString(36).replace(/\d/g, 'x')},n. 释义${i}`).join('\n');
    const t = performance.now();
    const r = parseWordList({ text, fileName: 'big.csv' });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.words.length).toBeGreaterThan(1000);
  });
});
