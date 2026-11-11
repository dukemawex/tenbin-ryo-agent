import { notFound } from "next/navigation";
import { getStore } from "@/lib/store";
import { verifyReceipt } from "@/lib/receipt";
import { ReceiptView } from "@/components/ReceiptView";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getStore().receipt(id);
  if (!r) notFound();
  const ok = verifyReceipt(r);
  const share = `${r.headline}. Evidence → rules → model red-team, sealed sha256 ${r.hash.slice(0, 12)}. Practice only, built on @ryodigital's read-only research tools.`;
  return (
    <>
      <p><a href="/">← Dashboard</a></p>
      <h1>{r.headline}</h1>
      <p>
        Integrity: <strong className={ok ? "ok" : "bad"}>{ok ? "hash verifies" : "HASH MISMATCH"}</strong> · <a href={`/api/receipts/${r.id}`}>raw JSON</a>
      </p>
      <details>
        <summary>Share this decision</summary>
        <p className="mono">{share}</p>
      </details>
      <ReceiptView r={r} />
    </>
  );
}
