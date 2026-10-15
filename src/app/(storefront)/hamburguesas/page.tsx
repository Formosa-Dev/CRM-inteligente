import { redirect } from "next/navigation";

// La carta digital es la superficie única de pedidos: esta ruta queda como
// alias permanente para links compartidos y navegación previa.
export default function HamburguesasPage() {
  redirect("/carta-digital?category=hamburguesa");
}
