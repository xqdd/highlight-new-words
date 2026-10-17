import type { ReadingSettings } from '@/core/reading/settings';
import { isReadingVisualActive } from '@/core/reading/settings';
import { ReadingPhrasesController } from './phrases';
import { ReadingVisual } from './visual';

/** 与生词引擎共用页面生命周期；关闭总开关或本站禁用时完整清理。 */
export function createReadingTools(doc: Document) {
  let visual: ReadingVisual | undefined;
  let phrases: ReadingPhrasesController | undefined;
  let signature = '';
  let visualSignature = '';
  return {
    update(settings: ReadingSettings) {
      const next = JSON.stringify(settings);
      if (next === signature) return;
      signature = next;
      // 短语开关不影响词性与词首效果，避免无关设置重建正文标记。
      const nextVisual = JSON.stringify([settings.enabled, settings.wordStylePriority, settings.bionic, settings.syntax, settings.emphasis]);
      if (isReadingVisualActive(settings)) {
        if (!visual) {
          visual = new ReadingVisual(doc.body, settings);
          visual.start();
        } else if (nextVisual !== visualSignature) {
          visual.update(settings);
        }
      } else {
        visual?.stop();
        visual = undefined;
      }
      visualSignature = nextVisual;
      if (settings.enabled && settings.phrases.enabled) {
        phrases ??= new ReadingPhrasesController({ document: doc });
        phrases.update(settings.phrases);
      } else {
        phrases?.dispose();
        phrases = undefined;
      }
    },
    stop() {
      signature = '';
      visualSignature = '';
      visual?.stop();
      visual = undefined;
      phrases?.dispose();
      phrases = undefined;
    },
  };
}
