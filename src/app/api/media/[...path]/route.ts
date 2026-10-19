import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import fs from "fs/promises";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
  ".ogg": "audio/ogg", ".opus": "audio/opus", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".pdf": "application/pdf", ".webm": "video/webm",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // public/uploads only holds INBOUND customer media (WhatsApp/Telegram voice
  // notes, photos, docs saved by saveMediaLocally) — product images go to
  // Cloudinary. Nothing here is meant to be public: require a session.
  // auth() throwing (no request scope, misconfigured secret) fails closed.
  let session;
  try {
    session = await auth();
  } catch {
    session = null;
  }
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const segments = (await params).path;
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Prevent directory traversal
  const cleanSegments = segments.map((s) => s.replace(/\.\./g, ""));
  const filePath = path.join(UPLOADS_DIR, ...cleanSegments);

  if (!filePath.startsWith(UPLOADS_DIR)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] || "application/octet-stream";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
