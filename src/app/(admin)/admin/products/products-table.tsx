"use client";

import { useState, useTransition, useActionState, useEffect, useEffectEvent, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { fadeUpSmall } from "@/lib/animation-variants";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

import {
  deleteProduct,
  toggleProductAvailability,
  createProduct,
  updateProduct,
  type ProductsResponse,
} from "./actions";

// ─── Types ────────────────────────────────────────────────────────────────────

type Product = ProductsResponse["products"][number];

interface ProductsTableProps {
  initialProducts: Product[];
  currentPage: number;
  totalPages: number;
  currentCategory: string;
  currentLine: string;
}

type ActionState = { error?: string; success?: boolean } | null;

// ─── Display maps ─────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  hamburguesa: "Hamburguesa",
  acompanamiento: "Acompañamiento",
  pan_mayorista: "Pan Mayorista",
  tragos_vip: "Tragos V.I.P",
  bebidas: "Bebidas",
};

const LINE_LABEL: Record<string, string> = {
  pollo: "Pollo",
  carne: "Carne",
  clasica: "Clásica",
  pan: "Pan",
  tragos: "Tragos",
  bebidas: "Bebidas",
};

const CATEGORY_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  hamburguesa: "default",
  acompanamiento: "secondary",
  pan_mayorista: "outline",
  tragos_vip: "default",
  bebidas: "secondary",
};

const LINE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  pollo: "outline",
  carne: "secondary",
  clasica: "default",
  pan: "outline",
  tragos: "default",
  bebidas: "secondary",
};

// ─── Product Form ─────────────────────────────────────────────────────────────

interface ProductFormProps {
  product: Product | null;
  onClose: () => void;
}

function ProductForm({ product, onClose }: ProductFormProps) {
  const router = useRouter();
  const isEdit = product !== null;

  const [available, setAvailable] = useState(product?.available ?? true);
  const [comingSoon, setComingSoon] = useState(product?.comingSoon ?? false);
  const [imageUrlValue, setImageUrlValue] = useState(product?.imageUrl ?? "");
  const [imagePreview, setImagePreview] = useState(product?.imageUrl ?? "");
  const [uploading, setUploading] = useState(false);

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const localPreview = URL.createObjectURL(file);
    setImagePreview(localPreview);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/media/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Error al subir");
      }

      const data = await res.json();
      setImageUrlValue(data.url);
      toast.success("Imagen subida");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al subir imagen");
      setImagePreview(product?.imageUrl ?? "");
    } finally {
      setUploading(false);
      setTimeout(() => URL.revokeObjectURL(localPreview), 5000);
    }
  }

  async function formAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
    formData.set("available", String(available));
    formData.set("comingSoon", String(comingSoon));

    if (isEdit) {
      return updateProduct(product.id, formData);
    }
    return createProduct(formData);
  }

  const [state, dispatch, isPending] = useActionState(formAction, null);

  // useEffectEvent lee los valores más recientes de isEdit/onClose/router sin
  // incluirlos como deps: el efecto solo corre cuando cambia `state`.
  const notifySuccess = useEffectEvent(() => {
    toast.success(isEdit ? "Producto actualizado" : "Producto creado");
    router.refresh();
    onClose();
  });

  useEffect(() => {
    if (!state) return;
    if (state.success) {
      notifySuccess();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state]);

  const selectClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <form action={dispatch} className="flex flex-col gap-5 py-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Nombre *</Label>
        <Input id="name" name="name" required defaultValue={product?.name ?? ""} placeholder="Ej: Hamburguesa Clásica" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="description">Descripción</Label>
        <Textarea id="description" name="description" rows={3} defaultValue={product?.description ?? ""} placeholder="Descripción opcional del producto" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="price">Precio *</Label>
        <Input id="price" name="price" type="number" step="0.01" min="0" required defaultValue={product?.price ?? ""} placeholder="0.00" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Imagen del producto</Label>
        <input type="hidden" name="imageUrl" value={imageUrlValue} />
        <div className="flex items-start gap-4">
          <div className="w-20 h-20 rounded-xl overflow-hidden bg-muted/40 border border-border flex items-center justify-center shrink-0">
            {imagePreview ? (
              // eslint-disable-next-line @next/next/no-img-element -- preview de imagen subida (blob/data URL); next/image no optimiza fuentes locales arbitrarias
              <img src={imagePreview} alt="Preview" className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl text-foreground/20">📸</span>
            )}
          </div>
          <div className="flex flex-col gap-2 flex-1">
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={uploading}
                onClick={() => document.getElementById(`image-picker-${product?.id || "new"}`)?.click()}>
                {uploading ? "Subiendo..." : "Subir foto"}
              </Button>
              {imageUrlValue && (
                <Button type="button" variant="outline" size="sm"
                  onClick={() => { setImageUrlValue(""); setImagePreview(""); }}
                  className="text-red-400 hover:text-red-300">Quitar</Button>
              )}
            </div>
            <input id={`image-picker-${product?.id || "new"}`} type="file"
              accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={handleImageSelect} />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="category">Categoría *</Label>
        <select id="category" name="category" required defaultValue={product?.category ?? "hamburguesa"} className={selectClass}>
          <option value="hamburguesa">Hamburguesa</option>
          <option value="acompanamiento">Acompañamiento</option>
          <option value="pan_mayorista">Pan Mayorista</option>
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="line">Línea *</Label>
        <select id="line" name="line" required defaultValue={product?.line ?? "clasica"} className={selectClass}>
          <option value="pollo">Pollo</option>
          <option value="carne">Carne</option>
          <option value="clasica">Clásica</option>
          <option value="pan">Pan</option>
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sortOrder">Orden</Label>
        <Input id="sortOrder" name="sortOrder" type="number" min="0" defaultValue={product?.sortOrder ?? 0} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stock">Stock disponible</Label>
        <Input id="stock" name="stock" type="number" min="0" step="1" defaultValue={product?.stock ?? ""} placeholder="0 = no hay stock, vacío = ilimitado" />
        <p className="text-xs text-muted-foreground">
          Si el producto tiene stock limitado, poné cuántos quedan. Si está vacío, el agente asume que hay disponible.
        </p>
      </div>
      <div className="flex items-center justify-between rounded-md border p-3 transition-colors hover:bg-muted/20">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="available" className="cursor-pointer">Disponible</Label>
          <span className="text-xs text-muted-foreground">El producto aparece como disponible para la venta</span>
        </div>
        <Switch id="available" checked={available} onCheckedChange={setAvailable} />
      </div>
      <div className="flex items-center justify-between rounded-md border p-3 transition-colors hover:bg-muted/20">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="comingSoon" className="cursor-pointer">Próximamente</Label>
          <span className="text-xs text-muted-foreground">Muestra el producto como &quot;próximamente disponible&quot;</span>
        </div>
        <Switch id="comingSoon" checked={comingSoon} onCheckedChange={setComingSoon} />
      </div>
      <Button type="submit" disabled={isPending} className="btn-gold mt-2 transition-opacity hover:opacity-90">
        {isPending ? (isEdit ? "Guardando..." : "Creando...") : isEdit ? "Guardar cambios" : "Crear producto"}
      </Button>
    </form>
  );
}

// ─── Product Card ─────────────────────────────────────────────────────────────

function ProductCard({
  product,
  availability,
  onToggleAvailability,
  onEdit,
  onDelete,
  isPending,
}: {
  product: Product;
  availability: boolean;
  onToggleAvailability: (id: number, next: boolean) => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
  isPending: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border p-4 flex flex-col gap-3 bg-card transition-all duration-200 hover:border-primary/40"
    >
      {/* Header: Name */}
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-foreground/90 truncate">{product.name}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={CATEGORY_VARIANT[product.category]} className="text-[10px]">
            {CATEGORY_LABEL[product.category]}
          </Badge>
          <Badge variant={LINE_VARIANT[product.line]} className="text-[10px]">
            {LINE_LABEL[product.line]}
          </Badge>
        </div>
      </div>

      {/* Price + Stock */}
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-primary">
          {product.price != null
            ? `$ ${Number(product.price).toLocaleString("es-AR")}`
            : "—"}
        </div>
        <div className="flex items-center gap-1 text-xs">
          {product.stock != null ? (
            product.stock > 0 ? (
              <span className="text-green-400/80">Stock: {product.stock}</span>
            ) : (
              <span className="text-red-400/80">Sin stock</span>
            )
          ) : (
            <span className="text-foreground/30">Stock ilimitado</span>
          )}
        </div>
      </div>

      {/* Switches */}
      <div className="flex flex-col gap-2 pt-1 border-t border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs text-foreground/50">Disponible</span>
          <Switch
            checked={availability}
            disabled={isPending}
            onCheckedChange={(checked) => onToggleAvailability(product.id, checked)}
            aria-label={`Disponibilidad de ${product.name}`}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-foreground/50">Próximamente</span>
          <Switch
            checked={product.comingSoon}
            disabled
            aria-label={`Próximamente ${product.name}`}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onEdit(product)}
          className="flex-1 h-8 sm:h-7 text-xs transition-colors hover:border-primary/40 hover:text-primary"
        >
          ✏️ Editar
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDelete(product)}
          className="flex-1 h-8 sm:h-7 text-xs transition-opacity hover:opacity-90"
        >
          🗑️ Eliminar
        </Button>
      </div>
    </motion.div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProductsTable({
  initialProducts,
  currentPage,
  totalPages,
  currentCategory,
  currentLine,
}: ProductsTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [availability, setAvailability] = useState<Record<number, boolean>>(
    () => Object.fromEntries(initialProducts.map((p) => [p.id, p.available]))
  );

  const [categoryFilter, setCategoryFilter] = useState<string>(currentCategory);
  const [lineFilter, setLineFilter] = useState<string>(currentLine);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isNewProductOpen, setIsNewProductOpen] = useState(false);

  const isSheetOpen = isNewProductOpen || selectedProduct !== null;
  const sheetProduct = isNewProductOpen ? null : selectedProduct;

  function handleCloseSheet() {
    setIsNewProductOpen(false);
    setSelectedProduct(null);
  }

  const navigate = useCallback(
    (params: Record<string, string>) => {
      const sp = new URLSearchParams();
      if (params.category) sp.set("category", params.category);
      if (params.line) sp.set("line", params.line);
      if (params.page) sp.set("page", params.page);
      router.push(`/admin/products?${sp.toString()}`);
    },
    [router]
  );

  function handleToggleAvailability(id: number, next: boolean) {
    setAvailability((prev) => ({ ...prev, [id]: next }));

    startTransition(async () => {
      const result = await toggleProductAvailability(id, next);
      if ("error" in result && result.error) {
        setAvailability((prev) => ({ ...prev, [id]: !next }));
        toast.error("Error al actualizar disponibilidad");
      } else {
        toast.success(next ? "Producto disponible" : "Producto no disponible");
        router.refresh();
      }
    });
  }

  function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);

    startTransition(async () => {
      const result = await deleteProduct(id);
      if ("error" in result && result.error) {
        toast.error("Error al eliminar el producto");
      } else {
        toast.success("Producto eliminado");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Top bar: filters + new product button */}
      <motion.div
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
      >
        <div className="flex flex-wrap gap-2">
          <Select
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              navigate({ category: e.target.value, line: lineFilter, page: "" });
            }}
            className="w-[160px] sm:w-[180px]"
          >
            <option value="all">Todas las categorías</option>
            <option value="hamburguesa">Hamburguesa</option>
            <option value="acompanamiento">Acompañamiento</option>
            <option value="pan_mayorista">Pan Mayorista</option>
          </Select>

          <Select
            value={lineFilter}
            onChange={(e) => {
              setLineFilter(e.target.value);
              navigate({ category: categoryFilter, line: e.target.value, page: "" });
            }}
            className="w-[140px] sm:w-[160px]"
          >
            <option value="all">Todas las líneas</option>
            <option value="pollo">Pollo</option>
            <option value="carne">Carne</option>
            <option value="clasica">Clásica</option>
            <option value="pan">Pan</option>
          </Select>
        </div>

        <motion.div whileHover={{ y: -1 }} transition={{ duration: 0.15 }}>
          <Button onClick={() => setIsNewProductOpen(true)}>
            + Nuevo Producto
          </Button>
        </motion.div>
      </motion.div>

      {/* Product Cards Grid */}
      <motion.div
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        transition={{ delay: 0.08 }}
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
      >
        {initialProducts.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center py-20 text-foreground/20">
            <span className="text-4xl mb-3 opacity-30">📦</span>
            <p className="text-sm">
              {currentCategory !== "all" || currentLine !== "all"
                ? "No hay productos que coincidan con los filtros."
                : "No hay productos. Creá el primero con el botón de arriba."}
            </p>
          </div>
        ) : (
          initialProducts.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              availability={availability[product.id] ?? product.available}
              onToggleAvailability={handleToggleAvailability}
              onEdit={setSelectedProduct}
              onDelete={setDeleteTarget}
              isPending={isPending}
            />
          ))
        )}
      </motion.div>

      {/* Pagination */}
      {totalPages > 1 && (
        <motion.div variants={fadeUpSmall} className="flex items-center justify-center gap-2 pt-2">
          <Button
            type="button"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => navigate({ category: categoryFilter, line: lineFilter, page: String(currentPage - 1) })}
            variant="outline"
            className="h-8 text-xs border-border"
          >
            ← Anterior
          </Button>
          <span className="text-xs text-foreground/30">
            {currentPage} / {totalPages}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => navigate({ category: categoryFilter, line: lineFilter, page: String(currentPage + 1) })}
            variant="outline"
            className="h-8 text-xs border-border"
          >
            Siguiente →
          </Button>
        </motion.div>
      )}

      {/* Create / Edit Sheet */}
      <Sheet open={isSheetOpen} onOpenChange={(open) => { if (!open) handleCloseSheet(); }}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader className="border-b border-primary/20 pb-4">
            <SheetTitle className="text-gold-gradient">
              {isNewProductOpen ? "Nuevo Producto" : "Editar Producto"}
            </SheetTitle>
            <SheetDescription>
              {isNewProductOpen
                ? "Completá los datos para agregar un nuevo producto al menú."
                : `Modificá los datos de "${selectedProduct?.name}".`}
            </SheetDescription>
          </SheetHeader>
          <ProductForm key={isNewProductOpen ? "new" : String(selectedProduct?.id)} product={sheetProduct} onClose={handleCloseSheet} />
        </SheetContent>
      </Sheet>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar producto?</AlertDialogTitle>
            <AlertDialogDescription>
              Estás por eliminar <span className="font-semibold">{deleteTarget?.name}</span>. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}