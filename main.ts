import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";
import { EditorView } from "@codemirror/view";

interface RilSettings {
  readLaterFile: string;
}

const DEFAULT_SETTINGS: RilSettings = {
  readLaterFile: "ReadLater.md",
};

const UNREAD_HEADER = "## 未読";
const READ_HEADER = "## 既読";

export default class RilPlugin extends Plugin {
  settings: RilSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "add-link-from-clipboard",
      name: "Add link from clipboard",
      callback: () => this.addLinkFromClipboard(),
    });

    this.addCommand({
      id: "clear-archived",
      name: "Clear all archived links",
      callback: () => this.clearArchived(),
    });

    this.addCommand({
      id: "count-unread",
      name: "Show unread count",
      callback: () => this.showUnreadCount(),
    });

    // Window-level capture for Reading Mode
    this.registerDomEvent(
      window,
      "click",
      (evt: MouseEvent) => this.handleLinkClick(evt),
      true
    );

    // Live Preview (CM6): links render as <span class="cm-underline">, not <a>.
    // We get the click position in the document and parse the URL from the source line.
    this.registerEditorExtension(
      EditorView.domEventHandlers({
        click: (event: MouseEvent, view: EditorView) => {
          const target = event.target as HTMLElement;
          if (!target.classList.contains("cm-underline")) return false;

          const activeFile = this.app.workspace.getActiveFile();
          if (!activeFile || activeFile.path !== this.settings.readLaterFile)
            return false;

          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;

          const line = view.state.doc.lineAt(pos);
          const posInLine = pos - line.from;

          const href = extractUrlAtPos(line.text, posInLine);
          if (!href) return false;

          event.preventDefault();
          event.stopImmediatePropagation();
          this.archiveLink(href).then(() => window.open(href, "_blank"));
          return true;
        },
      })
    );

    // Reading Mode: attach handlers directly after rendering
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (ctx.sourcePath !== this.settings.readLaterFile) return;
      el.querySelectorAll("a.external-link").forEach((anchor) => {
        anchor.addEventListener("click", (evt) => {
          const href = (anchor as HTMLAnchorElement).href;
          if (!href) return;
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.archiveLink(href).then(() => window.open(href, "_blank"));
        });
      });
    });

    this.addSettingTab(new RilSettingTab(this.app, this));
  }

  private async addLinkFromClipboard() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      new Notice("クリップボードの読み取りに失敗しました");
      return;
    }

    const parsed = text
      .split(/\r?\n/)
      .map(parseClipboardLine)
      .filter((item): item is ParsedLink => item !== null);

    if (parsed.length === 0) {
      new Notice("クリップボードにURLが見つかりません");
      return;
    }

    // Read file first to check for duplicates before fetching titles
    await this.ensureFileExists();
    const file = this.app.vault.getAbstractFileByPath(this.settings.readLaterFile);
    if (!(file instanceof TFile)) {
      new Notice("ファイルのアクセスに失敗しました");
      return;
    }
    const existingContent = await this.app.vault.read(file);
    const existingUrls = extractUnreadUrls(existingContent);

    const newItems = parsed.filter(({ url }) => {
      if (existingUrls.has(url)) {
        console.log(`[RIL] skipped duplicate: ${url}`);
        return false;
      }
      return true;
    });
    const skipped = parsed.length - newItems.length;

    if (newItems.length === 0) {
      new Notice(`すべて重複のためスキップしました (${skipped} 件)`);
      return;
    }

    const needFetch = newItems.filter((p) => p.title === null).length;
    const notice = new Notice(
      needFetch > 0 ? `ページタイトルを取得中… (0 / ${needFetch})` : "保存中…",
      0
    );

    let done = 0;
    const entries = await Promise.all(
      newItems.map(async ({ url, title }) => {
        if (title === null) {
          try {
            const res = await requestUrl({ url, method: "GET" });
            const m = res.text.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (m) title = m[1].trim().replace(/\s+/g, " ");
          } catch {
            // fall back to URL as title
          }
          title = title ?? url;
          done++;
          notice.setMessage(`ページタイトルを取得中… (${done} / ${needFetch})`);
        }
        return `- [ ] [${title}](${url}) <!-- ${localDatetime()} -->`;
      })
    );

    notice.hide();

    let content = existingContent;
    for (const entry of entries) {
      content = insertIntoUnread(content, entry);
    }
    await this.app.vault.modify(file, content);

    const skippedNote = skipped > 0 ? `（${skipped} 件重複スキップ）` : "";
    new Notice(
      newItems.length === 1
        ? `保存しました: ${newItems[0].title ?? newItems[0].url}${skippedNote}`
        : `${newItems.length} 件保存しました${skippedNote}`
    );
  }

  private async showUnreadCount() {
    const file = this.app.vault.getAbstractFileByPath(this.settings.readLaterFile);
    if (!(file instanceof TFile)) {
      new Notice("未読リンクはありません (ファイル未作成)");
      return;
    }
    const content = await this.app.vault.read(file);
    const count = extractUnreadUrls(content).size;
    new Notice(count === 0 ? "未読リンクはありません" : `未読: ${count} 件`);
  }

  private async clearArchived() {
    const file = this.app.vault.getAbstractFileByPath(this.settings.readLaterFile);
    if (!(file instanceof TFile)) {
      new Notice("ファイルが見つかりません");
      return;
    }
    const content = await this.app.vault.read(file);
    const { result, removed } = clearArchivedSection(content);
    if (removed === 0) {
      new Notice("既読リンクはありません");
      return;
    }
    await this.app.vault.modify(file, result);
    new Notice(`既読を ${removed} 件削除しました`);
  }

  private handleLinkClick(evt: MouseEvent) {
    if (evt.button !== 0) return;

    const target = evt.target as HTMLElement;
    const link = target.closest("a") as HTMLAnchorElement | null;
    if (!link) return;

    const href = link.href;
    if (!href || (!href.startsWith("http://") && !href.startsWith("https://")))
      return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.path !== this.settings.readLaterFile) return;

    evt.preventDefault();
    evt.stopImmediatePropagation();

    this.archiveLink(href).then(() => window.open(href, "_blank"));
  }

  async archiveLink(url: string) {
    const file = this.app.vault.getAbstractFileByPath(
      this.settings.readLaterFile
    );
    if (!(file instanceof TFile)) {
      console.log("[RIL] archiveLink: file not found", this.settings.readLaterFile);
      return;
    }

    const content = await this.app.vault.read(file);
    console.log("[RIL] archiveLink: searching for", url);
    const result = moveToArchived(content, url);
    if (!result) {
      new Notice("リンクが未読セクションに見つかりませんでした");
      console.log("[RIL] archiveLink: URL not found in 未読 section");
      return;
    }
    await this.app.vault.modify(file, result);
    new Notice("アーカイブしました");
  }

  private async ensureFileExists() {
    const existing = this.app.vault.getAbstractFileByPath(
      this.settings.readLaterFile
    );
    if (existing) return;

    const dir = this.settings.readLaterFile.split("/").slice(0, -1).join("/");
    if (dir) {
      try {
        await this.app.vault.createFolder(dir);
      } catch {
        // folder may already exist
      }
    }
    await this.app.vault.create(
      this.settings.readLaterFile,
      `${UNREAD_HEADER}\n\n${READ_HEADER}\n`
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

interface ParsedLink {
  url: string;
  title: string | null; // null = needs fetch
}

// Parses one clipboard line. Supports (with optional leading indent/bullet/checkbox):
//   "[Title](https://...)"           → use provided title and URL
//   "https://example.com"            → fetch title
//   "https://example.com | My Title" → use provided title
function parseClipboardLine(line: string): ParsedLink | null {
  // Strip leading whitespace, bullet (- * +), and checkbox ([ ] / [x])
  const stripped = line.replace(/^[\t ]*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?/, "");

  // Markdown link: [title](url)
  const mdMatch = stripped.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (mdMatch) {
    return { url: mdMatch[2], title: mdMatch[1].trim() };
  }

  // "URL | Title" format
  const pipeIdx = line.indexOf(" | ");
  if (pipeIdx !== -1) {
    const url = line.slice(0, pipeIdx).trim();
    const title = line.slice(pipeIdx + 3).trim();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return { url, title: title || null };
    }
  }

  // Plain URL
  const trimmed = line.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { url: trimmed, title: null };
  }

  return null;
}

// Collects all URLs from the 未読 section of the file.
function clearArchivedSection(content: string): { result: string; removed: number } {
  const lines = content.split("\n");
  const readIdx = lines.findIndex((l) => l.trimEnd() === READ_HEADER);
  if (readIdx === -1) return { result: content, removed: 0 };

  // Count non-empty lines after the header (= archived entries)
  const removed = lines.slice(readIdx + 1).filter((l) => l.trim() !== "").length;
  const result = [...lines.slice(0, readIdx + 1), ""].join("\n");
  return { result, removed };
}

function localDatetime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function extractUnreadUrls(content: string): Set<string> {
  const lines = content.split("\n");
  const unreadIdx = lines.findIndex((l) => l.trimEnd() === UNREAD_HEADER);
  const readIdx = lines.findIndex((l) => l.trimEnd() === READ_HEADER);
  if (unreadIdx === -1) return new Set();
  const unreadEnd = readIdx > unreadIdx && readIdx !== -1 ? readIdx : lines.length;
  const urls = new Set<string>();
  for (let i = unreadIdx + 1; i < unreadEnd; i++) {
    const m = lines[i].match(/\]\((https?:\/\/[^)]+)\)/);
    if (m) urls.add(m[1]);
  }
  return urls;
}

// Returns the URL of the markdown link [text](url) that contains posInLine, or null.
function extractUrlAtPos(lineText: string, posInLine: number): string | null {
  const re = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    if (posInLine >= m.index && posInLine <= m.index + m[0].length) {
      return m[2];
    }
  }
  return null;
}

function insertIntoUnread(content: string, entry: string): string {
  const unreadIdx = content.indexOf(UNREAD_HEADER);
  if (unreadIdx !== -1) {
    const insertAt = unreadIdx + UNREAD_HEADER.length;
    return content.slice(0, insertAt) + "\n" + entry + content.slice(insertAt);
  }
  return `${UNREAD_HEADER}\n${entry}\n\n${READ_HEADER}\n\n${content}`;
}

function moveToArchived(content: string, url: string): string | null {
  const lines = content.split("\n");
  const unreadIdx = lines.findIndex((l) => l.trimEnd() === UNREAD_HEADER);
  const readIdx = lines.findIndex((l) => l.trimEnd() === READ_HEADER);

  if (unreadIdx === -1) return null;

  const unreadEnd =
    readIdx > unreadIdx && readIdx !== -1 ? readIdx : lines.length;

  let targetIdx = -1;
  for (let i = unreadIdx + 1; i < unreadEnd; i++) {
    if (lines[i].includes(url)) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) return null;

  const archivedLine = lines[targetIdx].replace(/^(\s*-\s*)\[ \]/, "$1[x]");
  lines.splice(targetIdx, 1);

  const newReadIdx = lines.findIndex((l) => l.trimEnd() === READ_HEADER);
  if (newReadIdx !== -1) {
    lines.splice(newReadIdx + 1, 0, archivedLine);
  } else {
    lines.push("", READ_HEADER, archivedLine);
  }

  return lines.join("\n");
}

class RilSettingTab extends PluginSettingTab {
  plugin: RilPlugin;

  constructor(app: App, plugin: RilPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Read It Later" });

    new Setting(containerEl)
      .setName("保存ファイル")
      .setDesc("リンクを保存するファイルのパス（Vault ルートからの相対パス）")
      .addText((text) =>
        text
          .setPlaceholder("ReadLater.md")
          .setValue(this.plugin.settings.readLaterFile)
          .onChange(async (value) => {
            this.plugin.settings.readLaterFile = value.trim() || "ReadLater.md";
            await this.plugin.saveSettings();
          })
      );
  }
}
