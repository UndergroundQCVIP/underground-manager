/** Admin-managed requests: never mixed with wanted_candidates or monthly supports. */
import { isAdministrator } from "../config.ts";
import { WantedRequest, WantedRequestClass } from "../types.ts";
import { getKv } from "./kv.ts";
import { normalizeCreatorName } from "./creators.ts";
import { logAuditEvent } from "./audit.ts";

export function cleanRequestName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) throw new Error("Le nom doit contenir entre 2 et 60 caractères.");
  return name;
}

export function cleanRequestUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { throw new Error("Envoyez un lien de profil valide commençant par https:// ou http://."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.toString().length > 200) {
    throw new Error("Le lien doit être un profil http(s), sans identifiants, de 200 caractères maximum.");
  }
  return url.toString();
}

export async function getWantedRequest(id: string): Promise<WantedRequest | null> {
  return (await (await getKv()).get<WantedRequest>(["wanted_requests", id])).value;
}

export async function listWantedRequests(options: { category?: WantedRequestClass; status?: WantedRequest["status"] } = {}): Promise<WantedRequest[]> {
  const kv = await getKv();
  const out: WantedRequest[] = [];
  for await (const e of kv.list<WantedRequest>({ prefix: ["wanted_requests"] })) {
    if (e.value.status !== (options.status ?? "active")) continue;
    if (options.category && e.value.category !== options.category) continue;
    out.push(e.value);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

type RequestPatch = Partial<Pick<WantedRequest, "name" | "profileUrl" | "category" | "status">>;

/** Admin check and runtime validation apply to every write, including direct service calls. */
export async function saveWantedRequest(adminId: number, patch: RequestPatch, id?: string): Promise<WantedRequest> {
  if (!isAdministrator(adminId)) throw new Error("Accès réservé aux administrateurs.");
  const kv = await getKv();
  const requestId = id ?? crypto.randomUUID();
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await kv.get<WantedRequest>(["wanted_requests", requestId]);
    if (id && !row.value) throw new Error("Personne recherchée introuvable.");
    const name = cleanRequestName(patch.name ?? row.value?.name ?? "");
    const profileUrl = cleanRequestUrl(patch.profileUrl ?? row.value?.profileUrl ?? "");
    const category = patch.category ?? row.value?.category;
    if (category !== "creatrices" && category !== "amateurs") throw new Error("Choisissez uniquement Créatrices ou Amateurs.");
    const status = patch.status ?? row.value?.status ?? "active";
    if (status !== "active" && status !== "archived") throw new Error("Statut invalide.");
    const normalizedName = normalizeCreatorName(name);
    const index = await kv.get<string>(["wanted_requests_by_name", normalizedName]);
    if (index.value && index.value !== requestId) throw new Error("Ce nom figure déjà dans la liste (y compris les personnes retirées).");
    const now = new Date().toISOString();
    const entry: WantedRequest = {
      id: requestId, name, normalizedName, profileUrl, category, status,
      createdBy: row.value?.createdBy ?? adminId, updatedBy: adminId,
      createdAt: row.value?.createdAt ?? now, updatedAt: now,
    };
    const tx = kv.atomic().check(row).check(index).set(row.key, entry).set(index.key, requestId);
    if (row.value && row.value.normalizedName !== normalizedName) {
      tx.delete(["wanted_requests_by_name", row.value.normalizedName]);
    }
    if ((await tx.commit()).ok) {
      await logAuditEvent(id ? "wanted_request_updated" : "wanted_request_created", { requestId, name, category, status }, adminId);
      return entry;
    }
  }
  throw new Error("La liste a changé en même temps. Veuillez réessayer.");
}
