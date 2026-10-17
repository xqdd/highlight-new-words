import nlp from 'compromise';
import type { ReadingPartOfSpeech } from './settings';

export type { ReadingPartOfSpeech } from './settings';
export interface ReadingToken {
  start: number;
  end: number;
  text: string;
  pos?: ReadingPartOfSpeech;
  properNoun?: boolean;
  emphasis?: 'negation' | 'connectives' | 'numbers';
}

// 这些封闭词表仅提供阅读提示，不把规则匹配描述为句法分析。
const NEGATION = /^(?:no|not|never|neither|nor|none|nothing|nobody|nowhere|without|cannot|\w+n['’]t)$/i;
const CONNECTIVES = /^(?:and|or|but|if|so|while|since|when|until|however|although|though|yet|therefore|thus|hence|because|unless|whereas|nevertheless|moreover|furthermore|instead|otherwise|despite)$/i;
// compromise 将这些不定代词归入普通 Noun；仅补无名词/动词歧义的封闭复合形式。
const INDEFINITE_PRONOUN = /^(?:(?:some|any|every)(?:one|body|thing)|nobody|nothing)(?:['’]s)?$/i;
const WH_PERSON = /^(?:who|whom)$/;
const WH_NOMINAL = /^(?:what|which|whose)$/;
const WH_ADVERB = /^(?:where|when|why|how)$/;
// 设置变化或原站排版更新时复用最近完整段落的词性结果，缓存随内容脚本销毁。
const syntaxCache = new Map<string, ReadingToken[]>();

/** 整段上下文送入本地 compromise 标注，再将偏移映射回原文；不发起网络请求。 */
export function analyzeReading(text: string, withSyntax = true): ReadingToken[] {
  const cached = withSyntax ? syntaxCache.get(text) : undefined;
  if (cached) {
    syntaxCache.delete(text); syntaxCache.set(text, cached);
    return cached;
  }
  const tokens: ReadingToken[] = [];
  for (const match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+(?:[.,]\d+)*(?:%|[A-Za-z]+)?/g)) {
    const word = match[0];
    // 英文提示不切开重音词或混合标识符（naïve、COVID19）。
    if (/[\p{L}\p{M}\p{N}]/u.test(text[match.index - 1] ?? '') || /[\p{L}\p{M}\p{N}]/u.test(text[match.index + word.length] ?? '')) continue;
    tokens.push({
      start: match.index,
      end: match.index + word.length,
      text: word,
      emphasis: NEGATION.test(word) ? 'negation' : CONNECTIVES.test(word) ? 'connectives' : /^\d/.test(word) ? 'numbers' : undefined,
    });
  }
  if (!withSyntax || !/[A-Za-z]/.test(text)) return tokens;
  const byStart = new Map(tokens.map((token) => [token.start, token]));
  const indexByStart = new Map(tokens.map((token, index) => [token.start, index]));
  // 网页常把署名和引语分在相邻行内标签里，textContent 会成为 Ripley:“We。
  // 等长替换引号，避免分析器把署名与首词黏成一个 term；冒号直连引语按句首分析。
  // 紧贴省略号的 beef…Someone 也会黏词；用等长换行边界隔开，保留正常句点、缩写和连字符。
  // 只改分析副本，不改原文，因此所有偏移仍可直接映射到原 Text/生词节点。
  const syntaxText = text.replace(/:["“‘']/g, '. ').replace(/["“”‘]/g, ' ')
    .replace(/…|\.{3,}/g, punctuation => '\n' + ' '.repeat(punctuation.length - 1));
  const terms = nlp(syntaxText).terms().json({ offset: true }) as Array<{
    terms: Array<{ text: string; tags: string[]; offset?: { start: number; length: number } }>;
  }>;
  const taggedTerms = terms.flatMap(group => group.terms).flatMap(term => {
    // compromise 部分复合词只有一个 term（pre-review、CI/CD）；词级包装需要覆盖每个组成词。
    // 沿用整个复合词的上下文标签，仅展开纯英文连字符/斜杠形式，不拆 URL、小数或混合标识符。
    if (!term.offset || !/^[A-Za-z]+(?:['’][A-Za-z]+)?(?:[-/‐‑–—][A-Za-z]+(?:['’][A-Za-z]+)?)+$/.test(term.text)) return [term];
    const first = indexByStart.get(term.offset.start);
    if (first === undefined) return [term];
    const parts = [];
    for (let i = first; i < tokens.length && tokens[i]!.end <= term.offset.start + term.offset.length; i++) {
      const token = tokens[i]!;
      parts.push({ ...term, text: token.text, offset: { start: token.start, length: token.end - token.start } });
    }
    return parts;
  });
  for (const [index, term] of taggedTerms.entries()) {
      if (!term.offset) continue;
      const token = byStart.get(term.offset.start);
      if (!token) continue;
      token.properNoun = term.tags.includes('ProperNoun');
      const word = token.text.toLowerCase();
      const questionWord = word.replace(/['’]s$/, '');
      const next = taggedTerms[index + 1];
      // QuestionWord 和 There 不是 compromise 的常见词性子类，需显式映射。
      // what/which/whose 修饰名词时是限定词，独立使用时是代词；how 等不归为代词。
      // 仅在分析器已识别为疑问/连接/限定词时修正，避免覆盖同形专名。
      const whWord = term.tags.includes('QuestionWord') || term.tags.includes('Connector') || term.tags.includes('Determiner');
      let functionPos: ReadingPartOfSpeech | undefined;
      if (!token.properNoun) {
        if (INDEFINITE_PRONOUN.test(word) || whWord && WH_PERSON.test(questionWord)) functionPos = 'pronoun';
        else if (whWord && WH_NOMINAL.test(questionWord)) {
          // 原始 Noun 标签也包含上面补正的不定代词；what someone said 中不能当作名词修饰语。
          // what's 已包含系词，后面的名词不是 what 的被修饰词；which 则可直接限定专名。
          functionPos = questionWord === word && next && (next.tags.includes('Noun') && !next.tags.includes('Pronoun')
            && !INDEFINITE_PRONOUN.test(next.text) && (!next.tags.includes('ProperNoun') || questionWord === 'which')
            || next.tags.includes('Adjective') || next.tags.includes('Determiner') || next.tags.includes('Value')) ? 'determiner' : 'pronoun';
        } else if (whWord && WH_ADVERB.test(questionWord) && !term.tags.includes('Conjunction')) functionPos = 'adverb';
        else if (term.tags.includes('There')) functionPos = 'pronoun';
        else if (word === 'there') functionPos = 'adverb';
      }
      // 先处理子类和功能词，防止代词被 Noun 父标签吞掉；分类以完整上下文为准。
      token.pos = functionPos ?? (term.tags.includes('Particle') || word === 'to' && next?.tags.includes('Infinitive') ? 'particle'
        : term.tags.includes('Pronoun') ? 'pronoun'
        : term.tags.includes('Determiner') ? 'determiner'
        : term.tags.includes('Preposition') ? 'preposition'
        : term.tags.includes('Conjunction') ? 'conjunction'
        : term.tags.includes('Value') ? 'numeral'
        : term.tags.includes('Expression') ? 'interjection'
        : term.tags.includes('Verb') ? 'verb'
        : term.tags.includes('Adjective') ? 'adjective'
          : term.tags.includes('Adverb') ? 'adverb'
            : term.tags.includes('Noun') ? 'noun' : undefined);
      if (term.tags.includes('Value') && !token.emphasis) token.emphasis = 'numbers';
  }
  if (text.length <= 6000) {
    syntaxCache.set(text, tokens);
    if (syntaxCache.size > 24) syntaxCache.delete(syntaxCache.keys().next().value!);
  }
  return tokens;
}
