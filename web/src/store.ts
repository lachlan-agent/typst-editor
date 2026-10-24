/**
 * Autosave to IndexedDB.
 *
 * Writes are debounced so that typing doesn't hammer the database, and a final
 * flush runs on `pagehide` so the last few seconds of work survive a closed
 * tab.
 */

import { del, get, set } from "idb-keyval";

import { Project } from "./project";
import { deserializeProject, serializeProject } from "./share";

const KEY = "typsteditor.project.v1";
const DEBOUNCE_MS = 1_000;

export class Store {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Project | null = null;

  constructor() {
    // `pagehide` fires for tab close, navigation and bfcache eviction, where
    // `beforeunload` is unreliable on mobile.
    window.addEventListener("pagehide", () => {
      void this.flush();
    });
  }

  /** Queues a save, replacing any save still waiting out the debounce. */
  save(project: Project): void {
    this.#pending = project;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const project = this.#pending;
    if (!project) return;
    this.#pending = null;

    try {
      await set(KEY, serializeProject(project));
    } catch (error) {
      // A full or blocked database must not take the editor down with it.
      console.warn("could not autosave the project", error);
    }
  }

  async load(): Promise<Project | null> {
    try {
      const bytes = await get<Uint8Array>(KEY);
      if (!bytes) return null;
      return deserializeProject(bytes);
    } catch (error) {
      console.warn("could not restore the saved project", error);
      return null;
    }
  }

  async clear(): Promise<void> {
    this.#pending = null;
    await del(KEY);
  }
}
