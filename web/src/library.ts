/**
 * The document library: named snapshots of the project, kept in this browser.
 *
 * The working project autosaves as you type (store.ts); saving here keeps a
 * copy under a name, the way shader-editor's shader list does. An entry holds
 * the serialized project (every file, images included) and the window layout
 * it was arranged in. IndexedDB rather than localStorage, since a project can
 * carry images.
 */

import { del, get, set } from "idb-keyval";

import type { Settings } from "./settings";

/** The layout fields a document carries with it. */
export type SavedLayout = Pick<
  Settings,
  "split" | "swapped" | "editorFloating" | "editorRect" | "windows"
>;

export interface LibraryEntry {
  id: string;
  name: string;
  updated: number;
  /** `serializeProject` output. */
  project: Uint8Array;
  layout?: SavedLayout;
  /** For the list: how many files, how big. */
  files: number;
  bytes: number;
}

/** What the working project is called, and the entry it came from. */
export interface DocumentIdentity {
  name: string;
  libId: string | null;
}

const LIBRARY_KEY = "typsteditor.library.v1";
const IDENTITY_KEY = "typsteditor.document.v1";
export const UNTITLED = "Untitled";
export const MAX_NAME = 64;

export async function loadLibrary(): Promise<LibraryEntry[]> {
  try {
    const list = await get<unknown>(LIBRARY_KEY);
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** False when the database refused (quota, private mode): the caller keeps its old list. */
export async function persistLibrary(library: LibraryEntry[]): Promise<boolean> {
  try {
    await set(LIBRARY_KEY, library);
    return true;
  } catch {
    return false;
  }
}

export async function clearLibrary(): Promise<void> {
  await del(LIBRARY_KEY);
}

function isEntry(x: unknown): x is LibraryEntry {
  const e = x as Partial<LibraryEntry> | null;
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.updated === "number" &&
    e.project instanceof Uint8Array
  );
}

export function loadIdentity(): DocumentIdentity {
  try {
    const raw = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "{}") as Partial<DocumentIdentity>;
    return {
      name: cleanName(typeof raw.name === "string" ? raw.name : ""),
      libId: typeof raw.libId === "string" ? raw.libId : null,
    };
  } catch {
    return { name: UNTITLED, libId: null };
  }
}

export function saveIdentity(identity: DocumentIdentity): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // A convenience; losing it must not interrupt editing.
  }
}

export function cleanName(raw: string): string {
  return raw.trim().slice(0, MAX_NAME) || UNTITLED;
}

export function newId(): string {
  return (
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

/** "14:02" today, "Oct 3" otherwise. */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} kB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
