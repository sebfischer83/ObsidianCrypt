import type { SyncStatus } from "../sync/SyncController";

/** Renders the sync status into the Obsidian status bar item. */
export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    onClick: () => void,
  ) {
    el.addClass("mod-clickable");
    el.setAttribute("aria-label", "Encrypted sync status");
    el.addEventListener("click", onClick);
  }

  render(status: SyncStatus): void {
    this.el.setText(statusText(status));
    this.el.setAttribute("aria-label", status.message ?? "Encrypted sync");
  }
}

export function statusText(status: SyncStatus): string {
  switch (status.state) {
    case "notConfigured":
      return "☁ Not configured";
    case "locked":
      return "🔒 Locked";
    case "syncing":
      return "↻ Syncing";
    case "offline":
      return status.pending > 0 ? `☁ Offline · ${status.pending} pending` : "☁ Offline";
    case "rateLimited":
      return "⏳ Rate limited";
    case "blocked":
      return "⛔ Sync stopped";
    case "error":
      return "⚠ Sync error";
    case "idle":
      if (status.conflicts > 0) return `⚠ ${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`;
      if (status.pending > 0) return `☁ ${status.pending} pending`;
      return "☁ Synced";
  }
}
