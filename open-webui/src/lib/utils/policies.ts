// Pure helpers for the policy authoring UI. Kept free of Svelte/fetch
// imports so they're unit-testable in a plain node vitest environment.

const EPOCH_NS_TO_MS = 1_000_000;

/**
 * Client-side filter for the policy list: case-insensitive name match +
 * optional status filter ('all' shows everything).
 */
export const filterPolicies = <T extends { name: string; status: string }>(
	items: T[],
	query: string,
	status: string
): T[] => {
	const q = query.trim().toLowerCase();
	return items.filter((item) => {
		if (status !== 'all' && item.status !== status) return false;
		if (q && !item.name.toLowerCase().includes(q)) return false;
		return true;
	});
};

/** epoch-ns timestamp -> locale date string ('' for null/undefined). */
export const formatEpochNs = (ns: number | null | undefined): string => {
	if (ns === null || ns === undefined) return '';
	return new Date(Number(ns) / EPOCH_NS_TO_MS).toLocaleDateString();
};

/** epoch-ns timestamp -> locale date + time string ('' for null/undefined). */
export const formatEpochNsTime = (ns: number | null | undefined): string => {
	if (ns === null || ns === undefined) return '';
	return new Date(Number(ns) / EPOCH_NS_TO_MS).toLocaleString();
};

/**
 * Trailing-edge debounce (calls fn `delay` ms after the last invocation).
 * The returned function has a `.cancel()` to drop a pending call.
 */
export const debounce = <A extends unknown[]>(fn: (...args: A) => void, delay: number) => {
	let timer: ReturnType<typeof setTimeout> | null = null;

	const debounced = (...args: A) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, delay);
	};

	debounced.cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	return debounced;
};
