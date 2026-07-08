import { describe, test, expect, vi } from 'vitest';
import { FIFOCache, LRUCache } from '@/utils/lru';

describe('LRUCache', () => {
  describe('constructor', () => {
    test('creates cache with valid capacity', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.size()).toBe(0);
    });

    test('throws when capacity is 0', () => {
      expect(() => new LRUCache<string, number>(0)).toThrow(
        'LRUCache capacity must be greater than 0',
      );
    });

    test('throws when capacity is negative', () => {
      expect(() => new LRUCache<string, number>(-1)).toThrow(
        'LRUCache capacity must be greater than 0',
      );
    });

    test('throws when capacity is -Infinity', () => {
      expect(() => new LRUCache<string, number>(-Infinity)).toThrow(
        'LRUCache capacity must be greater than 0',
      );
    });
  });

  describe('set and get', () => {
    test('stores and retrieves a value', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
    });

    test('returns undefined for missing key', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    test('updates value for existing key', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('a', 2);
      expect(cache.get('a')).toBe(2);
      expect(cache.size()).toBe(1);
    });

    test('stores multiple values up to capacity', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size()).toBe(3);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });

    test('works with non-string keys', () => {
      const cache = new LRUCache<number, string>(2);
      cache.set(42, 'answer');
      expect(cache.get(42)).toBe('answer');
    });

    test('works with object values', () => {
      const cache = new LRUCache<string, { name: string }>(2);
      const obj = { name: 'test' };
      cache.set('key', obj);
      expect(cache.get('key')).toBe(obj);
    });
  });

  describe('eviction', () => {
    test('evicts oldest entry when capacity exceeded', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.has('a')).toBe(false);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.size()).toBe(2);
    });

    test('evicts correct entry after get reorders', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      // Access 'a' to make it most recently used
      cache.get('a');
      // Now 'b' is oldest, so 'b' should be evicted
      cache.set('c', 3);
      expect(cache.has('b')).toBe(false);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('c')).toBe(3);
    });

    test('evicts multiple entries as new ones are added', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      cache.set('d', 4); // evicts 'b'
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('evicts falsy keys when they are the oldest entry', () => {
      const cache = new LRUCache<number, string>(2);
      cache.set(0, 'zero');
      cache.set(1, 'one');
      cache.set(2, 'two');

      expect(cache.has(0)).toBe(false);
      expect(cache.entries()).toEqual([
        [2, 'two'],
        [1, 'one'],
      ]);
    });

    test('updating existing key does not trigger capacity eviction', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10); // update, not a new entry
      expect(cache.size()).toBe(2);
      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBe(2);
    });
  });

  describe('capacity 1', () => {
    test('holds exactly one entry', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('a', 1);
      expect(cache.size()).toBe(1);
      expect(cache.get('a')).toBe(1);
    });

    test('evicts the only entry when a new one is added', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.has('a')).toBe(false);
      expect(cache.get('b')).toBe(2);
      expect(cache.size()).toBe(1);
    });

    test('get on missing key does not disrupt state', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('a', 1);
      expect(cache.get('missing')).toBeUndefined();
      expect(cache.get('a')).toBe(1);
    });
  });

  describe('has', () => {
    test('returns true for existing key', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
    });

    test('returns false for missing key', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.has('a')).toBe(false);
    });

    test('returns false for evicted key', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.has('a')).toBe(false);
    });

    test('does not promote key (no LRU reorder)', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.has('a'); // should NOT move 'a' to most recent
      cache.set('c', 3); // should evict 'a' (still oldest)
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
    });
  });

  describe('delete', () => {
    test('removes an existing key and returns true', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
      expect(cache.has('a')).toBe(false);
      expect(cache.size()).toBe(0);
    });

    test('returns false for missing key', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.delete('nonexistent')).toBe(false);
    });

    test('frees capacity for new entries after deletion', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.delete('a');
      cache.set('c', 3);
      // 'b' should still be present since we freed a slot
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.size()).toBe(2);
    });
  });

  describe('clear', () => {
    test('removes all entries', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(false);
    });

    test('clearing empty cache is a no-op', () => {
      const cache = new LRUCache<string, number>(3);
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    test('cache is usable after clear', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.clear();
      cache.set('b', 2);
      expect(cache.size()).toBe(1);
      expect(cache.get('b')).toBe(2);
    });
  });

  describe('size', () => {
    test('returns 0 for empty cache', () => {
      const cache = new LRUCache<string, number>(5);
      expect(cache.size()).toBe(0);
    });

    test('tracks insertions', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.size()).toBe(1);
      cache.set('b', 2);
      expect(cache.size()).toBe(2);
    });

    test('does not exceed capacity', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size()).toBe(2);
    });

    test('decreases on delete', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.delete('a');
      expect(cache.size()).toBe(1);
    });
  });

  describe('entries', () => {
    test('returns empty array for empty cache', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.entries()).toEqual([]);
    });

    test('returns entries in most-recent-first order', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.entries()).toEqual([
        ['c', 3],
        ['b', 2],
        ['a', 1],
      ]);
    });

    test('reflects LRU reorder after get', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // move 'a' to most recent
      expect(cache.entries()).toEqual([
        ['a', 1],
        ['c', 3],
        ['b', 2],
      ]);
    });

    test('reflects order after update via set', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('a', 10); // update 'a', moves to most recent
      expect(cache.entries()).toEqual([
        ['a', 10],
        ['c', 3],
        ['b', 2],
      ]);
    });

    test('reflects eviction', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      expect(cache.entries()).toEqual([
        ['c', 3],
        ['b', 2],
      ]);
    });
  });

  describe('onEvict callback', () => {
    test('called when entry is evicted due to capacity', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    test('not called when entry is updated via set', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.set('a', 1);
      cache.set('a', 2); // update should not call onEvict
      expect(onEvict).not.toHaveBeenCalled();
      expect(cache.get('a')).toBe(2);
    });

    test('called when entry is deleted', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.set('a', 1);
      cache.delete('a');
      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    test('not called when delete returns false', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.delete('nonexistent');
      expect(onEvict).not.toHaveBeenCalled();
    });

    test('called for each entry on clear', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(3, onEvict);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(onEvict).toHaveBeenCalledTimes(3);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
      expect(onEvict).toHaveBeenCalledWith('b', 2);
      expect(onEvict).toHaveBeenCalledWith('c', 3);
    });

    test('not called on clear when cache is empty', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(3, onEvict);
      cache.clear();
      expect(onEvict).not.toHaveBeenCalled();
    });

    test('tracks all eviction events across operations', () => {
      const evicted: Array<[string, number]> = [];
      const onEvict = (key: string, value: number) => {
        evicted.push([key, value]);
      };
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      cache.set('b', 20); // updates 'b', does NOT evict (no onEvict on update)
      cache.delete('c'); // deletes 'c'
      cache.clear(); // clears 'b'

      expect(evicted).toEqual([
        ['a', 1],
        ['c', 3],
        ['b', 20],
      ]);
    });

    test('not called on get', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.set('a', 1);
      cache.get('a');
      cache.get('nonexistent');
      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  describe('LRU ordering stress', () => {
    test('repeated gets maintain correct eviction order', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Access in order: b, a, c
      cache.get('b');
      cache.get('a');
      cache.get('c');

      // Now order from oldest to newest: b, a, c
      // Adding 'd' should evict 'b'
      cache.set('d', 4);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    test('set on existing key moves it to most recent', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('a', 10); // 'a' becomes most recent

      // oldest is 'b', then 'c', then 'a'
      cache.set('d', 4); // evicts 'b'
      expect(cache.has('b')).toBe(false);

      cache.set('e', 5); // evicts 'c'
      expect(cache.has('c')).toBe(false);

      expect(cache.has('a')).toBe(true);
      expect(cache.has('d')).toBe(true);
      expect(cache.has('e')).toBe(true);
    });

    test('interleaved get and set maintains correct order', () => {
      const evictedKeys: string[] = [];
      const cache = new LRUCache<string, number>(3, (key) => {
        evictedKeys.push(key);
      });

      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // order: b, c, a
      cache.set('d', 4); // evicts b; order: c, a, d
      cache.get('c'); // order: a, d, c
      cache.set('e', 5); // evicts a; order: d, c, e

      expect(evictedKeys).toEqual(['b', 'a']);
      expect(cache.entries()).toEqual([
        ['e', 5],
        ['c', 3],
        ['d', 4],
      ]);
    });
  });
});

describe('FIFOCache', () => {
  test('evicts oldest-inserted entry regardless of access frequency', () => {
    const cache = new FIFOCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Access 'a' — in LRU this would protect it, in FIFO it does not
    cache.get('a');
    cache.get('a');
    cache.get('a');
    cache.set('d', 4); // should evict 'a' (oldest insertion), not 'b' or 'c'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  test('prefetched future entries survive while played entries get evicted', () => {
    // Simulates TTS playback: items added in order 1..5, then 1 and 2 are
    // accessed (played). When 6 is added, 1 must be evicted, not 5.
    const cache = new FIFOCache<number, string>(5);
    for (let i = 1; i <= 5; i++) cache.set(i, `s${i}`);
    cache.get(1); // "play" sentence 1
    cache.get(2); // "play" sentence 2
    cache.set(6, 's6'); // evicts 1 (oldest insertion)
    expect(cache.has(1)).toBe(false);
    expect(cache.has(5)).toBe(true); // future sentence survives
    expect(cache.has(6)).toBe(true);
  });

  test('get returns without promoting: eviction order is pure insertion order', () => {
    const evicted: number[] = [];
    const cache = new FIFOCache<number, string>(2, (k) => evicted.push(k));
    cache.set(1, 'a');
    cache.set(2, 'b');
    cache.get(1); // no promotion
    cache.set(3, 'c'); // evicts 1 (first inserted), not 2
    cache.set(4, 'd'); // evicts 2
    expect(evicted).toEqual([1, 2]);
  });

  test('set on existing key updates value in-place without changing order', () => {
    const cache = new FIFOCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99); // update — should NOT promote 'a'
    cache.set('c', 3); // should evict 'a' (still oldest)
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  test('entries returns newest-first (mirrors LRUCache API)', () => {
    const cache = new FIFOCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.entries()).toEqual([
      ['c', 3],
      ['b', 2],
      ['a', 1],
    ]);
  });

  test('onEvict callback fires on capacity eviction and explicit delete', () => {
    const onEvict = vi.fn();
    const cache = new FIFOCache<string, number>(2, onEvict);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(onEvict).toHaveBeenCalledWith('a', 1);
    cache.delete('b');
    expect(onEvict).toHaveBeenCalledWith('b', 2);
    expect(onEvict).toHaveBeenCalledTimes(2);
  });

  test('throws when capacity is 0 or negative', () => {
    expect(() => new FIFOCache<string, number>(0)).toThrow();
    expect(() => new FIFOCache<string, number>(-1)).toThrow();
  });
});
