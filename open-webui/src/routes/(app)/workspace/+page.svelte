<script lang="ts">
	import { goto } from '$app/navigation';

	type Connector = {
		name: string;
		kind: string;
		description: string;
		status: 'ready' | 'preview';
		initials: string;
		href?: string;
	};

	const connectors: Connector[] = [
		{ name: 'Web Research', kind: 'Native capability', description: 'Search and verify public information with governed scraping.', status: 'ready', initials: 'WR', href: '/workspace/tools' },
		{ name: 'Knowledge', kind: 'Workspace source', description: 'Connect internal knowledge bases to agent context.', status: 'ready', initials: 'KN', href: '/workspace/knowledge' },
		{ name: 'Figma', kind: 'MCP connector', description: 'Design files, comments, and handoff workflows.', status: 'preview', initials: 'FG' },
		{ name: 'Google Ads', kind: 'MCP connector', description: 'Campaign insights and bounded optimization actions.', status: 'preview', initials: 'GA' },
		{ name: 'File Operations', kind: 'Native capability', description: 'Read, transform, and prepare files with policy checks.', status: 'ready', initials: 'FO', href: '/workspace/tools' },
		{ name: 'Custom MCP', kind: 'Bring your connector', description: 'Register another application through a manifest and scopes.', status: 'preview', initials: 'MC' }
	];
</script>

<svelte:head>
	<title>Workspace Connectors</title>
</svelte:head>

<section class="workspace-home">
	<div class="intro">
		<div>
			<p class="eyebrow">Agent workspace</p>
			<h1>Applications your agents can operate.</h1>
			<p class="lede">Connect capabilities once. MADE keeps every model, tool, and external action inside policy.</p>
		</div>
		<a class="manage" href="/workspace/tools">Manage tools <span aria-hidden="true">↗</span></a>
	</div>

	<div class="section-label"><span>Connected surfaces</span><span>{connectors.filter((connector) => connector.status === 'ready').length} ready</span></div>
	<div class="connector-grid">
		{#each connectors as connector}
			<article class:preview={connector.status === 'preview'} class="connector-card">
				<div class="card-top">
					<div class="monogram" aria-hidden="true">{connector.initials}</div>
					<span class:status-preview={connector.status === 'preview'} class="status"><i></i>{connector.status === 'ready' ? 'Ready' : 'Preview'}</span>
				</div>
				<div class="card-copy">
					<p class="kind">{connector.kind}</p>
					<h2>{connector.name}</h2>
					<p>{connector.description}</p>
				</div>
				{#if connector.href}
					<a class="card-action" href={connector.href}>Open surface <span aria-hidden="true">→</span></a>
				{:else}
					<button class="card-action muted" type="button" on:click={() => goto('/workspace/tools')}>View setup path <span aria-hidden="true">→</span></button>
				{/if}
			</article>
		{/each}
	</div>

	<div class="principle">
		<div class="principle-mark">M</div>
		<div><strong>Every connector is bounded by policy.</strong><span>Scopes, budgets, approvals, and audit events are evaluated before execution.</span></div>
		<a href="/workspace/policies">Review policies <span aria-hidden="true">→</span></a>
	</div>
</section>

<style>
	.workspace-home { max-width: 1180px; margin: 0 auto; padding: 3.5rem 1rem 5rem; color: #171a19; }
	:global(.dark) .workspace-home { color: #edf1ee; }
	.intro { display: flex; justify-content: space-between; align-items: flex-end; gap: 2rem; padding-bottom: 3.5rem; }
	.eyebrow, .kind, .section-label { text-transform: uppercase; letter-spacing: .12em; font-size: .68rem; font-weight: 700; }
	.eyebrow { color: #16835d; margin: 0 0 1rem; }
	h1 { max-width: 680px; margin: 0; font-size: clamp(2.2rem, 5vw, 4.5rem); line-height: .98; letter-spacing: -.055em; font-weight: 650; }
	.lede { max-width: 540px; margin: 1.3rem 0 0; color: #68716c; line-height: 1.6; font-size: 1rem; }
	:global(.dark) .lede { color: #aeb8b1; }
	.manage, .card-action, .principle a { color: inherit; text-decoration: none; font-size: .82rem; font-weight: 650; }
	.manage { white-space: nowrap; border-bottom: 1px solid #16835d; padding-bottom: .35rem; }
	.section-label { display: flex; justify-content: space-between; border-bottom: 1px solid #d8ded9; padding-bottom: .75rem; color: #68716c; }
	:global(.dark) .section-label { border-color: #303936; }
	.connector-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: #d8ded9; border-bottom: 1px solid #d8ded9; }
	:global(.dark) .connector-grid { background: #303936; border-color: #303936; }
	.connector-card { background: #f7f9f7; min-height: 275px; padding: 1.4rem; display: flex; flex-direction: column; transition: background .2s ease, transform .2s ease; }
	.connector-card:hover { background: #ffffff; transform: translateY(-2px); }
	:global(.dark) .connector-card { background: #151b18; }
	:global(.dark) .connector-card:hover { background: #1b2420; }
	.connector-card.preview { opacity: .76; }
	.card-top { display: flex; justify-content: space-between; align-items: flex-start; }
	.monogram, .principle-mark { display: grid; place-items: center; background: #17352b; color: #d9f8e9; font-size: .76rem; font-weight: 750; letter-spacing: .06em; }
	.monogram { width: 2.5rem; height: 2.5rem; border-radius: 10px; }
	.status { display: inline-flex; align-items: center; gap: .4rem; color: #16835d; font-size: .7rem; font-weight: 700; }
	.status i { width: .42rem; height: .42rem; border-radius: 50%; background: currentColor; }
	.status-preview { color: #8a958e; }
	.card-copy { margin-top: 2.8rem; }
	.kind { color: #8a958e; margin: 0 0 .55rem; }
	h2 { margin: 0; font-size: 1.35rem; letter-spacing: -.03em; }
	.card-copy p:last-child { color: #68716c; line-height: 1.5; margin: .55rem 0 0; font-size: .88rem; }
	:global(.dark) .card-copy p:last-child { color: #aeb8b1; }
	.card-action { margin-top: auto; padding-top: 1.8rem; }
	.card-action span, .manage span, .principle a span { color: #16835d; margin-left: .3rem; }
	button.card-action { background: none; border: 0; text-align: left; cursor: pointer; font: inherit; }
	.muted { color: #68716c; }
	.principle { display: flex; align-items: center; gap: 1rem; margin-top: 2.5rem; padding: 1.15rem 1.25rem; border: 1px solid #d8ded9; border-radius: 10px; }
	:global(.dark) .principle { border-color: #303936; }
	.principle-mark { flex: none; width: 2rem; height: 2rem; border-radius: 7px; }
	.principle strong, .principle span { display: block; font-size: .82rem; }
	.principle span { color: #68716c; margin-top: .25rem; }
	.principle a { margin-left: auto; white-space: nowrap; }
	@media (max-width: 800px) { .intro { display: block; padding-bottom: 2.5rem; } .manage { display: inline-block; margin-top: 1.5rem; } .connector-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	@media (max-width: 540px) { .workspace-home { padding-top: 2rem; } .connector-grid { grid-template-columns: 1fr; } .principle { align-items: flex-start; flex-wrap: wrap; } .principle a { margin-left: 3rem; } }
	@media (prefers-reduced-motion: reduce) { .connector-card { transition: none; } }
</style>
