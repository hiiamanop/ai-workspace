<script lang="ts">
	import { goto } from '$app/navigation';
</script>

<div class="flex flex-col items-center justify-center w-full h-full gap-4 p-6">
	<div class="text-center max-w-md">
		<div class="text-4xl mb-3">📄</div>
		<h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">Documents</h1>
		<p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
			Create and edit documents with the built-in editor. Documents are saved to your
			device — open them any time from this workspace.
		</p>
	</div>

	<button
		class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition"
		on:click={() => goto('/workspace/documents/new')}
	>
		New Document
	</button>
</div>
