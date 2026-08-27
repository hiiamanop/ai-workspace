<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/stores';
	import {
		ApiError,
		deleteMapping,
		fetchLeaks,
		fetchMappings,
		updateMapping,
		type EntityMapping,
		type RedactionLeak
	} from '$lib/apis/privacy';
	import ConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';

	let loading = true;
	let error: string | null = null;

	let mappings: EntityMapping[] = [];
	let leaks: RedactionLeak[] = [];

	let revealed = new Set<string>();
	let editingId: string | null = null;
	let editValue = '';
	let editPlaceholder = '';
	let saving = false;

	let confirmDeleteId: string | null = null;
	let deleting = false;

	const fmt = (iso: string) => {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? iso : d.toLocaleString();
	};

	const load = async () => {
		loading = true;
		try {
			[mappings, leaks] = await Promise.all([
				fetchMappings(localStorage.token),
				fetchLeaks(localStorage.token).catch(() => [])
			]);
			error = null;
		} catch (e) {
			error =
				e instanceof ApiError && e.status === 403
					? 'Admin access required.'
					: e instanceof ApiError
						? e.message
						: 'Something went wrong. Please retry.';
		} finally {
			loading = false;
		}
	};

	const toggleReveal = (id: string) => {
		revealed.has(id) ? revealed.delete(id) : revealed.add(id);
		revealed = revealed;
	};

	const startEdit = (m: EntityMapping) => {
		editingId = m.id;
		editValue = m.original_value;
		editPlaceholder = m.placeholder;
		error = null;
	};

	const saveEdit = async () => {
		if (editingId === null) return;
		saving = true;
		error = null;
		try {
			const updated = await updateMapping(localStorage.token, editingId, {
				original_value: editValue,
				placeholder: editPlaceholder
			});
			mappings = mappings.map((m) => (m.id === updated.id ? updated : m));
			editingId = null;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Save failed. Please retry.';
		} finally {
			saving = false;
		}
	};

	const doDelete = async () => {
		if (confirmDeleteId === null) return;
		const id = confirmDeleteId;
		deleting = true;
		try {
			await deleteMapping(localStorage.token, id);
			mappings = mappings.filter((m) => m.id !== id);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Delete failed. Please retry.';
		} finally {
			deleting = false;
			confirmDeleteId = null;
		}
	};

	onMount(() => {
		if ($user?.role !== 'admin') {
			goto('/', { replaceState: true });
			return;
		}
		load();
	});
</script>

<div class="flex h-full w-full flex-col gap-6 px-1.5 py-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">Redaction mappings</h1>
		<button
			class="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
			on:click={load}
			type="button"
		>
			Refresh
		</button>
	</div>

	{#if error}
		<div
			class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
		>
			{error}
		</div>
	{/if}

	<div class="overflow-x-auto">
		<table class="w-full min-w-[640px] text-left text-sm">
			<thead>
				<tr class="border-b border-gray-200 text-gray-500 dark:border-gray-800 dark:text-gray-400">
					<th class="py-2 pr-3 font-medium">Placeholder</th>
					<th class="py-2 pr-3 font-medium">Type</th>
					<th class="py-2 pr-3 font-medium">Original value</th>
					<th class="py-2 pr-3 font-medium">Created</th>
					<th class="py-2 font-medium">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#if loading}
					<tr><td colspan="5" class="py-6 text-center text-gray-500">Loading…</td></tr>
				{:else if mappings.length === 0}
					<tr><td colspan="5" class="py-6 text-center text-gray-500">No mappings yet.</td></tr>
				{:else}
					{#each mappings as m (m.id)}
						<tr class="border-b border-gray-100 dark:border-gray-850">
							<td class="py-2.5 pr-3">
								{#if editingId === m.id}
									<input
										class="w-40 rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
										bind:value={editPlaceholder}
									/>
								{:else}
									<span class="font-mono text-xs text-gray-900 dark:text-gray-100">{m.placeholder}</span>
								{/if}
							</td>
							<td class="py-2.5 pr-3 text-gray-600 dark:text-gray-400">{m.entity_type}</td>
							<td class="py-2.5 pr-3">
								{#if editingId === m.id}
									<input
										class="w-56 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
										bind:value={editValue}
									/>
								{:else if revealed.has(m.id)}
									<button
										class="text-gray-900 underline decoration-dotted dark:text-gray-100"
										on:click={() => toggleReveal(m.id)}
									>
										{m.original_value}
									</button>
								{:else}
									<button class="text-gray-400 hover:text-gray-600" on:click={() => toggleReveal(m.id)}>
										•••••• <span class="text-[10px]">(reveal)</span>
									</button>
								{/if}
							</td>
							<td class="py-2.5 pr-3 text-gray-600 dark:text-gray-400">{fmt(m.created_at)}</td>
							<td class="py-2.5">
								<div class="flex items-center gap-1.5">
									{#if editingId === m.id}
										<button
											class="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
											on:click={saveEdit}
											disabled={saving}
											type="button">{saving ? 'Saving…' : 'Save'}</button
										>
										<button
											class="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200"
											on:click={() => (editingId = null)}
											type="button">Cancel</button
										>
									{:else}
										<button
											class="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
											on:click={() => startEdit(m)}
											type="button">Edit</button
										>
										<button
											class="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300"
											on:click={() => (confirmDeleteId = m.id)}
											type="button">Delete</button
										>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<div class="flex flex-col gap-2">
		<h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">
			Redaction leaks — detector gaps to fix
		</h2>
		{#if leaks.length === 0}
			<p class="text-sm text-gray-500">None recorded. Good.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full min-w-[480px] text-left text-sm">
					<thead>
						<tr
							class="border-b border-gray-200 text-gray-500 dark:border-gray-800 dark:text-gray-400"
						>
							<th class="py-2 pr-3 font-medium">When</th>
							<th class="py-2 pr-3 font-medium">Entity types that survived</th>
							<th class="py-2 font-medium">Spans</th>
						</tr>
					</thead>
					<tbody>
						{#each leaks as l (l.id)}
							<tr class="border-b border-gray-100 dark:border-gray-850">
								<td class="py-2 pr-3 text-gray-600 dark:text-gray-400">{fmt(l.created_at)}</td>
								<td class="py-2 pr-3 text-gray-900 dark:text-gray-100">{l.entity_types.join(', ')}</td>
								<td class="py-2 text-gray-600 dark:text-gray-400">{l.span_count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<ConfirmDialog
	title="Delete mapping"
	message="Delete this mapping? Any placeholder already sent to a model can no longer be restored."
	confirmLabel={deleting ? 'Deleting…' : 'Delete'}
	show={confirmDeleteId !== null}
	onConfirm={doDelete}
	on:cancel={() => (confirmDeleteId = null)}
/>
