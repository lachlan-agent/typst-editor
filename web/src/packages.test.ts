import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadPackage, parseSpec, PackageError } from "./packages";
import { buildArchive } from "./tar.test";

// The cache is IndexedDB, which does not exist under Node. Stubbing it keeps
// these tests about fetching and unpacking; the cache path is exercised
// separately below.
const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => void store.set(key, value),
  del: async (key: string) => void store.delete(key),
}));

function archiveResponse(files: Record<string, string>): Response {
  const bytes = buildArchive(files, { gzip: true });
  return new Response(bytes as BlobPart, { status: 200 });
}

const PACKAGE = {
  "typst.toml": '[package]\nname = "demo"\nversion = "1.0.0"\nentrypoint = "lib.typ"\n',
  "lib.typ": "#let hello = [hi]\n",
};

beforeEach(() => {
  store.clear();
});

describe("parseSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(parseSpec("@preview/cetz:0.3.1")).toEqual({
      namespace: "preview",
      name: "cetz",
      version: "0.3.1",
    });
  });

  it.each([
    "@preview/cetz",
    "preview/cetz:0.3.1",
    "@preview/cetz:0.3",
    "@preview//cetz:0.3.1",
    "@preview/Cetz:0.3.1",
  ])("rejects %s", (spec) => {
    expect(() => parseSpec(spec)).toThrow(PackageError);
  });
});

describe("loadPackage", () => {
  it("downloads, gunzips and untars a package", async () => {
    const fetchImpl = vi.fn(async () => archiveResponse(PACKAGE));
    const files = await loadPackage("@preview/demo:1.0.0", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://packages.typst.org/preview/demo-1.0.0.tar.gz",
    );
    const byPath = new Map(
      files.map((f) => [f.path, new TextDecoder().decode(f.data)]),
    );
    expect(byPath.get("/typst.toml")).toContain('name = "demo"');
    expect(byPath.get("/lib.typ")).toBe("#let hello = [hi]\n");
  });

  it("serves the second request from the cache without fetching", async () => {
    const fetchImpl = vi.fn(async () => archiveResponse(PACKAGE));
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const first = await loadPackage("@preview/demo:1.0.0", options);
    const second = await loadPackage("@preview/demo:1.0.0", options);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.map((f) => f.path).sort()).toEqual(
      first.map((f) => f.path).sort(),
    );
  });

  it("announces a download only when it actually goes to the network", async () => {
    const onDownload = vi.fn();
    const options = {
      fetchImpl: (async () => archiveResponse(PACKAGE)) as unknown as typeof fetch,
      onDownload,
    };

    await loadPackage("@preview/demo:1.0.0", options);
    await loadPackage("@preview/demo:1.0.0", options);

    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("unwraps an archive that nests the package in a directory", async () => {
    const fetchImpl = async () =>
      archiveResponse({
        "demo-1.0.0/typst.toml": PACKAGE["typst.toml"],
        "demo-1.0.0/lib.typ": PACKAGE["lib.typ"],
      });
    const files = await loadPackage("@preview/demo:1.0.0", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(files.map((f) => f.path).sort()).toEqual(["/lib.typ", "/typst.toml"]);
  });

  it("reports a package that does not exist", async () => {
    const fetchImpl = async () => new Response("", { status: 404 });
    await expect(
      loadPackage("@preview/nope:1.0.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/does not exist in the registry/);
  });

  it("reports a registry failure with its status", async () => {
    const fetchImpl = async () => new Response("", { status: 503 });
    await expect(
      loadPackage("@preview/demo:1.0.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/returned 503/);
  });

  it("reports a network failure in plain terms", async () => {
    const fetchImpl = async () => {
      throw new Error("offline");
    };
    await expect(
      loadPackage("@preview/demo:1.0.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/could not reach the package registry/);
  });

  it("rejects an archive with no manifest", async () => {
    const fetchImpl = async () => archiveResponse({ "lib.typ": "#let x = 1" });
    await expect(
      loadPackage("@preview/demo:1.0.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no typst.toml/);
  });

  it("rejects a body that is not a gzip archive", async () => {
    const fetchImpl = async () => new Response("not an archive", { status: 200 });
    await expect(
      loadPackage("@preview/demo:1.0.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it("refuses a namespace it cannot download", async () => {
    await expect(loadPackage("@local/mine:0.1.0")).rejects.toThrow(
      /only @preview packages/,
    );
  });

  it("does not cache a failed download", async () => {
    const failing = vi.fn(async () => new Response("", { status: 503 }));
    await expect(
      loadPackage("@preview/demo:1.0.0", {
        fetchImpl: failing as unknown as typeof fetch,
      }),
    ).rejects.toThrow();

    const succeeding = vi.fn(async () => archiveResponse(PACKAGE));
    const files = await loadPackage("@preview/demo:1.0.0", {
      fetchImpl: succeeding as unknown as typeof fetch,
    });
    expect(files).toHaveLength(2);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

describe("retryability", () => {
  const cases: Array<[string, () => Promise<Response>, boolean]> = [
    ["a 404", async () => new Response("", { status: 404 }), false],
    ["a 503", async () => new Response("", { status: 503 }), true],
    ["a 400", async () => new Response("", { status: 400 }), false],
    [
      "a network failure",
      async () => {
        throw new Error("offline");
      },
      true,
    ],
  ];

  it.each(cases)(
    "marks %s as retryable=%s",
    async (_name, fetchImpl, retryable) => {
      await expect(
        loadPackage("@preview/demo:1.0.0", {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ retryable });
    },
  );

  it("marks a malformed archive as permanent", async () => {
    const fetchImpl = async () => new Response("junk", { status: 200 });
    await expect(
      loadPackage("@preview/demo:1.0.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
