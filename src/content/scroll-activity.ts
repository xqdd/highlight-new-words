interface ScrollActivity {
  lastInputAt: number;
  references: number;
  listener: () => void;
}

// Window 弱键随文档销毁回收；应用在异步初始化前持有，后启动的两个引擎共享已有输入时间。
const activities = new WeakMap<Window, ScrollActivity>();
const INPUT_EVENTS = ['wheel', 'scroll', 'touchmove'] as const;

export function trackScrollActivity(view: Window): () => void {
  let activity = activities.get(view);
  if (!activity) {
    const created: ScrollActivity = {
      lastInputAt: -Infinity,
      references: 0,
      listener: () => { created.lastInputAt = performance.now(); },
    };
    activity = created;
    activities.set(view, activity);
    for (const type of INPUT_EVENTS) view.addEventListener(type, activity.listener, { capture: true, passive: true });
  }
  activity.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--activity.references) return;
    for (const type of INPUT_EVENTS) view.removeEventListener(type, activity.listener, true);
    activities.delete(view);
  };
}

export function lastScrollInputAt(view: Window | null): number {
  return view ? activities.get(view)?.lastInputAt ?? -Infinity : -Infinity;
}

/** 先让出绘制机会，再等待输入停稳；持续输入可延长等待，取消会释放所有定时器与观察引用。 */
export function waitForScrollQuiet(view: Window, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const release = trackScrollActivity(view);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    let frame = 0;
    const finish = (quiet: boolean) => {
      clearTimeout(timer);
      if (frame) view.cancelAnimationFrame(frame);
      signal?.removeEventListener('abort', abort);
      release();
      resolve(quiet);
    };
    const abort = () => finish(false);
    const check = () => {
      const remaining = 100 - (performance.now() - lastScrollInputAt(view));
      if (remaining > 0) timer = setTimeout(check, Math.min(100, remaining));
      else finish(true);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof view.requestAnimationFrame === 'function') {
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        clearTimeout(timer);
        // 下一任务再允许样式安装，让当前帧有机会先绘制；后台文档的 rAF 则由短定时器兜底。
        timer = setTimeout(check, 0);
      });
      timer = setTimeout(() => { view.cancelAnimationFrame(frame); frame = 0; check(); }, 32);
    } else timer = setTimeout(check, 0);
  });
}
