import { status } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await status(), { headers: { "Cache-Control": "no-store" } });
}
