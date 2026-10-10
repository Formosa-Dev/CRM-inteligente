"use client"

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react"
import { toast } from "sonner"
import { z } from "zod"

export type CartItem = {
  product: {
    id: string
    name: string
    price: number
    emoji: string
  }
  quantity: number
}

type CartContextValue = {
  items: CartItem[]
  total: number
  itemCount: number
  addItem: (product: CartItem["product"], qty?: number) => void
  removeItem: (productId: string) => void
  updateQuantity: (productId: string, qty: number) => void
  clearCart: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

const STORAGE_KEY = "muzapp-cart"

const cartItemSchema = z.object({
  product: z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    emoji: z.string(),
  }),
  quantity: z.number().int().positive(),
});

function loadCart(): CartItem[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const result = z.array(cartItemSchema).safeParse(parsed)
    if (!result.success) {
      console.warn("[cart] Invalid cart data in localStorage, clearing")
      localStorage.removeItem(STORAGE_KEY)
      return []
    }
    return result.data
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

  useEffect(() => {
    // Async para evitar setState sincrónico en el efecto y mismatch de hidratación
    const restore = window.setTimeout(() => setItems(loadCart()), 0)
    return () => window.clearTimeout(restore)
  }, [])

  useEffect(() => {
    if (items.length > 0 || localStorage.getItem(STORAGE_KEY)) {
      saveCart(items)
    }
  }, [items])

  const addItem = useCallback(
    (product: CartItem["product"], qty = 1) => {
      setItems((prev) => {
        const existing = prev.find((i) => i.product.id === product.id)
        if (existing) {
          return prev.map((i) =>
            i.product.id === product.id
              ? { ...i, quantity: i.quantity + qty }
              : i,
          )
        }
        return [...prev, { product, quantity: qty }]
      })
      toast(`${product.emoji} ${product.name} agregado al carrito`)
    },
    [],
  )

  const removeItem = useCallback((productId: string) => {
    setItems((prev) => {
      const item = prev.find((i) => i.product.id === productId)
      if (item) {
        toast(
          `${item.product.emoji} ${item.product.name} eliminado del carrito`,
        )
      }
      return prev.filter((i) => i.product.id !== productId)
    })
  }, [])

  const updateQuantity = useCallback(
    (productId: string, qty: number) => {
      if (qty < 1) {
        removeItem(productId)
        return
      }
      setItems((prev) =>
        prev.map((i) =>
          i.product.id === productId ? { ...i, quantity: qty } : i,
        ),
      )
    },
    [removeItem],
  )

  const clearCart = useCallback(() => {
    setItems([])
  }, [])

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
    }),
    [items, total, itemCount, addItem, removeItem, updateQuantity, clearCart],
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
