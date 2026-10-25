import { useEffect, useState } from "react";
import { artifactUrl, type Artifact } from "./api.ts";
import { Button, IconButton, Tabs } from "./ui/index.ts";
import { Close, Download, FileIcon, Globe, ImageIcon } from "./ui/icons.tsx";
import "./Preview.css";

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|x-sh))/;
const TEXT_EXTENSIONS = /\.(md|txt|json|csv|js|ts|tsx|css|py|sh|yaml|yml|xml|svg)$/i;
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

function isText(artifact: Artifact): boolean {
  return TEXT_TYPES.test(artifact.mimeType ?? "") || TEXT_EXTENSIONS.test(artifact.name);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function TabIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "page") return <Globe />;
  if (artifact.type === "screenshot") return <ImageIcon />;
  return <FileIcon />;
}

function TextPaper({ url, artifact }: { url: string; artifact: Artifact }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    fetch(url)
      .then((response) => (response.ok ? response.text() : Promise.reject(response.status)))
      .then((body) => !cancelled && setText(body))
      .catch(() => !cancelled && setText("Could not load this file."));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className="paper">
      <div className="paper-head">
        <FileIcon />
        <span>{artifact.name}</span>
      </div>
      <pre>{text ?? "Loading…"}</pre>
    </div>
  );
}

function Stage({ conversationId, artifact }: { conversationId: string; artifact: Artifact }) {
  const url = artifactUrl(conversationId, artifact.id);
  if (artifact.type === "page") {
    // The backend serves the page with `Content-Security-Policy: sandbox allow-scripts ...`, so
    // it runs in an opaque origin: its scripts run, but cannot reach this app or its cookies.
    // (The header rather than the iframe's `sandbox` attribute: it also holds when the page is
    // opened on its own, and some embedded browsers refuse sandboxed frames.)
    return <iframe className="stage-frame" title={artifact.name} src={url} />;
  }
  if (artifact.type === "screenshot")
    return <img className="stage-media" src={url} alt={artifact.name} />;
  if (artifact.type === "video") return <video className="stage-media" src={url} controls />;
  if (isText(artifact) && (artifact.sizeBytes ?? 0) <= TEXT_PREVIEW_MAX_BYTES) {
    return <TextPaper url={url} artifact={artifact} />;
  }
  return (
    <div className="download-card">
      <div className="download-tile">
        <FileIcon size={28} />
      </div>
      <div className="download-name">{artifact.name}</div>
      <div className="download-size">{formatBytes(artifact.sizeBytes)}</div>
      <Button href={artifactUrl(conversationId, artifact.id, true)}>Download</Button>
    </div>
  );
}

interface PreviewProps {
  conversationId: string;
  artifacts: Artifact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function Preview({
  conversationId,
  artifacts,
  selectedId,
  onSelect,
  onClose,
}: PreviewProps) {
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts.at(-1);
  return (
    <section className="preview" aria-label="Preview">
      <header className="preview__bar">
        <Tabs
          label="Files"
          items={artifacts.map((artifact) => ({
            id: artifact.id,
            label: artifact.name,
            icon: <TabIcon artifact={artifact} />,
          }))}
          selectedId={selected?.id}
          onSelect={onSelect}
        />
        {selected && (
          <IconButton
            label="Download"
            size="sm"
            href={artifactUrl(conversationId, selected.id, true)}
          >
            <Download />
          </IconButton>
        )}
        <IconButton label="Close preview" size="sm" onClick={onClose}>
          <Close />
        </IconButton>
      </header>
      <div className="stage">
        {selected ? (
          <Stage conversationId={conversationId} artifact={selected} key={selected.id} />
        ) : (
          <div className="stage-empty">What Pixel makes shows up here.</div>
        )}
      </div>
    </section>
  );
}
