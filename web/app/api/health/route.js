export async function GET() {
  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!process.env.RUNPOD_API_KEY &&
    !!process.env.RUNPOD_ENDPOINT_ID;
  return Response.json({ ok: configured }, { status: configured ? 200 : 503 });
}
