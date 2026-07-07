import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  hasScreenBrightness: true,
  setScreenBrightness: vi.fn(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasScreenBrightness: h.hasScreenBrightness } }),
}));
vi.mock('@/store/deviceStore', () => ({
  useDeviceControlStore: () => ({ setScreenBrightness: h.setScreenBrightness }),
}));

import { useScreenBrightness } from '@/app/reader/hooks/useScreenBrightness';

function Wrapper() {
  useScreenBrightness();
  return null;
}

const setup = () => render(<Wrapper />);

describe('useScreenBrightness', () => {
  beforeEach(() => {
    h.hasScreenBrightness = true;
    h.setScreenBrightness.mockReset();
  });
  afterEach(() => cleanup());

  it('releases control to the system on mount', () => {
    setup();
    expect(h.setScreenBrightness).toHaveBeenCalledWith(-1);
  });

  it('releases control on unmount', () => {
    const utils = setup();
    h.setScreenBrightness.mockClear();
    utils.unmount();
    expect(h.setScreenBrightness).toHaveBeenCalledWith(-1);
  });

  it('is inert when the platform lacks screen brightness control', () => {
    h.hasScreenBrightness = false;
    setup();
    expect(h.setScreenBrightness).not.toHaveBeenCalled();
  });
});
