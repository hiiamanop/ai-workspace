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
