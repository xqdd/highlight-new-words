import { describe, expect, it } from 'vitest';
import { AIM_EDGE_ZONE, AIM_OFFSET, computeOverlayFrame, dragAimPoint, fromFrameLocal, pointInRect, toFrameLocal } from '@/content/floatball/model';

describe('floatball 拖动取词纯逻辑', () => {
  it('准星在球心正上方 AIM_OFFSET 处', () => {
    expect(dragAimPoint(200, 400, 390)).toEqual({ x: 200, y: 400 - AIM_OFFSET });
  });

  it('球心在贴边区（挪位置）时不取词，离开贴边区才出现准星', () => {
    expect(dragAimPoint(AIM_EDGE_ZONE - 1, 400, 390)).toBeNull();
    expect(dragAimPoint(390 - AIM_EDGE_ZONE + 1, 400, 390)).toBeNull();
    expect(dragAimPoint(AIM_EDGE_ZONE, 400, 390)).not.toBeNull();
    expect(dragAimPoint(390 - AIM_EDGE_ZONE, 400, 390)).not.toBeNull();
  });

  it('准星超出屏幕顶部时不取词', () => {
    expect(dragAimPoint(200, AIM_OFFSET - 1, 390)).toBeNull();
    expect(dragAimPoint(200, AIM_OFFSET, 390)).toEqual({ x: 200, y: 0 });
  });

  it('宿主局部坐标与 client 坐标互逆（双指缩放、可见区域平移时）', () => {
    const frame = computeOverlayFrame({ offsetLeft: 30, offsetTop: 120, scale: 2, width: 195, height: 422 }, { width: 0, height: 0 });
    const local = toFrameLocal(frame, 80, 200);
    expect(fromFrameLocal(frame, local.x, local.y)).toEqual({ x: 80, y: 200 });
    // 未缩放、未平移时两种坐标相同
    const plain = computeOverlayFrame(null, { width: 390, height: 844 });
    expect(fromFrameLocal(plain, 12, 34)).toEqual({ x: 12, y: 34 });
  });

  it('取词点须落在单词框内（含容差）', () => {
    const r = { left: 100, right: 150, top: 200, bottom: 220 };
    expect(pointInRect(r, 120, 210, 6)).toBe(true);
    expect(pointInRect(r, 94, 226, 6)).toBe(true);
    expect(pointInRect(r, 93, 210, 6)).toBe(false);
    expect(pointInRect(r, 120, 227, 6)).toBe(false);
  });
});
