import { notFound, redirect } from "next/navigation";

// Esta ruta quedó como deep-link legacy: el detalle leía la columna jsonb
// `conversations.messages`, que no tiene writers y siempre renderizaba
// "No hay mensajes". La vista real vive en el inbox de /admin/conversations
// con `?sel=<id>` como selección — se redirige para no romper links viejos
// (dashboard "Abrir Chat", historial del navegador, bookmarks).
type Params = Promise<{ id: string }>;

export default async function ConversationDetailPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const numericId = Number.parseInt(id, 10);

  if (!Number.isFinite(numericId) || numericId <= 0) notFound();

  redirect(`/admin/conversations?sel=${numericId}`);
}
