import { fetchProducts } from "./actions";
import ProductsTable from "./products-table";

export const metadata = {
  title: "Productos — Admin",
};

export default async function ProductsPage(props: {
  searchParams?: Promise<{ page?: string; category?: string }>;
}) {
  const sp = await props.searchParams;
  const page = Number(sp?.page) || 1;
  const category = sp?.category || "all";

  const { products, totalPages } = await fetchProducts({ page, category });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gold-gradient">
          Productos
        </h1>
        <p className="text-sm text-muted-foreground">
          Administrá el catálogo — precios, disponibilidad y orden de menú
        </p>
      </div>
      <ProductsTable
        initialProducts={products}
        currentPage={page}
        totalPages={totalPages}
        currentCategory={category}
      />
    </div>
  );
}
