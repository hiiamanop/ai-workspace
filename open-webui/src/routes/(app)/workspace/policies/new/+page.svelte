<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/stores';
	import { ApiError, createPolicy } from '$lib/apis/policies';

	let name = 'Untitled Policy';
	let markdown = '';
	let creating = false;
	let error: string | null = null;

	onMount(() => {
		if ($user?.role !== 'admin') {
			goto('/', { replaceState: true });
		}
	});

	// Creates the policy server-side, then hands off to the real editor route
	// ([id]/+page.svelte), whose live compile handles the first compile.
	const create = async () => {
		if (!name.trim()) {
			error = 'Policy name is required.';
			return;
		}
		creating = true;
		error = null;
		try {
			// crypto.randomUUID() is URL-safe, satisfying the backend's
			// ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ id constraint.
			const policy = await createPolicy(localStorage.token, crypto.randomUUID(), name.trim(), markdown);
			await goto(`/workspace/policies/${policy.id}`);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Connection lost. Please try again.';
		} finally {
			creating = false;
		}
	};
</script>

<div class="flex h-full w-full flex-col gap-4 px-1.5 py-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">New Policy</h1>
		<button
			class="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700 transition hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
			on:click={() => goto('/workspace/policies')}
			type="button"
		>
			← Back to Policies
		</button>
	</div>

	<p class="text-sm text-gray-500 dark:text-gray-400">
		Name your policy and write its Markdown. After creation, the editor compiles it to Rego live —
		you can deploy it to MADE once the first compile succeeds.
	</p>

	{#if error}
		<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
			Error: {error}
		</div>
	{/if}

	<div class="flex flex-col gap-2">
		<label class="text-sm font-medium text-gray-700 dark:text-gray-300" for="policy-name">Name</label>
		<input
			id="policy-name"
			class="w-full max-w-md rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-gray-500"
			type="text"
			placeholder="Policy name"
			bind:value={name}
		/>
	</div>

	<div class="flex min-h-0 flex-1 flex-col gap-2">
		<label class="text-sm font-medium text-gray-700 dark:text-gray-300" for="policy-markdown">Markdown</label>
		<textarea
			id="policy-markdown"
			class="h-full min-h-64 w-full resize-none rounded-lg border border-gray-200 bg-white p-3 font-mono text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-gray-500"
			placeholder="# Policy
Write your policy as Markdown here…"
			bind:value={markdown}
		></textarea>
	</div>

	<div class="flex items-center gap-2">
		<button
			class="rounded-full bg-gray-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
			on:click={create}
			disabled={creating}
			type="button"
		>
			{creating ? 'Creating…' : 'Create Policy'}
		</button>
	</div>
</div>
