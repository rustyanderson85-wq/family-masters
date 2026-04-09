// ─────────────────────────────────────────────────────────────
//  api/masters.js  —  Live scoring proxy for Family Fantasy Masters
//
//  Strategy:
//    1. Try ESPN summary endpoint (free, hole-by-hole if available)
//    2. Fall back to ESPN scoreboard (round totals only)
//    3. Fall back to PGA Tour internal API (hole-by-hole)
//    4. Manual override: set DATA_SOURCE = "datagolf" + add key
//
//  To switch to Data Golf:
//    1. Set DATA_SOURCE = "datagolf" below
//    2. Add DATAGOLF_API_KEY to Vercel environment variables
//    3. git push — redeploys in 30 seconds
// ─────────────────────────────────────────────────────────────

const DATA_SOURCE = "sportsdata"; // "espn" | "pga" | "datagolf" | "sportsdata"

const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY || "";
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY || "";

// Masters 2026 event IDs — verify these closer to tournament week
const ESPN_EVENT_ID  = "401811941"; // update if needed
const PGA_TOURNAMENT_ID = "R2026014"; // update if needed

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    let data;

    if (DATA_SOURCE === "sportsdata") {
      data = await fetchSportsData();
    } else if (DATA_SOURCE === "datagolf") {
      data = await fetchDataGolf();
    } else if (DATA_SOURCE === "pga") {
      data = await fetchPGATour();
    } else {
      // ESPN: try summary (hole-by-hole) first, fall back to scoreboard
      data = await fetchESPN();
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Scoring fetch error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── ESPN (primary) ───────────────────────────────────────────

async function fetchESPN() {
  // Try the detailed summary endpoint first — more likely to have holes
  try {
    const summaryUrl = `https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/summary?event=${ESPN_EVENT_ID}`;
    const summaryRes = await fetch(summaryUrl, { headers: espnHeaders() });

    if (summaryRes.ok) {
      const raw = await summaryRes.json();
      const players = parseESPNSummary(raw);

      // Check if we actually got hole-by-hole data
      const hasHoles = players.some(p => p.rounds.some(r => Object.keys(r.holes).length > 0));
      if (players.length > 0) {
        return { players, source: "espn-summary", hasHoleData: hasHoles, updatedAt: new Date().toISOString() };
      }
    }
  } catch (e) {
    console.warn("ESPN summary failed, trying scoreboard:", e.message);
  }

  // Fall back to scoreboard endpoint
  const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard`;
  const scoreboardRes = await fetch(scoreboardUrl, { headers: espnHeaders() });
  if (!scoreboardRes.ok) throw new Error(`ESPN scoreboard returned ${scoreboardRes.status}`);

  const raw = await scoreboardRes.json();
  const event = raw.events?.find(e =>
    e.name?.toLowerCase().includes("masters") ||
    e.shortName?.toLowerCase().includes("masters")
  ) || raw.events?.[0];

  if (!event) throw new Error("Masters event not found in ESPN scoreboard");

  const players = parseESPNScoreboard(event);
  return { players, source: "espn-scoreboard", hasHoleData: false, updatedAt: new Date().toISOString() };
}

function parseESPNSummary(raw) {
  const competitors = raw?.tournament?.competitors || raw?.competitors || [];
  return competitors.map(c => {
    const rounds = (c.rounds || c.linescores || []).map((rd, rIdx) => {
      const holes = {};
      // ESPN summary may nest holes under linescores or periods
      const holeList = rd.linescores || rd.holes || rd.periods || [];
      holeList.forEach((h, i) => {
        const holeNum   = h.period || h.holeNumber || (i + 1);
        const strokes   = parseInt(h.value || h.score || h.strokes || 0);
        if (strokes > 0) holes[`h${holeNum}`] = strokes;
      });
      return {
        round:  rd.period || rd.round || (rIdx + 1),
        holes,
        score:  rd.value || rd.score || rd.displayValue || null,
        vspar:  rd.toPar || null,
      };
    });

    return {
      id:          String(c.id || c.athlete?.id),
      name:        c.athlete?.displayName || c.athlete?.fullName || c.displayName,
      countryCode: c.athlete?.countryCode || c.athlete?.flag?.alt || "USA",
      score:       c.score?.displayValue ?? c.displayScore ?? "E",
      scoreValue:  c.score?.value ?? 0,
      status:      c.status?.type?.name || "active",
      position:    c.status?.position?.displayText || c.position || "",
      rounds: parsedRounds,
    };
  }).filter(p => p.name);
}

function parseESPNScoreboard(event) {
  const competitors = event?.competitions?.[0]?.competitors || [];
  return competitors.map(c => {
    const rounds = (c.linescores || []).map((r, i) => ({
      round:  r.period || (i + 1),
      holes:  {},
      score:  r.value,
      vspar:  r.displayValue,
    }));
    // Parse score correctly — ESPN stores as strokes under par (negative = under)
    const rawScore = c.score?.value ?? c.score?.displayValue ?? 0;
    const scoreNum = typeof rawScore === "string" ? parseInt(rawScore) || 0 : rawScore;
    const scoreDisplay = scoreNum === 0 ? "E" : scoreNum > 0 ? `+${scoreNum}` : String(scoreNum);
    // Parse overall score from linescores
    const linescores = c.linescores || [];
    let totalVsPar = 0;
    let hasScore = false;
    linescores.forEach(r => {
      const v = r.displayValue || r.value;
      if (!v || v === "-" || v === "") return;
      hasScore = true;
      if (v === "E" || v === "0") return;
      totalVsPar += parseInt(v) || 0;
    });
    // Also try the direct score value
    if (!hasScore && c.score?.displayValue) {
      const sv = c.score.displayValue;
      if (sv === "E") totalVsPar = 0;
      else totalVsPar = parseInt(sv) || 0;
    }
    const totalDisplay = totalVsPar === 0 ? "E" : totalVsPar > 0 ? `+${totalVsPar}` : String(totalVsPar);
    
    // Parse rounds — use vspar string directly
    const parsedRounds = (c.linescores || []).map((r, i) => {
      const vsparStr = r.displayValue || "";
      const vsparNum = vsparStr === "E" ? 0 : (parseInt(vsparStr) || 0);
      return {
        round: r.period || (i + 1),
        holes: {},
        score: r.value || 0,
        vspar: vsparStr,
        vsparNum,
      };
    });
    return {
      id:          String(c.id || c.athlete?.id),
      name:        c.athlete?.displayName || c.athlete?.fullName,
      countryCode: c.athlete?.countryCode || "USA",
      score:       totalDisplay,
      scoreValue:  totalVsPar,
      status:      c.status?.type?.name || "active",
      position:    c.status?.position?.displayText || c.status?.displayValue || "",
      rounds: parsedRounds,
    };
  }).filter(p => p.name);
}

function espnHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
  };
}

// ─── PGA Tour internal (fallback) ─────────────────────────────

async function fetchPGATour() {
  const url = `https://statdata.pgatour.com/r/${PGA_TOURNAMENT_ID}/leaderboard-v2mini.json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; family-fantasy-app)",
      "Referer": "https://www.pgatour.com/",
    }
  });
  if (!res.ok) throw new Error(`PGA API returned ${res.status}`);
  const raw = await res.json();

  const players = (raw.leaderboard?.players || []).map(p => {
    const rounds = (p.rounds || []).map((rd, rIdx) => {
      const holes = {};
      (rd.holes || []).forEach(h => {
        if (h.score > 0) holes[`h${h.hole_nr}`] = h.score;
      });
      return { round: rIdx + 1, holes, score: rd.strokes, vspar: rd.under_par };
    });
    return {
      id:          String(p.player_id),
      name:        `${p.player_bio?.first_name} ${p.player_bio?.last_name}`.trim(),
      countryCode: p.player_bio?.country || "USA",
      score:       p.total || "E",
      scoreValue:  p.total_under_par || 0,
      status:      p.status,
      position:    p.current_position,
      rounds,
    };
  });

  return { players, source: "pga", hasHoleData: true, updatedAt: new Date().toISOString() };
}

// ─── Data Golf (upgrade path) ─────────────────────────────────

async function fetchDataGolf() {
  if (!DATAGOLF_API_KEY) throw new Error("DATAGOLF_API_KEY not set in environment variables");

  // Fetch live scores + live tournament stats (which has hole-by-hole) in parallel
  const [liveRes, statsRes] = await Promise.all([
    fetch(`https://feeds.datagolf.com/preds/in-play?tour=pga&dead_heat=no&odds_format=american&key=${DATAGOLF_API_KEY}`),
    fetch(`https://feeds.datagolf.com/preds/live-hole-stats?tour=pga&file_format=json&key=${DATAGOLF_API_KEY}`)
  ]);

  if (!liveRes.ok) throw new Error(`Data Golf live API returned ${liveRes.status}`);
  const live = await liveRes.json();

  // Try to get hole data from live stats
  const holeData = {};
  if (statsRes.ok) {
    try {
      const stats = await statsRes.json();
      console.log('[datagolf] hole keys:', Object.keys(stats).join(','));
      console.log('[datagolf] hole sample:', JSON.stringify(stats).slice(0,800));
    } catch(e) {
      console.log('Stats parse error:', e.message);
    }
  }

  const players = (live.data || []).map(p => {
    const playerName = p.player_name ? p.player_name.split(', ').reverse().join(' ') : '';
    const playerHoles = holeData[playerName] || {};
    const rounds = ["R1","R2","R3","R4"]
      .map((key, i) => {
        if (p[key] == null) return null;
        const rKey = `r${i+1}`;
        return { round: i+1, holes: playerHoles[rKey] || {}, score: p[key], vspar: null };
      })
      .filter(Boolean);
    return {
      id:          String(p.dg_id),
      name:        playerName,
      countryCode: "USA",
      score:       p.current_score === 0 ? "E" : p.current_score > 0 ? `+${p.current_score}` : String(p.current_score),
      scoreValue:  p.current_score || 0,
      status:      "active",
      position:    p.current_pos,
      rounds,
    };
  });

  return { players, source: "datagolf", hasHoleData: false, updatedAt: new Date().toISOString() };
}

async function fetchSportsData() {
  const key = process.env.SPORTSDATA_API_KEY;
  if (!key) throw new Error("SPORTSDATA_API_KEY not set");

  const res = await fetch(`https://api.sportsdata.io/golf/v2/json/Leaderboard/688?key=${key}`);
  if (!res.ok) throw new Error(`SportsData returned ${res.status}`);
  const data = await res.json();

  console.log('[sportsdata] keys:', Object.keys(data).join(','));
  console.log('[sportsdata] sample:', JSON.stringify(data).slice(0, 500));

  const players = (data.Players || []).map(p => {
    const rounds = (p.Rounds || []).map((rd, i) => {
      const holes = {};
      (rd.Holes || []).forEach(h => {
        if (h.Score != null && h.Score > 0) holes[`h${h.Number}`] = h.Score;
      });
      return { round: rd.Number || (i+1), holes, score: rd.Score || 0, vspar: rd.ToPar || 0 };
    });
    const totalVsPar = p.TotalToPar || 0;
    return {
      id: String(p.PlayerID),
      name: `${p.FirstName} ${p.LastName}`.trim(),
      countryCode: p.Country || "USA",
      score: totalVsPar === 0 ? "E" : totalVsPar > 0 ? `+${totalVsPar}` : String(totalVsPar),
      scoreValue: totalVsPar,
      status: "active",
      position: String(p.Rank || ""),
      rounds,
    };
  }).filter(p => p.name.trim());

  const hasHoleData = players.some(p => p.rounds.some(r => Object.keys(r.holes).length > 0));
  return { players, source: "sportsdata", hasHoleData, updatedAt: new Date().toISOString() };
}
