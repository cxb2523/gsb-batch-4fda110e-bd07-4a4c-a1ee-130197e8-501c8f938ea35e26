import { describe, expect, it } from 'vitest';
import { getFocusCameraTarget } from './cameraFocus';

describe('getFocusCameraTarget', () => {
  it('passes normalized display coordinates through', () => {
    expect(getFocusCameraTarget({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });
  });

  it.each([undefined, null, { x: Number.NaN, y: 0.5 }, { x: 0.5, y: Number.POSITIVE_INFINITY }])(
    'returns null for invalid display data: %j',
    (display) => {
      expect(getFocusCameraTarget(display)).toBeNull();
    },
  );
});