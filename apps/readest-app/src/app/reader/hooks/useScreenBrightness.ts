import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useDeviceControlStore } from '@/store/deviceStore';

// Sentinel handed to the native bridge to release any app override and give
// screen brightness back to the system: iOS restores the value captured before
// the override, Android clears BRIGHTNESS_OVERRIDE_NONE. See issue #4885.
const RELEASE_BRIGHTNESS = -1;

/**
 * Keeps the reader aligned with the system brightness while open and releases
 * any temporary override when the reader closes.
 *
 * Slider and swipe gestures adjust the live system brightness directly; we do
 * not persist a separate in-app brightness level. The native iOS bridge
 * additionally restores the system brightness whenever the app backgrounds
 * (and re-applies on foreground), so ambient auto-brightness never stays
 * locked after leaving the app — the reader component does not unmount when
 * the app is merely sent to the home screen.
 */
export const useScreenBrightness = () => {
  const { appService } = useEnv();
  const { setScreenBrightness } = useDeviceControlStore();

  const hasScreenBrightness = !!appService?.hasScreenBrightness;

  useEffect(() => {
    if (!hasScreenBrightness) return;
    setScreenBrightness(RELEASE_BRIGHTNESS);
    return () => {
      setScreenBrightness(RELEASE_BRIGHTNESS);
    };
  }, [hasScreenBrightness, setScreenBrightness]);
};
