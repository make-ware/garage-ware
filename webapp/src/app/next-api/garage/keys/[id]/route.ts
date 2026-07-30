import { GarageClient, keys } from '@/lib/garage';
import { errorResponse } from '@/lib/auth/server';
import { loadOwnedKey } from '@/lib/auth/ownership';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const { record } = await loadOwnedKey(req, id);

    const garage = GarageClient.fromEnv();
    const info = await keys.getKeyInfo(garage, record.garage_key_id);
    return Response.json({ record, garage: info });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const { pb, record } = await loadOwnedKey(req, id);

    const garage = GarageClient.fromEnv();
    await keys.deleteKey(garage, record.garage_key_id);
    await pb.collection('AccessKeys').delete(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
