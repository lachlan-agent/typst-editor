/**
 * The shared window system (../../shared/windows.ts) with this app's
 * window kinds pinned. main.ts and preview.ts import from here.
 */

import type { Win as SharedWin, WindowManagerOptions as SharedWindowManagerOptions } from "../../shared/windows";
import type { WindowKind } from "./settings";

export * from "../../shared/windows";
export type Win = SharedWin<WindowKind>;
export type WindowManagerOptions = SharedWindowManagerOptions<WindowKind>;
