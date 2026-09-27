import { Editor } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';

/**
 * Convert editor document to contract HTML.
 * Uses editor.getHTML() which already outputs in contract format
 * (.question, .math with data-tex, .figure.diagram, .options, .answer)
 */
export function toContractHtml(editor: Editor): string {
  return editor.getHTML();
}

/**
 * Parse contract HTML into editor document.
 * Uses ProseMirror DOMParser to parse HTML according to schema.
 */
export function fromContractHtml(editor: Editor, html: string): void {
  // Create a temporary DOM element to parse the HTML
  const temp = document.createElement('div');
  // D4 附带小修：trim() 消除往返尾部空 <p></p> 噪音
  temp.innerHTML = html.trim();

  // Parse using ProseMirror's DOMParser
  const parser = ProseMirrorDOMParser.fromSchema(editor.schema);
  const doc = parser.parse(temp);

  // Set the parsed content
  editor.commands.setContent(doc.toJSON());
}

/**
 * Normalize HTML for comparison (removes extra whitespace, normalizes attributes order).
 * Used in tests to compare contract HTML equivalence.
 */
export function normalizeHtml(html: string): string {
  const temp = document.createElement('div');
  temp.innerHTML = html.trim();

  // Normalize whitespace between tags
  const normalized = temp.innerHTML
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

/**
 * Check if two HTML strings are equivalent (ignoring whitespace and attribute order).
 */
export function isEquivalentHtml(html1: string, html2: string): boolean {
  return normalizeHtml(html1) === normalizeHtml(html2);
}
