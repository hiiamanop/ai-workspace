<script lang="ts">
	import { WEBUI_NAME } from '$lib/stores';
	import ArrowRight from '$lib/components/icons/ArrowRight.svelte';
	import ArrowPath from '$lib/components/icons/ArrowPath.svelte';
	import ChartBar from '$lib/components/icons/ChartBar.svelte';
	import CheckCircle from '$lib/components/icons/CheckCircle.svelte';
	import CommandLine from '$lib/components/icons/CommandLine.svelte';
	import Database from '$lib/components/icons/Database.svelte';
	import EyeSlash from '$lib/components/icons/EyeSlash.svelte';
	import LockClosed from '$lib/components/icons/LockClosed.svelte';
	import { onMount } from 'svelte';
	type Status = 'ready' | 'degraded' | 'offline' | 'preview';
	let activeView = 'overview';
	let refreshedAt = new Date();
	let refreshing = false;
	let runtime: { services?: Array<{ id: string; status: Status }> } = {};
	let runs: Array<{ run_id: string; workflow_id: string; status: string; intent: string | null; updated_at: string }> = [];
	let approvals: Array<{ approval_id: string; capability: string; operation: string; reason: string }> = [];
	let auditEvents: Array<{ event_id: string; event_type: string; outcome: string; occurred_at: string }> = [];
	async function loadOperations() {
		const [status, runResponse, approvalResponse, auditResponse] = await Promise.all([
			fetch('/api/operations/status'), fetch('/api/operations/runs?limit=25'),
			fetch('/api/operations/approvals?status=pending'), fetch('/api/operations/audit?limit=20')
		]);
		if (status.ok) runtime = await status.json();
		if (runResponse.ok) runs = (await runResponse.json()).runs ?? [];
		if (approvalResponse.ok) approvals = (await approvalResponse.json()).approvals ?? [];
		if (auditResponse.ok) auditEvents = (await auditResponse.json()).events ?? [];
		refreshedAt = new Date();
	}
	onMount(() => { void loadOperations(); });
	const infrastructure = [
		{ name: 'MADE policy engine', detail: 'Decisions & authorization', status: 'ready' as Status, metric: 'Available', icon: LockClosed, href: '/workspace/policies' },
		{ name: 'MCP runtime', detail: 'Registry & execution boundary', status: 'ready' as Status, metric: 'No connectors', icon: CommandLine, href: '/workspace/tools' },
		{ name: 'Workflow persistence', detail: 'Runs & state recovery', status: 'preview' as Status, metric: 'Persistent', icon: Database, href: '/workspace/tools' },
		{ name: 'Audit pipeline', detail: 'Redacted event stream', status: 'ready' as Status, metric: 'Redaction active', icon: EyeSlash, href: '/workspace/tools' }
	];
	const views = [
		{ id: 'overview', label: 'Overview' }, { id: 'runs', label: 'Workflow runs' },
		{ id: 'approvals', label: 'Approvals' }, { id: 'audit', label: 'Audit events' }
	];
	async function refresh() { refreshing = true; try { await loadOperations(); } finally { setTimeout(() => (refreshing = false), 250); } }
</script>

<svelte:head><title>Workspace / {$WEBUI_NAME}</title></svelte:head>
<main class="hub-shell">
	<section class="hero"><div><p class="eyebrow">CONTROL PLANE</p><h1>Workspace</h1><p class="lede">Pantau policy, workflow, dan boundary MCP dari satu tempat.</p></div><div class="hero-actions"><div class="live"><span></span> Runtime operational</div><button class="refresh" on:click={refresh} disabled={refreshing} aria-label="Refresh workspace"><ArrowPath className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing' : 'Refresh'}</button></div></section>
	<section class="signals"><div><label>Policy engine</label><strong>{runtime.services?.find((s) => s.id === 'made')?.status ?? 'Unknown'}</strong><small>MADE gate status</small></div><div><label>MCP runtime</label><strong>{runtime.services?.find((s) => s.id === 'mcp')?.status ?? 'Unknown'}</strong><small>Connector boundary</small></div><div><label>Pending approvals</label><strong>{approvals.length}</strong><small>{approvals.length ? 'Requires review' : 'Nothing requires review'}</small></div><div><label>Last refresh</label><strong>{refreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><small>Local runtime</small></div></section>
	<section class="section-head"><div><p class="eyebrow">SYSTEM MAP</p><h2>Infrastructure status</h2></div><a href="/workspace/tools">Inspect tools <ArrowRight /></a></section>
	<section class="infra-grid">{#each infrastructure as item}<a class="infra-card" href={item.href}><div class="card-top"><svelte:component this={item.icon} /><span class:preview={item.status === 'preview'} class="status"><i></i>{item.status}</span></div><h3>{item.name}</h3><p>{item.detail}</p><div class="card-foot"><b>{item.metric}</b><ArrowRight /></div></a>{/each}</section>
	<section class="operations"><div class="section-head"><div><p class="eyebrow">OPERATIONS</p><h2>Observe the control loop</h2></div><span class="muted">Read-only workspace views</span></div><nav class="tabs" aria-label="Operations views">{#each views as view}<button class:active={activeView === view.id} on:click={() => (activeView = view.id)}>{view.label}{#if view.count !== undefined}<em>{view.count}</em>{/if}</button>{/each}</nav><div class="panel">
		{#if activeView === 'overview'}<div class="empty"><ChartBar /><h3>Observability is ready</h3><p>{runs.length} workflow runs, {auditEvents.length} audit events, and {approvals.length} pending approvals.</p></div>
		{:else if activeView === 'runs'}{#if runs.length}<div class="rows">{#each runs as run}<div class="row"><b>{run.intent ?? run.workflow_id}</b><span>{run.status}</span><small>{run.updated_at}</small></div>{/each}</div>{:else}<div class="empty"><Database /><h3>No workflow runs yet</h3><p>Runs will appear here when the orchestrator persists them.</p></div>{/if}
		{:else if activeView === 'approvals'}{#if approvals.length}<div class="rows">{#each approvals as approval}<div class="row"><b>{approval.capability} / {approval.operation}</b><span>{approval.reason}</span></div>{/each}</div>{:else}<div class="empty"><CheckCircle /><h3>Approval inbox clear</h3><p>External writes will appear here only after MADE requests approval.</p></div>{/if}
		{:else}{#if auditEvents.length}<div class="rows">{#each auditEvents as event}<div class="row"><b>{event.event_type}</b><span>{event.outcome}</span><small>{event.occurred_at}</small></div>{/each}</div>{:else}<div class="empty"><EyeSlash /><h3>Audit viewer ready</h3><p>Events are redacted before display and will populate after persistence is enabled.</p></div>{/if}{/if}
	</div></section>
	</main>
<style>
	:global(body){background:#f7f8f6}.hub-shell{--ink:#17201d;--muted:#68736e;--line:#dce3de;--accent:#18794e;max-width:1240px;margin:auto;padding:58px 40px 100px;color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:32px;padding-bottom:52px}.eyebrow{color:var(--accent);font-size:10px;font-weight:800;letter-spacing:.16em;margin:0 0 13px}h1{font-size:clamp(48px,7vw,88px);letter-spacing:-.075em;line-height:.9;margin:0;font-weight:700}.dot{color:var(--accent)}.lede{max-width:540px;color:var(--muted);line-height:1.65;margin:22px 0 0;font-size:15px}.hero-actions{display:flex;align-items:center;gap:18px;padding-bottom:4px}.live{font-size:12px;color:var(--muted);white-space:nowrap}.live span{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:7px;box-shadow:0 0 0 4px #d9eee2}.refresh{border:1px solid var(--line);background:white;border-radius:7px;padding:9px 13px;color:var(--ink);cursor:pointer;display:flex;gap:7px;align-items:center;font-size:12px}.refresh :global(svg){width:14px}.spin{animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.signals{display:grid;grid-template-columns:repeat(4,1fr);border-block:1px solid var(--line);margin-bottom:72px}.signals>div{padding:22px 20px 23px 0;border-right:1px solid var(--line);margin:18px 20px 18px 0}.signals>div:last-child{border:0}.signals label,.signals small{display:block;font-size:11px;color:var(--muted)}.signals strong{display:block;font-size:22px;letter-spacing:-.04em;margin:7px 0 4px}.signals small{font-size:10px}.section-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px}.section-head h2{font-size:24px;letter-spacing:-.045em;margin:0}.section-head a{color:var(--accent);font-size:12px;text-decoration:none;display:flex;gap:7px;align-items:center}.section-head a :global(svg){width:14px}.muted{color:var(--muted);font-size:12px}.infra-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:72px}.infra-card{background:white;border:1px solid var(--line);border-radius:10px;padding:20px;min-height:190px;display:flex;flex-direction:column;text-decoration:none;color:inherit;transition:transform .18s,border-color .18s}.infra-card:hover{transform:translateY(-3px);border-color:#98b9a5}.card-top{display:flex;justify-content:space-between;align-items:center;color:var(--accent)}.card-top :global(svg){width:20px;height:20px}.status{display:flex;gap:6px;align-items:center;color:var(--accent);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.status i{width:6px;height:6px;border-radius:50%;background:currentColor}.status.preview{color:#9a6e18}.infra-card h3{font-size:15px;margin:34px 0 6px;letter-spacing:-.02em}.infra-card p{color:var(--muted);font-size:11px;margin:0}.card-foot{display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:20px;border-top:1px solid #eef1ef}.card-foot b{font-size:12px;font-weight:600}.card-foot :global(svg){width:14px;color:var(--accent)}.operations{border-top:1px solid var(--line);padding-top:36px}.tabs{border-bottom:1px solid var(--line);display:flex;gap:25px}.tabs button{background:none;border:0;padding:0 0 14px;color:#8a9590;font-size:12px;cursor:pointer;position:relative}.tabs button.active{color:var(--ink);font-weight:700}.tabs button.active:after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--accent)}.tabs em{font-style:normal;margin-left:6px;background:#e5ebe7;border-radius:10px;padding:2px 6px;font-size:10px}.panel{min-height:220px}.empty{text-align:center;max-width:430px;margin:54px auto}.empty :global(svg){width:27px;height:27px;color:var(--accent);margin-bottom:10px}.empty h3{font-size:15px;margin:0 0 7px}.empty p{color:var(--muted);font-size:12px;line-height:1.6;margin:0}@media(max-width:800px){.hub-shell{padding:35px 20px 70px}.hero{display:block}.hero-actions{margin-top:30px;justify-content:space-between}.signals{grid-template-columns:repeat(2,1fr);margin-bottom:50px}.signals>div:nth-child(2){border-right:0}.infra-grid{grid-template-columns:repeat(2,1fr);margin-bottom:52px}}@media(max-width:500px){.infra-grid{grid-template-columns:1fr}.tabs{gap:15px;overflow:auto}.tabs button{white-space:nowrap}.section-head{align-items:flex-start;gap:15px}.section-head>.muted{display:none}}:global(.dark) body{background:#101412}:global(.dark) .hub-shell{--ink:#e6eee9;--muted:#8e9c94;--line:#29332e}:global(.dark) .refresh,:global(.dark) .infra-card{background:#171d1a;border-color:var(--line)}:global(.dark) .card-foot{border-color:#28312c}:global(.dark) .tabs{border-color:var(--line)}:global(.dark) .tabs em{background:#26332c}
/* Design-system overrides: calm neutral surfaces, 8px rhythm, and clear focus. */
:global(body){background:#fafafa}
.hub-shell{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;max-width:1440px;padding:32px;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.hero{padding:32px 0 40px}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:.08em}
h1{font-size:40px;letter-spacing:-.04em;line-height:1.1}
.lede{font-size:16px;line-height:1.6;margin-top:12px}
.refresh{background:#fff;border-radius:10px;padding:10px 14px;font-size:14px;transition:background .2s,transform .2s}
.refresh:hover{background:#f3f4f6}.refresh:active{transform:scale(.98)}
.refresh:focus-visible,.tabs button:focus-visible,.infra-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.signals{margin-bottom:40px}.signals label,.signals small{font-size:12px}.signals strong{font-size:20px;font-variant-numeric:tabular-nums}
.section-head{margin-bottom:16px}.section-head h2{font-size:24px;letter-spacing:-.03em}.section-head a{font-size:14px}
.infra-grid{gap:24px;margin-bottom:40px}.infra-card{border-radius:12px;padding:24px;min-height:180px;transition:transform .2s,border-color .2s,box-shadow .2s}
.infra-card:hover{transform:translateY(-2px);border-color:#bfdbfe;box-shadow:0 1px 2px rgba(17,24,39,.05)}
.infra-card h3{font-size:16px;margin-top:28px}.infra-card p{font-size:14px;line-height:1.45}.card-foot{border-color:#f3f4f6}
.status{font-size:12px;text-transform:none;letter-spacing:0}.tabs{gap:24px}.tabs button{font-size:14px}.empty p{font-size:14px}
@media(max-width:800px){.hub-shell{padding:24px 20px 64px}.infra-grid{gap:16px}}
@media(max-width:500px){.hub-shell{padding:20px 16px 48px}}
:global(.dark) body{background:#111827}:global(.dark) .hub-shell{--ink:#f9fafb;--muted:#9ca3af;--line:#374151}:global(.dark) .refresh,:global(.dark) .infra-card{background:#1f2937;border-color:var(--line)}
</style>
