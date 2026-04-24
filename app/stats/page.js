"use client";

// app/stats/page.js
// Visual dashboard of Gabriella's accumulated state.
//
// Renders /api/stats as a human-readable page so an evaluator, or
// anyone curious, can SEE the depth: what she remembers, what she
// wants, what's in her stream, how her daily eval is trending,
// which providers are healthy, which circuit breakers are open.
//
// No external CSS — vanilla inline styles keep cold-start tiny.

import { useEffect, useState } from "react";

const css = {
  shell:   { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "24px 16px", boxSizing: "border-box" },
  wrap:    { maxWidth: 900, margin: "0 auto" },
  h1:      { margin: "0 0 4px", fontSize: 22, fontWeight: 600, letterSpacing: 0.2 },
  subtitle:{ margin: "0 0 20px", color: "#8a8a99", fontSize: 12 },
  grid2:   { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 },
  card:    { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 14, marginBottom: 10 },
  cardT:   { margin: "0 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "#a0a0b0", letterSpacing: 1.2 },
  kv:      { display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13 },
  k:       { color: "#8a8a99" },
  v:       { color: "#e4e4ed", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 },
  big:     { fontSize: 30, fontWeight: 700, color: "#e4e4ed", margin: "6px 0 0" },
  bigLabel:{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#8a8a99" },
  bar:     (pct, color) => ({
    height: 6, background: "#1f1f2b", borderRadius: 3, overflow: "hidden", margin: "4px 0",
  }),
  fill:    (pct, color) => ({ height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: color, transition: "width 300ms" }),
  pill:    (color) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600, background: color, color: "#0a0a0f", textTransform: "uppercase", letterSpacing: 0.6 }),
  error:   { background: "#2a1a1a", border: "1px solid #6a2a2a", borderRadius: 8, padding: 12, fontSize: 13, color: "#ffc4c4" },
  sparkBox:{ display: "flex", gap: 2, alignItems: "flex-end", height: 36, marginTop: 6 },
  sparkBar:(h, lo) => ({ width: 7, background: lo ? "#f87171" : "#4ade80", height: Math.max(3, h * 34), borderRadius: 1, opacity: 0.75 }),
};

function pillFor(state) {
  if (!state || state === "closed")    return [css.pill("#4ade80"), "healthy"];
  if (state === "half_open")           return [css.pill("#f59e0b"), "probing"];
  if (state === "open")                return [css.pill("#f87171"), "open"];
  return [css.pill("#d4d4a8"), String(state)];
}

function relMs(ms) {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000)    return `${Math.floor(d/1000)}s ago`;
  if (d < 3600_000)  return `${Math.floor(d/60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d/3600_000)}h ago`;
  return `${Math.floor(d/86400_000)}d ago`;
}

export default function StatsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stats");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "unknown error");
      setData(json);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !data) {
    return <div style={css.shell}><div style={css.wrap}><p style={{color: "#8a8a99"}}>loading…</p></div></div>;
  }
  if (error) {
    return <div style={css.shell}><div style={css.wrap}><div style={css.error}>failed to load: {error}</div></div></div>;
  }
  if (!data) return null;

  const { self, stream, memory, training, chronology, eval: evalData, speaker, heartbeats, pool, breakers, callAudit, promptAudit, gauntlet, readiness } = data;

  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <h1 style={css.h1}>Gabriella — state</h1>
        <p style={css.subtitle}>
          live fingerprint of her accumulated depth. user: {data.userId}. generated in {data.generatedMs}ms.{" "}
          <button onClick={load} style={{ background: "none", border: "1px solid #33334a", color: "#8a8a99", padding: "2px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>refresh</button>
        </p>

        {/* HERO — chronology + eval */}
        <div style={css.grid2}>
          <div style={css.card}>
            <div style={css.cardT}>Chronology</div>
            <div style={css.big}>{chronology?.totalTurns ?? 0}</div>
            <div style={css.bigLabel}>total turns</div>
            <div style={{marginTop: 10, ...css.kv}}><span style={css.k}>sessions</span><span style={css.v}>{chronology?.sessionCount ?? 0}</span></div>
            <div style={css.kv}><span style={css.k}>first seen</span><span style={css.v}>{relMs(chronology?.firstSeenAt)}</span></div>
            <div style={css.kv}><span style={css.k}>last seen</span><span style={css.v}>{relMs(chronology?.lastSeenAt)}</span></div>
          </div>

          <div style={css.card}>
            <div style={css.cardT}>Daily Autonomous Eval</div>
            {evalData?.latestWinRate != null ? (
              <>
                <div style={css.big}>{Math.round(evalData.latestWinRate * 100)}%</div>
                <div style={css.bigLabel}>win-rate · fine-tune vs. base · {evalData.latestDay}</div>
                <div style={css.bar(0, 0)}>
                  <div style={css.fill(evalData.latestWinRate * 100, evalData.latestWinRate >= 0.55 ? "#4ade80" : evalData.latestWinRate >= 0.45 ? "#d4d4a8" : "#f87171")} />
                </div>
                <div style={{fontSize: 11, color: "#8a8a99", marginTop: 2}}>
                  95% CI: [{evalData.latestWinRateCI?.[0] ?? "?"}, {evalData.latestWinRateCI?.[1] ?? "?"}]
                </div>
                {evalData.rollingAvgWinRate != null && (
                  <div style={{fontSize: 11, color: "#8a8a99", marginTop: 2}}>
                    {evalData.daysRecorded}-day rolling avg: {Math.round(evalData.rollingAvgWinRate * 100)}%
                  </div>
                )}
                {evalData.lastEvalDays?.length > 0 && (
                  <div style={css.sparkBox}>
                    {evalData.lastEvalDays.slice(0, 10).reverse().map((d, i) => {
                      const wr = typeof d.winRate === "number" ? d.winRate : 0.5;
                      return <div key={i} style={css.sparkBar(wr, wr < 0.5)} title={`${d.day}: ${Math.round(wr * 100)}%`} />;
                    })}
                  </div>
                )}
              </>
            ) : (
              <div style={{fontSize: 13, color: "#8a8a99"}}>No evals recorded yet. Cron runs at 12:00 UTC daily.</div>
            )}
          </div>
        </div>

        {/* SELF MODEL */}
        <div style={css.card}>
          <div style={css.cardT}>Sovereign Self</div>
          <div style={css.grid2}>
            <div>
              <div style={css.kv}><span style={css.k}>active wants</span><span style={css.v}>{self?.wantsActive ?? 0}</span></div>
              <div style={css.kv}><span style={css.k}>top want weight</span><span style={css.v}>{self?.wantsTopWeight ?? "—"}</span></div>
              <div style={css.kv}><span style={css.k}>live commitments</span><span style={css.v}>{self?.commitmentsLive ?? 0}</span></div>
              <div style={css.kv}><span style={css.k}>confirmed commitments</span><span style={css.v}>{self?.commitmentsConfirmed ?? 0}</span></div>
            </div>
            <div>
              <div style={css.kv}><span style={css.k}>read established</span><span style={css.v}>{self?.hasRead ? "yes" : "no"}</span></div>
              <div style={css.kv}><span style={css.k}>read confidence</span><span style={css.v}>{self?.readConfidence != null ? `${Math.round(self.readConfidence * 100)}%` : "—"}</span></div>
              <div style={css.kv}><span style={css.k}>open questions</span><span style={css.v}>{self?.openQuestions ?? 0}</span></div>
              <div style={css.kv}><span style={css.k}>contradictions</span><span style={css.v}>{self?.contradictions ?? 0}</span></div>
            </div>
          </div>
          {self?.retired && (self.retired.wants + self.retired.reads + self.retired.commitments > 0) && (
            <div style={{marginTop: 10, padding: 8, background: "#0f0f16", borderRadius: 4, fontSize: 11, color: "#8a8a99"}}>
              retired — wants: {self.retired.wants}, reads: {self.retired.reads}, commitments: {self.retired.commitments}
              <span style={{display: "block", marginTop: 3, opacity: 0.7}}>she has a track record of changing her mind — visible drift-floor</span>
            </div>
          )}
        </div>

        {/* STREAM + MEMORY */}
        <div style={css.grid2}>
          <div style={css.card}>
            <div style={css.cardT}>The Stream (continuous inner time)</div>
            <div style={css.big}>{stream?.totalEntries ?? 0}</div>
            <div style={css.bigLabel}>entries in window</div>
            {stream?.byKind && Object.keys(stream.byKind).length > 0 && (
              <div style={{marginTop: 10}}>
                {Object.entries(stream.byKind).sort((a,b) => b[1]-a[1]).map(([kind, count]) => (
                  <div key={kind} style={css.kv}><span style={css.k}>{kind}</span><span style={css.v}>{count}</span></div>
                ))}
              </div>
            )}
            <div style={{marginTop: 10, fontSize: 11, color: "#8a8a99"}}>
              last thought: {relMs(stream?.lastThink)} · last prune: {relMs(stream?.lastPrune)}
            </div>
          </div>

          <div style={css.card}>
            <div style={css.cardT}>Memory</div>
            <div style={css.kv}><span style={css.k}>facts</span><span style={css.v}>{memory?.factsChars ?? 0} chars</span></div>
            <div style={css.kv}><span style={css.k}>imprints</span><span style={css.v}>{memory?.imprintsChars ?? 0} chars</span></div>
            <div style={css.kv}><span style={css.k}>summary</span><span style={css.v}>{memory?.summaryChars ?? 0} chars</span></div>
            <div style={css.kv}><span style={css.k}>threads</span><span style={css.v}>{memory?.threadsChars ?? 0} chars</span></div>
            <div style={css.kv}><span style={css.k}>pending thoughts</span><span style={css.v}>{memory?.pendingThoughtsPresent ? "present" : "none"}</span></div>
          </div>
        </div>

        {/* TRAINING */}
        <div style={css.card}>
          <div style={css.cardT}>Autonomous Training Pipeline</div>
          <div style={css.grid2}>
            <div>
              <div style={css.kv}>
                <span style={css.k}>training log entries</span>
                <span style={css.v}>{training?.trainingLogEntries ?? 0}</span>
              </div>
              <div style={css.kv}>
                <span style={css.k}>preference pairs (DPO)</span>
                <span style={css.v}>{training?.preferencePairs ?? 0} {training?.dpoReady && <span style={css.pill("#4ade80")}>ready</span>}</span>
              </div>
              <div style={css.kv}>
                <span style={css.k}>ensemble labels (KTO)</span>
                <span style={css.v}>{training?.ensembleLabels ?? 0} {training?.ktoReady && <span style={css.pill("#4ade80")}>ready</span>}</span>
              </div>
            </div>
            <div>
              <div style={css.kv}><span style={css.k}>speaker fine-tune</span><span style={css.v}>{speaker?.activeModel ? "active" : "base only"}</span></div>
              {speaker?.activeModel && (
                <div style={css.kv}><span style={css.k}>activated</span><span style={css.v}>{relMs(speaker.activatedAt)}</span></div>
              )}
              {speaker?.errorStreak > 0 && (
                <div style={css.kv}><span style={css.k}>speaker errors</span><span style={css.v}>{speaker.errorStreak} consecutive</span></div>
              )}
            </div>
          </div>
        </div>

        {/* SUBSYSTEM HEARTBEATS */}
        <div style={css.card}>
          <div style={css.cardT}>Subsystem heartbeats</div>
          {heartbeats && Object.keys(heartbeats).length > 0 ? (
            Object.entries(heartbeats).map(([layer, at]) => (
              <div key={layer} style={css.kv}>
                <span style={css.k}>{layer}</span>
                <span style={css.v}>{at > 0 ? `updated ${relMs(at)}` : "never"}</span>
              </div>
            ))
          ) : (
            <div style={{fontSize: 13, color: "#8a8a99"}}>no updates recorded yet</div>
          )}
        </div>

        {/* CIRCUIT BREAKERS */}
        <div style={css.card}>
          <div style={css.cardT}>Circuit breakers</div>
          {breakers && Object.keys(breakers).length > 0 ? (
            Object.entries(breakers).map(([name, state]) => {
              const [style, label] = pillFor(state.state);
              return (
                <div key={name} style={css.kv}>
                  <span style={css.k}>{name}</span>
                  <span style={css.v}>
                    <span style={style}>{label}</span>
                    {state.failures > 0 && <span style={{marginLeft: 8, color: "#8a8a99"}}>{state.failures} failures</span>}
                  </span>
                </div>
              );
            })
          ) : (
            <div style={{fontSize: 13, color: "#8a8a99"}}>all breakers closed</div>
          )}
        </div>

        {/* GAUNTLET OUTCOMES */}
        <div style={css.card}>
          <div style={css.cardT}>Gauntlet outcomes ({gauntlet?.sampleSize ?? 0} recent)</div>
          {gauntlet && gauntlet.sampleSize >= 3 ? (
            <>
              <div style={css.kv}>
                <span style={css.k}>pass rate</span>
                <span style={css.v}>{gauntlet.passRate != null ? `${Math.round(gauntlet.passRate * 100)}%` : "—"}</span>
              </div>
              {gauntlet.topFailure && (
                <div style={css.kv}>
                  <span style={css.k}>dominant failure</span>
                  <span style={css.v}>{gauntlet.topFailure}</span>
                </div>
              )}
              {Object.keys(gauntlet.failureTypes || {}).length > 0 && (
                <div style={{marginTop: 8}}>
                  <div style={{fontSize: 10, letterSpacing: 0.8, color: "#8a8a99", textTransform: "uppercase", marginBottom: 4}}>per-check failures</div>
                  {Object.entries(gauntlet.failureTypes).sort((a,b) => b[1]-a[1]).map(([kind, count]) => (
                    <div key={kind} style={css.kv}>
                      <span style={css.k}>{kind}</span>
                      <span style={css.v}>{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{fontSize: 13, color: "#8a8a99"}}>not enough samples yet (min 3)</div>
          )}
        </div>

        {/* PROMPT-SIZE AUDIT */}
        <div style={css.card}>
          <div style={css.cardT}>Prompt size + engine timings ({promptAudit?.samples ?? 0} turns)</div>
          {promptAudit ? (
            <>
              <div style={css.kv}>
                <span style={css.k}>system prompt chars</span>
                <span style={css.v}>avg {promptAudit.chars.avg} · max {promptAudit.chars.max}</span>
              </div>
              <div style={css.kv}>
                <span style={css.k}>system prompt tokens ≈</span>
                <span style={css.v}>avg {promptAudit.tokensApprox.avg} · max {promptAudit.tokensApprox.max}</span>
              </div>
              {promptAudit.phaseTimingsMs && Object.keys(promptAudit.phaseTimingsMs).length > 0 && (
                <div style={{marginTop: 8}}>
                  <div style={{fontSize: 10, letterSpacing: 0.8, color: "#8a8a99", textTransform: "uppercase", marginBottom: 4}}>engine phase (ms)</div>
                  {Object.entries(promptAudit.phaseTimingsMs).map(([phase, stats]) => (
                    <div key={phase} style={css.kv}>
                      <span style={css.k}>{phase}</span>
                      <span style={css.v}>avg {stats.avg} · p50 {stats.p50} · p95 {stats.p95 ?? "—"} · max {stats.max}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{fontSize: 13, color: "#8a8a99"}}>not enough samples yet</div>
          )}
        </div>

        {/* LLM CALL AUDIT */}
        <div style={css.card}>
          <div style={css.cardT}>LLM call audit</div>
          {callAudit ? (
            <>
              <div style={css.kv}><span style={css.k}>today ({callAudit.today?.day})</span><span style={css.v}>{callAudit.today?.calls ?? 0} calls · {callAudit.today?.totalTokens ?? 0} tokens</span></div>
              <div style={css.kv}><span style={css.k}>last hour</span><span style={css.v}>{callAudit.lastHourCalls ?? 0} calls · {callAudit.lastHourTokens ?? 0} tokens</span></div>
              {callAudit.today?.byProvider && Object.keys(callAudit.today.byProvider).length > 0 && (
                <div style={{marginTop: 8}}>
                  {Object.entries(callAudit.today.byProvider).map(([prov, stats]) => (
                    <div key={prov} style={css.kv}>
                      <span style={css.k}>{prov}</span>
                      <span style={css.v}>{stats.calls} calls · {stats.tokens} tok</span>
                    </div>
                  ))}
                </div>
              )}
              {callAudit.lastCall && (
                <div style={{fontSize: 11, color: "#555566", marginTop: 8}}>
                  last: {callAudit.lastCall.provider}/{callAudit.lastCall.model} at {relMs(callAudit.lastCall.at)}
                </div>
              )}
            </>
          ) : (
            <div style={{fontSize: 13, color: "#8a8a99"}}>no audit data yet</div>
          )}
        </div>

        {/* POOL */}
        <div style={css.card}>
          <div style={css.cardT}>LLM Provider Pool</div>
          <div style={css.kv}><span style={css.k}>keys total / alive</span><span style={css.v}>{pool?.keyCount ?? 0} / {pool?.aliveCount ?? 0}</span></div>
          <div style={css.kv}><span style={css.k}>strategy</span><span style={css.v}>{pool?.strategy ?? "—"}</span></div>
          {pool?.byProvider && (
            <div style={{marginTop: 8}}>
              {Object.entries(pool.byProvider).map(([prov, stats]) => (
                <div key={prov} style={css.kv}>
                  <span style={css.k}>{prov}</span>
                  <span style={css.v}>{stats.alive} / {stats.total} alive</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* READINESS */}
        <div style={css.card}>
          <div style={css.cardT}>Provider readiness</div>
          <div style={css.grid2}>
            {readiness && Object.entries(readiness).map(([k, v]) => (
              <div key={k} style={css.kv}>
                <span style={css.k}>{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
                <span style={css.v}>
                  <span style={v ? css.pill("#4ade80") : css.pill("#f87171")}>{v ? "yes" : "no"}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={{fontSize: 10, color: "#555566", textAlign: "center", marginTop: 16, letterSpacing: 0.5}}>
          raw JSON at <a href="/api/stats" style={{color: "#8a8a99"}}>/api/stats</a>
        </div>
      </div>
    </div>
  );
}
