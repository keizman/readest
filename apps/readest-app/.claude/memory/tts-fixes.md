# TTS (Text-to-Speech) Fixes Reference

## Architecture

### Key Components
- `TTSController` (`src/services/tts/TTSController.ts`) - Core state machine
- `EdgeTTSClient` (`src/services/tts/EdgeTTSClient.ts`) - Edge TTS provider
- `useTTSControl` hook (`src/app/reader/hooks/useTTSControl.ts`) - React integration
- `useTTSMediaSession` hook (`src/app/reader/hooks/useTTSMediaSession.ts`) - Media controls

### Section-Aware TTS Model
TTS tracks its own section independently from the view via `#ttsSectionIndex`:
- `#initTTSForSection()` - Creates TTS document for a section without changing the view
- `#initTTSForNextSection()` / `#initTTSForPrevSection()` - Navigate TTS across sections
- `#getHighlighter()` - Only returns highlighter if view section matches TTS section
- `onSectionChange` callback - Notifies UI when TTS crosses section boundary
- Highlights use CFI strings (not raw Range objects) for cross-section compatibility

### State Management Pitfalls
1. **`#ttsSectionIndex` must match view section for highlights to work**
   - If `-1`, all highlight calls are suppressed
   - `shutdown()` sets it to `-1` but must also null out `this.view.tts`

2. **Guards/Refs that block re-entry:**
   - The old `ttsOnRef` guard blocked TTS restart from annotations (removed in #3292)
   - `view.tts` reference surviving shutdown blocked re-initialization (#3400)

3. **Timeouts that fire after pause:**
   - Edge TTS had a safety timeout that advanced sentences even when paused (#3244)
   - Solution: removed the entire `ontimeupdate` safety timeout mechanism

## Fix History

| Issue | Problem | Root Cause | Fix |
|-------|---------|------------|-----|
| #3100 | TTS scrolls too far | TTS coupled to view section | Added `#ttsSectionIndex`, "Back to TTS Location" button |
| #3198 | TTS doesn't follow to next section | No `onSectionChange` callback | Added section change notification, extracted hooks |
| #3244 | Paused TTS advances | Safety timeout fires after pause | Removed `ontimeupdate` timeout mechanism |
| #3291 | TTS fails without lang attribute | Invalid SSML from missing lang | Set lang/xml:lang on html element from `ttsLang` |
| #3292 | Can't restart TTS from annotation | `ttsOnRef` blocks re-entry | Removed the guard ref entirely |
| #3400 | TTS highlight stops after restart | `view.tts` not nulled on shutdown | Added `this.view.tts = null` in `shutdown()` |
| #4033 | Voice count flip-flops within one book (17↔5) | All 3 clients filtered voices by full locale (`v.lang.startsWith(locale)`); panel lang refreshes from the speaking mark (`getSpeakingLang`), and books mix region variants — Standard Ebooks boilerplate is `en-US` (17 Edge voices), body `en-GB` (5 Edge voices) | PR #4565: filter by primary lang (`isSameLang`) in Edge/Web/Native `getVoices`; new `TTSUtils.sortVoicesPreferLocaleFunc(locale)` keeps exact-locale voices first so `getVoiceIdFromLang` default stays region-aware. Also fixed `zh-Hans` → empty Edge list |
| — | Android: misdiagnosed "totally can't TTS" (`Edge TTS WebSocket timed out` on every batch) | An attempt to fix background-playback gaps by making Android *always* request the `*_HIDDEN` buffer/lookahead tiers (`WebAudioPlayer` `MAX_PENDING_HIDDEN`/`MAX_AHEAD_SEC_HIDDEN`, `EdgeTTSClient` `PIPELINE_LOOKAHEAD_HIDDEN`) even while visible caused sustained over-fetching against the self-hosted relay, timing out every WS request including the first | Reverted; `*_HIDDEN` budgets stay reactive to actual `document.visibilityState === 'hidden'` only. See code comments at the top of `WebAudioPlayer.ts`/`EdgeTTSClient.ts` near those constants before resurrecting an always-on variant |
| — | `console.warn('Edge TTS fetch attempt N/3 failed', [object DOMException])` looked like a real failure but wasn't | `#createAudioDataWithRetry` logged every caught error identically, including the expected `DOMException('Aborted', 'AbortError')` thrown by `wsAbortError()` when an in-flight WS wait/fetch is cancelled by a superseding session (navigation, `stop()`, a newer generation) — indistinguishable in logs from a genuine network/server failure | Check `signal.aborted` first in the catch and return `undefined` silently (existing "skip" convention) instead of warning + retry-backoff. If you see this warning with a near-instant matching `[TTS] session N start` → `[TTS] session N abort` pair (compare timestamps — genuine WS timeouts take ~`WS_REQUEST_TIMEOUT_MS`=15s per attempt, a real cancellation is ~1ms), it's very likely rapid overlapping `forward()`/`backward()`/`stop()` calls superseding an in-flight `#speak()` (its own `await this.stop(true)` aborts whatever `#currentSpeakAbortController` currently holds, which the caller doesn't await inside `#handleNavigationWithSSML`), not a real Edge/network problem |

## Debugging TTS Issues

1. **TTS doesn't start:** Check `#initTTSForSection()` - does `view.tts.doc === doc` shortcut early?
2. **No highlights:** Check `#ttsSectionIndex` matches view's section index
3. **Advances when paused:** Look for setTimeout/timer callbacks that bypass pause state
4. **Can't restart:** Check for refs/guards that prevent re-entry into speak handlers
5. **Fails on some chapters:** Check if chapter has lang attribute and XHTML namespace
6. **SSML errors:** Check `src/utils/ssml.ts` for proper namespace/lang handling
