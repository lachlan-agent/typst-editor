/**
 * Downloading Typst packages.
 *
 * This is the one part of the editor that touches the network. Only a package
 * name and version leave the browser — never the document — and every package
 * is cached in IndexedDB, so a project that uses packages keeps working
 * offline after the first compile.
 */

import { get, set } from "idb-keyval";

import { readTar, stripCommonPrefix, type TarEntry } from "./tar";

/** Where `@preview` packages come from. */
export const PREVIEW_REGISTRY = "https://packages.typst.org/preview";

export interface PackageFile {
  /** Path within the package, with a leading slash. */
  path: string;
  data: Uint8Array;
}

export class PackageError extends Error {
  constructor(
    readonly spec: string,
    message: string,
    /**
     * Whether trying again could succeed.
     *
     * Being offline is worth retrying; a package that does not exist is not.
     * The caller uses this to decide whether to stop asking.
     */
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "PackageError";
  }
}

interface ParsedSpec {
  namespace: string;
  name: string;
  version: string;
}

export function parseSpec(spec: string): ParsedSpec {
  const match = /^@([a-z0-9-]+)\/([a-z0-9-]+):(\d+\.\d+\.\d+)$/.exec(spec);
  if (!match) {
    throw new PackageError(spec, `"${spec}" is not a valid package name`);
  }
  return { namespace: match[1]!, name: match[2]!, version: match[3]! };
}

function cacheKey(spec: string): string {
  return `typsteditor.package.v1:${spec}`;
}

/** The cached form: a flat list, since IndexedDB cannot store a Map cheaply. */
type CachedPackage = Array<[string, Uint8Array]>;

async function readCache(spec: string): Promise<PackageFile[] | null> {
  try {
    const cached = await get<CachedPackage>(cacheKey(spec));
    if (!cached) return null;
    return cached.map(([path, data]) => ({ path, data }));
  } catch {
    return null;
  }
}

async function writeCache(spec: string, files: PackageFile[]): Promise<void> {
  try {
    await set(
      cacheKey(spec),
      files.map((file) => [file.path, file.data] as [string, Uint8Array]),
    );
  } catch {
    // A full quota must not stop the package from being used this session.
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toPackageFiles(entries: TarEntry[]): PackageFile[] {
  // Registry archives hold the package contents at the root, but an archive
  // built by hand may wrap them in a directory; both are accepted.
  const hasManifestAtRoot = entries.some((entry) => entry.name === "typst.toml");
  const normalized = hasManifestAtRoot ? entries : stripCommonPrefix(entries);
  return normalized.map((entry) => ({
    path: `/${entry.name}`,
    data: entry.data,
  }));
}

/**
 * Fetches a package, from cache when possible.
 *
 * `fetchImpl` is injectable so the tests can exercise the whole path —
 * download, gunzip, untar, cache — without the network.
 */
export async function loadPackage(
  spec: string,
  options: {
    registry?: string;
    fetchImpl?: typeof fetch;
    onDownload?: (spec: string) => void;
  } = {},
): Promise<PackageFile[]> {
  const cached = await readCache(spec);
  if (cached) return cached;

  const { namespace, name, version } = parseSpec(spec);
  if (namespace !== "preview") {
    throw new PackageError(
      spec,
      `only @preview packages can be downloaded; ${spec} would have to be provided by hand`,
    );
  }

  const registry = options.registry ?? PREVIEW_REGISTRY;
  const url = `${registry}/${name}-${version}.tar.gz`;
  options.onDownload?.(spec);

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url);
  } catch (error) {
    throw new PackageError(
      spec,
      `could not reach the package registry: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  if (response.status === 404) {
    throw new PackageError(spec, `${spec} does not exist in the registry`);
  }
  if (!response.ok) {
    // A server-side error may clear up; a client-side one will not.
    throw new PackageError(
      spec,
      `the registry returned ${response.status} for ${spec}`,
      response.status >= 500,
    );
  }

  const archive = new Uint8Array(await response.arrayBuffer());
  let files: PackageFile[];
  try {
    files = toPackageFiles(readTar(await gunzip(archive)));
  } catch (error) {
    throw new PackageError(
      spec,
      `the archive for ${spec} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!files.some((file) => file.path === "/typst.toml")) {
    throw new PackageError(spec, `${spec} has no typst.toml, so it is not a package`);
  }

  await writeCache(spec, files);
  return files;
}
