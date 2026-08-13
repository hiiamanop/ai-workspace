import { writable } from 'svelte/store';
import type { Policy, PolicyListItem } from '$lib/apis/policies';

// Policy authoring UI state. Pages write to these; components read them.
export const policies = writable<PolicyListItem[]>([]);

// The policy currently open in the editor (last known server state).
export const currentPolicy = writable<Policy | null>(null);

export type AsyncStatus = 'idle' | 'working' | 'success' | 'error';

export const compileStatus = writable<AsyncStatus>('idle');
export const compileError = writable<string | null>(null);

export const saveStatus = writable<AsyncStatus>('idle');
export const saveError = writable<string | null>(null);

export const deployStatus = writable<AsyncStatus>('idle');
export const deployError = writable<string | null>(null);

export const rollbackStatus = writable<AsyncStatus>('idle');
export const rollbackError = writable<string | null>(null);

/**
 * Reset all transient per-policy status/error stores to idle. The stores are
 * module-level, so stale state from a previously viewed policy (✓ Compiled,
 * stuck 'working', old errors) would otherwise leak into the next one.
 * Called at the top of the editor's onMount.
 */
export const resetPolicyStatuses = () => {
	compileStatus.set('idle');
	compileError.set(null);
	saveStatus.set('idle');
	saveError.set(null);
	deployStatus.set('idle');
	deployError.set(null);
	rollbackStatus.set('idle');
	rollbackError.set(null);
};
