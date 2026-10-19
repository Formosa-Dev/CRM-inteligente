"use client"

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import { toast } from "sonner"
import { z } from "zod"
import type { CheckoutReceipt } from "@/lib/checkout/contract"

export type CartItemType = "product" | "promo"

export type CartProduct = {
  id: string
  name: string
  price: number
  emoji?: string
}

export type CartItem = {
  product: CartProduct
  quantity: number
  /** Catalog line the item belongs to — products and promos share the cart. */
  type: CartItemType
  imageUrl?: string | null
}

export type CartItemMeta = {
  type?: CartItemType
  imageUrl?: string | null
  /** Suppress the confirmation toast (inline menu steppers fire one per tap). */
  toast?: boolean
}

type CartContextValue = {
  items: CartItem[]
  total: number
  itemCount: number
  addItem: (product: CartProduct, qty?: number, meta?: CartItemMeta) => void
  removeItem: (key: string) => void
  updateQuantity: (key: string, qty: number) => void
  clearCart: () => void
  /**
   * Last confirmed order receipt. Lifted to the provider because success
   * empties the cart — parents render the confirmation outside the cart-lines
   * branch so it is not unmounted before it can paint.
   */
  receipt: CheckoutReceipt | null
  /** Clears the cart AND records the receipt in a single commit. */
  completeOrder: (receipt: CheckoutReceipt) => void
  dismissReceipt: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

const STORAGE_KEY = "muzapp-cart"
/** Retired per-menu cart key. The shared cart supersedes it. */
const LEGACY_DIGITAL_KEY = "muzapp-digital-cart"

/** Stable identity for a cart line, so a promo id never collides with a product id. */
export function cartKey(type: CartItemType, id: string | number) {
  return `${type}:${id}`
}

const cartItemSchema = z.object({
  product: z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    emoji: z.string().optional(),
  }),
  quantity: z.number().int().positive(),
  // Added after the first release — older lines default to a product.
  type: z.enum(["product", "promo"]).optional(),
  imageUrl: z.string().nullable().optional(),
})

function loadCart(): CartItem[] {
  if (typeof window === "undefined") return []
  try {
    try {
      localStorage.removeItem(LEGACY_DIGITAL_KEY)
    } catch {
      /* storage unavailable — nothing to migrate */
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const result = z.array(cartItemSchema).safeParse(parsed)
    if (!result.success) {
      console.warn("[cart] Invalid cart data in localStorage, clearing")
      localStorage.removeItem(STORAGE_KEY)
      return []
    }
    return result.data.map((item) => ({
      product: { ...item.product, emoji: item.product.emoji ?? "" },
      quantity: item.quantity,
      type: item.type ?? "product",
      imageUrl: item.imageUrl ?? null,
    }))
  } catch {
    return []
  }
}

function saveCart(items: CartItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    /* quota exceeded — silently ignore */
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([])
  const [receipt, setReceipt] = useState<CheckoutReceipt | null>(null)
  // Persist only after the first restore, so an empty initial render can never
  // overwrite a cart that is still being read back from storage.
  const hydrated = useRef(false)

  useEffect(() => {
    // Deferred so restore is hydration-safe and not flagged as a sync setState.
    const id = window.setTimeout(() => {
      setItems(loadCart())
      hydrated.current = true
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!hydrated.current) return
    saveCart(items)
  }, [items])

  const addItem = useCallback(
    (product: CartProduct, qty = 1, meta?: CartItemMeta) => {
      const type = meta?.type ?? "product"
      const key = cartKey(type, product.id)
      // A new item starts a new order intent — a stale confirmation must go.
      setReceipt(null)
      setItems((prev) => {
        const existing = prev.find((i) => cartKey(i.type, i.product.id) === key)
        if (existing) {
          return prev.map((i) =>
            cartKey(i.type, i.product.id) === key
              ? { ...i, quantity: i.quantity + qty }
              : i,
          )
        }
        return [
          ...prev,
          { product, quantity: qty, type, imageUrl: meta?.imageUrl ?? null },
        ]
      })
      if (meta?.toast !== false) {
        const emoji = product.emoji ? `${product.emoji} ` : ""
        toast(`${emoji}${product.name} agregado al carrito`)
      }
    },
    [],
  )

  const removeItem = useCallback((key: string) => {
    setItems((prev) => {
      const item = prev.find((i) => cartKey(i.type, i.product.id) === key)
      if (item) {
        const emoji = item.product.emoji ? `${item.product.emoji} ` : ""
        toast(`${emoji}${item.product.name} eliminado del carrito`)
      }
      return prev.filter((i) => cartKey(i.type, i.product.id) !== key)
    })
  }, [])

  const updateQuantity = useCallback(
    (key: string, qty: number) => {
      if (qty < 1) {
        removeItem(key)
        return
      }
      setItems((prev) =>
        prev.map((i) =>
          cartKey(i.type, i.product.id) === key ? { ...i, quantity: qty } : i,
        ),
      )
    },
    [removeItem],
  )

  const clearCart = useCallback(() => {
    setItems([])
    // Persist synchronously: a checkout redirect right after clearing must not
    // be able to resurrect the just-ordered cart from a stale localStorage copy.
    saveCart([])
  }, [])

  const completeOrder = useCallback((orderReceipt: CheckoutReceipt) => {
    setItems([])
    saveCart([])
    setReceipt(orderReceipt)
  }, [])

  const dismissReceipt = useCallback(() => setReceipt(null), [])

  const total = useMemo(
    () => items.reduce((sum, i) => sum + i.product.price * i.quantity, 0),
    [items],
  )

  const itemCount = useMemo(
    () => items.reduce((sum, i) => sum + i.quantity, 0),
    [items],
  )

  const value = useMemo(
    () => ({
      items,
      total,
      itemCount,
      addItem,
      removeItem,
      updateQuantity,
      clearCart,
      receipt,
      completeOrder,
      dismissReceipt,
    }),
    [
      items,
      total,
      itemCount,
      addItem,
      removeItem,
      updateQuantity,
      clearCart,
      receipt,
      completeOrder,
      dismissReceipt,
    ],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext)
  if (!ctx) {
    throw new Error("useCart must be used within a CartProvider")
  }
  return ctx
}
