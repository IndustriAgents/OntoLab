import { useRef, useState } from "react";
import { IconUpload } from "./icons";

interface Props {
  title: string;
  hint: string;
  accept: string;
  formats: string[];
  multiple?: boolean;
  /** also offer a "Choose folder" button (recursive directory pick) */
  allowDirectory?: boolean;
  error?: string | null;
  onFiles: (files: File[]) => void;
}

export function Dropzone({ title, hint, accept, formats, multiple, allowDirectory, error, onFiles }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const emit = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  // non-standard directory-picker attributes (Chromium/WebKit/Firefox)
  const dirAttrs = { webkitdirectory: "", directory: "", mozdirectory: "" } as Record<string, string>;

  return (
    <div
      className={"dropzone" + (drag ? " drag" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        emit(e.dataTransfer.files);
      }}
    >
      <h2>{title}</h2>
      <p>{hint}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <button className="btn" onClick={() => inputRef.current?.click()}>
          <IconUpload /> Choose file{multiple ? "s" : ""}
        </button>
        {allowDirectory && (
          <button className="btn ghost" onClick={() => dirRef.current?.click()}>
            Choose folder
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          emit(e.target.files);
          e.target.value = "";
        }}
      />
      {allowDirectory && (
        <input
          ref={dirRef}
          type="file"
          hidden
          multiple
          {...dirAttrs}
          onChange={(e) => {
            emit(e.target.files);
            e.target.value = "";
          }}
        />
      )}
      <div className="dz-formats">
        {formats.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </div>
      {error && <div className="dz-error">{error}</div>}
    </div>
  );
}
