import { runTrashSweep } from '../../../server/trash-sweep';

export const config = { schedule: '@daily' };

export default async function trashSweep(
  _request: Request,
  context: { deploy: { context: string; published: boolean } },
) {
  if (context.deploy.context === 'production' && context.deploy.published)
    await runTrashSweep(process.env);
  return new Response(null, { status: 204 });
}
