import { getStore } from "@/lib/store";
import { verifyChain, type Receipt } from "@/lib/receipt";
export const dynamic = "force-dynamic";
export async function GET() {
  const store = getStore();
  const st = await store.load();
  const rs: Receipt[] = [];
  for (const e of [...st.index].reverse().slice(-50)) {
    const r = await store.receipt(e.id);
    if (r) rs.push(r);
  }
  const broken = verifyChain(rs);
  return Response.json({ store: store.kind, receipts: rs.length, ok: broken < 0, broken_at: broken < 0 ? null : rs[broken].id, head: st.head });
}
