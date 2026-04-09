import { useState, useEffect, useCallback, useRef } from "react";

const PROXY_URL = "https://family-masters.vercel.app";
const REFRESH_MS = 5 * 60 * 1000;
const TOTAL_PICKS = 4;
const PICK_SECONDS = 300;

const SCORING = { eagle:5, birdie:3, par:1, bogey:-1, double:-3, triple:-5, madeCut:5, lowRoundDrafted:2, lowRoundField:5 };

const AUGUSTA_PARS = [4,5,4,3,4,3,4,5,4, 4,4,3,5,4,5,3,4,4];
const FRONT_PAR = 36;
const BACK_PAR  = 36;
const TOTAL_PAR = 72;

const REQUIREMENTS = [
  { id:"champion",      label:"Masters Champion", emoji:"🏆", description:"A past Masters winner" },
  { id:"american",      label:"US Player",         emoji:"🇺🇸", description:"Born/representing USA" },
  { id:"international", label:"International",     emoji:"🌍", description:"Any non-US player" },
  { id:"rookie",        label:"Masters Rookie",    emoji:"🌱", description:"First Masters appearance" },
];

const REQ_STYLE = {
  champion:      { bg:"#fdf6e3", border:"#c9962a", text:"#8a6a1a" },
  american:      { bg:"#eaf3ee", border:"#2d6a4f", text:"#1a4731" },
  international: { bg:"#e8f0f7", border:"#3a6a8a", text:"#1a4060" },
  rookie:        { bg:"#f0faf0", border:"#3a8a3a", text:"#1a5a1a" },
};

const M = {
  green:"#1a4731", greenMid:"#2d6a4f", greenLight:"#e8f0eb",
  gold:"#d4a843",  goldLight:"#fdf6e3", goldDark:"#8a6a1a",
  cream:"#f9f5ec", white:"#ffffff",
  text:"#1a1a18",  textMid:"#4a4a42",  textSoft:"#7a7a6e",
  border:"rgba(26,71,49,0.15)", borderMid:"rgba(26,71,49,0.3)",
};

const sf = "'Georgia','Times New Roman',serif";
const ss = "'Helvetica Neue',Arial,sans-serif";

// ── helpers ──────────────────────────────────────────────────────────────────

function playerReqs(p) {
  const r = new Set();
  if (p.isFormerChamp)   r.add("champion");
  if (p.country==="USA") r.add("american");
  if (p.country!=="USA") r.add("international");
  if (p.isMastersRookie) r.add("rookie");
  return r;
}

function assignRequirements(picks) {
  const order = ["champion","american","international","rookie"];
  const a = { champion:null, american:null, international:null, rookie:null };
  const used = new Set();
  for (const req of order) {
    for (const p of picks) {
      if (used.has(p.id)) continue;
      if (playerReqs(p).has(req)) { a[req]=p.id; used.add(p.id); break; }
    }
  }
  return a;
}

function unmetRequirements(picks) {
  const a = assignRequirements(picks);
  // A requirement is met if any pick satisfies it, regardless of assignment
  return REQUIREMENTS.filter(r => {
    if (a[r.id] !== null) return false; // assigned
    // Also check if any pick can satisfy it even if assigned elsewhere
    return !picks.some(p => playerReqs(p).has(r.id));
  }).map(r=>r.id);
}

function playerIsUseful(player, currentPicks) {
  const newPicks = [...currentPicks, player];
  return unmetRequirements(newPicks).length <= (TOTAL_PICKS - newPicks.length);
}

function oddsToNum(o="") { return parseInt(o.replace("+",""))||99999; }

function scoreLabel(strokes, par) {
  if (!strokes) return null;
  const d = strokes - par;
  if (d <= -2) return { label:"Eagle",  color:M.green,    bg:"#eaf3ee", pts:SCORING.eagle  };
  if (d === -1) return { label:"Birdie", color:"#2a5a8a",  bg:"#e8f0f7", pts:SCORING.birdie };
  if (d ===  0) return { label:"Par",    color:M.textSoft, bg:M.cream,   pts:SCORING.par    };
  if (d ===  1) return { label:"Bogey",  color:M.goldDark, bg:"#fdf6e3", pts:SCORING.bogey  };
  if (d ===  2) return { label:"Double", color:"#8a4020",  bg:"#faf0e8", pts:SCORING.double };
  return              { label:"Triple+", color:"#8a2020",  bg:"#faeaea", pts:SCORING.triple };
}

function calcRoundPoints(rd) {
  return AUGUSTA_PARS.reduce((sum, par, i) => {
    const s = scoreLabel(rd[`h${i+1}`], par);
    return sum + (s ? s.pts : 0);
  }, 0);
}

function calcPoints(stats) {
  if (!stats) return 0;
  let pts = 0;
  for (let r=1;r<=4;r++) pts += calcRoundPoints(stats[`r${r}`]||{});
  pts += (stats.madeCut?SCORING.madeCut:0)+(stats.lowRoundDrafted?SCORING.lowRoundDrafted:0)+(stats.lowRoundField?SCORING.lowRoundField:0);
  return pts;
}

function fmtVsPar(n) { return n===0?"E":n>0?`+${n}`:String(n); }

// ── Badge component ───────────────────────────────────────────────────────────

const Badge = ({reqId, small=false}) => {
  const rs=REQ_STYLE[reqId]; const req=REQUIREMENTS.find(r=>r.id===reqId);
  if (!rs||!req) return null;
  return <span style={{ fontSize:small?13:15, background:rs.bg, color:rs.text, border:`0.5px solid ${rs.border}`, borderRadius:4, padding:small?"2px 6px":"4px 10px", fontFamily:ss, whiteSpace:"nowrap" }}>{req.emoji}{!small&&" "+req.label}</span>;
};

// ── ScoringTab component ──────────────────────────────────────────────────────

function ScoringTab({ allRosteredPlayers, playerStats, liveScores, updateHole, toggleStat, toggleLowRound, loadLiveData, loadingLive, liveError, lastUpdated }) {
  const today = new Date();
  const mastersStart = new Date("2026-04-09");
  const dayOffset = Math.floor((today - mastersStart) / (1000*60*60*24));
  const currentRound = Math.min(Math.max(dayOffset+1, 1), 4);

  const [activeRounds, setActiveRounds] = useState(
    Object.fromEntries(allRosteredPlayers.map(p => [p.id, currentRound]))
  );

  const setRound = (pid, r) => setActiveRounds(prev => ({...prev, [pid]:r}));

  if (allRosteredPlayers.length === 0)
    return <div style={{ textAlign:"center", padding:"60px 20px", color:M.textSoft, fontSize:15, fontFamily:ss }}>Complete the draft first.</div>;

  return (
    <div>
      {PROXY_URL !== "YOUR_PROXY_URL" && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 14px", background:liveError?M.white:M.greenLight, border:`0.5px solid ${liveError?"#c04040":M.greenMid}`, borderRadius:8, marginBottom:16, fontSize:13, fontFamily:ss }}>
          <span style={{ color:liveError?"#8a2020":M.green }}>{liveError||(lastUpdated?`Live · updated ${lastUpdated.toLocaleTimeString()}`:"Connecting…")}</span>
          <button onClick={loadLiveData} style={{ fontSize:12, padding:"3px 10px", background:"none", border:`0.5px solid currentColor`, borderRadius:4, cursor:"pointer", color:liveError?"#8a2020":M.green, fontFamily:ss }}>{loadingLive?"…":"↻ Refresh"}</button>
        </div>
      )}

      {allRosteredPlayers.map(player => {
        const stats    = playerStats[player.id] || {};
        const activeR  = activeRounds[player.id] || currentRound;
        const rd       = stats[`r${activeR}`] || {};
        const totalPts = calcPoints(stats);

        const roundSummaries = [1,2,3,4].map(r => {
          const d = stats[`r${r}`] || {};
          const holesPlayed = AUGUSTA_PARS.filter((_,i) => d[`h${i+1}`] > 0).length;
          const strokes     = AUGUSTA_PARS.reduce((s,_,i) => s+(d[`h${i+1}`]||0), 0);
          const vspar       = AUGUSTA_PARS.reduce((s,par,i) => d[`h${i+1}`] ? s+(d[`h${i+1}`]-par) : s, 0);
          const pts         = calcRoundPoints(d);
          return { holesPlayed, strokes, vspar, pts };
        });

        const nineStats = (offset) => {
          const strokes   = AUGUSTA_PARS.slice(offset, offset+9).reduce((s,_,i) => s+(rd[`h${i+1+offset}`]||0), 0);
          const par9      = offset===0 ? FRONT_PAR : BACK_PAR;
          const vspar     = AUGUSTA_PARS.slice(offset, offset+9).reduce((s,par,i) => rd[`h${i+1+offset}`] ? s+(rd[`h${i+1+offset}`]-par) : s, 0);
          const played    = AUGUSTA_PARS.slice(offset, offset+9).filter((_,i) => rd[`h${i+1+offset}`]>0).length;
          return { strokes, par:par9, vspar, played };
        };
        const front     = nineStats(0);
        const back      = nineStats(9);
        const totStroke = front.strokes + back.strokes;
        const totVsPar  = front.vspar + back.vspar;
        const roundPts  = calcRoundPoints(rd);

        const thSt = { padding:"7px 4px", textAlign:"center", fontSize:12, fontWeight:500, color:M.textSoft, borderRight:`0.5px solid ${M.border}`, fontFamily:ss, background:M.cream, whiteSpace:"nowrap" };
        const parSt = { padding:"5px 4px", textAlign:"center", fontSize:12, color:M.textSoft, borderRight:`0.5px solid ${M.border}`, fontFamily:ss, background:"#eef4f0" };
        const totSt = (val) => ({ padding:"6px 8px", textAlign:"center", fontSize:13, fontWeight:500, fontFamily:ss, color:val<0?M.green:val>0?"#8a2020":M.textMid, background:"#e8f0eb", borderRight:`0.5px solid ${M.border}` });

        const HoleCell = ({ idx }) => {
          const par     = AUGUSTA_PARS[idx];
          const strokes = rd[`h${idx+1}`] || 0;
          const info    = strokes > 0 ? scoreLabel(strokes, par) : null;
          const diff    = info ? strokes - par : null;
          const isEagle  = diff !== null && diff <= -2;
          const isBirdie = diff === -1;
          const isBogey  = diff !== null && diff >= 1;
          return (
            <td style={{ textAlign:"center", padding:"5px 2px", borderRight:`0.5px solid ${M.border}`, minWidth:46 }}>
              <div style={{
                width:30, height:30,
                borderRadius: isEagle||isBirdie ? "50%" : "4px",
                border: isEagle  ? `2.5px solid ${M.green}` :
                        isBirdie ? `1.5px solid #2a5a8a` :
                        isBogey  ? `1.5px solid ${info.color}` :
                                   `0.5px solid ${M.border}`,
                outline: isEagle ? `2px solid ${M.green}` : isBirdie ? `2px solid #2a5a8a` : "none",
                outlineOffset: 2,
                display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto",
                background: info ? info.bg : M.white,
              }}>
                <span style={{ fontSize:13, fontWeight:500, color:info?info.color:M.textSoft, fontFamily:ss }}>{strokes||""}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"center", gap:2, marginTop:3 }}>
                <button onClick={()=>updateHole(player.id, activeR, idx+1, Math.max(0, (rd[`h${idx+1}`]||0)-1))}
                  style={{ width:14,height:14,fontSize:10,background:"none",border:`0.5px solid ${M.borderMid}`,borderRadius:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,color:M.textSoft,lineHeight:1 }}>−</button>
                <button onClick={()=>updateHole(player.id, activeR, idx+1, (rd[`h${idx+1}`]||par-1)+1)}
                  style={{ width:14,height:14,fontSize:10,background:M.green,border:"none",borderRadius:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,color:M.gold,lineHeight:1 }}>+</button>
              </div>
            </td>
          );
        };

        return (
          <div key={player.id} style={{ background:M.white, border:`0.5px solid ${M.border}`, borderRadius:12, overflow:"hidden", marginBottom:22 }}>

            {/* Header */}
            <div style={{ background:M.green, padding:"14px 22px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontFamily:sf, fontSize:20, color:M.gold }}>{player.name}</div>
                <div style={{ fontFamily:ss, fontSize:12, color:"rgba(255,255,255,0.55)", marginTop:3 }}>
                  {player.country}
                  {[1,2,3,4].map(r => roundSummaries[r-1].holesPlayed>0 && (
                    <span key={r} style={{ marginLeft:14 }}>R{r}: {fmtVsPar(roundSummaries[r-1].vspar)} ({roundSummaries[r-1].strokes})</span>
                  ))}
                </div>
              </div>
              <div style={{ textAlign:"right" }}>
                {liveScores[player.id] && <div style={{ fontFamily:ss, fontSize:12, color:"rgba(255,255,255,0.55)", marginBottom:2 }}>{liveScores[player.id].score} to par</div>}
                <span style={{ fontFamily:ss, fontSize:22, fontWeight:500, color:totalPts>=0?M.gold:"#f08080" }}>{totalPts>=0?"+":""}{totalPts} pts</span>
              </div>
            </div>

            {/* Round tabs */}
            <div style={{ display:"flex", background:M.cream, borderBottom:`0.5px solid ${M.border}` }}>
              {[1,2,3,4].map(r => {
                const s = roundSummaries[r-1];
                const isActive = activeR === r;
                const isCurrent = r === currentRound;
                return (
                  <button key={r} onClick={()=>setRound(player.id,r)}
                    style={{ flex:1, padding:"10px 8px", background:isActive?M.white:"none", border:"none", borderBottom:isActive?`2.5px solid ${M.green}`:"2.5px solid transparent", cursor:"pointer", fontFamily:ss, transition:"background 0.1s" }}>
                    <div style={{ fontSize:14, fontWeight:500, color:isActive?M.green:M.textSoft }}>Round {r}{isCurrent?" ●":""}</div>
                    {s.holesPlayed > 0
                      ? <div style={{ fontSize:12, marginTop:2, color:s.vspar<0?M.green:s.vspar>0?"#8a2020":M.textSoft }}>
                          {fmtVsPar(s.vspar)} · {s.pts>=0?"+":""}{s.pts} pts
                        </div>
                      : <div style={{ fontSize:12, color:M.textSoft, marginTop:2 }}>—</div>
                    }
                  </button>
                );
              })}
            </div>

            {/* Scorecard */}
            <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
              <table style={{ borderCollapse:"collapse", minWidth:720 }}>
                <thead>
                  <tr>
                    <th style={{ ...thSt, textAlign:"left", padding:"7px 14px", minWidth:80 }}>Hole</th>
                    {[1,2,3,4,5,6,7,8,9].map(h => <th key={h} style={{ ...thSt, minWidth:46 }}>{h}</th>)}
                    <th style={{ ...thSt, background:"#d8eae0", color:M.green, minWidth:52 }}>OUT</th>
                    {[10,11,12,13,14,15,16,17,18].map(h => <th key={h} style={{ ...thSt, minWidth:46 }}>{h}</th>)}
                    <th style={{ ...thSt, background:"#d8eae0", color:M.green, minWidth:52 }}>IN</th>
                    <th style={{ ...thSt, background:"#d8eae0", color:M.green, minWidth:56 }}>TOT</th>
                    <th style={{ ...thSt, background:"#d8eae0", color:M.green, minWidth:64 }}>PTS</th>
                  </tr>
                  <tr>
                    <td style={{ ...parSt, textAlign:"left", padding:"5px 14px" }}>Par</td>
                    {AUGUSTA_PARS.slice(0,9).map((p,i) => <td key={i} style={parSt}>{p}</td>)}
                    <td style={{ ...parSt, background:"#d8eae0", fontWeight:500 }}>{FRONT_PAR}</td>
                    {AUGUSTA_PARS.slice(9).map((p,i) => <td key={i} style={parSt}>{p}</td>)}
                    <td style={{ ...parSt, background:"#d8eae0", fontWeight:500 }}>{BACK_PAR}</td>
                    <td style={{ ...parSt, background:"#d8eae0", fontWeight:500 }}>{TOTAL_PAR}</td>
                    <td style={{ ...parSt, background:"#d8eae0" }}></td>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background:M.white }}>
                    <td style={{ padding:"8px 14px", fontSize:13, fontFamily:sf, color:M.text, borderRight:`0.5px solid ${M.border}`, whiteSpace:"nowrap" }}>
                      {player.name.split(" ").slice(-1)[0]}
                    </td>
                    {[0,1,2,3,4,5,6,7,8].map(i => <HoleCell key={i} idx={i} />)}
                    <td style={totSt(front.vspar)}>
                      <div style={{ fontSize:15, fontWeight:500 }}>{front.strokes||"—"}</div>
                      <div style={{ fontSize:11, marginTop:1 }}>{front.played>0?fmtVsPar(front.vspar):""}</div>
                    </td>
                    {[9,10,11,12,13,14,15,16,17].map(i => <HoleCell key={i} idx={i} />)}
                    <td style={totSt(back.vspar)}>
                      <div style={{ fontSize:15, fontWeight:500 }}>{back.strokes||"—"}</div>
                      <div style={{ fontSize:11, marginTop:1 }}>{back.played>0?fmtVsPar(back.vspar):""}</div>
                    </td>
                    <td style={totSt(totVsPar)}>
                      <div style={{ fontSize:15, fontWeight:500 }}>{totStroke||"—"}</div>
                      <div style={{ fontSize:11, marginTop:1 }}>{front.played+back.played>0?fmtVsPar(totVsPar):""}</div>
                    </td>
                    <td style={{ textAlign:"center", padding:"6px 6px", background:M.cream, borderRight:`0.5px solid ${M.border}` }}>
                      <div style={{ fontFamily:ss, fontSize:15, fontWeight:500, color:roundPts>=0?M.green:"#8a2020" }}>{roundPts>=0?"+":""}{roundPts}</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Bonus toggles */}
            <div style={{ display:"flex", gap:10, padding:"12px 16px", background:M.cream, borderTop:`0.5px solid ${M.border}` }}>
              {[["Made cut","madeCut","#6a3a9a",false],["Low round (drafted)","lowRoundDrafted","#2a5a8a",true],["Low round (field)","lowRoundField",M.green,true]].map(([label,key,color,excl]) => {
                const active = stats[key];
                const ptVal = key==="lowRoundDrafted"?SCORING.lowRoundDrafted:key==="lowRoundField"?SCORING.lowRoundField:SCORING.madeCut;
                return (
                  <button key={key} onClick={()=>excl?toggleLowRound(player.id,key):toggleStat(player.id,key)}
                    style={{ flex:1, padding:"9px 6px", fontSize:13, fontFamily:ss, background:active?color:M.white, color:active?M.white:color, border:`0.5px solid ${color}`, borderRadius:7, cursor:"pointer" }}>
                    {label} {active?`✓ +${ptVal}`:`+${ptVal}`}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Player data ───────────────────────────────────────────────────────────────

const SAMPLE_PLAYERS = [
  { id:1,  name:"Scottie Scheffler",            country:"USA", odds:"+500",    isFormerChamp:true,  isMastersRookie:false },
  { id:2,  name:"Bryson DeChambeau",            country:"USA", odds:"+1000",   isFormerChamp:false, isMastersRookie:false },
  { id:3,  name:"Jon Rahm",                     country:"ESP", odds:"+1000",   isFormerChamp:true,  isMastersRookie:false },
  { id:4,  name:"Rory McIlroy",                 country:"NIR", odds:"+1300",   isFormerChamp:true,  isMastersRookie:false },
  { id:5,  name:"Xander Schauffele",            country:"USA", odds:"+1500",   isFormerChamp:false, isMastersRookie:false },
  { id:6,  name:"Matt Fitzpatrick",             country:"ENG", odds:"+1800",   isFormerChamp:false, isMastersRookie:false },
  { id:7,  name:"Ludvig Åberg",                 country:"SWE", odds:"+1800",   isFormerChamp:false, isMastersRookie:false },
  { id:8,  name:"Cameron Young",                country:"USA", odds:"+2200",   isFormerChamp:false, isMastersRookie:false },
  { id:9,  name:"Tommy Fleetwood",              country:"ENG", odds:"+2200",   isFormerChamp:false, isMastersRookie:false },
  { id:10, name:"Hideki Matsuyama",             country:"JPN", odds:"+2700",   isFormerChamp:true,  isMastersRookie:false },
  { id:11, name:"Justin Rose",                  country:"ENG", odds:"+2700",   isFormerChamp:false, isMastersRookie:false },
  { id:12, name:"Robert MacIntyre",             country:"SCO", odds:"+3000",   isFormerChamp:false, isMastersRookie:false },
  { id:13, name:"Min Woo Lee",                  country:"AUS", odds:"+3300",   isFormerChamp:false, isMastersRookie:false },
  { id:14, name:"Collin Morikawa",              country:"USA", odds:"+3500",   isFormerChamp:false, isMastersRookie:false },
  { id:15, name:"Patrick Reed",                 country:"USA", odds:"+4000",   isFormerChamp:true,  isMastersRookie:false },
  { id:16, name:"Brooks Koepka",                country:"USA", odds:"+4000",   isFormerChamp:false, isMastersRookie:false },
  { id:17, name:"Chris Gotterup",               country:"USA", odds:"+4500",   isFormerChamp:false, isMastersRookie:true  },
  { id:18, name:"Russell Henley",               country:"USA", odds:"+4500",   isFormerChamp:false, isMastersRookie:false },
  { id:19, name:"Si Woo Kim",                   country:"KOR", odds:"+4500",   isFormerChamp:false, isMastersRookie:false },
  { id:20, name:"Jordan Spieth",                country:"USA", odds:"+4500",   isFormerChamp:true,  isMastersRookie:false },
  { id:21, name:"Viktor Hovland",               country:"NOR", odds:"+5000",   isFormerChamp:false, isMastersRookie:false },
  { id:22, name:"Shane Lowry",                  country:"IRL", odds:"+6000",   isFormerChamp:false, isMastersRookie:false },
  { id:23, name:"Nicolai Højgaard",             country:"DEN", odds:"+6000",   isFormerChamp:false, isMastersRookie:false },
  { id:24, name:"Jake Knapp",                   country:"USA", odds:"+6500",   isFormerChamp:false, isMastersRookie:true  },
  { id:25, name:"Justin Thomas",                country:"USA", odds:"+6500",   isFormerChamp:false, isMastersRookie:false },
  { id:26, name:"Akshay Bhatia",                country:"USA", odds:"+6500",   isFormerChamp:false, isMastersRookie:false },
  { id:27, name:"Maverick McNealy",             country:"USA", odds:"+6500",   isFormerChamp:false, isMastersRookie:false },
  { id:28, name:"Adam Scott",                   country:"AUS", odds:"+7000",   isFormerChamp:true,  isMastersRookie:false },
  { id:29, name:"J.J. Spaun",                   country:"USA", odds:"+7000",   isFormerChamp:false, isMastersRookie:false },
  { id:30, name:"Patrick Cantlay",              country:"USA", odds:"+7000",   isFormerChamp:false, isMastersRookie:false },
  { id:31, name:"Sepp Straka",                  country:"AUT", odds:"+8000",   isFormerChamp:false, isMastersRookie:false },
  { id:32, name:"Tyrrell Hatton",               country:"ENG", odds:"+8000",   isFormerChamp:false, isMastersRookie:false },
  { id:33, name:"Jacob Bridgeman",              country:"USA", odds:"+8000",   isFormerChamp:false, isMastersRookie:true  },
  { id:34, name:"Jason Day",                    country:"AUS", odds:"+8000",   isFormerChamp:false, isMastersRookie:false },
  { id:35, name:"Sungjae Im",                   country:"KOR", odds:"+10000",  isFormerChamp:false, isMastersRookie:false },
  { id:36, name:"Sam Burns",                    country:"USA", odds:"+10000",  isFormerChamp:false, isMastersRookie:false },
  { id:37, name:"Harris English",               country:"USA", odds:"+10000",  isFormerChamp:false, isMastersRookie:false },
  { id:38, name:"Corey Conners",                country:"CAN", odds:"+10000",  isFormerChamp:false, isMastersRookie:false },
  { id:39, name:"Cameron Smith",                country:"AUS", odds:"+10000",  isFormerChamp:false, isMastersRookie:false },
  { id:40, name:"Marco Penge",                  country:"ENG", odds:"+10000",  isFormerChamp:false, isMastersRookie:true  },
  { id:41, name:"Daniel Berger",                country:"USA", odds:"+12500",  isFormerChamp:false, isMastersRookie:false },
  { id:42, name:"Kurt Kitayama",                country:"USA", odds:"+12500",  isFormerChamp:false, isMastersRookie:false },
  { id:43, name:"Gary Woodland",                country:"USA", odds:"+12500",  isFormerChamp:false, isMastersRookie:false },
  { id:44, name:"Rasmus Højgaard",              country:"DEN", odds:"+15000",  isFormerChamp:false, isMastersRookie:true  },
  { id:45, name:"Ben Griffin",                  country:"USA", odds:"+15000",  isFormerChamp:false, isMastersRookie:true  },
  { id:46, name:"Keegan Bradley",               country:"USA", odds:"+15000",  isFormerChamp:false, isMastersRookie:false },
  { id:47, name:"Aaron Rai",                    country:"ENG", odds:"+15000",  isFormerChamp:false, isMastersRookie:true  },
  { id:48, name:"Alex Noren",                   country:"SWE", odds:"+15000",  isFormerChamp:false, isMastersRookie:false },
  { id:49, name:"Ryan Gerard",                  country:"USA", odds:"+15000",  isFormerChamp:false, isMastersRookie:true  },
  { id:50, name:"Sam Stevens",                  country:"USA", odds:"+17500",  isFormerChamp:false, isMastersRookie:true  },
  { id:51, name:"Harry Hall",                   country:"ENG", odds:"+17500",  isFormerChamp:false, isMastersRookie:true  },
  { id:52, name:"Wyndham Clark",                country:"USA", odds:"+17500",  isFormerChamp:false, isMastersRookie:false },
  { id:53, name:"Aldrich Potgieter",            country:"RSA", odds:"+17500",  isFormerChamp:false, isMastersRookie:true  },
  { id:54, name:"Brian Harman",                 country:"USA", odds:"+17500",  isFormerChamp:false, isMastersRookie:false },
  { id:55, name:"Max Homa",                     country:"USA", odds:"+17500",  isFormerChamp:false, isMastersRookie:false },
  { id:56, name:"Ryan Fox",                     country:"NZL", odds:"+22500",  isFormerChamp:false, isMastersRookie:false },
  { id:57, name:"Casey Jarvis",                 country:"RSA", odds:"+22500",  isFormerChamp:false, isMastersRookie:true  },
  { id:58, name:"Kristoffer Reitan",            country:"NOR", odds:"+22500",  isFormerChamp:false, isMastersRookie:true  },
  { id:59, name:"Nick Taylor",                  country:"CAN", odds:"+25000",  isFormerChamp:false, isMastersRookie:false },
  { id:60, name:"Dustin Johnson",               country:"USA", odds:"+25000",  isFormerChamp:true,  isMastersRookie:false },
  { id:61, name:"Nicolas Echavarria",           country:"COL", odds:"+25000",  isFormerChamp:false, isMastersRookie:false },
  { id:62, name:"Carlos Ortiz",                 country:"MEX", odds:"+25000",  isFormerChamp:false, isMastersRookie:false },
  { id:63, name:"Michael Kim",                  country:"USA", odds:"+25000",  isFormerChamp:false, isMastersRookie:false },
  { id:64, name:"Max Greyserman",               country:"USA", odds:"+35000",  isFormerChamp:false, isMastersRookie:true  },
  { id:65, name:"Sergio Garcia",                country:"ESP", odds:"+35000",  isFormerChamp:true,  isMastersRookie:false },
  { id:66, name:"Haotong Li",                   country:"CHN", odds:"+35000",  isFormerChamp:false, isMastersRookie:false },
  { id:67, name:"Matt McCarty",                 country:"USA", odds:"+35000",  isFormerChamp:false, isMastersRookie:true  },
  { id:68, name:"Andrew Novak",                 country:"USA", odds:"+35000",  isFormerChamp:false, isMastersRookie:false },
  { id:69, name:"Tom McKibbin",                 country:"NIR", odds:"+35000",  isFormerChamp:false, isMastersRookie:true  },
  { id:70, name:"Sami Valimaki",                country:"FIN", odds:"+50000",  isFormerChamp:false, isMastersRookie:true  },
  { id:71, name:"Michael Brennan",              country:"USA", odds:"+50000",  isFormerChamp:false, isMastersRookie:true  },
  { id:72, name:"Bubba Watson",                 country:"USA", odds:"+50000",  isFormerChamp:true,  isMastersRookie:false },
  { id:73, name:"John Keefer",                  country:"USA", odds:"+50000",  isFormerChamp:false, isMastersRookie:true  },
  { id:74, name:"Rasmus Neergaard-Petersen",    country:"DEN", odds:"+50000",  isFormerChamp:false, isMastersRookie:true  },
  { id:75, name:"Charl Schwartzel",             country:"RSA", odds:"+50000",  isFormerChamp:true,  isMastersRookie:false },
  { id:76, name:"Zach Johnson",                 country:"USA", odds:"+50000",  isFormerChamp:true,  isMastersRookie:false },
  { id:77, name:"Davis Riley",                  country:"USA", odds:"+75000",  isFormerChamp:false, isMastersRookie:false },
  { id:78, name:"Angel Cabrera",                country:"ARG", odds:"+100000", isFormerChamp:true,  isMastersRookie:false },
  { id:79, name:"Mason Howell",                 country:"USA", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:80, name:"Fifa Laopakdee",               country:"THA", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:81, name:"Ethan Fang",                   country:"USA", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:82, name:"Brian Campbell",               country:"USA", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:83, name:"Vijay Singh",                  country:"FIJ", odds:"+100000", isFormerChamp:true,  isMastersRookie:false },
  { id:84, name:"Jose Maria Olazabal",          country:"ESP", odds:"+100000", isFormerChamp:true,  isMastersRookie:false },
  { id:85, name:"Brandon Holtz",                country:"USA", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:86, name:"Naoyuki Kataoka",              country:"JPN", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:87, name:"Danny Willett",                country:"ENG", odds:"+100000", isFormerChamp:true,  isMastersRookie:false },
  { id:88, name:"Jackson Herrington",           country:"USA", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:89, name:"Fred Couples",                 country:"USA", odds:"+100000", isFormerChamp:true,  isMastersRookie:false },
  { id:90, name:"Mateo Pulcini",                country:"ARG", odds:"+100000", isFormerChamp:false, isMastersRookie:true  },
  { id:91, name:"Mike Weir",                    country:"CAN", odds:"+100000", isFormerChamp:true,  isMastersRookie:false },
];

const SAMPLE_MEMBERS = ["Daddy","Mommy","Luke","Brooklynn","Lexi","Pop","Mor Mor"];

// Lexi's pre-assigned team — display names are fun, ids link to real players for scoring
const LEXI_TEAM = [
  { id:4,  name:"Rory Rory McIlroy",  country:"NIR", odds:"+1300", isFormerChamp:true,  isMastersRookie:false },
  { id:20, name:"Sordin Beef",         country:"USA", odds:"+4500", isFormerChamp:true,  isMastersRookie:false },
  { id:47, name:"Aaron Rai",           country:"ENG", odds:"+15000",isFormerChamp:false, isMastersRookie:true  },
  { id:1,  name:"Scottie Scheffler",   country:"USA", odds:"+500",  isFormerChamp:true,  isMastersRookie:false },
];
const TABS = ["Leaderboard","Scoring","Draft","Setup"];

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab]                   = useState(0); // 0=Leaderboard, 1=Scoring, 2=Draft, 3=Setup
  const [members, setMembers]           = useState(SAMPLE_MEMBERS);
  const [newMember, setNewMember]       = useState("");
  const [drafts, setDrafts]             = useState({});
  const [playerStats, setPlayerStats]   = useState({});
  const [draftOrder, setDraftOrder]     = useState([]);
  const [currentPick, setCurrentPick]   = useState(0);
  const [draftStarted, setDraftStarted] = useState(false);
  const [players, setPlayers]           = useState(SAMPLE_PLAYERS);
  const [liveScores, setLiveScores]     = useState({});
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [loadingLive, setLoadingLive]   = useState(false);
  const [liveError, setLiveError]       = useState(null);
  const [search, setSearch]             = useState("");
  const [filterReq, setFilterReq]       = useState(null);
  const [commentary, setCommentary]     = useState([]);
  const [aiLoading, setAiLoading]       = useState(false);
  const [pendingPick, setPendingPick]   = useState(null);
  const [timeLeft, setTimeLeft]         = useState(PICK_SECONDS);
  const [scoringMember, setScoringMember] = useState('all');
  const feedRef  = useRef(null);
  const timerRef = useRef(null);
  const snapRef  = useRef(null);

  const loadLiveData = useCallback(async () => {
    if (PROXY_URL==="YOUR_PROXY_URL") return;
    // Only fetch live player data during tournament week
    // Tournament is live
    setLoadingLive(true); setLiveError(null);
    try {
      const res=await fetch(`${PROXY_URL}/api/masters`);
      if (!res.ok) throw new Error("Failed");
      const data=await res.json();
      if (data.players?.length) {
        // Keep SAMPLE_PLAYERS — just build live score lookup by name
        const scores={};
        // Match by name since ESPN IDs differ from our IDs
        const liveByName = {};
        data.players.forEach(p => { liveByName[p.name.toLowerCase().trim()] = p; });
        SAMPLE_PLAYERS.forEach(sp => {
          const live = liveByName[sp.name.toLowerCase().trim()];
          if (live) scores[sp.id] = { score:live.score, scoreValue:live.scoreValue, rounds:live.rounds, status:live.status, position:live.position };
        });
        setLiveScores(scores); setLastUpdated(new Date());
      }
    } catch(e) { setLiveError("Could not reach live data."); }
    finally { setLoadingLive(false); }
  }, []);

  useEffect(() => { loadLiveData(); const iv=setInterval(loadLiveData,REFRESH_MS); return ()=>clearInterval(iv); }, [loadLiveData]);

  // Load shared state on mount
  useEffect(() => {
    if (PROXY_URL === "YOUR_PROXY_URL") return;
    fetch(`${PROXY_URL}/api/state`)
      .then(r => r.json())
      .then(data => {
        if (data.members)      setMembers(data.members);
        if (data.drafts)       setDrafts(data.drafts);
        if (data.draftOrder)   setDraftOrder(data.draftOrder);
        if (data.currentPick !== undefined) setCurrentPick(data.currentPick);
        if (data.draftStarted !== undefined) setDraftStarted(data.draftStarted);
        if (data.playerStats)  setPlayerStats(data.playerStats);
      })
      .catch(e => console.error("State load error:", e));
  }, []);

  // Save state helper
  const saveState = (patch) => {
    if (PROXY_URL === "YOUR_PROXY_URL") return;
    fetch(`${PROXY_URL}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(e => console.error("State save error:", e));
  };
  useEffect(() => { if(feedRef.current) feedRef.current.scrollTop=feedRef.current.scrollHeight; }, [commentary]);

  const allPicks = (() => {
    const p=[];
    for (let r=0;r<TOTAL_PICKS;r++) {
      const o=r%2===0?draftOrder:[...draftOrder].reverse();
      o.forEach(m=>{ if(m!=="Lexi") p.push({member:m,round:r+1}); });
    }
    return p;
  })();

  const curPick        = draftStarted && !(currentPick>=allPicks.length && allPicks.length>0) ? allPicks[currentPick] : null;
  const isDraftComplete= draftStarted && allPicks.length>0 && currentPick>=allPicks.length;
  const draftedIds     = new Set(Object.values(drafts).flatMap((arr,idx) => { const member = Object.keys(drafts)[idx]; return member==="Lexi" ? [] : (arr||[]).map(p=>p.id); }));
  const curMemberPicks = curPick ? (drafts[curPick.member]||[]) : [];

  snapRef.current = { curPick, isDraftComplete, drafts, players, curMemberPicks, currentPick };

  const doAutoPick = useCallback(() => {
    const { curPick:cp, isDraftComplete:dc, drafts:d, players:pl, curMemberPicks:cmp, currentPick:pick } = snapRef.current;
    if (!cp||dc) return;
    const takenIds=new Set(Object.values(d).flatMap(arr=>(arr||[]).map(p=>p.id)));
    const best=pl.filter(p=>!takenIds.has(p.id)&&playerIsUseful(p,cmp)).sort((a,b)=>oddsToNum(a.odds)-oddsToNum(b.odds))[0];
    if (!best) return;
    const newDrafts={...d,[cp.member]:[...cmp,best]};
    setDrafts(newDrafts); setCurrentPick(pick+1); setPendingPick(null); setSearch(""); setFilterReq(null);
    generateCommentary(cp.member,best,newDrafts,pick+1);
  }, []);

  useEffect(() => {
    if (!draftStarted||isDraftComplete) { clearInterval(timerRef.current); return; }
    setTimeLeft(PICK_SECONDS);
    clearInterval(timerRef.current);
    timerRef.current=setInterval(()=>{
      setTimeLeft(prev=>{
        if (prev<=1) { clearInterval(timerRef.current); doAutoPick(); return 0; }
        return prev-1;
      });
    },1000);
    return ()=>clearInterval(timerRef.current);
  }, [currentPick, draftStarted, isDraftComplete, doAutoPick]);

  const generateCommentary = async (picker,picked,allDrafts,pickNum) => {
    setAiLoading(true);
    const teamSoFar=(allDrafts[picker]||[]).map(p=>p.name);
    const allTakenIds=new Set(Object.values(allDrafts).flatMap(d=>(d||[]).map(x=>x.id)));
    const topSkipped=SAMPLE_PLAYERS.filter(p=>!allTakenIds.has(p.id)).sort((a,b)=>oddsToNum(a.odds)-oddsToNum(b.odds)).slice(0,3).map(p=>`${p.name} (${p.odds})`).join(", ");
    const otherTeams=Object.entries(allDrafts).filter(([m])=>m!==picker&&(allDrafts[m]||[]).length>0).map(([m,picks])=>`${m}: ${(picks||[]).map(p=>p.name).join(", ")}`).join(" | ");
    const prompt=`You're a sharp, funny golf analyst covering a family fantasy Masters draft. React in 2-3 sentences max. Witty and sassy.\n\n${picker} picked ${picked.name} (${picked.odds})${picked.isFormerChamp?" — former champ":""}${picked.isMastersRookie?" — Masters rookie":""}. Team so far: ${teamSoFar.length?teamSoFar.join(", "):"just this pick"}. Passed on: ${topSkipped}. Others: ${otherTeams||"none yet"}.\n\nPunchy. Roast the pick, mention who they passed on, make a quick prediction.`;
    try {
      const res=await fetch(`${PROXY_URL}/api/commentary`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt})});
      const data=await res.json();
      setCommentary(prev=>[...prev,{picker,picked:picked.name,text:data.text||"No comment.",pickNum}]);
    } catch(e) {
      setCommentary(prev=>[...prev,{picker,picked:picked.name,text:"The analyst stepped away. Suspicious timing.",pickNum}]);
    } finally { setAiLoading(false); }
  };

  const startDraft = () => {
    const order=[...members].sort(()=>Math.random()-0.5);
    setDraftOrder(order); setDraftStarted(true); setCurrentPick(0);
    setDrafts(Object.fromEntries(members.map(m=>[m, m==="Lexi" ? LEXI_TEAM : []])));
    setCommentary([]); setPendingPick(null); setTimeLeft(PICK_SECONDS); setTab(2);
    const order2 = [...members].sort(()=>Math.random()-0.5);
    saveState({ members, drafts: {}, draftOrder: order2, currentPick: 0, draftStarted: true, playerStats: {} });
  };

  const confirmPick = () => {
    if (!curPick||!pendingPick) return;
    clearInterval(timerRef.current);
    const {member}=curPick;
    const newDrafts={...drafts,[member]:[...(drafts[member]||[]),pendingPick]};
    setDrafts(newDrafts); setCurrentPick(p=>p+1); setSearch(""); setFilterReq(null);
    generateCommentary(member,pendingPick,newDrafts,currentPick+1);
    setPendingPick(null);
    saveState({ members, drafts: newDrafts, draftOrder, currentPick: currentPick+1, draftStarted, playerStats });
  };

  const getTeamPoints = (m) => (drafts[m]||[]).reduce((s,p)=>s+calcPoints(playerStats[p.id]),0);
  const leaderboard = [...members].sort((a,b)=>getTeamPoints(b)-getTeamPoints(a));

  const updateHole = (pid,r,h,val) => setPlayerStats(prev=>{
    const cur=prev[pid]||{}; const rk=`r${r}`; const rd={...(cur[rk]||{})};
    if (val===0) delete rd[`h${h}`]; else rd[`h${h}`]=val;
    return {...prev,[pid]:{...cur,[rk]:rd}};
  });
  const toggleStat = (pid,stat) => setPlayerStats(prev=>{ const c=prev[pid]||{}; const next={...prev,[pid]:{...c,[stat]:!c[stat]}}; saveState({ members, drafts, draftOrder, currentPick, draftStarted, playerStats: next }); return next; });
  const toggleLowRound = (pid,key) => setPlayerStats(prev=>{ const u={...prev}; u[pid]={...(u[pid]||{}),[key]:!(prev[pid]?.[key])}; return u; });

  const allRosteredPlayers = [...new Map(Object.values(drafts).flatMap(p=>(p||[])).map(p=>[p.id,p])).values()];

  const visiblePlayers = players
    .filter(p=>!draftedIds.has(p.id))
    .filter(p=>!search||p.name.toLowerCase().includes(search.toLowerCase()))
    .filter(p=>!filterReq||playerReqs(p).has(filterReq))
    .sort((a,b)=>oddsToNum(a.odds)-oddsToNum(b.odds))
    .map(p=>({...p, useful:curPick?playerIsUseful(p,curMemberPicks):true}));

  const timerColor = timeLeft<=30?"#f08080":timeLeft<=60?M.gold:M.white;

  const L = {
    headerFontLg:28, headerFontSm:14, tabFontSize:15,
    bannerNameFont:30, bannerMetaFont:16,
    timerFont:48, timerSecFont:13, timerBarW:72,
    boardFontSm:13, boardFontLg:15, cellMin:200,
    playerListH:700, playerNameF:17, playerOddsF:16, playerPad:"14px 18px",
    confirmNameF:18, confirmMetaF:14, filterFontSz:14, searchPad:"10px 16px",
    feedW:420, feedH:900, feedTitleF:14, feedPickerF:17, feedPickF:14, feedTextF:15,
    reqCardPad:"18px 20px", reqEmojiF:28, reqLabelF:16, reqDescF:13,
    scoringF:16, sectionTitleF:28, bodyTextF:15, pillPad:"6px 14px",
  };

  return (
    <div style={{ fontFamily:sf, color:M.text, background:M.cream }}>
      {/* Header */}
      <div style={{ background:M.green, padding:"16px 16px 0" }}>
        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:22 }}>
          <div style={{ width:42, height:42, background:M.gold, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>⛳</div>
          <div>
            <div style={{ fontFamily:sf, fontSize:"clamp(16px, 4vw, 28px)", color:M.gold, letterSpacing:"0.02em", lineHeight:1.1 }}>Family Fantasy Masters</div>
            <div style={{ fontFamily:ss, fontSize:"clamp(10px, 2vw, 14px)", color:"rgba(255,255,255,0.6)", letterSpacing:"0.08em", textTransform:"uppercase", marginTop:3 }}>Augusta National · April 2026</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:2 }}>
          {TABS.map((t,i)=>(
            <button key={t} onClick={()=>setTab(i)} style={{ background:"none", border:"none", borderBottom:tab===i?`3px solid ${M.gold}`:"3px solid transparent", padding:"8px 12px", fontSize:"clamp(10px, 2vw, 15px)", letterSpacing:"0.05em", textTransform:"uppercase", fontFamily:ss, fontWeight:tab===i?500:400, color:tab===i?M.gold:"rgba(255,255,255,0.55)", cursor:"pointer" }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ padding:"16px" }}>

        {/* ── SETUP ── */}
        {tab===3 && (
          <div>
            <h2 style={{ fontFamily:sf, fontSize:L.sectionTitleF, fontWeight:"normal", color:M.green, margin:"0 0 6px" }}>League members</h2>
            <p style={{ fontFamily:ss, fontSize:L.bodyTextF, color:M.textSoft, margin:"0 0 18px" }}>Add everyone participating, then start the draft.</p>
            <div style={{ display:"flex", flexWrap:"wrap", gap:10, marginBottom:16 }}>
              {members.map(m=>(
                <div key={m} style={{ display:"flex", alignItems:"center", gap:8, background:M.white, border:`0.5px solid ${M.borderMid}`, borderRadius:24, padding:"7px 14px 7px 18px", fontSize:15, fontFamily:ss }}>
                  {m}
                  <button onClick={()=>setMembers(p=>p.filter(x=>x!==m))} style={{ background:"none", border:"none", cursor:"pointer", fontSize:18, color:M.textSoft, padding:0 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display:"flex", gap:10, marginBottom:36 }}>
              <input value={newMember} onChange={e=>setNewMember(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&newMember.trim()){setMembers(p=>[...p,newMember.trim()]);setNewMember("");}}} placeholder="Add member..." style={{ flex:1, fontSize:15, fontFamily:ss, background:M.white, border:`0.5px solid ${M.borderMid}`, borderRadius:10, padding:"10px 16px" }} />
              <button onClick={()=>{if(newMember.trim()){setMembers(p=>[...p,newMember.trim()]);setNewMember("");}}} style={{ fontSize:15, fontFamily:ss, padding:"0 22px", background:M.green, color:M.gold, border:"none", borderRadius:10, cursor:"pointer" }}>Add</button>
            </div>
            <h2 style={{ fontFamily:sf, fontSize:L.sectionTitleF, fontWeight:"normal", color:M.green, margin:"0 0 14px" }}>Team requirements</h2>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:14, marginBottom:14 }}>
              {REQUIREMENTS.map(r=>{ const rs=REQ_STYLE[r.id]; return (
                <div key={r.id} style={{ background:rs.bg, border:`0.5px solid ${rs.border}`, borderRadius:12, padding:L.reqCardPad }}>
                  <div style={{ fontSize:L.reqEmojiF, marginBottom:8 }}>{r.emoji}</div>
                  <div style={{ fontSize:L.reqLabelF, fontWeight:500, color:rs.text, fontFamily:ss }}>{r.label}</div>
                  <div style={{ fontSize:L.reqDescF, color:rs.text, opacity:0.7, marginTop:4, fontFamily:ss }}>{r.description}</div>
                </div>
              );})}
            </div>
            <div style={{ fontSize:14, color:M.textMid, background:M.goldLight, border:`0.5px solid ${M.gold}`, borderRadius:10, padding:"12px 18px", marginBottom:36, fontFamily:ss, lineHeight:1.6 }}>
              Every team drafts exactly <strong>4 players</strong>, one satisfying each requirement. One player can cover multiple — e.g. Rory satisfies both Champion and International.
            </div>
            <h2 style={{ fontFamily:sf, fontSize:L.sectionTitleF, fontWeight:"normal", color:M.green, margin:"0 0 14px" }}>Scoring system</h2>
            <div style={{ background:M.white, border:`0.5px solid ${M.border}`, borderRadius:12, overflow:"hidden", marginBottom:36 }}>
              {[["Eagle",SCORING.eagle,M.green],["Birdie",SCORING.birdie,"#2a5a8a"],["Par",SCORING.par,M.textSoft],["Bogey",SCORING.bogey,M.goldDark],["Double bogey",SCORING.double,"#8a4020"],["Triple+",SCORING.triple,"#8a2020"],["Made cut bonus",SCORING.madeCut,"#6a3a9a"],["Low round — drafted",SCORING.lowRoundDrafted,"#2a5a8a"],["Low round — full field",SCORING.lowRoundField,M.green]].map(([label,pts,color],i,arr)=>(
                <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 20px", borderBottom:i<arr.length-1?`0.5px solid ${M.border}`:"none", background:i%2===0?M.white:M.cream }}>
                  <span style={{ fontSize:L.scoringF, fontFamily:ss, color:M.textMid }}>{label}</span>
                  <span style={{ fontSize:L.scoringF, fontWeight:500, color, fontFamily:ss }}>{pts>0?"+":""}{pts} pts</span>
                </div>
              ))}
            </div>
            <button onClick={startDraft} style={{ width:"100%", padding:"18px", fontSize:18, fontFamily:sf, background:M.green, color:M.gold, border:`1px solid ${M.gold}40`, borderRadius:10, cursor:"pointer" }}>
              {draftStarted?"Continue Draft →":`Begin Draft · ${members.length} participants`}
            {draftStarted && (
              <button onClick={()=>{
                if(window.confirm("Reset the entire draft? This cannot be undone.")) {
                  fetch(`${PROXY_URL}/api/state`, {method:"DELETE"});
                  setDrafts({}); setDraftOrder([]); setCurrentPick(0);
                  setDraftStarted(false); setPlayerStats({});
                  setCommentary([]); setPendingPick(null); setTimeLeft(PICK_SECONDS);
                }
              }} style={{ width:"100%", padding:"12px", fontSize:13, fontFamily:ss, background:"none", color:"#8a2020", border:"0.5px solid #8a2020", borderRadius:8, cursor:"pointer", marginTop:10 }}>
                Reset draft
              </button>
            )}
            </button>
          </div>
        )}

        {/* ── DRAFT ── */}
        {tab===2 && (
          <div>
            {!draftStarted ? (
              <div style={{ textAlign:"center", padding:"60px 20px", color:M.textSoft, fontSize:14, fontFamily:ss }}>Go to Setup to begin the draft.</div>
            ) : isDraftComplete ? (
              <div>
                <div style={{ textAlign:"center", marginBottom:24, padding:"16px 20px", background:M.greenLight, border:`0.5px solid ${M.greenMid}`, borderRadius:10 }}>
                  <div style={{ fontFamily:sf, fontSize:24, color:M.green, marginBottom:4 }}>Draft complete</div>
                  <div style={{ fontFamily:ss, fontSize:15, color:M.greenMid }}>All teams are set. May the best picks win.</div>
                </div>
                {members.map(m=>{ const picks=drafts[m]||[]; return (
                  <div key={m} style={{ background:M.white, border:`0.5px solid ${M.border}`, borderRadius:10, overflow:"hidden", marginBottom:14 }}>
                    <div style={{ background:M.green, padding:"12px 18px" }}><span style={{ fontFamily:sf, fontSize:18, color:M.gold }}>{m}</span></div>
                    <div style={{ padding:"12px 18px" }}>
                      {picks.map(p=>{ const reqs=[...playerReqs(p)]; return (
                        <div key={p.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 0", borderBottom:`0.5px solid ${M.border}` }}>
                          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                            <div style={{ display:"flex", gap:5 }}>{reqs.map(rid=><Badge key={rid} reqId={rid} small />)}</div>
                            <span style={{ fontSize:15, fontFamily:sf, color:M.text }}>{p.name}</span>
                          </div>
                          <span style={{ fontSize:13, color:M.textSoft, fontFamily:ss }}>{p.odds}</span>
                        </div>
                      );})}
                    </div>
                  </div>
                );})}
              </div>
            ) : (
              <div style={{ display:"flex", gap:20, alignItems:"flex-start" }}>
                {/* LEFT */}
                <div style={{ flex:"1 1 0", minWidth:0 }}>
                  {/* Banner */}
                  <div style={{ background:M.green, borderRadius:12, padding:"20px 24px", marginBottom:18 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontFamily:ss, fontSize:14, color:"rgba(255,255,255,0.55)", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:6 }}>Round {curPick?.round} · Pick {currentPick+1} of {allPicks.length}</div>
                        <div style={{ fontFamily:sf, fontSize:L.bannerNameFont, color:M.gold }}>{curPick?.member} is on the clock</div>
                        <div style={{ fontFamily:ss, fontSize:L.bannerMetaFont, color:"rgba(255,255,255,0.65)", marginTop:6 }}>
                          Pick {curMemberPicks.length+1} of {TOTAL_PICKS}{curMemberPicks.length>0&&` · Has: ${curMemberPicks.map(p=>p.name).join(", ")}`}
                        </div>
                      </div>
                      <div style={{ textAlign:"center", paddingLeft:24 }}>
                        <div style={{ fontFamily:ss, fontSize:L.timerFont, fontWeight:500, lineHeight:1, color:timerColor, transition:"color 0.5s" }}>{timeLeft}</div>
                        <div style={{ fontFamily:ss, fontSize:L.timerSecFont, color:"rgba(255,255,255,0.4)", letterSpacing:"0.06em", textTransform:"uppercase", marginTop:4 }}>sec</div>
                        <div style={{ marginTop:8, height:4, width:L.timerBarW, background:"rgba(255,255,255,0.15)", borderRadius:2 }}>
                          <div style={{ height:"100%", borderRadius:2, background:timerColor, width:`${(timeLeft/PICK_SECONDS)*100}%`, transition:"width 1s linear, background 0.5s" }}></div>
                        </div>
                      </div>
                    </div>
                    {unmetRequirements(curMemberPicks).length>0&&(
                      <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:14 }}>
                        <span style={{ fontSize:13, color:"rgba(255,255,255,0.5)", fontFamily:ss }}>Still needs:</span>
                        {unmetRequirements(curMemberPicks).map(rid=><Badge key={rid} reqId={rid} />)}
                      </div>
                    )}
                  </div>

                  {/* Draft board */}
                  <div style={{ marginBottom:18, overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
                    <table style={{ borderCollapse:"collapse", fontSize:L.boardFontSm, fontFamily:ss, minWidth:draftOrder.length*L.cellMin+52 }}>
                      <thead>
                        <tr style={{ background:M.green }}>
                          <th style={{ padding:"9px 12px", color:"rgba(255,255,255,0.4)", fontWeight:400, fontSize:12, width:44 }}></th>
                          {draftOrder.map(m=>{ const isOnClock=curPick?.member===m; return (
                            <th key={m} style={{ padding:"9px 16px", textAlign:"left", color:isOnClock?M.gold:"rgba(255,255,255,0.65)", fontWeight:isOnClock?500:400, fontSize:L.boardFontSm, letterSpacing:"0.06em", textTransform:"uppercase", whiteSpace:"nowrap", borderLeft:`0.5px solid rgba(255,255,255,0.1)`, minWidth:L.cellMin }}>{m}{isOnClock?" ⬅":""}</th>
                          );})}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({length:TOTAL_PICKS},(_,pickIdx)=>(
                          <tr key={pickIdx} style={{ background:pickIdx%2===0?M.white:M.cream }}>
                            <td style={{ padding:"9px 12px", color:M.textSoft, fontSize:L.boardFontSm, borderBottom:`0.5px solid ${M.border}` }}>P{pickIdx+1}</td>
                            {draftOrder.map(m=>{ const p=(drafts[m]||[])[pickIdx]; const isOnClock=curPick?.member===m&&(drafts[m]||[]).length===pickIdx; const reqs=p?[...playerReqs(p)]:[];
                              return (
                                <td key={m} style={{ padding:"9px 16px", borderLeft:`0.5px solid ${M.border}`, borderBottom:`0.5px solid ${M.border}`, background:isOnClock?M.greenLight:"inherit", minWidth:L.cellMin, verticalAlign:"top" }}>
                                  {p ? (
                                    <div>
                                      <div style={{ color:M.text, fontFamily:sf, fontSize:L.boardFontLg, marginBottom:6 }}>{p.name}</div>
                                      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>{reqs.map(rid=><Badge key={rid} reqId={rid} small />)}</div>
                                    </div>
                                  ) : (
                                    <span style={{ color:isOnClock?M.green:M.textSoft, fontStyle:isOnClock?"normal":"italic", fontSize:L.boardFontSm, fontWeight:isOnClock?500:400 }}>{isOnClock?"On clock…":"—"}</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Confirm bar */}
                  {pendingPick&&(
                    <div style={{ background:M.goldLight, border:`1px solid ${M.gold}`, borderRadius:10, padding:"14px 20px", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between", gap:16 }}>
                      <div>
                        <div style={{ fontFamily:sf, fontSize:L.confirmNameF, color:M.text }}>{pendingPick.name}</div>
                        <div style={{ fontFamily:ss, fontSize:L.confirmMetaF, color:M.textSoft, marginTop:3 }}>{pendingPick.odds} · {curPick?.member}'s pick</div>
                      </div>
                      <div style={{ display:"flex", gap:10 }}>
                        <button onClick={()=>setPendingPick(null)} style={{ padding:"9px 22px", fontSize:15, fontFamily:ss, background:"none", color:M.textMid, border:`0.5px solid ${M.borderMid}`, borderRadius:8, cursor:"pointer" }}>Cancel</button>
                        <button onClick={confirmPick} style={{ padding:"9px 22px", fontSize:15, fontFamily:ss, background:M.green, color:M.gold, border:"none", borderRadius:8, cursor:"pointer", fontWeight:500 }}>Confirm pick</button>
                      </div>
                    </div>
                  )}

                  {/* Filter buttons */}
                  <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap" }}>
                    {REQUIREMENTS.map(r=>{ const rs=REQ_STYLE[r.id]; const active=filterReq===r.id; return (
                      <button key={r.id} onClick={()=>{ setFilterReq(active?null:r.id); setSearch(""); }}
                        style={{ fontSize:L.filterFontSz, fontFamily:ss, padding:L.pillPad, borderRadius:24, cursor:"pointer", border:`0.5px solid ${rs.border}`, background:active?rs.text:rs.bg, color:active?M.white:rs.text }}>
                        {r.emoji} {r.label}
                      </button>
                    );})}
                    {filterReq&&<button onClick={()=>setFilterReq(null)} style={{ fontSize:L.filterFontSz, fontFamily:ss, padding:L.pillPad, borderRadius:24, cursor:"pointer", border:`0.5px solid ${M.borderMid}`, background:"none", color:M.textSoft }}>✕ Clear</button>}
                  </div>
                  {!filterReq&&<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search players…" style={{ width:"100%", fontSize:15, fontFamily:ss, marginBottom:12, boxSizing:"border-box", background:M.white, border:`0.5px solid ${M.borderMid}`, borderRadius:10, padding:L.searchPad }} />}

                  {/* Player list */}
                  <div style={{ height:L.playerListH, overflowY:"auto", borderRadius:12, border:`0.5px solid ${M.border}` }}>
                    {visiblePlayers.map((p,i)=>{ const reqs=[...playerReqs(p)]; const isPending=pendingPick?.id===p.id; return (
                      <div key={p.id} onClick={()=>p.useful&&setPendingPick(isPending?null:p)}
                        style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:L.playerPad, borderBottom:`0.5px solid ${M.border}`, cursor:p.useful?"pointer":"not-allowed", background:isPending?M.goldLight:i%2===0?M.white:M.cream, opacity:p.useful?1:0.3, outline:isPending?`2px solid ${M.gold}`:"none" }}
                        onMouseEnter={e=>{ if(p.useful&&!isPending) e.currentTarget.style.background=M.greenLight; }}
                        onMouseLeave={e=>{ if(!isPending) e.currentTarget.style.background=i%2===0?M.white:M.cream; }}>
                        <div>
                          <div style={{ fontSize:L.playerNameF, fontFamily:sf, color:M.text, marginBottom:5 }}>{p.name}</div>
                          <div style={{ display:"flex", gap:6 }}>{reqs.map(rid=><Badge key={rid} reqId={rid} small />)}</div>
                        </div>
                        <div style={{ fontSize:L.playerOddsF, color:M.goldDark, fontFamily:ss, fontWeight:500 }}>{p.odds}</div>
                      </div>
                    );})}
                  </div>
                  <div style={{ marginTop:8, fontSize:13, color:M.textSoft, fontFamily:ss }}>Dimmed players can't satisfy remaining requirements.</div>
                </div>

                {/* RIGHT: commentary */}
                <div style={{ width:L.feedW, flexShrink:0 }}>
                  <div style={{ background:M.green, borderRadius:"12px 12px 0 0", padding:"14px 18px", display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:10, height:10, borderRadius:"50%", background:M.gold }}></div>
                    <span style={{ fontFamily:ss, fontSize:L.feedTitleF, color:M.gold, letterSpacing:"0.08em", textTransform:"uppercase" }}>Draft desk</span>
                  </div>
                  <div ref={feedRef} style={{ height:L.feedH, overflowY:"auto", background:M.white, border:`0.5px solid ${M.border}`, borderTop:"none", borderRadius:"0 0 12px 12px", padding:"16px" }}>
                    {commentary.length===0&&!aiLoading&&(
                      <div style={{ textAlign:"center", padding:"60px 16px", color:M.textSoft, fontSize:15, fontFamily:ss, lineHeight:1.7 }}>The analyst is ready.<br/>Make a pick to get commentary.</div>
                    )}
                    {commentary.map((c,i)=>(
                      <div key={i} style={{ marginBottom:20, paddingBottom:20, borderBottom:i<commentary.length-1?`0.5px solid ${M.border}`:"none" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:6 }}>
                          <span style={{ fontFamily:sf, fontSize:L.feedPickerF, color:M.green }}>{c.picker}</span>
                          <span style={{ fontFamily:ss, fontSize:13, color:M.textSoft }}>#{c.pickNum}</span>
                        </div>
                        <div style={{ fontFamily:ss, fontSize:L.feedPickF, color:M.goldDark, marginBottom:8, fontWeight:500 }}>→ {c.picked}</div>
                        <div style={{ fontFamily:ss, fontSize:L.feedTextF, color:M.textMid, lineHeight:1.7 }}>{c.text}</div>
                      </div>
                    ))}
                    {aiLoading&&(
                      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 0" }}>
                        <div style={{ display:"flex", gap:5 }}>{[0,1,2].map(i=><div key={i} style={{ width:8,height:8,borderRadius:"50%",background:M.gold,animation:`pulse 1s ease-in-out ${i*0.2}s infinite` }}></div>)}</div>
                        <span style={{ fontFamily:ss, fontSize:14, color:M.textSoft }}>Analyst is typing…</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SCORING ── */}
        {tab===1 && (
          <div>
            <div style={{ display:"flex", gap:8, marginBottom:18, flexWrap:"wrap" }}>
              {["all",...members].map(m=>(
                <button key={m} onClick={()=>setScoringMember(m)}
                  style={{ fontSize:14, fontFamily:ss, padding:"7px 18px", borderRadius:24, cursor:"pointer",
                    border:`0.5px solid ${M.greenMid}`,
                    background:scoringMember===m?M.green:"none",
                    color:scoringMember===m?M.gold:M.green,
                    fontWeight:scoringMember===m?500:400 }}>
                  {m==="all"?"All teams":m}
                </button>
              ))}
            </div>
            <ScoringTab
              allRosteredPlayers={scoringMember==="all"
                ? allRosteredPlayers
                : (drafts[scoringMember]||[])}
            playerStats={playerStats}
            liveScores={liveScores}
            updateHole={updateHole}
            toggleStat={toggleStat}
            toggleLowRound={toggleLowRound}
            loadLiveData={loadLiveData}
            loadingLive={loadingLive}
            liveError={liveError}
            lastUpdated={lastUpdated}
          />
          </div>
        )}

        {/* ── LEADERBOARD ── */}
        {tab===0 && (
          <div>
            {leaderboard.map((member,i)=>{ const pts=getTeamPoints(member); const picks=drafts[member]||[]; const isLeader=i===0; return (
              <div key={member} style={{ background:M.white, border:`${isLeader?"1.5px":"0.5px"} solid ${isLeader?M.gold:M.border}`, borderRadius:10, overflow:"hidden", marginBottom:12 }}>
                <div style={{ background:isLeader?M.green:M.cream, padding:"12px 18px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:30,height:30,borderRadius:"50%",background:isLeader?M.gold:M.greenLight,border:`0.5px solid ${isLeader?M.goldDark:M.greenMid}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:500,color:isLeader?M.goldDark:M.green,fontFamily:ss }}>{i+1}</div>
                    <span style={{ fontFamily:sf, fontSize:18, color:isLeader?M.gold:M.green }}>{member}</span>
                  </div>
                  <span style={{ fontSize:22, fontWeight:500, color:isLeader?(pts>=0?M.gold:"#f08080"):(pts>=0?M.green:"#8a2020"), fontFamily:ss }}>{pts>=0?"+":""}{pts}</span>
                </div>
                <div style={{ padding:"8px 18px 14px" }}>
                  {picks.map(p=>{ const reqs=[...playerReqs(p)]; const pPts=calcPoints(playerStats[p.id]); return (
                    <div key={p.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 0", borderBottom:`0.5px solid ${M.border}` }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <div style={{ display:"flex", gap:4 }}>{reqs.map(rid=><Badge key={rid} reqId={rid} small />)}</div>
                        <span onClick={()=>{ setScoringMember(member); setTab(1); }} style={{ fontSize:14, fontFamily:sf, color:M.green, cursor:"pointer", textDecoration:"underline", textDecorationColor:`${M.green}55` }}>{p.name}</span>
                      </div>
                      <span style={{ fontSize:14, fontWeight:500, fontFamily:ss, color:pPts>=0?M.green:"#8a2020" }}>{pPts>=0?"+":""}{pPts}</span>
                    </div>
                  );})}
                </div>
              </div>
            );})}
            <div style={{ background:M.white, border:`0.5px solid ${M.border}`, borderRadius:10, padding:"14px 18px", marginTop:8 }}>
              <div style={{ fontFamily:sf, fontSize:16, color:M.green, marginBottom:10 }}>Scoring reference</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:"6px 20px" }}>
                {[["Eagle","+5"],["Birdie","+3"],["Par","+1"],["Bogey","−1"],["Double","−3"],["Triple+","−5"],["Cut","+5"],["Low (drafted)","+2"],["Low (field)","+5"]].map(([l,v])=>(
                  <span key={l} style={{ fontSize:13, color:M.textMid, fontFamily:ss }}>{l}: <strong style={{ color:M.green }}>{v}</strong></span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:0.3}50%{opacity:1}}`}</style>
    </div>
  );
}// Tue Apr  7 21:58:31 EDT 2026
// updated Tue Apr  7 21:58:41 EDT 2026
