/* eslint-disable i18n-text/no-en -- upstream convention */
import * as core from '@actions/core'

// Client for backend-core's git-mirror endpoints, authed by the runner verification
// token. The action seeds from a bare base mirror + a per-branch delta bundle (both
// presigned GETs), delta-fetches the tip from GitHub, then uploads the refreshed
// per-branch bundle — or, on a cold repo, the base — via a presigned PUT. Every call
// fails closed to stock checkout.

const API_TIMEOUT_MS = 10_000

export interface Presigned {
  url: string
  size_bytes?: number
}

// GET restore-url: what to seed before the delta fetch. 'cold' = no base yet.
export type RestoreLookup =
  | {kind: 'restore'; base: Presigned; branch: Presigned | null}
  | {kind: 'cold'}
  | {kind: 'disabled'}
  | {kind: 'error'}

// POST *upload-url: a presigned PUT, or a signal to skip (locked/disabled).
export type UploadGrant =
  | {kind: 'grant'; url: string}
  | {kind: 'locked'}
  | {kind: 'disabled'}
  | {kind: 'error'}

function baseUrl(): string {
  return (process.env['WARPBUILD_HOST_URL'] || '').replace(/\/+$/, '')
}

function authHeader(): string {
  return `Bearer ${process.env['WARPBUILD_RUNNER_VERIFICATION_TOKEN'] || ''}`
}

function endpoint(p: string): string {
  return `${baseUrl()}/api/v1/git-mirrors/${p}`
}

export async function lookupRestore(
  repoKey: string,
  ref: string
): Promise<RestoreLookup> {
  try {
    const res = await fetch(
      `${endpoint('restore-url')}?repo_key=${encodeURIComponent(
        repoKey
      )}&ref=${encodeURIComponent(ref)}`,
      {
        headers: {authorization: authHeader()},
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      }
    )
    if (res.status === 200) {
      const body = (await res.json()) as {
        base: Presigned
        branch: Presigned | null
      }
      return {kind: 'restore', base: body.base, branch: body.branch ?? null}
    }
    if (res.status === 404) {
      return {kind: 'cold'}
    }
    if (res.status === 403) {
      core.debug('[wb-cache] restore-url answered 403 (disabled)')
      return {kind: 'disabled'}
    }
    core.debug(`[wb-cache] restore-url answered ${res.status}`)
    return {kind: 'error'}
  } catch (error) {
    core.debug(`[wb-cache] restore-url failed: ${error}`)
    return {kind: 'error'}
  }
}

async function requestUpload(p: string, body: object): Promise<UploadGrant> {
  try {
    const res = await fetch(endpoint(p), {
      method: 'POST',
      headers: {
        authorization: authHeader(),
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.status === 200) {
      const b = (await res.json()) as {url: string}
      return {kind: 'grant', url: b.url}
    }
    if (res.status === 409) {
      return {kind: 'locked'}
    }
    if (res.status === 403) {
      return {kind: 'disabled'}
    }
    core.debug(`[wb-cache] ${p} answered ${res.status}`)
    return {kind: 'error'}
  } catch (error) {
    core.debug(`[wb-cache] ${p} failed: ${error}`)
    return {kind: 'error'}
  }
}

// Cold repo: request the single-flight grant to build + upload the base mirror.
export async function requestBaseUpload(repoKey: string): Promise<UploadGrant> {
  return requestUpload('base/upload-url', {repo_key: repoKey})
}

// Warm repo: request the grant to overwrite this branch's delta bundle.
export async function requestBranchUpload(
  repoKey: string,
  ref: string,
  sha: string
): Promise<UploadGrant> {
  return requestUpload('branch/upload-url', {repo_key: repoKey, ref, sha})
}

// GET shallow/restore-url: the per-branch depth-1 snapshot pack to seed a shallow checkout.
// 'cold' = no snapshot yet for this branch.
export type ShallowRestoreLookup =
  | {kind: 'restore'; pack: Presigned}
  | {kind: 'cold'}
  | {kind: 'disabled'}
  | {kind: 'error'}

export async function lookupShallowRestore(
  repoKey: string,
  ref: string
): Promise<ShallowRestoreLookup> {
  try {
    const res = await fetch(
      `${endpoint('shallow/restore-url')}?repo_key=${encodeURIComponent(
        repoKey
      )}&ref=${encodeURIComponent(ref)}`,
      {
        headers: {authorization: authHeader()},
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      }
    )
    if (res.status === 200) {
      const body = (await res.json()) as {pack: Presigned}
      return {kind: 'restore', pack: body.pack}
    }
    if (res.status === 404) {
      return {kind: 'cold'}
    }
    if (res.status === 403) {
      core.debug('[wb-cache] shallow restore-url answered 403 (disabled)')
      return {kind: 'disabled'}
    }
    core.debug(`[wb-cache] shallow restore-url answered ${res.status}`)
    return {kind: 'error'}
  } catch (error) {
    core.debug(`[wb-cache] shallow restore-url failed: ${error}`)
    return {kind: 'error'}
  }
}

// Warm branch: request the grant to overwrite this branch's shallow snapshot pack.
export async function requestShallowUpload(
  repoKey: string,
  ref: string
): Promise<UploadGrant> {
  return requestUpload('shallow/upload-url', {repo_key: repoKey, ref})
}
