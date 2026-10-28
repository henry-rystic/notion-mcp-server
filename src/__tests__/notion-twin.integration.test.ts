import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { initProxy } from '../init-server'

/**
 * End-to-end workflows against notion-twin, a local stateful simulator of the
 * Notion API (https://www.rystic.ai/docs/simulators/notion). The real server is
 * built in-process from scripts/notion-openapi.json and driven over MCP, and
 * every request it makes lands on the twin, never on api.notion.com.
 *
 * Run with `npm run test:twin`. The twin comes from NOTION_TWIN_URL when set;
 * otherwise the suite starts one with the `rystic` CLI, and skips when neither
 * is available. `npm test` never runs this file.
 */

const SPEC_PATH = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
const SCENARIO = 'notion_team_wiki'

// The twin serves Notion-Version 2026-03-11 only, and this server sends
// 2025-09-03 on every operation but the two page-markdown ones. A
// Notion-Version configured globally wins over the per-operation default
// (HttpClient.buildDefaultHeaders), so the suite forces 2026-03-11 until the
// twin accepts 2025-09-03 (Rystic RYS-TBD).
const DEFAULT_HEADERS = { Authorization: 'Bearer secret_placeholder', 'Notion-Version': '2026-03-11' }
process.env.OPENAPI_MCP_HEADERS ??= JSON.stringify(DEFAULT_HEADERS)

// Ids seeded by the notion_team_wiki world.
const BOT = 'a1000000-0000-4000-8000-000000000001'
const WIKI = 'a1000000-0000-4000-8000-000000000101'
const HANDBOOK = 'a1000000-0000-4000-8000-000000000102'
const ONBOARDING = 'a1000000-0000-4000-8000-000000000103'
const TOOLING = 'a1000000-0000-4000-8000-000000000104'
const WEEKLY_SYNC = 'a1000000-0000-4000-8000-000000000105'
const MEETING_NOTES = 'a1000000-0000-4000-8000-000000000301'

type Twin = { url: string; stop: () => void }

function startTwin(): Twin | null {
  if (process.env.NOTION_TWIN_URL) {
    return { url: process.env.NOTION_TWIN_URL, stop: () => {} }
  }
  const name = `notion-mcp-server-test-${process.pid}`
  try {
    const out = execFileSync(
      'rystic',
      ['run', 'notion-twin', '-d', '--port', '0', '--scenario', SCENARIO, '--name', name, '--json'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    )
    const url = JSON.parse(out).data?.url
    if (!url) return null
    return {
      url,
      stop: () => {
        execFileSync('rystic', ['stop', name], { stdio: 'ignore' })
        execFileSync('rystic', ['rm', name], { stdio: 'ignore' })
      },
    }
  } catch {
    return null
  }
}

const twin = startTwin()
// vitest hides console output from a skipped file, so the reason rides in the title.
const SUITE = twin
  ? 'notion-mcp-server against notion-twin'
  : 'notion-mcp-server against notion-twin (skipped: set NOTION_TWIN_URL, or install the rystic CLI and log in, https://www.rystic.ai/docs/installation)'

afterAll(() => twin?.stop())

async function twinRequest(method: string, route: string, body?: unknown): Promise<any> {
  const res = await fetch(new URL(route, twin!.url), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`)
  }
  return res.status === 204 ? undefined : res.json()
}

/** The twin's registers, read straight from its state rather than through the API. */
const inspect = () => twinRequest('GET', '/_rystic/inspect')

/** Every API request the twin served since the last reset: method, route template and status. */
async function servedCalls(): Promise<Array<{ method: string; template: string; status: number }>> {
  return (await twinRequest('GET', '/_rystic/calls')).calls
}

async function connect(headers?: Record<string, string>): Promise<Client> {
  const proxy = await initProxy(SPEC_PATH, twin!.url, headers)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(serverTransport)
  const client = new Client({ name: 'notion-twin-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name: `API-${name}`, arguments: args })
  const [content] = result.content as Array<{ type: string; text: string }>
  return JSON.parse(content.text)
}

/** Call a tool and fail with the Notion error body if the API refused it. */
async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const data = await callTool(client, name, args)
  expect(data.object, `${name} answered ${JSON.stringify(data)}`).not.toBe('error')
  return data
}

const text = (content: string) => [{ type: 'text', text: { content } }]
const plainText = (richText: Array<{ plain_text: string }>) => richText.map((t) => t.plain_text).join('')

describe.skipIf(!twin)(SUITE, () => {
  let client: Client

  beforeEach(async () => {
    await twinRequest('POST', '/_rystic/scenario', { name: SCENARIO })
    client = await connect()
  })

  it('reads the connection’s own bot with get-self', async () => {
    const me = await callOk(client, 'get-self')

    expect(me).toMatchObject({ object: 'user', id: BOT, type: 'bot', name: 'Wiki Reader' })
    expect((await inspect()).state_user.member.id).toBe(me.id)
  })

  it('finds a page with post-search and reads it with retrieve-a-page', async () => {
    const found = await callOk(client, 'post-search', {
      query: 'Engineering Handbook',
      filter: { property: 'object', value: 'page' },
    })
    expect(found.results.map((r: any) => r.id)).toEqual([HANDBOOK])

    const page = await callOk(client, 'retrieve-a-page', { page_id: HANDBOOK })
    expect(page.parent).toEqual({ type: 'page_id', page_id: WIKI })
    expect(plainText(page.properties.title.title)).toBe('Engineering Handbook')
  })

  it('creates a page under a seeded parent with post-page', async () => {
    const page = await callOk(client, 'post-page', {
      parent: { page_id: WIKI },
      properties: { title: { title: text('Launch checklist') } },
    })

    const state = await inspect()
    expect(state.state_page[page.id].parent).toEqual({ type: 'page_id', page_id: WIKI })

    const children = await callOk(client, 'get-block-children', { block_id: WIKI })
    const childPage = children.results.find((b: any) => b.id === page.id)
    expect(childPage).toMatchObject({ type: 'child_page', child_page: { title: 'Launch checklist' } })
  })

  it('appends blocks with patch-block-children and reads them back in order', async () => {
    const before = await callOk(client, 'get-block-children', { block_id: ONBOARDING })

    const appended = await callOk(client, 'patch-block-children', {
      block_id: ONBOARDING,
      children: [
        { object: 'block', type: 'paragraph', paragraph: { rich_text: text('Laptop is on its way') } },
        { object: 'block', type: 'to_do', to_do: { rich_text: text('Set up 2FA'), checked: false } },
      ],
    })
    expect(appended.results.map((b: any) => b.type)).toEqual(['paragraph', 'to_do'])

    const after = await callOk(client, 'get-block-children', { block_id: ONBOARDING })
    expect(after.results.map((b: any) => b.id)).toEqual([
      ...before.results.map((b: any) => b.id),
      ...appended.results.map((b: any) => b.id),
    ])
    expect(plainText(after.results.at(-1).to_do.rich_text)).toBe('Set up 2FA')

    const state = await inspect()
    for (const block of appended.results) {
      expect(state.state_block[block.id].parent).toEqual({ type: 'page_id', page_id: ONBOARDING })
    }
  })

  it('edits a block with update-a-block and trashes it with delete-a-block', async () => {
    const appended = await callOk(client, 'patch-block-children', {
      block_id: ONBOARDING,
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: text('draft') } }],
    })
    const blockId = appended.results[0].id

    // The spec declares this body as { type, archived }; Notion reads the
    // block's type key, so that's what an MCP client sends.
    await callOk(client, 'update-a-block', { block_id: blockId, paragraph: { rich_text: text('final') } })
    const block = await callOk(client, 'retrieve-a-block', { block_id: blockId })
    expect(plainText(block.paragraph.rich_text)).toBe('final')

    await callOk(client, 'delete-a-block', { block_id: blockId })
    expect((await inspect()).state_block[blockId].in_trash).toBe(true)
    const children = await callOk(client, 'get-block-children', { block_id: ONBOARDING })
    expect(children.results.map((b: any) => b.id)).not.toContain(blockId)
  })

  it('filters a data source’s rows with query-data-source', async () => {
    const retro = await callOk(client, 'post-page', {
      parent: { type: 'data_source_id', data_source_id: MEETING_NOTES },
      properties: {
        Name: { title: text('Sprint retro') },
        Date: { date: { start: '2026-02-03' } },
      },
    })

    const byTitle = await callOk(client, 'query-data-source', {
      data_source_id: MEETING_NOTES,
      filter: { property: 'Name', title: { contains: 'Weekly' } },
    })
    expect(byTitle.results.map((r: any) => r.id)).toEqual([WEEKLY_SYNC])

    const byDate = await callOk(client, 'query-data-source', {
      data_source_id: MEETING_NOTES,
      filter: { property: 'Date', date: { on_or_after: '2026-02-01' } },
    })
    expect(byDate.results.map((r: any) => r.id)).toEqual([retro.id])
  })

  // https://github.com/makenotion/notion-mcp-server/issues/125 reports date
  // properties left empty by a page create, needing a second update to set.
  it('sets a date property on create with post-page, with no follow-up update (#125)', async () => {
    const page = await callOk(client, 'post-page', {
      parent: { type: 'data_source_id', data_source_id: MEETING_NOTES },
      properties: {
        Name: { title: text('Planning offsite') },
        Date: { date: { start: '2026-02-10', end: '2026-02-11' } },
      },
    })
    expect(page.properties.Date.date).toMatchObject({ start: '2026-02-10', end: '2026-02-11' })

    const read = await callOk(client, 'retrieve-a-page', { page_id: page.id })
    expect(read.properties.Date.date).toMatchObject({ start: '2026-02-10', end: '2026-02-11' })
    const item = await callOk(client, 'retrieve-a-page-property', { page_id: page.id, property_id: 'date' })
    expect(item).toMatchObject({ object: 'property_item', type: 'date', date: { start: '2026-02-10' } })

    expect((await inspect()).state_page[page.id].properties.Date.date.start).toBe('2026-02-10')
    const pageWrites = (await servedCalls()).filter((c) => c.template.startsWith('/v1/pages') && c.method !== 'GET')
    expect(pageWrites).toEqual([expect.objectContaining({ method: 'POST', template: '/v1/pages', status: 200 })])
  })

  it('reads and rewrites a page with retrieve-page-markdown and update-page-markdown', async () => {
    // The page-markdown operations pin Notion-Version 2026-03-11 themselves,
    // so they work on a connection configured with a token alone.
    const tokenOnly = await connect({ Authorization: DEFAULT_HEADERS.Authorization })

    const before = await callOk(tokenOnly, 'retrieve-page-markdown', { page_id: HANDBOOK })
    expect(before.markdown).toContain('# How we ship')
    expect(before.markdown).toContain('Small changes, reviewed same day')

    const updated = await callOk(tokenOnly, 'update-page-markdown', {
      page_id: HANDBOOK,
      type: 'update_content',
      update_content: {
        content_updates: [{ old_str: 'reviewed same day', new_str: 'reviewed within the hour' }],
      },
    })
    expect(updated.markdown).toContain('Small changes, reviewed within the hour')

    const after = await callOk(tokenOnly, 'retrieve-page-markdown', { page_id: HANDBOOK })
    expect(after.markdown).toBe(updated.markdown)
    const paragraphs = Object.values((await inspect()).state_block).filter(
      (b: any) => b.parent?.page_id === HANDBOOK && b.type === 'paragraph',
    )
    expect(paragraphs.map((b: any) => plainText(b.content.rich_text))).toContain(
      'Small changes, reviewed within the hour, behind a flag until the dashboards are boring.',
    )
  })

  it('moves a page under a new parent with move-page', async () => {
    await callOk(client, 'move-page', { page_id: TOOLING, parent: { type: 'page_id', page_id: HANDBOOK } })

    expect((await inspect()).state_page[TOOLING].parent).toEqual({ type: 'page_id', page_id: HANDBOOK })
    const oldParent = await callOk(client, 'get-block-children', { block_id: WIKI })
    expect(oldParent.results.map((b: any) => b.id)).not.toContain(TOOLING)
    const newParent = await callOk(client, 'get-block-children', { block_id: HANDBOOK })
    expect(newParent.results.map((b: any) => b.id)).toContain(TOOLING)
  })

  it('adds a comment with create-a-comment and lists it with retrieve-a-comment', async () => {
    const comment = await callOk(client, 'create-a-comment', {
      parent: { page_id: ONBOARDING },
      rich_text: text('Can we add a security training step?'),
    })
    expect(comment).toMatchObject({ object: 'comment', parent: { type: 'page_id', page_id: ONBOARDING } })

    const listed = await callOk(client, 'retrieve-a-comment', { block_id: ONBOARDING })
    expect(listed.results.map((c: any) => c.id)).toContain(comment.id)
    expect(plainText(listed.results.find((c: any) => c.id === comment.id).rich_text)).toBe(
      'Can we add a security training step?',
    )
    expect((await inspect()).state_comment[comment.id]).toBeDefined()
  })

  // https://github.com/makenotion/notion-mcp-server/issues/328: create-a-comment
  // is the one operation the spec gives no Notion-Version, so with a token
  // alone it is sent with no version at all and Notion refuses it. Drop
  // `.fails` once the spec declares the header.
  it.fails('sends a Notion-Version with create-a-comment on a token-only connection (#328)', async () => {
    const tokenOnly = await connect({ Authorization: DEFAULT_HEADERS.Authorization })

    const comment = await callTool(tokenOnly, 'create-a-comment', {
      parent: { page_id: ONBOARDING },
      rich_text: text('ping'),
    })

    // Any version that arrives passes here, even one the twin refuses: the
    // twin names the absent header as `undefined`.
    expect(comment.message ?? '').not.toContain('instead was `undefined`')
  })
})
