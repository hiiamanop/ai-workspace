import { describe, expect, it } from 'vitest'
import { mergePPrFormat, parseDocx } from '../src/index'
import { buildDocx } from './helpers/build-docx'

const OFF = '<w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/>'

const TIGHT_STYLES =
  '<w:style w:type="paragraph" w:styleId="Tight"><w:name w:val="Tight"/>' +
  `<w:basedOn w:val="Normal"/><w:pPr>${OFF}</w:pPr></w:style>` +
  '<w:style w:type="paragraph" w:styleId="TightChild"><w:name w:val="Tight Child"/>' +
  '<w:basedOn w:val="Tight"/></w:style>'

async function parseFirst(pPrXml: string, extraStylesXml?: string) {
  const bytes = await buildDocx({
    bodyXml: `<w:p>${pPrXml ? `<w:pPr>${pPrXml}</w:pPr>` : ''}<w:r><w:t>x</w:t></w:r></w:p>`,
    extraStylesXml,
  })
  return (await parseDocx(bytes)).blocks[0]
}

describe('w:autoSpaceDE/DN parsing', () => {
  it('absent means Word default on: no autoSpace field', async () => {
    const block = await parseFirst('<w:jc w:val="center"/>')
    expect(block.format?.autoSpace).toBeUndefined()
  })

  it('both explicitly off parse to autoSpace false', async () => {
    const block = await parseFirst(OFF)
    expect(block.format?.autoSpace).toBe(false)
  })

  it('only one of DE/DN off keeps the default (the other class still gets the gap)', async () => {
    const block = await parseFirst('<w:autoSpaceDE w:val="0"/>')
    expect(block.format?.autoSpace).toBeUndefined()
  })

  it('unchanged paragraphs keep the raw autoSpace bytes on merge', async () => {
    const block = await parseFirst(OFF)
    expect(mergePPrFormat(block.rawPPr!, block.format)).toBe(`<w:pPr>${OFF}</w:pPr>`)
  })
})

describe('style-chain inheritance', () => {
  it('a style turning autoSpace off reaches its paragraphs', async () => {
    const block = await parseFirst('<w:pStyle w:val="Tight"/>', TIGHT_STYLES)
    expect(block.format?.autoSpace).toBe(false)
  })

  it('inherits through the basedOn chain', async () => {
    const block = await parseFirst('<w:pStyle w:val="TightChild"/>', TIGHT_STYLES)
    expect(block.format?.autoSpace).toBe(false)
  })

  it('explicit on in the pPr overrides a style-level off', async () => {
    const block = await parseFirst(
      '<w:pStyle w:val="Tight"/><w:autoSpaceDE/><w:autoSpaceDN/>',
      TIGHT_STYLES,
    )
    expect(block.format?.autoSpace).toBe(true)
  })
})

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
