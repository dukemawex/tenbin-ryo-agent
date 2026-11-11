import { getStore } from "@/lib/store";
import { verifyReceipt } from "@/lib/receipt";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await getStore().receipt(id);
  if (!r) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ...r, _verified: verifyReceipt(r) }, { headers: { "Cache-Control": "no-store" } });
}
