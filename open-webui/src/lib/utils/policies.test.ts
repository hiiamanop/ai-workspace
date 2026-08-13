import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, filterPolicies, formatEpochNs, formatEpochNsTime } from './policies';

describe('filterPolicies', () => {
	const items = [
		{ id: 'a', name: 'Budget Policy', status: 'draft', created_at: 1 },
		{ id: 'b', name: 'Safety Policy', status: 'active', created_at: 2 },
		{ id: 'c', name: 'safety-critical', status: 'draft', created_at: 3 }
	];

	it('returns everything with no query and status=all', () => {
		expect(filterPolicies(items, '', 'all')).toHaveLength(3);
	});

	it('filters by status', () => {
		expect(filterPolicies(items, '', 'draft')).toEqual([items[0], items[2]]);
		expect(filterPolicies(items, '', 'active')).toEqual([items[1]]);
	});

	it('matches name case-insensitively', () => {
		expect(filterPolicies(items, 'safety', 'all')).toEqual([items[1], items[2]]);
	});

	it('combines query and status', () => {
		expect(filterPolicies(items, 'safety', 'draft')).toEqual([items[2]]);
	});

	it('does not crash on empty input', () => {
		expect(filterPolicies([], 'x', 'all')).toEqual([]);
	});
});

describe('formatEpochNs', () => {
	it('converts epoch nanoseconds to a locale date string', () => {
		const ns = Date.UTC(2026, 7, 13, 12, 0, 0) * 1_000_000; // 2026-08-13
		expect(formatEpochNs(ns)).toBe(new Date(Date.UTC(2026, 7, 13, 12, 0, 0)).toLocaleDateString());
	});

	it('returns empty string for null/undefined', () => {
		expect(formatEpochNs(null)).toBe('');
		expect(formatEpochNs(undefined)).toBe('');
	});

	it('formatEpochNsTime includes time', () => {
		const ns = Date.UTC(2026, 7, 13, 12, 0, 0) * 1_000_000;
		expect(formatEpochNsTime(ns)).toBe(new Date(Date.UTC(2026, 7, 13, 12, 0, 0)).toLocaleString());
		expect(formatEpochNsTime(null)).toBe('');
	});
});

describe('debounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('only calls fn after the delay has elapsed since the last call', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 500);

		debounced('a');
		debounced('b');
		vi.advanceTimersByTime(499);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith('b');
	});

	it('resets the timer on every call (trailing edge)', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 100);

		debounced();
		vi.advanceTimersByTime(90);
		debounced();
		vi.advanceTimersByTime(90);
		debounced();
		vi.advanceTimersByTime(99);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('cancel() drops a pending call', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 100);

		debounced();
		debounced.cancel();
		vi.advanceTimersByTime(200);
		expect(fn).not.toHaveBeenCalled();
	});
});
