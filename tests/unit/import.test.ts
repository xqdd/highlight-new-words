import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectImportFormat, parseDelimited, parseWordList } from '@/core/import/parse';
import { localBookId, parseBookId, sourceBookId } from '@/core/wordbook/ids';

describe('词表导入解析', () => {
  it('有道 XML（fixture）：跳过非英文词条，保留释义音标', () => {
    const text = readFileSync('tests/fixtures/exampleNewWords.xml', 'utf8');
    const r = parseWordList({ text, fileName: 'exampleNewWords.xml' });
    expect(r.format).toBe('youdao-xml');
    const map = new Map(r.words.map((w) => [w.word.toLowerCase(), w]));
    expect(map.get('manipulate')).toMatchObject({ trans: 'vt. 操纵；操作；巧妙地处理；篡改', phonetic: "[mə'nɪpjulet]" });
    expect(map.has('asynchronous')).toBe(true);
    expect(map.has('影响')).toBe(false);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('CSV：表头识别、引号与逗号', () => {
    const r = parseWordList({ text: '﻿单词,音标,解释\napple,/ˈæpl/,"n. 苹果, 苹果树"\n', fileName: 'eudic.csv' });
    expect(r.format).toBe('csv');
    expect(r.words).toEqual([{ word: 'apple', phonetic: '/ˈæpl/', trans: 'n. 苹果, 苹果树' }]);
  });

  it('TXT：一行一词 / 词+释义 / 空格+中文释义', () => {
    const r = parseWordList({ text: 'abandon\nrun\tv. 跑\nstudy v. 学习\n# 注释\n\n' });
    expect(r.format).toBe('txt');
    expect(r.words).toEqual([{ word: 'abandon' }, { word: 'run', trans: 'v. 跑' }, { word: 'study', trans: 'v. 学习' }]);
  });

  it('Anki：指令行、guid 列、HTML 字段', () => {
    const text = '#separator:tab\n#html:true\n#guid column:1\nabc123\t<b>apple</b>\tn. 苹果<br>苹果树\n';
    expect(detectImportFormat(text, 'deck.txt')).toBe('anki');
    expect(parseWordList({ text }).words).toEqual([{ word: 'apple', trans: 'n. 苹果\n苹果树' }]);
  });

  it('parseDelimited：引号内换行与转义', () => {
    expect(parseDelimited('a,"b ""x""\nc"\r\nd,e', ',')).toEqual([['a', 'b "x"\nc'], ['d', 'e']]);
  });
});

describe('词书 id', () => {
  it('来源/本地/内置 id 往返', () => {
    expect(parseBookId(sourceBookId('eudic', 'a:b'))).toEqual({ kind: 'source', id: 'src:eudic:a%3Ab', providerId: 'eudic', remoteId: 'a:b' });
    expect(parseBookId(localBookId('u1'))).toEqual({ kind: 'local', id: 'local:u1', uuid: 'u1' });
    expect(parseBookId('cet6').kind).toBe('builtin');
  });
});
