import { FoliateView } from '@/types/view';
import { AppService } from '@/types/system';
import { filterSSMLWithLang, hasSpeakableText, parseSSMLMarks } from '@/utils/ssml';
import { Overlayer } from 'foliate-js/overlayer.js';
import {
  TTSGranularity,
  TTSHighlightGranularity,
  TTSHighlightOptions,
  TTSMark,
  TTSVoice,
} from './types';
import { createRejectFilter } from '@/utils/node';
import { getEdgeTTSWsMaxConcurrent, hasTTSPrefetchCapacity, WsSlotPriority } from '@/libs/edgeTTS';
import { WebSpeechClient } from './WebSpeechClient';
import { NativeTTSClient } from './NativeTTSClient';
import { EdgeTTSClient } from './EdgeTTSClient';
import { SectionTimeline, TimelineSentence } from './SectionTimeline';
import { TTSUtils } from './TTSUtils';
import { TTSClient } from './TTSClient';
import { isValidLang } from '@/utils/lang';
import { estimateSpeechDuration } from '@/utils/ttsTime';
import {
  computeWordOffsets,
  getTextSubRange,
  rangeTextExcludingInert,
  TTSWordOffset,
} from './wordHighlight';
import { elapsedMs, nowMs, ttsLog, ttsWarn } from './ttsDiagnostics';

// App-wide monotonic sequence for 'tts-position' events. A fresh TTSController
// is constructed per `tts-speak`, so a per-instance counter would restart at 0
// and consumers (paragraph mode, RSVP) holding `lastSequenceSeen` from a prior
// session would drop the new session's early positions until they exceeded the
// old count. A module-level counter keeps the sequence strictly increasing
// across sessions.
let ttsPositionSequence = 0;

// Deep look-ahead prefetch sized to fill most of the Edge audio cache:
// ~1.5 h of speech at Edge's 48 kbit/s MP3 is ~32 MB (TTS_AUDIO_CACHE_MAX_BYTES).
// Duration is estimated per paragraph (CJK chars vs. words), so English and
// short dialogue receive the same real playback buffer as dense CJK prose.
// Prefetch continues into following sections when needed.
const PREFETCH_TARGET_SECONDS = 90 * 60;
// Bound each look-ahead pass. A chapter with thousands of short blocks used to
// make TTS startup walk the whole remaining section synchronously via
// foliate's tts.next()/prev(), which can ANR Android before any network fetch
// starts. Playback asks for look-ahead again on later boundaries, so a modest
// per-pass window keeps the cache warm without monopolizing the main thread.
const PREFETCH_NEAR_PARAGRAPHS = 5;
const PREFETCH_MAX_PARAGRAPHS = 64;
const PREFETCH_MAX_RAW_SSML_CHARS = 24_000;
// Deep paragraph lookahead must stay distance-ordered near the playhead: the
// next few paragraphs are more valuable than many far-ahead misses. Parallel
// paragraph workers must not let distant content contend with this near window
// on the backend.
const prefetchParallelism = (): number => Math.max(1, getEdgeTTSWsMaxConcurrent() - 1);

// Native TTS (Android System TTS / iOS) can report a terminal 'error' for an
// utterance it cannot synthesize offline — typically a specific unsupported
// character, hit characteristically on the first utterance after a chapter
// boundary even with a local/offline voice (online the engine often
// network-falls-back, which is why it only breaks offline). #speak only
// auto-advances on 'end', so without handling, a single such error dead-ends
// playback and wedges the controls in 'playing'. Re-speaking the same text
// would just fail again, so we skip the bad chunk and advance — bounding
// consecutive failures so a wholly-unusable engine still stops gracefully
// instead of silently racing to the end of the book. See #4613, #4408.
// Edge TTS shares this bound: a paragraph whose batch exhausts its WS
// retries (reset connection, timeout, transient 5xx) used to terminate the
// whole session outright, which is what "TTS just stops / gets stuck" was —
// almost always a single flaky paragraph, not a broken pipeline, so treat it
// like the native case and skip forward instead.
const TTS_SPEAK_MAX_CONSECUTIVE_ERRORS = 5;

type TTSState =
  | 'stopped'
  | 'playing'
  | 'paused'
  | 'stop-paused'
  | 'backward-paused'
  | 'forward-paused'
  | 'setrate-paused'
  | 'setvoice-paused';

const HIGHLIGHT_KEY = 'tts-highlight';

// Hook-supplied callbacks rebound on view attach: the constructor-captured
// closures belong to whichever reader hook created the controller and die
// with it.
export interface TTSViewBindings {
  bookKey: string;
  preprocessCallback?: (ssml: string) => Promise<string>;
  onSectionChange?: (sectionIndex: number) => Promise<void>;
}

// Node filter shared by the live TTS instance and the timeline enumeration —
// the two MUST segment identically or timeline sentences drift from marks.
const createTTSNodeFilter = () =>
  createRejectFilter({
    tags: ['rt', 'canvas', 'br'],
    // Footnotes/endnotes are hidden in the rendered page (see the
    // `.epubtype-footnote`/`aside[epub|type]` rules in getPageLayoutStyles);
    // skip them in TTS too, including for background sections whose
    // documents are loaded without those styles.
    classes: [
      'annotationLayer',
      'epubtype-footnote',
      'duokan-footnote-content',
      'duokan-footnote-item',
    ],
    attributeTokens: [
      {
        tag: 'aside',
        attribute: 'epub:type',
        tokens: ['footnote', 'endnote', 'note', 'rearnote'],
      },
    ],
    contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
  });

export class TTSController extends EventTarget {
  appService: AppService | null = null;
  view: FoliateView;
  isAuthenticated: boolean = false;
  preprocessCallback?: (ssml: string) => Promise<string>;
  onSectionChange?: (sectionIndex: number) => Promise<void>;
  #nossmlCnt: number = 0;
  // Consecutive native-TTS utterances that ended in a terminal 'error' without
  // a successful 'end' in between. Reset on success; caps skip-on-error so a
  // wholly-unusable engine stops instead of racing to the book end. See #4613.
  #consecutiveSpeakErrors: number = 0;
  #currentSpeakAbortController: AbortController | null = null;
  #currentSpeakPromise: Promise<void> | null = null;
  #hasStartedPlayback = false;
  #prefetchAbortController: AbortController | null = null;
  #prefetchInFlight = false;
  #speakStartupGeneration = 0;
  #speakStartupInProgress = false;
  #deferredPreloadNextSSML = false;
  #ttsSectionIndex: number = -1;

  // Virtual section timeline for position/duration/seek (Edge client only).
  // Built lazily OFF the playback critical path: enumerating a 2000-sentence
  // chapter must never delay first audio.
  #sectionTimeline: SectionTimeline | null = null;
  #timelineSectionIndex: number = -1;
  #currentSentenceIndex: number = -1;
  #currentSpeakRange: Range | null = null;
  #ttsDoc: Document | null = null;
  #ttsGranularity: TTSGranularity = 'sentence';

  // Word-level highlight state for the currently spoken chunk. Armed by a
  // successful dispatchSpeakMark, populated by prepareSpeakWords when a TTS
  // client has word-boundary metadata for the chunk.
  #speakWordsArmed = false;
  #speakWordBaseRange: Range | null = null;
  #speakWordOffsets: (TTSWordOffset | null)[] = [];
  #speakWordRanges: (Range | null | undefined)[] = [];
  #suppressMarkHighlight = false;
  // True while the current chunk is highlighted word-by-word, with the most
  // recently highlighted word range. Lets re-highlights (e.g. on page relocate)
  // re-apply the word instead of redrawing the whole sentence over it.
  #wordHighlightActive = false;
  #lastSpeakWordRange: Range | null = null;
  // User-chosen highlight granularity. 'word' (default) highlights word-by-word
  // when the active client reports word boundaries (Edge); 'sentence' keeps the
  // highlight at the sentence level even then. Sentence highlighting is assumed
  // supported by every client, so 'word' falls back to it automatically.
  #highlightGranularity: TTSHighlightGranularity = 'word';

  #state: TTSState = 'stopped';
  #terminated = false;
  // View attachment: false while the session runs headless (book closed).
  // The epoch invalidates in-flight attachView calls when a detach (or a
  // newer attach) supersedes them.
  #attached = true;
  #attachEpoch = 0;
  // Controller-owned foliate TTS text instance. view.close() nulls view.tts,
  // so the controller keeps its own handle (mirrored to view.tts while a view
  // is attached, for external consumers).
  #tts: FoliateView['tts'] = null;

  ttsLang: string = '';
  ttsRate: number = 1.0;
  ttsClient: TTSClient;
  ttsWebClient: TTSClient;
  ttsEdgeClient: EdgeTTSClient;
  ttsNativeClient: TTSClient | null = null;
  ttsWebVoices: TTSVoice[] = [];
  ttsEdgeVoices: TTSVoice[] = [];
  ttsNativeVoices: TTSVoice[] = [];
  ttsTargetLang: string = '';

  options: TTSHighlightOptions = { style: 'highlight', color: 'gray' };

  constructor(
    appService: AppService | null,
    view: FoliateView,
    isAuthenticated: boolean = false,
    preprocessCallback?: (ssml: string) => Promise<string>,
    onSectionChange?: (sectionIndex: number) => Promise<void>,
  ) {
    super();
    this.ttsWebClient = new WebSpeechClient(this);
    this.ttsEdgeClient = new EdgeTTSClient(this, appService);
    // Native TTS is backed by Android TextToSpeech and iOS AVSpeechSynthesizer.
    // TODO: implement native TTS client for desktop platforms.
    if (appService?.isAndroidApp || appService?.isIOSApp) {
      this.ttsNativeClient = new NativeTTSClient(this);
    }
    this.ttsClient = this.ttsWebClient;
    this.appService = appService;
    this.view = view;
    this.isAuthenticated = isAuthenticated;
    this.preprocessCallback = preprocessCallback;
    this.onSectionChange = onSectionChange;
  }

  get state(): TTSState {
    return this.#state;
  }

  // The state value is a TRANSIT signal ('stopped' occurs on every paragraph
  // advance and across chapter transitions) — listeners must never infer
  // session death from it; that is what 'tts-session-ended' is for. Dispatch
  // is deferred to a microtask so listeners never run re-entrantly inside
  // stop()/error().
  set state(value: TTSState) {
    if (this.#state === value) return;
    this.#state = value;
    queueMicrotask(() => {
      this.dispatchEvent(new CustomEvent('tts-state-change', { detail: { state: value } }));
    });
  }

  // True once the session reached a terminal condition (end of content or
  // unrecoverable error). Rate/voice/navigation restarts never set this.
  get terminated(): boolean {
    return this.#terminated;
  }

  // The live text instance: prefer the view's mirror (the public surface
  // external callers use) and fall back to the controller-owned handle once
  // view.close() nulls the mirror.
  #getTts(): FoliateView['tts'] {
    return this.view?.tts ?? this.#tts;
  }

  #terminate(reason: 'ended' | 'error') {
    if (this.#terminated) return;
    this.#terminated = true;
    queueMicrotask(() => {
      this.dispatchEvent(new CustomEvent('tts-session-ended', { detail: { reason } }));
    });
  }

  get isViewAttached(): boolean {
    return this.#attached;
  }

  // Enter headless mode. Audio, the abort signal, and the in-flight speak
  // generator are untouched: only layout-dependent work stops. The old view
  // object is retained as a pure book handle (view.close() destroys the
  // renderer but keeps view.book, and getCFI/resolveCFI are book+range math).
  detachView(): void {
    this.#attached = false;
    this.#attachEpoch++;
    // The unmounted hook's closures read wiped stores; running them headless
    // crashes the speak loop (e.g. proofread preprocessing on a cleared
    // viewSettings). Severed here, rebound by attachView.
    this.preprocessCallback = undefined;
    this.onSectionChange = undefined;
  }

  // Adopt a freshly mounted view without touching in-flight audio. Async prep
  // builds a TTS text instance over the new view's document; the swap itself
  // is synchronous and re-seeds from the OLD instance's cursor at swap time —
  // forward() may have auto-advanced during prep, and a seed captured earlier
  // would replay the previous paragraph.
  async attachView(view: FoliateView, bindings: TTSViewBindings): Promise<void> {
    const epoch = ++this.#attachEpoch;
    const oldTts = this.#getTts();
    const sectionIndex = Math.max(this.#ttsSectionIndex, 0);

    // Prep (no controller state mutated): resolve the section document from
    // the new view, preferring its rendered primary content.
    const contents = view.renderer.getContents();
    const primary = contents.find((x) => x.index === view.renderer.primaryIndex) ?? contents[0];
    let doc = primary && (primary.index ?? 0) === sectionIndex ? primary.doc : undefined;
    if (!doc) {
      const section = view.book.sections?.[sectionIndex];
      doc = section?.createDocument ? await section.createDocument() : undefined;
    }
    if (!doc) {
      ttsWarn('attach-view-no-document', { section: sectionIndex });
      return;
    }
    const { TTS } = await import('foliate-js/tts.js');
    const { textWalker } = await import('foliate-js/text-walker.js');
    const newTts = new TTS(
      doc,
      textWalker,
      createTTSNodeFilter(),
      this.#getHighlighter(),
      this.#ttsGranularity,
    );

    // A detach (new view closed) or a newer attach superseded this one.
    if (epoch !== this.#attachEpoch) return;

    // Synchronous swap.
    this.view = view;
    this.preprocessCallback = bindings.preprocessCallback;
    this.onSectionChange = bindings.onSectionChange;
    this.#attached = true;
    const lastRange = oldTts?.getLastRange?.();
    if (lastRange) {
      try {
        // Re-derive the seed NOW: CFIs are valid from the old (content
        // identical) document, and from() needs a range anchored in the new
        // doc (compareBoundaryPoints throws cross-document).
        const cfi = view.getCFI(sectionIndex, lastRange);
        const anchored = view.resolveCFI(cfi).anchor(doc);
        if (anchored) newTts.from(anchored); // position the iterator; discard SSML
      } catch (err) {
        ttsWarn('attach-view-reseed-failed', undefined, err);
      }
    }
    this.#tts = newTts;
    this.view.tts = newTts;
    this.#ttsDoc = doc;
    // The timeline maps the old document's ranges; rebuild lazily.
    this.#sectionTimeline = null;
    this.#timelineSectionIndex = -1;
    this.#currentSentenceIndex = -1;
    this.reapplyCurrentHighlight();
    this.redispatchPosition();
  }

  async init() {
    const availableClients = [];
    if (await this.ttsEdgeClient.init()) {
      availableClients.push(this.ttsEdgeClient);
    }
    if (this.ttsNativeClient && (await this.ttsNativeClient.init())) {
      availableClients.push(this.ttsNativeClient);
      this.ttsNativeVoices = await this.ttsNativeClient.getAllVoices();
    }
    if (await this.ttsWebClient.init()) {
      availableClients.push(this.ttsWebClient);
    }
    this.ttsClient = availableClients[0] || this.ttsWebClient;
    const preferredClientName = TTSUtils.getPreferredClient();
    if (preferredClientName) {
      const preferredClient = availableClients.find(
        (client) => client.name === preferredClientName,
      );
      if (preferredClient) {
        this.ttsClient = preferredClient;
      }
    }
    this.ttsWebVoices = await this.ttsWebClient.getAllVoices();
    this.ttsEdgeVoices = await this.ttsEdgeClient.getAllVoices();
  }

  #getPrimaryContent() {
    if (!this.#attached) return undefined;
    const contents = this.view.renderer.getContents();
    const primaryIndex = this.view.renderer.primaryIndex;
    return (contents.find((x) => x.index === primaryIndex) ?? contents[0]) as
      | {
          doc: Document;
          index?: number;
          overlayer?: Overlayer;
        }
      | undefined;
  }

  #getHighlighter() {
    return (range: Range) => {
      // Suppress the sentence highlight that foliate's setMark draws when the
      // active client highlights word-by-word. The flag is only set around the
      // synchronous setMark call, so word draws (dispatchSpeakWord) and paused
      // navigation still highlight normally.
      if (this.#suppressMarkHighlight) return;
      const content = this.#getPrimaryContent();
      if (!content) return;
      const { doc, index, overlayer } = content;
      if (!doc || index === undefined || index !== this.#ttsSectionIndex) {
        return;
      }
      try {
        const cfi = this.view.getCFI(index, range);
        const visibleRange = this.view.resolveCFI(cfi).anchor(doc);
        const { style, color } = this.options;
        overlayer?.remove(HIGHLIGHT_KEY);
        overlayer?.add(HIGHLIGHT_KEY, visibleRange, Overlayer[style], { color });
      } catch (e) {
        console.error('Failed to highlight range', e);
      }
    };
  }

  #clearHighlighter() {
    const content = this.#getPrimaryContent();
    const overlayer = content?.overlayer as Overlayer | undefined;
    overlayer?.remove(HIGHLIGHT_KEY);
  }

  updateHighlightOptions(options: TTSHighlightOptions) {
    this.options.style = options.style;
    this.options.color = options.color;
  }

  setHighlightGranularity(granularity: TTSHighlightGranularity) {
    this.#highlightGranularity = granularity;
  }

  async initViewTTS(index?: number) {
    if (this.#ttsSectionIndex === -1) {
      const fromSectionIndex = (index || this.#getPrimaryContent()?.index) ?? 0;
      await this.#initTTSForSection(fromSectionIndex);
    }
  }

  async #initTTSForSection(sectionIndex: number): Promise<boolean> {
    const sections = this.view.book.sections;
    if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
      return false;
    }

    const section = sections[sectionIndex];
    if (!section?.createDocument) {
      return false;
    }

    this.#ttsSectionIndex = sectionIndex;

    const currentSection = this.#getPrimaryContent();
    if (currentSection?.index !== sectionIndex) {
      await this.onSectionChange?.(sectionIndex);
    }

    let doc: Document;
    if (currentSection?.index === sectionIndex && currentSection?.doc) {
      doc = currentSection.doc;
    } else {
      doc = await section.createDocument();
      const html = doc.querySelector('html');
      const lang = html?.getAttribute('lang') || html?.getAttribute('xml:lang') || '';
      if (html && !isValidLang(lang) && this.ttsLang) {
        html.setAttribute('lang', this.ttsLang);
        html.setAttribute('xml:lang', this.ttsLang);
      }
    }

    // The section changed (or is initializing): any previous timeline maps a
    // dead document.
    this.#sectionTimeline = null;
    this.#timelineSectionIndex = -1;
    this.#currentSentenceIndex = -1;
    this.#ttsDoc = doc;

    const existing = this.#getTts();
    if (existing && existing.doc === doc) {
      this.#tts = existing;
      this.view.tts = existing;
      return true;
    }

    this.#tts = await this.#createTTS(doc, this.#getHighlighter());
    this.view.tts = this.#tts;
    ttsLog('section-tts-initialized', { section: sectionIndex });

    return true;
  }

  async #createTTS(doc: Document, highlighter: (range: Range) => void) {
    const { TTS } = await import('foliate-js/tts.js');
    const { textWalker } = await import('foliate-js/text-walker.js');
    let granularity: TTSGranularity = this.view.language.isCJK ? 'sentence' : 'word';
    const supportedGranularities = this.ttsClient.getGranularities();
    if (!supportedGranularities.includes(granularity)) {
      granularity = supportedGranularities[0]!;
    }
    this.#ttsGranularity = granularity;

    return new TTS(
      doc,
      textWalker,
      createRejectFilter({
        tags: ['rt', 'canvas', 'br'],
        // Footnotes/endnotes are hidden in the rendered page (see the
        // `.epubtype-footnote`/`aside[epub|type]` rules in getPageLayoutStyles);
        // skip them in TTS too, including for background sections whose
        // documents are loaded without those styles.
        classes: [
          'annotationLayer',
          'epubtype-footnote',
          'duokan-footnote-content',
          'duokan-footnote-item',
        ],
        attributeTokens: [
          {
            tag: 'aside',
            attribute: 'epub:type',
            tokens: ['footnote', 'endnote', 'note', 'rearnote'],
          },
        ],
        contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
      }),
      highlighter,
      granularity,
    );
  }

  // Build (or return) the virtual timeline for the current section. Edge-only:
  // it is the only client with measurable audio durations and a chunk clock.
  // Callers invoke this off the playback path (panel poll, media session).
  async ensureTimeline(): Promise<SectionTimeline | null> {
    if (this.ttsClient !== this.ttsEdgeClient) return null;
    if (this.#sectionTimeline && this.#timelineSectionIndex === this.#ttsSectionIndex) {
      return this.#sectionTimeline;
    }
    const doc = this.#ttsDoc;
    if (!doc || this.#ttsSectionIndex < 0) return null;
    const { getSentences } = await import('foliate-js/tts.js');
    const { textWalker } = await import('foliate-js/text-walker.js');
    const sentences: TimelineSentence[] = [];
    for (const entry of getSentences(
      doc,
      textWalker,
      createTTSNodeFilter(),
      this.#ttsGranularity,
    )) {
      sentences.push({ ...entry, text: entry.range.toString() });
    }
    const timeline = new SectionTimeline(
      sentences,
      this.ttsLang || 'en',
      this.ttsClient.getVoiceId(),
    );
    timeline.setRate(this.ttsRate);
    this.#sectionTimeline = timeline;
    this.#timelineSectionIndex = this.#ttsSectionIndex;
    return timeline;
  }

  // Whether the active client can ever produce a timeline (Edge only). The
  // scrubber renders a reserved disabled slot while true and info is still
  // null, and hides entirely while false.
  supportsPlaybackInfo(): boolean {
    return this.ttsClient === this.ttsEdgeClient;
  }

  // Position/duration of the current section playback at the current rate.
  // Null while no timeline exists (non-Edge client, timeline not yet built,
  // or nothing located yet) — the UI reserves a disabled slot for that state.
  getPlaybackInfo(): { position: number; duration: number; measuredFraction: number } | null {
    if (this.ttsClient !== this.ttsEdgeClient) return null;
    const timeline = this.#sectionTimeline;
    if (!timeline || this.#timelineSectionIndex !== this.#ttsSectionIndex) return null;
    const duration = timeline.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return null;
    let index = -1;
    const snapshot =
      this.ttsClient === this.ttsEdgeClient ? this.ttsEdgeClient.getPlaybackSnapshot() : null;
    const activeMark =
      snapshot?.mark ??
      (this.ttsClient === this.ttsEdgeClient ? this.ttsEdgeClient.getCurrentSpeakMark() : null);
    if (activeMark) {
      index = timeline.indexOfMark(activeMark);
    }
    if (index < 0) index = this.#currentSentenceIndex;
    if (index < 0 && this.#currentSpeakRange) {
      index = timeline.indexOfRange(this.#currentSpeakRange);
    }
    if (index < 0) {
      const range = this.#getTts()?.getLastRange();
      index = range ? timeline.indexOfRange(range) : -1;
    }
    if (index < 0) return null;
    const within = snapshot?.position ?? this.ttsClient.getChunkPosition?.() ?? 0;
    return {
      position: timeline.positionAt(index, within),
      duration,
      measuredFraction: timeline.getMeasuredFraction(),
    };
  }

  // Sentence-snapped seek through the same navigation machinery as prev/next:
  // foliate's from(range) returns the paragraph SSML sliced at the target
  // sentence, so highlighting, page-follow, and mark bookkeeping come free.
  async seekToTime(seconds: number): Promise<void> {
    await this.initViewTTS();
    const timeline = await this.ensureTimeline();
    if (!timeline) return;
    const target = timeline.sentenceAtTime(seconds);
    if (!target) return;
    const isPlaying = this.state === 'playing';
    await this.stop();
    if (!isPlaying) this.state = 'forward-paused';
    this.#currentSentenceIndex = target.index;
    const ssml = this.#getTts()?.from(target.sentence.range);
    await this.#handleNavigationWithSSML(ssml, isPlaying);
    if (!isPlaying) this.reapplyCurrentHighlight();
  }

  async #initTTSForNextSection(): Promise<boolean> {
    const nextIndex = this.#ttsSectionIndex + 1;
    const sections = this.view.book.sections;

    if (!sections || nextIndex >= sections.length) {
      return false;
    }

    return await this.#initTTSForSection(nextIndex);
  }

  async #initTTSForPrevSection(): Promise<boolean> {
    const prevIndex = this.#ttsSectionIndex - 1;

    if (prevIndex < 0) {
      return false;
    }

    return await this.#initTTSForSection(prevIndex);
  }

  async #handleNavigationWithSSML(ssml: string | undefined, isPlaying: boolean) {
    if (isPlaying) {
      this.#speak(ssml);
    } else {
      if (ssml) {
        const { marks } = parseSSMLMarks(ssml);
        if (marks.length > 0) {
          this.dispatchSpeakMark(marks[0]);
        }
      }
    }
  }

  async #handleNavigationWithoutSSML(initSection: () => Promise<boolean>, isPlaying: boolean) {
    if (await initSection()) {
      if (isPlaying) {
        this.#speak(this.#getTts()?.start());
      } else {
        this.#getTts()?.start();
      }
    } else {
      // No adjacent section in this direction: the session has run out of
      // content (end of book on forward, start of book on backward).
      this.#terminate('ended');
      await this.stop();
    }
  }

  async preloadSSML(ssml: string | undefined, signal: AbortSignal, startup = false) {
    if (!ssml) return;
    if (this.ttsClient === this.ttsEdgeClient) {
      const { marks } = parseSSMLMarks(ssml, this.ttsLang);
      const speakableMarks = marks.filter((mark) => hasSpeakableText(mark.text));
      if (speakableMarks.length === 0) return;
      // Explicit preload of imminent content: warm at 'high' (near) priority so
      // it is not starved by the low-priority deep look-ahead prefetch.
      await this.#preloadMarks(speakableMarks, signal, startup, 'high');
      return;
    }
    const iter = startup
      ? await this.ttsClient.speak(ssml, signal, true, true)
      : await this.ttsClient.speak(ssml, signal, true);
    for await (const _ of iter);
  }

  async #preloadMarks(
    marks: TTSMark[],
    signal: AbortSignal,
    startup = false,
    priority: WsSlotPriority = 'low',
    awaitAll = false,
  ) {
    if (marks.length === 0 || this.ttsClient !== this.ttsEdgeClient) return;
    const iter = this.ttsEdgeClient.speakMarks(marks, signal, true, startup, priority, awaitAll);
    for await (const _ of iter);
  }

  #appendSpeakableMarksFromSSML = (marks: TTSMark[], ssml: string) => {
    const parsed = parseSSMLMarks(ssml, this.ttsLang);
    for (const mark of parsed.marks) {
      if (!hasSpeakableText(mark.text)) continue;
      marks.push(mark);
    }
  };

  // Range of the mark currently being spoken. Prefer the controller snapshot:
  // it remains stable while foliate rebuilds its internal mark map.
  #getActiveSpeakRange(): Range | null {
    if (this.#currentSpeakRange) return this.#currentSpeakRange.cloneRange();
    return this.#getTts()?.getLastRange() ?? null;
  }

  #cancelPrefetch() {
    const controller = this.#prefetchAbortController;
    if (!controller) return;
    ttsLog('prefetch-cancel');
    controller.abort();
    if (this.#prefetchAbortController === controller) {
      this.#prefetchAbortController = null;
    }
    this.#prefetchInFlight = false;
  }

  #beginSpeakStartup(): number {
    const generation = ++this.#speakStartupGeneration;
    this.#speakStartupInProgress = true;
    this.#deferredPreloadNextSSML = false;
    return generation;
  }

  #finishSpeakStartup(generation: number, runDeferredPrefetch: boolean) {
    if (generation !== this.#speakStartupGeneration || !this.#speakStartupInProgress) return;
    this.#speakStartupInProgress = false;
    const shouldRunPrefetch =
      runDeferredPrefetch && this.#deferredPreloadNextSSML && this.state === 'playing';
    this.#deferredPreloadNextSSML = false;
    if (shouldRunPrefetch) {
      ttsLog('prefetch-resume-after-boundary');
      void this.preloadNextSSML();
    }
  }

  #requestPreloadNextSSML() {
    if (this.#speakStartupInProgress) {
      if (!this.#deferredPreloadNextSSML) {
        ttsLog('prefetch-defer-during-speak-start');
      }
      this.#deferredPreloadNextSSML = true;
      return;
    }
    void this.preloadNextSSML();
  }

  async #preloadRawParagraphs(
    rawSsmls: string[],
    signal: AbortSignal,
    distanceBase = 0,
  ): Promise<void> {
    const preloadOne = async (ssml: string | undefined, index: number): Promise<void> => {
      if (!ssml || signal.aborted || !hasTTSPrefetchCapacity()) return;
      const processed = await this.#preprocessSSML(ssml);
      if (!processed || signal.aborted || !hasTTSPrefetchCapacity()) return;
      const marks: TTSMark[] = [];
      this.#appendSpeakableMarksFromSSML(marks, processed);
      // Bounded, session-relative distance (paragraphs ahead of the currently
      // playing paragraph). Resets every prefetch walk, so it never grows
      // unbounded — it is only a diagnostic to see how far ahead a fetch is
      // relative to the playhead (e.g. "dist=+37 while playing dist=0" points
      // straight at a runaway look-ahead).
      if (marks.length > 0) {
        ttsLog('prefetch-paragraph', { dist: distanceBase + index, marks: marks.length });
      }
      // Deep look-ahead: 'low' priority (yields the reserved slot to the
      // playhead) and awaitAll so each paragraph fully completes before the
      // walk advances — no detached background fills accumulating behind the
      // current sentence.
      await this.#preloadMarks(marks, signal, false, 'low', true);
    };

    // Keep the near-playhead window strict: the next few paragraphs must be
    // cached in distance order before far-ahead workers are allowed to run.
    // Otherwise a failed/slow next paragraph can stall playback while much
    // later content is already occupying cache and WS slots.
    const nearCount = Math.min(PREFETCH_NEAR_PARAGRAPHS, rawSsmls.length);
    for (let index = 0; index < nearCount; index++) {
      await preloadOne(rawSsmls[index], index);
      if (signal.aborted || !hasTTSPrefetchCapacity()) return;
    }

    let nextIndex = nearCount;
    const worker = async () => {
      for (;;) {
        if (signal.aborted || !hasTTSPrefetchCapacity()) return;
        const index = nextIndex++;
        if (index >= rawSsmls.length) return;
        await preloadOne(rawSsmls[index], index);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(prefetchParallelism(), Math.max(0, rawSsmls.length - nearCount)) },
        () => worker(),
      ),
    );
  }

  async preloadNextSSML(
    targetSeconds: number = PREFETCH_TARGET_SECONDS,
    maxParagraphs: number = PREFETCH_MAX_PARAGRAPHS,
  ) {
    const tts = this.view.tts;
    if (!tts || this.#prefetchInFlight || !hasTTSPrefetchCapacity()) return;
    const abortController = new AbortController();
    this.#prefetchAbortController = abortController;
    this.#prefetchInFlight = true;
    try {
      await this.#preloadNextSSMLImpl(targetSeconds, maxParagraphs, abortController.signal);
    } finally {
      if (this.#prefetchAbortController === abortController) {
        this.#prefetchAbortController = null;
        this.#prefetchInFlight = false;
      }
    }
  }

  async #preloadNextSSMLImpl(
    targetSeconds: number = PREFETCH_TARGET_SECONDS,
    maxParagraphs: number = PREFETCH_MAX_PARAGRAPHS,
    signal: AbortSignal,
  ) {
    const tts = this.view.tts;
    if (!tts || signal.aborted || !hasTTSPrefetchCapacity()) return;

    // Gather the next SSMLs and rewind synchronously to avoid a race condition:
    // tts.next() replaces TTS.#ranges (used by setMark() during playback).
    // If async gaps exist between next()/prev() calls, a concurrent #speak()
    // can dispatch marks against the wrong #ranges, causing incorrect highlights
    // and accidental page turns. Stop once the estimated buffered speech reaches
    // the target so long paragraphs don't over-fetch and short ones still build
    // a real time-based buffer (bounded by maxParagraphs).
    const rawSsmls: string[] = [];
    let estimatedSeconds = 0;
    let rawSsmlChars = 0;
    for (
      let i = 0;
      i < maxParagraphs &&
      estimatedSeconds < targetSeconds &&
      rawSsmlChars < PREFETCH_MAX_RAW_SSML_CHARS &&
      !signal.aborted &&
      hasTTSPrefetchCapacity();
      i++
    ) {
      const ssml = tts.next();
      if (!ssml) break;
      rawSsmls.push(ssml);
      rawSsmlChars += ssml.length;
      estimatedSeconds += estimateSpeechDuration(ssml.replace(/<[^>]+>/g, ''), this.ttsRate);
    }
    for (let i = 0; i < rawSsmls.length; i++) {
      tts.prev();
    }

    await this.#preloadRawParagraphs(rawSsmls, signal, 0);
    if (signal.aborted || !hasTTSPrefetchCapacity()) return;

    // A chapter boundary must not shrink the offline window. Build isolated
    // TTS iterators for following sections, so look-ahead can continue without
    // changing view.tts or the current paragraph/highlight state.
    let paragraphCount = rawSsmls.length;
    const sections = this.view.book.sections;
    for (
      let sectionIndex = this.#ttsSectionIndex + 1;
      sections &&
      sectionIndex < sections.length &&
      paragraphCount < maxParagraphs &&
      estimatedSeconds < targetSeconds &&
      rawSsmlChars < PREFETCH_MAX_RAW_SSML_CHARS &&
      !signal.aborted &&
      hasTTSPrefetchCapacity();
      sectionIndex++
    ) {
      const section = sections[sectionIndex];
      if (!section?.createDocument) continue;
      const doc = await section.createDocument();
      if (signal.aborted) return;
      const html = doc.querySelector('html');
      const lang = html?.getAttribute('lang') || html?.getAttribute('xml:lang') || '';
      if (html && !isValidLang(lang) && this.ttsLang) {
        html.setAttribute('lang', this.ttsLang);
        html.setAttribute('xml:lang', this.ttsLang);
      }
      const sectionTTS = await this.#createTTS(doc, () => {});
      const sectionRawSsmls: string[] = [];
      let raw = sectionTTS.start();
      while (
        raw &&
        paragraphCount < maxParagraphs &&
        estimatedSeconds < targetSeconds &&
        rawSsmlChars < PREFETCH_MAX_RAW_SSML_CHARS &&
        !signal.aborted &&
        hasTTSPrefetchCapacity()
      ) {
        estimatedSeconds += estimateSpeechDuration(raw.replace(/<[^>]+>/g, ''), this.ttsRate);
        rawSsmlChars += raw.length;
        paragraphCount++;
        sectionRawSsmls.push(raw);
        raw = sectionTTS.next();
      }
      await this.#preloadRawParagraphs(
        sectionRawSsmls,
        signal,
        paragraphCount - sectionRawSsmls.length,
      );
    }
  }

  async #preprocessSSML(ssml?: string) {
    if (!ssml) return;
    ssml = ssml
      .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1')
      .replace(/[–—]/g, ',')
      .replace('<break/>', ' ')
      .replace(/\.{2,}/g, ' ')
      .replace(/。{2,}/g, ' ')
      .replace(/…+/g, ' ')
      .replace(/……/g, ' ')
      .replace(/\*/g, ' ')
      .replace(/·/g, ' ');

    if (this.ttsTargetLang) {
      ssml = filterSSMLWithLang(ssml, this.ttsTargetLang);
    }

    if (this.preprocessCallback) {
      ssml = await this.preprocessCallback(ssml);
    }

    return ssml;
  }

  async #speak(ssml: string | undefined | Promise<string>, oneTime = false) {
    const startupGeneration = oneTime ? 0 : this.#beginSpeakStartup();
    await this.stop(true);
    this.#terminated = false;
    const speakAbortController = new AbortController();
    this.#currentSpeakAbortController = speakAbortController;
    const { signal } = speakAbortController;

    const speakPromise = new Promise<void>(async (resolve, reject) => {
      try {
        const speakStartedAt = nowMs();
        ttsLog('speak-start');
        this.state = 'playing';

        signal.addEventListener('abort', () => {
          resolve();
        });

        const ssmlAwaitStartedAt = nowMs();
        const rawSsml = await ssml;
        ttsLog('speak-ssml-ready', {
          waitMs: elapsedMs(ssmlAwaitStartedAt),
          hasSsml: !!rawSsml,
          sinceStartMs: elapsedMs(speakStartedAt),
        });

        const preprocessStartedAt = nowMs();
        ssml = await this.#preprocessSSML(rawSsml);
        ttsLog('speak-preprocess-done', {
          ms: elapsedMs(preprocessStartedAt),
          textLen: ssml?.length ?? 0,
          sinceStartMs: elapsedMs(speakStartedAt),
        });
        if (!ssml) {
          this.#nossmlCnt++;
          // FIXME: in case we are at the end of the book, need a better way to handle this
          if (this.#nossmlCnt < 10 && this.state === 'playing' && !oneTime) {
            resolve();
            if (await this.#initTTSForNextSection()) {
              await this.forward();
            } else {
              // End of book: nothing left to speak.
              this.#terminate('ended');
              await this.stop();
            }
          }
          ttsLog('speak-no-ssml', { count: this.#nossmlCnt });
          return;
        } else {
          this.#nossmlCnt = 0;
        }

        const startup = !oneTime && !this.#hasStartedPlayback;
        const parseStartedAt = nowMs();
        const { marks } = parseSSMLMarks(ssml, this.ttsLang);
        const speakableMarks = marks.filter((mark) => hasSpeakableText(mark.text));
        ttsLog('speak-marks-ready', {
          ms: elapsedMs(parseStartedAt),
          marks: marks.length,
          speakable: speakableMarks.length,
          sinceStartMs: elapsedMs(speakStartedAt),
        });
        if (!oneTime) {
          if (speakableMarks.length === 0) {
            resolve();
            return await this.forward();
          } else {
            const markStartedAt = nowMs();
            this.dispatchSpeakMark(speakableMarks[0]);
            ttsLog('speak-initial-mark-done', {
              ms: elapsedMs(markStartedAt),
              sinceStartMs: elapsedMs(speakStartedAt),
            });
          }
          if (this.ttsClient === this.ttsEdgeClient) {
            // Paragraph-local marks guarantee preload and playback produce the
            // same Edge batch keys and keep foliate's cursor authoritative.
            // This is the sentence about to play, so warm it at 'high' priority:
            // it must never queue behind the low-priority deep look-ahead
            // prefetch for the shared WS slots (that priority inversion was a
            // primary cause of the current sentence stalling while far-ahead
            // sentences were being fetched).
            const preloadStartedAt = nowMs();
            ttsLog('speak-preload-start', {
              startup,
              marks: speakableMarks.length,
              sinceStartMs: elapsedMs(speakStartedAt),
            });
            await this.#preloadMarks(speakableMarks, signal, startup, 'high');
            ttsLog('speak-preload-done', {
              ms: elapsedMs(preloadStartedAt),
              sinceStartMs: elapsedMs(speakStartedAt),
            });
          } else {
            await this.preloadSSML(ssml, signal, startup);
          }
          this.#hasStartedPlayback = true;
        }
        // Only the native client surfaces an offline engine failure as a
        // terminal 'error' code (Edge/Web throw, which the catch below handles).
        const canSkipOnError = this.ttsClient === this.ttsNativeClient;
        const iter =
          this.ttsClient === this.ttsEdgeClient
            ? this.ttsEdgeClient.speakMarks(speakableMarks, signal, false, startup)
            : await this.ttsClient.speak(ssml, signal, false, startup);
        ttsLog('speak-playback-enter', {
          startup,
          sinceStartMs: elapsedMs(speakStartedAt),
        });
        let lastCode;
        let lastMessage: string | undefined;
        let firstBoundarySeen = false;
        for await (const { code, message } of iter) {
          if (signal.aborted) {
            resolve();
            return;
          }
          if (code === 'boundary' && !oneTime) {
            if (!firstBoundarySeen) {
              firstBoundarySeen = true;
              ttsLog('speak-first-boundary', { sinceStartMs: elapsedMs(speakStartedAt) });
            }
            this.#finishSpeakStartup(startupGeneration, true);
          }
          lastCode = code;
          lastMessage = message;
        }

        // Edge's own retry loop already exhausted its attempts (WS reset,
        // timeout, transient 5xx, or a permanently-unsynthesizable batch) by
        // the time this 'error' surfaces — retrying the same paragraph here
        // would just repeat the same multi-second stall. Skip forward like
        // any other engine failure rather than killing the whole session.
        const canSkipEdgeError = this.ttsClient === this.ttsEdgeClient && lastCode === 'error';

        if (lastCode === 'end' && this.state === 'playing' && !oneTime) {
          this.#consecutiveSpeakErrors = 0;
          resolve();
          await this.forward();
        } else if (lastCode === 'interrupted') {
          // Audio output device lost (e.g. Bluetooth headphones disconnected):
          // stop cleanly rather than continuing on a different output device.
          resolve();
          await this.stop();
        } else if (
          lastCode === 'error' &&
          (canSkipOnError || canSkipEdgeError) &&
          !signal.aborted &&
          this.state === 'playing' &&
          !oneTime
        ) {
          // The engine reported it can't speak this chunk — offline that's
          // almost always a specific unsynthesizable utterance (e.g. an
          // unsupported character), and for Edge it's almost always a single
          // flaky paragraph (network blip, WS reset, doomed punctuation-only
          // batch), neither of which retrying the identical request fixes.
          // Skip it and advance exactly as a normal 'end' would, so one bad
          // chunk (often the first utterance across a chapter boundary) can't
          // strand playback with the controls wedged in 'playing'. Bound
          // consecutive failures so a wholly-unusable engine/connection stops
          // gracefully instead of silently racing to the end of the book.
          // See #4613, #4408.
          ttsWarn('speak-skip-paragraph-after-error', { message: lastMessage });
          this.#consecutiveSpeakErrors++;
          resolve();
          if (this.#consecutiveSpeakErrors <= TTS_SPEAK_MAX_CONSECUTIVE_ERRORS) {
            await this.forward();
          } else {
            this.#consecutiveSpeakErrors = 0;
            this.#terminate('error');
            await this.stop();
          }
        }
        resolve();
      } catch (e) {
        if (signal.aborted) {
          resolve();
        } else {
          reject(e);
        }
      } finally {
        if (!oneTime) {
          this.#finishSpeakStartup(startupGeneration, false);
        }
        if (this.#currentSpeakAbortController === speakAbortController) {
          this.#currentSpeakAbortController.abort();
          this.#currentSpeakAbortController = null;
        }
      }
    });
    this.#currentSpeakPromise = speakPromise;

    await speakPromise.catch((e) => this.error(e));
  }

  async speak(ssml: string | Promise<string>, oneTime = false, oneTimeCallback?: () => void) {
    await this.initViewTTS();
    this.#speak(ssml, oneTime)
      .then(() => {
        if (oneTime && oneTimeCallback) {
          oneTimeCallback();
        }
      })
      .catch((e) => this.error(e));
    if (!oneTime) {
      this.#requestPreloadNextSSML();
      this.dispatchSpeakMark();
    }
  }

  play() {
    if (this.state !== 'playing') {
      this.start();
    } else {
      this.pause();
    }
  }

  async start() {
    await this.initViewTTS();
    // Always resume from the current list position instead of calling tts.start().
    // tts.start() resets the TTS list to position 0 (section beginning), which is
    // wrong when state transiently becomes 'stopped' during forward()/backward()
    // — a fast play tap in that window would otherwise jump back to section start.
    // tts.resume() falls back to tts.next() on a fresh TTS, so it's safe at init.
    const ssml = this.#getTts()?.resume();
    if (this.state.includes('paused')) {
      this.resume();
    }
    this.#speak(ssml);
    this.#requestPreloadNextSSML();
  }

  async pause() {
    this.state = 'paused';
    if (!(await this.ttsClient.pause().catch((e) => this.error(e)))) {
      await this.stop();
      this.state = 'stop-paused';
    }
  }

  async resume() {
    this.state = 'playing';
    await this.ttsClient.resume().catch((e) => this.error(e));
  }

  async stop(keepPrefetch = false) {
    if (!keepPrefetch) this.#cancelPrefetch();
    const speakAbortController = this.#currentSpeakAbortController;
    const speakPromise = this.#currentSpeakPromise;
    if (speakAbortController) {
      speakAbortController.abort();
    }
    await this.ttsClient.stop().catch((e) => this.error(e));

    if (speakPromise) {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stop operation timed out')), 3000),
      );
      await Promise.race([speakPromise.catch((e) => this.error(e)), timeout]).catch((e) =>
        this.error(e),
      );
      if (this.#currentSpeakPromise === speakPromise) {
        this.#currentSpeakPromise = null;
      }
    }
    if (this.#currentSpeakAbortController === speakAbortController) {
      this.#currentSpeakAbortController = null;
    }
    this.state = 'stopped';
    if (!keepPrefetch) {
      this.#speakStartupInProgress = false;
      this.#deferredPreloadNextSSML = false;
    }
  }

  // goto previous mark/paragraph
  async backward(byMark = false) {
    await this.initViewTTS();
    const isPlaying = this.state === 'playing';
    await this.stop();
    if (!isPlaying) this.state = 'backward-paused';

    const ssml = byMark ? this.#getTts()?.prevMark(!isPlaying) : this.#getTts()?.prev(!isPlaying);
    if (!ssml) {
      await this.#handleNavigationWithoutSSML(() => this.#initTTSForPrevSection(), isPlaying);
    } else {
      await this.#handleNavigationWithSSML(ssml, isPlaying);
    }
  }

  // goto next mark/paragraph
  async forward(byMark = false) {
    await this.initViewTTS();
    const isPlaying = this.state === 'playing';
    await this.stop(true);
    if (!isPlaying) this.state = 'forward-paused';

    const ssml = byMark ? this.#getTts()?.nextMark(!isPlaying) : this.#getTts()?.next(!isPlaying);
    if (!ssml) {
      await this.#handleNavigationWithoutSSML(() => this.#initTTSForNextSection(), isPlaying);
    } else {
      await this.#handleNavigationWithSSML(ssml, isPlaying);
    }
    if (isPlaying && !byMark) this.#requestPreloadNextSSML();
  }

  async setLang(lang: string) {
    this.ttsLang = lang;
    this.setPrimaryLang(lang);
  }

  async setPrimaryLang(lang: string) {
    if (this.ttsEdgeClient.initialized) this.ttsEdgeClient.setPrimaryLang(lang);
    if (this.ttsWebClient.initialized) this.ttsWebClient.setPrimaryLang(lang);
    if (this.ttsNativeClient?.initialized) this.ttsNativeClient?.setPrimaryLang(lang);
  }

  async setRate(rate: number) {
    this.ttsRate = rate;
    this.#sectionTimeline?.setRate(rate);
    await this.ttsClient.setRate(this.ttsRate);
  }

  async getVoices(lang: string) {
    const ttsWebVoices = await this.ttsWebClient.getVoices(lang);
    const ttsEdgeVoices = await this.ttsEdgeClient.getVoices(lang);
    const ttsNativeVoices = (await this.ttsNativeClient?.getVoices(lang)) ?? [];

    const voicesGroups = [...ttsNativeVoices, ...ttsEdgeVoices, ...ttsWebVoices];
    return voicesGroups;
  }

  async setVoice(voiceId: string, lang: string) {
    this.state = 'setvoice-paused';
    const useEdgeTTS = !!this.ttsEdgeVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    const useNativeTTS = !!this.ttsNativeVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    if (useEdgeTTS) {
      this.ttsClient = this.ttsEdgeClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else if (useNativeTTS) {
      if (!this.ttsNativeClient) {
        throw new Error('Native TTS client is not available');
      }
      this.ttsClient = this.ttsNativeClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else {
      this.ttsClient = this.ttsWebClient;
      await this.ttsClient.setRate(this.ttsRate);
    }
    TTSUtils.setPreferredClient(this.ttsClient.name);
    TTSUtils.setPreferredVoice(this.ttsClient.name, lang, voiceId);
    await this.ttsClient.setVoice(voiceId);
    // A different voice speaks at a different pace: re-estimate the timeline
    // under the new voice (measured durations are keyed per voice already).
    this.#sectionTimeline?.setVoice(this.ttsClient.getVoiceId());
  }

  getVoiceId() {
    return this.ttsClient.getVoiceId();
  }

  getSpeakingLang() {
    return this.ttsClient.getSpeakingLang();
  }

  setTargetLang(lang: string) {
    this.ttsTargetLang = lang;
  }

  getSpokenSentence(): { cfi: string; text: string } | null {
    const range = this.#getTts()?.getLastRange();
    if (!range || this.#ttsSectionIndex < 0) return null;
    try {
      const cfi = this.view.getCFI(this.#ttsSectionIndex, range);
      const text = range.toString().trim();
      if (!cfi || !text) return null;
      return { cfi, text };
    } catch {
      return null;
    }
  }

  // Canonical position signal emitted from the same paths as
  // tts-highlight-mark / tts-highlight-word. The controller is the source of
  // truth (it owns the section index and current word/sentence CFI).
  #dispatchPosition(cfi: string, kind: 'word' | 'sentence') {
    this.dispatchEvent(
      new CustomEvent('tts-position', {
        detail: {
          cfi,
          kind,
          sectionIndex: this.#ttsSectionIndex,
          sequence: ++ttsPositionSequence,
        },
      }),
    );
  }

  dispatchSpeakMark(mark?: TTSMark) {
    this.#resetSpeakWords();
    this.dispatchEvent(new CustomEvent('tts-speak-mark', { detail: mark || { text: '' } }));
    if (mark && mark.name !== '-1') {
      try {
        // When the active client highlights word-by-word, suppress the
        // sentence highlight that setMark would otherwise draw, so the page
        // doesn't flash the whole sentence before the first word. The fallback
        // (no boundaries) is drawn later in prepareSpeakWords. When the user
        // forces sentence granularity we keep the sentence highlight, so don't
        // suppress it.
        this.#suppressMarkHighlight =
          this.ttsClient.supportsWordBoundaries() && this.#highlightGranularity === 'word';
        const suppressSentenceHighlight = this.#suppressMarkHighlight;
        const range = mark.range ? mark.range.cloneRange() : this.#getTts()?.setMark(mark.name);
        this.#suppressMarkHighlight = false;
        this.#speakWordsArmed = !!range;
        this.#currentSpeakRange = range ?? null;
        // Captured ranges bypass setMark (and its highlight); draw the sentence
        // here unless word mode will take over in prepareSpeakWords.
        if (range && mark.range && !suppressSentenceHighlight) {
          this.#getHighlighter()(range.cloneRange());
        }
        if (this.#sectionTimeline) {
          // Keep the timeline honest as measurements land, then locate the
          // audible sentence for position reporting.
          this.#sectionTimeline.refresh();
          this.#currentSentenceIndex = this.#sectionTimeline.indexOfMark(mark);
          if (this.#currentSentenceIndex < 0 && range) {
            this.#currentSentenceIndex = this.#sectionTimeline.indexOfRange(range);
          }
        }
        const cfi = this.view.getCFI(this.#ttsSectionIndex, range);
        this.dispatchEvent(new CustomEvent('tts-highlight-mark', { detail: { cfi } }));
        this.#dispatchPosition(cfi, 'sentence');
        if (this.state === 'playing') {
          this.#requestPreloadNextSSML();
        }
      } catch {
        this.#suppressMarkHighlight = false;
      }
    }
  }

  #resetSpeakWords() {
    this.#speakWordsArmed = false;
    this.#speakWordBaseRange = null;
    this.#speakWordOffsets = [];
    this.#speakWordRanges = [];
    this.#wordHighlightActive = false;
    this.#lastSpeakWordRange = null;
  }

  // Re-apply the active highlight after the view relocates (page turn,
  // re-render). In word mode this re-draws the current word so the sentence
  // never reappears over it; otherwise it re-draws the sentence.
  reapplyCurrentHighlight() {
    if (!this.#attached) return;
    if (this.#wordHighlightActive && this.#lastSpeakWordRange) {
      this.#getHighlighter()(this.#lastSpeakWordRange.cloneRange());
      return;
    }
    const range = this.#getActiveSpeakRange();
    if (range) this.#getHighlighter()(range);
  }

  // CFI of the currently highlighted word during word-by-word playback. Used
  // for the "in view" check that drives the back-to-TTS button: when a sentence
  // spans a page break, the word can be on a different page than the sentence's
  // ttsLocation, so the word position is the accurate reference. Returns null
  // outside word mode, where the sentence-level ttsLocation is correct.
  getCurrentHighlightCfi(): string | null {
    if (!this.#attached) return null;
    if (!this.#wordHighlightActive || !this.#lastSpeakWordRange || this.#ttsSectionIndex < 0) {
      return null;
    }
    try {
      return this.view.getCFI(this.#ttsSectionIndex, this.#lastSpeakWordRange) || null;
    } catch {
      return null;
    }
  }

  // Re-emit the controller's current position on the canonical 'tts-position'
  // signal with a fresh (monotonic) sequence. Lets a follower that engages
  // mid-session (paragraph / RSVP mode entered while TTS is already playing or
  // paused) sync to the current position without waiting for the next word or
  // sentence boundary. Mirrors reapplyCurrentHighlight's word-vs-sentence
  // choice, but dispatches a position instead of drawing a highlight.
  redispatchPosition() {
    if (this.#ttsSectionIndex < 0) return;
    if (this.#wordHighlightActive && this.#lastSpeakWordRange) {
      try {
        const cfi = this.view.getCFI(this.#ttsSectionIndex, this.#lastSpeakWordRange);
        if (cfi) {
          this.#dispatchPosition(cfi, 'word');
          return;
        }
      } catch {}
    }
    const range = this.#getActiveSpeakRange();
    if (!range) return;
    try {
      const cfi = this.view.getCFI(this.#ttsSectionIndex, range);
      if (cfi) this.#dispatchPosition(cfi, 'sentence');
    } catch {}
  }

  // Word-level highlighting within the chunk of the last dispatched mark,
  // driven by TTS clients that report word boundaries (Edge TTS). It only
  // swaps the visual highlight from the sentence to the spoken word —
  // ttsLocation, media-session metadata and mark navigation keep their
  // sentence-level semantics.
  prepareSpeakWords(words: string[]) {
    if (!this.#speakWordsArmed) return;
    // User forced sentence-level highlighting: the sentence highlight was drawn
    // at mark dispatch (not suppressed), so there's nothing to do here — leave
    // word mode off even though the client reported word boundaries.
    if (this.#highlightGranularity === 'sentence') return;
    const range = this.#getActiveSpeakRange();
    if (!range) return;
    this.#speakWordBaseRange = range;
    const matchText = rangeTextExcludingInert(range);
    this.#speakWordOffsets = computeWordOffsets(matchText, words);
    this.#speakWordRanges = [];
    if (process.env.NODE_ENV !== 'production') {
      // Dev-only trace of the Edge word-sync: each spoken (boundary) word vs the
      // text it actually highlights. A drifted or "(unmatched)" mapping — or an
      // empty word list — pinpoints word-highlight bugs without instrumenting
      // the overlayer by hand. `process.env.NODE_ENV` is statically inlined, so
      // this whole block is dropped from production builds.
      const mapping = words.map((word, i) => {
        const offset = this.#speakWordOffsets[i];
        const highlighted = offset
          ? getTextSubRange(range, offset.start, offset.end)?.toString()
          : '';
        return { spoken: word, highlighted: highlighted || '(unmatched)' };
      });
      ttsLog('word-sync', { textLen: matchText.length, words: mapping.length });
    }
    if (words.length === 0) {
      // No word boundaries for this chunk: the sentence highlight was
      // suppressed at mark dispatch, so draw it now as the fallback.
      this.#wordHighlightActive = false;
      this.#getHighlighter()(range.cloneRange());
    } else {
      // Highlight the first word immediately so the suppressed sentence
      // highlight never appears before playback reaches the first boundary.
      this.#wordHighlightActive = true;
      this.dispatchSpeakWord(0);
    }
  }

  dispatchSpeakWord(index: number) {
    const base = this.#speakWordBaseRange;
    if (!base) return;
    let range = this.#speakWordRanges[index];
    if (range === undefined) {
      const offset = this.#speakWordOffsets[index];
      range = offset ? getTextSubRange(base, offset.start, offset.end) : null;
      this.#speakWordRanges[index] = range;
    }
    if (range) {
      this.#lastSpeakWordRange = range;
      this.#getHighlighter()(range.cloneRange());
      // Let the view follow the spoken word so it turns the page mid-sentence
      // when the word crosses a page boundary, instead of waiting for the next
      // sentence's mark.
      try {
        const cfi = this.view.getCFI(this.#ttsSectionIndex, range);
        if (cfi) {
          this.dispatchEvent(new CustomEvent('tts-highlight-word', { detail: { cfi } }));
          this.#dispatchPosition(cfi, 'word');
        }
      } catch {}
    }
  }

  error(e: unknown) {
    // AbortError is expected during normal stop/restart cycles (rate change,
    // forward/backward, voice change) — on iOS especially, the in-flight
    // audio.play() promise rejects with AbortError after audio.src is reset,
    // and that rejection can leak through one of the .catch chains. Letting it
    // flip state to 'stopped' desyncs the state machine: handleSetRate's
    // `state === 'playing'` check then falls through to a no-op, and #speak's
    // auto-forward gate skips advancing to the next paragraph.
    if (e instanceof Error && (e.name === 'AbortError' || e.message === 'Aborted')) {
      return;
    }
    console.error(e);
    this.#terminate('error');
    this.state = 'stopped';
  }

  async shutdown() {
    await this.stop();
    this.#clearHighlighter();
    this.#ttsSectionIndex = -1;
    this.#sectionTimeline = null;
    this.#timelineSectionIndex = -1;
    this.#currentSentenceIndex = -1;
    this.#ttsDoc = null;
    this.#tts = null;
    this.view.tts = null;
    if (this.ttsWebClient.initialized) {
      await this.ttsWebClient.shutdown();
    }
    if (this.ttsEdgeClient.initialized) {
      await this.ttsEdgeClient.shutdown();
    }
    if (this.ttsNativeClient?.initialized) {
      await this.ttsNativeClient.shutdown();
    }
  }
}
