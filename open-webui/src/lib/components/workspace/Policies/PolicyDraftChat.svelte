<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { ApiError, draftPolicy, type DraftChatMessage } from '$lib/apis/policies';
	import { uploadFile, getFileById } from '$lib/apis/files';
	import Spinner from '$lib/components/common/Spinner.svelte';

	const dispatch = createEventDispatcher<{ draft: string }>();

	let messages: DraftChatMessage[] = [];
	let input = '';
	let sending = false;
	let error: string | null = null;
	let uploading = false;
	let fileInput: HTMLInputElement;
	let pendingAttachment: { filename: string; content: string } | null = null;

	const send = async () => {
		const text = input.trim();
		if (!text || sending) return;

		const attachment = pendingAttachment;
		pendingAttachment = null;
		const userContent = attachment
			? `Attached regulation document (${attachment.filename}):\n\n${attachment.content}\n\n---\n\n${text}`
			: text;

		messages = [...messages, { role: 'user', content: userContent }];
		input = '';
		sending = true;
		error = null;

		try {
			const result = await draftPolicy(localStorage.token, messages);
			messages = [...messages, { role: 'assistant', content: result.content }];
			if (result.draft_markdown) {
				dispatch('draft', result.draft_markdown);
			}
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Connection lost. Please try again.';
			// Roll back the optimistic user message so a retry doesn't duplicate it.
			messages = messages.slice(0, -1);
			input = text;
		} finally {
			sending = false;
		}
	};

	const onFileSelected = async (e: Event) => {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		uploading = true;
		error = null;
		try {
			const uploaded = await uploadFile(localStorage.token, file);
			const full = await getFileById(localStorage.token, uploaded.id);
			const content = full?.data?.content;
			if (!content) {
				error = `Could not extract text from "${file.name}".`;
				return;
			}
			pendingAttachment = { filename: file.name, content };
		} catch (e) {
			error = e instanceof Error ? e.message : 'File upload failed.';
		} finally {
			uploading = false;
			if (fileInput) fileInput.value = '';
		}
	};

	const onKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};
</script>

<div class="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
	<div class="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
		<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Draft with AI</span>
		<span class="text-xs text-gray-400 dark:text-gray-500">Type a request, or upload a regulation document</span>
	</div>

	<div class="flex max-h-72 min-h-24 flex-col gap-2 overflow-y-auto px-3 py-2">
		{#if messages.length === 0}
			<p class="text-sm text-gray-400 dark:text-gray-500">
				Describe the rule you want, or upload a regulation file below — the AI will ask questions if it
				needs more detail, then draft Markdown you can review and edit before saving.
			</p>
		{/if}
		{#each messages as message}
			<div class="flex {message.role === 'user' ? 'justify-end' : 'justify-start'}">
				<div
					class="max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-sm {message.role === 'user'
						? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
						: 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'}"
				>
					{message.content}
				</div>
			</div>
		{/each}
		{#if sending}
			<div class="flex justify-start">
				<Spinner className="size-4 text-gray-400" />
			</div>
		{/if}
	</div>

	{#if error}
		<div class="mx-3 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
			{error}
		</div>
	{/if}

	{#if pendingAttachment}
		<div class="mx-3 flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
			<span>📎 {pendingAttachment.filename} — will be sent with your next message</span>
			<button type="button" class="text-gray-400 hover:text-gray-600" on:click={() => (pendingAttachment = null)}>
				✕
			</button>
		</div>
	{/if}

	<div class="flex items-end gap-2 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
		<input bind:this={fileInput} type="file" class="hidden" accept=".txt,.md,.pdf,.docx" on:change={onFileSelected} />
		<button
			type="button"
			class="shrink-0 rounded-full bg-gray-100 px-2.5 py-1.5 text-sm text-gray-600 transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
			on:click={() => fileInput.click()}
			disabled={uploading}
			title="Upload a regulation document"
		>
			{uploading ? '…' : '📎'}
		</button>
		<textarea
			class="min-h-9 flex-1 resize-none rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-gray-500"
			rows="1"
			placeholder="e.g. Deny DeepSeek for confidential data unless redacted"
			bind:value={input}
			on:keydown={onKeydown}
			disabled={sending}
		></textarea>
		<button
			type="button"
			class="shrink-0 rounded-full bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
			on:click={send}
			disabled={sending || !input.trim()}
		>
			Send
		</button>
	</div>
</div>
