"use client"

import { useCart, cartKey } from "@/lib/cart/cart-context"
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
    total,
    itemCount,
    updateQuantity,
    removeItem,
    clearCart,
    receipt,
    dismissReceipt,
  } = useCart()
  // Mobile renders the cart as a bottom sheet; desktop keeps the side drawer.
  const isMobile = useMediaQuery("(max-width: 767px)")
  // Checkout only accepts catalog ids — drop stale entries persisted before
  // items were stored with real product ids.
  const checkoutable = items.filter((i) =>
    Number.isSafeInteger(Number(i.product.id)) && Number(i.product.id) > 0,
  )
  const hasStale = checkoutable.length !== items.length
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
                ({itemCount} {itemCount === 1 ? "item" : "items"})
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
              {items.map((item) => (
                <div
                  key={cartKey(item.type, item.product.id)}
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
                    <p className="text-muted-foreground text-xs tabular-nums">
                      ${item.product.price.toLocaleString("es-AR")} c/u
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-11 shrink-0 sm:size-7"
                      onClick={() =>
                        updateQuantity(cartKey(item.type, item.product.id), item.quantity - 1)
                      }
                    >
                      <Minus className="size-3" aria-label="Quitar una unidad" />
                    </Button>
                    <span className="w-6 text-center text-sm tabular-nums">
                      {item.quantity}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-11 shrink-0 sm:size-7"
                      onClick={() =>
                        updateQuantity(cartKey(item.type, item.product.id), item.quantity + 1)
                      }
                    >
                      <Plus className="size-3" aria-label="Agregar una unidad" />
                    </Button>
                  </div>

                  <p className="hidden w-16 text-right text-sm font-medium tabular-nums sm:block">
                    ${(item.product.price * item.quantity).toLocaleString("es-AR")}
                  </p>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeItem(cartKey(item.type, item.product.id))}
                    aria-label={`Eliminar ${item.product.name}`}
                    className="size-11 shrink-0 opacity-70 hover:opacity-100 transition-opacity sm:size-7"
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="space-y-3 pt-2">
              <Separator />

              <div className="space-y-1 px-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">${total.toLocaleString("es-AR")}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-base font-semibold">
                  <span>Total</span>
                  <span className="text-4xl font-black font-mono tabular-nums">${total.toLocaleString("es-AR")}</span>
                </div>
              </div>

              {hasStale && (
                <p role="alert" className="checkout-error">
                  Hay productos que ya no están disponibles.{" "}
                  <button
                    type="button"
                    onClick={() =>
                      items
                        .filter((i) => !checkoutable.includes(i))
                        .forEach((i) => removeItem(cartKey(i.type, i.product.id)))
                    }
                  >
                    Quitarlos del pedido
                  </button>
                </p>
              )}

              {!hasStale && (
                <CheckoutForm key={items.map(i => `${cartKey(i.type, i.product.id)}:${i.quantity}`).join(",")} items={checkoutable.map(i => ({ type: i.type, id: Number(i.product.id), quantity: i.quantity }))} />
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
