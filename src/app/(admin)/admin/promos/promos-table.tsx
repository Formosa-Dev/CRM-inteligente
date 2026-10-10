"use client";

import { useState } from "react";
import { createPromo, updatePromo, deletePromo, type PromoRow } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "next/navigation";

// El import de useRouter debe estar en el scope correcto
import { motion } from "framer-motion";
import { fadeUpSmall } from "@/lib/animation-variants";

function PromoForm({
  promo,
  onClose,
  onSaved,
}: {
  promo?: PromoRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(promo?.name || "");
  const [description, setDescription] = useState(promo?.description || "");
  const [customPrice, setCustomPrice] = useState(promo?.customPrice || "");
  const [active, setActive] = useState(promo?.active ?? true);
  const [imageUrl, setImageUrl] = useState(promo?.imageUrl || "");
  const [uploading, setUploading] = useState(false);
  const router = useRouter();

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/media/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) setImageUrl(data.url);
    setUploading(false);
  };

  const handleSubmit = async () => {
    const data = {
      name,
      description: description || undefined,
      imageUrl: imageUrl || undefined,
      customPrice: customPrice ? Number(customPrice) : undefined,
      active,
    };

    const result = promo
      ? await updatePromo(promo.id, data)
      : await createPromo(data);

    if (result.success) {
      onSaved();
      router.refresh();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <motion.div
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        className="bg-card border border-border rounded-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium text-foreground mb-4">
          {promo ? "Editar Promo" : "Nueva Promo"}
        </h2>

        <div className="flex flex-col gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Nombre *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-muted/40 border-border" />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Descripción</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="bg-muted/40 border-border" rows={3} />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Precio de promo</label>
            <Input value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder="Ej: 12000" className="bg-muted/40 border-border" />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Imagen</label>
            <Input type="file" accept="image/*" onChange={handleImageUpload} className="bg-muted/40 border-border text-xs" disabled={uploading} />
            {uploading && <p className="text-xs text-gold-bright mt-1">Subiendo...</p>}
            {imageUrl && (
              <div className="mt-2 flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- preview de imagen subida (blob/data URL); next/image no optimiza fuentes locales arbitrarias */}
                <img src={imageUrl} alt="Preview" className="w-16 h-16 object-cover rounded" />
                <span className="text-[10px] text-foreground/30 truncate">{imageUrl}</span>
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground/60">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Activa
          </label>

          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onClose} className="text-foreground/40 hover:text-foreground/60">
              Cancelar
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={!name} className="bg-primary/15 text-gold-bright hover:bg-primary/25 border border-primary/30">
              {promo ? "Guardar" : "Crear"}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export function PromosTable({ promos }: { promos: PromoRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<PromoRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    await deletePromo(id);
    setDeleting(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold tracking-tight text-gold-gradient">Promociones</h1>
        <Button
          type="button"
          onClick={() => setShowCreate(true)}
          className="bg-primary/15 text-gold-bright hover:bg-primary/25 border border-primary/30 h-8 text-xs"
        >
          + Nueva Promo
        </Button>
      </div>

      {promos.length === 0 ? (
        <div className="text-center py-20 text-foreground/20 text-sm">No hay promociones. Creá la primera.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {promos.map((p) => (
            <motion.div
              key={p.id}
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`rounded-xl border p-4 flex flex-col gap-3 bg-card hover:border-primary/40 transition-all cursor-pointer ${
                p.active ? "border-primary/30" : "border-border"
              }`}
              onClick={() => setEditing(p)}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground/90">{p.name}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${p.active ? "bg-emerald-500/10 text-emerald-300" : "bg-muted/40 text-foreground/30"}`}>
                  {p.active ? "Activa" : "Inactiva"}
                </span>
              </div>
              {p.description && <p className="text-xs text-foreground/50">{p.description}</p>}
              <div className="flex items-center justify-between">
                {p.customPrice && <span className="text-sm font-mono text-gold-bright">${Number(p.customPrice).toLocaleString("es-AR")}</span>}
                {/* eslint-disable-next-line @next/next/no-img-element -- thumbnail de URL externa arbitraria; convertir a next/image exige remotePatterns y cambia el layout */}
                {p.imageUrl && <img src={p.imageUrl} className="w-10 h-10 object-cover rounded" alt="" />}
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setDeleting(p.id); }}
                  className="h-7 text-[10px] px-2 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                >
                  Eliminar
                </Button>
              </div>
              {deleting === p.id && (
                <div className="flex gap-1 justify-end">
                  <Button type="button" size="sm" onClick={() => handleDelete(p.id)} className="h-6 text-[10px] px-2 bg-red-500/20 text-red-400">
                    Confirmar
                  </Button>
                  <Button type="button" size="sm" onClick={() => setDeleting(null)} variant="ghost" className="h-6 text-[10px] px-2 text-foreground/30">
                    ✕
                  </Button>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {showCreate && (
        <PromoForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); router.refresh(); }} />
      )}
      {editing && (
        <PromoForm promo={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} />
      )}
    </div>
  );
}
