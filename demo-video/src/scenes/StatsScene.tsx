// Scene 4: Stats — animated counters from the real mainnet run, 15s.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { colors, fonts, sizes, radius } from "../theme";
import { agentOutput } from "../data";

interface Stat { label: string; value: number; suffix?: string; color: string; note?: string; }
const stats: Stat[] = [
  { label: "Native CELO txs", value: agentOutput.rawTxns, color: colors.text, note: "fetched in 1.3s" },
  { label: "Classified by rules", value: agentOutput.ruleHits, color: colors.success },
  { label: "LLM fallbacks", value: agentOutput.llmFallbacks, color: colors.textDim, note: "rules covered it" },
  { label: "Flagged for review", value: agentOutput.flaggedForReview, color: colors.warn, note: "honest uncertainty" },
];

const AnimatedNumber: React.FC<{ target: number; start: number; duration: number; color: string; suffix?: string }> = ({ target, start, duration, color, suffix }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - start, fps, durationInFrames: duration, config: { damping: 30, stiffness: 60 } });
  const current = Math.floor(target * progress);
  return (
    <div style={{ fontFamily: fonts.mono, fontSize: 88, fontWeight: 800, color, lineHeight: 1 }}>
      {current}{suffix && <span style={{ fontSize: 48, marginLeft: 4 }}>{suffix}</span>}
    </div>
  );
};

export const StatsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOpacity = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: colors.bg, padding: 80, justifyContent: "center" }}>
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.title, color: colors.accent,
        fontWeight: 800, marginBottom: 8, opacity: headerOpacity,
      }}>
        The result ↓
      </div>
      <div style={{
        fontFamily: fonts.mono, fontSize: sizes.small, color: colors.textDim,
        marginBottom: 50, opacity: headerOpacity,
      }}>
        on {agentOutput.addressShort} · Celo mainnet · {agentOutput.taxYear}
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32,
      }}>
        {stats.map((s, i) => {
          const start = 0.8 * fps + i * 0.4 * fps;
          return (
            <div key={i} style={{
              background: colors.surface, border: `1px solid ${colors.border}`,
              borderRadius: radius.md, padding: "32px 36px",
            }}>
              <AnimatedNumber target={s.value} start={start} duration={1.2 * fps} color={s.color} />
              <div style={{
                fontFamily: fonts.display, fontSize: sizes.body, color: colors.text,
                marginTop: 12, fontWeight: 500,
              }}>
                {s.label}
              </div>
              {s.note && (
                <div style={{
                  fontFamily: fonts.mono, fontSize: sizes.tiny, color: colors.textDim,
                  marginTop: 6,
                }}>
                  {s.note}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
