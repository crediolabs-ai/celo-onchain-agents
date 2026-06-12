// Scene 1: Intro — title + tagline, 5s.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { colors, fonts, sizes } from "../theme";

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title scales in with spring; subtitle fades in after.
  const titleScale = spring({ frame, fps, config: { damping: 14, stiffness: 100 } });
  const subtitleOpacity = interpolate(frame, [1.2 * fps, 2.2 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const taglineOpacity = interpolate(frame, [2.4 * fps, 3.6 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const badgeOpacity = interpolate(frame, [3.8 * fps, 4.6 * fps], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  // Accent line slides in from left
  const lineWidth = interpolate(frame, [0, 0.8 * fps], [0, 320], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: colors.bg, justifyContent: "center", alignItems: "center" }}>
      {/* Accent bar */}
      <div style={{
        position: "absolute", top: "32%", left: "50%", transform: "translateX(-50%)",
        width: lineWidth, height: 4, background: colors.accent,
      }} />

      {/* Title */}
      <div style={{
        fontFamily: fonts.display, fontWeight: 900,
        fontSize: sizes.hero, color: colors.text, letterSpacing: -2,
        transform: `scale(${0.7 + titleScale * 0.3})`, opacity: titleScale,
      }}>
        Agent 06
      </div>

      {/* Subtitle */}
      <div style={{
        fontFamily: fonts.display, fontWeight: 500,
        fontSize: sizes.subtitle, color: colors.accent, marginTop: 16,
        opacity: subtitleOpacity,
      }}>
        Onchain Tax & Portfolio Agent for Celo
      </div>

      {/* Tagline */}
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.body, color: colors.textDim,
        marginTop: 32, maxWidth: 900, textAlign: "center", lineHeight: 1.4,
        opacity: taglineOpacity,
      }}>
        Crawls your Celo wallet. Classifies every txn.
        <br />Answers "what's my PNL?" in plain English.
      </div>

      {/* Hackathon badge */}
      <div style={{
        position: "absolute", bottom: 60, opacity: badgeOpacity,
        fontFamily: fonts.mono, fontSize: sizes.small, color: colors.textDim,
        border: `1px solid ${colors.border}`, padding: "8px 16px", borderRadius: 6,
      }}>
        Celo Onchain Agents Hackathon 2026 · #CeloAgents
      </div>
    </AbsoluteFill>
  );
};
