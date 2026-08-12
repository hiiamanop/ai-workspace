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

/** Test-only helper: routes to saveDocxImpl if handle exists, else falls back to saveDocxNewImpl */
export async function saveDocxRouted(path: string, data: ArrayBuffer): Promise<SaveResult> {
  return currentFileHandle ? saveDocxImpl(path, data) : saveDocxNewImpl(path, data, undefined);
}

const desktop: DesktopApi = {
  getLanguage: async () => "en",
  onLanguageChanged: noop,
  getTheme: async () => "system",
  onThemeChanged: noop,
  openDocx: async () =>
    window.showOpenFilePicker ? openDocxImpl(window.showOpenFilePicker) : openDocxViaInput(),
  openDocxPath: async () => null,
  consumePendingOpenDocx: async () => null,
  consumeNewBlankDoc: async () => true,
  onOpenDocx: noop,
  onRenamedDocx: noop,
  saveDocx: async (path, data) =>
    currentFileHandle ? saveDocxImpl(path, data) : saveDocxNewImpl(path, data, undefined),
  writeRecoveryCopy: async () => ({ ok: false }),
  onTeardown: noop,
  saveDocxAs: async (defaultName, data) =>
    window.showSaveFilePicker
      ? saveDocxAsImpl(defaultName, data, window.showSaveFilePicker)
      : saveDocxNewImpl(defaultName, data, undefined),
  saveDocxNew: async (defaultName, data) => saveDocxNewImpl(defaultName, data, window.showSaveFilePicker),
  getRecentFiles: async () => [],
  pickImage: async () => null,
  getAiSettings: async () => ({
    provider: "custom",
    providers: {
      genspark: { apiKey: "", model: "" },
      anthropic: { apiKey: "", model: "" },
      gemini: { apiKey: "", model: "" },
      deepseek: { apiKey: "", model: "" },
      openai: { apiKey: "", model: "" },
      custom: { apiKey: "", model: "", baseUrl: "" },
    },
  }),
  setAiSettings: async () => {},
  print: async () => {
    window.print();
  },
  exportPdf: async () => ({ ok: false, error: NOT_AVAILABLE }),
  printPdfBuffer: async () => ({ ok: false }),
  saveMergedPdf: async () => ({ ok: false, error: NOT_AVAILABLE }),
  aiChat: async () => ({ ok: false, error: NOT_AVAILABLE }),
  aiStream: async () => {},
  aiStreamCancel: async () => {},
  aiGskStatus: async () => ({ loggedIn: false }),
  aiGskLogin: async () => {},
  webSearch: async (query, maxResults) => {
    try {
      const res = await fetch("/api/web-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, maxResults }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return { results: [], method: "error", error: body.error ?? `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { results: Array<{ title: string; url: string; snippet: string }>; answer?: string };
      return { results: data.results, answer: data.answer, method: "searxng" };
    } catch (err) {
      return { results: [], method: "error", error: (err as Error).message };
    }
  },
  imageSearch: async () => ({ images: [], method: "error", error: NOT_AVAILABLE }),
  fetchImage: async () => null,
  pickAttachments: async () => null,
  addAttachmentPaths: async (paths) => ({ accepted: [], rejected: paths.map(() => NOT_AVAILABLE) }),
  addPastedImage: async () => ({ accepted: [], rejected: [NOT_AVAILABLE] }),
  readAttachment: async () => ({ ok: false, error: NOT_AVAILABLE }),
  readAttachmentImage: async () => ({ ok: false, error: NOT_AVAILABLE }),
  getPathForFile: () => "",
  openNewTab: async () => {},
  listDocsTabs: async () => [],
  focusDocsTab: async () => {},
  onAiStream: noop,
  onMenuCommand: noop,
  onCloseCheck: noop,
  reportCloseCheck: () => {},
  onCloseSaveRequest: noop,
  reportCloseSaveResult: () => {},
  reportViewMenuState: () => {},
};

function makeProjectSummary(id: string, name: string): ProjectSummary {
  const now = new Date().toISOString();
  return { id, name, createdAt: now, updatedAt: now, fileCount: 0, lastActiveAt: now, isDefault: id === "default" };
}

const projectApi: ProjectApi = {
  resolveChat: async ({ tempChatId }) => ({ projectId: "default", chatId: tempChatId ?? "session" }),
  appendChat: async () => {},
  loadChat: async () => [],
  rebindChat: async ({ newChatId, tempChatId }) => ({ projectId: "default", chatId: newChatId ?? tempChatId ?? "session" }),
  listProjects: async () => [makeProjectSummary("default", "Default")],
  createProject: async ({ name }) => makeProjectSummary("default", name),
  renameProject: async () => {},
  deleteProject: async () => {},
  moveFile: async () => {},
  getTimeline: async () => [],
};

window.desktop = desktop;
window.projectApi = projectApi;
