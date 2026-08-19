import { describe, expect, it, vi } from 'vitest';

import { debounce } from '@/util/events';

/**
 * The panel that closes while a keystroke is still pending is the case this
 * exists for: without a flush, what you typed goes down with it.
 */
describe('debounce', () => {
  it('runs once after the pause, with the last arguments', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fn = debounce((value: string) => calls.push(value), 100);

    fn('a');
    fn('b');
    vi.advanceTimersByTime(99);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['b']);
    vi.useRealTimers();
  });

  it('flushes a pending call immediately', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fn = debounce((value: string) => calls.push(value), 100);

    fn('typed');
    fn.flush();
    expect(calls).toEqual(['typed']);

    // And the timer is gone, so it does not fire a second time.
    vi.advanceTimersByTime(200);
    expect(calls).toEqual(['typed']);
    vi.useRealTimers();
  });

  it('flushes nothing when nothing is pending', () => {
    const calls: number[] = [];
    const fn = debounce(() => calls.push(1), 100);
    fn.flush();
    expect(calls).toEqual([]);
  });

  it('drops a pending call on cancel', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const fn = debounce(() => calls.push(1), 100);
    fn();
    fn.cancel();
    fn.flush();
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });
});
