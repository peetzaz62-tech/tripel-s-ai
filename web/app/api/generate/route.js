import { adminClient, requireUser, num, int } from '../../../lib/server.mjs';
import { buildMagnificGraph, buildSSSGraph } from '../../../lib/workflows.mjs';
import {
  buildExteriorPrompt,
  buildSemiOutdoorPrompt,
  buildInteriorPrompt,
} from '../../../lib/prompts.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CREDIT_COST = { magnific: 1, sss: 1 };
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export async function POST(req) {
  const sb = adminClient();
  try {
    const { user, error: authError, status } = await requireUser(req, sb);
    if (authError) return Response.json({ error: authError }, { status });

    const body = await req.json();
    const params = body?.params || {};
    const inputPath = String(body?.inputPath || '');
    const wf = params.workflow === 'sss' ? 'sss' : 'magnific';
    const cost = CREDIT_COST[wf];

    // the client uploads the input image straight to Supabase Storage
    // (bucket "inputs", folder = its own uid) to dodge the request-size limit here
    if (!inputPath.startsWith(`${user.id}/`)) {
      return Response.json({ error: 'Bad input path' }, { status: 400 });
    }
    const { data: fileData, error: dlError } = await sb.storage.from('inputs').download(inputPath);
    if (dlError || !fileData) {
      return Response.json({ error: 'Input image not found', detail: dlError?.message }, { status: 400 });
    }
    const buffer = Buffer.from(await fileData.arrayBuffer());
    if (buffer.length > MAX_INPUT_BYTES) {
      return Response.json({ error: 'Image too large (max 25MB)' }, { status: 413 });
    }

    // spend credits atomically; null balance = insufficient
    const { data: newCredits, error: creditError } = await sb.rpc('spend_credits', {
      p_user_id: user.id,
      p_amount: cost,
    });
    if (creditError) {
      return Response.json({ error: 'Credit check failed', detail: creditError.message }, { status: 500 });
    }
    if (newCredits === null) {
      return Response.json({ error: 'Not enough credits — please upgrade your plan' }, { status: 402 });
    }

    // prompt + graph are built server-side so presets stay private
    let graph;
    if (wf === 'sss') {
      let prompt;
      if (params.promptType === 'custom') prompt = String(params.customPrompt || '');
      else if (params.promptType === 'interior') prompt = buildInteriorPrompt(params);
      else if (params.promptType === 'semiOutdoor') prompt = buildSemiOutdoorPrompt(params);
      else prompt = buildExteriorPrompt(params);
      graph = buildSSSGraph({
        prompt,
        turbo: !!params.turbo,
        guidance: num(params.guidance, 4),
        megapixels: Math.min(Math.max(num(params.megapixels, 2), 0.5), 8),
        seed: int(params.seed, Math.floor(Math.random() * 1e9)),
      });
    } else {
      graph = buildMagnificGraph({
        prompt: String(params.prompt || ''),
        upscaleBy: Math.min(Math.max(num(params.upscaleBy, 2), 1), 4),
        denoise: Math.min(Math.max(num(params.denoise, 0.15), 0), 1),
        steps: Math.min(Math.max(int(params.steps, 20), 1), 100),
        cfg: num(params.cfg, 8),
        seed: int(params.seed, Math.floor(Math.random() * 1e9)),
      });
    }

    const rp = await fetch(`https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify({
        input: { workflow: graph, image_base64: buffer.toString('base64') },
      }),
    });
    if (!rp.ok) {
      await sb.rpc('spend_credits', { p_user_id: user.id, p_amount: -cost }); // refund
      const detail = (await rp.text()).slice(0, 500);
      return Response.json({ error: 'GPU backend unavailable, credit refunded', detail }, { status: 502 });
    }
    const { id: runpodJobId } = await rp.json();

    const { data: job, error: jobError } = await sb
      .from('jobs')
      .insert({ user_id: user.id, workflow: wf, status: 'PENDING', runpod_job_id: runpodJobId, cost })
      .select('id')
      .single();
    if (jobError) {
      return Response.json({ error: 'Job started but could not be recorded', detail: jobError.message }, { status: 500 });
    }

    return Response.json({ jobId: job.id, status: 'PENDING', credits: newCredits });
  } catch (err) {
    return Response.json({ error: 'Unexpected error', detail: err.message }, { status: 500 });
  }
}
