import type { DesktopApi } from "../shared/ipc";
import type { ProjectApi, ProjectSummary } from "@genoffice/project-store";

const NOT_AVAILABLE = "not available in the web build";
const noop = (): (() => void) => () => {};

const desktop: DesktopApi = {
  getLanguage: async () => "en",
  onLanguageChanged: noop,
  getTheme: async () => "system",
  onThemeChanged: noop,
  openDocx: async () => null,
  openDocxPath: async () => null,
  consumePendingOpenDocx: async () => null,
  consumeNewBlankDoc: async () => true,
  onOpenDocx: noop,
  onRenamedDocx: noop,
  saveDocx: async () => ({ ok: false, error: NOT_AVAILABLE }),
  writeRecoveryCopy: async () => ({ ok: false }),
  onTeardown: noop,
  saveDocxAs: async () => ({ ok: false, error: NOT_AVAILABLE }),
  saveDocxNew: async () => ({ ok: false, error: NOT_AVAILABLE }),
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
