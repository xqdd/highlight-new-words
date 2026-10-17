import { describe, expect, it } from 'vitest';
import { analyzeReading } from '@/core/reading/analyze';

describe('阅读功能词分类', () => {
  it.each(['…', '...', '....'])('省略号%s不吞掉后续代词，保持前后词的原文偏移', punctuation => {
    const text = `Ernest:“There’s always ‘beef’ emails — neighborhood beef, yoga studio beef, conference beef, business beef${punctuation}Someone has been wronged and has written a Medium hot take about it.”`;
    const tokens = analyzeReading(text);
    expect(tokens.find(token => token.text === 'Someone')).toMatchObject({ pos: 'pronoun', properNoun: false });
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it('保留无空格破折号两侧词性，不破坏复合词、缩写或小数', () => {
    const text = 'Great communication—excellent work—I love Medium. War, well…It’s violent. The U.S. team used 3.14 low-quality samples.';
    const tokens = analyzeReading(text);
    for (const [word, pos] of [['excellent', 'adjective'], ['I', 'pronoun'], ['It’s', 'pronoun']]) {
      expect(tokens.find(token => token.text === word)?.pos, word).toBe(pos);
    }
    expect(tokens.find(token => token.text === '3.14')?.pos).toBe('numeral');
    expect(tokens.filter(token => ['low', 'quality'].includes(token.text)).every(token => token.pos !== undefined)).toBe(true);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it.each([
    ['Ripley:“OK, the writer of the post has an issue with a specific company.”', 'OK'],
    ['Ernest:“There’s a difference between criticizing and targeting an individual.”', 'There’s'],
    ['Ripley:“We naturally fall into a quasi-Socratic, cross-examination conversation with some tricky tickets.”', 'We'],
    ['Ernest:“This has intentional misgendering and dead-naming.”', 'This'],
    ['She said:“What happens?”', 'What'],
    ['Ripley:"We naturally fall into a conversation."', 'We'],
    ["Ripley:'We naturally fall into a conversation.'", 'We'],
    ['Ripley:‘We naturally fall into a conversation.’', 'We'],
    ['“We moderate content at Medium.”', 'We'],
  ])('相邻署名和引号不吞掉引语首词，并保留全部原文偏移：%s', (text, word) => {
    const tokens = analyzeReading(text);
    expect(tokens.find(token => token.text === word)?.pos).toBeDefined();
    if (word === 'We' || word === 'There’s' || word === 'This' || word === 'What') {
      expect(tokens.find(token => token.text === word)?.pos).toBe('pronoun');
      expect(tokens.find(token => token.text === word)?.properNoun).toBe(false);
    }
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it('保留个人代词并补充不定代词，不将地点副词当作代词', () => {
    const text = 'We know someone can help. Anybody can share something with everyone. We can meet somewhere.';
    const tokens = analyzeReading(text);
    for (const word of ['We', 'someone', 'Anybody', 'something', 'everyone']) {
      expect(tokens.find(token => token.text === word)?.pos, word).toBe('pronoun');
    }
    expect(tokens.find(token => token.text === 'somewhere')?.pos).toBe('adverb');
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it('将存在句 there 与地点 there 分开，不遗留没有词性的 There 标签', () => {
    const tokens = analyzeReading('There are people waiting. We went there.');
    expect(tokens.filter(token => token.text.toLowerCase() === 'there').map(token => token.pos)).toEqual(['pronoun', 'adverb']);
  });

  it('保留缩写的完整原文并识别缩写疑问词和存在句主语', () => {
    const text = "There's someone here. What’s happening? How’s everyone?";
    const tokens = analyzeReading(text);
    expect(tokens.find(token => token.text === "There's")?.pos).toBe('pronoun');
    expect(tokens.find(token => token.text === 'What’s')?.pos).toBe('pronoun');
    expect(tokens.find(token => token.text === 'How’s')?.pos).toBe('adverb');
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it.each([
    ['What can we do?', 'What', 'pronoun'],
    ['What color is it?', 'What', 'determiner'],
    ['Which option should we choose?', 'Which', 'determiner'],
    ['Which is yours?', 'Which', 'pronoun'],
    ['Whose is this?', 'Whose', 'pronoun'],
    ['Who knows?', 'Who', 'pronoun'],
    ['You know what I mean.', 'what', 'pronoun'],
    ['I know what someone said.', 'what', 'pronoun'],
    ['What everyone needs is support.', 'What', 'pronoun'],
    ['Which John do you mean?', 'Which', 'determiner'],
    ['I know what John said.', 'what', 'pronoun'],
    ["What's music?", "What's", 'pronoun'],
    ['What’s new?', 'What’s', 'pronoun'],
    ['There are people who care about what we write.', 'what', 'pronoun'],
    ['How can we help?', 'How', 'adverb'],
    ['We know where she lives.', 'where', 'adverb'],
    ['We can wait when someone arrives.', 'when', 'conjunction'],
  ])('根据句中用途映射疑问词：%s', (text, word, pos) => {
    expect(analyzeReading(text).find(token => token.text === word)?.pos).toBe(pos);
  });

  it('纯语义分析保持不执行词性补充', () => {
    expect(analyzeReading('Someone knows what happened there.', false).every(token => token.pos === undefined)).toBe(true);
  });
});
