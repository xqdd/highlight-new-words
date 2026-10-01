/**
 * “只恢复我们自己发起的暂停”：记录由扩展调用的 pause/play，与用户（或播放器自身，如广告、播放结束）的操作区分开。
 *
 * 媒体事件是异步派发的，因此用计数抵消：调用 video.pause() 前 expectPause++，收到 pause 事件时先抵消计数；
 * 计数为 0 时收到的 pause/play 都视为用户操作，此后放弃本次自动恢复。
 * 监听挂在 document 的捕获阶段（媒体事件不冒泡，但捕获阶段能收到），视频元素被播放器替换也不受影响。
 */
export class PauseController {
  /** 当前的暂停是否由我们发起、且之后用户没有操作过播放/暂停 */
  private ours = false;
  private expectPause = 0;
  private expectPlay = 0;
  private readonly onMedia = (e: Event) => {
    const v = e.target;
    if (!(v instanceof HTMLMediaElement) || v !== this.getVideo()) return;
    if (e.type === 'pause') {
      if (this.expectPause > 0) this.expectPause--;
      else this.ours = false;
    } else if (this.expectPlay > 0) {
      this.expectPlay--;
    } else {
      // 我们暂停期间用户自己点了播放：交还控制权
      this.ours = false;
    }
  };

  constructor(
    private readonly doc: Document,
    private readonly getVideo: () => HTMLVideoElement | null,
    private readonly canPause: () => boolean = () => true,
  ) {
    doc.addEventListener('pause', this.onMedia, true);
    doc.addEventListener('play', this.onMedia, true);
  }

  /** 是否处于“我们发起的暂停”中 */
  get pausedByUs(): boolean {
    return this.ours;
  }

  /** 查词暂停：视频在播放且允许暂停时暂停并记为我们发起；已暂停（用户暂停的）不动。返回是否暂停了 */
  pause(): boolean {
    const v = this.getVideo();
    if (!v || v.paused || v.ended || !this.canPause()) return false;
    this.expectPause++;
    v.pause();
    this.ours = true;
    return true;
  }

  /** 恢复播放：只在暂停由我们发起、且期间用户没有操作过时恢复 */
  resume(): boolean {
    const v = this.getVideo();
    const should = this.ours && !!v && v.paused;
    this.ours = false;
    if (!should) return false;
    this.expectPlay++;
    // play() 可能因自动播放策略被拒绝（不会派发 play 事件），此时回收计数
    void v!.play()?.catch?.(() => {
      this.expectPlay = Math.max(0, this.expectPlay - 1);
    });
    return true;
  }

  /** 放弃本次自动恢复（如关闭了自动暂停开关） */
  release(): void {
    this.ours = false;
  }

  destroy(): void {
    this.doc.removeEventListener('pause', this.onMedia, true);
    this.doc.removeEventListener('play', this.onMedia, true);
  }
}
