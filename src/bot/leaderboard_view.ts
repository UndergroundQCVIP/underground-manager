/**
 * LA CONFRÉRIE — Leaderboard screen (UG-07)
 */

import { InlineKeyboard } from "grammy";
import { getClubName } from "../config.ts";
import { getProfile } from "../db/points.ts";
import { formatRows, myStanding, POINTS, Tab, topList } from "../points/service.ts";
import { torontoMonthCycle } from "../util/time.ts";

const TITLES: Record<Tab, string> = {
  month: "Ce mois-ci",
  all: "Total",
  referrers: "Ceux qui partagent le plus",
};

export async function renderLeaderboard(userId: number, tab: Tab = "month"): Promise<{ text: string; kb: InlineKeyboard }> {
  const rows = await topList(tab, 10);
  const me = await myStanding(userId);
  const profile = await getProfile(userId);
  const unit = tab === "referrers" ? "parrainé(s)" : "pts";

  const rankLine = (rank: number | null) => (rank ? `#${rank}` : "—");
  const text =
    `🏆 *${getClubName()} — CLASSEMENT*\n_${TITLES[tab]}${tab === "month" ? ` (${torontoMonthCycle()})` : ""}_\n\n` +
    `${formatRows(rows, unit)}\n\n` +
    `*Vous :* ${me.month} pts ce mois-ci (${rankLine(me.rankMonth)}) · ${me.all} pts au total (${rankLine(me.rankAll)})` +
    ` · ${me.referred} personne(s) parrainée(s) (${rankLine(me.rankReferrers)})\n\n` +
    `_Comment gagner des points : 1 pt par ${POINTS.starsPerPoint} Étoiles payées · ${POINTS.perPublishedItem} pts par contenu publié (+${POINTS.rewardBonus} s'il est récompensé) · ${POINTS.referralJoin} pts par personne qui rejoint avec votre lien._\n` +
    `_Le numéro 1 du mois reçoit des jours d'accès bonus. Les accès offerts par les administrateurs ne rapportent pas de points._`;

  const mark = (t: Tab, label: string) => (tab === t ? `• ${label}` : label);
  const kb = new InlineKeyboard()
    .text(mark("month", "Ce mois"), "lb:month")
    .text(mark("all", "Total"), "lb:all")
    .text(mark("referrers", "Parrains"), "lb:referrers")
    .row()
    .text(profile.showName ? "🕶️ Redevenir anonyme" : "👁 Afficher mon nom", `lb:name:${profile.showName ? 0 : 1}:${tab}`)
    .row()
    .text("🤝 Mon lien de parrainage", "ref:menu")
    .row()
    .text("⬅️ Menu principal", "member:home");
  return { text, kb };
}
