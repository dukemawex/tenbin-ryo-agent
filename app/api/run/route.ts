import { runAgent } from "@/lib/agent";
import { MissingCredentialError } from "@/lib/ryo";
import { getStore } from "@/lib/store";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function allowed(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const tokens = [process.env.TENBIN_RUN_TOKEN, process.env.CRON_SECRET].filter((t): t is string => !!t && t.length >= 16);
  return tokens.some((t) => {
    const a = Buffer.from(auth);
    const b = Buffer.from(`Bearer ${t}`);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function handle(req: Request) {
  if (!allowed(req)) return Response.json({ error: "unauthorized: runs spend RYO quota, so they need TENBIN_RUN_TOKEN or the Vercel cron secret" }, { status: 401 });
  try {
    const r = await runAgent({ store: getStore() });
    return Response.json({ id: r.id, headline: r.headline, hash: r.hash, url: `/r/${r.id}` });
  } catch (e) {
    if (e instanceof MissingCredentialError) return Response.json({ error: e.message }, { status: 503 });
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
export const GET = handle; // Vercel cron uses GET with "Authorization: Bearer $CRON_SECRET"
export const POST = handle;
