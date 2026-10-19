"use client"

import { useEffect, useMemo, useState } from "react"
import { useCart, cartKey } from "@/lib/cart/cart-context"
import {
  buildCatalogIndex,
  fetchPublicCatalog,
  orderReviewSignature,
  reconcileCart,
  type CatalogIndex,
} from "@/lib/cart/catalog"
import { CheckoutForm } from "./checkout-form"
import { CheckoutConfirmation } from "./checkout-confirmation"
import { useMediaQuery } from "@/hooks/use-media-query"
import { CatalogImage } from "@/components/products/catalog-image"
import { getCatalogProductImage } from "@/lib/catalog-images"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  ShoppingCart,
  Plus,
  Minus,
  Trash2,
} from "lucide-react"


type CartDrawerProps = {
  open: boolean
  onClose: () => void
}

export function CartDrawer({ open, onClose }: CartDrawerProps) {
  const {
    items,
    itemCount,
    updateQuantity,
    removeItem,
    clearCart,
    receipt,
    dismissReceipt,
  } = useCart()
  // Mobile renders the cart as a bottom sheet; desktop keeps the side drawer.
  const isMobile = useMediaQuery("(max-width: 767px)")
  // The drawer re-prices against the live catalog every time it opens: stored
  // snapshots may predate a price change, an archive or a stock-out. A failed
  // refresh keeps the last known catalog — never a reason to lock the cart.
  const [catalog, setCatalog] = useState<CatalogIndex | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchPublicCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(buildCatalogIndex(data))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])
  const reconciled = useMemo(() => reconcileCart(items, catalog), [items, catalog])
  const hasBlocked = reconciled.hasBlocked
  const checkoutable = reconciled.checkoutLines
  // Before the POST, verify the cart on screen is still the cart the catalog
  // allows: a drift aborts the submit so the updated prices get reviewed.
  async function revalidateCart() {
    try {
      const fresh = buildCatalogIndex(await fetchPublicCatalog())
      const drift =
        orderReviewSignature(items, catalog) !== orderReviewSignature(items, fresh)
      setCatalog(fresh)
      return !drift
    } catch {
      // Can't verify — don't block; the server re-prices and rejects conflicts.
      return true
    }
  }
  function fixBlocked() {
    for (const line of reconciled.lines) {
      if (line.orderable) continue
      const key = cartKey(line.item.type, line.item.product.id)
      if (line.status === "out_of_range" && line.entry) {
        updateQuantity(key, line.entry.maxQuantity)
      } else {
        removeItem(key)
      }
    }
  }
  return (
    <Sheet open={open} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        onDragDismiss={onClose}
        className={
          isMobile
            ? "flex max-h-[85svh] w-full flex-col overflow-hidden p-0"
            : "flex w-full flex-col overflow-y-auto p-5 sm:max-w-md"
        }
      >
        <SheetHeader className="shrink-0 flex-row items-center justify-between gap-0 px-5 pt-2">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <ShoppingCart className="size-5" />
            Tu Pedido
            {itemCount > 0 && (
              <span className="text-muted-foreground text-sm font-normal">
                ({itemCount} {itemCount === 1 ? "producto" : "productos"})
              </span>
            )}
          </SheetTitle>
        </SheetHeader>

        {receipt ? (
          <div className="px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-4">
            <CheckoutConfirmation
              receipt={receipt}
              onDone={() => {
                dismissReceipt();
                onClose();
              }}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-16 text-center">
            <ShoppingCart className="text-muted-foreground size-12 opacity-30" />
            <p className="text-muted-foreground text-sm">
              No hay productos en el carrito
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <div className="space-y-1 py-4">
              {reconciled.lines.map((line) => {
                const item = line.item
                const key = cartKey(item.type, item.product.id)
                const maxQuantity = line.entry?.maxQuantity ?? 99
                return (
                <div
                  key={key}
                  className="group flex items-center gap-2 rounded-lg p-2 transition-colors hover:bg-muted/50 sm:gap-3"
                >
                  <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md sm:h-12 sm:w-14">
                    <CatalogImage
                      src={getCatalogProductImage({ id: item.product.id, name: item.product.name, imageUrl: item.imageUrl })}
                      alt={item.product.name}
                      sizes="56px"
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {item.product.name}
                    </p>
                    {line.orderable ? (
                      <p className="text-muted-foreground text-xs tabular-nums">
                        ${line.effectivePrice.toLocaleString("es-AR")} c/u
                        {line.status === "price_changed" && (
                          <span className="text-primary/80">
                            {" "}· antes ${item.product.price.toLocaleString("es-AR")}
                          </span>
                        )}
                      </p>
                    ) : (
                      <p className="text-destructive text-xs">
                        {line.status === "out_of_range"
                          ? `Quedan ${line.entry?.maxQuantity ?? 0} disponibles`
                          : "Ya no está disponible"}
                      </p>
                    )}
                  </div>

                  {line.orderable ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-11 shrink-0 sm:size-7"
                        aria-label={`Quitar una unidad de ${item.product.name}`}
                        onClick={() => updateQuantity(key, item.quantity - 1)}
                      >
                        <Minus className="size-3" aria-hidden="true" />
                      </Button>
                      <span className="w-6 text-center text-sm tabular-nums">
                        {item.quantity}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-11 shrink-0 sm:size-7"
                        aria-label={`Agregar una unidad de ${item.product.name}`}
                        disabled={item.quantity >= maxQuantity}
                        onClick={() => updateQuantity(key, item.quantity + 1)}
                      >
                        <Plus className="size-3" aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}

                  <p className="hidden w-16 text-right text-sm font-medium tabular-nums sm:block">
                    {line.orderable
                      ? `$${(line.effectivePrice * item.quantity).toLocaleString("es-AR")}`
                      : "—"}
                  </p>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeItem(key)}
                    aria-label={`Eliminar ${item.product.name}`}
                    className="size-11 shrink-0 opacity-70 hover:opacity-100 transition-opacity sm:size-7"
                  >
                    <Trash2 className="size-3 text-destructive" aria-hidden="true" />
                  </Button>
                </div>
                )
              })}
            </div>

            <div className="space-y-3 pt-2">
              <Separator />

              <div className="space-y-1 px-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">${reconciled.total.toLocaleString("es-AR")}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-base font-semibold">
                  <span>Total</span>
                  <span className="text-4xl font-black font-mono tabular-nums">${reconciled.total.toLocaleString("es-AR")}</span>
                </div>
              </div>

              {reconciled.pricesChanged && (
                <p
                  role="status"
                  className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground"
                >
                  Actualizamos los precios con la carta actual. Revisá el total
                  antes de confirmar.
                </p>
              )}

              {hasBlocked && (
                <p role="alert" className="checkout-error">
                  Hay productos que ya no están disponibles.{" "}
                  <button type="button" onClick={fixBlocked}>
                    Quitarlos del pedido
                  </button>
                </p>
              )}

              {!hasBlocked && (
                <CheckoutForm key={checkoutable.map(i => `${i.type}:${i.id}`).join(",")} items={checkoutable} revalidateCart={revalidateCart} />
              )}

              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2 transition-colors"
                >
                  Vaciar carrito
                </button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
