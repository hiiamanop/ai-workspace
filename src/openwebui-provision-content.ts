// Seeds a starter set of general-assistant Prompts (slash-command templates,
// used via `/`) and Skills (longer instruction blocks the model follows,
// used via `@` or `$`, see openwebui/.../MessageInput/Commands/AtCommands.svelte)
// into Open WebUI. Same admin-signin pattern as src/openwebui-provision-tools.ts,
// but Prompts/Skills don't have a valves step, so this is simpler: resolve a
// token (a shared pre-minted key when the reconciler hands one in, else sign
// in), create-or-update each definition, and make sure every definition has a
// public-read grant (same access_grants shape used for tier models in CLAUDE.md).
//
// Payload shapes verified against this fork's backend routers:
//   - prompts.py: PromptForm { command, name, content, data?, meta?, tags?,
//     access_grants?, version_id?, commit_message?, is_production? }.
//     id is server-generated (uuid), existence is keyed by `command`; create
//     returns 400 COMMAND_TAKEN if the command already exists.
//   - skills.py: SkillForm { id, name, description?, content,
//     meta: { tags: [...] }, is_active?, access_grants? }. id is client-chosen
//     and normalized server-side (lowercased, spaces -> dashes). Update excludes
//     `id`. Existence is a direct GET /id/{id} (404 when missing).
// Both routers pass access_grants through filter_allowed_access_grants(), which
// returns them untouched for role=admin — so the public `*` read grant below is
// preserved when the reconciler's admin account provisions these.
const PUBLIC_READ_GRANT = [{ principal_type: "user", principal_id: "*", permission: "read" }];

export interface PromptDefinition {
  command: string; // without leading "/"
  name: string;
  description: string;
  content: string;
  tags: string[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
}

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    command: "summarize",
    name: "Summarize",
    description: "Condense pasted text into concise bullet points.",
    tags: ["writing", "general"],
    content:
      "Summarize the following text in 3-5 concise bullet points, preserving key facts and figures. Do not add opinions.\n\n{{CLIPBOARD}}",
  },
  {
    command: "translate-formal",
    name: "Translate (Formal)",
    description: "Translate pasted text into formal, professional language.",
    tags: ["writing", "translation"],
    content:
      "Translate the following text into clear, formal, professional language, preserving the original meaning and language unless a target language is specified above the text:\n\n{{CLIPBOARD}}",
  },
  {
    command: "explain-simple",
    name: "Explain Simply",
    description: "Explain a concept in plain language for a non-expert.",
    tags: ["explaining", "general"],
    content:
      "Explain the following in plain language a non-expert could understand, using a short analogy if it helps:\n\n{{CLIPBOARD}}",
  },
  {
    command: "brainstorm",
    name: "Brainstorm Ideas",
    description: "Generate a diverse list of ideas for a stated goal.",
    tags: ["ideation", "general"],
    content:
      "Brainstorm 8-10 diverse, concrete ideas for the goal below. Group them by theme and flag the 2 most promising with a one-line reason:\n\n{{CLIPBOARD}}",
  },
  {
    command: "email-draft",
    name: "Draft Email",
    description: "Turn rough notes into a ready-to-send email.",
    tags: ["writing", "general"],
    content:
      "Turn the notes below into a clear, polite, ready-to-send email. Include a subject line. Keep it concise:\n\n{{CLIPBOARD}}",
  },
  {
    command: "proofread",
    name: "Proofread",
    description: "Fix grammar/spelling and list the changes made.",
    tags: ["writing", "general"],
    content:
      "Proofread the text below. Return the corrected text, then a short bullet list of what you changed and why:\n\n{{CLIPBOARD}}",
  },
  {
    command: "pros-cons",
    name: "Pros and Cons",
    description: "Lay out a balanced pros/cons list for a decision.",
    tags: ["decision", "general"],
    content:
      "Lay out a balanced pros and cons list for the decision below, then give a one-sentence recommendation with your reasoning:\n\n{{CLIPBOARD}}",
  },
  {
    command: "meeting-notes",
    name: "Meeting Notes to Action Items",
    description: "Extract decisions and action items from raw meeting notes.",
    tags: ["productivity", "general"],
    content:
      "From the raw meeting notes below, extract: (1) key decisions made, (2) action items with an owner if mentioned, (3) open questions. Use headers:\n\n{{CLIPBOARD}}",
  },
];

export const SKILL_DEFINITIONS: SkillDefinition[] = [
  {
    id: "writing-clarity-coach",
    name: "Writing Clarity Coach",
    description: "Rewrite text for clarity and concision without changing meaning.",
    tags: ["writing"],
    content:
      "When this skill is active, rewrite the user's text for clarity and concision: cut filler words, prefer active voice, break up sentences over ~25 words, and keep the original meaning and tone intent. Show the rewritten version first, then a short bullet list of the specific changes made.",
  },
  {
    id: "research-summarizer",
    name: "Research Summarizer",
    description: "Summarize sources into key findings, methodology, and caveats.",
    tags: ["research"],
    content:
      "When this skill is active and the user shares one or more sources (text, links, or attached files), summarize them into: (1) key findings, (2) methodology or evidence quality if stated, (3) caveats or limitations, (4) how the sources agree or disagree with each other. Cite which source each point came from.",
  },
  {
    id: "decision-helper",
    name: "Decision Helper",
    description: "Structure a decision as weighted criteria and score each option.",
    tags: ["decision"],
    content:
      "When this skill is active and the user describes a decision with multiple options, structure it as: (1) the options, (2) 3-5 criteria that matter for this decision, (3) a simple table scoring each option 1-5 per criterion, (4) a recommendation based on the totals with the reasoning spelled out. Ask for the criteria's relative importance only if it materially changes the recommendation.",
  },
  {
    id: "code-explainer",
    name: "Code Explainer",
    description: "Explain what a code snippet does, line by line for tricky parts.",
    tags: ["coding"],
    content:
      "When this skill is active and the user shares a code snippet, explain: (1) what it does overall in one or two sentences, (2) a walkthrough of any non-obvious parts (not every line — skip the obvious ones), (3) any bug or edge case you notice, stated plainly, not just praise. Do not rewrite the code unless asked.",
  },
  {
    id: "meeting-facilitator",
    name: "Meeting Notes Structurer",
    description: "Turn raw meeting notes into decisions, action items, and open questions.",
    tags: ["productivity"],
    content:
      "When this skill is active and the user pastes raw meeting notes or a transcript, structure the output under three headers: Decisions, Action Items (with owner and due date if mentioned, otherwise mark 'unassigned'), and Open Questions. Do not invent details that were not in the notes.",
  },
  {
    id: "study-buddy",
    name: "Study Buddy",
    description: "Turn source material into a short quiz to test understanding.",
    tags: ["learning"],
    content:
      "When this skill is active and the user shares study material, generate 5 quiz questions of mixed type (multiple choice, short answer) covering the material's key points. Ask the questions first without answers. Only reveal an answer and a one-line explanation when the user responds to that question.",
  },
  {
    id: "data-table-formatter",
    name: "Table/Data Formatter",
    description: "Reformat messy pasted data into a clean Markdown table.",
    tags: ["data"],
    content:
      "When this skill is active and the user pastes messy or inconsistently delimited data, reformat it into a clean Markdown table with sensible column headers inferred from the data. Flag any row that looks malformed or ambiguous instead of silently guessing.",
  },
  {
    id: "tone-adjuster",
    name: "Tone Adjuster",
    description: "Rewrite text in a requested tone while preserving the content.",
    tags: ["writing"],
    content:
      "When this skill is active, rewrite the user's text in the tone they request (e.g. more formal, more casual, more assertive, friendlier) without changing the underlying facts or requests in the text. If no tone is specified, ask which tone before rewriting.",
  },
];

export interface ProvisionContentDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  // Share a pre-minted key when provisioning more than one thing in the same
  // run (see openwebui-auth.ts) — omit to sign in once here standalone.
  openwebuiToken?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionContentResult {
  ok: boolean;
  error?: string;
  actions: { kind: "prompt" | "skill"; id: string; action: "created" | "updated" | "up-to-date" }[];
}

interface PromptRow {
  id: string;
  command: string;
  content: string;
}

export async function provisionContent(deps: ProvisionContentDeps): Promise<ProvisionContentResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const actions: ProvisionContentResult["actions"] = [];

  // Resolve a Bearer token once: prefer a shared pre-minted key from the
  // reconciler (no extra signin — Open WebUI rate-limits signin ~15 req/3min),
  // else sign in here. get_current_user accepts both JWT and `sk-` API keys.
  let token = deps.openwebuiToken;
  if (!token) {
    const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
    });
    const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
    if (!signinRes.ok || !signinBody.token) {
      return { ok: false, error: signinBody.detail ?? `sign-in failed with status ${signinRes.status}`, actions };
    }
    token = signinBody.token;
  }
  const authHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // Prompts: id is server-generated, so existence is keyed by `command` (the
  // create endpoint 400s COMMAND_TAKEN on a duplicate). List once, reconcile.
  const existingPromptsRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/prompts/`, {
    method: "GET",
    headers: authHeaders,
  });
  if (!existingPromptsRes.ok) {
    return { ok: false, error: `listing prompts failed: ${existingPromptsRes.status}`, actions };
  }
  let existingPrompts = (await existingPromptsRes.json()) as PromptRow[] | null;

  for (const prompt of PROMPT_DEFINITIONS) {
    const payload = {
      command: prompt.command,
      name: prompt.name,
      content: prompt.content,
      meta: { description: prompt.description },
      tags: prompt.tags,
      access_grants: PUBLIC_READ_GRANT,
    };

    let existing = (existingPrompts ?? []).find((p) => p.command === prompt.command);

    if (!existing) {
      const createRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/prompts/create`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      if (!createRes.ok) {
        // A 400 COMMAND_TAKEN can happen if a prompt with this command was
        // created between our list and this create (e.g. a concurrent
        // reconciler). Re-list and fall through to the update path.
        const body = (await createRes.json().catch(() => ({}))) as { detail?: string };
        if (createRes.status !== 400) {
          return { ok: false, error: body.detail ?? `create prompt /${prompt.command} failed: ${createRes.status}`, actions };
        }
        const relistRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/prompts/`, {
          method: "GET",
          headers: authHeaders,
        });
        if (relistRes.ok) {
          existingPrompts = (await relistRes.json()) as PromptRow[] | null;
          existing = (existingPrompts ?? []).find((p) => p.command === prompt.command);
        }
        if (!existing) {
          return { ok: false, error: body.detail ?? `create prompt /${prompt.command} failed: ${createRes.status}`, actions };
        }
      } else {
        actions.push({ kind: "prompt", id: prompt.command, action: "created" });
        continue;
      }
    }

    if (existing.content === prompt.content) {
      // Re-apply the public read grant so a drifted/revoked grant heals itself
      // (mirrors how the tools provisioner re-applies valves every cycle).
      const grantsRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/prompts/id/${existing.id}/access/update`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ access_grants: PUBLIC_READ_GRANT }),
      });
      if (!grantsRes.ok) {
        const body = (await grantsRes.json().catch(() => ({}))) as { detail?: string };
        return { ok: false, error: body.detail ?? `grants update for /${prompt.command} failed: ${grantsRes.status}`, actions };
      }
      actions.push({ kind: "prompt", id: prompt.command, action: "up-to-date" });
      continue;
    }

    const updateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/prompts/id/${existing.id}/update`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
    if (!updateRes.ok) {
      const body = (await updateRes.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, error: body.detail ?? `update prompt /${prompt.command} failed: ${updateRes.status}`, actions };
    }
    actions.push({ kind: "prompt", id: prompt.command, action: "updated" });
  }

  // Skills: id is client-chosen and normalized server-side (lowercased,
  // spaces -> dashes). Our ids are already lowercase/dashed, so the GET below
  // matches what create stores. Existence is a direct GET by id (404 = absent).
  for (const skill of SKILL_DEFINITIONS) {
    const payload = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      meta: { tags: skill.tags },
      access_grants: PUBLIC_READ_GRANT,
    };

    const existingRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/skills/id/${skill.id}`, {
      method: "GET",
      headers: authHeaders,
    });

    if (!existingRes.ok) {
      const createRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/skills/create`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => ({}))) as { detail?: string };
        return { ok: false, error: body.detail ?? `create skill ${skill.id} failed: ${createRes.status}`, actions };
      }
      actions.push({ kind: "skill", id: skill.id, action: "created" });
      continue;
    }

    const existing = (await existingRes.json()) as { content?: string };
    if (existing.content === skill.content) {
      const grantsRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/skills/id/${skill.id}/access/update`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ access_grants: PUBLIC_READ_GRANT }),
      });
      if (!grantsRes.ok) {
        const body = (await grantsRes.json().catch(() => ({}))) as { detail?: string };
        return { ok: false, error: body.detail ?? `grants update for skill ${skill.id} failed: ${grantsRes.status}`, actions };
      }
      actions.push({ kind: "skill", id: skill.id, action: "up-to-date" });
      continue;
    }

    const updateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/skills/id/${skill.id}/update`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
    if (!updateRes.ok) {
      const body = (await updateRes.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, error: body.detail ?? `update skill ${skill.id} failed: ${updateRes.status}`, actions };
    }
    actions.push({ kind: "skill", id: skill.id, action: "updated" });
  }

  return { ok: true, actions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const openwebuiUrl = process.env.OPENWEBUI_URL ?? "http://localhost:3001";
  const adminEmail = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
  const adminPassword = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";

  provisionContent({ openwebuiUrl, adminEmail, adminPassword }).then((result) => {
    if (!result.ok) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exit(1);
    }
    for (const a of result.actions) {
      console.log(`${a.kind} ${a.id}: ${a.action}`);
    }
    console.log("Content provisioned successfully.");
  });
}
