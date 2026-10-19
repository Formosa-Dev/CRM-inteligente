"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { MetaConnectButton } from "@/components/meta/meta-connect-button";
import { disconnectMeta } from "./actions";
import { useIsAdmin } from "@/components/admin/role-context";

interface Props {
  isConnected: boolean;
  businessName: string | null;
  expiresAt: Date | null;
}

export function MetaConnectionSection({ isConnected, businessName, expiresAt }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isAdmin = useIsAdmin();

  function handleDisconnect() {
    startTransition(async () => {
      await disconnectMeta();
      router.refresh();
    });
  }

  return (
    <section className="rounded-xl border border-border bg-muted/20 p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">Conexión Meta Business</h2>
      {isAdmin ? (
        <MetaConnectButton
          isConnected={isConnected}
          businessName={businessName}
          onDisconnect={isPending ? undefined : handleDisconnect}
        />
      ) : (
        <div className={`flex items-center gap-3 rounded-xl border p-4 ${isConnected ? "border-green-500/20 bg-green-500/5" : "border-border bg-muted/40"}`}>
          <div className={`h-3 w-3 rounded-full ${isConnected ? "bg-green-500" : "bg-muted-foreground/40"}`} />
          <p className="text-sm font-medium text-foreground">
            {isConnected
              ? `Conectado${businessName ? ` a ${businessName}` : " a Meta Business"}`
              : "No conectado"}
          </p>
        </div>
      )}
      {expiresAt && (
        <p className="text-xs text-muted-foreground mt-2">
          Token expira: {new Date(expiresAt).toLocaleDateString("es-AR")}
        </p>
      )}
    </section>
  );
}
