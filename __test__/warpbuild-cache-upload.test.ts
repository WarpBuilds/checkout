import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs/promises'
import {createServer} from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {IGitSourceSettings} from '../src/git-source-settings.js'
import {contribute, setup} from '../src/warpbuild/mirror-cache.js'

const environment = {
  WARPBUILD_RUNNER_VERIFICATION_TOKEN: 'test-token',
  WARPBUILD_HOST_URL: 'https://api.example.test',
  GITHUB_REPOSITORY_ID: '123',
  GITHUB_REPOSITORY: 'octocat/hello-world',
  GITHUB_REF: 'refs/pull/42/merge',
  GITHUB_BASE_REF: 'main'
}
const savedEnv = new Map(
  Object.keys(environment).map(key => [key, process.env[key]])
)
const artifacts = new Map<string, Buffer>()
const server = createServer((request, response) => {
  const content = artifacts.get(request.url || '')
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
  if (!content || !range) {
    response.writeHead(404).end()
    return
  }
  const start = Number(range[1])
  const end = Math.min(Number(range[2]), content.length - 1)
  response.writeHead(206, {
    'content-range': `bytes ${start}-${end}/${content.length}`,
    'content-length': end - start + 1
  })
  response.end(content.subarray(start, end + 1))
})
let root: string
let repositoryPath: string
let cacheUrl: string
let commit: string
let cold: boolean
const requests: Array<{url: string; method: string}> = []

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', args, {cwd})
}

function settingsFor(
  fetchDepth: number,
  cacheUpload: boolean
): IGitSourceSettings {
  return {
    repositoryOwner: 'octocat',
    repositoryName: 'hello-world',
    repositoryPath,
    ref: 'refs/pull/42/merge',
    commit,
    fetchDepth,
    cacheUpload
  } as IGitSourceSettings
}

describe('cache-upload', () => {
  beforeAll(async () => {
    Object.assign(process.env, environment)
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-cache-upload-'))
    const source = path.join(root, 'source')
    await fs.mkdir(source)
    git(source, 'init', '-q')
    await fs.writeFile(path.join(source, 'file.txt'), 'cached contents\n')
    git(source, 'add', 'file.txt')
    git(
      source,
      '-c',
      'user.name=Checkout test',
      '-c',
      'user.email=checkout@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Initial commit'
    )
    commit = git(source, 'rev-parse', 'HEAD').toString().trim()
    git(source, 'update-ref', 'refs/remotes/origin/main', commit)
    const bundle = path.join(root, 'base.bundle')
    git(source, 'bundle', 'create', bundle, '--remotes=origin')
    artifacts.set('/base.bundle', await fs.readFile(bundle))
    artifacts.set(
      '/shallow.pack',
      execFileSync('git', ['pack-objects', '--stdout', '--revs'], {
        cwd: source,
        input: `${commit}\n`
      })
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address for the mirror test server')
    }
    cacheUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    repositoryPath = await fs.mkdtemp(path.join(root, 'checkout-'))
    git(repositoryPath, 'init', '-q')
    cold = false
    requests.length = 0
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method || 'GET'
      requests.push({url, method})
      if (method === 'POST') {
        return new Response('{}', {status: 409})
      }
      if (cold) {
        return new Response('{}', {status: 404})
      }
      const body = url.includes('/shallow/')
        ? {pack: {url: `${cacheUrl}/shallow.pack`}}
        : {base: {url: `${cacheUrl}/base.bundle`}, branch: null}
      return new Response(JSON.stringify(body), {status: 200})
    })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await fs.rm(repositoryPath, {recursive: true, force: true})
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
    await fs.rm(root, {recursive: true, force: true})
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it.each([0, 1])(
    'restores depth %i and cleans up refs with uploads disabled',
    async fetchDepth => {
      const settings = settingsFor(fetchDepth, false)
      expect(await setup(settings)).toBe(
        fetchDepth === 0 ? 'seeded' : 'shallow-seeded'
      )
      expect(
        git(repositoryPath, 'cat-file', '-p', `${commit}:file.txt`).toString()
      ).toBe('cached contents\n')
      expect(
        git(repositoryPath, 'for-each-ref', 'refs/wb').length
      ).toBeGreaterThan(0)

      await contribute(settings)

      expect(requests).toHaveLength(1)
      expect(requests[0].url).toContain('ref=main')
      expect(requests[0].method).toBe('GET')
      expect(git(repositoryPath, 'for-each-ref', 'refs/wb').toString()).toBe('')
      expect(
        git(repositoryPath, 'cat-file', '-p', `${commit}:file.txt`).toString()
      ).toBe('cached contents\n')
    }
  )

  it.each([0, 1])(
    'skips upload grants on a depth %i cache miss when disabled',
    async fetchDepth => {
      cold = true
      const settings = settingsFor(fetchDepth, false)
      expect(await setup(settings)).toBe('off')
      await contribute(settings)
      expect(requests).toHaveLength(1)
      expect(requests[0].method).toBe('GET')
    }
  )

  it.each([0, 1])(
    'requests a depth %i cache upload when enabled',
    async fetchDepth => {
      const settings = settingsFor(fetchDepth, true)
      expect(await setup(settings)).toBe(
        fetchDepth === 0 ? 'seeded' : 'shallow-seeded'
      )
      if (fetchDepth === 0) {
        await fs.writeFile(
          path.join(repositoryPath, 'file.txt'),
          'updated contents\n'
        )
        git(repositoryPath, 'add', 'file.txt')
        git(
          repositoryPath,
          '-c',
          'user.name=Checkout test',
          '-c',
          'user.email=checkout@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'New tip'
        )
        settings.commit = git(repositoryPath, 'rev-parse', 'HEAD')
          .toString()
          .trim()
      }
      await contribute(settings)
      expect(requests.at(-1)).toEqual({
        url: `https://api.example.test/api/v1/git-mirrors/${fetchDepth === 0 ? 'branch' : 'shallow'}/upload-url`,
        method: 'POST'
      })
      expect(git(repositoryPath, 'for-each-ref', 'refs/wb').toString()).toBe('')
    }
  )

  it.each([0, 1])(
    'requests a depth %i cache upload on a miss when enabled',
    async fetchDepth => {
      cold = true
      const settings = settingsFor(fetchDepth, true)
      expect(await setup(settings)).toBe(
        fetchDepth === 0 ? 'off' : 'shallow-cold'
      )
      await contribute(settings)
      expect(requests.at(-1)).toEqual({
        url: `https://api.example.test/api/v1/git-mirrors/${fetchDepth === 0 ? 'base' : 'shallow'}/upload-url`,
        method: 'POST'
      })
    }
  )
})
