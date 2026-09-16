import type { Instance as EngineInstance } from "@miblox/core";

/**
 * A plain textarea with line numbers and Luau-aware indentation.
 *
 * Not a full code editor: shipping one would add a megabyte to the bundle for
 * a feature that is not what this project is about. Tab indents, Enter keeps
 * the current indent and adds one after a line that opens a block, which is
 * most of what writing a game script needs.
 */
export class ScriptEditor {
  readonly element: HTMLDivElement;
  private gutter: HTMLDivElement;
  private textarea: HTMLTextAreaElement;
  private title: HTMLDivElement;
  private target: EngineInstance | null = null;
  private onChange: () => void = () => {};

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "script-editor";
    this.element.innerHTML = `
      <div class="script-head"><span class="script-title">No script selected</span></div>
      <div class="script-body">
        <div class="gutter"></div>
        <textarea class="code" spellcheck="false" wrap="off"></textarea>
      </div>`;

    this.title = this.element.querySelector(".script-title")!;
    this.gutter = this.element.querySelector(".gutter")!;
    this.textarea = this.element.querySelector(".code")!;

    this.textarea.addEventListener("input", () => {
      this.commit();
      this.renderGutter();
    });
    this.textarea.addEventListener("scroll", () => {
      this.gutter.scrollTop = this.textarea.scrollTop;
    });
    this.textarea.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.show(null);
  }

  bind(onChange: () => void): void {
    this.onChange = onChange;
  }

  /** True when the given instance has a Source property to edit. */
  static isScript(instance: EngineInstance | null): boolean {
    return !!instance && "Source" in (instance as unknown as Record<string, unknown>);
  }

  show(instance: EngineInstance | null): void {
    this.target = ScriptEditor.isScript(instance) ? instance : null;
    if (!this.target) {
      this.title.textContent = "Select a Script, LocalScript or ModuleScript";
      this.textarea.value = "";
      this.textarea.disabled = true;
      this.renderGutter();
      return;
    }
    this.title.textContent = `${this.target.GetFullName()} (${this.target.className})`;
    this.textarea.disabled = false;
    this.textarea.value = (this.target as unknown as { Source: string }).Source ?? "";
    this.renderGutter();
  }

  private commit(): void {
    if (!this.target) return;
    (this.target as unknown as { Source: string }).Source = this.textarea.value;
    this.onChange();
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Stop Studio's own shortcuts firing while typing code.
    event.stopPropagation();

    if (event.key === "Tab") {
      event.preventDefault();
      this.insert("\t");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const start = this.textarea.selectionStart;
      const before = this.textarea.value.slice(0, start);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const indent = line.match(/^[\t ]*/)?.[0] ?? "";
      // One more level after a line that opens a block.
      const opensBlock = /\b(then|do|function|else|repeat)\s*$|\{\s*$|\(\s*$/.test(line.trim());
      this.insert(`\n${indent}${opensBlock ? "\t" : ""}`);
    }
  }

  private insert(text: string): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    this.textarea.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const caret = selectionStart + text.length;
    this.textarea.setSelectionRange(caret, caret);
    this.commit();
    this.renderGutter();
  }

  private renderGutter(): void {
    const lines = this.textarea.value.split("\n").length;
    this.gutter.innerHTML = Array.from({ length: Math.max(lines, 1) }, (_, i) => `<div>${i + 1}</div>`).join("");
  }
}
