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
