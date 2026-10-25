import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import type { ChatInputProps } from "../../contracts/composer";

/** File selection, paste and drop share the existing managed attachment upload. */
export function useComposerFileInput(input: ChatInputProps, canEdit: boolean) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string>();
  const busy = input.contextBusy === true || uploading;
  const enabled = canEdit && input.onUploadAttachmentFiles !== undefined;

  async function uploadFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0 || !enabled) return;
    if (pendingRef.current || input.contextBusy === true) {
      setNotice("附件正在处理，请完成后再添加。");
      return;
    }
    pendingRef.current = true;
    setUploading(true);
    setNotice(undefined);
    try {
      await input.onUploadAttachmentFiles?.(files);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传附件失败。");
    } finally {
      pendingRef.current = false;
      setUploading(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.currentTarget.files ?? []);
    // Reset before uploading so selecting the same file again still fires change.
    event.currentTarget.value = "";
    void uploadFiles(files);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (!enabled || files.length === 0) return;
    // Mixed text/file clipboard content keeps the textarea's normal text insertion.
    if (event.clipboardData.getData("text/plain").length === 0) event.preventDefault();
    void uploadFiles(files);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    if (enabled && !busy) setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = enabled && !busy ? "copy" : "none";
  }

  function onDragLeave(): void {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    dragDepthRef.current = 0;
    setDragging(false);
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    const items = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
    const directories = items.filter((item) => item.webkitGetAsEntry()?.isDirectory === true);
    const files = items.length === 0 ? Array.from(event.dataTransfer.files) : items
      .filter((item) => !directories.includes(item))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    void uploadFiles(files);
    if (directories.length > 0) setNotice("文件夹请通过“引用本地文件或文件夹”添加。");
  }

  return {
    fileInputRef,
    busy,
    dragging,
    notice,
    canAdd: enabled && !busy,
    onFileChange,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}

function hasFiles(data: DataTransfer): boolean {
  return Array.from(data.types).includes("Files");
}
