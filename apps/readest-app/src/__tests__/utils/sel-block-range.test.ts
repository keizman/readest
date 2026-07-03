import { describe, it, expect } from 'vitest';
import { getBlockRangeFromPoint } from '@/utils/sel';

// jsdom implements neither caret*FromPoint nor a real hit-test, so we drive the
// block-climbing logic by stubbing elementFromPoint (the function's fallback).
describe('getBlockRangeFromPoint', () => {
  it('returns a collapsed range at the start of the enclosing block', () => {
    document.body.innerHTML = '<p id="p"><span id="s">Hello world</span></p>';
    const span = document.getElementById('s')!;
    const p = document.getElementById('p')!;
    document.elementFromPoint = () => span;

    const range = getBlockRangeFromPoint(document, 10, 10);
    expect(range).not.toBeNull();
    expect(range!.collapsed).toBe(true);
    expect(range!.startContainer).toBe(p);
    expect(range!.startOffset).toBe(0);
  });

  it('returns null when no block-level ancestor exists', () => {
    document.body.innerHTML = '';
    document.elementFromPoint = () => null;
    expect(getBlockRangeFromPoint(document, 5, 5)).toBeNull();
  });
});
