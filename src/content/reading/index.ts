import type { ReadingSettings } from '@/core/reading/settings';
import { isReadingVisualActive } from '@/core/reading/settings';
import { ReadingPhrasesController } from './phrases';
import { ReadingVisual } from './visual';
import { sendToBackground } from '@/core/messaging';
import { waitForScrollQuiet } from '../scroll-activity';

/** 与生词引擎共用页面生命周期；关闭总开关或本站禁用时完整清理。 */
export function createReadingTools(doc: Document) {
  let visual: ReadingVisual | undefined;
  let phrases: ReadingPhrasesController | undefined;
  let signature = '';
  let visualSignature = '';
  let pendingVisual: AbortController | undefined;
  let pendingSignature = '';
  return {
    update(settings: ReadingSettings) {
      const next = JSON.stringify(settings);
      if (next === signature) return;
      signature = next;
      // 短语开关不影响词性与词首效果，避免无关设置重建正文标记。
      const nextVisual = JSON.stringify([settings.enabled, settings.wordStylePriority, settings.scope, settings.bionic, settings.syntax, settings.emphasis]);
      if (isReadingVisualActive(settings)) {
        if (visual && nextVisual === visualSignature) {
          pendingVisual?.abort(); pendingVisual = undefined; pendingSignature = '';
        } else if (nextVisual !== pendingSignature && doc.defaultView) {
          pendingVisual?.abort();
          const request = pendingVisual = new AbortController();
          pendingSignature = nextVisual;
          // 原生样式注册也会重算站点样式。旧视觉保留到停稳提交，过期设置与关闭可取消待启动任务。
          void waitForScrollQuiet(doc.defaultView, request.signal).then(quiet => {
            if (!quiet || pendingVisual !== request || !doc.body) return;
            pendingVisual = undefined; pendingSignature = '';
            if (!visual) {
              // 词性分析在扩展后台本地执行，页面线程只收集文字与提交绘制范围。
              visual = new ReadingVisual(doc.body, settings, (text, withSyntax) => sendToBackground('analyzeReading', { text, withSyntax }));
              visual.start();
            } else visual.update(settings);
            visualSignature = nextVisual;
          });
        }
      } else {
        pendingVisual?.abort(); pendingVisual = undefined; pendingSignature = '';
        visual?.stop();
        visual = undefined;
        visualSignature = '';
      }
      if (settings.enabled && settings.phrases.enabled) {
        phrases ??= new ReadingPhrasesController({ document: doc });
        phrases.update(settings.phrases);
      } else {
        phrases?.dispose();
        phrases = undefined;
      }
    },
    stop() {
      pendingVisual?.abort(); pendingVisual = undefined; pendingSignature = '';
      signature = '';
      visualSignature = '';
      visual?.stop();
      visual = undefined;
      phrases?.dispose();
      phrases = undefined;
    },
  };
}
