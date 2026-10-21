/** Connect curated requests to the existing publication/reward pipeline. */
import { getConfig } from "../config.ts";
import { getWantedRequest } from "../db/wanted_requests.ts";
import { getCreatorByName } from "../db/creators.ts";
import { saveContribution } from "../db/contributions.ts";
import { findSimilarCreators, startContribution, startNewCreatorContribution } from "../contributions/service.ts";
import { Contribution } from "../types.ts";

export function wantedRequestLink(id: string): string {
  return `https://t.me/${getConfig().BOT_USERNAME}?start=request_${id}`;
}

export async function startWantedRequestContribution(userId: number, requestId: string): Promise<{ ok: boolean; contribution?: Contribution; error?: string }> {
  const request = await getWantedRequest(requestId);
  if (!request || request.status !== "active") return { ok: false, error: "Cette personne ne figure plus dans la liste recherchée. Actualisez la liste." };
  const existing = await getCreatorByName(request.name);
  let contribution: Contribution;
  if (existing?.status === "active") {
    const result = await startContribution(userId, existing.id);
    if (!result.ok || !result.contribution) return result;
    contribution = result.contribution;
  } else {
    contribution = (await startNewCreatorContribution(userId)).contribution;
    contribution.creatorName = request.name;
    contribution.step = "media";
    contribution.proposal = {
      name: request.name, profileUrl: request.profileUrl,
      // The reviewing administrator can change the publication forum before approval.
      collection: "regular", duplicateCandidateIds: (await findSimilarCreators(request.name)).map((c) => c.id),
    };
  }
  contribution.wantedRequest = {
    id: request.id, name: request.name, profileUrl: request.profileUrl, category: request.category,
  };
  await saveContribution(contribution);
  return { ok: true, contribution };
}
