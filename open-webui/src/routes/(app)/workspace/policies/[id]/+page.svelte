<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { user } from '$lib/stores';
	import {
		ApiError,
		compilePolicy,
		deletePolicy,
		deployPolicy,
		fetchPolicy,
		rollbackPolicy,
		updatePolicy
	} from '$lib/apis/policies';
	import { debounce } from '$lib/utils/policies';
	import {
		compileError,
		compileStatus,
		currentPolicy,
		deployError,
		deployStatus,
		resetPolicyStatuses,
		rollbackError,
		rollbackStatus,
		saveError,
		saveStatus
	} from '$lib/stores/policies';
	import ConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';

	const policyId = $page.params.id as string;

	// Editing buffer — the store keeps last-known server state.
	let markdown = '';
	let dirty = false;
	let loaded = false;
	let fetchError: string | null = null;
	let notFound = false;
	let redirectTimer: ReturnType<typeof setTimeout> | null = null;

	let banner: { type: 'success' | 'error'; text: string } | null = null;
	let dialog: 'deploy' | 'rollback' | 'delete' | null = null;

	$: status = $currentPolicy?.status ?? 'draft';
	$: locked = status === 'active';

	// Refetches (after deploy/rollback) run with loaded=true so the editor
	// stays visible; only the initial load shows the "Loading…" state.
	const loadPolicy = async () => {
		fetchError = null;
		notFound = false;
		try {
			const policy = await fetchPolicy(localStorage.token, policyId);
			// Late response for a different policy (user navigated away while
			// this fetch was in flight) must not write into the new policy's
			// view — same lifetime bug class as the citation-state gotcha.
			if (policy.id !== policyId) return;
			currentPolicy.set(policy);
			markdown = policy.markdown_content;
			dirty = false;
			loaded = true;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				notFound = true;
				redirectTimer = setTimeout(() => goto('/workspace/policies'), 2000);
			} else if (e instanceof ApiError && e.status === 403) {
				fetchError = 'Admin access required. You do not have permission to manage policies.';
			} else if (!loaded) {
				fetchError =
					e instanceof ApiError ? e.message : 'Connection lost. Please check your connection and retry.';
			}
			// Refetch failure with a loaded editor: keep the current view —
			// the deploy/rollback error banner already explains what failed.
		}
	};

	const doSave = async (): Promise<boolean> => {
		if (!dirty) return true;
		saveStatus.set('working');
		saveError.set(null);
		try {
			const updated = await updatePolicy(localStorage.token, policyId, markdown);
			// Id-guard: a save for policy A landing after navigation to B must
			// not write A's data into B's view.
			currentPolicy.update((p) => (p && p.id === policyId ? { ...p, ...updated } : p));
			dirty = false;
			saveStatus.set('success');
			return true;
		} catch (e) {
			saveStatus.set('error');
			saveError.set(e instanceof ApiError ? e.message : 'Connection lost. Please retry.');
			return false;
		}
	};

	const doCompile = async (): Promise<boolean> => {
		if (!loaded || status !== 'draft') return true;
		compileStatus.set('working');
		compileError.set(null);
		try {
			const res = await compilePolicy(localStorage.token, policyId);
			// Id-guard, same as doSave: a compile response for policy A must
			// not write A's compiled_rego into B's preview.
			currentPolicy.update((p) => (p && p.id === policyId ? { ...p, compiled_rego: res.compiled_rego } : p));
			compileStatus.set('success');
			return true;
		} catch (e) {
			compileStatus.set('error');
			compileError.set(e instanceof ApiError ? e.message : 'Connection lost. Please retry.');
			return false;
		}
	};

	// C1's compile endpoint compiles the policy's SAVED markdown (no body),
	// so a save must precede a compile for the preview to match the textarea.
	const saveThenCompile = async (): Promise<{ saved: boolean; compiled: boolean }> => {
		if (!dirty) return { saved: true, compiled: true };
		const saved = await doSave();
		if (!saved) return { saved: false, compiled: false };
		const compiled = await doCompile();
		return { saved: true, compiled };
	};

	const scheduleCompile = debounce(saveThenCompile, 500);
	const scheduleSave = debounce(saveThenCompile, 1000);

	const manualSave = () => {
		scheduleCompile.cancel();
		scheduleSave.cancel();
		saveThenCompile();
	};

	const handleKeydown = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			manualSave();
		}
	};

	const doDeploy = async () => {
		dialog = null;
		banner = null;
		// Make sure MADE deploys the latest compiled Rego, not a stale one.
		if (dirty) {
			const result = await saveThenCompile();
			if (!result.saved || !result.compiled) return;
		}
		deployStatus.set('working');
		deployError.set(null);
		try {
			const res = await deployPolicy(localStorage.token, policyId);
			await loadPolicy();
			deployStatus.set('success');
			banner = { type: 'success', text: res.message ?? 'Policy deployed successfully.' };
		} catch (e) {
			deployStatus.set('error');
			if (e instanceof ApiError) {
				const body = e.body as { message?: string; rolled_back?: boolean } | null;
				if (body?.message) {
					deployError.set(body.message);
					banner = {
						type: 'error',
						text: body.rolled_back
							? 'Deployment failed and was rolled back. Fix the Rego and retry.'
							: 'Deployment failed. Fix the Rego and retry.'
					};
				} else {
					deployError.set(e.message);
				}
				// 400/502 responses leave the policy draft or set last_error —
				// refetch to keep badges and last_error in sync.
				if (e.status !== 0) await loadPolicy();
			} else {
				deployError.set('Connection lost. Please retry.');
			}
		}
	};

	const doRollback = async () => {
		dialog = null;
		banner = null;
		rollbackStatus.set('working');
		rollbackError.set(null);
		try {
			const res = await rollbackPolicy(localStorage.token, policyId);
			await loadPolicy();
			rollbackStatus.set('success');
			banner = { type: 'success', text: res.message ?? 'Rolled back to previous version.' };
		} catch (e) {
			rollbackStatus.set('error');
			rollbackError.set(e instanceof ApiError ? e.message : 'Connection lost. Please retry.');
			if (e instanceof ApiError && e.status !== 0) await loadPolicy();
		}
	};

	const doDelete = async () => {
		dialog = null;
		banner = null;
		try {
			await deletePolicy(localStorage.token, policyId);
			await goto('/workspace/policies');
		} catch (e) {
			banner = {
				type: 'error',
				text: e instanceof ApiError ? e.message : 'Delete failed. Please retry.'
			};
		}
	};

	onMount(() => {
		if ($user?.role !== 'admin') {
			goto('/', { replaceState: true });
			return;
		}
		// The status/error stores are module-level: stale state from a
		// previously viewed policy (✓ Compiled, stuck 'working', old errors)
		// must not leak into this one.
		resetPolicyStatuses();
		loadPolicy();
		window.addEventListener('keydown', handleKeydown);
	});

	onDestroy(() => {
		scheduleCompile.cancel();
		scheduleSave.cancel();
		// Clicking "Back to Policies" (or any nav) IS what blurs the textarea,
		// which schedules the 1s debounced save — without this, edits made in
		// the blur window are dropped. Fire-and-forget PUT; `dirty` can only
		// be true for a draft (the textarea is disabled when active).
		if (dirty) void doSave();
		window.removeEventListener('keydown', handleKeydown);
		if (redirectTimer !== null) clearTimeout(redirectTimer);
	});
</script>

<div class="flex h-full w-full flex-col gap-3 px-1.5 py-4">
	{#if notFound}
		<div
			class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
		>
			Policy not found — it may have been deleted. Redirecting to the policy list…
		</div>
	{:else if fetchError}
		<div
			class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
		>
			<span>Error: {fetchError}</span>
			<button
				class="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
				on:click={loadPolicy}
				type="button"
			>
				Retry
			</button>
		</div>
	{:else if loaded}
		<!-- Header -->
		<div class="flex flex-wrap items-center gap-2">
			<h1 class="min-w-0 truncate text-xl font-semibold text-gray-900 dark:text-gray-100">
				{$currentPolicy?.name}
			</h1>
			{#if status === 'active'}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/50 dark:text-green-400"
				>
					✓ Active
				</span>
			{:else}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
				>
					⚪ Draft
				</span>
			{/if}

			<div class="ml-auto flex flex-wrap items-center gap-1.5">
				{#if status === 'draft'}
					<button
						class="rounded-full bg-gray-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
						on:click={() => (dialog = 'deploy')}
						disabled={$deployStatus === 'working' || !$currentPolicy?.compiled_rego}
						type="button"
					>
						{$deployStatus === 'working'
							? 'Deploying…'
							: !$currentPolicy?.compiled_rego
								? 'Deploy (compile first)'
								: 'Deploy'}
					</button>
					<button
						class="rounded-full bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900"
						on:click={() => (dialog = 'delete')}
						type="button"
					>
						Delete
					</button>
				{:else}
					{#if $rollbackStatus === 'working'}
						<button
							class="cursor-not-allowed rounded-full bg-gray-200 px-4 py-1.5 text-sm font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
							disabled
							type="button"
						>
							Rolling back…
						</button>
					{:else}
						<button
							class="rounded-full bg-amber-100 px-4 py-1.5 text-sm font-medium text-amber-800 transition hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-900"
							on:click={() => (dialog = 'rollback')}
							type="button"
						>
							Rollback
						</button>
					{/if}
				{/if}
				<button
					class="rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
					on:click={() => goto('/workspace/policies')}
					type="button"
				>
					← Back to Policies
				</button>
			</div>
		</div>

		{#if $currentPolicy?.last_error && status === 'draft'}
			<div
				class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
			>
				Last deployment error: {$currentPolicy.last_error}
			</div>
		{/if}

		{#if banner}
			<div
				class="rounded-lg border px-3 py-2 text-sm {banner.type === 'success'
					? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300'
					: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'}"
			>
				{banner.type === 'success' ? '✓ ' : '✗ '}{banner.text}
			</div>
		{/if}

		{#if $deployError}
			<div
				class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
			>
				✗ Deployment failed: {$deployError}
			</div>
		{/if}
		{#if $rollbackError}
			<div
				class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
			>
				✗ Rollback failed: {$rollbackError}
			</div>
		{/if}

		<!-- Split pane: stacks on mobile, side-by-side from md (768px) up -->
		<div class="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
			<div class="flex min-h-0 flex-1 flex-col gap-1.5 md:w-1/2">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-medium text-gray-700 dark:text-gray-300">Markdown</h2>
					<span class="text-xs text-gray-500 dark:text-gray-400">
						{#if $saveStatus === 'working'}
							Saving…
						{:else if $saveStatus === 'success'}
							✓ Saved
						{:else if $saveStatus === 'error'}
							✗ Save failed
						{/if}
					</span>
				</div>
				<textarea
					class="h-full min-h-64 w-full resize-none rounded-lg border border-gray-200 bg-white p-3 font-mono text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-blue-500"
					placeholder="# Policy
Write your policy in Markdown…"
					bind:value={markdown}
					disabled={locked}
					on:input={() => {
						dirty = true;
						scheduleCompile();
					}}
					on:blur={() => {
						scheduleSave();
					}}
				></textarea>
				{#if locked}
					<p class="text-xs text-gray-500 dark:text-gray-400">
						Active policies are read-only. Roll back to edit.
					</p>
				{/if}
				{#if $saveError}
					<p class="text-xs text-red-600 dark:text-red-400">Save failed: {$saveError}</p>
				{/if}
			</div>

			<div class="flex min-h-0 flex-1 flex-col gap-1.5 md:w-1/2">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-medium text-gray-700 dark:text-gray-300">Rego Preview</h2>
					<span class="text-xs text-gray-500 dark:text-gray-400">
						{#if $compileStatus === 'working'}
							Compiling…
						{:else if $compileStatus === 'success'}
							✓ Compiled
						{:else if $compileStatus === 'error'}
							✗ Compile failed
						{:else}
							Compile runs automatically while you type
						{/if}
					</span>
				</div>
				{#if $compileError}
					<div
						class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
					>
						✗ {$compileError}
					</div>
				{/if}
				<pre
					class="h-full min-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
					><code>{$currentPolicy?.compiled_rego || '(No compiled Rego yet — start typing to compile.)'}</code></pre>
			</div>
		</div>
	{:else}
		<div class="py-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading policy…</div>
	{/if}
</div>

{#if dialog === 'deploy'}
	<ConfirmDialog
		title="Deploy policy"
		message="Deploy this policy to MADE? It will become **active** and govern live requests."
		confirmLabel="Deploy"
		show={true}
		onConfirm={doDeploy}
		on:cancel={() => (dialog = null)}
	/>
{/if}
{#if dialog === 'rollback'}
	<ConfirmDialog
		title="Rollback policy"
		message="Roll back to the previous version? This reverts MADE's active policy and unlocks the editor."
		confirmLabel="Rollback"
		show={true}
		onConfirm={doRollback}
		on:cancel={() => (dialog = null)}
	/>
{/if}
{#if dialog === 'delete'}
	<ConfirmDialog
		title="Delete policy"
		message={`Delete **{$currentPolicy?.name}**? This cannot be undone.`}
		confirmLabel="Delete"
		show={true}
		onConfirm={doDelete}
		on:cancel={() => (dialog = null)}
	/>
{/if}
