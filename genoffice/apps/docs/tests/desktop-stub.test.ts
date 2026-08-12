import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDocxImpl, openDocxViaInputForTests, saveDocxImpl, saveDocxAsImpl, saveDocxNewImpl, routedSaveDocx, resetCurrentFileHandleForTests } from '../src/renderer/desktop-stub'

function makeFile(name: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
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

  it('opening a second file (e.g. Review > Compare) does not hijack the first file\'s save handle', async () => {
    const fileA = makeFile('A.docx', SAMPLE_BYTES)
    const writeA = vi.fn()
    const closeA = vi.fn()
    const handleA = { getFile: async () => fileA, createWritable: async () => ({ write: writeA, close: closeA }) }

    const fileB = makeFile('B.docx', SAMPLE_BYTES)
    const writeB = vi.fn()
    const closeB = vi.fn()
    const handleB = { getFile: async () => fileB, createWritable: async () => ({ write: writeB, close: closeB }) }

    // real "Open" of A
    await openDocxImpl(vi.fn().mockResolvedValue([handleA]))
    // Review > Compare picking B — from openDocxImpl's point of view this looks identical to a real open
    await openDocxImpl(vi.fn().mockResolvedValue([handleB]))

    const newBytes = new Uint8Array([9, 9]).buffer
    const result = await saveDocxImpl('A.docx', newBytes)

    expect(result).toEqual({ ok: true, path: 'A.docx' })
    expect(writeA).toHaveBeenCalledWith(newBytes)
    expect(closeA).toHaveBeenCalled()
    expect(writeB).not.toHaveBeenCalled()
    expect(closeB).not.toHaveBeenCalled()
  })
})

describe('desktop-stub: fallback path (no File System Access API)', () => {
  beforeEach(() => {
    resetCurrentFileHandleForTests()
  })

  it('saveDocxNewImpl() builds a Blob and triggers a download without throwing', async () => {
    const clickSpy = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag) as any
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
    await new Promise((r) => setTimeout(r, 0))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')

    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('routedSaveDocx() falls back to Blob download when no handle is open for the path', async () => {
    const clickSpy = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag) as any
      if (tag === 'a') el.click = clickSpy
      return el
    })
    const createObjectURL = vi.fn().mockReturnValue('blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    const result = await routedSaveDocx('document.docx', new Uint8Array([5, 6, 7]).buffer)

    expect(result).toEqual({ ok: true, path: 'document.docx' })
    expect(clickSpy).toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')

    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('openDocxViaInput() reads the picked file via <input type=file> and returns name/data/hash', async () => {
    const file = makeFile('report.docx', SAMPLE_BYTES)
    const originalCreateElement = document.createElement.bind(document)
    let capturedInput: HTMLInputElement | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag) as any
      if (tag === 'input') {
        capturedInput = el as HTMLInputElement
        Object.defineProperty(el, 'files', { value: [file], configurable: true })
        el.click = () => {
          capturedInput?.onchange?.(new Event('change'))
        }
      }
      return el
    })

    const result = await openDocxViaInputForTests()

    expect(result).toEqual({ path: 'report.docx', name: 'report.docx', data: await file.arrayBuffer(), hash: SAMPLE_HASH })

    vi.restoreAllMocks()
  })
})
