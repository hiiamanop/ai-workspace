<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { user, workspaceActions } from '$lib/stores';
	import { policies } from '$lib/stores/policies';
	import { ApiError, deletePolicy, fetchPolicies } from '$lib/apis/policies';
	import { filterPolicies, formatEpochNs } from '$lib/utils/policies';
	import ConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';

	let loading = true;
	let error: string | null = null;
	let offline = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	let searchQuery = '';
	let statusFilter: 'all' | 'draft' | 'active' = 'all';

	let confirmDeleteId: string | null = null;
	let deleting = false;

	$: filteredPolicies = filterPolicies($policies, searchQuery, statusFilter);

	const load = async () => {
		loading = true;
		try {
			const res = await fetchPolicies(localStorage.token);
			policies.set(res.policies);
			error = null;
			offline = false;
		} catch (e) {
			if (e instanceof ApiError && e.status === 0) {
				// Network-level failure: keep the list if we have one, retry periodically.
				offline = true;
				error = 'Connection lost. Retrying…';
				scheduleRetry();
			} else if (e instanceof ApiError && e.status === 403) {
				error = 'Admin access required. You do not have permission to manage policies.';
			} else {
				error = e instanceof ApiError ? e.message : 'Something went wrong. Please retry.';
			}
		} finally {
			loading = false;
		}
	};

	const scheduleRetry = () => {
		if (retryTimer !== null) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			load();
		}, 5000);
	};

	const doDelete = async () => {
		if (confirmDeleteId === null) return;
		const id = confirmDeleteId;
		deleting = true;
		error = null;
		try {
			await deletePolicy(localStorage.token, id);
			policies.update((list) => list.filter((p) => p.id !== id));
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Delete failed. Please retry.';
		} finally {
			deleting = false;
			confirmDeleteId = null;
		}
	};

	onMount(async () => {
		if ($user?.role !== 'admin') {
			goto('/', { replaceState: true });
			return;
		}
		// "New Policy" appears in the workspace nav's split-create button.
		workspaceActions.set([{ id: 'new-policy', label: 'New Policy', href: '/workspace/policies/new' }]);
		load();
	});

	onDestroy(() => {
		if (retryTimer !== null) clearTimeout(retryTimer);
	});
</script>

<div class="flex h-full w-full flex-col gap-4 px-1.5 py-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">Policies</h1>
		<button
			class="rounded-full bg-gray-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
			on:click={() => goto('/workspace/policies/new')}
			type="button"
		>
			+ New Policy
		</button>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<input
			class="w-64 max-w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-gray-500"
			type="text"
			placeholder="Search policies…"
			bind:value={searchQuery}
		/>
		<select
			class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-gray-500"
			bind:value={statusFilter}
		>
			<option value="all">All</option>
			<option value="draft">Draft</option>
			<option value="active">Active</option>
		</select>
		<span class="text-sm text-gray-500 dark:text-gray-400">
			{filteredPolicies.length} / {$policies.length}
		</span>
	</div>

	{#if error}
		<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
			<span>Error: {error}</span>
			<button
				class="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
				on:click={load}
				type="button"
			>
				Retry
			</button>
		</div>
	{/if}

	{#if offline}
		<div class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
			Offline — showing last loaded policies, retrying every 5 seconds.
		</div>
	{/if}

	<div class="overflow-x-auto">
		<table class="w-full min-w-[600px] text-left text-sm">
			<thead>
				<tr class="border-b border-gray-200 text-gray-500 dark:border-gray-800 dark:text-gray-400">
					<th class="py-2 pr-3 font-medium">Name</th>
					<th class="py-2 pr-3 font-medium">Status</th>
					<th class="py-2 pr-3 font-medium">Created</th>
					<th class="py-2 pr-3 font-medium">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#if loading}
					<tr>
						<td colspan="4" class="py-6 text-center text-gray-500 dark:text-gray-400">
							Loading policies…
						</td>
					</tr>
				{:else if filteredPolicies.length === 0}
					<tr>
						<td colspan="4" class="py-6 text-center text-gray-500 dark:text-gray-400">
							{searchQuery || statusFilter !== 'all'
								? 'No policies match your filters.'
								: 'No policies yet. Create one to get started.'}
						</td>
					</tr>
				{:else}
					{#each filteredPolicies as policy (policy.id)}
						<tr
							class="cursor-pointer border-b border-gray-100 transition hover:bg-gray-50 dark:border-gray-850 dark:hover:bg-gray-900"
							on:click={() => goto(`/workspace/policies/${policy.id}`)}
						>
							<td class="max-w-64 truncate py-2.5 pr-3 font-medium text-gray-900 dark:text-gray-100">
								{policy.name}
							</td>
							<td class="py-2.5 pr-3">
								{#if policy.status === 'active'}
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
							</td>
							<td class="py-2.5 pr-3 text-gray-600 dark:text-gray-400">
								{formatEpochNs(policy.created_at)}
							</td>
							<td class="py-2.5">
								<div class="flex items-center gap-1.5">
									<button
										class="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
										on:click|stopPropagation={() => goto(`/workspace/policies/${policy.id}`)}
										type="button"
									>
										Edit
									</button>
									{#if policy.status === 'draft'}
										<button
											class="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 transition hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900"
											on:click|stopPropagation={() => (confirmDeleteId = policy.id)}
											type="button"
										>
											Delete
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>

<ConfirmDialog
	title="Delete policy"
	message={`Delete **${confirmDeleteId ? ($policies.find((p) => p.id === confirmDeleteId)?.name ?? '') : ''}**? This cannot be undone.`}
	confirmLabel={deleting ? 'Deleting…' : 'Delete'}
	show={confirmDeleteId !== null}
	onConfirm={doDelete}
/>
