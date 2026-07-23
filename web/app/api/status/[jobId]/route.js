import { adminClient, requireUser } from '../../../../lib/server.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req, ctx) {
  const sb = adminClient();
  try {
    const { user, error: authError, status } = await requireUser(req, sb);
    if (authError) return Response.json({ error: authError }, { status });

    const { jobId } = await ctx.params;
    const { data: job, error: jobError } = await sb
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();
    if (jobError || !job) return Response.json({ error: 'Job not found' }, { status: 404 });

    // terminal states are served straight from our DB
    if (job.status === 'COMPLETED') {
      return Response.json({ status: 'COMPLETED', outputUrl: job.output_url });
    }
    if (job.status === 'FAILED') {
      return Response.json({ status: 'FAILED', error: job.error });
    }

    const rp = await fetch(
      `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/status/${job.runpod_job_id}`,
      { headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` } }
    );
    if (!rp.ok) {
      return Response.json({ status: job.status, note: 'status check degraded' });
    }
    const rpData = await rp.json();

    if (rpData.status === 'COMPLETED') {
      const outputB64 = rpData.output?.output_image_base64;
      const workerError = rpData.output?.error;
      if (!outputB64) {
        return failJob(sb, job, workerError ? `${workerError}: ${rpData.output?.message || ''}` : 'Worker returned no image');
      }
      const path = `${user.id}/${job.id}.png`;
      const { error: upError } = await sb.storage
        .from('outputs')
        .upload(path, Buffer.from(outputB64, 'base64'), { contentType: 'image/png', upsert: true });
      if (upError) {
        return Response.json({ error: 'Result ready but could not be stored', detail: upError.message }, { status: 500 });
      }
      const { data: pub } = sb.storage.from('outputs').getPublicUrl(path);
      await sb.from('jobs').update({ status: 'COMPLETED', output_url: pub.publicUrl }).eq('id', job.id);
      return Response.json({ status: 'COMPLETED', outputUrl: pub.publicUrl });
    }

    if (rpData.status === 'FAILED' || rpData.status === 'CANCELLED' || rpData.status === 'TIMED_OUT') {
      return failJob(sb, job, rpData.error || rpData.status);
    }

    // IN_QUEUE / IN_PROGRESS
    if (rpData.status === 'IN_PROGRESS' && job.status !== 'IN_PROGRESS') {
      await sb.from('jobs').update({ status: 'IN_PROGRESS' }).eq('id', job.id);
    }
    return Response.json({ status: rpData.status });
  } catch (err) {
    return Response.json({ error: 'Unexpected error', detail: err.message }, { status: 500 });
  }
}

async function failJob(sb, job, message) {
  const errText = String(message || 'unknown error').slice(0, 1000);
  // conditional update so two concurrent polls can't both trigger the refund
  const { data: updated } = await sb
    .from('jobs')
    .update({ status: 'FAILED', error: errText })
    .eq('id', job.id)
    .neq('status', 'FAILED')
    .select('id');
  let credits;
  if (updated && updated.length) {
    const { data } = await sb.rpc('spend_credits', { p_user_id: job.user_id, p_amount: -job.cost });
    credits = data;
  }
  return Response.json({ status: 'FAILED', error: errText, credits });
}
