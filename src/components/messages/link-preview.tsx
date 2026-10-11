"use client";

import { useState, useEffect } from "react";
import { ExternalLink } from "lucide-react";

interface LinkPreviewProps {
  url: string;
}

interface OgData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

export function LinkPreview({ url }: LinkPreviewProps) {
  const [data, setData] = useState<OgData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((og) => {
        if (!cancelled && og.title) setData(og);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  if (!data) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex border border-border rounded-lg overflow-hidden hover:bg-muted/40 transition-colors group"
    >
      {data.image && (
        <div className="w-20 h-20 flex-shrink-0 bg-muted/40">
          {/* eslint-disable-next-line @next/next/no-img-element -- imagen OG de dominio externo arbitrario; next/image requeriría remotePatterns abierto y pierde el fallback onError */}
          <img
            src={data.image}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </div>
      )}
      <div className="flex-1 min-w-0 p-2.5">
        <p className="text-xs font-medium text-foreground line-clamp-1 leading-snug">
          {data.title}
        </p>
        {data.description && (
          <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5 leading-relaxed">
            {data.description}
          </p>
        )}
        <p className="flex items-center gap-1 text-[10px] text-foreground/40 mt-1">
          <ExternalLink className="h-3 w-3" />
          {data.siteName || new URL(url).hostname}
        </p>
      </div>
    </a>
  );
}
