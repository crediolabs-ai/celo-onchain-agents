// Scene 6: Outro — GitHub + ERC-8004 + closing, 10s.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { colors, fonts, sizes, radius } from "../theme";

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({ frame, fps, config: { damping: 14, stiffness: 100 } });
  const linksOpacity = interpolate(frame, [1.0 * fps, 2.0 * fps], [0, 1], { extrapolateRight: "clamp" });
  const linksY = interpolate(frame, [1.0 * fps, 2.0 * fps], [30, 0], { extrapolateRight: "clamp" });
  const ctaOpacity = interpolate(frame, [2.5 * fps, 3.5 * fps], [0, 1], { extrapolateRight: "clamp" });
  const hashtagOpacity = interpolate(frame, [4.0 * fps, 5.0 * fps], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, justifyContent: "center", alignItems: "center", padding: 80 }}>
      {/* Big "Try it" CTA */}
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.hero, fontWeight: 900,
        color: colors.accent, letterSpacing: -2, textAlign: "center",
        transform: `scale(${0.85 + titleScale * 0.15})`, opacity: titleScale,
        lineHeight: 1.1,
      }}>
        Try it.<br /><span style={{ color: colors.text }}>Right now.</span>
      </div>

      {/* Links */}
      <div style={{
        marginTop: 60, display: "flex", flexDirection: "column", gap: 16,
        opacity: linksOpacity, transform: `translateY(${linksY}px)`,
        alignItems: "center",
      }}>
        <div style={{
          fontFamily: fonts.mono, fontSize: sizes.body, color: colors.text,
          background: colors.surface, border: `1px solid ${colors.border}`,
          padding: "12px 24px", borderRadius: radius.sm,
        }}>
          github.com/crediolabs-ai/celo-onchain-agents
        </div>
        <div style={{
          fontFamily: fonts.mono, fontSize: sizes.body, color: colors.text,
          background: colors.surface, border: `1px solid ${colors.accent}`,
          padding: "12px 24px", borderRadius: radius.sm,
        }}>
          ERC-8004: 0x0fad789e…961a1 (Celo mainnet)
        </div>
      </div>

      {/* CTA reminder */}
      <div style={{
        marginTop: 40, fontFamily: fonts.display, fontSize: sizes.body,
        color: colors.textDim, opacity: ctaOpacity,
      }}>
        pnpm install · pnpm demo --mode=all
      </div>

      {/* Hashtag + closing */}
      <div style={{
        position: "absolute", bottom: 60,
        fontFamily: fonts.display, fontSize: sizes.subtitle, fontWeight: 700,
        color: colors.accent, opacity: hashtagOpacity, letterSpacing: 4,
      }}>
        #CeloAgents
      </div>
    </AbsoluteFill>
  );
};
