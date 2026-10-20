"use client";

import { FileText, Mic, Download, Image as ImageIcon } from "lucide-react";
import type { MediaAttachment } from "@/types/chat";

interface MediaRendererProps {
  media: MediaAttachment;
}

function resolveUrl(url: string): string {
  if (url.startsWith("http") || url.startsWith("//")) return url;
  // Rows saved before media left public/ carry /uploads/<path>; the bytes now
  // live behind the session-gated media route under the same relative path.
  const pathname = url.startsWith("/uploads/")
    ? `/api/media/${url.slice("/uploads/".length)}`
    : url;
  return `${typeof window !== "undefined" ? window.location.origin : ""}${pathname}`;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ImageMedia({ media }: { media: MediaAttachment }) {
  return (
    <div className="relative rounded-lg overflow-hidden group">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={resolveUrl(media.url)}
        alt={media.caption || "Imagen"}
        className="max-w-full max-h-64 rounded-lg object-cover cursor-pointer transition-transform group-hover:scale-[1.02]"
        loading="lazy"
      />
      {media.caption && (
        <p className="text-xs text-muted-foreground mt-1">{media.caption}</p>
      )}
    </div>
  );
}

function AudioMedia({ media }: { media: MediaAttachment }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2.5">
        <Mic className="h-4 w-4 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          {media.url ? (
            <audio
              controls
              src={resolveUrl(media.url)}
              className="w-full h-8"
              preload="none"
            />
          ) : (
            <span className="text-xs text-muted-foreground">Archivo no disponible</span>
          )}
        </div>
        {media.fileSize && (
          <span className="text-[10px] text-muted-foreground flex-shrink-0">
            {formatFileSize(media.fileSize)}
          </span>
        )}
      </div>
      {media.transcription && (
        <p className="text-xs text-muted-foreground italic px-1">
          &ldquo;{media.transcription}&rdquo;
        </p>
      )}
    </div>
  );
}

function VideoMedia({ media }: { media: MediaAttachment }) {
  return (
    <div className="relative rounded-lg overflow-hidden bg-black/40">
      {media.url ? (
        <video
          controls
          src={resolveUrl(media.url)}
          className="w-full max-h-48 rounded-lg"
          preload="metadata"
        />
      ) : (
        <div className="aspect-video flex items-center justify-center">
          <span className="text-xs text-muted-foreground">Archivo no disponible</span>
        </div>
      )}
      {media.caption && (
        <p className="text-xs text-muted-foreground px-2 pb-2">{media.caption}</p>
      )}
    </div>
  );
}

function DocumentMedia({ media }: { media: MediaAttachment }) {
  return (
    <a
      href={resolveUrl(media.url)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 bg-muted/40 rounded-lg px-3 py-2.5 border border-border hover:border-primary/30 transition-colors group"
    >
      <FileText className="h-5 w-5 text-primary flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">
          {media.fileName || "Documento"}
        </p>
        <div className="flex items-center gap-2">
          {media.mimeType && (
            <span className="text-[10px] text-muted-foreground uppercase">
              {media.mimeType.split("/").pop()}
            </span>
          )}
          {media.fileSize && (
            <span className="text-[10px] text-muted-foreground">
              {formatFileSize(media.fileSize)}
            </span>
          )}
        </div>
      </div>
      <Download className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
    </a>
  );
}

export function MediaRenderer({ media }: MediaRendererProps) {
  switch (media.type) {
    case "image":
      return <ImageMedia media={media} />;
    case "audio":
      return <AudioMedia media={media} />;
    case "video":
      return <VideoMedia media={media} />;
    case "document":
      return <DocumentMedia media={media} />;
    default:
      return (
        <div className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Archivo no soportado</span>
        </div>
      );
  }
}
