"use client";

import Link from "next/link";
import Image from "next/image";
import { useBusiness } from "@/lib/hooks/use-business";

export function Footer() {
  const business = useBusiness();
  const brandName = business?.name || "";
  const instagram = business?.instagram;
  return (
    <footer className="border-t border-border py-16 mt-auto bg-[#050505]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          <div className="flex flex-col gap-4 md:col-span-2">
            <div className="flex items-center gap-3">
              <Image
                src="/assets/images/logo.png"
                alt={brandName || "Logo"}
                width={32}
                height={32}
                className="object-contain"
              />
              <span className="text-xl font-black text-gold-gradient">
                {brandName}
              </span>
            </div>
            <p className="text-sm text-foreground/50 leading-relaxed max-w-md">
              {business?.description || "Hecho con amor y los mejores ingredientes."}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-primary uppercase tracking-wider">
              Navegación
            </h3>
            <nav className="flex flex-col gap-2">
              <Link href="/" className="text-sm text-foreground/60 hover:text-gold-light transition-all duration-200">
                Inicio
              </Link>
              <Link href="/carta-digital" className="text-sm text-foreground/60 hover:text-gold-light transition-all duration-200">
                Carta Digital
              </Link>
              <Link href="/pan-mayorista" className="text-sm text-foreground/60 hover:text-gold-light transition-all duration-200">
                Pan Mayorista
              </Link>
            </nav>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-primary uppercase tracking-wider">
              Seguinos
            </h3>
            <div className="flex flex-col gap-2">
              {instagram ? (
                <a
                  href={`https://instagram.com/${instagram}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-foreground/60 hover:text-gold-light transition-colors"
                >
                  Instagram
                </a>
              ) : null}
              {business?.whatsappPhone ? (
                <a
                  href={`https://wa.me/${business.whatsappPhone}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-foreground/60 hover:text-gold-light transition-colors"
                >
                  WhatsApp
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-12 pt-6 flex flex-col sm:flex-row items-center justify-between gap-2 border-t border-primary/15">
          <p className="text-xs text-foreground/50">
            © {new Date().getFullYear()} {brandName}. Todos los derechos reservados.
          </p>
          <p className="text-xs text-foreground/50">
            Hecho con amor en Argentina
          </p>
        </div>
      </div>
    </footer>
  );
}
