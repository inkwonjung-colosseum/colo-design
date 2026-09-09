import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Image from "@tiptap/extension-image";
import type { ConfluenceConflict } from "@drafthouse/protocol";
import type { Daemon } from "./daemon-client";
import { ConfluenceBlock } from "./editor/ConfluenceBlock";
import { renderFrontmatter, splitFrontmatter, type Frontmatter } from "./editor/frontmatter";
import { docToMarkdown, markdownToDoc } from "./editor/markdown-view";
import { ConflictModal } from "./ConflictModal";

/** What a quote carries into the composer (DESIGN §4.3 선택 → 채팅 인용). */
export interface DocQuote {
  title: string;
  heading: string | null;
  text: string;
}

const AUTOSAVE_MS = 500;

export function DocEditor({
  daemon,
  path,
  onDirty,
  onQuote,
}: {
  daemon: Daemon;
  path: string | null;
  onDirty: (dirty: boolean) => void;
  onQuote: (quote: DocQuote | null) => void;
}) {
  const [frontmatter, setFrontmatter] = useState<Frontmatter>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawBody, setRawBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConfluenceConflict | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [quoteCandidate, setQuoteCandidate] = useState<{ text: string; heading: string | null } | null>(null);

  const revision = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Always-current save, for closures TipTap holds past their render. */
  const saveRef = useRef<() => void>(() => undefined);
  /** The open path for closures that outlive the render they were made in. */
  const pathRef = useRef<string | null>(null);
  pathRef.current = path;
  /**
   * TipTap destroys and recreates the editor when the path deps change, and a
   * captured instance can already be destroyed when a load lands — touching
   * `.commands` on one throws. Always go through the current instance.
   */
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);
  const attachments = useRef(new Map<string, string>()); // reference → data url
  const lock = daemon.docLock;
  const locked = lock?.locked === true;

  /** display data url → attachment reference, computed at serialize time. */
  const reverseAttachments = (): Map<string, string> => {
    const reverse = new Map<string, string>();
    attachments.current.forEach((dataUrl, reference) => reverse.set(dataUrl, reference));
    return reverse;
  };

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          // Tables and links come from their own extensions.
          link: false,
          listItem: { HTMLAttributes: {} },
        }),
        Link.configure({ openOnClick: false, autolink: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Image.configure({ inline: false, allowBase64: true }),
        ConfluenceBlock,
      ],
      content: { type: "doc", content: [{ type: "paragraph" }] },
      editable: false,
      onUpdate: () => {
        if (pathRef.current === null) return; // no document open yet
        // TipTap keeps this closure for the editor's lifetime; the actual
        // save must always run against the CURRENT render's state.
        revision.current += 1;
        setDirty(true);
        onDirty(true);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS);
      },
      onSelectionUpdate: ({ editor }) => {
        const { from, to } = editor.state.selection;
        const doc = editor.state.doc;
        if (to - from < 2) {
          setQuoteCandidate(null);
          return;
        }
        const text = doc.textBetween(from, to, "\n").trim();
        if (!text) {
          setQuoteCandidate(null);
          return;
        }
        // The nearest heading above the selection names where the quote is.
        let heading: string | null = null;
        type DocNode = { type: { name: string }; textContent: string };
        doc.forEach((node: DocNode) => {
          if (node.type.name === "heading") heading = node.textContent;
        });
        let seen: string | null = null;
        let done = false;
        doc.descendants((node: { type: { name: string }; textContent: string }, pos: number) => {
          if (done) return false;
          if (pos >= from) {
            done = true;
            return false;
          }
          if (node.type.name === "heading") seen = node.textContent;
          return true;
        });
        setQuoteCandidate({ text, heading: seen ?? heading });
        return undefined;
      },
      editorProps: {
        handlePaste: (_view, event) => handleFiles(event.clipboardData?.files),
        handleDrop: (_view, event) => handleFiles(event.dataTransfer?.files),
      },
    },
    [path],
  );
  editorRef.current = editor ?? null;

  /** A pasted/dropped image goes to the page's attachments folder first. */
  const handleFiles = (files: FileList | null | undefined): boolean => {
    if (!files || files.length === 0 || !path) return false;
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return false;
    for (const file of images) void uploadImage(file);
    return true;
  };

  const uploadImage = async (file: File) => {
    if (!path || !editor) return;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const saved = await daemon.api.docAttachmentSave(path, file.name, file.type, data);
      const dataUrl = `data:${file.type};base64,${data}`;
      attachments.current.set(saved.reference, dataUrl);
      editor.chain().focus().setImage({ src: dataUrl, alt: file.name }).run();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  // -- load -----------------------------------------------------------------

  const load = useCallback(async () => {
    if (!path) return;
    setNotice(null);
    const state = await daemon.api.docOpen(path);
    const { frontmatter: meta, body } = splitFrontmatter(state.markdown);
    setFrontmatter(meta);
    setConflict(state.conflict ?? null);
    attachments.current = new Map(
      state.attachments.map((attachment) => [
        `attachments/${meta.pageId}/${attachment.filename}`,
        `data:${attachment.mediaType};base64,${attachment.data}`,
      ]),
    );
    const display = swapReferences(body, attachments.current);
    setRawBody(body);
    setDirty(false);
    onDirty(false);
    revision.current += 1; // any in-flight save must not clobber this reload
    const current = editorRef.current;
    if (current && !current.isDestroyed) {
      current.commands.setContent(markdownToDoc(display), { emitUpdate: false });
    }
    // Keyed on daemon.api (stable), NOT the daemon state object: the state
    // object changes on every broadcast, which would reload the editor out
    // from under unsaved typing.
  }, [daemon.api, editor, onDirty, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // A mirror change for our page while we hold no unsaved work reloads it
  // (DESIGN §4.4: Claude 턴 실행 중 변경 실시간 반영).
  useEffect(() => {
    const changed = daemon.docChanged;
    if (!changed || changed.path !== path || dirty) return;
    void load();
  }, [daemon.docChanged, path, dirty, load]);

  useEffect(() => {
    if (editor) editor.setEditable(!locked && !rawMode && Boolean(path));
  }, [editor, locked, rawMode, path]);

  // -- save -----------------------------------------------------------------

  const currentMarkdown = useCallback((): string => {
    const body = rawMode ? rawBody : serializeEditor();
    // The placeholder frontmatter is stripped again; this is just "frontmatter
    // + body" built through the one renderer.
    return renderFrontmatter(`---\n---\n${body}`, frontmatter);
  }, [rawMode, rawBody, frontmatter]); // eslint-disable-line react-hooks/exhaustive-deps

  const serializeEditor = (): string => {
    if (!editor) return "";
    const json = editor.getJSON();
    // Swap display data urls back to their attachment references.
    const reverse = reverseAttachments();
    const walked = JSON.parse(
      JSON.stringify(json, (key, value) => {
        if (key === "src" && typeof value === "string") return reverse.get(value) ?? value;
        return value;
      }),
    );
    return docToMarkdown(walked);
  };

  const save = useCallback(
    async (markdown?: string) => {
      if (!path) return;
      const at = revision.current;
      const sent = markdown ?? currentMarkdown();
      try {
        const saved = await daemon.api.docSave(path, sent);
        setNotice(null);
        if (revision.current === at && !rawMode) {
          const { body } = splitFrontmatter(saved.markdown);
          const display = swapReferences(body, attachments.current);
          const mine = docToMarkdown(editor?.getJSON() ?? { type: "doc", content: [] });
          if (display.trim() !== mine.trim() && editor) {
            editor.commands.setContent(markdownToDoc(display), { emitUpdate: false });
          }
        }
        setDirty(false);
        onDirty(false);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [daemon.api, editor, currentMarkdown, onDirty, path, rawMode],
  );

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  }, [save]);

  saveRef.current = () => void save();

  // Tell the daemon while the editor holds unsaved work, so background pulls
  // defer (DESIGN §4.4 자동 pull 연기).
  useEffect(() => {
    if (!path) return;
    void daemon.api.docEditing(path, dirty).catch(() => undefined);
  }, [daemon, path, dirty]);

  useEffect(() => () => onDirty(false), [onDirty, path]);

  // -- conflict -------------------------------------------------------------

  const resolve = async (choice: "mine" | "theirs") => {
    if (!path) return;
    try {
      // 내 것으로 덮기 after a manual edit: save first so the file holds it.
      if (choice === "mine" && dirty) await save();
      await daemon.api.docResolve(path, choice);
      setManualOpen(false);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  if (!path) {
    return (
      <div className="doc-editor doc-editor--empty">
        <p className="hint">왼쪽에서 기획 문서를 선택해 주세요.</p>
      </div>
    );
  }

  return (
    <div className="doc-editor">
      <div className="doc-editor__bar">
        <input
          className="doc-editor__title"
          value={frontmatter.title ?? ""}
          aria-label="문서 제목"
          disabled={locked}
          onChange={(e) => {
            setFrontmatter({ ...frontmatter, title: e.target.value });
            setDirty(true);
            onDirty(true);
            scheduleSave();
          }}
        />
        <span className="hint">v{frontmatter.version ?? "?"}{dirty ? " · 저장 중…" : " · 저장됨"}</span>
        <button
          type="button"
          className={rawMode ? "preview__toggle preview__toggle--on" : "preview__toggle"}
          aria-pressed={rawMode}
          onClick={() => {
            if (rawMode && editor) {
              revision.current += 1;
              editor.commands.setContent(markdownToDoc(swapReferences(rawBody, attachments.current)), { emitUpdate: false });
            } else if (!rawMode) {
              setRawBody(serializeEditor());
            }
            setRawMode(!rawMode);
          }}
        >
          원문
        </button>
      </div>

      {locked && (
        <div className="notice notice--warn doc-editor__lock">
          <span className="notice__text">{lock?.reason ?? "읽기 전용"}</span>
        </div>
      )}
      {notice && (
        <div className="notice notice--error">
          <span className="notice__text">{notice}</span>
        </div>
      )}
      {conflict && !manualOpen && (
        <ConflictModal
          conflict={conflict}
          onResolve={(choice) => void resolve(choice)}
          onManual={() => setManualOpen(true)}
        />
      )}
      {manualOpen && conflict && (
        <ConflictModal
          conflict={conflict}
          manual
          onResolve={(choice) => void resolve(choice)}
          onManual={() => setManualOpen(false)}
        />
      )}

      {!rawMode && (
        <div className="doc-editor__toolbar" role="toolbar" aria-label="문서 서식">
          <button type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} className={editor?.isActive("heading", { level: 1 }) ? "doc-tool doc-tool--on" : "doc-tool"}>제목1</button>
          <button type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} className={editor?.isActive("heading", { level: 2 }) ? "doc-tool doc-tool--on" : "doc-tool"}>제목2</button>
          <button type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} className={editor?.isActive("heading", { level: 3 }) ? "doc-tool doc-tool--on" : "doc-tool"}>제목3</button>
          <button type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()} className={editor?.isActive("bulletList") ? "doc-tool doc-tool--on" : "doc-tool"}>• 목록</button>
          <button type="button" onClick={() => editor?.chain().focus().toggleOrderedList().run()} className={editor?.isActive("orderedList") ? "doc-tool doc-tool--on" : "doc-tool"}>1. 목록</button>
          <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()} className={editor?.isActive("bold") ? "doc-tool doc-tool--on" : "doc-tool"}><strong>B</strong></button>
          <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()} className={editor?.isActive("italic") ? "doc-tool doc-tool--on" : "doc-tool"}><em>I</em></button>
          <button type="button" onClick={() => editor?.chain().focus().toggleCode().run()} className={editor?.isActive("code") ? "doc-tool doc-tool--on" : "doc-tool"}>{"</>"}</button>
          <button type="button" onClick={() => editor?.chain().focus().toggleCodeBlock().run()} className={editor?.isActive("codeBlock") ? "doc-tool doc-tool--on" : "doc-tool"}>코드 블록</button>
          <button type="button" onClick={() => editor?.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()} className="doc-tool">표</button>
          <button
            type="button"
            className="doc-tool"
            onClick={() => {
              const url = window.prompt("링크 주소");
              if (url) editor?.chain().focus().setLink({ href: url }).run();
            }}
          >
            링크
          </button>
          <label className="doc-tool doc-tool--file">
            이미지
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadImage(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      )}

      {quoteCandidate && !locked && (
        <div className="doc-editor__quotefloat">
          <button
            type="button"
            className="primary"
            onClick={() => {
              onQuote({
                title: frontmatter.title ?? "",
                heading: quoteCandidate.heading,
                text: quoteCandidate.text,
              });
              setQuoteCandidate(null);
            }}
          >
            인용
          </button>
        </div>
      )}

      {rawMode ? (
        <textarea
          className="doc-editor__raw"
          value={rawBody}
          aria-label="원문 마크다운"
          spellCheck={false}
          disabled={locked}
          onChange={(e) => {
            setRawBody(e.target.value);
            revision.current += 1;
            setDirty(true);
            onDirty(true);
            scheduleSave();
          }}
        />
      ) : (
        <EditorContent editor={editor} className="doc-editor__content" />
      )}
    </div>
  );
}

/** Attachment references become display urls; unknown srcs pass through. */
function swapReferences(body: string, attachments: Map<string, string>): string {
  let out = body;
  attachments.forEach((dataUrl, reference) => {
    out = out.split(`(${reference})`).join(`(${dataUrl})`);
  });
  return out;
}
