# GenOffice Browser-Native `.docx` File I/O Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GenOffice's `/document` page actually open and save real `.docx` files (currently every open/save action silently no-ops), and fix a docx-engine bug where paragraph formatting inherited from a Word style is invisible outside CSS rendering.

**Architecture:** `@genoffice/docx-engine`'s parse/generate has no Node/Electron dependency and already runs entirely client-side even in the Electron build — the Electron main process only ever moves raw bytes, never parses OOXML. This means **only `genoffice/apps/docs/src/renderer/desktop-stub.ts` changes** for file I/O: it needs to fulfill the exact same `DesktopApi` contract (`OpenFileResult`, `{ok, path?, error?}` save results) that `genoffice/apps/docs/src/renderer/file-actions.ts`'s `loadFile()`/`save()`/`saveOnce()` already consume unmodified today — those functions were read in full during planning and require no changes. File access itself uses the File System Access API (`showOpenFilePicker`/`showSaveFilePicker`) where available, falling back to `<input type=file>` + a download link where it isn't (Firefox/Safari, as of this writing).

## Global Constraints

- No new npm dependencies. The File System Access API isn't in TypeScript's bundled `lib.dom.d.ts` — write a small local ambient `.d.ts` instead of adding a types package.
- `genoffice/apps/docs/src/renderer/file-actions.ts` and `App.tsx` are **not modified** by this plan — confirmed during planning that both already handle `OpenFileResult | null` and `{ok, path?, error?}` shapes generically, with no Electron-specific assumptions baked in beyond what `desktop-stub.ts` fulfills.
- No recent-files list, crash-recovery, or external-modification detection — `getRecentFiles()` stays `[]`, `writeRecoveryCopy()` stays a no-op `{ok:false}`, per the design spec's explicit non-goals.
- `image_search`/other still-stubbed `desktop-stub.ts` entries are untouched.

---

### Task 1: Browser-native `.docx` open/save via File System Access API

**Files:**
- Create: `genoffice/apps/docs/src/renderer/file-system-access.d.ts`
- Modify: `genoffice/apps/docs/src/renderer/desktop-stub.ts`
- Create: `genoffice/apps/docs/src/renderer/desktop-stub.test.ts`

**Interfaces:**
- Consumes: `DesktopApi.OpenFileResult { path: string; name: string; data: ArrayBuffer; hash: string }`, `DesktopApi.saveDocx/saveDocxAs/saveDocxNew` return shapes (`genoffice/apps/docs/src/shared/ipc.ts:1-8,149-180` — read, not modified).
- Produces: real implementations of `openDocx`, `saveDocx`, `saveDocxAs`, `saveDocxNew` on the existing `desktop` object in `desktop-stub.ts`. `openDocxPath`, `consumePendingOpenDocx`, `consumeNewBlankDoc`, `onOpenDocx`, `onRenamedDocx`, `onTeardown`, `getRecentFiles`, `writeRecoveryCopy` are unchanged (already-correct stubs per the design spec — no browser-tab equivalent exists for any of them).

- [ ] **Step 1: Write the ambient File System Access API types**

Create `genoffice/apps/docs/src/renderer/file-system-access.d.ts`:

```ts
/**
 * Minimal ambient types for the File System Access API (not yet in
 * TypeScript's lib.dom.d.ts). Only the members this codebase actually uses.
 */
interface FileSystemWritableFileStream extends WritableStream {
  write(data: ArrayBuffer | Blob): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandle {
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritableFileStream>
}

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[]
  multiple?: boolean
}

interface SaveFilePickerOptions {
  types?: FilePickerAcceptType[]
  suggestedName?: string
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
}
```

- [ ] **Step 2: Write the failing tests**

Create `genoffice/apps/docs/src/renderer/desktop-stub.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDocxImpl, saveDocxImpl, saveDocxAsImpl, saveDocxNewImpl, resetCurrentFileHandleForTests } from './desktop-stub'

function makeFile(name: string, bytes: Uint8Array): File {
  return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}

const SAMPLE_BYTES = new Uint8Array([1, 2, 3, 4])
// sha256("\x01\x02\x03\x04") — computed once via crypto.subtle.digest for this exact fixture
const SAMPLE_HASH = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'

describe('desktop-stub: File System Access API path', () => {
  beforeEach(() => {
    resetCurrentFileHandleForTests()
  })

  it('openDocxImpl() reads the picked file and returns name/data/hash', async () => {
    const file = makeFile('report.docx', SAMPLE_BYTES)
    const handle = { getFile: async () => file, createWritable: vi.fn() }
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle])

    const result = await openDocxImpl(showOpenFilePicker)

    expect(result).toEqual({ path: 'report.docx', name: 'report.docx', data: await file.arrayBuffer(), hash: SAMPLE_HASH })
  })

  it('openDocxImpl() returns null when the user cancels the picker (AbortError)', async () => {
    const abortError = new DOMException('cancelled', 'AbortError')
    const showOpenFilePicker = vi.fn().mockRejectedValue(abortError)

    const result = await openDocxImpl(showOpenFilePicker)

    expect(result).toBeNull()
  })

  it('saveDocxImpl() writes to the handle from the prior open with no picker prompt', async () => {
    const file = makeFile('report.docx', SAMPLE_BYTES)
    const write = vi.fn()
    const close = vi.fn()
    const handle = { getFile: async () => file, createWritable: async () => ({ write, close }) }
    await openDocxImpl(vi.fn().mockResolvedValue([handle]))

    const newBytes = new Uint8Array([9, 9]).buffer
    const result = await saveDocxImpl('report.docx', newBytes)

    expect(result).toEqual({ ok: true, path: 'report.docx' })
    expect(write).toHaveBeenCalledWith(newBytes)
    expect(close).toHaveBeenCalled()
  })

  it('saveDocxAsImpl() prompts showSaveFilePicker and updates the handle used by subsequent saves', async () => {
    const write = vi.fn()
    const close = vi.fn()
    const handle = { createWritable: async () => ({ write, close }) }
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle)

    const result = await saveDocxAsImpl('new-name.docx', new Uint8Array([5]).buffer, showSaveFilePicker)

    expect(result).toEqual({ ok: true, path: 'new-name.docx' })
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'new-name.docx' })
    )
  })

  it('saveDocxImpl() returns an error result when writing throws', async () => {
    const handle = {
      getFile: async () => makeFile('report.docx', SAMPLE_BYTES),
      createWritable: async () => {
        throw new Error('disk full')
      },
    }
    await openDocxImpl(vi.fn().mockResolvedValue([handle]))

    const result = await saveDocxImpl('report.docx', new Uint8Array([1]).buffer)

    expect(result).toEqual({ ok: false, error: 'disk full' })
  })
})

describe('desktop-stub: fallback path (no File System Access API)', () => {
  it('saveDocxNewImpl() builds a Blob and triggers a download without throwing', async () => {
    const clickSpy = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') el.click = clickSpy
      return el
    })
    const createObjectURL = vi.fn().mockReturnValue('blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    const result = await saveDocxNewImpl('untitled.docx', new Uint8Array([1, 2]).buffer, undefined)

    expect(result).toEqual({ ok: true, path: 'untitled.docx' })
    expect(clickSpy).toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')

    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})
```

`SAMPLE_HASH` above is the real, verified sha256 hex digest of bytes `[1,2,3,4]` (computed via `crypto.subtle.digest("SHA-256", ...)` during planning) — use it as written, no need to recompute.

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `genoffice/apps/docs`): `npx vitest run src/renderer/desktop-stub.test.ts`
Expected: FAIL — `openDocxImpl`/`saveDocxImpl`/`saveDocxAsImpl`/`saveDocxNewImpl`/`resetCurrentFileHandleForTests` don't exist yet.

- [ ] **Step 4: Implement browser-native file I/O**

Replace the top of `genoffice/apps/docs/src/renderer/desktop-stub.ts` (everything up to and including the `saveDocxNew` line of the `desktop` object) with:

```ts
import type { DesktopApi } from "../shared/ipc";
import type { OpenFileResult } from "../shared/ipc";
import type { ProjectApi, ProjectSummary } from "@genoffice/project-store";

const NOT_AVAILABLE = "not available in the web build";
const noop = (): (() => void) => () => {};

const DOCX_ACCEPT = {
  description: "Word Document",
  accept: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] },
};

/** the currently open document's writable handle — one document per browser tab, matching how the app already behaves */
let currentFileHandle: FileSystemFileHandle | null = null;

export function resetCurrentFileHandleForTests(): void {
  currentFileHandle = null;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** File System Access API open — exported standalone (rather than only reachable via `window.desktop.openDocx`) so tests can inject a fake `showOpenFilePicker` without touching real browser globals. */
export async function openDocxImpl(
  showOpenFilePicker: (opts: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
): Promise<OpenFileResult | null> {
  try {
    const [handle] = await showOpenFilePicker({ types: [DOCX_ACCEPT] });
    const file = await handle.getFile();
    const data = await file.arrayBuffer();
    currentFileHandle = handle;
    return { path: file.name, name: file.name, data, hash: await sha256Hex(data) };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/** `<input type=file>` fallback for browsers without the File System Access API */
function openDocxViaInput(): Promise<OpenFileResult | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".docx";
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .arrayBuffer()
        .then(async (data) => resolve({ path: file.name, name: file.name, data, hash: await sha256Hex(data) }))
        .catch(reject);
    };
    input.click();
  });
}

type SaveResult = { ok: boolean; path?: string; error?: string };

/** writes to `currentFileHandle` (set by a prior open/save-as/save-new) — no picker prompt */
export async function saveDocxImpl(path: string, data: ArrayBuffer): Promise<SaveResult> {
  if (!currentFileHandle) {
    return { ok: false, error: "no open file handle to save to" };
  }
  try {
    const writable = await currentFileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    return { ok: true, path };
  } catch (err) {
    if (isAbort(err)) return { ok: false };
    return { ok: false, error: (err as Error).message };
  }
}

export async function saveDocxAsImpl(
  defaultName: string,
  data: ArrayBuffer,
  showSaveFilePicker: (opts: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
): Promise<SaveResult> {
  try {
    const handle = await showSaveFilePicker({ suggestedName: defaultName, types: [DOCX_ACCEPT] });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    currentFileHandle = handle;
    return { ok: true, path: defaultName };
  } catch (err) {
    if (isAbort(err)) return { ok: false };
    return { ok: false, error: (err as Error).message };
  }
}

/** first save of a brand-new document: File System Access API still shows a picker (there is no OS-level "default folder" concept in a browser tab, unlike Electron's silent-save-to-default-dir); the fallback path downloads immediately with no dialog, since a browser download always has an implicit destination (the browser's downloads folder). */
async function saveDocxNewImpl(
  defaultName: string,
  data: ArrayBuffer,
  showSaveFilePicker: ((opts: SaveFilePickerOptions) => Promise<FileSystemFileHandle>) | undefined
): Promise<SaveResult> {
  if (showSaveFilePicker) {
    return saveDocxAsImpl(defaultName, data, showSaveFilePicker);
  }
  try {
    const blob = new Blob([data], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = defaultName;
    link.click();
    URL.revokeObjectURL(url);
    return { ok: true, path: defaultName };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export { saveDocxNewImpl };
```

Then, in the `desktop` object literal, replace these four lines:

```ts
  openDocx: async () => null,
  openDocxPath: async () => null,
```

with (only `openDocx` changes; `openDocxPath` is unchanged — a synthetic path from this browser build is never re-openable without a fresh picker):

```ts
  openDocx: async () =>
    window.showOpenFilePicker ? openDocxImpl(window.showOpenFilePicker) : openDocxViaInput(),
  openDocxPath: async () => null,
```

and replace:

```ts
  saveDocx: async () => ({ ok: false, error: NOT_AVAILABLE }),
```

with:

```ts
  saveDocx: async (path, data) => saveDocxImpl(path, data),
```

and replace:

```ts
  saveDocxAs: async () => ({ ok: false, error: NOT_AVAILABLE }),
  saveDocxNew: async () => ({ ok: false, error: NOT_AVAILABLE }),
```

with:

```ts
  saveDocxAs: async (defaultName, data) =>
    window.showSaveFilePicker
      ? saveDocxAsImpl(defaultName, data, window.showSaveFilePicker)
      : saveDocxNewImpl(defaultName, data, undefined),
  saveDocxNew: async (defaultName, data) => saveDocxNewImpl(defaultName, data, window.showSaveFilePicker),
```

(`NOT_AVAILABLE` stays defined and used by every other still-stubbed entry in the file — do not remove it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/desktop-stub.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck and run the full docs test suite**

Run: `npm run typecheck` then `npm run test -- --run` (both from `genoffice/apps/docs`)
Expected: typecheck clean; all tests passing (733 existing + 6 new = 739)

- [ ] **Step 7: Commit**

```bash
git add genoffice/apps/docs/src/renderer/file-system-access.d.ts genoffice/apps/docs/src/renderer/desktop-stub.ts genoffice/apps/docs/src/renderer/desktop-stub.test.ts
git commit -m "feat: browser-native .docx open/save via File System Access API"
```

---

### Task 2: docx-engine — style-inherited paragraph formatting reaches `Block.format`

**Files:**
- Modify: `genoffice/packages/docx-engine/src/parse.ts`
- Modify: `genoffice/packages/docx-engine/tests/autospace.test.ts` (rename file's scope — see Step 1)

**Interfaces:**
- Consumes: `StyleDisplay` fields already resolved by `styleDisplayOf()` (`genoffice/packages/docx-engine/src/types.ts:860-897`) and stored on `ctx.styles.get(styleId)?.display` (`BuildContext.styles: Map<string, StyleInfo>`, `src/parse.ts:321-323`).
- Modifies: `buildTextParagraph()`'s style-fallback block (`src/parse.ts:904-912`) to cover 9 more `ParaFormat` fields beyond the existing `autoSpace` one, using the exact field-name mapping below (verified by reading both `extractParaFormat()` at `src/parse.ts:1527-1587` and `styleDisplayOf()` at `src/parse.ts:3561-3629`, and `ParaFormat`/`StyleDisplay` in `src/types.ts:186-220,860-897`):

| `ParaFormat` field (paragraph) | `StyleDisplay` field (style) |
|---|---|
| `align` | `align` |
| `spaceBefore` | `spaceBeforeTwips` |
| `spaceAfter` | `spaceAfterTwips` |
| `lineSpacing` + `lineRule` + `lineRawTwips` | `lineSpacing` + `lineRule` + `lineRawTwips` (all three set together, from the style's `w:spacing`) |
| `indentLeft` | `indentLeftTwips` |
| `indentRight` | `indentRightTwips` |
| `indentFirstLine` | `indentFirstLineTwips` |
| `keepNext` | `keepNext` |
| `keepLines` | `keepLines` |
| `contextualSpacing` | `contextualSpacing` |

- [ ] **Step 1: Write the failing tests**

The existing `genoffice/packages/docx-engine/tests/autospace.test.ts` already has the exact test scaffolding needed (`parseFirst`, `TIGHT_STYLES`-style fixtures) — extend it rather than duplicating the helper. Add these new `describe` blocks at the end of the file, after the existing `'style-chain inheritance'` block's closing `})`:

```ts
const FORMATTED_STYLE =
  '<w:style w:type="paragraph" w:styleId="Formatted"><w:name w:val="Formatted"/>' +
  '<w:basedOn w:val="Normal"/><w:pPr>' +
  '<w:jc w:val="center"/>' +
  '<w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/>' +
  '<w:ind w:left="720" w:right="360" w:firstLine="240"/>' +
  '<w:keepNext/><w:keepLines/><w:contextualSpacing/>' +
  '</w:pPr></w:style>'

describe('style-chain inheritance: paragraph-format properties beyond autoSpace', () => {
  it('align from the style reaches the paragraph', async () => {
    const block = await parseFirst('<w:pStyle w:val="Formatted"/>', FORMATTED_STYLE)
    expect(block.format?.align).toBe('center')
  })

  it('spaceBefore/spaceAfter from the style reach the paragraph', async () => {
    const block = await parseFirst('<w:pStyle w:val="Formatted"/>', FORMATTED_STYLE)
    expect(block.format?.spaceBefore).toBe(240)
    expect(block.format?.spaceAfter).toBe(120)
  })

  it('lineSpacing/lineRule/lineRawTwips from the style reach the paragraph', async () => {
    const block = await parseFirst('<w:pStyle w:val="Formatted"/>', FORMATTED_STYLE)
    expect(block.format?.lineSpacing).toBe(1.5)
    expect(block.format?.lineRule).toBe('auto')
    expect(block.format?.lineRawTwips).toBe(360)
  })

  it('indentLeft/indentRight/indentFirstLine from the style reach the paragraph', async () => {
    const block = await parseFirst('<w:pStyle w:val="Formatted"/>', FORMATTED_STYLE)
    expect(block.format?.indentLeft).toBe(720)
    expect(block.format?.indentRight).toBe(360)
    expect(block.format?.indentFirstLine).toBe(240)
  })

  it('keepNext/keepLines/contextualSpacing from the style reach the paragraph', async () => {
    const block = await parseFirst('<w:pStyle w:val="Formatted"/>', FORMATTED_STYLE)
    expect(block.format?.keepNext).toBe(true)
    expect(block.format?.keepLines).toBe(true)
    expect(block.format?.contextualSpacing).toBe(true)
  })

  it('a direct paragraph override wins over the style for every property', async () => {
    const block = await parseFirst(
      '<w:pStyle w:val="Formatted"/><w:jc w:val="right"/><w:ind w:left="100"/>',
      FORMATTED_STYLE,
    )
    expect(block.format?.align).toBe('right')
    expect(block.format?.indentLeft).toBe(100)
    // untouched-by-the-override properties still inherit from the style
    expect(block.format?.spaceBefore).toBe(240)
    expect(block.format?.keepNext).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `genoffice/packages/docx-engine`): `npx vitest run tests/autospace.test.ts`
Expected: FAIL — the 5 new `format?.X` assertions read `undefined` since only `autoSpace` currently falls back to the style.

- [ ] **Step 3: Implement the fallback for all 9 remaining properties**

Replace, in `genoffice/packages/docx-engine/src/parse.ts`, the existing block:

```ts
  const pPr = findChild(pNode, 'w:pPr')
  const styleId = pPr ? attrsOf(findChild(pPr, 'w:pStyle') ?? {})['w:val'] : undefined
  let format = pPr ? extractParaFormat(pPr) : undefined
  // style-chain autoSpace off reaches the block: the renderer reads it per paragraph
  if (format?.autoSpace === undefined && styleId) {
    if (ctx.styles.get(styleId)?.display?.autoSpace === false) {
      format = { ...(format ?? {}), autoSpace: false }
    }
  }
```

with:

```ts
  const pPr = findChild(pNode, 'w:pPr')
  const styleId = pPr ? attrsOf(findChild(pPr, 'w:pStyle') ?? {})['w:val'] : undefined
  let format = pPr ? extractParaFormat(pPr) : undefined
  // Paragraph-format properties that come purely from the paragraph's style (no direct
  // override) are already resolved correctly for on-screen CSS rendering via
  // styleDisplayOf()'s basedOn-chain walk, but extractParaFormat() only ever reads the
  // paragraph's own w:pPr — so code reading Block.format directly (toolbar active-state,
  // AI tools, .docx export) saw them as absent. Pull each one down here the same way
  // autoSpace already was, so Block.format matches what the user actually sees.
  const styleDisplay = styleId ? ctx.styles.get(styleId)?.display : undefined
  if (styleDisplay) {
    if (format?.autoSpace === undefined && styleDisplay.autoSpace === false) {
      format = { ...(format ?? {}), autoSpace: false }
    }
    if (format?.align === undefined && styleDisplay.align !== undefined) {
      format = { ...(format ?? {}), align: styleDisplay.align }
    }
    if (format?.spaceBefore === undefined && styleDisplay.spaceBeforeTwips !== undefined) {
      format = { ...(format ?? {}), spaceBefore: styleDisplay.spaceBeforeTwips }
    }
    if (format?.spaceAfter === undefined && styleDisplay.spaceAfterTwips !== undefined) {
      format = { ...(format ?? {}), spaceAfter: styleDisplay.spaceAfterTwips }
    }
    if (format?.lineSpacing === undefined && styleDisplay.lineSpacing !== undefined) {
      format = {
        ...(format ?? {}),
        lineSpacing: styleDisplay.lineSpacing,
        lineRule: styleDisplay.lineRule,
        lineRawTwips: styleDisplay.lineRawTwips,
      }
    }
    if (format?.indentLeft === undefined && styleDisplay.indentLeftTwips !== undefined) {
      format = { ...(format ?? {}), indentLeft: styleDisplay.indentLeftTwips }
    }
    if (format?.indentRight === undefined && styleDisplay.indentRightTwips !== undefined) {
      format = { ...(format ?? {}), indentRight: styleDisplay.indentRightTwips }
    }
    if (format?.indentFirstLine === undefined && styleDisplay.indentFirstLineTwips !== undefined) {
      format = { ...(format ?? {}), indentFirstLine: styleDisplay.indentFirstLineTwips }
    }
    if (format?.keepNext === undefined && styleDisplay.keepNext) {
      format = { ...(format ?? {}), keepNext: true }
    }
    if (format?.keepLines === undefined && styleDisplay.keepLines) {
      format = { ...(format ?? {}), keepLines: true }
    }
    if (format?.contextualSpacing === undefined && styleDisplay.contextualSpacing) {
      format = { ...(format ?? {}), contextualSpacing: true }
    }
  }
```

(This is a straight superset of the previous block — the `autoSpace` check is preserved verbatim as the first `if` inside the new `if (styleDisplay)` guard, so existing `autospace.test.ts` behavior is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/autospace.test.ts`
Expected: PASS (all tests in the file, existing + 6 new)

- [ ] **Step 5: Run the full docx-engine test suite**

Run (from `genoffice/packages/docx-engine`): `npm run test -- --run` and `npm run typecheck`
Expected: all passing, clean typecheck — this change touches a code path exercised by many existing roundtrip/format tests, so a full run matters here more than usual.

- [ ] **Step 6: Run the docs app's test suite too**

`buildTextParagraph` is used by `apps/docs`'s whole document-parsing pipeline. Run (from `genoffice/apps/docs`): `npm run test -- --run`
Expected: all passing — if any existing docs-app test snapshot/assertion depended on a style-inherited property being absent from `Block.format`, it would break here; investigate rather than silence any such failure, since the fix is deliberately supposed to change that.

- [ ] **Step 7: Commit**

```bash
git add genoffice/packages/docx-engine/src/parse.ts genoffice/packages/docx-engine/tests/autospace.test.ts
git commit -m "fix: style-inherited paragraph formatting (align, indent, spacing, keepNext/Lines, contextualSpacing) now reaches Block.format"
```

---

## Manual verification (recommended)

Unlike the inline-citations work, this plan's automated coverage is real and thorough (File System Access API is fully mockable, and the docx-engine fix has direct unit tests) — but still worth a real-browser pass before considering this done:

1. Run the dev stack, open `/document` in Chrome or Edge.
2. Click Open, pick a real `.docx` with at least one paragraph whose center/right alignment comes from its style (not a direct override) — confirm the alignment toolbar button correctly shows the active state for that paragraph (this was the originally-reported symptom).
3. Edit the document, click Save — confirm no dialog appears (writes straight to the same file) and the file on disk actually changed (check its modified time / reopen it elsewhere).
4. Click Save As, pick a new file name — confirm a new file is created and subsequent Saves go to the new file, not the original.
5. Repeat steps 2-4 in Firefox (no File System Access API) — confirm Open works via the file picker, and Save/Save As trigger a browser download each time (expected fallback behavior, not a bug).
