<script lang="ts">
	// D3: embeds GenOffice (served by the ai-workspace Node backend at :3000)
	// inside Open WebUI. The `id` route segment is cosmetic for now — GenOffice
	// keeps document state client-side via the File System Access API, so any
	// id (including "new") renders the same editor. ponytail: no doc metadata
	// DB yet (D4+); absolute URL because /document is a different origin than
	// Open WebUI's own server.
</script>

<svelte:head>
	<title>Document — Open WebUI</title>
</svelte:head>

<div class="w-full h-full min-h-0">
	<iframe
		title="Document editor"
		src="http://localhost:3000/document"
		class="w-full h-full min-h-0 border-0"
		allow="clipboard-read; clipboard-write"
	></iframe>
</div>
