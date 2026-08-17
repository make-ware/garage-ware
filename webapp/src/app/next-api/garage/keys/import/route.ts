import { z } from 'zod';
import { AccessKeyMutator } from '@garage-ware/shared/mutators';
import { GarageClient, keys } from '@/lib/garage';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const ImportBody = z.object({
  garage_key_id: z.string().min(1).max(128),
  user_id: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const body = ImportBody.parse(await req.json());

    const accessKeys = new AccessKeyMutator(pb);
    const existing = await accessKeys.findByGarageId(body.garage_key_id);
    if (existing) {
      throw new HttpError(
        409,
        `Access key ${body.garage_key_id} is already allocated to a user`
      );
    }

    const garage = GarageClient.fromEnv();
    const info = await keys.getKeyInfo(garage, body.garage_key_id);

    const writePb = await getPbAsSuperuser();
    const record = await writePb.collection('AccessKeys').create({
      user: body.user_id,
      garage_key_id: info.accessKeyId,
      name: info.name,
    });

    return Response.json({ record });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
